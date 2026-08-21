/**
 * AGENDA — is this account pushing something?
 *
 * The axis that exists because automation scoring alone cannot answer the
 * user's actual question. A paid human posting talking points has a real
 * account age, organic timing and varied language; every signal in
 * automation.js reads clean on them. What they cannot easily hide is the
 * SHAPE of their participation — one subject, recurring formulations, no
 * interest in the conversation after the message lands, and often an account
 * with a history that isn't theirs.
 *
 * None of these signals is damning alone. A hobbyist is topic-concentrated;
 * everyone has verbal tics. They are weighted to be read together, and each
 * one publishes the sentence a human needs to disagree with it.
 */

import {
  activityOldestFirst, groupHistogram, reliableActivityOldestFirst,
} from '../sources/profile.js';
import {
  BAND_THRESHOLDS, buildAxis, signal, unmeasured,
} from './axis.js';
import {
  bareId, clamp01, formatDate, normalizeWords, pct, plural, rescale,
} from './stats.js';

const SECONDS_PER_DAY = 86400;

const MIN_ITEMS_FOR_CONCENTRATION = 10;

const STOCK_NGRAM_SIZE = 6;
const STOCK_MIN_COMMENTS = 3;
const STOCK_MIN_THREADS = 2;
const MIN_COMMENTS_FOR_STOCK = 10;

/**
 * A talking point is a CLAIM. A six-word run made entirely of function words
 * — "does anyone know how do i", "is that what you are" — is a grammatical
 * tic, and every fluent speaker repeats several of them. Requiring at least
 * two content words is what stops this signal from convicting people of
 * having a writing style, which matters because a false positive on the
 * agenda axis is an accusation against a real person.
 *
 * The list is ordinary English function words — articles, pronouns,
 * prepositions, conjunctions, auxiliaries, quantifiers — and nothing
 * topical. Do not add subject-matter words to it; that would silently
 * exempt whichever subject gets added.
 */
const STOCK_MIN_CONTENT_WORDS = 2;
const FUNCTION_WORDS = new Set((
  'a an the and or but if then than that this these those i you he she it we they me him her us them '
  + 'my your his hers its our their mine yours theirs of in on at to from by for with about into over '
  + 'under above through during without within between against toward after before since until while '
  + 'is are was were be been being am do does did doing done have has had having will would shall '
  + 'should can could may might must not no nor so as up down out off again once here there when '
  + 'where why how what which who whom all any both each few more most other some such only own same '
  + 'too very just also even still yet ever never one'
).split(' '));

function contentWordCount(words) {
  let n = 0;
  for (const word of words) if (!FUNCTION_WORDS.has(word)) n += 1;
  return n;
}

const MIN_ENGAGEMENTS_FOR_DRIVE_BY = 8;

/** Below this a gap is a holiday, not dormancy. */
const MIN_DORMANCY_GAP_DAYS = 120;
const STRONG_DORMANCY_GAP_DAYS = 730;
/** A revival stops being "the account's current era" somewhere past here. */
const REVIVAL_FRESH_DAYS = 365;
const REVIVAL_STALE_DAYS = 1095;
const MIN_ITEMS_AFTER_GAP = 5;

export function scoreAgenda(profile) {
  return buildAxis(holdShapeToCorroboration([
    topicConcentrationSignal(profile),
    stockPhrasingSignal(profile),
    driveBySignal(profile),
    dormancyRevivalSignal(profile),
  ]));
}

