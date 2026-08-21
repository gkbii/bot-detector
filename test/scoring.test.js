import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoverage, buildProfile } from '../extension/lib/sources/profile.js';
import { scoreAccount } from '../extension/lib/scoring/index.js';
import {
  BAND, MIN_COMMENTS_FOR_SCORING, MIN_HISTORY_DAYS,
} from '../extension/lib/scoring/axis.js';

const NOW = 1785950000; // 2026-08-05
const DAY = 86400;

// ---------------------------------------------------------------------------
// Deterministic builders. Every profile below is hand-built: the scoring core
// is pure, so a scenario is just data and no network or clock is involved.
// ---------------------------------------------------------------------------

/** mulberry32 — seeded so a failing test fails the same way twice. */
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ('the a of and to in that it is was for on with as at by from but not they we you this have'
  + ' about which their would there could been more when who will one all some other into over after before'
  + ' because while though against between under above through during without within toward each many few')
  .split(' ');

/** Genuinely varied prose, so nothing trips the duplicate or template signals. */
function randomText(rand, minWords = 25, maxWords = 90) {
  const n = minWords + Math.floor(rand() * (maxWords - minWords));
  const words = [];
  for (let i = 0; i < n; i += 1) words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
  return `${words.join(' ')}.`;
}

function comment({
  id, at, group = 'g0', body = 'a comment with several ordinary words in it',
  score = 3, thread = null, isTopLevel = false,
}) {
  const threadId = thread ?? `t3_${id}`;
  return {
    id,
    createdUtc: at,
    group,
    body,
    score,
    threadId,
    parentId: isTopLevel ? threadId : `t1_p_${id}`,
    isTopLevel,
  };
}

function post({ id, at, group = 'g0', title = 'a post', score = 5, replyCount = 0 }) {
  return { id, createdUtc: at, group, title, score, replyCount };
}

function profileOf({
  comments = [], posts = [], firstSeenUtc = NOW - 900 * DAY,
  karma = { post: 400, comment: 2600, total: 3000 },
  counts = null, truncated = false, username = 'subject',
}) {
  return buildProfile({
    platform: 'reddit',
    username,
    id: 'abc',
    fetchedAt: NOW,
    firstSeenUtc,
    karma,
    counts: counts ?? { comments: comments.length, posts: posts.length },
    comments,
    posts,
    coverage: buildCoverage({
      commentsFetched: comments.length,
      commentsTotal: truncated ? comments.length * 10 : comments.length,
      postsFetched: posts.length,
      postsTotal: posts.length,
      oldestFetchedUtc: comments.length ? Math.min(...comments.map((c) => c.createdUtc)) : null,
      sources: ['arctic-shift'],
    }),
  });
}

/**
 * A lumpy human timeline: only some days are active, and an active day holds a
 * handful of comments spaced minutes apart, strictly inside a waking window.
 *
 * `activeHours` must be contiguous (it may wrap midnight). Comments are placed
 * by walking an offset through the window, so they never leak into the hours
 * the person is meant to be asleep — that leak is what a dead-zone test would
 * otherwise measure instead of the scorer.
 */
function humanTimestamps({ rand, days, activeHours, activeDayChance = 0.45, perDay = 5, endDaysAgo = 1 }) {
  const windowSeconds = activeHours.length * 3600;
  const stamps = [];

  for (let d = days; d >= endDaysAgo; d -= 1) {
    if (rand() > activeDayChance) continue;
    const midnight = Math.floor((NOW - d * DAY) / DAY) * DAY;
    const n = 1 + Math.floor(rand() * perDay);

    // Offsets scattered across the WHOLE waking window, then thinned so no two
    // land within 5 minutes of each other — conversational, never burst-fast.
    const offsets = Array.from({ length: n }, () => Math.floor(rand() * windowSeconds))
      .sort((a, b) => a - b);
    let last = -Infinity;
    for (const offset of offsets) {
      if (offset - last < 300) continue;
      last = offset;
      const hour = activeHours[Math.floor(offset / 3600)];
      // A window that wraps midnight lands its later hours on the next day.
      const dayShift = hour < activeHours[0] ? DAY : 0;
      stamps.push(midnight + dayShift + hour * 3600 + (offset % 3600));
    }
  }
  return stamps.sort((a, b) => a - b);
}

const WAKING_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const NIGHT_SHIFT_HOURS = [22, 23, 0, 1, 2, 3, 4, 5];

