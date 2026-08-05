/**
 * options.js — settings, the backend probe, and the cache controls.
 *
 * Imports only providers/backend.js (URL normalisation), never providers/index.js:
 * the index pulls in the local scorer and therefore the core modules, and an
 * options page that cannot open because the scoring half is mid-rewrite would
 * be a poor trade for one shared function.
 */

import { normaliseBackendUrl } from './providers/backend.js';

const $ = (id) => document.getElementById(id);

const DEFAULTS = { backendUrl: '', autoScan: true, scanPosts: true };

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
  $('backendUrl').value = stored.backendUrl || '';
  $('mode').textContent = stored.backendUrl ? 'backend' : 'local (in this browser)';
  await refreshCache();
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

$('clearCache').addEventListener('click', async () => {
  try {
    const { cleared } = await ask({ type: 'BD_CLEAR_CACHE' });
    setStatus($('cacheStatus'), `Cleared ${cleared} cached account${cleared === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    setStatus($('cacheStatus'), `Could not clear the cache: ${err.message}`, 'err');
  }
});

load();
