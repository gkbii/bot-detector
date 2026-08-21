/**
 * AUTHENTICITY — positive evidence that this is a real person.
 *
 * This axis exists because a tool that only ever flags suspicion never answers
 * the question that was asked. Run three suspicion scores over a normal human
 * and you get three shrugs, which reads as "probably fine, but…" — everyone
 * ends up looking slightly guilty and nobody gets vouched for. So these
 * signals look for things that are HARD TO FAKE AND POINTLESS TO FAKE:
 * admitting error, staying in an argument, caring about unrelated subjects,
 * asking for help, and taking an unpopular position in front of your own
 * audience.
 *
 * A low score here is NOT an accusation. It means we found no positive
 * evidence, which is a different statement from the automation and agenda
 * axes, and the headline in index.js is careful to keep them apart.
 */

import { commentsOldestFirst, groupHistogram } from '../sources/profile.js';
import { buildAxis, signal, unmeasured } from './axis.js';
import {
  clamp01, normalizedEntropy, pct, plural, rescale, stripUrls,
} from './stats.js';

const MIN_COMMENTS = 10;
const MIN_THREADS = 5;
const MIN_GROUP_ITEMS = 10;

/**
 * Items per group at which topical breadth is credited in full. Below it the
 * account's reach is tapered towards zero at 1.0 item per group — see the long
 * note on `topicalBreadthSignal`.
 */
const DEPTH_FULL_CREDIT = 3;

/** Distinct groups at which the reach half of that signal saturates. */
const REACH_FULL_CREDIT_GROUPS = 15;

/**
 * Grouped items below which the depth taper is WITHHELD, because under it the
 * taper stops measuring the account's shape and starts measuring its size.
 *
 * It is the product of the two constants above and not a number chosen next to
 * a population: `REACH_FULL_CREDIT_GROUPS` groups at `DEPTH_FULL_CREDIT` items
 * each is the smallest history in which an account can satisfy BOTH halves of
 * this signal at once. Below it the two are in structural conflict — every item
 * spent widening the reach is one not available to deepen it — so an account
 * there is docked for how little it has posted rather than for where it went.
 */
const DEPTH_MIN_ITEMS = REACH_FULL_CREDIT_GROUPS * DEPTH_FULL_CREDIT;

/**
 * Items per group at or below which a tapered account is DESCRIBED as running
 * sitewide, rather than merely discounted for it.
 *
 * Two is where the average group stops being a visit: under it most of what the
 * account touched it never went back to. The live sweep behind `DEPTH_MIN_ITEMS`
 * is what makes the distinction load-bearing — real people do land in the
 * tapered range (2.53 and 2.61 items per group, docked ~20%), and telling
 * someone their account looks like automation is an accusation this axis
 * explicitly does not make. A discount is a discount; only the floor of the
 * measure is a description.
 */
const SITEWIDE_ITEMS_PER_GROUP = 2;

/**
 * Admitting error. Cheap to type, but a propaganda account has no reason to —
 * conceding a point is the opposite of the job.
 */