/**
 * SHAPE IS NOT A TALKING POINT (JIO-424).
 *
 * Two of the four signals here describe the SHAPE of an account's
 * participation — how concentrated it is, and whether it stays for the reply.
 * The other two are about what the account actually says and whose history it
 * is. The header above says all four are "weighted to be read together"; a
 * weighted mean does not do that, and the difference is measurable.
 *
 * Measured over the 27 frozen accounts in `test/corpus/`, no network, by
 * `scripts/measure-agenda-shape.mjs`:
 *
 *   * `topic-concentration` ranks the corpus BACKWARDS against its only ground
 *     truth. Seven of the 8 declared bots hold the bottom 7 places (2-7% top
 *     share) and the eighth reaches 16%, which 16 of the 19 humans beat; the
 *     top of the ranking is two hand-read hobbyists at 77% and 97%. The only
 *     two accounts in the corpus this signal scores above `low` are both
 *     people.
 *   * `drive-by-ratio` separates nothing: bots span 0-91%, people 3-87%, and
 *     the window floor of 0.35 sits at the MEDIAN thread human (0.36), so it
 *     reads above zero for 9 of the 17.
 *
 * So the two prolific humans of Finding 4a scored agenda `moderate` 55 and 57
 * — on those two signals alone, with `stock-phrasing` measuring a real ZERO
 * for both and `dormancy-revival` unmeasurable inside their 2- and 4-day
 * windows. u/Hartacus, an ordinary thread human, sits at the same 87% drive-by
 * share and stays `low` only for posting in 38 groups rather than 6. That
 * is the axis banding a hobbyist on volume and choice of subreddit, which is
 * this axis's most consequential false positive: a false accusation against a
 * real person.
 *
 * THE RULE: a shape signal may argue as hard as the evidence beside it, and no
 * harder. Its strength is held to the strongest measured `stock-phrasing` or
 * `dormancy-revival` — floored at the `moderate` band edge, so it is never
 * silenced and can always take the axis to the edge of an accusation on its
 * own. GRADED, not a gate, and that is load-bearing: an on/off rule at the
 * band edge would have taken u/chilidirigible from 30 to 68 on a
 * `stock-phrasing` strength moving 0.29 to 0.31, and two of the 17 thread
 * humans sit within 0.11 of that line on their real bodies (0.37 and 0.40). A
 * cliff that steep next to real accounts is a false positive waiting for a
 * re-capture.
 *
 * The floor is `BAND_THRESHOLDS.moderate / 100` rather than a number somebody
 * picked, for the same reason.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not touch either threshold. The
 * corpus holds no agenda accounts — the 8 declared bots are utility bots, and
 * EVALUATION.md records that no population of known-paid accounts exists — so
 * "where should the gate sit" is a question nothing here can answer, and
 * moving one on this evidence would be the error JIO-344 named on
 * ORDINARY_ITEMS_PER_HOUR. What IS measurable is that neither signal separates
 * anything this repo can label, and the hold is a claim only about that.
 *
 * An UNMEASURED corroborating signal corroborates nothing. That is the same
 * direction axis.js rule 3 already runs in: we do not have the evidence, so we
 * do not make the accusation.
 */
const SHAPE_KEYS = new Set(['topic-concentration', 'drive-by-ratio']);
const CORROBORATING_KEYS = new Set(['stock-phrasing', 'dormancy-revival']);
/** An uncorroborated shape signal reaches the band edge and does not cross it. */
const SHAPE_FLOOR = BAND_THRESHOLDS.moderate / 100;

function holdShapeToCorroboration(signals) {
  const corroborating = signals.filter((s) => CORROBORATING_KEYS.has(s.key) && s.strength != null);
  const ceiling = Math.max(SHAPE_FLOOR, ...corroborating.map((s) => s.strength));
  if (ceiling >= 1) return signals;

  const strongest = corroborating.length
    ? corroborating.reduce((a, b) => (b.strength > a.strength ? b : a))
    : null;
  // Named by BAND, never by strength: `axis.js` strips the internal 0..1 so
  // nothing downstream can start reading it as a likelihood, and an evidence
  // string is downstream.
  const beside = strongest && strongest.strength >= SHAPE_FLOOR
    ? `the strongest evidence beside it, "${strongest.label}", reads ${strongest.band}, so it is held to that`
    : `nothing beside it reads above low${
      corroborating.length < CORROBORATING_KEYS.size ? ', and one of the two could not be measured at all' : ''
    }, so it is held to the edge of \`moderate\``;

  return signals.map((s) => {
    if (!SHAPE_KEYS.has(s.key) || s.strength == null || s.strength <= ceiling) return s;
    // Held, and it says so on the account being judged — a bound that fires
    // silently is the one nobody can argue with.
    return signal({
      key: s.key,
      label: s.label,
      weight: s.weight,
      strength: ceiling,
      value: { ...s.value, heldToCorroboration: true },
      evidence: `${s.evidence} A shape like this fits a dedicated hobbyist as well as it fits an agenda account. Here ${beside} rather than counted in full.`,
    });
  });
}

