/**
 * AUTOMATION — is a machine posting this?
 *
 * This axis is about MECHANISM, never about content. That separation is the
 * product thesis: a paid human posting talking points has a real account age,
 * organic timing and varied language, and scores clean on every signal in this
 * file. That is not a bug to be patched by mixing in agenda signals — it is
 * the finding. Blending the axes is what hides the exact case the tool exists
 * to find, so nothing content-shaped belongs here.
 */

import {
  activityOldestFirst,
  commentsOldestFirst,
  reliableActivityOldestFirst,
} from '../sources/profile.js';
import {
  buildAxis, exampleRef, signal, unmeasured,
} from './axis.js';
import {
  clamp01, coefficientOfVariation, formatDate, jaccard, longestZeroRunCircular,
  mean, normalizeWords, normalizedEntropy, pct, plural, ratioPct, rescale, shingles,
} from './stats.js';

const HOURS_IN_DAY = 24;

/** Below this, the hour histogram is too sparse to mean anything. */
const MIN_ITEMS_FOR_HOUR_PROFILE = 24;

/**
 * ...and below this it is too SHORT to mean anything, however many items it
 * holds. A very prolific account returns its per-lookup limit from the last
 * few minutes, and those items necessarily cluster in one or two hours of the
 * day. Verified live 2026-08-05 against an account with 1.59M comments: its
 * newest 299 spanned under an hour and produced a "17 consecutive quiet hours,
 * consistent with a sleep cycle" reading — a perfect human alibi for a bot,
 * manufactured entirely by the fetch window. A sleep cycle is a claim about
 * days, so it needs days.
 */
const MIN_SPAN_DAYS_FOR_HOUR_PROFILE = 3;

/**
 * An hour counts as "quiet" if it holds less than this share of the account's
 * average hour — NOT if it is strictly empty. A prolific human will eventually
 * land one comment in every hour of the day across insomnia, travel and
 * timezone changes, and a strict-zero test would call them a bot for it. What
 * actually distinguishes a person is that their sleep hours stay near-empty
 * *relative to their own volume*.
 */
const QUIET_HOUR_FRACTION = 0.2;

/** A human sleep cycle. At or above this, the dead-zone signal reads clean. */
const HUMAN_DEAD_ZONE_HOURS = 6;

/**
 * The other half of that trade, and the reason this file has two signals
 * reading the same window.
 *
 * `MIN_SPAN_DAYS_FOR_HOUR_PROFILE` is right and must not be weakened, but it
 * hands the loudest bots an exemption from the heaviest check in the axis:
 * the more prolific the account, the shorter the window its per-lookup limit
 * covers, and the more certainly `posting-hour-dead-zone` returns unmeasured
 * (EVALUATION.md Finding 4 — "volume itself buys immunity from the strongest
 * check"). `sustained-posting-rate` is what fills that window, and it can,
 * because THROUGHPUT SURVIVES TRUNCATION WHILE A SCHEDULE DOES NOT. An hour
 * histogram built from 82 seconds of data is measuring our pagination; a rate
 * built from the same 82 seconds is a ratio of two things we genuinely
 * observed, and 297 items in 82 seconds is a fact about the account no matter
 * how much older history we failed to fetch.
 *
 * So the guards here are about having enough items to call it *sustained*
 * rather than about covering enough calendar. 60 seconds is the floor purely
 * so a degenerate window cannot divide by ~zero; AutoModerator's real window
 * is 82 seconds and has to clear it, or this signal is unmeasured for exactly
 * the account it was added for.
 */
const MIN_ITEMS_FOR_RATE = 30;
const MIN_SPAN_SECONDS_FOR_RATE = 60;

/**
 * Below this the account is inside the range a person can sustain, and the
 * signal reports NOTHING — not a low strength. It is deliberately
 * one-directional: an ordinary posting rate is not evidence of a human, it is
 * the absence of evidence of a machine, and every account on the platform has
 * it. Scoring it as a measured zero would hand a clean vote to every patient
 * bot in exchange for a signal that can only ever fire on the loud ones.
 *
 * 3 items/hour is 72 a day sustained across the entire retrieved window,
 * nights included.
 *
 * IT IS NOT A CEILING ON PEOPLE, and the comment that stood here saying "the
 * gate sits in the gap" between the humans and the bots was wrong. A
 * content-blind sweep of 22 subreddits found seven accounts above it and SIX
 * OF THE SEVEN hand-read as people, topping out at 5.90/h — above
 * u/RemindMeBot's 5.5/h, the slowest bot this was added for (EVALUATION.md
 * Finding 4a). The two populations overlap, so no value of this constant
 * separates them: raising it to 6 silences RemindMeBot and still measures the
 * human. There is no gap and there is nothing to sit in.
 *
 * What keeps a prolific person `low` is the SHAPE of this signal rather than
 * the position of this number — one-directional, floored at
 * `RATE_FLOOR_STRENGTH`, log-scaled to `SATURATED_ITEMS_PER_HOUR`, and weight
 * 2 of 18.5. The 5.90/h human earns strength 0.573, i.e. 0.073 above neutral,
 * and scores automation `low 14`. So this is the threshold at which throughput
 * becomes worth WEIGHING, not the throughput at which an account becomes a
 * machine, and moving it is not the lever it looks like. u/humdingler (5.90/h)
 * and u/chilidirigible (3.42/h) are frozen in `test/corpus/` so that stops
 * being an assurance and starts being a test.
 */
const ORDINARY_ITEMS_PER_HOUR = 3;

/** One item every 12 seconds, sustained. Nothing above this scores differently. */
const SATURATED_ITEMS_PER_HOUR = 300;