function findSignal(axis, key) {
  const found = axis.signals.find((s) => s.key === key);
  assert.ok(found, `expected a "${key}" signal, got ${axis.signals.map((s) => s.key).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Round-the-clock, evenly spaced, templated, never replies. */
function botProfile() {
  const comments = [];
  for (let i = 0; i < 400; i += 1) {
    const at = NOW - (400 - i) * 3600 + (i % 7) * 8; // hourly, tiny jitter
    comments.push(comment({
      id: `bot${i}`,
      at,
      group: `g${i % 6}`,
      body: `Great point! I completely agree with this take and think more people should see it. Reference ${i}.`,
      score: 1,
      isTopLevel: true,
    }));
  }
  return profileOf({ comments, karma: { post: 5000, comment: 45000, total: 50000 }, firstSeenUtc: NOW - 300 * DAY });
}

/** A person who is awake 22:00-06:00 UTC. Unusual hours, entirely human shape. */
function nightShiftProfile() {
  const rand = rng(7);
  const stamps = humanTimestamps({ rand, days: 260, activeHours: NIGHT_SHIFT_HOURS });
  const comments = stamps.map((at, i) => comment({
    id: `ns${i}`,
    at,
    group: `g${Math.floor(rand() * 12)}`,
    body: randomText(rand),
    score: 1 + Math.floor(rand() * 30),
    thread: `t3_th${Math.floor(i / 2)}`,
    isTopLevel: rand() < 0.4,
  }));
  return profileOf({ comments, karma: { post: 900, comment: 8000, total: 8900 } });
}

/**
 * The case the whole project exists to find: a real human, on human hours,
 * writing varied prose, pushing one line. Every automation signal reads clean
 * because no machine is involved.
 */
function propagandistProfile() {
  const rand = rng(11);
  const talkingPoint = 'the mainstream media refuses to report the real numbers';

  // An old era, a long silence, then a busy present.
  const oldEra = humanTimestamps({ rand, days: 980, activeHours: WAKING_HOURS, activeDayChance: 0.25, perDay: 2, endDaysAgo: 950 });
  const nowEra = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS, activeDayChance: 0.5, perDay: 3, endDaysAgo: 2 });

  const comments = [...oldEra, ...nowEra].map((at, i) => {
    const body = rand() < 0.45
      ? `${randomText(rand, 20, 40)} ${talkingPoint}. ${randomText(rand, 20, 40)}`
      : randomText(rand, 30, 80);
    return comment({
      id: `pg${i}`,
      at,
      group: rand() < 0.9 ? 'mainpush' : `side${Math.floor(rand() * 2)}`,
      body,
      score: 2 + Math.floor(rand() * 40), // never downvoted on home turf
      thread: `t3_p${i}`, // one and done, every time
      isTopLevel: true,
    });
  });

  const posts = [
    post({ id: 'pp1', at: NOW - 40 * DAY, group: 'mainpush', replyCount: 31 }),
    post({ id: 'pp2', at: NOW - 90 * DAY, group: 'mainpush', replyCount: 12 }),
  ];

  return profileOf({ comments, posts, karma: { post: 1200, comment: 5400, total: 6600 }, firstSeenUtc: NOW - 1000 * DAY });
}

/**
 * Varied, and all SHORTER than the 6-word n-gram the agenda axis looks for, so
 * a person's ordinary conversational habits cannot register as stock phrasing.
 * A fixture that repeated one distinctive six-word question in eighty threads
 * would be building a talking point and then testing that we found it.
 */
const CORRECTIONS = [
  'Edit: I was wrong.',
  'You are right.',
  'Good catch.',
  'I stand corrected.',
  'Fair enough.',
  'My mistake.',
];
const QUESTIONS = [
  'Does anyone know?',
  'Can someone explain?',
  'Any advice?',
  'Am i missing something?',
  'Genuine question.',
  'Not sure why.',
];
/** Varied too — two fixed suffixes colliding would forge a phrase nobody wrote. */
const FILLERS = ['is that right?', 'right?', 'or no?', 'surely?', 'yes?'];

/** A real person the tool should be able to vouch for. */
function genuineProfile() {
  const rand = rng(23);
  const stamps = humanTimestamps({ rand, days: 400, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => {
    // Picked from the rng, never from `i`: index arithmetic aliases (every
    // multiple of 75 draws the same pair) and quietly forges a stock phrase.
    const pick = (pool) => pool[Math.floor(rand() * pool.length)];
    let body = randomText(rand);
    if (i % 25 === 0) body = `${body} ${pick(CORRECTIONS)}`;
    if (i % 4 === 0) body = `${body} ${pick(QUESTIONS)}`;
    else if (i % 3 === 0) body = `${body} ${pick(FILLERS)}`;
    // A dominant-ish home group, where the account is occasionally downvoted.
    const home = rand() < 0.4;
    return comment({
      id: `gn${i}`,
      at,
      group: home ? 'home' : `g${Math.floor(rand() * 14)}`,
      body,
      score: home && i % 17 === 0 ? -6 : 1 + Math.floor(rand() * 40),
      thread: `t3_t${Math.floor(i / 3)}`, // real back-and-forth
      isTopLevel: i % 3 === 0,
    });
  });
  return profileOf({ comments, karma: { post: 3000, comment: 12000, total: 15000 } });
}

// ---------------------------------------------------------------------------
// The insufficient-data gate
// ---------------------------------------------------------------------------

test('thin comment history is insufficient-data on every axis, never a low score', () => {
  const rand = rng(3);
  const comments = Array.from({ length: MIN_COMMENTS_FOR_SCORING - 1 }, (_, i) => comment({
    id: `t${i}`, at: NOW - (100 - i) * DAY, body: randomText(rand),
  }));

  const verdict = scoreAccount(profileOf({ comments }));

  for (const axis of ['automation', 'agenda', 'authenticity']) {
    assert.equal(verdict[axis].band, BAND.INSUFFICIENT, `${axis} must not report a band`);
    assert.equal(verdict[axis].score, null, `${axis} must not report a score`);
  }
  assert.match(verdict.headline, /Not enough history/);
  assert.match(verdict.automation.signals[0].evidence, /not a clean result, it is no result/);
});

test('a brand-new account is insufficient-data even with plenty of comments', () => {
  const rand = rng(5);
  const comments = Array.from({ length: 120 }, (_, i) => comment({
    id: `n${i}`, at: NOW - (MIN_HISTORY_DAYS - 2) * DAY + i * 600, body: randomText(rand),
  }));

  const verdict = scoreAccount(profileOf({ comments, firstSeenUtc: NOW - (MIN_HISTORY_DAYS - 2) * DAY }));

  assert.equal(verdict.automation.band, BAND.INSUFFICIENT);
  assert.equal(verdict.agenda.band, BAND.INSUFFICIENT);
  assert.equal(verdict.authenticity.band, BAND.INSUFFICIENT);
});

test('one comment past the threshold, the gate opens', () => {
  const rand = rng(9);
  const stamps = humanTimestamps({ rand, days: 200, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({ id: `o${i}`, at, body: randomText(rand) }));
  assert.ok(comments.length >= MIN_COMMENTS_FOR_SCORING);

  const verdict = scoreAccount(profileOf({ comments }));
  assert.notEqual(verdict.automation.band, BAND.INSUFFICIENT);
});

// ---------------------------------------------------------------------------
// Automation signals, one at a time
// ---------------------------------------------------------------------------

test('automation: no dead zone is the strongest signal; an unusual dead zone is not', () => {
  const bot = scoreAccount(botProfile()).automation;
  const night = scoreAccount(nightShiftProfile()).automation;

  const botHours = findSignal(bot, 'posting-hour-dead-zone');
  const nightHours = findSignal(night, 'posting-hour-dead-zone');

  assert.equal(botHours.band, BAND.HIGH);
  assert.equal(botHours.direction, 'raises');
  assert.equal(botHours.value.deadZoneHours, 0);
  assert.match(botHours.evidence, /no quiet stretch/);

  assert.equal(nightHours.band, BAND.LOW);
  assert.equal(nightHours.direction, 'lowers');
  assert.ok(nightHours.value.deadZoneHours >= 6, 'a night-shift human still has a sleep gap');
  assert.match(nightHours.evidence, /sleep cycle/);
});

test('automation: the dead zone is measured circularly, so a wrapping sleep window counts once', () => {
  // 22:00-06:00 wraps midnight. A linear scan would see two short gaps and
  // conclude the account never sleeps.
  const night = scoreAccount(nightShiftProfile()).automation;
  const hours = findSignal(night, 'posting-hour-dead-zone');
  assert.equal(hours.value.deadZoneHours, 24 - NIGHT_SHIFT_HOURS.length);
});

test('automation: near-duplicate bodies fire while varied prose does not', () => {
  const bot = findSignal(scoreAccount(botProfile()).automation, 'near-duplicate-bodies');
  assert.equal(bot.band, BAND.HIGH);
  assert.equal(bot.direction, 'raises');
  assert.ok(bot.value.maxSimilarity > 0.55);

  const human = findSignal(scoreAccount(genuineProfile()).automation, 'near-duplicate-bodies');
  assert.equal(human.band, BAND.LOW);
  assert.equal(human.value.duplicated, 0);
});

test('automation: bursts need different threads, so a fast argument does not count', () => {
  const rand = rng(31);
  const base = NOW - 60 * DAY;

  // Ten comments 20 seconds apart, all in ONE thread: someone arguing.
  const argument = Array.from({ length: 10 }, (_, i) => comment({
    id: `arg${i}`, at: base + i * 20, thread: 't3_same', body: randomText(rand),
  }));
  // Ten comments 20 seconds apart across TEN threads: a queue draining.
  const drain = Array.from({ length: 10 }, (_, i) => comment({
    id: `drn${i}`, at: base + i * 20, thread: `t3_x${i}`, body: randomText(rand),
  }));
  const filler = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS })
    .map((at, i) => comment({ id: `f${i}`, at, body: randomText(rand), thread: `t3_f${i}` }));

  const argumentSignal = findSignal(
    scoreAccount(profileOf({ comments: [...filler, ...argument] })).automation, 'cross-thread-bursts',
  );
  const drainSignal = findSignal(
    scoreAccount(profileOf({ comments: [...filler, ...drain] })).automation, 'cross-thread-bursts',
  );

  assert.equal(argumentSignal.value.burstComments, 0, 'one heated thread is not a burst');
  assert.ok(drainSignal.value.burstComments >= 10, 'ten threads in ten seconds is');
  assert.match(drainSignal.evidence, /different threads within/);
});

test('automation: an account that never replies to replies is flagged for it', () => {
  const bot = findSignal(scoreAccount(botProfile()).automation, 'conversation-depth');
  assert.equal(bot.value.replies, 0);
  assert.equal(bot.band, BAND.HIGH);
  assert.match(bot.evidence, /never replied to another commenter/);

  const human = findSignal(scoreAccount(genuineProfile()).automation, 'conversation-depth');
  assert.equal(human.band, BAND.LOW);
});

test('automation: karma velocity is the weakest signal and its evidence admits it', () => {
  const sig = findSignal(scoreAccount(genuineProfile()).automation, 'karma-velocity');
  assert.equal(sig.weight, 1);
  const heaviest = Math.max(...scoreAccount(genuineProfile()).automation.signals.map((s) => s.weight));
  assert.ok(sig.weight < heaviest, 'karma velocity must never be the heaviest signal');
  assert.match(sig.evidence, /weak evidence on its own/);
});

// ---------------------------------------------------------------------------
// Agenda signals, one at a time
// ---------------------------------------------------------------------------

test('agenda: topic concentration fires on a single-group account, not a broad one', () => {
  const pushed = findSignal(scoreAccount(propagandistProfile()).agenda, 'topic-concentration');
  assert.equal(pushed.band, BAND.HIGH);
  assert.ok(pushed.value.topShare > 0.8);
  assert.match(pushed.evidence, /sits in one group/);
  assert.doesNotMatch(pushed.evidence, /subreddit/i, 'the scorers must never say subreddit');

  const broad = findSignal(scoreAccount(genuineProfile()).agenda, 'topic-concentration');
  assert.equal(broad.band, BAND.LOW);
});

test('agenda: stock phrasing needs the phrase to cross threads', () => {
  const pushed = findSignal(scoreAccount(propagandistProfile()).agenda, 'stock-phrasing');
  assert.equal(pushed.band, BAND.HIGH);
  assert.match(pushed.value.top.phrase, /mainstream media refuses to report/);
  assert.ok(pushed.value.top.threads >= 2);

  const clean = findSignal(scoreAccount(genuineProfile()).agenda, 'stock-phrasing');
  assert.equal(clean.value.phraseCount, 0,
    `a person writing varied prose has no talking point, got ${JSON.stringify(clean.value.top)}`);
  assert.equal(clean.band, BAND.LOW);
});

test('agenda: a repeated run of pure function words is a tic, not a talking point', () => {
  // "does anyone know how do i" recurring across dozens of threads is what a
  // fluent speaker sounds like. Convicting someone of a writing style is a
  // false positive the agenda axis cannot afford.
  const rand = rng(37);
  const stamps = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({
    id: `tic${i}`,
    at,
    group: `g${i % 9}`,
    body: `${randomText(rand)} but is that what you are saying about it`,
    thread: `t3_tic${i}`,
  }));

  const sig = findSignal(scoreAccount(profileOf({ comments })).agenda, 'stock-phrasing');
  assert.equal(sig.value.phraseCount, 0,
    `a function-word tic repeated in every comment must not register, got ${JSON.stringify(sig.value.top)}`);
  assert.equal(sig.band, BAND.LOW);
});

test('agenda: dormancy revival finds the largest gap and says account age would miss it', () => {
  const sig = findSignal(scoreAccount(propagandistProfile()).agenda, 'dormancy-revival');
  assert.ok(sig.value.largestGapDays > 400, `expected a long silence, got ${sig.value.largestGapDays}`);
  assert.ok(['moderate', 'high'].includes(sig.band), `expected a firing band, got ${sig.band}`);
  assert.match(sig.evidence, /Account age alone would not show this/);

  const steady = findSignal(scoreAccount(genuineProfile()).agenda, 'dormancy-revival');
  assert.equal(steady.band, BAND.LOW);
  assert.match(steady.evidence, /below the 120-day dormancy threshold/);
});

test('agenda: truncated history cannot manufacture a dormancy gap', () => {
  // We page newest-first, so the stretch between the account's first activity
  // and the oldest thing we fetched is history we never asked for — not
  // silence. Counting it would flag every prolific account.
  // 400 days, not 120: the window has to be longer than MIN_DORMANCY_GAP_DAYS
  // or the span gate answers first and this stops testing the truncation rule
  // at all (JIO-290). What is under test here is that the 7 unfetched years
  // are not counted, so the fetched window must be one a gap could fit in.
  const rand = rng(41);
  const stamps = humanTimestamps({ rand, days: 400, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({ id: `tr${i}`, at, body: randomText(rand) }));

  const verdict = scoreAccount(profileOf({
    comments,
    firstSeenUtc: NOW - 3000 * DAY, // account is 8 years old
    truncated: true, // but we only fetched the last 400 days
  }));

  const sig = findSignal(verdict.agenda, 'dormancy-revival');
  assert.equal(sig.band, BAND.LOW, 'the unfetched years are not a dormancy gap');
  assert.ok(sig.value.largestGapDays < 120);
  assert.match(sig.evidence, /any earlier dormancy is invisible/);
});

test('agenda: a shallow comment window plus one ancient post is not a twelve-year dormancy', () => {
  // Found live on 2026-08-05 against an account with 1.59M comments: its newest
  // 299 covered about an hour, and a single 2014 submission came back alongside
  // them. Merged naively that is a 4,480-day silence followed by a revival —
  // the strongest agenda signal in the file firing on the shape of our own
  // pagination. Comments and posts are separate windows of separate depths.
  const now = NOW;
  const comments = Array.from({ length: 40 }, (_, i) => comment({
    id: `fh${i}`, at: now - 3600 + i * 60, group: `g${i % 20}`, body: `reminder number ${i} for you`,
  }));
  const ancientPost = post({ id: 'old1', at: now - 4480 * DAY, group: 'g0', replyCount: 3 });

  const profile = buildProfile({
    platform: 'reddit',
    username: 'firehose',
    fetchedAt: now,
    firstSeenUtc: now - 4480 * DAY,
    karma: { post: 10, comment: 2793484, total: 2793494 },
    counts: { comments: 1593945, posts: 1 },
    comments,
    posts: [ancientPost],
    coverage: buildCoverage({
      commentsFetched: comments.length,
      commentsTotal: 1593945, // truncated by four orders of magnitude
      postsFetched: 1,
      postsTotal: 1, // complete
      oldestFetchedUtc: ancientPost.createdUtc,
      sources: ['arctic-shift'],
    }),
  });

  const sig = findSignal(scoreAccount(profile).agenda, 'dormancy-revival');
  assert.notEqual(sig.band, BAND.HIGH, 'a pagination artifact must not read as a revived account');
  assert.ok(
    (sig.value?.largestGapDays ?? 0) < 120,
    `the 2014 post sits below the reliable window and must be excluded, got ${sig.value?.largestGapDays}`,
  );
});


/**
 * u/AutoModerator, live on 2026-08-05: 299 comments spanning 0.0 days, on an
 * account years old. The signal answered "longest silence is 0 days, below the
 * 120-day threshold" and contributed strength 0 at weight 3 — the only sentence
 * the arithmetic allowed, dressed up as a finding (JIO-290, Finding 3).
 */
function firehoseComments({ count = 299, spanSeconds = 3000, prefix = 'am' } = {}) {
  return Array.from({ length: count }, (_, i) => comment({
    id: `${prefix}${i}`,
    at: NOW - spanSeconds + Math.floor((i * spanSeconds) / count),
    group: `g${i % 40}`,
    body: `Your submission was removed for reason ${i}, please read the rules before posting again.`,
  }));
}

test('agenda: a window too short to hold a 120-day gap is insufficient-data, not a clean zero', () => {
  const sig = findSignal(
    scoreAccount(profileOf({
      comments: firehoseComments(),
      firstSeenUtc: NOW - 3000 * DAY,
      truncated: true,
    })).agenda,
    'dormancy-revival',
  );

  assert.equal(sig.band, BAND.INSUFFICIENT,
    `299 comments over 0.0 days cannot rule a 120-day silence in or out, got ${sig.band}: ${sig.evidence}`);
  assert.equal(sig.direction, 'neutral', 'an unmeasurable signal must not argue either way');
  assert.doesNotMatch(sig.evidence, /below the 120-day dormancy threshold/,
    'reporting a confident zero from a window a gap could not fit in is the defect');
  assert.match(sig.evidence, /could not fit inside it/);
});

test('agenda: the dormancy span gate fires on a COMPLETE short history too, not just a truncated one', () => {
  // Gating on coverage.truncated instead of on the span would have left the
  // bug live for exactly the young accounts this axis gets pointed at: a
  // 30-day history that is complete still cannot hold a 120-day silence.
  const rand = rng(61);
  const stamps = humanTimestamps({ rand, days: 30, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({ id: `yg${i}`, at, body: randomText(rand) }));

  const verdict = scoreAccount(profileOf({
    comments,
    firstSeenUtc: NOW - 30 * DAY,
    truncated: false,
  }));
  assert.equal(verdict.agenda.band === BAND.INSUFFICIENT, false, 'the axis itself still scores');

  const sig = findSignal(verdict.agenda, 'dormancy-revival');
  assert.equal(sig.band, BAND.INSUFFICIENT);
  assert.equal(sig.direction, 'neutral');
  assert.ok(sig.value.spanDays < 120 && sig.value.spanDays > 20,
    `expected the measured span in the value, got ${JSON.stringify(sig.value)}`);
});

// ---------------------------------------------------------------------------
// Finding 2 — query strings are not questions
// ---------------------------------------------------------------------------

/** One real u/RemindMeBot comment, links and all. Seven '?' and no question. */
const REMINDME_BODY = [
  'I will be messaging you in 1 day on [**2026-08-06 12:00:00 UTC**]'
  + '(http://www.wolframalpha.com/input/?i=2026-08-06%2012:00:00%20UTC%20To%20Local%20Time)'
  + ' to remind you of [**this link**]'
  + '(https://www.reddit.com/r/tipofmypenis/comments/1vgfto6/name/p1wwajz/?context=3)',
  '[**CLICK THIS LINK**](https://www.reddit.com/message/compose/?to=RemindMeBot'
  + '&subject=Reminder&message=RemindMe%21%202026-08-06%2012%3A00%3A00%20UTC)'
  + ' to send a PM to also be reminded and to reduce spam.',
  '^(Parent commenter can ) [^(delete this message to hide from others.)]'
  + '(https://www.reddit.com/message/compose/?to=RemindMeBot&subject=Delete%20Comment)',
  'Info | Custom | Your Reminders | Feedback | reddit.com/r/RemindMeBot/comments/e1bko7/?st=abc',
].join('\n\n');

test('authenticity: query strings in links are not questions', () => {
  assert.ok(REMINDME_BODY.split('?').length - 1 >= 5, 'the fixture must carry the query strings');

  const comments = Array.from({ length: 60 }, (_, i) => comment({
    id: `rb${i}`, at: NOW - 3000 + i * 50, group: `g${i % 30}`, body: REMINDME_BODY,
  }));
  const sig = findSignal(
    scoreAccount(profileOf({ comments, firstSeenUtc: NOW - 2000 * DAY, truncated: true })).authenticity,
    'asks-questions',
  );

  assert.equal(sig.value.questions, 0,
    `a template bot's own links must not read as questions, got ${sig.value.questions} of ${sig.value.sample}`);
  assert.equal(sig.band, BAND.LOW);
  assert.match(sig.evidence, /^0 of 60 comments/);
});

