// The evidence pack: the numbered set of comments the Claude read is allowed
// to talk about, built by plain deterministic code.
//
// THE AGGREGATION HAPPENS FIRST, IN CODE. Nothing in this file touches the
// network or the model, which means the whole pack is testable for free and a
// dry run can print exactly what would be sent. It is also what makes citation
// verification possible at all: the model can only cite ids that this file
// minted, so `agenda.js` can resolve every claim against the pack it actually
// sent rather than trusting the response.
//
// WHY A SPREAD, NOT THE MOST RECENT N. The question being asked is whether an
// account's output shows a *sustained* pattern. Handing the model the newest 60
// comments answers a different question -- what has this account been doing
// this week -- and systematically overweights whatever the account is arguing
// about right now. So selection round-robins across the account's groups
// (subreddits) and, within each group, walks a recursive-midpoint ordering so
// that any prefix already covers the group's whole time range. An account that
// posts in twelve places gets twelve places represented; an account that posts
// in one gets that one, spread over its history.
//
// THE CAP IS A PRIVACY BUDGET AS WELL AS A TOKEN BUDGET. Every comment in the
// pack is a piece of a real stranger's public posting shipped to a third party.
// `BOT_AGENDA_MAX_COMMENTS` bounds both, and bodies are truncated rather than
// sent whole.

import config from './config.js';

const TRUNCATION_MARKER = ' …[truncated]';

/**
 * Index ordering whose every prefix is spread across [0, n): repeated
 * midpoints, breadth-first. Deterministic, so two runs over the same profile
 * produce the same pack (and therefore the same cache-worthy result).
 */
export function spreadOrder(n) {
  const out = [];
  if (!Number.isFinite(n) || n <= 0) return out;
  const seen = new Array(n).fill(false);
  const queue = [[0, n - 1]];
  while (queue.length > 0) {
    const [lo, hi] = queue.shift();
    if (lo > hi) continue;
    const mid = Math.floor((lo + hi) / 2);
    if (!seen[mid]) {
      seen[mid] = true;
      out.push(mid);
    }
    queue.push([lo, mid - 1]);
    queue.push([mid + 1, hi]);
  }
  return out;
}

