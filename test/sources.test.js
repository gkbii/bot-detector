import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REQUESTS_PER_LOOKUP, fetchAccount, normalizeUsername,
} from '../extension/lib/sources/arcticShift.js';
import { reliableTimelineStart } from '../extension/lib/sources/profile.js';
import { scoreAccount } from '../extension/lib/scoring/index.js';
import { BAND } from '../extension/lib/scoring/axis.js';

/**
 * No network in tests. The fixtures below are REAL arctic-shift payloads
 * recorded live on 2026-08-05 (author `spez`), trimmed to the fields the
 * normalizer reads plus a few it must ignore. Recording them rather than
 * inventing them is the point: a hand-written fixture only ever proves the
 * normalizer agrees with whoever wrote the fixture.
 */

const USER_PAYLOAD = {
  data: [{
    _meta: {
      earliest_comment_at: 1134392748,
      earliest_post_at: 1119552314,
      last_comment_at: 1729645028,
      last_post_at: 1751475161,
      num_comments: 2568,
      num_posts: 549,
      comment_stats_updated_at: 1742860804,
      post_stats_updated_at: 1756166402,
      post_karma: 832984,
      comment_karma: 666948,
      total_karma: 1499932,
    },
    author: 'spez',
    id: '1w72',
  }],
};

const COMMENT_REPLY = {
  id: 'p1vy2h1',
  created_utc: 1785948140,
  subreddit: 'u_spez',
  body: 'I am once again coming to you to ask you to spend more time in this app.',
  score: 2,
  link_id: 't3_1vgbkge',
  parent_id: 't1_p1vuqcb',
  author: 'spez',
  score_hidden: false,
  distinguished: 'admin',
  permalink: '/user/spez/comments/1vgbkge/x/p1vy2h1/',
};

const COMMENT_TOP_LEVEL = {
  id: 'ojb40kw',
  created_utc: 1777638722,
  subreddit: 'redditstock',
  body: 'That was Rich Greenfield from LightShed. He is great. He was just giving us a friendly hard time.',
  score: 20,
  link_id: 't3_1t0jood',
  parent_id: 't3_1t0jood',
  author: 'spez',
  score_hidden: false,
};

const POST_HIDDEN_SCORE = {
  id: '1vgbkge',
  created_utc: 1785945836,
  subreddit: 'u_spez',
  title: 'Modernizing Reddit’s infrastructure with you',
  score: 1,
  num_comments: 0,
  author: 'spez',
  hide_score: true,
};

const POST_VISIBLE = {
  id: '1u7hraf',
  created_utc: 1781625867,
  subreddit: 'u_spez',
  title: '21 years of Reddit',
  score: 606,
  num_comments: 201,
  author: 'spez',
  hide_score: false,
};

const NOW = 1785950000;

// ---------------------------------------------------------------------------
// A scripted fetch. Each route is a queue of responses; calls are recorded so
// tests can assert on pagination cursors and the request ceiling.
// ---------------------------------------------------------------------------

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function scriptedFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) });
    const queue = routes[parsed.pathname];
    if (!queue) return jsonResponse({ data: [] });
    const next = typeof queue === 'function' ? queue(parsed, calls) : (queue.length > 1 ? queue.shift() : queue[0]);
    return next;
  };
  impl.calls = calls;
  return impl;
}

const noSleep = async () => {};

