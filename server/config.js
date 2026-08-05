// Config for the OPTIONAL bot-detector backend (JIO-110, server half).
//
// A FOURTH independent copy of the Anthropic key. Per this repo's explicit
// per-package rule (see the env table in the root CLAUDE.md), a var lives in
// whichever package's code actually reads it -- skill-backend, task-runner and
// playlist-maker each parse their own `.env`, and this package does the same
// rather than reaching across for someone else's. That is what keeps each
// package runnable and testable on its own.
//
// THE KEY NEVER SHIPS IN THE EXTENSION. This is the whole reason the Claude
// read lives behind an HTTP endpoint instead of in the browser: a Chrome
// extension's bundle is readable by anyone who installs it, so an API key put
// there is a published API key. `bot-detector/.env` is gitignored and is read
// only by this process; the extension talks to `/api/verdict` and never sees a
// credential. If the server is unreachable the extension falls back to its own
// local deterministic scoring -- it is useful with no backend at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');

/** Hand-parsed .env, same no-dotenv-dependency pattern as the other packages. */
function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotEnv = loadDotEnvFile(path.join(packageRoot, '.env'));

function get(key, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  if (Object.prototype.hasOwnProperty.call(dotEnv, key)) return dotEnv[key];
  return fallback;
}

function getInt(key, fallback) {
  const raw = get(key, undefined);
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getList(key, fallback) {
  const raw = get(key, undefined);
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  packageRoot,

  // --- HTTP ---------------------------------------------------------------
  // 3200 was picked because nothing else in this repo binds it: skill-backend
  // is :3000, task-runner's standalone wrapper :3100, the website :8080, Home
  // Assistant :8123, and the (retired) ttyd :7681. Checked 2026-08-05.
  port: getInt('BOT_DETECTOR_PORT', 3200),

  // Explicit CORS allowlist. Entries are matched exactly, except that a bare
  // scheme prefix ending in `://` matches any origin on that scheme -- which
  // is how `chrome-extension://` covers the extension without pinning the
  // per-install extension id.
  //
  // The default is permissive for local use only: any chrome-extension origin
  // plus loopback. THE TUNNEL CASE: if this is exposed on the Mac mini behind
  // the existing Cloudflare Tunnel (a `bot.jiolab.dev -> localhost:3200`
  // ingress rule in infra/cloudflared/config.yml), set
  // BOT_DETECTOR_ALLOWED_ORIGINS to the exact `chrome-extension://<id>` of
  // the installed extension. `bigbrain.jiolab.dev` is deliberately not behind
  // Cloudflare Access because Alexa can't answer an identity challenge; a
  // hostname for this server has no such excuse, so put it behind Access and
  // narrow this list rather than leaving the default in place.
  allowedOrigins: getList('BOT_DETECTOR_ALLOWED_ORIGINS', [
    'chrome-extension://',
    'http://localhost',
    'http://127.0.0.1',
  ]),

  // --- Cache (see cache.js) ------------------------------------------------
  // A separate .db file from anything else in the repo, for the same reason
  // chess.db is separate from tasks.db: this is a rebuildable cache, not
  // operational state, so "delete it" has to be a safe, isolated operation.
  // Under data/ so it is gitignored runtime state, not source.
  dbPath: get('BOT_DETECTOR_DB_PATH', path.join(packageRoot, 'data', 'cache.db')),

  // Profiles hold comment BODIES, so this TTL is also a data-retention bound
  // (see the privacy note in cache.js): expired profile rows are deleted, not
  // merely ignored. Short by design.
  profileTtlSeconds: getInt('BOT_DETECTOR_PROFILE_TTL_SECONDS', 6 * 3600),

  // The cheap half. A deterministic verdict is a pure function of the profile,
  // so this only exists to skip the Reddit round trip on a repeat lookup.
  verdictTtlSeconds: getInt('BOT_DETECTOR_VERDICT_TTL_SECONDS', 24 * 3600),

  // The expensive half, and deliberately much longer than the verdict TTL: an
  // Opus read costs real money per lookup, and an account's *agenda* moves on
  // a scale of weeks, not hours. This is the entry that makes the shared cache
  // worth having across two machines.
  llmTtlSeconds: getInt('BOT_DETECTOR_LLM_TTL_SECONDS', 14 * 24 * 3600),

  // --- The Claude agenda read (see agenda.js) ------------------------------
  anthropicApiKey: get('ANTHROPIC_API_KEY', undefined),

  // Opus, not Haiku, for the same reason CHESS_SYNTHESIS_MODEL is: this is the
  // one intelligence-sensitive call in this project. Pattern-matching already
  // covers the deterministic half in the browser; what this call is for is the
  // judgement pattern-matching cannot make -- narrative repetition vs. a
  // person with a hobbyhorse, stock talking points vs. a consistently held
  // opinion. A cheap model gets that wrong confidently.
  agendaModel: get('BOT_AGENDA_MODEL', 'claude-opus-5'),

  // How many of an account's comments go into one pack. Caps token cost and,
  // just as importantly, how much of a stranger's posting history is shipped
  // to a third party in one request. Raising it widens both.
  agendaMaxComments: getInt('BOT_AGENDA_MAX_COMMENTS', 60),

  // Per-comment body budget, in characters. Long comments are truncated with a
  // marker rather than dropped, so the citation ids stay stable.
  agendaMaxCommentChars: getInt('BOT_AGENDA_MAX_COMMENT_CHARS', 700),

  // Output budget. THINKING COUNTS AGAINST THIS as well as the JSON (thinking
  // is on by default on Opus 5 and is deliberately not disabled), which is why
  // this is well above what the report itself needs. A `max_tokens` stop fails
  // loudly rather than handing back truncated JSON.
  agendaMaxTokens: getInt('BOT_AGENDA_MAX_TOKENS', 8000),
};

export default config;
export { loadDotEnvFile };