/** Share of all activity in the single largest group. */
function topicConcentrationSignal(profile) {
  const key = 'topic-concentration';
  const label = 'Single-subject focus';
  const weight = 2.5;

  const timeline = activityOldestFirst(profile);
  const histogram = groupHistogram(timeline);
  const total = [...histogram.values()].reduce((a, b) => a + b, 0);

  if (total < MIN_ITEMS_FOR_CONCENTRATION) {
    return unmeasured({
      key, label, weight, evidence: `Only ${total} items carry a group — needs at least ${MIN_ITEMS_FOR_CONCENTRATION}.`,
    });
  }

  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  const [topGroup, topCount] = ranked[0];
  const topShare = topCount / total;
  const strength = rescale(topShare, 0.35, 0.85);

  return signal({
    key,
    label,
    weight,
    strength,
    value: { topGroup, topCount, total, topShare, distinctGroups: histogram.size },
    // The "a dedicated hobbyist looks like this too" caveat that used to hang
    // off this string now lives in holdShapeToCorroboration(), which appends
    // it exactly when the read really is shape-only — and holds the number as
    // well as warning about it, which is the half the sentence never did.
    evidence: `${pct(topShare)} of activity (${topCount} of ${total} items) sits in one group, "${topGroup}", out of ${histogram.size} ${plural(histogram.size, 'group')} total.`,
  });
}

/**
 * Stock phrasing: word sequences that recur across otherwise unrelated
 * comments. Six-word n-grams are long enough that hitting one twice by
 * coincidence is unlikely, and requiring the repeats to span DIFFERENT THREADS
 * is what separates a talking point from someone restating themselves inside
 * one argument. Spanning different groups too is stronger still, so the top
 * phrase's group spread feeds the score directly.
 */
function stockPhrasingSignal(profile) {
  const key = 'stock-phrasing';
  const label = 'Recurring stock phrases';
  const weight = 2.5;

  const docs = profile.comments
    .map((c, i) => ({
      idx: i,
      thread: c.threadId ?? `thread-${i}`,
      group: c.group,
      words: normalizeWords(c.body),
    }))
    .filter((d) => d.words.length >= STOCK_NGRAM_SIZE);

  if (docs.length < MIN_COMMENTS_FOR_STOCK) {
    return unmeasured({
      key, label, weight, evidence: `Only ${docs.length} comments long enough to check for repeated phrasing — needs at least ${MIN_COMMENTS_FOR_STOCK}.`,
    });
  }

  /** phrase -> { comments:Set, threads:Set, groups:Set } */
  const phrases = new Map();
  for (const doc of docs) {
    const seenHere = new Set();
    for (let i = 0; i + STOCK_NGRAM_SIZE <= doc.words.length; i += 1) {
      const window = doc.words.slice(i, i + STOCK_NGRAM_SIZE);
      if (contentWordCount(window) < STOCK_MIN_CONTENT_WORDS) continue;
      const phrase = window.join(' ');
      if (seenHere.has(phrase)) continue;
      seenHere.add(phrase);
      let entry = phrases.get(phrase);
      if (!entry) {
        entry = { comments: new Set(), threads: new Set(), groups: new Set() };
        phrases.set(phrase, entry);
      }
      entry.comments.add(doc.idx);
      entry.threads.add(doc.thread);
      if (doc.group) entry.groups.add(doc.group);
    }
  }

  const qualifying = [...phrases.entries()].filter(
    ([, e]) => e.comments.size >= STOCK_MIN_COMMENTS && e.threads.size >= STOCK_MIN_THREADS,
  );

  const covered = new Set();
  let top = null;
  for (const [phrase, entry] of qualifying) {
    for (const idx of entry.comments) covered.add(idx);
    const rank = entry.comments.size * (1 + entry.groups.size);
    if (!top || rank > top.rank) {
      top = { phrase, rank, comments: entry.comments.size, groups: entry.groups.size, threads: entry.threads.size };
    }
  }

  const coveredShare = covered.size / docs.length;
  const strength = clamp01(
    0.75 * rescale(coveredShare, 0.03, 0.30)
    + 0.25 * rescale(top ? top.groups : 0, 1, 4),
  );

  return signal({
    key,
    label,
    weight,
    strength,
    value: {
      phraseCount: qualifying.length, coveredComments: covered.size, compared: docs.length, coveredShare, top,
    },
    evidence: top
      ? `${qualifying.length} ${STOCK_NGRAM_SIZE}-word ${plural(qualifying.length, 'phrase')} ${plural(qualifying.length, 'recurs', 'recur')} across unrelated threads, covering ${covered.size} of ${docs.length} comments (${pct(coveredShare)}). The most repeated is "${top.phrase}" — ${top.comments} comments across ${top.threads} ${plural(top.threads, 'thread')} and ${top.groups} ${plural(top.groups, 'group')}. A signature sign-off looks like this too, so read the phrase itself rather than the count.`
      : `No ${STOCK_NGRAM_SIZE}-word phrase recurs across ${STOCK_MIN_COMMENTS}+ comments in ${STOCK_MIN_THREADS}+ separate threads, over ${docs.length} comments compared.`,
  });
}

