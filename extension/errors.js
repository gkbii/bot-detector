/**
 * EVERY ERROR THIS REPO THROWS, as a coded taxonomy in one file.
 *
 * A caller branches on `code`, never on the message. `domain` is the tag the
 * log helper prints. `httpStatus` is what the optional server answers with, so
 * the HTTP layer needs no table of its own. `test/conformance.test.cjs`
 * forbids a bare `throw new Error` under extension/ and server/, so a new
 * failure mode is a new entry in ERRORS first.
 *
 * WHY THIS LIVES IN extension/ AND NOT IN A src/ OF ITS OWN. The extension
 * must stay copy-out-able: `extension/` is what Chrome loads unpacked, and
 * nothing it imports may sit above it. The server reaches in the other
 * direction (`server/deterministic.ts` already imports the scoring core the
 * same way), so extension/ is the only home that works for both halves.
 *
 * `kind` is an alias of `code`, kept because the worker's message envelope and
 * `providers/index.js` were written against it and it crosses the
 * `chrome.runtime.sendMessage` boundary as data. One name in new code: `code`.
 *
 * The two classic content scripts cannot import this file at all -- Chrome
 * does not support ES modules for declaratively-injected content scripts -- so
 * `content/badge.js` builds coded errors with its own factory and
 * `test/errors.test.js` asserts the codes it uses are declared here. A test
 * rather than a rule, because a second list that nothing compares is how the
 * two drift.
 */

/** @typedef {'lookup'|'scoring'|'source'|'worker'|'backend'|'agenda'|'pack'|'deterministic'|'http'} ErrorDomain */

/**
 * The registry of codes. `docs/registry.md` is rendered from this.
 * @type {Readonly<Record<string, { code: string, domain: ErrorDomain, httpStatus: number, summary: string }>>}
 */
export const ERRORS = Object.freeze({
  // --- lookup: the account itself -----------------------------------------
  'not-found': { code: 'not-found', domain: 'lookup', httpStatus: 404, summary: 'No archive data for the account (deleted, suspended, or a typo).' },
  'core-mismatch': { code: 'core-mismatch', domain: 'lookup', httpStatus: 500, summary: 'The scoring core loaded but does not match the expected interface.' },

  // --- scoring: the pure function's argument contract ----------------------
  'bad-profile': { code: 'bad-profile', domain: 'scoring', httpStatus: 400, summary: 'scoreAccount() was called without an AccountProfile.' },

  // --- source: the archive ------------------------------------------------
  'no-fetch-impl': { code: 'no-fetch-impl', domain: 'source', httpStatus: 500, summary: 'No fetch implementation was available to fetchAccount().' },
  'request-ceiling': { code: 'request-ceiling', domain: 'source', httpStatus: 429, summary: 'One lookup hit its hard request ceiling.' },
  'archive-request-failed': { code: 'archive-request-failed', domain: 'source', httpStatus: 502, summary: 'An archive request failed and is not retryable.' },

  // --- worker: the MV3 service worker and the queue ------------------------
  'queue-full': { code: 'queue-full', domain: 'worker', httpStatus: 503, summary: 'The lookup queue is at its cap; a long thread queues rather than floods.' },
  'worker-silent': { code: 'worker-silent', domain: 'worker', httpStatus: 503, summary: 'The extension worker did not answer a message.' },
  'worker-reloaded': { code: 'worker-reloaded', domain: 'worker', httpStatus: 503, summary: 'The extension was reloaded or unloaded under a live page.' },
  'worker-messaging': { code: 'worker-messaging', domain: 'worker', httpStatus: 503, summary: 'chrome.runtime.sendMessage failed for a reason the page cannot fix.' },

  // --- backend: the OPTIONAL server, seen from the extension ---------------
  'backend-error': { code: 'backend-error', domain: 'backend', httpStatus: 502, summary: 'The configured backend answered with something unusable.' },
  'rate-limited': { code: 'rate-limited', domain: 'backend', httpStatus: 429, summary: 'The backend asked us to slow down; the queue backoff, not the UI, handles this.' },

  // --- agenda: the Claude read (server only) -------------------------------
  'no-api-key': { code: 'no-api-key', domain: 'agenda', httpStatus: 503, summary: 'ANTHROPIC_API_KEY is unset, so the agenda read is unavailable.' },
  'sdk-missing': { code: 'sdk-missing', domain: 'agenda', httpStatus: 503, summary: '@anthropic-ai/sdk is not installed, so the agenda read is unavailable.' },
  'empty-pack': { code: 'empty-pack', domain: 'agenda', httpStatus: 503, summary: 'The evidence pack has no comments in it.' },
  refusal: { code: 'refusal', domain: 'agenda', httpStatus: 503, summary: 'The model declined to read the account (safety refusal).' },
  'max-tokens': { code: 'max-tokens', domain: 'agenda', httpStatus: 503, summary: 'The read hit max_tokens before finishing rather than returning partial JSON.' },
  'no-text-block': { code: 'no-text-block', domain: 'agenda', httpStatus: 503, summary: 'The model response carried no text block.' },
  unparseable: { code: 'unparseable', domain: 'agenda', httpStatus: 503, summary: "The model's JSON response did not parse." },

  // --- http: the optional server's request layer --------------------------
  'body-too-large': { code: 'body-too-large', domain: 'http', httpStatus: 413, summary: 'The request body exceeded the server\u2019s cap.' },
  'body-not-object': { code: 'body-not-object', domain: 'http', httpStatus: 400, summary: 'The request body parsed but is not a JSON object.' },
  'body-not-json': { code: 'body-not-json', domain: 'http', httpStatus: 400, summary: 'The request body was not valid JSON.' },
  'bad-request': { code: 'bad-request', domain: 'http', httpStatus: 400, summary: 'A request field failed validation before anything was fetched.' },
  'method-not-allowed': { code: 'method-not-allowed', domain: 'http', httpStatus: 405, summary: 'A known route was asked with a method it does not serve.' },
  'not-a-route': { code: 'not-a-route', domain: 'http', httpStatus: 404, summary: 'No route in the ROUTES table matches the path.' },
  'origin-not-allowed': { code: 'origin-not-allowed', domain: 'http', httpStatus: 403, summary: 'The request Origin is not in the CORS allowlist.' },

  // --- pack / deterministic -----------------------------------------------
  'no-profile': { code: 'no-profile', domain: 'pack', httpStatus: 400, summary: 'buildPack() was called without a profile.' },
  'deterministic-unavailable': { code: 'deterministic-unavailable', domain: 'deterministic', httpStatus: 503, summary: 'The scoring core the server borrows from the extension could not be loaded.' },
});

