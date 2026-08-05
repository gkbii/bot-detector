/**
 * providers/index.js — the seam between "who scored this account" and
 * "everything that displays a score".
 *
 * This is the same adapter shape this repo already uses three times on the
 * Node side (skill-backend/src/integrations/{haClient,taskRunner,messageReminders}.js):
 * a documented interface, a probe for whether the richer dependency is
 * actually there, and a graceful degrade to the simpler one that says so out
 * loud. Here the "richer dependency" is an optional user-run backend and the
 * fallback is local scoring.
 *
 * Resolution:
 *   chrome.storage.sync.backendUrl empty (the default) -> providers/local.js
 *   chrome.storage.sync.backendUrl set                 -> providers/backend.js
 *   set but unreachable                                -> providers/local.js, degraded: true
 *
 * A degraded run is never silent. `degraded` + `degradedReason` ride along with
 * every verdict and the expanded card prints them, because local mode looking
 * indistinguishable from backend mode is how someone ends up believing an LLM
 * read an account when nothing of the sort happened.
 */

import { getLocalVerdict, insufficientVerdict, AccountNotFoundError } from './local.js';
import { getBackendVerdict, probeBackendHealth, normaliseBackendUrl } from './backend.js';

export { insufficientVerdict, AccountNotFoundError, probeBackendHealth, normaliseBackendUrl };

export const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: '',
  autoScan: true,
  scanPosts: true,
});

/** How long a failed backend is considered down before we try it again. */
const BACKEND_DOWN_MS = 60_000;

let settingsMemo = null;
let backendDownUntil = 0;
let backendDownReason = '';

// Settings live in storage.sync so they follow the user's profile between
// machines; the verdict cache lives in storage.local (see background.js)
// because it is bulk, rebuildable, and per-machine.
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    settingsMemo = null;
    if (Object.prototype.hasOwnProperty.call(changes, 'backendUrl')) {
      backendDownUntil = 0;
      backendDownReason = '';
    }
  });
}

/** @returns {Promise<{backendUrl: string, autoScan: boolean, scanPosts: boolean}>} */
export async function getSettings() {
  if (settingsMemo) return settingsMemo;
  let stored = {};
  try {
    stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  } catch {
    stored = {};
  }
  settingsMemo = {
    backendUrl: normaliseBackendUrl(stored.backendUrl),
    autoScan: stored.autoScan !== false,
    scanPosts: stored.scanPosts !== false,
  };
  return settingsMemo;
}

/** What the popup/options and the content script show as the current mode. */
export async function describeMode() {
  const { backendUrl } = await getSettings();
  return {
    mode: backendUrl ? 'backend' : 'local',
    backendUrl,
    backendDown: backendUrl ? Date.now() < backendDownUntil : false,
    backendDownReason: backendDownReason || undefined,
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The one entry point everything else calls.
 *
 * @param {string} username
 * @param {{ platform?: string, deep?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<{verdict: object, provider: 'local'|'backend', degraded: boolean, degradedReason?: string}>}
 */
export async function getVerdict(username, opts = {}) {
  const platform = opts.platform || 'reddit';
  const deep = Boolean(opts.deep);
  const { backendUrl } = await getSettings();

  if (!backendUrl) {
    const verdict = await localOrInsufficient(username, platform, opts.signal);
    // A deep read is a backend-only capability. Asking for one with no backend
    // configured is a UI bug rather than a user error, but if it happens the
    // answer is a real local verdict that admits what it is not.
    return deep
      ? {
          verdict,
          provider: 'local',
          degraded: true,
          degradedReason: 'A deep LLM read needs a backend; no backend is configured, so this is the local score.',
        }
      : { verdict, provider: 'local', degraded: false };
  }

  if (Date.now() < backendDownUntil) {
    const verdict = await localOrInsufficient(username, platform, opts.signal);
    return {
      verdict,
      provider: 'local',
      degraded: true,
      degradedReason: `Backend ${hostOf(backendUrl)} is not responding (${backendDownReason}); scored locally in your browser instead.`,
    };
  }

  try {
    const verdict = await getBackendVerdict(backendUrl, username, { platform, deep, signal: opts.signal });
    backendDownUntil = 0;
    backendDownReason = '';
    return { verdict, provider: 'backend', degraded: false };
  } catch (err) {
    if (err && err.kind === 'rate-limited') throw err; // the queue's backoff should see this, not the UI
    if (err && err.kind === 'not-found') {
      // The backend is healthy and answered definitively. Nothing to degrade.
      return {
        verdict: insufficientVerdict(username, platform, `No archive data returned for u/${username}.`),
        provider: 'backend',
        degraded: false,
      };
    }
    backendDownUntil = Date.now() + BACKEND_DOWN_MS;
    backendDownReason = err && err.message ? err.message : 'unknown error';
    const verdict = await localOrInsufficient(username, platform, opts.signal);
    return {
      verdict,
      provider: 'local',
      degraded: true,
      degradedReason: `Backend ${hostOf(backendUrl)} failed (${backendDownReason}); scored locally in your browser instead.`,
    };
  }
}

async function localOrInsufficient(username, platform, signal) {
  try {
    return await getLocalVerdict(username, { platform, signal });
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      return insufficientVerdict(username, platform, `No archive data returned for u/${username}.`);
    }
    throw err;
  }
}