function baseOpts(fetchImpl, extra = {}) {
  return {
    fetchImpl, now: NOW, sleep: noSleep, commentLimit: 100, postLimit: 100, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test('normalizes a real recorded arctic-shift payload into an AccountProfile', async () => {
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': [jsonResponse({ data: [COMMENT_REPLY, COMMENT_TOP_LEVEL] })],
    '/api/posts/search': [jsonResponse({ data: [POST_HIDDEN_SCORE, POST_VISIBLE] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl));

  assert.equal(profile.platform, 'reddit');
  assert.equal(profile.username, 'spez');
  assert.equal(profile.id, '1w72');
  assert.equal(profile.fetchedAt, NOW);

  // firstSeenUtc is the earlier of the two "earliest" stamps (the post one).
  assert.equal(profile.firstSeenUtc, 1119552314);
  assert.ok(Math.abs(profile.accountAgeDays - (NOW - 1119552314) / 86400) < 1e-6);

  assert.deepEqual(profile.karma, { post: 832984, comment: 666948, total: 1499932 });
  assert.deepEqual(profile.counts, { comments: 2568, posts: 549 });

  // The Reddit vocabulary must not survive normalization.
  const [reply, topLevel] = profile.comments;
  assert.equal(reply.group, 'u_spez');
  assert.equal(reply.threadId, 't3_1vgbkge');
  assert.equal(reply.isTopLevel, false, 't1_ parent means it replies to another commenter');
  assert.equal(topLevel.group, 'redditstock');
  assert.equal(topLevel.isTopLevel, true, 't3_ parent means it replies to the submission');
  assert.equal(reply.score, 2);
  assert.ok(!('subreddit' in reply), 'the neutral shape must not carry a subreddit field');
  assert.ok(!('num_comments' in profile.posts[0]));

  assert.equal(profile.posts[1].replyCount, 201);
  assert.equal(profile.posts[1].title, '21 years of Reddit');
  assert.equal(profile.posts[1].group, 'u_spez');
});

test('a hidden score normalizes to null, never to a number', async () => {
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': [jsonResponse({ data: [{ ...COMMENT_REPLY, score_hidden: true }] })],
    '/api/posts/search': [jsonResponse({ data: [POST_HIDDEN_SCORE, POST_VISIBLE] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl));

  assert.equal(profile.comments[0].score, null, 'hidden comment score must be null, not 2');
  assert.equal(profile.posts[0].score, null, 'hide_score post must be null, not 1');
  assert.equal(profile.posts[1].score, 606);
});

test('missing source fields become null rather than zero', async () => {
  const bare = { data: [{ author: 'ghost', id: 'x1', _meta: {} }] };
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(bare)],
    '/api/comments/search': [jsonResponse({ data: [] })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('ghost', baseOpts(fetchImpl));

  assert.deepEqual(profile.karma, { post: null, comment: null, total: null });
  assert.deepEqual(profile.counts, { comments: null, posts: null });
  assert.equal(profile.firstSeenUtc, null);
  assert.equal(profile.accountAgeDays, null);
  assert.equal(profile.coverage.oldestFetchedUtc, null);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test('coverage reports truncation when the account has more history than we fetched', async () => {
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': [jsonResponse({ data: [COMMENT_REPLY, COMMENT_TOP_LEVEL] })],
    '/api/posts/search': [jsonResponse({ data: [POST_VISIBLE] })],
  });

  const { coverage } = await fetchAccount('spez', baseOpts(fetchImpl));

  assert.equal(coverage.commentsFetched, 2);
  assert.equal(coverage.commentsTotal, 2568);
  assert.equal(coverage.postsFetched, 1);
  assert.equal(coverage.postsTotal, 549);
  assert.equal(coverage.truncated, true, '2 of 2568 comments is truncated and must say so');
  assert.equal(coverage.oldestFetchedUtc, 1777638722);
  assert.deepEqual([...coverage.sources], ['arctic-shift']);
  assert.deepEqual([...coverage.errors], []);
});

test('coverage does not claim truncation when the whole history came back', async () => {
  const complete = {
    data: [{ ...USER_PAYLOAD.data[0], _meta: { ...USER_PAYLOAD.data[0]._meta, num_comments: 2, num_posts: 1 } }],
  };
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(complete)],
    '/api/comments/search': [jsonResponse({ data: [COMMENT_REPLY, COMMENT_TOP_LEVEL] })],
    '/api/posts/search': [jsonResponse({ data: [POST_VISIBLE] })],
  });

  const { coverage } = await fetchAccount('spez', baseOpts(fetchImpl));
  assert.equal(coverage.truncated, false);
});

// ---------------------------------------------------------------------------
// Absence
// ---------------------------------------------------------------------------

test('an unknown account is null, not a throw (the API answers 200 with an empty array)', async () => {
  // Absence now has to be agreed by all three endpoints, not asserted by the
  // users index alone — see the pair of tests below. The empty streams here
  // are what makes this account genuinely unknown.
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse({ data: [] })],
    '/api/comments/search': [jsonResponse({ data: [] })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  assert.equal(await fetchAccount('zzz_no_such_user_qqq', baseOpts(fetchImpl)), null);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.path).sort(),
    ['/api/comments/search', '/api/posts/search', '/api/users/search'],
    'the streams must be asked before an account is called absent',
  );
});

// ---------------------------------------------------------------------------
// The users index misses an account it has never heard of — EVALUATION.md
// Finding 1. `/api/users/search` is a frozen 2025-03-25 snapshot, so 14.8% of
// one live thread's authors (20.0% on a 2026-08-16 re-probe) returned empty
// from it while their comments served normally. Before this fix every one of
// them got the grey "no data" badge, whose text blames deletion, suspension or
// a typo. All 110 tests of the day passed straight through it.
// ---------------------------------------------------------------------------