/** Every code, for the registry renderer and the content-script drift test. */
export const ERROR_CODES = Object.freeze(Object.keys(ERRORS));

/**
 * The one base class. Every throw in this repo is this or a subclass of it.
 */
export class BotDetectorError extends Error {
  /**
   * @param {string} code a key of ERRORS
   * @param {string} [message] the human sentence; defaults to the code's summary
   */
  constructor(code, message) {
    const spec = ERRORS[code];
    if (!spec) {
      // An undeclared code is itself a defect, and a silent fallback would hide
      // it until something downstream branched on `undefined`.
      super(`undeclared error code ${JSON.stringify(code)}: ${message || ''}`);
      this.name = new.target.name;
      this.code = 'core-mismatch';
      this.domain = 'lookup';
      this.httpStatus = 500;
      return;
    }
    super(message || spec.summary);
    this.name = new.target.name;
    this.code = spec.code;
    this.domain = spec.domain;
    this.httpStatus = spec.httpStatus;
  }

  /** Alias of `code`. See the header: it crosses the sendMessage boundary. */
  get kind() {
    return this.code;
  }
}

/** Thrown when the account itself could not be resolved (deleted, suspended, typo). */
export class AccountNotFoundError extends BotDetectorError {
  /** @param {string} username */
  constructor(username) {
    super('not-found', `No archive data for u/${username}`);
    this.username = username;
  }
}

/**
 * A failure of the Claude agenda read. Kept as its own class with the
 * `(code, message)` signature because `server/index.ts` and the server tests
 * both branch on `instanceof AgendaError` to fold the failure into the verdict
 * instead of failing the request.
 */
export class AgendaError extends BotDetectorError {
  /** @param {string} code @param {string} [message] */
  constructor(code, message) {
    super(code, message);
  }
}

/** The scoring core the server borrows from the extension could not be loaded. */
export class DeterministicUnavailableError extends BotDetectorError {
  /** @param {string} message */
  constructor(message) {
    super('deterministic-unavailable', message);
  }
}

/**
 * A coded error with extra fields attached, for the call sites that used to do
 * `Object.assign(new Error(m), { kind, ...extra })`.
 *
 * @param {string} code @param {string} [message] @param {Record<string, unknown>} [extra]
 */
export function codedError(code, message, extra = {}) {
  return Object.assign(new BotDetectorError(code, message), extra);
}

/**
 * The message of something caught. `catch (err)` hands you `unknown`, and every
 * call site that wants to quote the cause had its own `err && err.message`
 * dance before this existed.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