test('authenticity: a question in link TEXT still counts, and help-seeking reads the same stripped body', () => {
  // The two halves of this signal deliberately see identical text: whatever
  // the author actually typed, with every link target removed. A question
  // someone wrote as the label of a link is still their question; a phrase
  // that exists only inside a url was written by nobody.
  const rand = rng(67);
  const stamps = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({
    id: `lk${i}`,
    at,
    group: `g${i % 12}`,
    body: i % 2 === 0
      // Asked in the link text, buried behind a query string: still a question.
      ? `${randomText(rand)} [does anyone know how to fix this?](https://example.com/a/b?q=1&r=2)`
      // "how do i" only ever appears inside the url: not help-seeking.
      : `${randomText(rand)} see reddit.com/r/x/how-do-i-do-this/?context=3`,
    thread: `t3_lk${Math.floor(i / 3)}`,
  }));

  const sig = findSignal(scoreAccount(profileOf({ comments })).authenticity, 'asks-questions');
  const half = Math.floor(comments.length / 2);
  assert.ok(Math.abs(sig.value.questions - half) <= 1,
    `only the link-text questions should count, got ${sig.value.questions} of ${sig.value.sample}`);
  assert.ok(sig.value.helpSeeking >= half - 1,
    `"does anyone know" in link text is help-seeking, got ${sig.value.helpSeeking}`);
});

