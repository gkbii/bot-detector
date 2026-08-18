/**
 * arctic-shift — the data source. THE ONLY MODULE THAT KNOWS THESE URLs, and
 * the only module in the package that knows the word "subreddit". Everything
 * else consumes the platform-neutral AccountProfile from ./profile.js.
 *
 * ## Why not Reddit's own API
 *
 * We do not use it because it does not work for us, not because we didn't try.
 * Verified live 2026-08-05: `https://www.reddit.com/user/<name>/about.json`
 * returns 403 from a server REGARDLESS OF User-Agent — a browser UA gets a 403
 * text/html challenge page, not JSON. Do not "fix" this by spoofing headers;
 * it has been tried and the block is not UA-based. OAuth would mean every user
 * of a load-unpacked extension registering their own app, which contradicts
 * the zero-setup requirement outright.
 *
 * ## The source we do use
 *
 * `https://arctic-shift.photon-reddit.com` — unauthenticated, no key, no
 * signup, permissive CORS (`access-control-allow-origin: *`, so the extension
 * can call it directly). It is LIVE, not archival: verified 2026-08-05 that
 * the newest comment returned for an active account was stamped the same day.
 *
 *   GET /api/users/search?author=<name>
 *       -> { data: [ { _meta: { earliest_comment_at, earliest_post_at,
 *                              last_comment_at, last_post_at, num_comments,
 *                              num_posts, post_karma, comment_karma,
 *                              total_karma }, author, id } ] }
 *   GET /api/comments/search?author=<name>&limit=N&sort=desc[&before=T]
 *       -> { data: [ <full Reddit-shaped comment objects> ] }
 *   GET /api/posts/search?author=<name>&limit=N&sort=desc[&before=T]
 *       -> { data: [ <full Reddit-shaped submission objects> ] }
 *
 * ### Four behaviours confirmed against the live API, not assumed
 *
 *  1. `limit` MAXES OUT AT 100, not 300. `limit=1000` returns HTTP 400 with
 *     `{"error":"'limit' must be between 1 and 100"}`. A 300-comment lookup is
 *     therefore three paged requests, which is why this module paginates at
 *     all. Raising DEFAULT_COMMENT_LIMIT raises the request count linearly.
 *
 *  2. PAGINATION IS `before=<unix seconds>` WITH `sort=desc`, and `before` is
 *     EXCLUSIVE (`<`, not `<=`). Verified: page 1 ended at 1761856696, and
 *     `before=1761856696` returned items strictly older with zero overlap.
 *     We nonetheless page with `before = oldest + 1` and dedupe by id, because
 *     an exclusive cursor on a non-unique key silently DROPS any sibling
 *     sharing that exact second. Overlap is cheap; a hole is invisible.
 *
 *  3. THROTTLING LOOKS LIKE A CLIENT ERROR. Two parallel requests produced
 *     HTTP 422 with `{"data":null,"error":"Timeout. Maybe slow down a bit"}`.
 *     A 422 normally means "your request is malformed, retrying is pointless",
 *     so treating it that way would turn ordinary rate-limiting into a hard
 *     failure. We retry it. Responses carry `x-ratelimit-reset` (seconds,
 *     ~20s window) and that is what we back off on. Eight rapid sequential
 *     calls all returned 200 — permissive, but real.
 *
 *  4. AN UNKNOWN ACCOUNT IS `{"data":[]}` WITH HTTP 200, not a 404. So
 *     "no such account" is an empty array — but see the next section: an empty
 *     array from `/api/users/search` alone does NOT mean the account does not
 *     exist.
 *
 * ### `/api/users/search` IS A FROZEN SNAPSHOT, NOT A LAGGING ONE
 *
 * This is the difference between a delay and a cutoff, and it decides the
 * whole shape of `fetchAccount`. Measured over the 236 authors of one live
 * thread (EVALUATION.md, Finding 1): every one of the 201 indexed accounts
 * carried the SAME `comment_stats_updated_at` of 2025-03-25, the newest
 * `earliest_comment_at` among them was 2025-03-14, and 0 of 196 had a
 * `last_comment_at` within a week. It is not refreshed; it was taken once.
 *
 * So an account whose first comment postdates that snapshot does not exist to
 * this endpoint, however active it is right now — 35 of those 236 authors
 * (14.8%) returned empty from it while `/api/comments/search` served their
 * comments normally. A re-probe on 2026-08-16 put it at 20.0%, and THE GROWTH
 * IS THE PROOF: lag shrinks, a cutoff widens every day. The blind spot is
 * therefore exactly the population most worth checking, because a brand-new
 * account is the shape astroturf takes.
 *
 * Hence the fallback below: a users-index miss is not an answer about the
 * account, so we ask the streams before believing it.
 *
 * ### Documented fallback, deliberately not implemented
 *
 * `https://api.pullpush.io` (`/reddit/search/comment/?author=<name>`,
 * `/reddit/search/submission/?author=<name>`) was also verified returning 200
 * on 2026-08-05 and covers the same ground with a similar Reddit-shaped
 * payload. It is recorded here as the escape hatch if arctic-shift goes away.
 * It is NOT wired up: a second live source that nothing exercises is a second
 * source that has silently broken by the time you need it. Add it when it is
 * needed, with its own tests, and add its name to `coverage.sources`.
 */

