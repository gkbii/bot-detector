// bot-detector's OPTIONAL backend (JIO-110, server half).
//
// ===========================================================================
// PRIVACY. This thing judges real people, so the rules are stated up front.
//   * Only public data is ever touched -- the same public Reddit archive the
//     extension reads with no credentials. Nothing here logs in as anyone,
//     scrapes anything gated, or looks at private messages, votes or email.
//   * Comment bodies are never logged. Not at any log level, not on error, not
//     in the access line. The access log records method, path, status,
//     duration and the username that was looked up -- nothing else.
//   * Comment bodies do not outlive their cache TTL. Expiry in cache.js is a
//     physical DELETE, run on open and after every write, not a read-time
//     filter (see that file's header).
//   * The model is asked for evidence and a band, never a verdict on a person
//     and never an identity claim (see agenda.js).
//   * The whole server is optional. Anyone uncomfortable with a shared cache
//     or a third-party read runs the extension alone and loses only those two
//     things.
// ===========================================================================
//
// WHAT THIS ADDS OVER THE EXTENSION ALONE, and nothing else:
//   1. A Claude agenda read (agenda.js) -- the judgement pattern-matching
//      cannot make, and the reason an API key is involved at all. The key
//      lives in bot-detector/.env and is never shipped in the extension.
//   2. A shared SQLite cache (cache.js) -- a lookup done on the laptop is free
//      on the desktop.
// The deterministic verdict itself is the extension's own code (see
// deterministic.js); this server does not have a second opinion about it.
//
// Zero-dependency `node:http`, like website/server.js -- this repo does not
// reach for Express outside skill-backend.
//
// Runs the same on a laptop and on the Mac mini behind the existing Cloudflare
// Tunnel; see config.js's `allowedOrigins` for the tunnel case.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import config from './config.ts';
import { Cache } from './cache.ts';
import { normalisePlatform, normaliseUsername } from './username.ts';
import { buildPack } from './pack.ts';
import { readAgenda, AgendaError } from './agenda.ts';
import { loadDeterministic } from './deterministic.ts';
import { ROUTES } from './registry/routes.ts';
import { BotDetectorError, ERRORS } from '../extension/errors.js';
import { log as logEvent } from '../extension/log.js';
import { errorMessage } from '../extension/errors.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Route } from './registry/routes.ts';
import type { DeterministicCore } from './deterministic.ts';
import type { AccountProfile, Verdict } from './types.ts';

/** Why there is no LLM block on a verdict. Reported, never invented around. */
interface LlmError {
  code: string;
  message: string | undefined;
}

/** One access-log line. Carries no request or response body -- see the privacy block. */
interface AccessLine {
  method: string | undefined;
  route: string;
  status: number;
  ms: number;
  origin: string | null;
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Origin allowlist. An entry matches if it is exactly the origin, or is a bare
 * scheme prefix ending in `://` (so `chrome-extension://` covers the extension
 * without pinning a per-install id), or is an origin prefix the request only
 * extends with a port (so `http://localhost` covers `http://localhost:5173`).
 * `*` allows everything and is a local-dev-only setting.
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[] = config.allowedOrigins): boolean {
  if (!origin) return true; // Not a browser request; CORS is not the control here.
  for (const entry of allowed) {
    if (entry === '*') return true;
    if (entry === origin) return true;
    if (entry.endsWith('://') && origin.startsWith(entry)) return true;
    if (origin.startsWith(`${entry}:`)) return true;
  }
  return false;
}

function corsHeaders(origin: string | undefined | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'content-type';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown, origin: string | undefined | null): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(payload);
}