test('automation: a fetch window under three days cannot claim a sleep cycle', () => {
  // Same live account, same root cause on a different signal: 299 comments
  // spanning under an hour necessarily leave 17 hours of the day empty, which
  // read as "consistent with a sleep cycle" — a human alibi manufactured by
  // the fetch window.
  const comments = Array.from({ length: 60 }, (_, i) => comment({
    id: `sp${i}`, at: NOW - 3000 + i * 50, group: `g${i % 20}`, body: `reminder number ${i} for you now`,
  }));

  const sig = findSignal(
    scoreAccount(profileOf({ comments, truncated: true })).automation, 'posting-hour-dead-zone',
  );
  assert.equal(sig.band, BAND.INSUFFICIENT, 'an hour of data says nothing about a sleep cycle');
  assert.equal(sig.direction, 'neutral');
  assert.match(sig.evidence, /far too short a window/);
});

// ---------------------------------------------------------------------------
// Finding 4 — the window where the hour profile cannot run
// ---------------------------------------------------------------------------

/** 299 items across `hours`, spread evenly. The prolific-account shape. */
function fastProfile(hours, count = 299) {
  const rand = rng(53);
  const spacing = (hours * 3600) / count;
  const comments = Array.from({ length: count }, (_, i) => comment({
    id: `fast${i}`,
    at: Math.round(NOW - hours * 3600 + i * spacing),
    group: `g${i % 40}`,
    body: randomText(rand),
    thread: `t3_fast${i}`,
  }));
  return profileOf({ comments, truncated: true, firstSeenUtc: NOW - 2000 * DAY });
}