import { PLATFORMS, buildCoverage, buildProfile } from './profile.js';

const BASE_URL = 'https://arctic-shift.photon-reddit.com';
export const SOURCE_NAME = 'arctic-shift';

/** Hard ceiling from the API itself — see note 1 above. */
const PAGE_SIZE = 100;

const DEFAULT_COMMENT_LIMIT = 300;
const DEFAULT_POST_LIMIT = 100;

/**
 * Hard per-lookup request ceiling. This is a safety property, not a tuning
 * knob: one badge render must never be able to become a scraping loop, whether
 * through a pagination bug, a cursor that stops advancing, or an account with
 * a pathological history. Retries count against it too, so a source that is
 * failing cannot spin either. 300 comments + 100 posts + 1 identity call = 5
 * requests, so this leaves headroom for a few retries and nothing more.
 */
export const MAX_REQUESTS_PER_LOOKUP = 12;

const MAX_RETRIES_PER_REQUEST = 2;
const MAX_BACKOFF_SECONDS = 30;
const DEFAULT_BACKOFF_SECONDS = 2;

/** Reddit usernames: 3-20 of [A-Za-z0-9_-]. Anything else cannot be an account. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * What the user is told when the profile came from the streams alone. It is a
 * `coverage.errors` entry because that is the one channel every consumer
 * already renders (the badge lists them verbatim), and because the rule here
 * is that a bound which fires says so out loud. It names the cause rather than
 * the symptom: "not in the index" is a fact about our source, not about them.
 */
const USERS_INDEX_MISS = 'users-index: no entry for this account — the index is a frozen '
  + '2025-03-25 snapshot, so accounts created since are absent from it however active they are. '
  + 'Scored from its comment and post streams alone: no karma, no lifetime totals, and the age '
  + 'is a floor rather than a total.';

/**
 * Fetch and normalize one account.
 *
 * @param {string} username           bare name, or `u/name`, or `/u/name`
 * @param {object} [opts]
 * @param {number} [opts.commentLimit=300]
 * @param {number} [opts.postLimit=100]
 * @param {Function} [opts.fetchImpl=fetch]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.now]         unix seconds; injected so callers and
 *                                    tests control the clock
 * @param {Function} [opts.sleep]     ms => Promise, injected so backoff is
 *                                    testable without actually waiting
 * @returns {Promise<import('./profile.js').AccountProfile|null>} null only when
 *          the users index AND both streams come back empty — a users-index
 *          miss on its own is the frozen-snapshot cutoff, not an absent
 *          account, and yields a stream-derived profile instead
 */