/**
 * What `ORDINARY_ITEMS_PER_HOUR` itself scores. Not 0: a measured strength
 * below 0.25 reads as `direction: 'lowers'` in axis.js and drags the weighted
 * average down, which is the vote for a person this signal is not allowed to
 * cast. The measured range therefore starts at neutral and only ever climbs.
 *
 * Shared by every one-directional signal in this axis — clock-alignment and
 * template-structure fire past an "ordinary" floor exactly the way the rate
 * does, and a barely-past-the-floor measurement scoring ~0 would cast the
 * same forbidden vote.
 */
const RATE_FLOOR_STRENGTH = 0.5;

function oneDirectionalStrength(fraction) {
  return RATE_FLOOR_STRENGTH + (1 - RATE_FLOOR_STRENGTH) * clamp01(fraction);
}

const MIN_INTERVALS = 10;

/**
 * The two ends of the cadence scale `interval-regularity` reads, named because
 * the second one is now a gate and not only a ceiling (JIO-346).
 *
 * At or below `MECHANICAL_INTERVAL_CV` the gaps are a scheduler's. At or above
 * `HUMANLIKE_INTERVAL_CV` the arithmetic already had nothing left to say —
 * `rescale` clamps, so every CV from 1.0 to infinity produced the identical
 * strength 0.000. The gate is therefore the point the scale itself stops at,
 * not a number picked next to a population.
 */
const MECHANICAL_INTERVAL_CV = 0.15;
const HUMANLIKE_INTERVAL_CV = 1.0;
const MIN_COMMENTS_FOR_LENGTH = 10;

const BURST_GAP_SECONDS = 120;
const BURST_MIN_SIZE = 3;
const BURST_MIN_DISTINCT_THREAD_RATIO = 0.75;

const DUPLICATE_SHINGLE_SIZE = 3;
const DUPLICATE_MIN_WORDS = 6;
const DUPLICATE_JACCARD = 0.55;
/** Pairwise comparison is O(n^2); 200 newest keeps a badge render instant. */
const DUPLICATE_MAX_COMPARED = 200;

/** At or below this share of replies, the account is broadcasting, not talking. */
const BROADCAST_REPLY_SHARE = 0.02;
/** ...and by this share the signal has spent its argument and reads zero. */
const CONVERSATIONAL_REPLY_SHARE = 0.3;

/**
 * Clock alignment (JIO-428). A scheduler fires at a fixed second of its minute
 * or minute of its hour; a person's timestamps are uniform mod 60. Needs
 * enough items that a spike cannot be luck: with 60 items over 60 buckets the
 * expected count per bucket is 1, and the chance of any bucket reaching 15% of
 * the sample by coincidence is far below 1%.
 *
 * ONE-DIRECTIONAL, like sustained-posting-rate and for the same reason: an
 * ordinary spread of seconds is what everyone has — person, summon-bot and
 * burst-bot alike — so it is the absence of evidence of a scheduler, not
 * evidence of a person, and scoring it would hand every event-driven bot a
 * vote for its own humanity. Below the floor this signal reports nothing.
 */
const MIN_ITEMS_FOR_CLOCK = 60;
const CLOCK_BUCKETS = 60;
const CLOCK_ORDINARY_TOP_SHARE = 0.15;
const CLOCK_SATURATED_TOP_SHARE = 0.7;

/**
 * Template structure (JIO-429). `near-duplicate-bodies` shingles over WORDS,
 * so a template with heavy variable fill — quoted titles, injected names, a
 * different link every time — can slip under the Jaccard threshold while its
 * SKELETON (same lines, same links-per-line, same rules and bullets) is
 * identical in every comment. This reads the skeleton.
 *
 * Guards, because ordinary prose must be invisible to it: only comments with
 * REAL structure participate (three-plus lines, two-plus links, or quote/
 * bullet/heading/rule furniture), the winning skeleton must itself contain a
 * non-plain-text element (every three-paragraph plain comment shares a
 * skeleton, and that shape means nothing), and below the firing floor it is
 * one-directional unmeasured — varied structure is what writing looks like,
 * not evidence of a person.
 *
 * A SINGLE LINE WITH A SINGLE LINK IS NOT A SCAFFOLD, and that is a live
 * finding rather than a precaution: the first cut counted it, and on a live
 * re-fetch of 2026-09-07 u/chilidirigible — the prolific human JIO-344 froze
 * precisely so this class of change would have to face them — had 65 of 125
 * formatted comments reading skeleton "t1", one line, one link. "Here's the
 * source: [link]" is among the most ordinary comment shapes a person
 * produces, and it took their automation to `moderate 30`: a human crossed a
 * band. Such comments now have no scaffold at all — they are excluded from
 * the numerator AND the denominator, not merely barred from winning, because
 * leaving them in the denominator would let a hundred ordinary link-drops
 * dilute a real template below the firing floor.
 */
const MIN_STRUCTURED_COMMENTS = 10;
const STRUCTURE_ORDINARY_TOP_SHARE = 0.4;
const STRUCTURE_SATURATED_TOP_SHARE = 0.9;
const STRUCTURE_MAX_LINKS_PER_LINE = 3;

export function scoreAutomation(profile) {
  return buildAxis([
    postingHourSignal(profile),
    sustainedRateSignal(profile),
    intervalRegularitySignal(profile),
    burstSignal(profile),
    lengthUniformitySignal(profile),
    karmaVelocitySignal(profile),
    duplicateBodySignal(profile),
    conversationDepthSignal(profile),
    clockAlignmentSignal(profile),
    templateStructureSignal(profile),
  ]);
}

