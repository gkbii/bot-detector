/**
 * providers/local.js — the default provider: everything happens in this browser.
 *
 * The extension's `host_permissions` let the service worker fetch the public
 * archive cross-origin, so there is no CORS problem and therefore no reason to
 * stand up a server. Nothing about the user's browsing leaves the machine
 * except the username being looked up, which goes to Reddit's own public
 * archive and nowhere else.
 *
 * Contract this file consumes (owned by the core, not by this file):
 *   lib/sources/arcticShift.js  export async function fetchAccount(username, opts) -> AccountProfile | null
 *   lib/scoring/index.js        export function scoreAccount(profile, opts) -> Verdict
 *
 * These are STATIC imports on purpose. Dynamic `import()` inside an MV3 module
 * service worker is not reliably supported across Chrome versions, so a
 * "does the dependency exist?" probe of the kind this repo uses for
 * `require()`-based adapters (skill-backend/src/integrations/*.js) cannot be
 * done here at module scope. The graceful-degrade half of that pattern still
 * exists — it just lives one layer out: if these modules are missing, the
 * worker fails to load, every `chrome.runtime.sendMessage` from a content
 * script rejects, and the content script renders its neutral "unavailable"
 * badge instead of touching the page. See background.js's message handler and
 * content/reddit.js's `askBackground()`.
 */

import { fetchAccount } from '../lib/sources/arcticShift.js';
import { scoreAccount } from '../lib/scoring/index.js';

/** Thrown when the account itself could not be resolved (deleted, suspended, typo). */
export class AccountNotFoundError extends Error {
  constructor(username) {
    super(`No archive data for u/${username}`);
    this.name = 'AccountNotFoundError';
    this.kind = 'not-found';
    this.username = username;
  }
}

/**
 * Score an account entirely in the browser.
 *
 * @param {string} username
 * @param {{ platform?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<object>} Verdict
 */
export async function getLocalVerdict(username, opts = {}) {
  const platform = opts.platform || 'reddit';

  if (typeof fetchAccount !== 'function' || typeof scoreAccount !== 'function') {
    // Shape check rather than existence check — a core that loaded but renamed
    // its exports should fail loudly here, not silently score nothing.
    const err = new Error('Core scoring modules loaded but do not match the expected interface');
    err.kind = 'core-mismatch';
    throw err;
  }

  // `fetchImpl` is bound here on purpose, and it is not optional.
  // arcticShift.js defaults it to a bare `globalThis.fetch` and then calls it
  // as `ctx.fetchImpl(...)`, which hands `fetch` a receiver that is not the
  // global scope. A window is forgiving about that; an MV3 service worker is
  // not — it throws `Failed to execute 'fetch' on 'WorkerGlobalScope':
  // Illegal invocation`, and every single lookup fails. Confirmed live in
  // Chrome, not deduced: it is invisible to unit tests, which inject their own
  // fetch stub, and it only ever bites in the one context this actually runs
  // in. Keep this even if the default is fixed upstream.
  const profile = await fetchAccount(username, {
    platform,
    signal: opts.signal,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  if (!profile) throw new AccountNotFoundError(username);

  const verdict = scoreAccount(profile, { platform });
  if (!verdict || typeof verdict !== 'object') {
    const err = new Error('scoreAccount() returned no verdict');
    err.kind = 'core-mismatch';
    throw err;
  }
  return verdict;
}

/**
 * A verdict-shaped object for "we could not learn enough to say anything".
 *
 * This is a UI concern, not a scoring one: the badge and the panel have exactly
 * one rendering path, and absence of evidence has to travel through it as its
 * own visibly-neutral band rather than arriving as a low/clean score. Nothing
 * here invents a number — every axis is `score: null`, `band:
 * 'insufficient-data'`, with a single signal explaining why.
 */
export function insufficientVerdict(username, platform, reason) {
  const axis = () => ({
    band: 'insufficient-data',
    score: null,
    signals: [
      {
        key: 'no-data',
        label: 'No data to score',
        band: 'insufficient-data',
        direction: 'neutral',
        weight: 0,
        value: null,
        evidence: reason,
      },
    ],
  });
  return {
    username,
    platform: platform || 'reddit',
    fetchedAt: new Date().toISOString(),
    automation: axis(),
    agenda: axis(),
    authenticity: axis(),
    headline: 'Not enough data to judge this account.',
    coverage: { commentsFetched: 0, postsFetched: 0, truncated: false, sources: [], errors: [reason] },
  };
}