export async function fetchAccount(username, opts = {}) {
  const {
    commentLimit = DEFAULT_COMMENT_LIMIT,
    postLimit = DEFAULT_POST_LIMIT,
    // .bind(globalThis) is load-bearing, not defensive style. This default is
    // later called as `ctx.fetchImpl(...)`, which hands fetch a receiver that
    // is not the global scope. Node does not care, so every test here passes
    // either way -- but in an MV3 service worker fetch is a native WebIDL
    // method that requires its own global as the receiver, and an unbound
    // reference throws "Failed to execute 'fetch' on 'WorkerGlobalScope':
    // Illegal invocation" on every single lookup. Caught by running the real
    // unpacked extension in Chrome; it cannot be caught by a test in Node,
    // because the injected stub is a plain function with no receiver rules.
    fetchImpl = globalThis.fetch.bind(globalThis),
    signal,
    now = Math.floor(Date.now() / 1000),
    sleep = defaultSleep,
  } = opts;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchAccount: no fetch implementation available');
  }

  const name = normalizeUsername(username);
  // Not a well-formed name => not an account. Same answer as "no such
  // account", because to the caller it is the same fact.
  if (!name) return null;

  const ctx = {
    fetchImpl,
    signal,
    sleep,
    budget: { spent: 0, ceiling: MAX_REQUESTS_PER_LOOKUP, exhausted: false },
  };

  // --- identity + lifetime stats -----------------------------------------
  // This gives us karma, account age and the totals we measure truncation
  // against. A REQUEST failure here still throws — we cannot tell a broken
  // endpoint from an absent account, and guessing would turn an outage into a
  // stream of confidently thin profiles. An EMPTY RESULT is different: it is
  // the frozen-snapshot cutoff documented in the header, so we carry on
  // without the blob rather than reporting the account as nonexistent.
  const users = await requestData(ctx, '/api/users/search', { author: name });
  const meta = Array.isArray(users) && users.length ? users[0] : null;

  const stats = meta?._meta ?? {};
  const errors = [];
  if (!meta) errors.push(USERS_INDEX_MISS);

  // --- history ------------------------------------------------------------
  // These two ARE optional. A profile with karma and age but no comment bodies
  // is degraded, not useless, and the scorers already report per-signal what
  // they could not measure. So a failure is recorded in coverage.errors and
  // the lookup continues — that is the same "name what you couldn't" rule the
  // truncation flag exists for.
  const rawComments = await collect(ctx, 'comments', name, commentLimit, errors);
  const rawPosts = await collect(ctx, 'posts', name, postLimit, errors);

  const comments = rawComments.map(normalizeComment);
  const posts = rawPosts.map(normalizePost);

  // The account is absent only when NOTHING knows about it. An index miss with
  // a served stream is the snapshot cutoff; an index miss with both streams
  // empty is a deleted, suspended or mistyped name, and stays null.
  if (!meta && comments.length === 0 && posts.length === 0) return null;

  const oldestFetchedUtc = minTimestamp([
    ...comments.map((c) => c.createdUtc),
    ...posts.map((p) => p.createdUtc),
  ]);

  const coverage = buildCoverage({
    commentsFetched: comments.length,
    commentsTotal: pickNumber(stats.num_comments),
    postsFetched: posts.length,
    postsTotal: pickNumber(stats.num_posts),
    // A stream that came back holding exactly as many items as we asked for
    // stopped because OUR limit ran out, not because the account did. With no
    // totals to compare against that is the only proof of truncation
    // available, and it has to be reported: without it a stream-derived
    // profile claims a complete history, and `reliableTimelineStart()` then
    // trusts a 40-minute comment window merged with a years-old post — the
    // forged-dormancy failure it exists to prevent.
    filledCommentLimit: filledLimit(rawComments.length, commentLimit),
    filledPostLimit: filledLimit(rawPosts.length, postLimit),
    oldestFetchedUtc,
    sources: [SOURCE_NAME],
    errors,
    hitRequestCeiling: ctx.budget.exhausted,
  });

  return buildProfile({
    platform: PLATFORMS.REDDIT,
    username: meta?.author ?? name,
    id: meta?.id ?? null,
    fetchedAt: now,
    // Without the blob the oldest item we retrieved is the earliest activity
    // we can see. It is a FLOOR on the account's age, not the age: if the
    // stream filled our limit there is older history we never asked for, and
    // `coverage.truncated` says so. Understating age is the safe direction —
    // it can only send the verdict towards `insufficient-data`, never towards
    // a clean score (see the README section on this fallback).
    firstSeenUtc: meta
      ? minTimestamp([
        pickNumber(stats.earliest_comment_at),
        pickNumber(stats.earliest_post_at),
      ])
      : oldestFetchedUtc,
    karma: {
      post: pickNumber(stats.post_karma),
      comment: pickNumber(stats.comment_karma),
      total: pickNumber(stats.total_karma),
    },
    counts: {
      comments: pickNumber(stats.num_comments),
      posts: pickNumber(stats.num_posts),
    },
    comments,
    posts,
    coverage,
  });
}

// ---------------------------------------------------------------------------
// Normalization — the Reddit vocabulary stops here.
// ---------------------------------------------------------------------------

export function normalizeComment(raw) {
  const parentId = str(raw.parent_id);
  return {
    id: str(raw.id),
    createdUtc: pickNumber(raw.created_utc),
    group: str(raw.subreddit),
    body: str(raw.body),
    // `score_hidden` means the number on screen is not the real one. Null is
    // the honest answer; a hidden score recorded as 1 would read to the
    // dissent signal as "nobody engaged" rather than "we cannot tell".
    score: raw.score_hidden === true ? null : pickNumber(raw.score),
    threadId: str(raw.link_id),
    parentId,
    // Reddit encodes "replies to the submission" as a t3_ parent. Resolving it
    // HERE is what keeps that prefix out of the scorers entirely.
    isTopLevel: parentId == null ? null : parentId.startsWith('t3_'),
  };
}