/**
 * Posting-hour dead zone. The single strongest signal available and weighted
 * accordingly: humans sleep, and a real account has a 6-8 hour stretch where
 * essentially nothing happens. No dead zone at all is very hard to fake by
 * accident and very easy to produce with a cron job.
 *
 * The dead zone is measured CIRCULARLY (22:00-06:00 is one 8-hour gap, not two
 * short ones) and the entropy term only ever pushes the score UP. That is what
 * keeps a night-shift worker — whose hours are concentrated and whose entropy
 * is therefore LOW — from being scored as automated for the crime of having an
 * unusual schedule.
 */
function postingHourSignal(profile) {
  const key = 'posting-hour-dead-zone';
  const label = 'Round-the-clock posting';
  const weight = 3;

  // The reliable window, not the raw timeline: a single ancient post merged
  // against a shallow comment window would otherwise stretch the measured
  // span across years and defeat the span guard below.
  const timeline = reliableActivityOldestFirst(profile);
  if (timeline.length < MIN_ITEMS_FOR_HOUR_PROFILE) {
    return unmeasured({
      key,
      label,
      weight,
      evidence: `Only ${timeline.length} timestamped ${plural(timeline.length, 'item')} — needs at least ${MIN_ITEMS_FOR_HOUR_PROFILE} before an hour-of-day profile means anything.`,
    });
  }

  const spanDays = (timeline[timeline.length - 1].createdUtc - timeline[0].createdUtc) / 86400;
  if (spanDays < MIN_SPAN_DAYS_FOR_HOUR_PROFILE) {
    return unmeasured({
      key,
      label,
      weight,
      value: { spanDays },
      evidence: `The ${timeline.length} retrieved items span only ${spanDays < 1 ? `${Math.round(spanDays * 24)} hours` : `${spanDays.toFixed(1)} days`} — far too short a window to tell a sleep cycle from the time of day we happened to look. Needs at least ${MIN_SPAN_DAYS_FOR_HOUR_PROFILE} days.`,
    });
  }

  const hours = new Array(HOURS_IN_DAY).fill(0);
  for (const item of timeline) {
    hours[new Date(item.createdUtc * 1000).getUTCHours()] += 1;
  }

  const avgPerHour = mean(hours);
  const quietThreshold = avgPerHour * QUIET_HOUR_FRACTION;
  const activityMask = hours.map((count) => (count > quietThreshold ? count : 0));
  const deadZone = longestZeroRunCircular(activityMask);
  const entropy = normalizedEntropy(hours, HOURS_IN_DAY);

  const deadZoneComponent = 1 - rescale(deadZone.length, 0, HUMAN_DEAD_ZONE_HOURS);
  const entropyComponent = rescale(entropy, 0.85, 0.98) ?? 0;
  const strength = clamp01(0.7 * deadZoneComponent + 0.3 * entropyComponent);

  const evidence = deadZone.length === 0
    ? `Active in all ${HOURS_IN_DAY} UTC hours with no quiet stretch at all across ${timeline.length} items (hour entropy ${entropy.toFixed(2)} of 1.00). Human accounts almost always show a 6-8 hour sleep gap.`
    : `Longest quiet stretch is ${deadZone.length} consecutive UTC ${plural(deadZone.length, 'hour')} starting ${String(deadZone.start).padStart(2, '0')}:00, across ${timeline.length} items (hour entropy ${entropy.toFixed(2)} of 1.00).${deadZone.length >= HUMAN_DEAD_ZONE_HOURS ? ' That is consistent with a sleep cycle.' : ''}`;

  return signal({
    key,
    label,
    weight,
    strength,
    value: { deadZoneHours: deadZone.length, deadZoneStartHour: deadZone.start, hourEntropy: entropy, hours },
    evidence,
  });
}

/**
 * Sustained posting rate — items per hour across the reliable window.
 *
 * Complementary to `cross-thread-bursts` rather than a duplicate of it: a
 * burst is a run of items inside 120 seconds and says nothing about the other
 * 23 hours, while this is the average over the whole window and is diluted by
 * every quiet stretch in it. An account that drains a queue once a day scores
 * on bursts and not here; an account that never stops scores here.
 *
 * It is also NOT `interval-regularity`. CV is unitless on purpose and reports
 * only whether a rhythm is mechanical, so a summon-driven bot posting as
 * irregularly as the humans summoning it reads clean there. This asks the
 * question CV deliberately refuses: not how evenly, but how much.
 *
 * Weighted below `posting-hour-dead-zone` (3) because it is the weaker claim
 * of the two — a schedule with no sleep in it is hard to produce by accident,
 * whereas throughput is only ever an argument from volume.
 */