test('automation: 299 items in 5 hours reads high on throughput, in the very window the hour profile refuses', () => {
  const axis = scoreAccount(fastProfile(5)).automation;

  // The pairing is the point: the heaviest signal in the axis drops out for
  // prolific accounts precisely because they are prolific (EVALUATION.md
  // Finding 4), and this is what covers that window.
  assert.equal(findSignal(axis, 'posting-hour-dead-zone').band, BAND.INSUFFICIENT,
    'the span guard must still refuse — this test is worthless if it was weakened');

  const rate = findSignal(axis, 'sustained-posting-rate');
  assert.equal(rate.band, BAND.HIGH, `299 comments in 5 hours must read high, got ${rate.band}`);
  assert.equal(rate.direction, 'raises');
  assert.ok(rate.value.itemsPerHour > 55, `expected ~60/h, got ${rate.value.itemsPerHour}`);

  // The evidence must claim THROUGHPUT, not schedule. Claiming a schedule from
  // a five-hour window is the forged sleep cycle all over again.
  assert.match(rate.evidence, /throughput/);
  assert.doesNotMatch(rate.evidence, /sleep|quiet|hour of the day|dead zone/);
});

test('automation: an 82-second window still measures throughput — the binding real case', () => {
  // u/AutoModerator's reliable window in test/corpus/ is 297 items spanning 82
  // seconds. Any minimum-span guard it fails leaves the axis at 7.0 of 15.5
  // measured, below MIN_MEASURED_WEIGHT_FRACTION, which is strictly worse than
  // never adding this signal at all.
  const rate = findSignal(scoreAccount(fastProfile(82 / 3600, 297)).automation, 'sustained-posting-rate');

  assert.notEqual(rate.band, BAND.INSUFFICIENT, '82 seconds of 297 items is a throughput fact');
  assert.equal(rate.band, BAND.HIGH);
  assert.match(rate.evidence, /82 seconds/);
});