function byTimeAsc(a, b) {
  const at = Number(a.createdUtc) || 0;
  const bt = Number(b.createdUtc) || 0;
  if (at !== bt) return at - bt;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function usableComments(profile) {
  const comments = Array.isArray(profile?.comments) ? profile.comments : [];
  return comments.filter(
    (c) => c && typeof c.body === 'string' && c.body.trim().length > 0
  );
}

/**
 * Picks up to `max` comments spread across the account's groups and its
 * timeline. Exported separately from buildPack() so the selection rule can be
 * tested without constructing a whole profile.
 */
export function selectComments(comments, max) {
  const sorted = [...comments].sort(byTimeAsc);
  if (sorted.length <= max) return sorted;

  const buckets = new Map();
  for (const comment of sorted) {
    const key = comment.group || '(unknown)';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(comment);
  }

  // Largest group first so a dominant subreddit is never crowded out by a
  // long tail of one-offs; name as the tie-break keeps this deterministic.
  const ordered = [...buckets.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  const cursors = ordered.map(([, items]) => ({ items, order: spreadOrder(items.length), at: 0 }));

  const picked = [];
  let progressed = true;
  while (picked.length < max && progressed) {
    progressed = false;
    for (const cursor of cursors) {
      if (picked.length >= max) break;
      if (cursor.at >= cursor.order.length) continue;
      picked.push(cursor.items[cursor.order[cursor.at]]);
      cursor.at += 1;
      progressed = true;
    }
  }

  return picked.sort(byTimeAsc);
}

function truncate(body, maxChars) {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

function isoDay(createdUtc) {
  const seconds = Number(createdUtc);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown-date';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Builds the pack for one AccountProfile.
 *
 * @param {object} profile - an AccountProfile (see the extension's contract).
 * @param {object} [opts]
 * @param {number} [opts.maxComments]
 * @param {number} [opts.maxCommentChars]
 * @returns {{
 *   platform: string, username: string,
 *   entries: Array<{ id: string, comment: object, text: string }>,
 *   byId: Map<string, { id: string, comment: object, text: string }>,
 *   groups: Array<{ group: string, count: number }>,
 *   account: object,
 *   coverage: object|null,
 *   selected: number, available: number
 * }}
 */
export function buildPack(profile, {
  maxComments = config.agendaMaxComments,
  maxCommentChars = config.agendaMaxCommentChars,
} = {}) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('buildPack(): no profile');
  }

  const available = usableComments(profile);
  const selected = selectComments(available, maxComments);

  const entries = selected.map((comment, i) => ({
    id: `C${i + 1}`,
    comment,
    text: truncate(comment.body, maxCommentChars),
  }));

  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const groupCounts = new Map();
  for (const comment of available) {
    const key = comment.group || '(unknown)';
    groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
  }
  const groups = [...groupCounts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));

  return {
    platform: profile.platform || 'reddit',
    username: profile.username,
    entries,
    byId,
    groups,
    account: {
      accountAgeDays: profile.accountAgeDays ?? null,
      firstSeenUtc: profile.firstSeenUtc ?? null,
      karma: profile.karma ?? null,
      counts: profile.counts ?? null,
      postGroups: Array.isArray(profile.posts)
        ? [...new Set(profile.posts.map((p) => p?.group).filter(Boolean))]
        : [],
    },
    coverage: profile.coverage ?? null,
    selected: entries.length,
    available: available.length,
  };
}

/**
 * Renders a pack as the plain text the model reads. Kept separate from
 * buildPack() so a `--dry-run` (or a test) can print exactly what would be
 * sent without an API key in the environment.
 */
export function renderPack(pack) {
  const lines = [];
  lines.push(`Account: ${pack.username} (${pack.platform})`);
  if (pack.account.accountAgeDays != null) {
    lines.push(`Account age: ${pack.account.accountAgeDays} days`);
  }
  if (pack.account.karma) {
    const k = pack.account.karma;
    lines.push(`Karma: ${k.total ?? '?'} total (${k.post ?? '?'} post, ${k.comment ?? '?'} comment)`);
  }
  if (pack.account.counts) {
    const c = pack.account.counts;
    lines.push(`Known activity: ${c.comments ?? '?'} comments, ${c.posts ?? '?'} posts`);
  }
  if (pack.coverage) {
    const cov = pack.coverage;
    lines.push(
      `Coverage: fetched ${cov.commentsFetched ?? '?'} of ${cov.commentsTotal ?? '?'} comments` +
        (cov.truncated ? ' (truncated -- this is a sample, not the whole history)' : '')
    );
  }
  lines.push(
    `Sample: ${pack.selected} of ${pack.available} available comments, spread across groups and time.`
  );

  if (pack.groups.length > 0) {
    lines.push('');
    lines.push('Groups the account comments in (all known activity, not just the sample):');
    for (const { group, count } of pack.groups.slice(0, 25)) {
      lines.push(`  ${group}: ${count}`);
    }
    if (pack.groups.length > 25) {
      lines.push(`  ...and ${pack.groups.length - 25} more`);
    }
  }

  lines.push('');
  lines.push('Comments. Cite these by id exactly as written.');
  for (const entry of pack.entries) {
    const c = entry.comment;
    const meta = [
      isoDay(c.createdUtc),
      c.group || '(unknown group)',
      `score ${c.score ?? '?'}`,
      c.isTopLevel ? 'top-level' : 'reply',
    ].join(' | ');
    lines.push('');
    lines.push(`${entry.id} [${meta}]`);
    lines.push(entry.text);
  }

  return lines.join('\n');
}

export { TRUNCATION_MARKER };