function sustainedRateSignal(profile) {
  const key = 'sustained-posting-rate';
  const label = 'Sustained posting throughput';
  const weight = 2;

  const timeline = reliableActivityOldestFirst(profile);
  if (timeline.length < MIN_ITEMS_FOR_RATE) {
    return unmeasured({
      key,
      label,
      weight,
      evidence: `Only ${timeline.length} timestamped ${plural(timeline.length, 'item')} in the reliable window — needs at least ${MIN_ITEMS_FOR_RATE} before a rate is more than a coincidence.`,
    });
  }

  const spanSeconds = timeline[timeline.length - 1].createdUtc - timeline[0].createdUtc;
  if (spanSeconds < MIN_SPAN_SECONDS_FOR_RATE) {
    return unmeasured({
      key,
      label,
      weight,
      value: { items: timeline.length, spanSeconds },
      evidence: `The ${timeline.length} retrieved items span under ${MIN_SPAN_SECONDS_FOR_RATE} seconds, which is too short to divide by.`,
    });
  }

  const perHour = timeline.length / (spanSeconds / 3600);
  const value = { itemsPerHour: perHour, items: timeline.length, spanSeconds };
  const measured = `${timeline.length} items in ${formatSpan(spanSeconds)} is ${formatRate(perHour)} an hour`;

  if (perHour < ORDINARY_ITEMS_PER_HOUR) {
    return unmeasured({
      key,
      label,
      weight,
      value,
      evidence: `${measured}, below the ${ORDINARY_ITEMS_PER_HOUR} an hour at which this signal begins to weigh throughput at all. Accounts of every kind sit here, so it says nothing about this account either way — it is not a clean result on the automation axis.`,
    });
  }

  const strength = oneDirectionalStrength(rescale(
    Math.log10(perHour),
    Math.log10(ORDINARY_ITEMS_PER_HOUR),
    Math.log10(SATURATED_ITEMS_PER_HOUR),
  ));

  return signal({
    key,
    label,
    weight,
    strength,
    value,
    // NOT "more than a person keeps up", which is what this said until
    // EVALUATION.md Finding 4a found six live accounts over this gate that
    // hand-read as people. The string is printed ON THE ACCOUNT BEING JUDGED,
    // so it may describe the account and the weighing, and may not make a
    // claim about what human beings are capable of — see the guard in
    // test/scoring.test.js.
    evidence: `${measured}, sustained across the whole retrieved window — above the ${ORDINARY_ITEMS_PER_HOUR} an hour at which this signal begins to weigh throughput at all. Throughput at this level is uncommon and is weighed as such, not taken on its own as proof of automation. This is a claim about throughput and not about schedule: it counts how much the account produced, not when.`,
  });
}

/**
 * Cadence regularity. Machine posting is too EVEN — a scheduler produces gaps
 * with a low coefficient of variation, while a person posts in clumps around
 * their day. CV is unitless, so this says nothing about whether the account is
 * fast or slow, only whether the rhythm is mechanical.
 *
 * ONE POLE, NOT TWO (JIO-346), for the same reason `conversation-depth` has
 * one (JIO-345). An even cadence is evidence of a scheduler; an UNEVEN cadence
 * is not evidence of a person, because a summon-driven bot does not own its
 * own rhythm — it inherits the irregularity of whoever summoned it.
 * u/RemindMeBot posts when people ask it to, so it measured CV 1.26 live (1.09
 * in the frozen window — both above the ceiling) and was told, at weight 2,
 * *"that is the irregular, clumpy spacing typical of a person"*. EVALUATION.md Finding 4 named that as the second of the three
 * reasons declared bots topped out at `moderate`; Finding 4e measured it.
 *
 * WHY THE GATE SITS AT `HUMANLIKE_INTERVAL_CV` AND IS NOT A CHOSEN NUMBER.
 * `rescale(cv, 0.15, 1.0)` clamps at its ceiling, so a CV of 1.0 and a CV of
 * 16.1 both produced **strength exactly 0.000** — the largest vote for
 * humanity this signal can cast, handed out identically to a bot and to a
 * person. Measured by `node scripts/measure-interval-cv.mjs` over the 27
 * frozen accounts, 26 of them sit at or above 1.0: all 19 humans (1.53 to
 * 5.29) AND seven of the eight declared bots (1.08 to 16.09). A signal that
 * scores the adversary and the person it exists to tell apart with the same
 * number is not measuring either of them, so this end returns `unmeasured()`
 * rather than a clean zero — axis.js rule 3, applied to a POLE.
 *
 * WHY THIS AND NOT RESPONSE LATENCY. The alternative on the ticket was to
 * measure the gap from a parent comment to this account's reply, which is a
 * rhythm the account DOES own. It is buildable — probed live 2026-08-21,
 * `/api/comments/ids` returns `created_utc` 120 ids at a time and all 299 of
 * u/RemindMeBot's parents are comments — but it needs a new `AccountProfile`
 * field, a second fetch pass in `arcticShift.js` and a re-capture of all 27
 * frozen profiles before `npm run evaluate` could measure it, and PLATFORMS.md
 * ("If this is picked up", condition 1) forbids feeding this signal family
 * from a payload whose contiguity cannot be proven. Parent timestamps arrive by id lookup with no
 * window guarantee at all, so that is not a detail to be worked around later.
 * It is a different ticket if it is ever worth one.
 *
 * THE MECHANICAL POLE IS UNTOUCHED, and it is the half that separates. Below
 * 1.0 the strength climbs to a full-weight 1.0 at CV 0.15, and
 * u/sub_doesnt_exist_bot (CV 0.94) is the one frozen account still measured
 * here.
 *
 * THE BOUND, OUT LOUD. This signal now says nothing at all about 26 of the 27
 * frozen accounts, which is 2 of the axis's 15.5 weight going quiet for very
 * nearly everybody — a real loss of coverage, not a free fix. It is the honest
 * reading of what was already there: those 26 scores were the same 0.000
 * whatever the account was.
 */
