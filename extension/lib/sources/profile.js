/**
 * AccountProfile — the normalized, PLATFORM-NEUTRAL account shape.
 *
 * This is the seam between "where the data came from" and "what we think of
 * it". Everything downstream of here (extension/lib/scoring/) sees only this
 * shape, and that is load-bearing rather than tidy: TikTok and X are the
 * stated next targets, so the scoring core must never learn what a subreddit
 * is. Hence `group` rather than `subreddit`, `threadId` rather than `link_id`,
 * `replyCount` rather than `num_comments`. Adding a Reddit-flavoured field
 * here is how the scorers quietly become Reddit-only.
 *
 * Two rules the rest of the package depends on:
 *
 *   1. NULL, NEVER ZERO, for anything the source did not give us. A missing
 *      karma total and a karma total of 0 are different facts, and the
 *      scorers treat them differently — a signal it could not measure is
 *      reported as unmeasured, not as a clean result. Inventing zeros here
 *      turns "we don't know" into "it's fine" three modules away.
 *
 *   2. COVERAGE IS DATA, NOT A FOOTNOTE. If an account has 4,000 comments and
 *      300 came back, `truncated` is true and every consumer can say so. Same
 *      discipline as this repo's chess project, which names what it couldn't
 *      cover rather than quietly reporting on a smaller sample.
 *
 * All timestamps are unix SECONDS (the source's own unit), never milliseconds.
 */

/** Platforms this shape has been exercised against. */
export const PLATFORMS = Object.freeze({ REDDIT: 'reddit' });

const SECONDS_PER_DAY = 86400;

/**
 * @typedef {object} NormalizedComment
 * @property {string|null} id
 * @property {number|null} createdUtc   unix seconds
 * @property {string|null} group        neutral name for the community/space
 * @property {string|null} body
 * @property {number|null} score        null when the source hides it
 * @property {string|null} threadId     stable id of the conversation
 * @property {string|null} parentId     what this replies to
 * @property {boolean|null} isTopLevel  replies to the submission itself
 *
 * @typedef {object} NormalizedPost
 * @property {string|null} id
 * @property {number|null} createdUtc
 * @property {string|null} group
 * @property {string|null} title
 * @property {number|null} score
 * @property {number|null} replyCount
 */

/**
 * Build the `coverage` block. Callers pass what they actually observed;
 * `truncated` is derived here so no caller can forget it.
 */
export function buildCoverage({
  commentsFetched = 0,
  commentsTotal = null,
  postsFetched = 0,
  postsTotal = null,
  oldestFetchedUtc = null,
  sources = [],
  errors = [],
  hitRequestCeiling = false,
} = {}) {
  // Truncation is a lower bound on purpose. `commentsTotal` comes from a
  // periodically-refreshed stats blob upstream, so it can LAG the live history
  // (verified 2026-08-05: an account whose newest comment was that day carried
  // totals last recomputed 16 months earlier). We therefore report truncation
  // when we can prove it, and never report "complete" as a positive claim.
  const truncated = Boolean(
    hitRequestCeiling
      || (Number.isFinite(commentsTotal) && commentsFetched < commentsTotal)
      || (Number.isFinite(postsTotal) && postsFetched < postsTotal),
  );

  return Object.freeze({
    commentsFetched,
    commentsTotal: numOrNull(commentsTotal),
    postsFetched,
    postsTotal: numOrNull(postsTotal),
    truncated,
    oldestFetchedUtc: numOrNull(oldestFetchedUtc),
    sources: Object.freeze([...sources]),
    errors: Object.freeze([...errors]),
  });
}

/**
 * Assemble an AccountProfile. Every key is always present so consumers can
 * destructure without guards; unknown values are null.
 */
export function buildProfile({
  platform,
  username,
  id = null,
  fetchedAt,
  firstSeenUtc = null,
  karma = {},
  counts = {},
  comments = [],
  posts = [],
  coverage,
}) {
  const first = numOrNull(firstSeenUtc);
  const accountAgeDays = first != null && Number.isFinite(fetchedAt)
    ? Math.max(0, (fetchedAt - first) / SECONDS_PER_DAY)
    : null;

  return Object.freeze({
    platform,
    username,
    id: id ?? null,
    fetchedAt,
    accountAgeDays,
    firstSeenUtc: first,
    karma: Object.freeze({
      post: numOrNull(karma.post),
      comment: numOrNull(karma.comment),
      total: numOrNull(karma.total),
    }),
    counts: Object.freeze({
      comments: numOrNull(counts.comments),
      posts: numOrNull(counts.posts),
    }),
    comments: Object.freeze([...comments]),
    posts: Object.freeze([...posts]),
    coverage: coverage ?? buildCoverage(),
  });
}

