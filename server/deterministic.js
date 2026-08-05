// The deterministic half, imported from the extension. ONE IMPLEMENTATION.
//
// The extension is the primary artifact: it calls the Reddit archive directly
// and scores in the browser, and it is fully useful with this server switched
// off. That means the fetch and the scoring already exist, and re-implementing
// either here would immediately produce two answers to the same question --
// the local provider's and the backend's -- that drift apart silently. So the
// server imports the extension's modules rather than owning copies. There is
// no build step and no bundler; Node loads the same ESM files the MV3 service
// worker does.
//
// LOADED LAZILY, AND NEVER STUBBED. A static import would make the whole
// server (including `/api/health`, the cache and the config) fail to load
// while these files are still being written, and a fallback stub would let the
// server answer with numbers nobody computed. Instead the import happens on
// first use and, if it fails, says exactly which file it wanted.

const SOURCE_MODULE = '../extension/lib/sources/arcticShift.js';
const SCORING_MODULE = '../extension/lib/scoring/index.js';

let cached = null;

export class DeterministicUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeterministicUnavailableError';
    this.code = 'deterministic-unavailable';
  }
}

/**
 * @returns {Promise<{ fetchAccount: Function, scoreAccount: Function }>}
 */
export async function loadDeterministic() {
  if (cached) return cached;

  let source;
  let scoring;
  try {
    source = await import(SOURCE_MODULE);
  } catch (err) {
    throw new DeterministicUnavailableError(
      `could not load ${SOURCE_MODULE} (${err.message})`
    );
  }
  try {
    scoring = await import(SCORING_MODULE);
  } catch (err) {
    throw new DeterministicUnavailableError(
      `could not load ${SCORING_MODULE} (${err.message})`
    );
  }

  if (typeof source.fetchAccount !== 'function') {
    throw new DeterministicUnavailableError(`${SOURCE_MODULE} does not export fetchAccount()`);
  }
  if (typeof scoring.scoreAccount !== 'function') {
    throw new DeterministicUnavailableError(`${SCORING_MODULE} does not export scoreAccount()`);
  }

  cached = { fetchAccount: source.fetchAccount, scoreAccount: scoring.scoreAccount };
  return cached;
}

/** Test-only: injects the pair without touching the filesystem. */
export function _setDeterministicForTests(pair) {
  cached = pair;
}

export { SOURCE_MODULE, SCORING_MODULE };
