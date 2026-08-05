/**
 * providers/backend.js — the optional second provider.
 *
 * Nothing in the shipped product needs this. It exists because the design
 * brief is "standalone now, structured so a backend is easy to add later,
 * specifically so Claude can do part of the analysis" — an LLM read of an
 * account's agenda needs an API key, and an API key must not sit in an
 * extension that anyone can unzip.
 *
 * The wire contract, kept deliberately small:
 *   POST {backendUrl}/api/verdict  {platform, username, deep}
 *        -> {verdict, provider: 'backend'}      // same Verdict shape as local
 *   GET  {backendUrl}/api/health
 *        -> {ok: boolean, agenda: boolean}      // `agenda` = an LLM read is available
 *
 * A backend verdict may carry one extra block the local scorer never produces,
 * `verdict.agenda.llm`, which the panel renders when present. Everything else
 * must be shape-identical, so the UI has one renderer.
 */

const DEFAULT_TIMEOUT_MS = 20000;
const DEEP_TIMEOUT_MS = 90000;
const HEALTH_TIMEOUT_MS = 5000;

/** Normalise a user-typed backend URL to an origin + path prefix with no trailing slash. */
export function normaliseBackendUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    try {
      url = new URL(`http://${trimmed}`);
    } catch {
      return '';
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function timeoutSignal(ms, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${ms}ms`)), ms);
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => ctrl.abort(outerSignal.reason), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function backendError(message, kind, extra = {}) {
  const err = new Error(message);
  err.kind = kind || 'backend-error';
  Object.assign(err, extra);
  return err;
}

/**
 * @param {string} backendUrl already normalised
 * @param {string} username
 * @param {{ platform?: string, deep?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<object>} Verdict
 */
export async function getBackendVerdict(backendUrl, username, opts = {}) {
  const deep = Boolean(opts.deep);
  const { signal, done } = timeoutSignal(deep ? DEEP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, opts.signal);
  let res;
  try {
    res = await fetch(`${backendUrl}/api/verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: opts.platform || 'reddit', username, deep }),
      signal,
    });
  } catch (err) {
    throw backendError(`could not reach ${backendUrl} (${err.message})`, 'backend-unreachable');
  } finally {
    done();
  }

  // Only 429 is a "slow down" — it arms the queue's shared backoff instead of
  // degrading, because retrying a rate limit from a different tab is the exact
  // behaviour a rate limit exists to stop.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw backendError('backend is rate limiting (429)', 'rate-limited', {
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    });
  }
  // The server answers 404 when the account genuinely does not exist. That is a
  // fact, not a backend failure — falling back to local scoring would just make
  // a second pointless archive request to learn the same thing.
  if (res.status === 404) {
    throw backendError(`no such account: ${username}`, 'not-found', { status: 404 });
  }
  // Everything else — including 503, which this server uses for "my own
  // scoring modules failed to load" rather than for rate limiting — degrades to
  // local scoring. Local can answer all three axes; only the LLM read is lost.
  if (!res.ok) {
    throw backendError(`backend returned ${res.status}`, 'backend-error', { status: res.status });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw backendError('backend returned a non-JSON body', 'backend-error');
  }
  const verdict = body && body.verdict;
  if (!verdict || typeof verdict !== 'object') {
    throw backendError('backend response had no verdict', 'backend-error');
  }
  return verdict;
}

/**
 * Health probe. Never throws — the caller wants a fact, not an exception, and
 * "unreachable" is a legitimate answer that the options page displays.
 *
 * @returns {Promise<{ok: boolean, agenda: boolean, error?: string}>}
 */
export async function probeBackendHealth(backendUrl) {
  if (!backendUrl) return { ok: false, agenda: false, error: 'no backend configured' };
  const { signal, done } = timeoutSignal(HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal });
    if (!res.ok) return { ok: false, agenda: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: Boolean(body && body.ok), agenda: Boolean(body && body.agenda) };
  } catch (err) {
    return { ok: false, agenda: false, error: err.message || 'unreachable' };
  } finally {
    done();
  }
}