function intervalRegularitySignal(profile) {
  const key = 'interval-regularity';
  const label = 'Mechanical posting rhythm';
  const weight = 2;

  const comments = commentsOldestFirst(profile);
  const intervals = [];
  for (let i = 1; i < comments.length; i += 1) {
    intervals.push(comments[i].createdUtc - comments[i - 1].createdUtc);
  }

  if (intervals.length < MIN_INTERVALS) {
    return unmeasured({
      key,
      label,
      weight,
      evidence: `Only ${intervals.length} ${plural(intervals.length, 'gap')} between comments — needs at least ${MIN_INTERVALS} to judge a rhythm.`,
    });
  }

  const cv = coefficientOfVariation(intervals);
  if (cv == null) {
    return unmeasured({
      key, label, weight, evidence: 'Comment timestamps do not support an interval calculation.',
    });
  }

  const value = { coefficientOfVariation: cv, intervals: intervals.length };

  if (cv >= HUMANLIKE_INTERVAL_CV) {
    return unmeasured({
      key,
      label,
      weight,
      value,
      evidence: `Gaps between consecutive comments vary by ${ratioPct(cv)} of their average (CV ${cv.toFixed(2)}) over ${intervals.length} intervals — an uneven cadence, which this signal cannot read. A bot that works on demand inherits its irregularity from the people summoning it, so an uneven rhythm does not separate it from a person, and it is not a clean result on the automation axis. What this signal can read is the opposite pole: a cadence too even to be anyone's day.`,
    });
  }

  const strength = 1 - rescale(cv, MECHANICAL_INTERVAL_CV, HUMANLIKE_INTERVAL_CV);

  return signal({
    key,
    label,
    weight,
    strength,
    value,
    evidence: `Gaps between consecutive comments vary by ${ratioPct(cv)} of their average (CV ${cv.toFixed(2)}) over ${intervals.length} intervals. ${cv < 0.4 ? 'Human posting is far lumpier than this.' : `This signal measures distance from the mechanical pole and nothing else — a scheduler runs at a CV near ${MECHANICAL_INTERVAL_CV} — so a cadence looser than that is the absence of that evidence rather than evidence of a person.`}`,
  });
}

/**
 * Bursts across DIFFERENT threads. One person arguing hard replies quickly, but
 * within one conversation; a run of comments seconds apart in unrelated threads
 * is a queue being drained. Requiring the threads to differ is what keeps a
 * heated back-and-forth from scoring as a bot.
 */
function burstSignal(profile) {
  const key = 'cross-thread-bursts';
  const label = 'Bursts across unrelated threads';
  const weight = 2;

  const comments = commentsOldestFirst(profile);
  if (comments.length < BURST_MIN_SIZE * 2) {
    return unmeasured({
      key, label, weight, evidence: `Only ${comments.length} timestamped comments — too few to detect burst posting.`,
    });
  }

  let burstComments = 0;
  let largestBurst = 0;
  let largestBurstSpan = null;
  let largestBurstExample = null;
  let run = [comments[0]];

  const closeRun = () => {
    if (run.length >= BURST_MIN_SIZE) {
      const threads = new Set(run.map((c) => c.threadId ?? c.id));
      if (threads.size / run.length >= BURST_MIN_DISTINCT_THREAD_RATIO && threads.size >= BURST_MIN_SIZE) {
        burstComments += run.length;
        if (run.length > largestBurst) {
          largestBurst = run.length;
          largestBurstSpan = {
            seconds: run[run.length - 1].createdUtc - run[0].createdUtc,
            threads: threads.size,
            at: run[0].createdUtc,
          };
          largestBurstExample = exampleRef('comment', run[0]);
        }
      }
    }
    run = [];
  };

  for (let i = 1; i < comments.length; i += 1) {
    if (comments[i].createdUtc - comments[i - 1].createdUtc <= BURST_GAP_SECONDS) {
      run.push(comments[i]);
    } else {
      closeRun();
      run = [comments[i]];
    }
  }
  closeRun();

  const share = burstComments / comments.length;
  const strength = rescale(share, 0.02, 0.35);

  return signal({
    key,
    label,
    weight,
    strength,
    value: {
      burstComments, share, largestBurst, largestBurstSpan, example: largestBurstExample,
    },
    evidence: largestBurst
      ? `${burstComments} of ${comments.length} comments (${pct(share)}) fall in rapid bursts across unrelated threads — the largest was ${largestBurst} comments in ${largestBurstSpan.threads} different threads within ${largestBurstSpan.seconds} seconds on ${formatDate(largestBurstSpan.at)}.`
      : `No runs of ${BURST_MIN_SIZE}+ comments within ${BURST_GAP_SECONDS}s across unrelated threads.`,
  });
}

/**
 * Length uniformity. Templated output is uniform in a way written comments are
 * not — a person writes "lol" and then four paragraphs.
 */
function lengthUniformitySignal(profile) {
  const key = 'length-uniformity';
  const label = 'Uniform comment length';
  const weight = 1.5;

  const lengths = profile.comments
    .map((c) => (typeof c.body === 'string' ? c.body.trim().length : null))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (lengths.length < MIN_COMMENTS_FOR_LENGTH) {
    return unmeasured({
      key, label, weight, evidence: `Only ${lengths.length} comments with retrievable text — needs at least ${MIN_COMMENTS_FOR_LENGTH}.`,
    });
  }

  const cv = coefficientOfVariation(lengths);
  if (cv == null) {
    return unmeasured({ key, label, weight, evidence: 'Comment lengths do not support a variance calculation.' });
  }

  const strength = 1 - rescale(cv, 0.15, 0.7);
  const avg = Math.round(mean(lengths));

  return signal({
    key,
    label,
    weight,
    strength,
    value: { coefficientOfVariation: cv, meanLength: avg, sample: lengths.length },
    evidence: `Comment length averages ${avg} characters and varies by ${ratioPct(cv)} of that (CV ${cv.toFixed(2)}) across ${lengths.length} comments. ${cv < 0.35 ? 'That is unusually uniform, as templated output tends to be.' : 'That is the wide spread of ordinary writing.'}`,
  });
}