/**
 * THE EVIDENCE STRING IS PRINTED ON THE ACCOUNT BEING JUDGED, so it is held to
 * what was actually measured (JIO-344, EVALUATION.md Finding 4a).
 *
 * It used to read "above the 3 an hour a person keeps up". That is a claim
 * about people rather than about this account, it was never measured, and it
 * is false: a content-blind sweep of 22 subreddits found seven accounts over
 * the gate and six of them hand-read as people, topping out at 5.90/h — above
 * u/RemindMeBot's 5.5/h. u/humdingler and u/chilidirigible are frozen in
 * `test/corpus/` as the counter-example.
 *
 * The rule this enforces is narrow and easy to keep: describe the ACCOUNT and
 * how the number is weighed, not the population. If a future signal genuinely
 * has a measured claim about people behind it, that measurement goes in
 * EVALUATION.md first and this guard is loosened deliberately — it is not a
 * word filter to route around.
 */
test('automation: the rate evidence claims what was measured, never what a person can do', () => {
  const fired = findSignal(scoreAccount(fastProfile(5)).automation, 'sustained-posting-rate');
  const silent = findSignal(scoreAccount(genuineProfile()).automation, 'sustained-posting-rate');

  assert.equal(fired.band, BAND.HIGH);
  assert.equal(silent.band, BAND.INSUFFICIENT);

  for (const [which, sig] of [['fired', fired], ['unmeasured', silent]]) {
    assert.doesNotMatch(sig.evidence, /\b(?:person|people|human|humans)\b/i,
      `the ${which} rate evidence makes a claim about people: ${JSON.stringify(sig.evidence)}`);
  }

  // ...and it still says the thing it is entitled to say.
  assert.match(fired.evidence, /uncommon/, 'the fired evidence must still explain why the number is being weighed');
  assert.match(silent.evidence, /not a clean result/);
});

