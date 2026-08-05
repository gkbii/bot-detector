/**
 * Bot Detector — MV3 service worker.
 *
 * The worker owns the lookup queue. Content scripts never fetch anything; they
 * ask (`chrome.runtime.sendMessage`) and render whatever comes back. That split
 * is not tidiness — it is the only place where a global concurrency cap, a
 * global inter-request gap, and a global backoff can actually be global. Five
 * open Reddit tabs are five content scripts and one worker, so the archive
 * sees one polite client rather than five impatient ones.
 *
 * The archive this points at is a free public service run by a volunteer. Every
 * limit below exists to keep this extension from being the reason it stops
 * being free and public.
 *
 * Message protocol (all replies are {ok: true, data} | {ok: false, error}):
 *   BD_LOOKUP        {platform, username, deep?, force?} -> {verdict, provider, degraded, degradedReason?, cached}
 *   BD_STATUS        {}                                  -> {mode, backendUrl, backendDown, settings, queue, cache}
 *   BD_CLEAR_CACHE   {}                                  -> {cleared}
 *   BD_PROBE_BACKEND {url}                               -> {ok, agenda, error?}
 */

import { getVerdict, getSettings, describeMode, probeBackendHealth, normaliseBackendUrl } from './providers/index.js';

// ---------------------------------------------------------------------------
// Limits. All of them are about being a good citizen of a free public archive.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = 3;        // in flight across every tab, not per tab
const MIN_REQUEST_GAP_MS = 300;  // between the *starts* of two lookups
const MAX_QUEUE = 250;           // a very long thread queues, it does not flood
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 120_000;

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_CACHE_ENTRIES = 300;
const CACHE_EVICT_TO = 240;               // LRU-evict down to this on overflow
const CACHE_PREFIX = 'bd:v1:';
const CACHE_INDEX_KEY = 'bd:v1:index';
const INDEX_FLUSH_MS = 2000;

// ---------------------------------------------------------------------------
// Cache — chrome.storage.local, keyed platform:username, TTL + LRU cap.
// One entry per key plus a single small index, so touching an entry's
// last-used time does not rewrite every verdict we hold.
// ---------------------------------------------------------------------------
let cacheIndex = null;
let indexDirty = false;
let indexFlushTimer = null;

function cacheKey(platform, username) {
  return `${CACHE_PREFIX}${platform}:${String(username).toLowerCase()}`;
}

async function loadIndex() {
  if (cacheIndex) return cacheIndex;
  try {
    const got = await chrome.storage.local.get(CACHE_INDEX_KEY);
    cacheIndex = (got && got[CACHE_INDEX_KEY]) || {};
  } catch {
    cacheIndex = {};
  }
  return cacheIndex;
}

function markIndexDirty() {
  indexDirty = true;
  if (indexFlushTimer) return;
  indexFlushTimer = setTimeout(() => {
    indexFlushTimer = null;
    flushIndex();
  }, INDEX_FLUSH_MS);
}

async function flushIndex() {
  if (!indexDirty || !cacheIndex) return;
  indexDirty = false;
  try {
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: cacheIndex });
  } catch {
    indexDirty = true;
  }
}

async function readCache(platform, username, { needDeep = false } = {}) {
  const key = cacheKey(platform, username);
  const index = await loadIndex();
  const meta = index[key];
  if (!meta) return null;
  if (Date.now() - meta.storedAt > CACHE_TTL_MS) {
    delete index[key];
    markIndexDirty();
    chrome.storage.local.remove(key).catch(() => {});
    return null;
  }
  if (needDeep && !meta.deep) return null;
  let entry;
  try {
    const got = await chrome.storage.local.get(key);
    entry = got && got[key];
  } catch {
    entry = null;
  }
  if (!entry || !entry.verdict) {
    delete index[key];
    markIndexDirty();
    return null;
  }
  meta.lastUsedAt = Date.now();
  markIndexDirty();
  return entry;
}

async function writeCache(platform, username, entry) {
  const key = cacheKey(platform, username);
  const index = await loadIndex();
  const now = Date.now();
  index[key] = { storedAt: now, lastUsedAt: now, deep: Boolean(entry.deep) };
  try {
    await chrome.storage.local.set({ [key]: { ...entry, storedAt: now } });
  } catch {
    delete index[key];
    return;
  }
  markIndexDirty();
  await evictIfNeeded();
}

async function evictIfNeeded() {
  const index = await loadIndex();
  const keys = Object.keys(index);
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  keys.sort((a, b) => (index[a].lastUsedAt || 0) - (index[b].lastUsedAt || 0));
  const doomed = keys.slice(0, keys.length - CACHE_EVICT_TO);
  for (const key of doomed) delete index[key];
  markIndexDirty();
  try {
    await chrome.storage.local.remove(doomed);
  } catch {
    /* the index no longer references them; orphans are harmless */
  }
}