/**
 * Karma per day of account age.
 *
 * DELIBERATELY THE LOWEST-WEIGHTED SIGNAL IN THE AXIS, because it is the
 * weakest: one post to the front page gives a real person a velocity no
 * script would bother to match, and a patient bot can sit well under any
 * threshold. It is here for corroboration only, and its evidence string says
 * so rather than implying more than it knows.
 */
function karmaVelocitySignal(profile) {
  const key = 'karma-velocity';
  const label = 'Karma accumulation rate';
  const weight = 1;

  const total = profile.karma.total;
  const ageDays = profile.accountAgeDays;

  if (!Number.isFinite(total) || !Number.isFinite(ageDays) || ageDays < 1) {
    return unmeasured({
      key, label, weight, evidence: 'No karma total or account age available from the source.',
    });
  }

  const velocity = total / ageDays;
  const strength = rescale(Math.log10(Math.max(velocity, 1)), Math.log10(100), Math.log10(3000));

  return signal({
    key,
    label,
    weight,
    strength,
    value: { karmaPerDay: velocity, totalKarma: total, accountAgeDays: ageDays },
    evidence: `${Math.round(total).toLocaleString('en-US')} karma over ${Math.round(ageDays)} days is ${velocity.toFixed(1)} per day. This is weak evidence on its own — a single popular post produces the same number.`,
  });
}

/**
 * Near-duplicate bodies via word-shingle Jaccard. Shingles are order-sensitive,
 * so this catches a reused template rather than merely a repeated topic — two
 * comments about the same subject share vocabulary but not word sequences.
 */
function duplicateBodySignal(profile) {
  const key = 'near-duplicate-bodies';
  const label = 'Repeated near-identical text';
  const weight = 2.5;

  const docs = profile.comments
    .slice(0, DUPLICATE_MAX_COMPARED)
    .map((c) => ({ id: c.id, src: c, words: normalizeWords(c.body) }))
    .filter((d) => d.words.length >= DUPLICATE_MIN_WORDS)
    .map((d) => ({ ...d, set: shingles(d.words, DUPLICATE_SHINGLE_SIZE) }))
    .filter((d) => d.set.size > 0);

  if (docs.length < MIN_COMMENTS_FOR_LENGTH) {
    return unmeasured({
      key, label, weight, evidence: `Only ${docs.length} comments long enough to compare (${DUPLICATE_MIN_WORDS}+ words) — needs at least ${MIN_COMMENTS_FOR_LENGTH}.`,
    });
  }

  const duplicated = new Set();
  let maxSimilarity = 0;
  let example = null;
  let firstDuplicate = null;

  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const score = jaccard(docs[i].set, docs[j].set);
      if (score > maxSimilarity) {
        maxSimilarity = score;
        example = [docs[i], docs[j]];
      }
      if (score >= DUPLICATE_JACCARD) {
        if (!firstDuplicate) firstDuplicate = docs[i];
        duplicated.add(docs[i].id ?? i);
        duplicated.add(docs[j].id ?? j);
      }
    }
  }

  const share = duplicated.size / docs.length;
  const strength = rescale(share, 0.03, 0.35);

  return signal({
    key,
    label,
    weight,
    strength,
    value: {
      duplicated: duplicated.size,
      compared: docs.length,
      share,
      maxSimilarity,
      example: firstDuplicate ? exampleRef('comment', firstDuplicate.src) : null,
    },
    evidence: duplicated.size
      ? `${duplicated.size} of ${docs.length} compared comments (${pct(share)}) are near-duplicates of another comment by the same account (peak similarity ${maxSimilarity.toFixed(2)}), e.g. "${snippet(example[0].words)}".`
      : `No near-duplicate comments among the ${docs.length} compared (peak similarity ${maxSimilarity.toFixed(2)}, threshold ${DUPLICATE_JACCARD}).`,
  });
}

/**
 * Conversation depth. An account that only ever drops top-level comments and
 * never replies to another commenter is not having conversations — it is
 * broadcasting. `isTopLevel` is resolved by the source adapter, so this stays
 * platform-neutral.
 *
 * ONE POLE, NOT TWO (JIO-345). Never replying is evidence of a machine; the
 * absence of that is not evidence of a person, and this signal used to cast it
 * as one. `strength = 1 - rescale(replyShare, …)` handed u/RemindMeBot — which
 * replies to a summoning commenter 100% of the time and does nothing else at
 * all — a full-weight vote for humanity, produced by the exact mechanism that
 * makes it a bot. EVALUATION.md Finding 4 lists that inversion as one of three
 * reasons seven of eight declared bots top out at `moderate`, and Finding 4b
 * measured the identity underneath it: this signal reads **0.000 for ordinary
 * people AND 0.000 for u/RemindMeBot**. A signal that scores the adversary and
 * the person it is meant to tell apart identically is not measuring either.
 *
 * So the top of the range returns `unmeasured()` rather than a clean zero —
 * axis.js rule 3, applied to a POLE of a measurement rather than to a sample
 * that was too thin. The broadcast pole is untouched: it separates, and
 * u/AmputatorBot (21.7% replies), u/AutoModerator (8.4%) and u/RepostSleuthBot
 * (8.0%) all sit below every human in the corpus and are read there.
 *
 * WHERE THE CUT IS, AND WHY IT IS A FACT RATHER THAN A THRESHOLD. Measured
 * over the 27 frozen accounts by `node scripts/measure-reply-share.mjs`, no
 * network: the five reply-bots sit at exactly 100.0% (299/299 and 300/300) and
 * the 19 humans run from u/Hartacus at 40.0% up to u/MundaneFacts at 99.0%.
 * The entire job is separating 99.0% from 100.0% — a margin of THREE COMMENTS
 * in 300 — and a percentile drawn off a 19-point distribution would not
 * survive the twentieth human. The cut is therefore categorical: NO top-level
 * comment anywhere in the retrieved window. That is a property of the window
 * rather than a number somebody picked, and it is the one value in this
 * distribution that is not standing inside the margin.
 *
 * THE BOUND, OUT LOUD. A reply-bot that drops a single top-level comment in
 * 300 escapes this and still collects its zero. Closing that needs a threshold
 * inside a three-comment margin next to a real account, which is the shape
 * this repo keeps finding on the wrong side of. And below the cut the discount
 * is untouched — an ordinary reply rate still votes for a person at full
 * weight. Withdrawing THAT is JIO-329, 3.5 of 15.5 weight together with
 * `interval-regularity`, and it has a measured cost on real people that this
 * change deliberately does not pay: EVALUATION.md Finding 4b crossed seven
 * live accounts into `moderate`, u/chilidirigible among them.
 */