/** A stream of comments ending `at`, one every `stepSeconds`, newest first. */
function commentStream(count, { endAt = 1785948140, stepSeconds = 3600, prefix = 'sd' } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    ...COMMENT_REPLY,
    id: `${prefix}${i}`,
    created_utc: endAt - i * stepSeconds,
    subreddit: `sub${i % 12}`,
    body: `an ordinary sentence about number ${i} with several plain words in it`,
  }));
}

function missingFromIndex(routes) {
  return scriptedFetch({ '/api/users/search': [jsonResponse({ data: [] })], ...routes });
}

test('an account missing from the users index is built from its streams, not reported absent', async () => {
  const fetchImpl = missingFromIndex({
    '/api/comments/search': [jsonResponse({ data: commentStream(40) })],
    '/api/posts/search': [jsonResponse({ data: [POST_VISIBLE] })],
  });

  const profile = await fetchAccount('newAccount', baseOpts(fetchImpl));

  assert.ok(profile, 'an index miss with a served stream is not an absent account');
  assert.equal(profile.username, 'newAccount', 'the requested name stands in for the index one');
  assert.equal(profile.id, null);
  assert.equal(profile.comments.length, 40);
  assert.equal(profile.posts.length, 1);

  // Rule 1 of profile.js: null, never zero, for anything the source did not
  // give us. A karma of 0 here would read three modules away as "fine".
  assert.deepEqual(profile.karma, { post: null, comment: null, total: null });
  assert.deepEqual(profile.counts, { comments: null, posts: null });

  // Age comes from the oldest thing we actually retrieved.
  assert.equal(profile.firstSeenUtc, Math.min(1785948140 - 39 * 3600, POST_VISIBLE.created_utc));
  assert.ok(Number.isFinite(profile.accountAgeDays));

  // The fallback names itself. The badge renders coverage.errors verbatim, so
  // this is what the reader is told instead of nothing.
  assert.equal(profile.coverage.errors.length, 1);
  assert.match(profile.coverage.errors[0], /^users-index: /);
  assert.match(profile.coverage.errors[0], /floor/);
  assert.deepEqual([...profile.coverage.sources], ['arctic-shift']);
});

test('a stream-derived profile that exhausted both streams is not called truncated', async () => {
  const fetchImpl = missingFromIndex({
    '/api/comments/search': [jsonResponse({ data: commentStream(40) })],
    '/api/posts/search': [jsonResponse({ data: [POST_VISIBLE] })],
  });

  const { coverage } = await fetchAccount('newAccount', baseOpts(fetchImpl));

  assert.equal(coverage.commentsTotal, null, 'there is no total without the index blob');
  assert.equal(coverage.truncated, false, '40 of a requested 100 means the account ran out, not us');
});