/**
 * Drive-by ratio — dropping a message and never engaging with what comes back.
 *
 * SPEC DEVIATION, STATED HONESTLY IN THE EVIDENCE STRING. The brief asks for
 * "comments that drew replies the account never answered", and the source only
 * gives us half of that directly. So this measures two observable things and
 * says which is which:
 *
 *   * EXACT, for the account's own submissions: a post with a known reply
 *     count where the account never commented in its own thread. Here we know
 *     replies existed and know they went unanswered.
 *   * PROXY, for comments: a thread the account entered exactly once, with a
 *     top-level comment, and never returned to. We cannot see whether anyone
 *     replied to it, only that the account never came back to look.
 *
 * The proxy is weaker and is named as a proxy on screen rather than being
 * quietly folded in as if it were the real measurement.
 */
function driveBySignal(profile) {
  const key = 'drive-by-ratio';
  const label = 'Posts and leaves';
  const weight = 2;

  const commentedThreads = new Map(); // bare thread id -> comments in it
  for (const c of profile.comments) {
    const thread = bareId(c.threadId);
    if (!thread) continue;
    if (!commentedThreads.has(thread)) commentedThreads.set(thread, []);
    commentedThreads.get(thread).push(c);
  }

  const postsWithReplies = profile.posts.filter((p) => Number.isFinite(p.replyCount) && p.replyCount > 0);
  const abandonedPosts = postsWithReplies.filter((p) => !commentedThreads.has(bareId(p.id)));

  let oneAndDone = 0;
  for (const comments of commentedThreads.values()) {
    if (comments.length === 1 && comments[0].isTopLevel === true) oneAndDone += 1;
  }

  const engagements = postsWithReplies.length + commentedThreads.size;
  if (engagements < MIN_ENGAGEMENTS_FOR_DRIVE_BY) {
    return unmeasured({
      key, label, weight, evidence: `Only ${engagements} threads to judge follow-up behaviour on — needs at least ${MIN_ENGAGEMENTS_FOR_DRIVE_BY}.`,
    });
  }

  const driveBys = abandonedPosts.length + oneAndDone;
  const share = driveBys / engagements;
  const strength = rescale(share, 0.35, 0.9);

  const postClause = postsWithReplies.length
    ? `${abandonedPosts.length} of ${postsWithReplies.length} of the account's own submissions drew replies it never answered`
    : 'none of the account\'s own submissions have a known reply count';

  return signal({
    key,
    label,
    weight,
    strength,
    value: {
      abandonedPosts: abandonedPosts.length,
      postsWithReplies: postsWithReplies.length,
      oneAndDoneThreads: oneAndDone,
      threads: commentedThreads.size,
      engagements,
      share,
    },
    evidence: `${pct(share)} of ${engagements} engagements look like drive-bys: ${postClause}, and ${oneAndDone} of ${commentedThreads.size} threads got a single top-level comment and no return visit. The second half is a proxy — the source does not say whether those comments drew replies, only that the account never came back.`,
  });
}

/**
 * Dormancy revival — an old account with a long silent gap before its recent
 * activity. A purchased or reactivated account is a strong, cheap signal and
 * it is INVISIBLE to any plain account-age check: the age looks great, which
 * is exactly why it was bought.
 *
 * The load-bearing guard: gaps are measured ONLY WITHIN THE FETCHED WINDOW.
 * We page newest-first, so the stretch between `firstSeenUtc` and
 * `oldestFetchedUtc` is history we never asked for, not silence — counting it
 * would report a fabricated multi-year dormancy for every prolific account
 * whose history got truncated. When the view is truncated the evidence says
 * so, because a gap we could not see into is a real limit on this signal.
 */