async function clearCache() {
  const index = await loadIndex();
  const keys = Object.keys(index);
  cacheIndex = {};
  indexDirty = true;
  try {
    await chrome.storage.local.remove([...keys, CACHE_INDEX_KEY]);
  } catch {
    /* ignore */
  }
  await flushIndex();
  return keys.length;
}

// ---------------------------------------------------------------------------
// Queue — global concurrency cap, minimum gap, shared backoff, dedupe.
// ---------------------------------------------------------------------------
const queue = [];
const inflight = new Map(); // key -> Promise, so a name visible in three tabs is one lookup
let active = 0;
let lastStartedAt = 0;
let cooldownUntil = 0;
let consecutiveFailures = 0;
let pumpTimer = null;

function schedulePump(delayMs) {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pump();
  }, Math.max(delayMs, 0));
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const now = Date.now();
    const wait = Math.max(cooldownUntil - now, lastStartedAt + MIN_REQUEST_GAP_MS - now, 0);
    if (wait > 0) {
      schedulePump(wait);
      return;
    }
    const job = queue.shift();
    lastStartedAt = Date.now();
    active += 1;
    runJob(job).finally(() => {
      active -= 1;
      pump();
    });
  }
}

async function runJob(job) {
  try {
    const result = await getVerdict(job.username, { platform: job.platform, deep: job.deep });
    consecutiveFailures = 0;
    cooldownUntil = 0;
    const entry = {
      verdict: result.verdict,
      provider: result.provider,
      degraded: Boolean(result.degraded),
      degradedReason: result.degradedReason,
      deep: Boolean(job.deep),
    };
    // A degraded result is still a real verdict and worth caching — but only
    // for the entry itself. It carries its own reason string, so a cache hit
    // still tells the truth about how it was produced.
    await writeCache(job.platform, job.username, entry);
    job.resolve({ ...entry, cached: false });
  } catch (err) {
    consecutiveFailures += 1;
    const explicit = Number(err && err.retryAfterMs);
    const backoff = Number.isFinite(explicit) && explicit > 0
      ? Math.min(explicit, BACKOFF_MAX_MS)
      : Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
    cooldownUntil = Date.now() + backoff;
    job.reject(err);
  }
}

/**
 * @param {{platform: string, username: string, deep?: boolean, force?: boolean}} req
 */
async function requestVerdict(req) {
  const platform = req.platform || 'reddit';
  const username = String(req.username || '').trim();
  const deep = Boolean(req.deep);
  if (!username) throw taggedError('no username given', 'bad-request');

  if (!req.force) {
    const cached = await readCache(platform, username, { needDeep: deep });
    if (cached) return { ...cached, cached: true };
  }

  const key = `${platform}:${username.toLowerCase()}:${deep ? 'deep' : 'shallow'}`;
  if (inflight.has(key)) return inflight.get(key);

  if (queue.length >= MAX_QUEUE) throw taggedError('lookup queue is full', 'queue-full');

  const promise = new Promise((resolve, reject) => {
    queue.push({ platform, username, deep, resolve, reject });
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  pump();
  return promise;
}

function taggedError(message, kind) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

// ---------------------------------------------------------------------------
// Message router.
// ---------------------------------------------------------------------------
const handlers = {
  async BD_LOOKUP(msg) {
    return requestVerdict(msg);
  },
  async BD_STATUS() {
    const [mode, settings, index] = await Promise.all([describeMode(), getSettings(), loadIndex()]);
    return {
      ...mode,
      settings,
      queue: { queued: queue.length, active, cooldownMs: Math.max(cooldownUntil - Date.now(), 0) },
      cache: { entries: Object.keys(index).length, ttlHours: CACHE_TTL_MS / 3600000, max: MAX_CACHE_ENTRIES },
    };
  },
  async BD_CLEAR_CACHE() {
    return { cleared: await clearCache() };
  },
  async BD_PROBE_BACKEND(msg) {
    const url = normaliseBackendUrl(msg && msg.url);
    if (!url) return { ok: false, agenda: false, error: 'not a valid http(s) URL' };
    return probeBackendHealth(url);
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({
      ok: false,
      error: { message: (err && err.message) || String(err), kind: (err && err.kind) || 'error' },
    }));
  return true; // async reply
});

chrome.runtime.onInstalled.addListener(() => {
  // Nothing to migrate yet; the cache is rebuildable by definition, so a
  // version bump that changes the Verdict shape should bump CACHE_PREFIX
  // rather than try to upgrade stored verdicts in place.
});