/** A failure whose status comes from the code, so no route repeats a number. */
function sendFailure(res: ServerResponse, code: keyof typeof ERRORS, message: string, origin: string | undefined): void {
  return sendJson(res, ERRORS[code].httpStatus, { error: message, code }, origin);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BotDetectorError('body-too-large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new BotDetectorError('body-not-object', 'body must be a JSON object'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new BotDetectorError('body-not-json', 'body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Attaches the LLM block (or the reason there isn't one) without mutating the
 * verdict the scorer produced. Shape-identical to the local provider's verdict
 * plus `agenda.llm`, which is the whole contract the panel renders against.
 */
function withAgendaBlock(verdict: Verdict, { llm = null, llmError = null }: { llm?: unknown; llmError?: LlmError | null } = {}): Verdict {
  const agenda = { ...(verdict.agenda || {}) };
  if (llm) agenda.llm = llm;
  if (llmError) agenda.llmError = llmError;
  return { ...verdict, agenda };
}

/**
 * @param {object} [deps] - injectable for tests; every one defaults to the real thing.
 * @param {Cache} [deps.cache]
 * @param {() => Promise<{fetchAccount: Function, scoreAccount: Function}>} [deps.loadDeterministic]
 * @param {Function} [deps.readAgenda]
 * @param {(line: object) => void} [deps.log]
 */
export function createApp({
  cache = new Cache(),
  loadDeterministic: load = loadDeterministic,
  readAgenda: agendaRead = readAgenda,
  log = defaultLog,
  agendaConfigured = () => Boolean(config.anthropicApiKey),
} = {}) {
  /** The handlers ROUTES names, by key. */
  const handlers: Record<Route['handler'], (req: IncomingMessage, res: ServerResponse, origin: string | undefined) => Promise<void>> = {
    health: (_req, res, origin) => handleHealth(res, origin),
    verdict: (req, res, origin) => handleVerdict(req, res, origin),
  };

  async function handleHealth(res: ServerResponse, origin: string | undefined): Promise<void> {
    sendJson(
      res,
      200,
      {
        ok: true,
        // The extension's options page shows this as "an LLM read is
        // available". It is a boolean about configuration, never the key.
        agenda: agendaConfigured(),
        cache: cache.stats(),
      },
      origin
    );
  }

  async function handleVerdict(req: IncomingMessage, res: ServerResponse, origin: string | undefined): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = err instanceof BotDetectorError ? err.httpStatus : 400;
      const code = err instanceof BotDetectorError ? err.code : 'bad-request';
      return sendJson(res, status, { error: errorMessage(err), code }, origin);
    }

    const platformCheck = normalisePlatform(body.platform);
    if (!platformCheck.ok) {
      return sendJson(res, 400, { error: platformCheck.reason }, origin);
    }
    // Hard validation: this value flows into an outbound URL. See username.js.
    const usernameCheck = normaliseUsername(body.username);
    if (!usernameCheck.ok) {
      return sendJson(res, 400, { error: usernameCheck.reason }, origin);
    }

    const { platform } = platformCheck;
    const { username } = usernameCheck;
    const deep = Boolean(body.deep);

    let deterministic: DeterministicCore;
    try {
      deterministic = await load();
    } catch (err) {
      const code = err instanceof BotDetectorError ? err.code : 'deterministic-unavailable';
      return sendJson(res, ERRORS[code].httpStatus, { error: errorMessage(err), code }, origin);
    }

    const cached = { profile: false, verdict: false, llm: false };

    let llm: unknown = deep ? cache.getLlmRead(platform, username)?.value ?? null : null;
    cached.llm = Boolean(llm);
    let verdict = (cache.getVerdict(platform, username)?.value ?? null) as Verdict | null;
    cached.verdict = Boolean(verdict);
    let profile = (cache.getProfile(platform, username)?.value ?? null) as AccountProfile | null;
    cached.profile = Boolean(profile);

    // The profile is needed to score, and needed again to build an evidence
    // pack -- so a cached profile is exactly what stops a `deep` request from
    // refetching an account the shallow request just pulled.
    const needProfile = !verdict || (deep && !llm);
    if (needProfile && !profile) {
      try {
        profile = (await deterministic.fetchAccount(username, { platform })) as AccountProfile | null;
      } catch (err) {
        return sendFailure(res, 'archive-request-failed', `fetch failed: ${errorMessage(err)}`, origin);
      }
      if (!profile) {
        return sendFailure(res, 'not-found', `no such ${platform} account: ${username}`, origin);
      }
      cache.putProfile(platform, username, profile);
    }

    if (!verdict) {
      try {
        verdict = deterministic.scoreAccount(profile, { platform }) as Verdict;
      } catch (err) {
        return sendFailure(res, 'core-mismatch', `scoring failed: ${errorMessage(err)}`, origin);
      }
      cache.putVerdict(platform, username, verdict);
    }

    let llmError: LlmError | null = null;
    if (deep && !llm) {
      try {
        const pack = buildPack(profile as AccountProfile);
        const result = await agendaRead({ pack });
        if (result.read) {
          llm = result.read;
          cache.putLlmRead(platform, username, llm);
        } else {
          // Nothing survived citation checking. No LLM block is the correct
          // outcome -- an unsupported paragraph about a stranger is worse than
          // none -- so this is reported, not invented around, and deliberately
          // not cached.
          llmError = { code: 'unsupported', message: result.reason };
        }
      } catch (err) {
        // Every agenda failure leaves the deterministic verdict intact. The
        // request still succeeds; the caller is told what it did not get.
        llmError =
          err instanceof AgendaError
            ? { code: err.code, message: err.message }
            : { code: 'agenda-failed', message: errorMessage(err) };
      }
    }

    sendJson(
      res,
      200,
      { verdict: withAgendaBlock(verdict as Verdict, { llm, llmError }), provider: 'backend', cached },
      origin
    );
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const origin = req.headers.origin;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    res.on('finish', () => {
      log({
        method: req.method,
        route,
        status: res.statusCode,
        ms: Date.now() - started,
        origin: origin || null,
      });
    });

    if (origin && !isOriginAllowed(origin)) {
      return sendJson(res, ERRORS['origin-not-allowed'].httpStatus, { error: 'origin not allowed', code: 'origin-not-allowed' }, null);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }

    // Dispatch is a lookup in registry/routes.ts, not a branch per route: a
    // path that table does not carry is a 404 and one asked with the wrong
    // method is a 405, both decided here once.
    const matches = ROUTES.filter((entry) => entry.path === route);
    if (matches.length === 0) return sendFailure(res, 'not-a-route', 'not found', origin);
    const matched = matches.find((entry) => entry.method === req.method);
    if (!matched) return sendFailure(res, 'method-not-allowed', 'method not allowed', origin);

    return handlers[matched.handler](req, res, origin).catch((err) =>
      sendJson(res, 500, { error: err.message, code: err.code }, origin)
    );
  });

  server.on('close', () => {
    try {
      cache.close();
    } catch {
      /* already closed */
    }
  });

  return server;
}

/** Access log. Deliberately carries no request or response body -- see the privacy block. */
function defaultLog(line: AccessLine): void {
  logEvent('http', 'request', {
    method: line.method,
    route: line.route,
    status: line.status,
    ms: line.ms,
    origin: line.origin ?? undefined,
  });
}

export function start({ port = config.port }: { port?: number } = {}) {
  const server = createApp();
  server.listen(port, () => {
    logEvent('server', 'listening', {
      url: `http://localhost:${port}`,
      // A boolean about configuration, never the key.
      agenda: config.anthropicApiKey ? 'configured' : 'NOT-configured',
      cache: config.dbPath,
    });
  });
  return server;
}

// `npm start` starts it; importing it (tests, another module) does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
