// EVERY MESSAGE THAT CROSSES THE EXTENSION'S ONE INTERNAL BOUNDARY.
//
// Content scripts never fetch anything: they ask the MV3 service worker and
// render whatever comes back. That split is the only place a global
// concurrency cap, a global inter-request gap and a global backoff can actually
// be global -- five open Reddit tabs are five content scripts and one worker,
// so the archive sees one polite client rather than five impatient ones.
//
// This was a comment block at the top of extension/background.js. It is data
// now because test/registry.test.js asserts every name here is a handler
// background.js actually registers, and that every handler it registers is
// here -- a protocol documented in a comment is one that drifts silently.

export interface WorkerEvent {
  readonly name: string;
  readonly request: string;
  readonly reply: string;
  readonly description: string;
}

/** Every reply is `{ok: true, data}` or `{ok: false, error: {message, code, kind}}`. */
export const EVENTS: readonly WorkerEvent[] = [
  {
    name: 'BD_LOOKUP',
    request: '{platform, username, deep?, force?}',
    reply: '{verdict, provider, degraded, degradedReason?, cached}',
    description:
      'Score one account. `degraded` is true when a configured backend was unreachable and the worker fell back to local scoring -- which it always reports, because local and backend mode are otherwise indistinguishable from the outside.',
  },
  {
    name: 'BD_STATUS',
    request: '{}',
    reply: '{mode, backendUrl, backendDown, settings, queue, cache}',
    description: 'What the toolbar popup renders: which provider produced the verdicts on screen, the queue depth, the cache size.',
  },
  { name: 'BD_CLEAR_CACHE', request: '{}', reply: '{cleared}', description: 'Drop every cached verdict. The cache is rebuildable by definition, so this is always safe.' },
  { name: 'BD_CLEAR_LOG', request: '{}', reply: '{cleared}', description: 'Drop the signal log the options page shows.' },
  { name: 'BD_GET_LOG', request: '{}', reply: '{entries, max}', description: 'Read the signal log, newest first, capped at `max`.' },
  { name: 'BD_PROBE_BACKEND', request: '{url}', reply: '{ok, agenda, error?}', description: 'Probe a candidate backend URL from the options page before it is saved.' },
] as const;
