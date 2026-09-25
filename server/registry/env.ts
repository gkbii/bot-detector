// EVERY ENVIRONMENT VARIABLE THIS REPO READS. `server/config.ts` reads through
// this list and nothing else, so a variable that is not here does not exist;
// `npm run registry` renders it into docs/registry.md and .env.example, and
// test/registry.test.js fails when either is stale.
//
// The extension reads no environment at all -- it has none to read -- so every
// entry here belongs to the OPTIONAL server. That is why the registry lives
// under server/ rather than in a src/ of its own: the two consumers of this
// data (config.ts and the renderer) are both here, and a registry nothing
// imports is one that rots.

/** How config.ts coerces the raw string. */
export type EnvKind = 'string' | 'int' | 'list';

export interface EnvVar {
  readonly key: string;
  readonly kind: EnvKind;
  /** The value config.ts falls back to. `null` means "unset is meaningful". */
  readonly default: string | null;
  /** The property name on the config object, so the two cannot drift. */
  readonly field: string;
  readonly secret: boolean;
  readonly description: string;
}

export const ENV: readonly EnvVar[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    kind: 'string',
    default: null,
    field: 'anthropicApiKey',
    secret: true,
    description:
      'The only credential this repo takes, and it NEVER ships in the extension: a browser extension bundle is readable by anyone who installs it, so the Claude read lives behind HTTP instead. Unset means the deterministic verdict still works and the agenda read reports itself unavailable.',
  },
  {
    key: 'BOT_DETECTOR_PORT',
    kind: 'int',
    default: '3200',
    field: 'port',
    secret: false,
    description: 'The port the optional server binds.',
  },
  {
    key: 'BOT_DETECTOR_ALLOWED_ORIGINS',
    kind: 'list',
    default: 'chrome-extension://,http://localhost,http://127.0.0.1',
    field: 'allowedOrigins',
    secret: false,
    description:
      'Comma-separated CORS allowlist. An entry matches exactly, or as a bare scheme prefix ending in `://` (so `chrome-extension://` covers the extension without pinning a per-install id). The default is for local use only; if this is ever exposed on a hostname, narrow it to the exact `chrome-extension://<id>` and put the hostname behind an identity challenge.',
  },
  {
    key: 'BOT_DETECTOR_DB_PATH',
    kind: 'string',
    default: 'data/cache.db',
    field: 'dbPath',
    secret: false,
    description:
      'The SQLite cache file, relative to the repo root. A rebuildable cache rather than operational state, which is what makes "delete it" safe.',
  },
  {
    key: 'BOT_DETECTOR_PROFILE_TTL_SECONDS',
    kind: 'int',
    default: '21600',
    field: 'profileTtlSeconds',
    secret: false,
    description:
      'How long a cached profile lives. Profiles hold comment BODIES, so this is a data-retention bound and not only a performance knob: expiry is a physical DELETE, not a read-time filter.',
  },
  {
    key: 'BOT_DETECTOR_VERDICT_TTL_SECONDS',
    kind: 'int',
    default: '86400',
    field: 'verdictTtlSeconds',
    secret: false,
    description:
      'How long a deterministic verdict is reused. A verdict is a pure function of the profile, so this only skips the archive round trip.',
  },
  {
    key: 'BOT_DETECTOR_LLM_TTL_SECONDS',
    kind: 'int',
    default: '1209600',
    field: 'llmTtlSeconds',
    secret: false,
    description:
      'How long a Claude agenda read is reused. Much longer than the verdict TTL on purpose: the read costs real money and an account’s agenda moves over weeks, not hours.',
  },
  {
    key: 'BOT_AGENDA_MODEL',
    kind: 'string',
    default: 'claude-opus-5',
    field: 'agendaModel',
    secret: false,
    description:
      'The model for the agenda read. Opus rather than a cheap model because this is the one judgement call pattern-matching cannot make -- stock talking points versus an opinion someone genuinely holds -- and a cheap model gets it wrong confidently.',
  },
  {
    key: 'BOT_AGENDA_MAX_COMMENTS',
    kind: 'int',
    default: '60',
    field: 'agendaMaxComments',
    secret: false,
    description:
      'How many of an account’s comments go into one pack. Caps token cost and, just as much, how much of a stranger’s history is shipped to a third party in one request.',
  },
  {
    key: 'BOT_AGENDA_MAX_COMMENT_CHARS',
    kind: 'int',
    default: '700',
    field: 'agendaMaxCommentChars',
    secret: false,
    description: 'Per-comment body budget. Long comments are truncated with a marker rather than dropped, so citation ids stay stable.',
  },
  {
    key: 'BOT_AGENDA_MAX_TOKENS',
    kind: 'int',
    default: '8000',
    field: 'agendaMaxTokens',
    secret: false,
    description:
      'Output budget for the agenda read. THINKING COUNTS AGAINST THIS as well as the JSON, which is why it is well above what the report itself needs. A max_tokens stop fails loudly rather than handing back truncated JSON.',
  },
] as const;