function dormancyRevivalSignal(profile) {
  const key = 'dormancy-revival';
  const label = 'Revived dormant account';
  const weight = 3;

  // Only look inside the window where both streams are complete. See
  // reliableTimelineStart() — merging a shallow comment window with a deep
  // post window manufactures dormancy that never happened.
  const timeline = reliableActivityOldestFirst(profile);
  const dropped = activityOldestFirst(profile).length - timeline.length;

  if (timeline.length < MIN_ITEMS_AFTER_GAP + 1) {
    return unmeasured({
      key,
      label,
      weight,
      evidence: dropped > 0
        ? `Only ${timeline.length} items fall inside the window where the retrieved history is complete (${dropped} older ${plural(dropped, 'item')} sit below it), which is too few to look for a dormancy gap.`
        : `Only ${timeline.length} timestamped items — too few to find a dormancy gap.`,
    });
  }

  // A gap this signal could report has to FIT in the window we can see. The
  // item-count gate above is not that check: 299 comments spanning 0.0 days
  // clear it easily, and the signal then reported "longest silence is 0 days,
  // below the 120-day threshold" — arithmetically the only sentence it could
  // have produced (JIO-290, EVALUATION.md Finding 3). Across 25 live accounts
  // it returned a clean `low` 25 times and `insufficient-data` never, so the
  // heaviest agenda signal (weight 3) was a near-constant zero diluting every
  // other one. That is the README's rule 3 inverted: absence of evidence
  // scored as evidence of absence.
  //
  // The gate is on the SPAN and nothing else — deliberately not on
  // `coverage.truncated`. A complete nine-day history cannot hold a 120-day
  // silence either, so gating on truncation would leave the bug live for
  // exactly the young accounts this axis is most often pointed at.
  // `posting-hour-dead-zone` has always had the equivalent guard
  // (MIN_SPAN_DAYS_FOR_HOUR_PROFILE); this is the same shape.
  const spanDays = (timeline[timeline.length - 1].createdUtc - timeline[0].createdUtc) / SECONDS_PER_DAY;
  if (spanDays < MIN_DORMANCY_GAP_DAYS) {
    return unmeasured({
      key,
      label,
      weight,
      value: { spanDays },
      evidence: `The ${timeline.length} items in the reliable window span only ${spanDays < 1 ? `${Math.round(spanDays * 24)} hours` : `${spanDays.toFixed(1)} days`} — a ${MIN_DORMANCY_GAP_DAYS}-day silence could not fit inside it, so this says nothing either way.`,
    });
  }

  let best = null;
  for (let i = 1; i < timeline.length; i += 1) {
    const gapDays = (timeline[i].createdUtc - timeline[i - 1].createdUtc) / SECONDS_PER_DAY;
    if (!best || gapDays > best.gapDays) {
      best = { gapDays, start: timeline[i - 1].createdUtc, end: timeline[i].createdUtc, index: i };
    }
  }

  const itemsAfter = timeline.length - best.index;
  const daysSinceRevival = (profile.fetchedAt - best.end) / SECONDS_PER_DAY;

  const truncationNote = profile.coverage.truncated
    ? ` Measured over the ${timeline.length} items in the window where the retrieved history is complete${dropped > 0 ? ` (${dropped} older ${plural(dropped, 'item')} excluded, since below that point missing data is indistinguishable from silence)` : ''}, so any earlier dormancy is invisible to this check.`
    : '';

  if (best.gapDays < MIN_DORMANCY_GAP_DAYS || itemsAfter < MIN_ITEMS_AFTER_GAP) {
    return signal({
      key,
      label,
      weight,
      strength: 0,
      value: { largestGapDays: best.gapDays, itemsAfterGap: itemsAfter },
      evidence: `Longest silence in the retrieved history is ${Math.round(best.gapDays)} days (${formatDate(best.start)} to ${formatDate(best.end)}), below the ${MIN_DORMANCY_GAP_DAYS}-day dormancy threshold.${truncationNote}`,
    });
  }

  const sizeComponent = rescale(best.gapDays, MIN_DORMANCY_GAP_DAYS, STRONG_DORMANCY_GAP_DAYS);
  // A revival only counts while it is still the account's CURRENT era. A
  // hiatus that ended a decade ago is biography, not a reactivation, and
  // scoring it would flag every long-lived account that once took a break.
  const freshness = 1 - rescale(daysSinceRevival, REVIVAL_FRESH_DAYS, REVIVAL_STALE_DAYS);
  const strength = clamp01(sizeComponent * freshness);

  const staleNote = freshness < 0.5
    ? ` That was ${Math.round(daysSinceRevival)} days ago, long enough that it reads as an old hiatus rather than a recent reactivation, so it is discounted here.`
    : ' Account age alone would not show this.';

  return signal({
    key,
    label,
    weight,
    strength,
    value: {
      largestGapDays: best.gapDays,
      gapStart: best.start,
      gapEnd: best.end,
      itemsAfterGap: itemsAfter,
      daysSinceRevival,
    },
    evidence: `The account went silent for ${Math.round(best.gapDays)} days (${formatDate(best.start)} to ${formatDate(best.end)}) and then resumed, posting ${itemsAfter} of its ${timeline.length} retrieved items since.${staleNote}${truncationNote}`,
  });
}