export function normalizePost(raw) {
  return {
    id: str(raw.id),
    createdUtc: pickNumber(raw.created_utc),
    group: str(raw.subreddit),
    title: str(raw.title),
    score: raw.hide_score === true ? null : pickNumber(raw.score),
    replyCount: pickNumber(raw.num_comments),
  };
}

export function normalizeUsername(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^\/?(?:u|user)\//i, '');
  return USERNAME_PATTERN.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

async function collect(ctx, kind, author, limit, errors) {
  const wanted = Math.max(0, Math.floor(limit ?? 0));
  if (wanted === 0) return [];

  const path = kind === 'comments' ? '/api/comments/search' : '/api/posts/search';
  const out = [];
  const seen = new Set();
  let before = null;

  while (out.length < wanted) {
    const pageSize = Math.min(PAGE_SIZE, wanted - out.length);
    let rows;
    try {
      rows = await requestData(ctx, path, {
        author,
        limit: pageSize,
        sort: 'desc',
        ...(before == null ? {} : { before }),
      });
    } catch (err) {
      // Partial history beats no history. Record and stop this stream.
      errors.push(`${kind}: ${err.message}`);
      break;
    }

    if (!Array.isArray(rows) || rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      const id = str(row.id);
      const key = id ?? `${row.created_utc}:${out.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      added += 1;
    }

    // Stall guard. `before = oldest + 1` re-includes the boundary second, so
    // if an entire page shares one timestamp the cursor cannot advance and we
    // would page forever. Zero NEW rows means we are done, whatever the API
    // keeps handing back. (The request ceiling is the outer net; this is the
    // one that stops us wasting it.)
    if (added === 0) break;

    const oldest = minTimestamp(rows.map((r) => pickNumber(r.created_utc)));
    if (oldest == null) break;
    before = oldest + 1;

    // Short page => the source is out of history.
    if (rows.length < pageSize) break;
  }

  return out.slice(0, wanted);
}

// ---------------------------------------------------------------------------
// Transport: budget, retry, backoff
// ---------------------------------------------------------------------------

async function requestData(ctx, path, params) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_REQUEST; attempt += 1) {
    if (!spendRequest(ctx)) {
      throw new Error(
        `request ceiling of ${ctx.budget.ceiling} reached for this lookup`,
      );
    }

    let res;
    try {
      res = await ctx.fetchImpl(url.toString(), {
        method: 'GET',
        signal: ctx.signal,
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      lastError = err;
      await backoff(ctx, null, attempt);
      continue;
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.ok && body && !body.error) return body.data;

    const message = (body && body.error) || `HTTP ${res.status}`;

    if (!isRetryable(res.status, message)) {
      throw new Error(`${path} failed: ${message}`);
    }

    lastError = new Error(`${path} failed: ${message}`);
    await backoff(ctx, res, attempt);
  }

  throw lastError ?? new Error(`${path} failed`);
}

/**
 * 400 is a genuine "your request is wrong" (e.g. limit > 100) and retrying it
 * just burns the budget. 422 is the awkward one: the API uses it for
 * "Timeout. Maybe slow down a bit", which IS retryable — see note 3 in the
 * header. We key off the message so a real validation 422 still fails fast.
 */
function isRetryable(status, message) {
  if (status === 429 || status >= 500) return true;
  if (status === 422) return /timeout|slow down|rate/i.test(message);
  return false;
}

async function backoff(ctx, res, attempt) {
  let seconds = DEFAULT_BACKOFF_SECONDS * (attempt + 1);

  const reset = res && Number(res.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) seconds = reset;

  await ctx.sleep(Math.min(seconds, MAX_BACKOFF_SECONDS) * 1000);
}

function spendRequest(ctx) {
  if (ctx.budget.spent >= ctx.budget.ceiling) {
    ctx.budget.exhausted = true;
    return false;
  }
  ctx.budget.spent += 1;
  return true;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

// ---------------------------------------------------------------------------

function pickNumber(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Did this stream stop because our own limit ran out? `collect()` can only
 * reach `wanted` items by filling up, so equality is the test. An account
 * holding exactly `wanted` items reads as filled too — a false positive that
 * costs a "truncated" flag we cannot disprove, which is the direction to err
 * in: over-reporting truncation discards data, under-reporting it invents
 * silence that was never there.
 */
function filledLimit(fetched, limit) {
  const wanted = Math.max(0, Math.floor(limit ?? 0));
  return wanted > 0 && fetched >= wanted;
}

function str(value) {
  return typeof value === 'string' && value.length ? value : null;
}

function minTimestamp(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? Math.min(...nums) : null;
}
