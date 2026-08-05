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
  commentsOldestFirst,
  reliableActivityOldestFirst,
} from '../sources/profile.js';
import {
  buildAxis, signal, unmeasured,
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

const MIN_INTERVALS = 10;
const MIN_COMMENTS_FOR_LENGTH = 10;

const BURST_GAP_SECONDS = 120;
const BURST_MIN_SIZE = 3;
const BURST_MIN_DISTINCT_THREAD_RATIO = 0.75;

const DUPLICATE_SHINGLE_SIZE = 3;
const DUPLICATE_MIN_WORDS = 6;
const DUPLICATE_JACCARD = 0.55;
/** Pairwise comparison is O(n^2); 200 newest keeps a badge render instant. */
const DUPLICATE_MAX_COMPARED = 200;

export function scoreAutomation(profile) {
  return buildAxis([
    postingHourSignal(profile),
    intervalRegularitySignal(profile),
    burstSignal(profile),
    lengthUniformitySignal(profile),
    karmaVelocitySignal(profile),
    duplicateBodySignal(profile),
    conversationDepthSignal(profile),
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
 * Cadence regularity. Machine posting is too EVEN — a scheduler produces gaps
 * with a low coefficient of variation, while a person posts in clumps around
 * their day. CV is unitless, so this says nothing about whether the account is
 * fast or slow, only whether the rhythm is mechanical.
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

  const strength = 1 - rescale(cv, 0.15, 1.0);

  return signal({
    key,
    label,
    weight,
    strength,
    value: { coefficientOfVariation: cv, intervals: intervals.length },
    evidence: `Gaps between consecutive comments vary by ${ratioPct(cv)} of their average (CV ${cv.toFixed(2)}) over ${intervals.length} intervals. ${cv < 0.4 ? 'Human posting is far lumpier than this.' : 'That is the irregular, clumpy spacing typical of a person.'}`,
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
    value: { burstComments, share, largestBurst, largestBurstSpan },
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
    .map((c) => ({ id: c.id, words: normalizeWords(c.body) }))
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

  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const score = jaccard(docs[i].set, docs[j].set);
      if (score > maxSimilarity) {
        maxSimilarity = score;
        example = [docs[i], docs[j]];
      }
      if (score >= DUPLICATE_JACCARD) {
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
    value: { duplicated: duplicated.size, compared: docs.length, share, maxSimilarity },
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
  const replyShare = replies / known.length;
  const strength = 1 - rescale(replyShare, 0.02, 0.3);

  return signal({
    key,
    label,
    weight,
    strength,
    value: { replies, sample: known.length, replyShare },
    evidence: replies === 0
      ? `All ${known.length} comments are top-level responses to a submission; the account has never replied to another commenter.`
      : `${replies} of ${known.length} comments (${pct(replyShare)}) are replies to other commenters rather than top-level drops.`,
  });
}

function snippet(words) {
  const text = words.slice(0, 9).join(' ');
  return words.length > 9 ? `${text}…` : text;
}
