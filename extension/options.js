/**
 * options.js — settings, the backend probe, the cache controls, and the
 * signal-log viewer.
 *
 * Imports only providers/backend.js (URL normalisation), never providers/index.js:
 * the index pulls in the local scorer and therefore the core modules, and an
 * options page that cannot open because the scoring half is mid-rewrite would
 * be a poor trade for one shared function.
 */

import { normaliseBackendUrl } from './providers/backend.js';

const $ = (id) => document.getElementById(id);

const DEFAULTS = { backendUrl: '', autoScan: true, scanPosts: true, autoLookup: false };

function setStatus(node, message, kind) {
  node.textContent = message || '';
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

async function ask(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res) throw new Error('the extension worker did not respond');
  if (!res.ok) throw new Error((res.error && res.error.message) || 'failed');
  return res.data;
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  $('autoScan').checked = stored.autoScan !== false;
  $('scanPosts').checked = stored.scanPosts !== false;
  $('autoLookup').checked = stored.autoLookup === true;
  $('backendUrl').value = stored.backendUrl || '';
  $('mode').textContent = stored.backendUrl ? 'backend' : 'local (in this browser)';
  await Promise.all([refreshCache(), refreshLog()]);
}

async function refreshCache() {
  try {
    const status = await ask({ type: 'BD_STATUS' });
    const { entries, max, ttlHours } = status.cache;
    setStatus($('cacheStatus'), `${entries} of ${max} accounts cached · ${ttlHours}h TTL · ${status.queue.queued} queued, ${status.queue.active} in flight`);
  } catch (err) {
    setStatus($('cacheStatus'), `Could not read extension state: ${err.message}`, 'err');
  }
}

$('autoScan').addEventListener('change', async (event) => {
  await chrome.storage.sync.set({ autoScan: event.target.checked });
});

$('scanPosts').addEventListener('change', async (event) => {
  await chrome.storage.sync.set({ scanPosts: event.target.checked });
});

$('autoLookup').addEventListener('change', async (event) => {
  await chrome.storage.sync.set({ autoLookup: event.target.checked });
});

$('save').addEventListener('click', async () => {
  const raw = $('backendUrl').value.trim();
  if (!raw) {
    await chrome.storage.sync.set({ backendUrl: '' });
    $('mode').textContent = 'local (in this browser)';
    setStatus($('backendStatus'), 'Saved. Scoring happens in this browser.', 'ok');
    return;
  }
  const url = normaliseBackendUrl(raw);
  if (!url) {
    setStatus($('backendStatus'), 'That is not a valid http:// or https:// URL.', 'err');
    return;
  }

  // Host permission is requested here, on a real user gesture, for this one
  // origin — not claimed at install time for every site on the internet.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
  } catch (err) {
    setStatus($('backendStatus'), `Could not request permission for ${url}: ${err.message}`, 'err');
    return;
  }
  if (!granted) {
    setStatus($('backendStatus'), 'Permission denied, so the backend was not saved. Scoring stays local.', 'warn');
    return;
  }

  await chrome.storage.sync.set({ backendUrl: url });
  $('backendUrl').value = url;
  $('mode').textContent = 'backend';
  setStatus($('backendStatus'), `Saved ${url}. Testing…`);
  await test(url);
});

$('test').addEventListener('click', () => test(normaliseBackendUrl($('backendUrl').value)));

async function test(url) {
  if (!url) {
    setStatus($('backendStatus'), 'No backend URL to test — scoring is local.', 'warn');
    return;
  }
  setStatus($('backendStatus'), `Probing ${url}/api/health…`);
  try {
    const health = await ask({ type: 'BD_PROBE_BACKEND', url });
    if (!health.ok) {
      setStatus($('backendStatus'), `${url} did not answer /api/health (${health.error || 'no ok flag'}). Lookups will fall back to local scoring and every card will say so.`, 'warn');
      return;
    }
    setStatus(
      $('backendStatus'),
      health.agenda
        ? `${url} is up, and reports an LLM agenda read is available. The deep read button appears on each card.`
        : `${url} is up, but reports no LLM agenda read. Verdicts will come from the backend without a deep read.`,
      'ok',
    );
  } catch (err) {
    setStatus($('backendStatus'), `Probe failed: ${err.message}`, 'err');
  }
}

$('clearBackend').addEventListener('click', async () => {
  await chrome.storage.sync.set({ backendUrl: '' });
  $('backendUrl').value = '';
  $('mode').textContent = 'local (in this browser)';
  setStatus($('backendStatus'), 'Backend cleared. Everything is scored in this browser.', 'ok');
});

// ---------------------------------------------------------------------------
// Signal log — renders what the worker recorded (see background.js). All text
// lands via textContent: evidence strings quote account content and usernames,
// and this page is not going to be the place they become markup.
// ---------------------------------------------------------------------------
let logEntries = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function bandText(band, score) {
  if (!band) return '?';
  return band === 'insufficient-data' ? 'no data' : `${band}${score != null ? ` ${score}` : ''}`;
}