// ---------------------------------------------------------------------------
// Neutral derived views. These live here rather than in the scorers so that
// "what counts as an activity" is defined once, next to the shape itself.
// ---------------------------------------------------------------------------

/** Comments with a usable timestamp, oldest first. */
export function commentsOldestFirst(profile) {
  return profile.comments
    .filter((c) => Number.isFinite(c.createdUtc))
    .sort((a, b) => a.createdUtc - b.createdUtc);
}

/**
 * Comments and posts merged into one timeline, oldest first. Used by anything
 * asking "when is this account awake" or "was it ever dormant", both of which
 * are about the account, not about one kind of contribution.
 */
export function activityOldestFirst(profile) {
  const items = [];
  for (const c of profile.comments) {
    if (Number.isFinite(c.createdUtc)) {
      items.push({ kind: 'comment', createdUtc: c.createdUtc, group: c.group });
    }
  }
  for (const p of profile.posts) {
    if (Number.isFinite(p.createdUtc)) {
      items.push({ kind: 'post', createdUtc: p.createdUtc, group: p.group });
    }
  }
  return items.sort((a, b) => a.createdUtc - b.createdUtc);
}

/** Map of group -> count over anything carrying a `group`. */
export function groupHistogram(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item.group) continue;
    counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  }
  return counts;
}

/**
 * The timestamp below which the merged timeline stops being trustworthy, or
 * null if the whole history is reliable.
 *
 * Comments and posts are fetched as SEPARATE newest-first windows with
 * different depths, so merging them can invent silence that never happened.
 * The case that proved it (live, 2026-08-05): an account with 1.59M comments
 * returned its newest 299 — about an hour of activity — plus one submission
 * from 2014. Merged naively that reads as a twelve-year dormancy followed by a
 * revival, which is the single strongest agenda signal firing on nothing but
 * the shape of our own pagination.
 *
 * So anything older than the oldest item of any TRUNCATED stream is dropped:
 * below that point we hold partial data and cannot tell absence from
 * not-having-asked. Deliberately conservative — a real gap in a complete
 * stream can be discarded because the other stream was truncated — because
 * inventing a gap is far worse than missing one.
 */
export function reliableTimelineStart(profile) {
  const { coverage } = profile;
  if (!coverage?.truncated) return null;

  const commentsTruncated = Number.isFinite(coverage.commentsTotal)
    ? coverage.commentsFetched < coverage.commentsTotal
    : true;
  const postsTruncated = Number.isFinite(coverage.postsTotal)
    ? coverage.postsFetched < coverage.postsTotal
    : true;

  const oldestComment = oldestOf(profile.comments);
  const oldestPost = oldestOf(profile.posts);

  const bounds = [];
  if (commentsTruncated && oldestComment != null) bounds.push(oldestComment);
  if (postsTruncated && oldestPost != null) bounds.push(oldestPost);

  // Truncated for a reason we cannot attribute to a stream (e.g. the request
  // ceiling): assume both are short rather than trusting either.
  if (!bounds.length) {
    if (oldestComment != null) bounds.push(oldestComment);
    if (oldestPost != null) bounds.push(oldestPost);
  }

  return bounds.length ? Math.max(...bounds) : null;
}

/**
 * The merged timeline, trimmed to the window where the retrieved history is
 * complete. Any signal that reasons about WHEN the account is active — its
 * hours, its silences — must use this rather than the raw timeline, or it ends
 * up measuring our pagination instead of the account.
 */
export function reliableActivityOldestFirst(profile) {
  const start = reliableTimelineStart(profile);
  const all = activityOldestFirst(profile);
  return start == null ? all : all.filter((item) => item.createdUtc >= start);
}

function oldestOf(items) {
  const stamps = items.map((i) => i.createdUtc).filter((t) => Number.isFinite(t));
  return stamps.length ? Math.min(...stamps) : null;
}

/** Days between the oldest and newest thing we actually fetched, or null. */
export function observedSpanDays(profile) {
  const timeline = activityOldestFirst(profile);
  if (timeline.length < 2) return null;
  return (timeline[timeline.length - 1].createdUtc - timeline[0].createdUtc) / SECONDS_PER_DAY;
}

function numOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