function conversationDepthSignal(profile) {
  const key = 'conversation-depth';
  const label = 'Never replies to replies';
  const weight = 1.5;

  const known = profile.comments.filter((c) => typeof c.isTopLevel === 'boolean');
  if (known.length < MIN_COMMENTS_FOR_LENGTH) {
    return unmeasured({
      key, label, weight, evidence: `Only ${known.length} comments carry thread-position data — needs at least ${MIN_COMMENTS_FOR_LENGTH}.`,
    });
  }

  const replies = known.filter((c) => !c.isTopLevel).length;
  const topLevel = known.length - replies;
  const replyShare = replies / known.length;
  const value = {
    replies, topLevel, sample: known.length, replyShare,
  };

  if (topLevel === 0) {
    return unmeasured({
      key,
      label,
      weight,
      value,
      evidence: `Every one of the ${known.length} retrieved comments is a reply to another commenter and not one is top-level. A summon-bot replies to everything by definition, and so does a person who only ever joins threads already underway, so this measurement cannot tell those two apart — it is not a clean result on the automation axis. The thing this signal can read is the opposite pole: an account that never replies at all.`,
    });
  }

  const strength = 1 - rescale(replyShare, BROADCAST_REPLY_SHARE, CONVERSATIONAL_REPLY_SHARE);

  return signal({
    key,
    label,
    weight,
    strength,
    value,
    evidence: replies === 0
      ? `All ${known.length} comments are top-level responses to a submission; the account has never replied to another commenter.`
      : `${replies} of ${known.length} comments (${pct(replyShare)}) are replies to other commenters rather than top-level drops. This signal measures distance from the broadcast pole and nothing else — at or below ${pct(BROADCAST_REPLY_SHARE)} replies an account is broadcasting rather than talking — so a rate above that is the absence of that evidence rather than evidence of a person.`,
  });
}

/**
 * Clock alignment — see the constants block for the design. Both granularities
 * are checked and the stronger one reported: second-of-minute catches a
 * per-minute or fixed-offset scheduler, minute-of-hour an hourly one.
 *
 * Per-item and window-independent on purpose: which second of its minute a
 * comment landed on is a fact about that comment no matter how much history
 * the fetch missed, so this uses the whole timestamped timeline the way
 * sustained-posting-rate gets to use raw throughput — truncation cannot forge
 * it. (A burst spraying 300 items over 82 seconds spreads them across all 60
 * seconds and reads as ordinary here; the burst signal is where that shape is
 * scored.)
 */
function clockAlignmentSignal(profile) {
  const key = 'clock-alignment';
  const label = 'Posts on a clock boundary';
  const weight = 1.5;

  const timeline = activityOldestFirst(profile);
  if (timeline.length < MIN_ITEMS_FOR_CLOCK) {
    return unmeasured({
      key,
      label,
      weight,
      evidence: `Only ${timeline.length} timestamped ${plural(timeline.length, 'item')} — needs at least ${MIN_ITEMS_FOR_CLOCK} before a clock-alignment spike can be told from luck.`,
    });
  }

  const granularities = [
    { name: 'second of its minute', unit: 'second', of: (t) => t % CLOCK_BUCKETS },
    { name: 'minute of its hour', unit: 'minute', of: (t) => Math.floor(t / 60) % CLOCK_BUCKETS },
  ];

  let top = null;
  for (const g of granularities) {
    const buckets = new Array(CLOCK_BUCKETS).fill(0);
    for (const item of timeline) buckets[g.of(item.createdUtc)] += 1;
    const max = Math.max(...buckets);
    const share = max / timeline.length;
    if (!top || share > top.share) {
      top = { granularity: g.name, unit: g.unit, bucket: buckets.indexOf(max), count: max, share };
    }
  }

  const value = { ...top, items: timeline.length };

  if (top.share < CLOCK_ORDINARY_TOP_SHARE) {
    return unmeasured({
      key,
      label,
      weight,
      value,
      evidence: `The busiest ${top.unit} holds ${top.count} of ${timeline.length} items (${pct(top.share)}), an ordinary spread. Everyone's timestamps look like this — person, summon-bot and burst-bot alike — so it says nothing about this account either way; only a scheduler-shaped spike would.`,
    });
  }

  const strength = oneDirectionalStrength(rescale(top.share, CLOCK_ORDINARY_TOP_SHARE, CLOCK_SATURATED_TOP_SHARE));

  const inBucket = top.unit === 'second'
    ? (t) => t % CLOCK_BUCKETS === top.bucket
    : (t) => Math.floor(t / 60) % CLOCK_BUCKETS === top.bucket;
  const exemplar = timeline.find((item) => inBucket(item.createdUtc));

  return signal({
    key,
    label,
    weight,
    strength,
    value: { ...value, example: exemplar ? exampleRef(exemplar.kind, exemplar) : null },
    evidence: `${top.count} of ${timeline.length} items (${pct(top.share)}) land on the same ${top.granularity} (:${String(top.bucket).padStart(2, '0')}), where an even spread would put ${Math.round(timeline.length / CLOCK_BUCKETS)} there. Timestamps aligned to a clock boundary are how a scheduler posts and not how typing does.`,
  });
}

