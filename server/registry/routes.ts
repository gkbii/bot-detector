// EVERY HTTP ROUTE THE OPTIONAL SERVER SERVES. `server/index.ts` dispatches by
// looking a request up in this table -- it is not documentation beside an
// if-chain, it IS the if-chain, which is what stops the two disagreeing.
//
// A route not in this table is a 404; a route in it, asked with the wrong
// method, is a 405. Both of those used to be a branch per route.

export interface Route {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** The key on the handler map `createApp()` builds. */
  readonly handler: 'health' | 'verdict';
  /** Does the handler read a JSON request body? */
  readonly body: boolean;
  readonly description: string;
}

export const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/health',
    handler: 'health',
    body: false,
    description:
      'Liveness, plus whether an agenda read is available and the cache stats. `agenda` is a boolean about configuration and never the key itself; the extension’s options page renders it as "an LLM read is available".',
  },
  {
    method: 'POST',
    path: '/api/verdict',
    handler: 'verdict',
    body: true,
    description:
      'Score one account. `{platform, username, deep?}`. Answers the deterministic verdict always; `deep` adds the Claude agenda read. An agenda failure is folded into the verdict as `agenda.llmError` rather than failing the request, because the deterministic half is unaffected by it.',
  },
] as const;
