// THE SERVER'S VIEW of the two shapes it borrows from the extension.
//
// The scoring core (extension/lib/) is untyped ESM, loaded at run time by
// deterministic.ts, and this server deliberately has no second opinion about
// what it produces: `AccountProfile` and `Verdict` describe only the fields the
// server itself reads to build an evidence pack and attach an agenda block.
// Everything else passes through as `unknown` and is re-serialised untouched.
//
// So these are NOT the core's schema, and must not grow into a duplicate of it.
// A field belongs here when server code reads it; when the panel reads it, it
// belongs to the core and nothing here should know it exists.

/** One comment, as the profile builder emits it. */
export interface ProfileComment {
  readonly id?: string;
  readonly body?: string;
  /** The subreddit. Named `group` because the seam is meant to outlive Reddit. */
  readonly group?: string;
  readonly createdUtc?: number;
  readonly permalink?: string;
  readonly score?: number;
  readonly isTopLevel?: boolean;
  readonly threadId?: string;
}

/**
 * How much of the account the fetch actually saw. `truncated` is the reason
 * this is in the pack at all: a sample presented as a whole history is how a
 * shape signal comes to fire on the shape of our own pagination.
 */
export interface Coverage {
  readonly commentsFetched?: number;
  readonly commentsTotal?: number;
  readonly truncated?: boolean;
}

/** One post. The pack reads only which group it was in. */
export interface ProfilePost {
  readonly group?: string;
}

/** What `fetchAccount()` returns, as far as the server is concerned. */
export interface AccountProfile {
  readonly platform?: string;
  readonly username?: string;
  readonly comments?: readonly ProfileComment[];
  readonly posts?: readonly ProfilePost[];
  readonly accountAgeDays?: number | null;
  readonly firstSeenUtc?: number | null;
  readonly karma?: Record<string, number> | null;
  readonly counts?: Record<string, number> | null;
  readonly coverage?: Coverage | null;
}

/** One numbered piece of evidence the model may cite. */
export interface PackEntry {
  readonly id: string;
  readonly comment: ProfileComment;
  readonly text: string;
}

/** The evidence pack: what is sent, and what a citation is checked against. */
export interface EvidencePack {
  readonly platform: string;
  readonly username: string | undefined;
  readonly entries: readonly PackEntry[];
  /** The citation index. A cite that does not resolve in here is dropped. */
  readonly byId: Map<string, PackEntry>;
  readonly groups: readonly { readonly group: string; readonly count: number }[];
  readonly account: {
    readonly accountAgeDays: number | null;
    readonly firstSeenUtc: number | null;
    readonly karma: Record<string, number> | null;
    readonly counts: Record<string, number> | null;
    readonly postGroups: readonly string[];
  };
  readonly coverage: Coverage | null;
  readonly selected: number;
  readonly available: number;
}

/**
 * A verdict, as far as the server touches it: it attaches an `agenda.llm` block
 * and otherwise passes the object straight through.
 */
export interface Verdict {
  agenda?: Record<string, unknown>;
  [key: string]: unknown;
}