const SELF_CORRECTION_PATTERNS = [
  /\bi was wrong\b/i,
  /\byou(?:'| a)?re right\b/i,
  /\bfair (?:point|enough)\b/i,
  /\bgood (?:catch|point)\b/i,
  /\bi stand corrected\b/i,
  /\bi misremembered\b/i,
  /\bi misread\b/i,
  /\bmy (?:mistake|bad)\b/i,
  /\bi'?m wrong\b/i,
  /\bcorrection\b/i,
  /(?:^|\s)edit\s*[:\-]/i,
  /\bTIL\b/,
  /\bturns out i\b/i,
  /\bthanks for (?:the )?correct/i,
];

const HELP_SEEKING_PATTERNS = [
  /\bdoes anyone know\b/i,
  /\bcan (?:someone|anyone)\b/i,
  /\bhow do i\b/i,
  /\bany (?:idea|advice|suggestions|recommendations)\b/i,
  /\bam i missing\b/i,
  /\bwhat am i doing wrong\b/i,
  /\bnot sure (?:if|how|what|why)\b/i,
  /\bgenuine question\b/i,
];

/** Threads with at least this many comments count as sustained back-and-forth. */
const SUSTAINED_MIN_COMMENTS = 3;

/**
 * A "dominant group" needs both a real share and a real sample before the
 * dissent signal will look inside it.
 */
const DOMINANT_MIN_SHARE = 0.25;
const DOMINANT_MIN_SCORED_COMMENTS = 10;
/** Past this, the account is simply disliked — see the note on the signal. */
const DISSENT_DAMPING_START = 0.35;
const DISSENT_DAMPING_END = 0.8;

export function scoreAuthenticity(profile) {
  return buildAxis([
    selfCorrectionSignal(profile),
    sustainedThreadSignal(profile),
    topicalBreadthSignal(profile),
    questionSignal(profile),
    offScriptDissentSignal(profile),
  ]);
}

function selfCorrectionSignal(profile) {
  const key = 'self-correction';
  const label = 'Admits being wrong';
  const weight = 2.5;

  const bodies = profile.comments.map((c) => c.body).filter((b) => typeof b === 'string' && b.length);
  if (bodies.length < MIN_COMMENTS) {
    return unmeasured({
      key, label, weight, evidence: `Only ${bodies.length} comments with retrievable text — needs at least ${MIN_COMMENTS}.`,
    });
  }

  const examples = [];
  let hits = 0;
  for (const body of bodies) {
    const matched = SELF_CORRECTION_PATTERNS.find((re) => re.test(body));
    if (matched) {
      hits += 1;
      if (examples.length < 3) {
        const m = body.match(matched);
        if (m) examples.push(m[0].trim().toLowerCase());
      }
    }
  }

  const share = hits / bodies.length;
  const strength = rescale(share, 0.005, 0.05);

  return signal({
    key,
    label,
    weight,
    strength,
    value: { hits, sample: bodies.length, share, examples },
    evidence: hits
      ? `${hits} of ${bodies.length} comments (${pct(share)}) contain self-correction language — e.g. ${examples.map((e) => `"${e}"`).join(', ')}. Conceding a point is the opposite of what a scripted account is for.`
      : `None of the ${bodies.length} comments contain self-correction language. That is an absence of positive evidence, not evidence of anything.`,
  });
}

/**
 * Sustained back-and-forth: threads the account stayed in, replying to other
 * commenters rather than only to the submission. Requiring at least one
 * non-top-level comment is what makes this "an argument" rather than "three
 * separate thoughts about the same post".
 */
function sustainedThreadSignal(profile) {
  const key = 'sustained-threads';
  const label = 'Stays in conversations';
  const weight = 2;

  const threads = new Map();
  for (const c of commentsOldestFirst(profile)) {
    const id = c.threadId ?? c.id;
    if (!id) continue;
    if (!threads.has(id)) threads.set(id, []);
    threads.get(id).push(c);
  }

  if (threads.size < MIN_THREADS) {
    return unmeasured({
      key, label, weight, evidence: `Only ${threads.size} distinct threads in the retrieved history — needs at least ${MIN_THREADS}.`,
    });
  }

  let sustained = 0;
  let deepest = 0;
  for (const comments of threads.values()) {
    if (comments.length > deepest) deepest = comments.length;
    const repliesToOthers = comments.filter((c) => c.isTopLevel === false).length;
    if (comments.length >= SUSTAINED_MIN_COMMENTS && repliesToOthers >= 1) sustained += 1;
  }

  const share = sustained / threads.size;
  const strength = rescale(share, 0.02, 0.25);

  return signal({
    key,
    label,
    weight,
    strength,
    value: { sustained, threads: threads.size, share, deepestThread: deepest },
    evidence: sustained
      ? `Held sustained back-and-forth in ${sustained} of ${threads.size} threads (${pct(share)}), replying to other commenters rather than only to the submission; the longest run was ${deepest} comments in one thread.`
      : `No thread received ${SUSTAINED_MIN_COMMENTS}+ comments including a reply to another commenter, across ${threads.size} threads.`,
  });
}

/**
 * Topical breadth. Real people are interested in more than one thing. Scored
 * from both how much sits OUTSIDE the largest cluster and how many distinct
 * groups there are, because either alone is gameable: an account in two groups
 * 50/50 has a low top share, and an account touching 30 groups once each while
 * spending 90% of itself in one has a high distinct count.
 *
 * AND THEN TAPERED BY DEPTH, which is the part that stops it vouching for
 * infrastructure (JIO-347, EVALUATION.md Finding 4f). Both halves above
 * saturate on sitewide automation: u/AutoModerator answers in 307 groups with
 * 98% of itself outside the largest, so it scored a flat 1.000 — the maximum
 * this signal can award a human — and both of its `high` authenticity signals
 * were artifacts of being a machine. Running everywhere is what a bot IS. All
 * eight declared bots in the frozen corpus read `high` here, not the two the
 * ticket named.
 *
 * The discriminator is items per group. Full credit needs `DEPTH_FULL_CREDIT`
 * items per group and credit starts at 1.0, which is not a threshold fitted
 * between two adjacent accounts: 1.0 is the arithmetic minimum of the measure —
 * one item in every group, reach with no depth anywhere — and 3 is a return
 * visit rather than a drive-by. Reproduce both ends with
 * `node scripts/measure-topical-breadth.mjs`.
 *
 * HOW WIDE THE GAP ACTUALLY IS, which is smaller than the corpus says. The 27
 * frozen accounts read bots 1.24-2.06 against humans 3.08-66.7, no overlap and
 * a clear 1.02 between the populations. A content-blind live sweep of 42
 * scorable accounts on 2026-08-21 (Finding 4f) found the human tail runs down
 * to 2.53, and 6 of the 42 sit within 20% of the edge. The real margin above
 * the busiest corpus bot is 0.47, not 1.02, and the two humans past the edge
 * are docked 5.9 and 4.8 authenticity points without changing band. So the
 * taper cuts where it was aimed, but "nobody is standing in the gap" was a
 * statement about 19 people rather than about people, and the constant is
 * defended by its derivation above and not by that margin.
 *
 * AND IT IS WITHHELD BELOW `DEPTH_MIN_ITEMS`. The same live sweep found a
 * 25-item person in 19 groups — 1.32 items each, automation `low 0`, coverage
 * not truncated — reading the same breadth band as u/AutoModerator and losing
 * 21 authenticity points for it. Above the floor, items per group measures the
 * account's shape; at the floor it measures its SIZE, and no history is short
 * enough to be evidence of automation. The gate costs the fix nothing: the
 * smallest declared bot in the corpus carries 299 grouped items against a gate
 * of 45. Withholding a discount is generous, so like every other bound here it
 * is named in the evidence rather than applied silently.
 *
 * WHY THE SINGLETON SHARE IS NOT THE MEASURE, though it is the obvious one:
 * the share of an account's groups holding exactly one item does separate the
 * two populations, by 0.0023 — u/humdingler at 0.6667 against u/RepostSleuthBot
 * at 0.6689. A cut there is fitted to the third decimal place of one person,
 * and one more comment in a group they have already visited moves it. On items
 * per group those same two populations are 1.02 apart, a factor of 1.49.
 *
 * WHY A TAPER AND NOT `unmeasured()`, which is how JIO-345 and JIO-346 closed
 * the same shape of defect on the automation axis: `buildAxis` averages over
 * MEASURED weight only, so dropping a signal REDISTRIBUTES its weight to the
 * others. On a suspicion axis that is a penalty and the fix works; on this one
 * — the axis that exists to vouch — it would RAISE every tapered bot's
 * authenticity score, which is the opposite of the ask. A signal that reads
 * "reach without depth" has measured something; it must score it low, not
 * decline to look.
 */
function topicalBreadthSignal(profile) {
  const key = 'topical-breadth';
  const label = 'Range of interests';
  const weight = 2;

  const histogram = groupHistogram([...profile.comments, ...profile.posts]);
  const counts = [...histogram.values()];
  const total = counts.reduce((a, b) => a + b, 0);

  if (total < MIN_GROUP_ITEMS) {
    return unmeasured({
      key, label, weight, evidence: `Only ${total} items carry a group — needs at least ${MIN_GROUP_ITEMS}.`,
    });
  }

  const topCount = Math.max(...counts);
  const topShare = topCount / total;
  const outside = 1 - topShare;
  const entropy = normalizedEntropy(counts, Math.max(histogram.size, 2)) ?? 0;

  const reach = clamp01(
    0.5 * rescale(outside, 0.15, 0.75)
    + 0.5 * rescale(histogram.size, 2, REACH_FULL_CREDIT_GROUPS),
  );

  const itemsPerGroup = total / histogram.size;
  const tapered = total >= DEPTH_MIN_ITEMS;
  const rawDepth = rescale(itemsPerGroup, 1, DEPTH_FULL_CREDIT);
  const depth = tapered ? rawDepth : 1;
  const strength = reach * depth;

  // Every bound that fires says so out loud, and that includes the one that
  // WITHHELD a discount: a breadth score has to name what was and was not
  // applied, or the sentence describes a range of interests this signal did
  // not actually credit — or credits one it declined to check. The gate is
  // named only where it CHANGED something; an account past the gate that would
  // have kept full credit anyway has had nothing withheld from it.
  let depthNote;
  if (!tapered && rawDepth < 1) {
    depthNote = ` That is ${itemsPerGroup.toFixed(2)} items per group, but ${total} items is under the ${DEPTH_MIN_ITEMS} it takes to be in ${REACH_FULL_CREDIT_GROUPS} groups ${DEPTH_FULL_CREDIT} deep, so the depth taper would be reading how little history there is rather than how it was spent. It is withheld and the reach is credited in full.`;
  } else if (depth < 1 && itemsPerGroup <= SITEWIDE_ITEMS_PER_GROUP) {
    depthNote = ` That is ${itemsPerGroup.toFixed(2)} items per group — reach without depth, which is what running sitewide looks like rather than what being curious looks like, so the breadth credit is cut to ${pct(depth)} of what the reach alone would score.`;
  } else if (depth < 1) {
    depthNote = ` That is ${itemsPerGroup.toFixed(2)} items per group — the account does go back to what it touches, but short of the ${DEPTH_FULL_CREDIT} that reads as a return rather than a look around, so the breadth credit is cut to ${pct(depth)} of what the reach alone would score.`;
  } else {
    depthNote = ` At ${itemsPerGroup.toFixed(2)} items per group the account returns to what it touches, so the reach is credited in full.`;
  }

  return signal({
    key,
    label,
    weight,
    strength,
    value: {
      distinctGroups: histogram.size, topShare, outsideTopShare: outside, entropy, itemsPerGroup, reach, depth, tapered,
    },
    evidence: `Active in ${histogram.size} ${plural(histogram.size, 'group')} across ${total} items; the largest accounts for ${pct(topShare)}, leaving ${pct(outside)} elsewhere (spread ${entropy.toFixed(2)} of 1.00).${depthNote}`,
  });
}

/**
 * ASKS QUESTIONS — someone who asks for things they do not know.
 *
 * URLS ARE REMOVED FIRST, and that single line is the whole reason this signal
 * means anything (JIO-290, EVALUATION.md Finding 2). The test used to be
 * `body.includes('?')` against the raw body, so every query string counted:
 * u/RemindMeBot scored 100/100 and u/RepostSleuthBot 93/100 without either
 * asking a single question, off `?context=3` and `message/compose/?to=` links
 * in their own boilerplate. Humans drifted 1-2 points, so the suite and every
 * hand-check looked fine — the false positive was shaped exactly like the
 * adversary, on the one axis that exists to VOUCH for people.
 *
 * The help-seeking patterns run over the stripped body too, deliberately: they
 * are English phrases, and a phrase that only occurs inside a link target
 * (`/r/AskDocs/how-do-i-...`) was not said by anyone. Both halves of this
 * signal therefore see the same text — what the author actually typed.
 */
function questionSignal(profile) {
  const key = 'asks-questions';
  const label = 'Asks questions';
  const weight = 1.5;

  const bodies = profile.comments.map((c) => c.body).filter((b) => typeof b === 'string' && b.length);
  if (bodies.length < MIN_COMMENTS) {
    return unmeasured({
      key, label, weight, evidence: `Only ${bodies.length} comments with retrievable text — needs at least ${MIN_COMMENTS}.`,
    });
  }

  let questions = 0;
  let helpSeeking = 0;
  for (const raw of bodies) {
    const body = stripUrls(raw);
    if (body.includes('?')) questions += 1;
    if (HELP_SEEKING_PATTERNS.some((re) => re.test(body))) helpSeeking += 1;
  }

  const share = questions / bodies.length;
  const strength = clamp01(
    0.7 * rescale(share, 0.03, 0.30)
    + 0.3 * rescale(helpSeeking / bodies.length, 0.005, 0.06),
  );

  return signal({
    key,
    label,
    weight,
    strength,
    value: { questions, helpSeeking, sample: bodies.length, share },
    evidence: `${questions} of ${bodies.length} comments (${pct(share)}) ask a question, including ${helpSeeking} that explicitly seek help or admit uncertainty.`,
  });
}

/**
 * ARGUES OFF-SCRIPT — net-downvoted comments inside the account's OWN dominant
 * group. The rarest and best signal in the file: a propaganda account does not
 * take unpopular positions in front of the audience it was created to
 * influence. Doing so costs it the standing it exists to accumulate.
 *
 * Implemented carefully, because it is easy to get wrong in three ways:
 *
 *   * SCORE SEMANTICS. On this platform a comment starts at 1 (your own vote),
 *     so "downvoted" is score <= 0, not score < some average. A hidden score
 *     is null from the source and is excluded from the denominator entirely —
 *     counting hidden as undownvoted would manufacture consensus.
 *
 *   * IT MUST BE THEIR OWN TURF. Being downvoted in a group you visited once
 *     is not courage, it is being an outsider. So it only looks inside a group
 *     that is genuinely dominant, by share AND by absolute sample.
 *
 *   * MORE IS NOT BETTER. Past a point this stops being principled dissent and
 *     starts being an account its own community dislikes, which is not the
 *     same evidence at all. Strength is therefore DAMPED above 35% rather than
 *     saturating, so a troll cannot ride this signal to a vouch.
 *
 * When no dissent is found the direction is pinned to 'neutral' rather than
 * the derived 'lowers': absence of a rare positive is not a mark against
 * anyone, and letting it read as one would quietly punish every ordinary
 * account for not being remarkable.
 */
function offScriptDissentSignal(profile) {
  const key = 'off-script-dissent';
  const label = 'Takes unpopular positions on home turf';
  const weight = 3;

  const withGroup = profile.comments.filter((c) => c.group);
  const histogram = groupHistogram(withGroup);
  if (!histogram.size) {
    return unmeasured({ key, label, weight, evidence: 'No comments carry a group.' });
  }

  const [topGroup, topCount] = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0];
  const topShare = topCount / withGroup.length;

  const scored = withGroup.filter((c) => c.group === topGroup && Number.isFinite(c.score));

  if (topShare < DOMINANT_MIN_SHARE || scored.length < DOMINANT_MIN_SCORED_COMMENTS) {
    return unmeasured({
      key,
      label,
      weight,
      value: { topGroup, topShare, scoredInTopGroup: scored.length },
      evidence: `No group is dominant enough to check for off-script dissent — the largest, "${topGroup}", holds ${pct(topShare)} of comments with ${scored.length} carrying a visible score (needs ${pct(DOMINANT_MIN_SHARE)} and ${DOMINANT_MIN_SCORED_COMMENTS}).`,
    });
  }

  const downvoted = scored.filter((c) => c.score <= 0);
  const share = downvoted.length / scored.length;

  if (downvoted.length === 0) {
    return signal({
      key,
      label,
      weight,
      strength: 0,
      direction: 'neutral',
      value: { topGroup, scored: scored.length, downvoted: 0, share: 0 },
      evidence: `None of the ${scored.length} scored comments in the account's dominant group ("${topGroup}") were net-downvoted. No evidence either way that it will take an unpopular position there.`,
    });
  }

  const damping = 1 - rescale(share, DISSENT_DAMPING_START, DISSENT_DAMPING_END);
  const strength = clamp01((0.3 + 0.7 * rescale(share, 0.005, 0.06)) * damping);

  const worst = downvoted.map((c) => c.score).sort((a, b) => a - b).slice(0, 3);
  const dampingNote = share > DISSENT_DAMPING_START
    ? ' At this rate it reads less like principled dissent and more like an account its own community dislikes, so the signal is discounted.'
    : ' A scripted account does not spend standing this way in front of its own audience.';

  return signal({
    key,
    label,
    weight,
    strength,
    value: { topGroup, scored: scored.length, downvoted: downvoted.length, share, worstScores: worst },
    evidence: `${downvoted.length} of ${scored.length} scored comments (${pct(share)}) in the account's dominant group ("${topGroup}") were net-downvoted, worst at ${worst.join(', ')}.${dampingNote}`,
  });
}
