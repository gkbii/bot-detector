/**
 * popup.js — a status readout, not a control panel.
 *
 * The one thing it must always answer correctly is "where did the verdicts I am
 * looking at come from", because local mode and backend mode look identical
 * from the outside and only one of them involves sending usernames to a server.
 */

const $ = (id) => document.getElementById(id);

async function ask(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res) throw new Error('the extension worker did not respond');
  if (!res.ok) throw new Error((res.error && res.error.message) || 'failed');
  return res.data;
}

async function refresh() {
  try {
    const status = await ask({ type: 'BD_STATUS' });
    const backend = status.mode === 'backend';
    const down = backend && status.backendDown;

    $('mode').textContent = down ? 'local (backend down)' : backend ? 'your backend' : 'this browser';
    $('mode').className = `v ${down ? 'warn' : backend ? 'backend' : 'local'}`;
    $('autoScan').checked = status.settings.autoScan !== false;
    $('cache').textContent = `${status.cache.entries} / ${status.cache.max}`;
    $('queue').textContent = `${status.queue.queued} / ${status.queue.active}`;

    $('sub').textContent = backend
      ? 'Verdicts come from your configured backend.'
      : 'Verdicts are computed in this browser. Nothing but usernames leaves your machine.';

    const notes = [];
    if (down) notes.push(`Backend not responding: ${status.backendDownReason || 'unknown'}. Falling back to local scoring; cards say so.`);
    if (status.queue.cooldownMs > 0) notes.push(`Backing off the archive for ${Math.ceil(status.queue.cooldownMs / 1000)}s.`);
    $('note').textContent = notes.join(' ');
  } catch (err) {
    $('sub').textContent = 'The extension worker is not answering.';
    $('note').textContent = `${err.message} — if the scoring modules under extension/lib/ are missing, Chrome will show the load error on chrome://extensions.`;
  }
}

$('autoScan').addEventListener('change', async (event) => {
  await chrome.storage.sync.set({ autoScan: event.target.checked });
});

$('clearCache').addEventListener('click', async () => {
  try {
    await ask({ type: 'BD_CLEAR_CACHE' });
    await refresh();
  } catch {
    $('note').textContent = 'Could not clear the cache.';
  }
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();