test('a stream-derived profile that filled our own limit reports truncation', async () => {
  // Without this the fallback would claim a complete history purely because
  // the totals blob is missing, and reliableTimelineStart() would then trust a
  // 100-comment window merged with a years-old post — the forged-dormancy
  // failure of EVALUATION.md Finding 3, re-entered through the new door.
  const fetchImpl = missingFromIndex({
    '/api/comments/search': [jsonResponse({ data: commentStream(100, { stepSeconds: 60 }) })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('prolific', baseOpts(fetchImpl));

  assert.equal(profile.comments.length, 100);
  assert.equal(profile.coverage.truncated, true,
    'a stream that filled the limit we set is proof there is more we did not ask for');
  assert.equal(reliableTimelineStart(profile), profile.coverage.oldestFetchedUtc,
    'and the reliable window stops where our own window does');
});

test('an index miss with an empty comment stream but a served post stream still scores', async () => {
  const fetchImpl = missingFromIndex({
    '/api/comments/search': [jsonResponse({ data: [] })],
    '/api/posts/search': [jsonResponse({ data: [POST_VISIBLE, POST_HIDDEN_SCORE] })],
  });

  const profile = await fetchAccount('posterOnly', baseOpts(fetchImpl));

  assert.ok(profile, 'posts alone are still evidence the account exists');
  assert.equal(profile.comments.length, 0);
  assert.equal(profile.posts.length, 2);
});

test('a users-endpoint FAILURE still throws — only an empty result falls back', async () => {
  // An outage and an absent account are different facts. Falling back on a
  // 500 would turn a broken endpoint into a stream of confidently thin
  // profiles that all look like young accounts.
  const fetchImpl = scriptedFetch({
    '/api/users/search': () => jsonResponse({ data: null, error: 'boom' }, { status: 500 }),
    '/api/comments/search': [jsonResponse({ data: commentStream(40) })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  await assert.rejects(() => fetchAccount('newAccount', baseOpts(fetchImpl)), /boom/);
});

test('the stream-derived profile scores, with karma-velocity reporting what it lost', async () => {
  // The seam working as designed: one signal (weight 1 of 12.5) says what it
  // could not measure instead of the whole lookup vanishing.
  const fetchImpl = missingFromIndex({
    '/api/comments/search': [jsonResponse({
      data: commentStream(40, { stepSeconds: 6 * 3600 }), // 40 comments over 10 days
    })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('newAccount', baseOpts(fetchImpl, { now: 1785948140 + 5 * 86400 }));
  const verdict = scoreAccount(profile);
  const karmaVelocity = verdict.automation.signals.find((s) => s.key === 'karma-velocity');

  assert.equal(karmaVelocity.band, BAND.INSUFFICIENT);
  assert.match(karmaVelocity.evidence, /No karma total or account age available/);
  assert.notEqual(verdict.automation.band, BAND.INSUFFICIENT,
    'losing the weakest signal must not lose the axis');
});

test('a prolific account seen only through a short window is insufficient-data, not a verdict', async () => {
  // The deliberate decision behind the stream-derived age. `firstSeenUtc` is
  // the oldest item we retrieved, so for an OLD account whose window filled up
  // it understates the age and MIN_HISTORY_DAYS gates the whole verdict.
  // That is the answer we want: what we hold is 100 comments spanning 100
  // minutes, and scoring that would be a verdict on our own pagination. The
  // gate says so in words rather than issuing a clean band.
  const fetchImpl = missingFromIndex({
    '/api/comments/search': [jsonResponse({ data: commentStream(100, { stepSeconds: 60 }) })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const verdict = scoreAccount(await fetchAccount('prolific', baseOpts(fetchImpl)));

  for (const axis of ['automation', 'agenda', 'authenticity']) {
    assert.equal(verdict[axis].band, BAND.INSUFFICIENT, `${axis} must not report a band`);
  }
  assert.match(verdict.headline, /Not enough history/);
});

test('a malformed username is null without spending a request', async () => {
  const fetchImpl = scriptedFetch({ '/api/users/search': [jsonResponse(USER_PAYLOAD)] });
  assert.equal(await fetchAccount('not a username!', baseOpts(fetchImpl)), null);
  assert.equal(await fetchAccount('', baseOpts(fetchImpl)), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('accepts u/name and /u/name forms', () => {
  assert.equal(normalizeUsername('u/spez'), 'spez');
  assert.equal(normalizeUsername('/u/spez'), 'spez');
  assert.equal(normalizeUsername('  spez  '), 'spez');
  assert.equal(normalizeUsername('user/spez'), 'spez');
  assert.equal(normalizeUsername('has space'), null);
});

// ---------------------------------------------------------------------------
// Pagination — the API caps `limit` at 100, verified live
// ---------------------------------------------------------------------------

test('pages a 300-comment request into three requests using the before cursor', async () => {
  const page = (start) => Array.from({ length: 100 }, (_, i) => ({
    ...COMMENT_REPLY, id: `c${start - i}`, created_utc: start - i * 60,
  }));

  let served = 0;
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': () => {
      const start = 1785948140 - served * 6000;
      served += 1;
      return jsonResponse({ data: page(start) });
    },
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl, { commentLimit: 300, postLimit: 0 }));

  const commentCalls = fetchImpl.calls.filter((c) => c.path === '/api/comments/search');
  assert.equal(commentCalls.length, 3, '300 comments at a 100 cap is exactly three requests');
  assert.equal(commentCalls[0].params.limit, '100');
  assert.equal(commentCalls[0].params.sort, 'desc');
  assert.equal(commentCalls[0].params.before, undefined, 'first page carries no cursor');

  // The cursor is oldest+1, not oldest, so an item sharing the boundary second
  // cannot be skipped by an exclusive `before`.
  const firstPageOldest = 1785948140 - 99 * 60;
  assert.equal(commentCalls[1].params.before, String(firstPageOldest + 1));

  assert.equal(profile.comments.length, 300);
  assert.equal(new Set(profile.comments.map((c) => c.id)).size, 300, 'no duplicates across pages');

  assert.equal(fetchImpl.calls.filter((c) => c.path === '/api/posts/search').length, 0,
    'a zero limit fetches nothing');
});

test('deduplicates the boundary second re-served by the overlapping cursor', async () => {
  const pageOne = Array.from({ length: 100 }, (_, i) => ({
    ...COMMENT_REPLY, id: `a${i}`, created_utc: 1785948140 - i * 60,
  }));
  const boundary = pageOne[pageOne.length - 1];
  const pageTwo = [boundary, ...Array.from({ length: 20 }, (_, i) => ({
    ...COMMENT_REPLY, id: `b${i}`, created_utc: boundary.created_utc - (i + 1) * 60,
  }))];

  const pages = [jsonResponse({ data: pageOne }), jsonResponse({ data: pageTwo })];
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': () => pages.shift() ?? jsonResponse({ data: [] }),
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl, { commentLimit: 300, postLimit: 0 }));

  assert.equal(profile.comments.length, 120, 'the repeated boundary item is counted once');
  assert.equal(new Set(profile.comments.map((c) => c.id)).size, 120);
});

test('stops instead of looping when a whole page shares one timestamp', async () => {
  // The cursor is oldest+1, so a page whose items all share a second cannot
  // advance it. Without the stall guard this pages forever until the ceiling.
  const stuck = Array.from({ length: 100 }, (_, i) => ({
    ...COMMENT_REPLY, id: `s${i}`, created_utc: 1700000000,
  }));
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': () => jsonResponse({ data: stuck }),
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl, { commentLimit: 1000, postLimit: 0 }));

  const calls = fetchImpl.calls.filter((c) => c.path === '/api/comments/search').length;
  assert.equal(calls, 2, 'one page, then one that adds nothing new, then stop');
  assert.equal(profile.comments.length, 100);
});

// ---------------------------------------------------------------------------
// Retry, backoff and the request ceiling
// ---------------------------------------------------------------------------

test('retries the 422 the API uses for throttling, and backs off on x-ratelimit-reset', async () => {
  // Verified live: two parallel calls returned HTTP 422 with
  // {"data":null,"error":"Timeout. Maybe slow down a bit"}. Treating 422 as a
  // permanent client error would turn ordinary rate-limiting into a failure.
  const slept = [];
  const responses = [
    jsonResponse({ data: null, error: 'Timeout. Maybe slow down a bit' },
      { status: 422, headers: { 'x-ratelimit-reset': '7' } }),
    jsonResponse(USER_PAYLOAD),
  ];
  const fetchImpl = scriptedFetch({
    '/api/users/search': () => responses.shift(),
    '/api/comments/search': [jsonResponse({ data: [COMMENT_REPLY] })],
    '/api/posts/search': [jsonResponse({ data: [] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl, {
    sleep: async (ms) => { slept.push(ms); },
  }));

  assert.ok(profile, 'the throttled lookup still succeeds');
  assert.deepEqual(slept, [7000], 'backoff honours x-ratelimit-reset, in seconds');
});

test('a genuine validation 422 is not retried', async () => {
  const fetchImpl = scriptedFetch({
    '/api/users/search': () => jsonResponse(
      { data: null, error: "'limit' must be between 1 and 100" }, { status: 422 },
    ),
  });
  await assert.rejects(
    () => fetchAccount('spez', baseOpts(fetchImpl)),
    /limit/,
  );
  assert.equal(fetchImpl.calls.length, 1, 'no retries burned on an unfixable request');
});

test('a failed history stream is recorded in coverage.errors, not thrown away', async () => {
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': () => jsonResponse({ data: null, error: 'bad request' }, { status: 400 }),
    '/api/posts/search': [jsonResponse({ data: [POST_VISIBLE] })],
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl));

  assert.ok(profile, 'karma and age are still worth having without comment bodies');
  assert.equal(profile.comments.length, 0);
  assert.equal(profile.posts.length, 1);
  assert.equal(profile.coverage.errors.length, 1);
  assert.match(profile.coverage.errors[0], /^comments: /);
  assert.equal(profile.coverage.truncated, true);
});

test('one lookup can never exceed the hard request ceiling', async () => {
  // A source stuck in a retryable failure must not become a scraping loop.
  const fetchImpl = scriptedFetch({
    '/api/users/search': [jsonResponse(USER_PAYLOAD)],
    '/api/comments/search': () => jsonResponse({ data: null, error: 'Timeout. Maybe slow down a bit' },
      { status: 422 }),
    '/api/posts/search': () => jsonResponse({ data: null, error: 'Timeout. Maybe slow down a bit' },
      { status: 422 }),
  });

  const profile = await fetchAccount('spez', baseOpts(fetchImpl, { commentLimit: 300, postLimit: 300 }));

  assert.ok(fetchImpl.calls.length <= MAX_REQUESTS_PER_LOOKUP,
    `spent ${fetchImpl.calls.length} requests, ceiling is ${MAX_REQUESTS_PER_LOOKUP}`);
  assert.equal(profile.coverage.truncated, true, 'hitting the ceiling is itself truncation');
  assert.ok(profile.coverage.errors.length > 0, 'and it is reported');
});
