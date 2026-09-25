// Config for the OPTIONAL bot-detector backend.
//
// EVERY VALUE HERE COMES FROM registry/env.ts AND NOTHING ELSE. `get()` takes
// an EnvVar rather than a key string, so a variable this file reads is a
// variable the registry declares, which is what `npm run registry` renders and
// test/registry.test.js holds to. Adding a knob means adding a row there first.
//
// A var lives in whichever package's code actually reads it: this package parses
// its own `.env` rather than reaching across for someone else's, which is what
// keeps it runnable and testable on its own. No `dotenv` -- Node's built-ins
// are preferred to npm packages throughout, and this is fifteen lines.
//
// THE KEY NEVER SHIPS IN THE EXTENSION. That is the whole reason the Claude read
// lives behind an HTTP endpoint instead of in the browser: a Chrome extension's
// bundle is readable by anyone who installs it, so an API key put there is a
// published API key. `bot-detector/.env` is gitignored and is read only by this
// process; the extension talks to `/api/verdict` and never sees a credential.
// If the server is unreachable the extension falls back to its own local
// deterministic scoring -- it is useful with no backend at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, type EnvVar } from './registry/env.ts';
import { BotDetectorError } from '../extension/errors.js';

/** A config defect -- an undeclared key reached `declared()` -- not a default. */
class ConfigError extends BotDetectorError {
  constructor(message: string) {
    super('core-mismatch', message);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');

/** Hand-parsed .env, same no-dotenv-dependency pattern as every other package. */
export function loadDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotEnv = loadDotEnvFile(path.join(packageRoot, '.env'));

const BY_KEY = new Map<string, EnvVar>(ENV.map((entry) => [entry.key, entry]));

/** The declared variable, or a throw -- an undeclared key is a defect, not a default. */
function declared(key: string): EnvVar {
  const entry = BY_KEY.get(key);
  if (!entry) throw new ConfigError(`${key} is not declared in server/registry/env.ts`);
  return entry;
}

function raw(entry: EnvVar): string | undefined {
  if (Object.prototype.hasOwnProperty.call(process.env, entry.key)) return process.env[entry.key];
  if (Object.prototype.hasOwnProperty.call(dotEnv, entry.key)) return dotEnv[entry.key];
  return entry.default ?? undefined;
}

function str(key: string): string | undefined {
  return raw(declared(key));
}

function int(key: string): number {
  const entry = declared(key);
  const value = raw(entry);
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  if (Number.isFinite(parsed)) return parsed;
  // A typo in a numeric knob falls back to the declared default rather than to
  // NaN, and the declared default is the one in registry/env.ts.
  return parseInt(String(entry.default), 10);
}

function list(key: string): string[] {
  const value = raw(declared(key)) ?? '';
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  readonly packageRoot: string;
  readonly port: number;
  readonly allowedOrigins: string[];
  readonly dbPath: string;
  readonly profileTtlSeconds: number;
  readonly verdictTtlSeconds: number;
  readonly llmTtlSeconds: number;
  readonly anthropicApiKey: string | undefined;
  readonly agendaModel: string;
  readonly agendaMaxComments: number;
  readonly agendaMaxCommentChars: number;
  readonly agendaMaxTokens: number;
}

const dbPathRaw = str('BOT_DETECTOR_DB_PATH') ?? 'data/cache.db';

const config: Config = {
  packageRoot,
  port: int('BOT_DETECTOR_PORT'),
  allowedOrigins: list('BOT_DETECTOR_ALLOWED_ORIGINS'),
  // Declared relative to the repo root, resolved absolute here.
  dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(packageRoot, dbPathRaw),
  profileTtlSeconds: int('BOT_DETECTOR_PROFILE_TTL_SECONDS'),
  verdictTtlSeconds: int('BOT_DETECTOR_VERDICT_TTL_SECONDS'),
  llmTtlSeconds: int('BOT_DETECTOR_LLM_TTL_SECONDS'),
  anthropicApiKey: str('ANTHROPIC_API_KEY') || undefined,
  agendaModel: str('BOT_AGENDA_MODEL') ?? 'claude-opus-5',
  agendaMaxComments: int('BOT_AGENDA_MAX_COMMENTS'),
  agendaMaxCommentChars: int('BOT_AGENDA_MAX_COMMENT_CHARS'),
  agendaMaxTokens: int('BOT_AGENDA_MAX_TOKENS'),
};

export default config;