test('automation: an ordinary rate is unmeasured, never a vote for a person', () => {
  const axis = scoreAccount(genuineProfile()).automation;
  const rate = findSignal(axis, 'sustained-posting-rate');

  assert.equal(rate.band, BAND.INSUFFICIENT);
  assert.equal(rate.direction, 'neutral',
    'an ordinary rate must not lower the axis — it is the absence of evidence, not evidence');
  assert.match(rate.evidence, /not a clean result/);

  // ...and the axis it sits in still reports, rather than being tipped into
  // insufficient-data by the weight this signal withholds.
  assert.equal(axis.band, BAND.LOW);
  assert.ok(Number.isFinite(axis.score));
});

test('automation: the rate signal never outranks the dead zone it stands in for', () => {
  const axis = scoreAccount(fastProfile(5)).automation;
  const rate = findSignal(axis, 'sustained-posting-rate');

  assert.equal(rate.weight, 2);
  assert.ok(rate.weight < findSignal(axis, 'posting-hour-dead-zone').weight,
    'throughput is the weaker claim of the two and must stay weighted below the schedule');
});

test('automation: the rate is measured over the RELIABLE window, so an ancient post cannot dilute it', () => {
  // Same defect shape as the forged 12-year dormancy: one old submission
  // merged against a shallow comment window. Here it would drag 299 items in
  // 5 hours down to 299 items in 12 years and silence the signal entirely.
  const fast = fastProfile(5);
  const withAncient = profileOf({
    comments: [...fast.comments],
    posts: [post({ id: 'old', at: NOW - 4300 * DAY })],
    truncated: true,
    firstSeenUtc: NOW - 4300 * DAY,
  });

  const rate = findSignal(scoreAccount(withAncient).automation, 'sustained-posting-rate');
  assert.equal(rate.band, BAND.HIGH, 'the 2014 submission is below the reliable start and must be dropped');
  assert.ok(rate.value.spanSeconds < 6 * 3600, `expected a 5-hour span, got ${rate.value.spanSeconds}s`);
});

test('agenda: drive-by counts unanswered replies on own posts and names the proxy half', () => {
  const sig = findSignal(scoreAccount(propagandistProfile()).agenda, 'drive-by-ratio');
  assert.equal(sig.value.postsWithReplies, 2);
  assert.equal(sig.value.abandonedPosts, 2, 'both posts drew replies the account never answered');
  assert.ok(sig.value.share > 0.9);
  assert.equal(sig.band, BAND.HIGH);
  assert.match(sig.evidence, /proxy/, 'the weaker half must be labelled as a proxy');
});

// ---------------------------------------------------------------------------
// Authenticity signals, one at a time
// ---------------------------------------------------------------------------

test('authenticity: self-correction language is found and quoted back', () => {
  const sig = findSignal(scoreAccount(genuineProfile()).authenticity, 'self-correction');
  assert.ok(sig.value.hits > 0);
  assert.ok(['moderate', 'high'].includes(sig.band), `got ${sig.band}`);
  assert.equal(sig.direction, 'raises');
  assert.ok(sig.value.examples.length > 0, 'the evidence quotes what it matched');

  const none = findSignal(scoreAccount(propagandistProfile()).authenticity, 'self-correction');
  assert.equal(none.value.hits, 0);
  assert.match(none.evidence, /absence of positive evidence, not evidence of anything/);
});

test('authenticity: off-script dissent needs the downvotes to be on home turf', () => {
  const sig = findSignal(scoreAccount(genuineProfile()).authenticity, 'off-script-dissent');
  assert.ok(sig.value.downvoted > 0);
  assert.equal(sig.value.topGroup, 'home');
  assert.ok(['moderate', 'high'].includes(sig.band), `got ${sig.band}`);
  assert.match(sig.evidence, /net-downvoted/);
});

test('authenticity: absent dissent is neutral, not a mark against the account', () => {
  const sig = findSignal(scoreAccount(propagandistProfile()).authenticity, 'off-script-dissent');
  assert.equal(sig.value.downvoted, 0);
  assert.equal(sig.direction, 'neutral', 'not being remarkable is not evidence of anything');
  assert.match(sig.evidence, /No evidence either way/);
});

test('authenticity: a universally downvoted account is discounted, not vouched for', () => {
  // Past ~35% this stops being principled dissent and starts being an account
  // its own community dislikes. A troll must not ride this signal to a vouch.
  const rand = rng(53);
  const stamps = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({
    id: `tl${i}`, at, group: 'home', body: randomText(rand), score: i % 10 < 7 ? -12 : 4,
  }));

  const sig = findSignal(scoreAccount(profileOf({ comments })).authenticity, 'off-script-dissent');
  assert.ok(sig.value.share > 0.6);
  assert.equal(sig.band, BAND.LOW, `70% downvoted must not read as courage, got ${sig.band}`);
  assert.match(sig.evidence, /its own community dislikes/);
});

test('authenticity: topical breadth separates a broad account from a single-issue one', () => {
  const broad = findSignal(scoreAccount(genuineProfile()).authenticity, 'topical-breadth');
  const narrow = findSignal(scoreAccount(propagandistProfile()).authenticity, 'topical-breadth');
  assert.ok(broad.value.distinctGroups > narrow.value.distinctGroups);
  assert.equal(broad.band, BAND.HIGH);
  assert.equal(narrow.band, BAND.LOW);
});