/**
 * The structural skeleton of one body: one token per non-empty line — its kind
 * (quote, bullet/numbered, heading, horizontal rule, plain text) plus its
 * markdown-link count, capped so a footer with six links and one with seven
 * read as the same furniture.
 */
function structureSkeleton(body) {
  if (typeof body !== 'string') return { skeleton: '', lines: 0, links: 0 };
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  let links = 0;
  const tokens = lines.map((line) => {
    const linkCount = Math.min((line.match(/\]\(/g) || []).length, STRUCTURE_MAX_LINKS_PER_LINE);
    links += linkCount;
    let kind = 't';
    if (/^(?:&gt;|>)/.test(line)) kind = 'q';
    else if (/^(?:[-*+]\s|\\?#?\d+[.:)]\s?|\\#)/.test(line)) kind = 'b';
    else if (/^#{1,6}\s/.test(line)) kind = 'h';
    else if (/^(?:[-*_]\s*){3,}$/.test(line)) kind = 'r';
    return kind + linkCount;
  });
  return { skeleton: tokens.join('|'), lines: lines.length, links };
}

/** Does a skeleton contain anything beyond plain unlinked text lines? */
function skeletonHasFurniture(skeleton) {
  return /[qbhr]|t[1-9]/.test(skeleton);
}

function templateStructureSignal(profile) {
  const key = 'template-structure';
  const label = 'Identical comment scaffolding';
  const weight = 1.5;

  const structured = profile.comments
    .slice(0, DUPLICATE_MAX_COMPARED)
    .map((c) => ({ ...structureSkeleton(c.body), src: c }))
    .filter((s) => s.lines >= 3 || s.links >= 2
      || (s.lines >= 2 && skeletonHasFurniture(s.skeleton)));

  if (structured.length < MIN_STRUCTURED_COMMENTS) {
    return unmeasured({
      key,
      label,
      weight,
      evidence: `Only ${structured.length} ${plural(structured.length, 'comment')} carry enough formatting to have a scaffold at all — needs at least ${MIN_STRUCTURED_COMMENTS}. Plain prose has no scaffold to compare, which says nothing about this account either way.`,
    });
  }

  const counts = new Map();
  for (const s of structured) {
    const entry = counts.get(s.skeleton) ?? { count: 0, lines: s.lines, links: s.links };
    entry.count += 1;
    counts.set(s.skeleton, entry);
  }
  // Only a genuinely multi-part scaffold can win. Furniture alone is not
  // enough: every three-paragraph plain comment shares "t0|t0|t0", and every
  // quote-then-reply shares "q0|t0" — both are just what writing looks like.
  // A template is a scaffold with parts: three-plus lines or two-plus links,
  // AND something in it beyond plain text.
  const qualifying = [...counts.entries()].filter(([skeleton, meta]) => skeletonHasFurniture(skeleton)
    && (meta.lines >= 3 || meta.links >= 2));
  const top = qualifying.length ? qualifying.reduce((a, b) => (b[1].count > a[1].count ? b : a)) : null;
  const share = top ? top[1].count / structured.length : 0;
  const value = top
    ? { topSkeleton: top[0], repeated: top[1].count, structured: structured.length, share }
    : { structured: structured.length, share: 0 };

  if (!top || share < STRUCTURE_ORDINARY_TOP_SHARE) {
    return unmeasured({
      key,
      label,
      weight,
      value,
      evidence: `No formatting scaffold recurs across ${pct(STRUCTURE_ORDINARY_TOP_SHARE)} of the ${structured.length} formatted comments — their structure varies the way written comments do. Varied structure is not evidence of a person, so this says nothing either way.`,
    });
  }

  const strength = oneDirectionalStrength(rescale(share, STRUCTURE_ORDINARY_TOP_SHARE, STRUCTURE_SATURATED_TOP_SHARE));

  const exemplar = structured.find((s) => s.skeleton === top[0]);

  return signal({
    key,
    label,
    weight,
    strength,
    value: { ...value, example: exemplar ? exampleRef('comment', exemplar.src) : null },
    evidence: `${top[1].count} of ${structured.length} formatted comments (${pct(share)}) share one exact scaffold — the same lines, bullets and links-per-line in the same order — even where their words differ. Fill-in-the-blanks output keeps its scaffold while varying its words; writing varies both.`,
  });
}

/** A span in the largest unit that still reads as a measurement. */
function formatSpan(seconds) {
  if (seconds < 120) return `${Math.round(seconds)} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

/**
 * A rate, at the precision that still carries information. The extra decimal
 * below 1/hour is not cosmetic: `toFixed(1)` renders a 310-item account as
 * "0.0 an hour", and an evidence string that contradicts its own sample is
 * exactly the bare-number failure mode axis.js exists to prevent.
 */
function formatRate(perHour) {
  if (perHour >= 100) return Math.round(perHour).toLocaleString('en-US');
  return perHour >= 1 ? perHour.toFixed(1) : perHour.toFixed(2);
}

function snippet(words) {
  const text = words.slice(0, 9).join(' ');
  return words.length > 9 ? `${text}…` : text;
}