function fmtValue(value) {
  if (value == null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value);
}

function signalTable(axis) {
  const table = el('table', 'log-signals');
  const head = table.createTHead().insertRow();
  for (const h of ['signal', 'band', 'direction', 'weight', 'value']) {
    head.appendChild(el('th', null, h));
  }
  head.appendChild(el('th', null, 'evidence'));
  const body = table.createTBody();
  for (const s of axis.signals || []) {
    const row = body.insertRow();
    row.appendChild(el('td', null, s.label || s.key));
    row.appendChild(el('td', `band-${s.band}`, s.band === 'insufficient-data' ? 'unmeasured' : s.band));
    row.appendChild(el('td', null, s.direction || 'neutral'));
    row.appendChild(el('td', 'num', String(s.weight)));
    row.appendChild(el('td', 'num', fmtValue(s.value)));
    row.appendChild(el('td', null, s.evidence || ''));
  }
  return table;
}

function renderEntry(entry) {
  const details = el('details', 'log-entry');
  const summary = el('summary');
  summary.appendChild(el('span', 'who', `u/${entry.username}`));

  if (entry.outcome !== 'scored') {
    summary.appendChild(document.createTextNode(' — lookup failed'));
    details.appendChild(summary);
    details.appendChild(el('p', 'log-note', `${entry.error?.kind || 'error'}: ${entry.error?.message || 'unknown error'}`));
    details.appendChild(el('p', 'log-note', `at ${entry.at} · looked up ${entry.lookups}×`));
    return details;
  }

  for (const name of ['automation', 'agenda', 'authenticity']) {
    const a = entry.axes?.[name];
    summary.appendChild(document.createTextNode(' · '));
    summary.appendChild(el('span', null, `${name} `));
    summary.appendChild(el('span', a ? `band-${a.band}` : null, bandText(a?.band, a?.score)));
  }
  const how = [entry.provider, entry.cached ? 'cached' : null, entry.degraded ? 'degraded' : null]
    .filter(Boolean).join(', ');
  summary.appendChild(el('span', 'meta', `  (${how})`));
  details.appendChild(summary);

  if (entry.headline) details.appendChild(el('p', 'log-headline', entry.headline));
  if (entry.degradedReason) details.appendChild(el('p', 'log-note', entry.degradedReason));

  const cov = entry.coverage;
  if (cov) {
    const parts = [
      `${cov.commentsFetched ?? '?'} comments and ${cov.postsFetched ?? '?'} posts fetched`,
      cov.truncated ? 'history truncated' : 'no truncation proven',
    ];
    if (cov.errors?.length) parts.push(`${cov.errors.length} lookup error(s)`);
    details.appendChild(el('p', 'log-note', `Coverage: ${parts.join(' · ')}`));
  }
  details.appendChild(el('p', 'log-note', `Fetched ${entry.fetchedAt || entry.at} · looked up ${entry.lookups}× this session`));

  for (const name of ['automation', 'agenda', 'authenticity']) {
    const a = entry.axes?.[name];
    if (!a) continue;
    details.appendChild(el('p', 'log-axis', `${name} — ${bandText(a.band, a.score)}`));
    details.appendChild(signalTable(a));
  }
  return details;
}

async function refreshLog() {
  const list = $('logList');
  try {
    const { entries, max } = await ask({ type: 'BD_GET_LOG' });
    logEntries = entries || [];
    list.replaceChildren(...logEntries.map(renderEntry));
    setStatus(
      $('logStatus'),
      logEntries.length
        ? `${logEntries.length} account${logEntries.length === 1 ? '' : 's'} logged (newest first, cap ${max}). Click one for the per-signal working.`
        : 'Nothing logged yet this browser session. Scroll a Reddit thread with badging on, then hit Refresh.',
    );
  } catch (err) {
    setStatus($('logStatus'), `Could not read the signal log: ${err.message}`, 'err');
  }
}

$('refreshLog').addEventListener('click', refreshLog);

$('exportLog').addEventListener('click', () => {
  if (!logEntries.length) {
    setStatus($('logStatus'), 'Nothing to export — the log is empty.', 'warn');
    return;
  }
  const blob = new Blob([JSON.stringify(logEntries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bot-detector-signal-log-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('clearLog').addEventListener('click', async () => {
  try {
    const { cleared } = await ask({ type: 'BD_CLEAR_LOG' });
    logEntries = [];
    $('logList').replaceChildren();
    setStatus($('logStatus'), `Cleared ${cleared} logged account${cleared === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    setStatus($('logStatus'), `Could not clear the log: ${err.message}`, 'err');
  }
});

$('clearCache').addEventListener('click', async () => {
  try {
    const { cleared } = await ask({ type: 'BD_CLEAR_CACHE' });
    setStatus($('cacheStatus'), `Cleared ${cleared} cached account${cleared === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    setStatus($('cacheStatus'), `Could not clear the cache: ${err.message}`, 'err');
  }
});

load();