// ---------------------------------------------------------------------------
// The two cases most likely to be wrong
// ---------------------------------------------------------------------------

test('CRITICAL: a 24/7 bot and a night-shift human do not get the same verdict', () => {
  const bot = scoreAccount(botProfile());
  const human = scoreAccount(nightShiftProfile());

  assert.equal(bot.automation.band, BAND.HIGH,
    `round-the-clock templated posting must read as automated (score ${bot.automation.score})`);
  assert.equal(human.automation.band, BAND.LOW,
    `an unusual schedule is not automation (score ${human.automation.score})`);
  assert.ok(bot.automation.score - human.automation.score > 40,
    `the two must be far apart, got ${bot.automation.score} vs ${human.automation.score}`);

  assert.match(bot.headline, /automated/);
  assert.doesNotMatch(human.headline, /automated/);
});

test('CRITICAL: a high-agenda, low-automation human is exactly what the tool must surface', () => {
  // The propagandist. A paid human posting talking points has a real account
  // age, organic timing and varied language, so every automation signal reads
  // clean — correctly, because no machine is involved. Collapsing the axes
  // into one number would land this account mid-scale and hide it.
  const verdict = scoreAccount(propagandistProfile());

  assert.ok(
    [BAND.LOW, BAND.MODERATE].includes(verdict.automation.band),
    `automation must stay clean, got ${verdict.automation.band} (${verdict.automation.score})`,
  );
  assert.equal(verdict.agenda.band, BAND.HIGH,
    `agenda must fire, got ${verdict.agenda.band} (${verdict.agenda.score})`);
  assert.equal(verdict.authenticity.band, BAND.LOW,
    `no positive evidence of a person, got ${verdict.authenticity.band}`);

  assert.match(verdict.headline, /paid-poster shape/);
  assert.match(verdict.headline, /an automation check alone would clear it/);
});

test('a genuine person is vouched for rather than left vaguely suspect', () => {
  const verdict = scoreAccount(genuineProfile());

  assert.equal(verdict.automation.band, BAND.LOW);
  assert.equal(verdict.agenda.band, BAND.LOW);
  assert.equal(verdict.authenticity.band, BAND.HIGH,
    `the tool must be able to say yes (score ${verdict.authenticity.score})`);
  assert.match(verdict.headline, /Reads like a real person/);
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

test('the three scores are never blended into one number', () => {
  const verdict = scoreAccount(propagandistProfile());
  const keys = Object.keys(verdict);
  assert.deepEqual(
    keys.sort(),
    ['agenda', 'authenticity', 'automation', 'coverage', 'fetchedAt', 'headline', 'platform', 'username'].sort(),
  );
  for (const forbidden of ['score', 'overall', 'combined', 'botScore', 'probability', 'confidence']) {
    assert.ok(!(forbidden in verdict), `a blended "${forbidden}" defeats the entire point`);
  }
});

test('every signal carries a weight, a direction and an arguable evidence sentence', () => {
  const verdict = scoreAccount(genuineProfile());
  for (const axisName of ['automation', 'agenda', 'authenticity']) {
    const axis = verdict[axisName];
    assert.ok(axis.signals.length > 0);
    for (const s of axis.signals) {
      assert.equal(typeof s.key, 'string');
      assert.equal(typeof s.label, 'string');
      assert.ok(['insufficient-data', 'low', 'moderate', 'high'].includes(s.band), `${s.key}: ${s.band}`);
      assert.ok(['raises', 'lowers', 'neutral'].includes(s.direction), `${s.key}: ${s.direction}`);
      assert.equal(typeof s.weight, 'number');
      assert.ok(s.weight > 0);
      assert.ok(typeof s.evidence === 'string' && s.evidence.length > 30,
        `${s.key} needs an evidence sentence a human can argue with, got "${s.evidence}"`);
      // The internal 0..1 must not escape and become "73% bot".
      assert.ok(!('strength' in s), `${s.key} leaked its internal strength`);
    }
  }
});

test('an unmeasurable signal is reported as unmeasured, not as a clean zero', () => {
  const rand = rng(67);
  // Enough comments to open the gate, but no karma and no post history at all.
  const stamps = humanTimestamps({ rand, days: 200, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({ id: `u${i}`, at, body: randomText(rand) }));

  const verdict = scoreAccount(profileOf({
    comments, karma: { post: null, comment: null, total: null },
  }));

  const karma = findSignal(verdict.automation, 'karma-velocity');
  assert.equal(karma.band, BAND.INSUFFICIENT);
  assert.equal(karma.direction, 'neutral');
  assert.equal(karma.value, null);
  assert.match(karma.evidence, /No karma total or account age/);

  // And it must not have been averaged in as a zero.
  assert.notEqual(verdict.automation.band, BAND.INSUFFICIENT, 'the rest of the axis still scores');
});

test('scoring is pure: the same profile scores identically twice, with no clock of its own', () => {
  const profile = propagandistProfile();
  const a = scoreAccount(profile);
  const b = scoreAccount(profile);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.fetchedAt, NOW, 'the only clock is the one the source captured');
});

test('truncated coverage is carried into the verdict and stated in the headline', () => {
  const rand = rng(71);
  const stamps = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({ id: `c${i}`, at, body: randomText(rand) }));

  const verdict = scoreAccount(profileOf({ comments, truncated: true }));

  assert.equal(verdict.coverage.truncated, true);
  assert.match(verdict.headline, /Based on the most recent \d+ comments/);
});
