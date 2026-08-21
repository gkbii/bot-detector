import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoverage, buildProfile } from '../extension/lib/sources/profile.js';
import { scoreAccount } from '../extension/lib/scoring/index.js';
import {
  BAND, MIN_COMMENTS_FOR_SCORING, MIN_HISTORY_DAYS,
} from '../extension/lib/scoring/axis.js';
import { normalizeWords, rescale, stripUrls } from '../extension/lib/scoring/stats.js';

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
function propagandistProfile({ revived = true } = {}) {
  const rand = rng(11);
  const talkingPoint = 'the mainstream media refuses to report the real numbers';

  // An old era, a long silence, then a busy present. `revived: false` drops the
  // old era and keeps everything else, which leaves `dormancy-revival` measured
  // (300 days is well over its 120-day span gate) and reading a flat zero. That
  // is the one shape the corpus never produces: a strong corroborator beside a
  // measured-zero one. See the strongest-not-weakest test.
  const oldEra = revived
    ? humanTimestamps({ rand, days: 980, activeHours: WAKING_HOURS, activeDayChance: 0.25, perDay: 2, endDaysAgo: 950 })
    : [];
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

/**
 * A DEDICATED HOBBYIST (JIO-424). One subreddit, high volume, one top-level
 * comment per thread and never a return visit — the exact shape
 * `topic-concentration` and `drive-by-ratio` are both built to read, in a
 * person who is pushing nothing. This is u/humdingler and u/chilidirigible,
 * hand-built: the two live accounts that made the axis band a hobbyist.
 *
 * Deliberately spans 300 days, so `dormancy-revival` is MEASURED at zero
 * rather than merely unmeasurable — a measured zero must not corroborate
 * either. `days` shortens that span below the signal's 120-day gate, which is
 * the OTHER case, and the one both live accounts were actually in: their 2-
 * and 4-day windows left dormancy unmeasurable, and an unmeasured corroborator
 * has to be named as unmeasured on screen rather than silently read as a zero.
 */
function hobbyistProfile({ days = 300 } = {}) {
  const rand = rng(41);
  const stamps = humanTimestamps({ rand, days, activeHours: WAKING_HOURS, perDay: 6 });
  const comments = stamps.map((at, i) => comment({
    id: `hb${i}`,
    at,
    group: rand() < 0.92 ? 'thehobby' : `g${Math.floor(rand() * 3)}`,
    body: randomText(rand),
    score: 1 + Math.floor(rand() * 30),
    thread: `t3_hb${i}`, // one and done, every time
    isTopLevel: true,
  }));
  return profileOf({ comments, karma: { post: 800, comment: 9000, total: 9800 } });
}

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

/**
 * THE OTHER POLE, WHICH USED TO VOTE THE WRONG WAY (JIO-345).
 *
 * A summon-bot replies to a commenter 100% of the time, because that is what
 * being summoned IS. Under `1 - rescale(replyShare, …)` that earned strength
 * 0 — the maximum vote for humanity in the axis, at full weight, produced by
 * the mechanism that makes it a bot. u/RemindMeBot is the real account
 * (299 of 299 replies, frozen in `test/corpus/`); this is that shape,
 * hand-built.
 */
function replyBotProfile() {
  const comments = [];
  for (let i = 0; i < 400; i += 1) {
    const at = NOW - (400 - i) * 3600 + (i % 7) * 8; // hourly, tiny jitter
    comments.push(comment({
      id: `rb${i}`,
      at,
      group: `g${i % 6}`,
      body: `I will message you in 3 days. Click this to send a PM to also be reminded. Reference ${i}.`,
      score: 1,
      isTopLevel: false, // summoned, every single time
    }));
  }
  return profileOf({ comments, karma: { post: 5000, comment: 45000, total: 50000 }, firstSeenUtc: NOW - 300 * DAY });
}

test('automation: replying to everyone is not evidence of a person', () => {
  const sig = findSignal(scoreAccount(replyBotProfile()).automation, 'conversation-depth');

  assert.equal(sig.value.topLevel, 0, 'the fixture must hold no top-level comment at all');
  assert.equal(sig.band, BAND.INSUFFICIENT,
    'a 100% reply rate must be unmeasured, never a measured zero (axis.js rule 3)');
  assert.equal(sig.strength ?? null, null, 'nothing that reads as a strength may be published here');
  assert.equal(sig.direction, 'neutral', 'an unmeasured pole must not lean either way');
  // The evidence has to say what it cannot conclude, not only what it counted.
  assert.match(sig.evidence, /cannot tell those two apart/);
  assert.match(sig.evidence, /never replies at all/);
});

/**
 * THE BOUND, PINNED. The cut is categorical — no top-level comment ANYWHERE in
 * the window — because the frozen humans separate from the frozen reply-bots
 * by three comments in 300, and no percentile drawn off 19 people survives
 * that margin. What it costs is that ONE top-level comment buys a reply-bot
 * its measured zero back. That is written down in automation.js and asserted
 * here, so it stays a stated bound rather than a discovery.
 */
test('automation: one top-level comment in 400 is enough to escape the reply-pole cut', () => {
  const comments = replyBotProfile().comments
    .map((c, i) => (i === 0 ? { ...c, isTopLevel: true, parentId: c.threadId } : c));
  const sig = findSignal(scoreAccount(profileOf({ comments })).automation, 'conversation-depth');

  assert.equal(sig.value.topLevel, 1);
  assert.equal(sig.band, BAND.LOW,
    'the cut is at zero, so 1-in-400 is still measured — and still scores the zero');
});

test('automation: the reply-pole cut leaves the broadcast pole and ordinary people alone', () => {
  // One-and-done, top-level every time: the pole that works, on the account
  // this project exists to find.
  const pushed = findSignal(scoreAccount(propagandistProfile()).automation, 'conversation-depth');
  assert.equal(pushed.band, BAND.HIGH);

  // And a person with real back-and-forth still gets the discount. Withdrawing
  // THAT is JIO-329, which costs real people a band; it is not this change.
  const human = findSignal(scoreAccount(genuineProfile()).automation, 'conversation-depth');
  assert.equal(human.band, BAND.LOW);
  assert.ok(human.value.topLevel > 0);
  assert.match(human.evidence, /rather than evidence of a person/);
});

/**
 * THE SAME SHAPE ON THE OTHER SIGNAL JIO-329 WOULD HAVE REMOVED (JIO-346).
 *
 * `interval-regularity` scored `1 - rescale(cv, 0.15, 1.0)`, and `rescale`
 * clamps: every account from CV 1.0 up earned the identical strength 0.000, at
 * weight 2. A summon-driven bot does not own its own cadence — it inherits the
 * irregularity of the people summoning it — so u/RemindMeBot measured CV 1.26
 * and was told it had "the irregular, clumpy spacing typical of a person".
 * Measured over `test/corpus/` by `scripts/measure-interval-cv.mjs`, 26 of the
 * 27 frozen accounts are above that ceiling: all 19 humans AND seven of the
 * eight declared bots.
 */
function summonedBotProfile() {
  const rand = rng(23);
  const comments = [];
  let at = NOW - 300 * DAY;
  for (let i = 0; i < 400; i += 1) {
    // Summons arrive when people ask, so the gaps are the humans' and not the
    // bot's: a heavy tail, exactly what an ordinary person's cadence looks like.
    at += Math.round(60 + (rand() ** 4) * 90000);
    comments.push(comment({
      id: `sb${i}`,
      at,
      group: `g${i % 9}`,
      body: `I will message you in 3 days. Click this to send a PM to also be reminded. Reference ${i}.`,
      score: 1,
      isTopLevel: false,
    }));
  }
  return profileOf({ comments, karma: { post: 5000, comment: 45000, total: 50000 }, firstSeenUtc: NOW - 400 * DAY });
}

test('automation: an uneven cadence is not evidence of a person', () => {
  const sig = findSignal(scoreAccount(summonedBotProfile()).automation, 'interval-regularity');

  assert.ok(sig.value.coefficientOfVariation >= 1.0,
    'the fixture must land above the ceiling rescale() already clamped at');
  assert.equal(sig.band, BAND.INSUFFICIENT,
    'a CV past the top of the scale must be unmeasured, never a measured zero (axis.js rule 3)');
  assert.equal(sig.strength ?? null, null, 'nothing that reads as a strength may be published here');
  assert.equal(sig.direction, 'neutral', 'an unmeasured pole must not lean either way');
  // The evidence has to name what it cannot conclude, not only what it counted.
  assert.match(sig.evidence, /inherits its irregularity from the people summoning it/);
  assert.match(sig.evidence, /too even to be anyone/);
});

test('automation: the mechanical pole is untouched, and it is the half that separates', () => {
  // Hourly to the second, which is nobody's day.
  const bot = findSignal(scoreAccount(botProfile()).automation, 'interval-regularity');
  assert.ok(bot.value.coefficientOfVariation < 0.15);
  assert.equal(bot.band, BAND.HIGH);
  assert.equal(bot.direction, 'raises');
  assert.match(bot.evidence, /far lumpier than this/);

  // And a person is not read as one. Both of these were 0.000 before JIO-346;
  // only the human end changed.
  const human = findSignal(scoreAccount(genuineProfile()).automation, 'interval-regularity');
  assert.equal(human.band, BAND.INSUFFICIENT);
});

/**
 * THE BOUND, PINNED. The gate is the ceiling of the existing scale rather than
 * a number drawn next to the 27 frozen accounts, so what it costs is that a
 * scheduler jittering just past CV 1.0 buys the same silence a person gets.
 * u/sub_doesnt_exist_bot (CV 0.94) is the one frozen account still measured
 * here, and the margin between it and the gate is the whole of the protection.
 * That is written down in automation.js and asserted here so it stays a stated
 * bound rather than a later discovery.
 */
test('automation: a scheduler jittering past the ceiling buys the same silence a person gets', () => {
  const jittered = (spreadSeconds) => {
    const rand = rng(29);
    const comments = [];
    let at = NOW - 300 * DAY;
    for (let i = 0; i < 400; i += 1) {
      at += Math.max(60, Math.round(3600 + (rand() - 0.5) * spreadSeconds));
      comments.push(comment({
        id: `jt${i}`, at, group: `g${i % 6}`, score: 1, isTopLevel: true,
        body: `Great point! I completely agree with this take and think more people should see it. Reference ${i}.`,
      }));
    }
    return findSignal(scoreAccount(profileOf({ comments })).automation, 'interval-regularity');
  };

  const tight = jittered(2000);
  assert.ok(tight.value.coefficientOfVariation < 1.0);
  assert.notEqual(tight.band, BAND.INSUFFICIENT, 'a scheduler inside the scale is still read');

  const loose = jittered(40000);
  assert.ok(loose.value.coefficientOfVariation >= 1.0);
  assert.equal(loose.band, BAND.INSUFFICIENT,
    'and one that jitters past the ceiling is not — the bound this change accepts');
});

/**
 * THE RECONSTRUCTION, PINNED. EVALUATION.md Finding 4e publishes a BEFORE score
 * for u/chilidirigible -- `low 26` against the `moderate 30` it scores live
 * today -- and calls that a measurement rather than an estimate. It is only a
 * measurement because the old `1 - rescale(cv, 0.15, 1.0)` CLAMPED: above the
 * ceiling the pre-JIO-346 strength was not approximately zero, it was exactly
 * 0.000, so re-adding 2 of weight at that strength recovers the old score with
 * no modelling in between.
 *
 * That identity is what the whole crossing claim rests on, and it lives in a
 * function this signal no longer calls above 1.0 -- which is exactly the shape
 * that rots unnoticed. If `rescale` ever stops clamping, or the floor/ceiling
 * move, the published 26 silently becomes a guess. This says so first.
 */
test('automation: the pre-JIO-346 strength above the ceiling was exactly zero, not nearly zero', () => {
  // The CVs Finding 4e names, plus the poles of the frozen corpus's range.
  for (const cv of [1.0, 1.01, 1.09, 1.26, 1.665, 2.338, 4.964, 5.292, 16.09, 1e6]) {
    const oldStrength = 1 - rescale(cv, 0.15, 1.0);
    assert.equal(oldStrength, 0,
      `CV ${cv} must reconstruct at exactly 0, not ${oldStrength} — `
      + 'Finding 4e\'s before-scores are arithmetic only while this holds');
  }

  // And immediately below the gate it is NOT zero, which is why the mechanical
  // pole survived the change and u/sub_doesnt_exist_bot (CV 0.94) is still read.
  assert.ok(1 - rescale(0.94, 0.15, 1.0) > 0,
    'below the ceiling the old scale still varied — that half was never the problem');
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

// ---------------------------------------------------------------------------
// JIO-386 — the same rule, running the other way
// ---------------------------------------------------------------------------

/**
 * `stripUrls()` erred in both directions at once, and both errors landed on
 * `asks-questions`, the one signal that is positive evidence of a PERSON.
 *
 * The bare host/path rule was `[\w-]+(?:\.[\w-]+)+\/\S*` — two dot-joined
 * word chunks and a slash. A numeric ratio is exactly that shape, so
 * "would you rate it 3.5/10?" was cut to "would you rate it" and a human lost
 * a genuine question AND three tokens. Meanwhile the rule needed the slash, so
 * `/search?q=cats` and `example.com?utm=1` kept their `?` and read as
 * curiosity — JIO-290's defect, still open in two shapes.
 *
 * The fix is one shape rule: a host ends in an ALPHABETIC top-level label of
 * two or more letters. `3.5/10` and `10.50/hour` fail it on `5` and `50`, and
 * so do `U.S./Canada` and `v1.2.3/build`, which the old rule also ate. A query
 * now counts as a link tail without a path, but only a real one — it must
 * carry an `=`, so "see example.com?" stays the question the README promises.
 */
const STRIP_URL_CASES = [
  // [ input, must survive in the stripped text, must not survive ]
  ['would you rate it 3.5/10?', ['3.5/10', '?'], []],
  ['it costs 10.50/hour, right?', ['10.50/hour', '?'], []],
  ['the U.S./Canada border, no?', ['U.S./Canada', '?'], []],
  ['does v1.2.3/build pass?', ['v1.2.3/build', '?'], []],
  ['and/or, he/she, 12/25 — clear?', ['and/or', 'he/she', '12/25', '?'], []],
  ['see example.com? I think so', ['example.com?'], []],
  ['see /search?q=cats for more', ['see', 'for more'], ['?', 'cats']],
  ['check example.com?utm=1 later', ['check', 'later'], ['?', 'utm']],
  ['go to reddit.com/r/x/?context=3 now', ['go to', 'now'], ['?', 'context']],
  ['read en.wikipedia.org/wiki/Foo please', ['read', 'please'], ['wikipedia']],
  ['watch youtu.be/abc123 tonight', ['watch', 'tonight'], ['youtu']],
  ['(/message/compose/?to=Bot) is the link', ['is the link'], ['?', 'compose']],
];

/**
 * The same rule, checked against text nobody here invented. Every one of these
 * is a verbatim fragment from a real comment that the pre-JIO-386 rule ate,
 * found by A/B-ing both rules over 17,282 live bodies on 2026-08-21 (README,
 * "And the same rule, running the other way"). They are kept separate from the
 * list above because they are evidence rather than design: the hand-built
 * cases say what we MEANT the rule to do, and these say what people wrote.
 *
 * Four of the six are shapes the hand-built list does not reach — a unit after
 * the slash (`1.5A/port`), a size out of a size (`15.8/16GB`), a currency
 * symbol in front (`$44.56/hour`), and a ratio in non-Latin text where no
 * surrounding word is a hint (`2.5/3.5`). The last is the only live instance of
 * the ticket's own review-rating shape, and it is why the ticket was right even
 * though the measurement is smaller than it claimed.
 */
const LIVE_STRIP_URL_CASES = [
  // [ input, the fragment the old rule destroyed, the account that wrote it ]
  ['\u039d\u03b1\u03b9 \u03b3\u03b9\u03b1 backup. \u0395\u03c7\u03c9 \u03ad\u03bd\u03b1 \u03c3\u03c5\u03c1\u03c4\u03ac\u03c1\u03b9 \u03bc\u03b5 30+ \u03c3\u03ba\u03bb\u03b7\u03c1\u03bf\u03cd\u03c2 \u03b4\u03af\u03c3\u03ba\u03bf\u03c5\u03c2 2.5/3.5', '2.5/3.5', 'u/Imgema'],
  ['However, it maxes at 1.5A/port. So, as others have said', '1.5A/port', 'u/rogue1102'],
  ['Post-tax, I make around 5.2k/month. I pay about 3k for rent', '5.2k/month', 'u/Throwaway_LostOW'],
  ['15.8/16GB with nothing running on 16GB RAM is not normal', '15.8/16GB', 'u/NanosoftComputers'],
  ['I currently make $44.56/hour for 37.5 hours per week', '$44.56/hour', 'u/ScubaAlek'],
  ['My problem is purely a meta one and I still gave it a 3.5/5', '3.5/5', 'u/Grindhoss'],
];

/** The one thing the new rules removed from that sweep that the old one kept. */
const LIVE_TRUE_POSITIVE = ['Go to /_layouts/15/people.aspx?MembershipGroupId=0 on the broken site',
  'MembershipGroupId', 'u/blud_13'];

test('stripUrls: a ratio is not a host, and a query string is not a question', () => {
  for (const [input, survives, removed] of STRIP_URL_CASES) {
    const stripped = stripUrls(input);
    for (const fragment of survives) {
      assert.ok(stripped.includes(fragment),
        `${JSON.stringify(input)} -> ${JSON.stringify(stripped)} lost ${JSON.stringify(fragment)}`);
    }
    for (const fragment of removed) {
      assert.ok(!stripped.includes(fragment),
        `${JSON.stringify(input)} -> ${JSON.stringify(stripped)} kept ${JSON.stringify(fragment)}`);
    }
  }
});

test('stripUrls: the fragments live accounts actually lost keep their text', () => {
  for (const [body, fragment, author] of LIVE_STRIP_URL_CASES) {
    assert.ok(stripUrls(body).includes(fragment),
      `${author} wrote ${JSON.stringify(fragment)} and the rule ate it: ${JSON.stringify(stripUrls(body))}`);
  }

  const [body, gone, author] = LIVE_TRUE_POSITIVE;
  assert.ok(!stripUrls(body).includes(gone),
    `${author}'s query string is a link and must not survive: ${JSON.stringify(stripUrls(body))}`);
});

test('normalizeWords: a ratio keeps its tokens, a query string contributes none', () => {
  // The automation axis reads the same stripped text, so the ticket's defect
  // cost the ratio its words as well as its question mark.
  assert.deepEqual(normalizeWords('would you rate it 3.5/10?'),
    ['would', 'you', 'rate', 'it', '3', '5', '10']);
  assert.deepEqual(normalizeWords('see /search?q=cats for more'), ['see', 'for', 'more']);
  assert.deepEqual(normalizeWords('check example.com?utm=1 later'), ['check', 'later']);
});

test('authenticity: a human who quotes ratios keeps the question credit', () => {
  // The inversion of the RemindMeBot fixture above. Every body here ends in a
  // real question that happens to contain a ratio; before JIO-386 the bare
  // host/path rule deleted the ratio, the question mark and everything after
  // it, and this account asked no questions at all.
  const rand = rng(386);
  const stamps = humanTimestamps({ rand, days: 300, activeHours: WAKING_HOURS });
  const comments = stamps.map((at, i) => comment({
    id: `rt${i}`,
    at,
    group: `g${i % 12}`,
    body: `${randomText(rand)} would you rate it ${3 + (i % 5)}.5/10?`,
    thread: `t3_rt${Math.floor(i / 3)}`,
  }));

  const sig = findSignal(scoreAccount(profileOf({ comments })).authenticity, 'asks-questions');
  assert.equal(sig.value.questions, comments.length,
    `every body ends in a question, got ${sig.value.questions} of ${sig.value.sample}`);
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

/**
 * THE FALSE POSITIVE THIS AXIS COULD LEAST AFFORD (JIO-424).
 *
 * Two of the four agenda signals describe the SHAPE of an account's
 * participation, and both are true of a hobbyist. Read as a plain weighted
 * mean they banded u/humdingler and u/chilidirigible `moderate` 55 and 57 on
 * nothing but volume and choice of subreddit, while `stock-phrasing` measured
 * a real zero for both. The header of agenda.js has always said these signals
 * are "weighted to be read together"; this is that sentence, executed.
 *
 * If this fails, the axis has gone back to accusing people of having a hobby.
 * HAND-READ the account before changing it.
 */
test('agenda: single-subject focus and posts-and-leaves cannot band an account on their own', () => {
  const verdict = scoreAccount(hobbyistProfile()).agenda;
  const topic = findSignal(verdict, 'topic-concentration');
  const driveBy = findSignal(verdict, 'drive-by-ratio');

  // The shape really is there — this is not a fixture that fails to fire.
  assert.ok(topic.value.topShare > 0.85, `expected a concentrated account, got ${topic.value.topShare}`);
  assert.ok(driveBy.value.share > 0.85, `expected a drive-by shape, got ${driveBy.value.share}`);

  // And neither corroborating signal reads above low, including a MEASURED
  // zero on dormancy rather than an unmeasurable one.
  assert.equal(findSignal(verdict, 'stock-phrasing').band, BAND.LOW);
  assert.equal(findSignal(verdict, 'dormancy-revival').band, BAND.LOW);

  assert.equal(topic.value.heldToCorroboration, true);
  assert.equal(driveBy.value.heldToCorroboration, true);
  assert.equal(verdict.band, BAND.LOW,
    `a hobbyist must not earn an agenda band, got ${verdict.band} (${verdict.score})`);
});

test('agenda: a held signal says so on the account being judged', () => {
  const topic = findSignal(scoreAccount(hobbyistProfile()).agenda, 'topic-concentration');

  // The measurement survives the hold — a reader has to be able to see both
  // what was measured and what was counted.
  assert.match(topic.evidence, /sits in one group/);
  assert.match(topic.evidence, /fits a dedicated hobbyist/);
  assert.match(topic.evidence, /nothing beside it reads above low/);
  assert.match(topic.evidence, /held to the edge of `moderate` rather than counted in full/);
  assert.doesNotMatch(topic.evidence, /could not be measured at all/,
    'both corroborators ARE measured on this fixture — do not claim otherwise');
});

/**
 * And the case both live accounts were in. u/humdingler and u/chilidirigible
 * were captured over 2- and 4-day windows, so `dormancy-revival` could not be
 * measured at all — and "we did not look" must not read on screen as "we
 * looked and found nothing", which is `axis.js` rule 3 in the one place a user
 * actually reads. Nothing pinned this sentence: dropping the `strength != null`
 * filter that produces it passes the rest of the suite and `evaluate`, because
 * `Math.max` swallows the null and no score moves.
 */
test('agenda: a corroborator that could not be measured is named as unmeasured', () => {
  const verdict = scoreAccount(hobbyistProfile({ days: 60 })).agenda;
  assert.equal(findSignal(verdict, 'dormancy-revival').band, BAND.INSUFFICIENT,
    'the fixture only bites if the window is too short to look for a gap');

  const topic = findSignal(verdict, 'topic-concentration');
  assert.equal(topic.value.heldToCorroboration, true);
  assert.match(topic.evidence, /nothing beside it reads above low, and one of the two could not be measured at all/);
  assert.equal(verdict.band, BAND.LOW);
});

/**
 * The other half of the same rule. The hold is GRADED — a shape signal is
 * held to the strength of the evidence beside it, not switched off — so a
 * talking point recurring across unrelated threads buys the shape signals back
 * their band. Without this the hold would be a blanket discount on two signals
 * rather than a statement about reading them together, and the propagandist
 * would quietly get cheaper to be.
 */
test('agenda: a talking point buys the shape signals back their strength', () => {
  const verdict = scoreAccount(propagandistProfile()).agenda;

  for (const key of ['topic-concentration', 'drive-by-ratio']) {
    const sig = findSignal(verdict, key);
    assert.equal(sig.band, BAND.HIGH,
      `${key} was held below its own band despite a talking point recurring across threads`);
    assert.doesNotMatch(sig.evidence, /nothing beside it reads above low/);
  }
  assert.equal(verdict.band, BAND.HIGH);
});

/**
 * THE CLIFF THIS RULE DOES NOT HAVE, pinned because the graded shape is the
 * whole reason it is written the way it is. An on/off gate at the band edge
 * would have moved u/chilidirigible from agenda 30 to 68 on a `stock-phrasing`
 * strength crossing 0.30, and two of the 17 thread humans sit within 0.11 of
 * that line on their real bodies (0.37 and 0.40). So: a hair more
 * corroboration must buy a hair more agenda, never a band.
 */
test('agenda: corroboration is graded, so no small change in phrasing moves a band', () => {
  const base = hobbyistProfile();
  const talkingPoint = 'the mainstream media refuses to report the real numbers';

  let previous = null;
  for (const share of [0, 0.04, 0.08, 0.12, 0.16, 0.2]) {
    const comments = base.comments.map((c, i) => (
      i / base.comments.length < share ? { ...c, body: `${c.body} ${talkingPoint}.` } : c
    ));
    const score = scoreAccount({ ...base, comments }).agenda.score;
    if (previous !== null) {
      assert.ok(score - previous <= 12,
        `agenda jumped ${previous} -> ${score} on a small change in phrasing coverage (${share})`);
    }
    previous = score;
  }
});

/**
 * STRONGEST, NOT WEAKEST (JIO-424). The ceiling is a `max` over the measured
 * corroborators, and nothing pinned that until this test: mutating it to a
 * `min` passed the entire suite and `npm run evaluate`, because no account in
 * `test/corpus/` and no other fixture has both corroborators measured with one
 * of them strong. This one does — a talking point recurring across threads,
 * beside a 300-day span whose longest silence is days, so `dormancy-revival`
 * is a MEASURED ZERO rather than an absent one.
 *
 * A `min` would hold both shape signals to the band edge here and let a real
 * propagandist out of `high` on the strength of evidence it does NOT have,
 * which is the inversion of the rule this whole hold was written to state.
 */
test('agenda: shape is held to the strongest corroborator, not the weakest', () => {
  const verdict = scoreAccount(propagandistProfile({ revived: false })).agenda;

  const dormancy = findSignal(verdict, 'dormancy-revival');
  assert.equal(dormancy.band, BAND.LOW, 'the fixture only bites if dormancy is MEASURED');
  assert.ok(dormancy.value.largestGapDays < 120, 'and measured at zero');
  assert.equal(findSignal(verdict, 'stock-phrasing').band, BAND.HIGH,
    'the strong corroborator the shape must be read against');

  for (const key of ['topic-concentration', 'drive-by-ratio']) {
    const sig = findSignal(verdict, key);
    // Held — both shape strengths clamp to 1 here, above any corroborator — but
    // held to the phrasing at `high`, not down to the band edge by the zero.
    assert.equal(sig.value.heldToCorroboration, true);
    assert.equal(sig.band, BAND.HIGH,
      `${key} was held to the measured-zero dormancy rather than the phrasing beside it`);
    assert.match(sig.evidence, /"Recurring stock phrases", reads high/);
  }
  assert.ok(verdict.score >= 60, `a corroborated propagandist fell to ${verdict.score}`);
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
