/**
 * `node scripts/measure-interval-crossing.mjs` — does JIO-346's cadence-pole
 * cut push a real person over the `moderate` band edge, on live data, today?
 *
 *   node scripts/measure-interval-crossing.mjs                 # the two ceiling accounts
 *   node scripts/measure-interval-crossing.mjs --all-humans    # all 19 corpus humans
 *   node scripts/measure-interval-crossing.mjs u/someone u/else
 *
 * GOES TO THE NETWORK, like `capture-corpus.mjs`, `probe-prolific-humans.mjs`
 * and `measure-jio329.mjs`, and like all three it is run by hand and is not
 * part of `npm test` or `npm run evaluate`. That is the whole point of it: the
 * question it answers is one the frozen corpus CANNOT answer, so the three
 * no-network `measure-*.mjs` scripts are the wrong tool and the import-graph
 * guard in `test/corpus.test.js` deliberately does not list this file.
 *
 * WHY IT EXISTS (JIO-346, EVALUATION.md Finding 4e). Taking `interval-regularity`
 * to `unmeasured` removes 2 of 15.5 weight from an axis that averages over
 * MEASURED weight only, so every ordinary person's automation score is
 * multiplied by `mw / (mw - 2)` — a multiplier on the score is a divisor on the
 * band edge, and `moderate` starts early by exactly that factor. Finding 4e
 * priced that and then checked two samples for anyone standing in the newly
 * exposed 26-29 strip: the frozen corpus (nobody) and a 77-account live sweep
 * (nobody). Both were true and neither could see the crossing that had already
 * happened. `test/corpus/` was captured 2026-08-18; u/chilidirigible drifted one
 * point in three days and was at `low 26` before this change and `moderate 30`
 * after it, measured live on 2026-08-21. One point was the entire margin.
 *
 * So this script is the third sample, and it is the one that has to go live,
 * because a frozen profile is exactly what hid the answer. It reconstructs the
 * PRE-change score by re-adding `interval-regularity` at the clamped strength
 * 0.000 it used to earn at weight 2 — which is sound precisely because the old
 * `rescale(cv, 0.15, 1.0)` CLAMPED: for any CV at or above 1.0 the old strength
 * was not approximately zero, it was exactly 0.000. Above the gate there is
 * nothing to estimate.
 *
 * WHAT IT CANNOT SHOW. It re-fetches accounts THIS REPO ALREADY NAMES, so it is
 * a re-measure and not a fresh sample: it can tell you the invariant broke, it
 * cannot tell you how many people are in the strip. Finding 4b's whole-ranking
 * sweep is the tool for that question and `measure-jio329.mjs --harvest` is the
 * command. It also reads PUBLISHED signals only — `band` and `value`, never
 * `strength`, which `axis.js` strips on purpose — so `measuredWeight` here is
 * recomputed from which signals came back `insufficient-data`.
 */

import { fetchAccount } from '../extension/lib/sources/arcticShift.js';
import { scoreAutomation } from '../extension/lib/scoring/automation.js';
import { BAND, bandFromScore } from '../extension/lib/scoring/axis.js';
import { COHORTS, loadCorpus } from '../test/corpus/load.js';

/** The gate JIO-346 installed, restated so this fails loudly if it moves. */
const HUMANLIKE_INTERVAL_CV = 1.0;
/** The weight `interval-regularity` carries, and therefore what was removed. */
const RHYTHM_WEIGHT = 2;

const args = process.argv.slice(2);
const allHumans = args.includes('--all-humans');
const named = args.filter((a) => !a.startsWith('--'));

const { accounts } = loadCorpus();
const humans = accounts.filter((a) => a.class === 'human');

let targets;
let scopeNote;
if (named.length) {
  targets = named;
  scopeNote = `${targets.length} account(s) named on the command line`;
} else if (allHumans) {
  targets = humans.map((a) => a.username);
  scopeNote = `all ${targets.length} humans in test/corpus/`;
} else {
  // BOUND, FIRED AND SAID OUT LOUD: the default is not the whole corpus. The
  // 17 thread humans top out at 20 post-change and cannot reach 30 without
  // roughly half again their score, so the only accounts that can plausibly
  // cross are the two prolific ones -- which is also why they were admitted to
  // the corpus at all (JIO-344). --all-humans checks that assumption instead
  // of inheriting it, at the cost of 19 live lookups.
  targets = humans.filter((a) => a.cohort === COHORTS.PROLIFIC).map((a) => a.username);
  scopeNote = `the ${targets.length} prolific humans only — the 17 thread humans `
    + 'top out at 20 and are NOT checked here; pass --all-humans to check them';
}

console.log(`Live re-measure of JIO-346's cost — ${scopeNote}.`);
console.log('Fetched through the shipped fetchAccount, scored by the shipped scoreAutomation.\n');

const rows = [];
for (const username of targets) {
  const profile = await fetchAccount(username);
  if (!profile) {
    rows.push({ username, error: 'no such account, or no profile returned' });
    continue;
  }

  const axis = scoreAutomation(profile);
  const rhythm = axis.signals.find((s) => s.key === 'interval-regularity');
  const measured = axis.signals.filter((s) => s.band !== BAND.INSUFFICIENT);
  const mw = measured.reduce((acc, s) => acc + s.weight, 0);
  const totalWeight = axis.signals.reduce((acc, s) => acc + s.weight, 0);
  const cv = rhythm?.value?.coefficientOfVariation ?? null;
  const gated = rhythm?.band === BAND.INSUFFICIENT && cv != null && cv >= HUMANLIKE_INTERVAL_CV;

  // Pre-change: the same measured evidence, plus RHYTHM_WEIGHT at strength
  // 0.000. Only meaningful where the gate is what withheld it -- an account
  // unmeasured for want of intervals was unmeasured before this change too.
  const post = axis.score;
  const pre = post == null || !gated
    ? null
    : Math.round((post / 100) * mw / (mw + RHYTHM_WEIGHT) * 100);
  const bracket = post == null || !gated
    ? null
    : [(post - 0.5) * mw / (mw + RHYTHM_WEIGHT), (post + 0.5) * mw / (mw + RHYTHM_WEIGHT)];

  rows.push({
    username,
    comments: profile.comments?.length ?? 0,
    cv,
    gated,
    mw,
    totalWeight,
    post,
    postBand: axis.band,
    pre,
    preBand: pre == null ? null : bandFromScore(pre),
    bracket,
    // The band edge this profile's own shape puts `moderate` at, on the old
    // scale: 30 x (mw_pre - 2) / mw_pre. Shape-dependent, which is the part
    // Finding 4e originally stated as a single universal 25.6.
    effectiveEdge: gated ? 30 * mw / (mw + RHYTHM_WEIGHT) : null,
  });
}

const w = Math.max(8, ...rows.map((r) => r.username.length));
console.log(
  `${'account'.padEnd(w)}  ${'CV'.padStart(6)}  ${'mw'.padStart(9)}  `
  + `${'before'.padStart(12)}  ${'after'.padStart(12)}  ${'edge'.padStart(5)}  crossed`,
);
for (const r of rows) {
  if (r.error) { console.log(`${r.username.padEnd(w)}  ${r.error}`); continue; }
  const crossed = r.pre != null && r.preBand !== r.postBand;
  console.log(
    `${r.username.padEnd(w)}  ${(r.cv == null ? '—' : r.cv.toFixed(2)).padStart(6)}  `
    + `${`${r.mw}/${r.totalWeight}`.padStart(9)}  `
    + `${(r.pre == null ? 'n/a' : `${r.preBand} ${r.pre}`).padStart(12)}  `
    + `${(r.post == null ? 'insufficient' : `${r.postBand} ${r.post}`).padStart(12)}  `
    + `${(r.effectiveEdge == null ? '—' : r.effectiveEdge.toFixed(1)).padStart(5)}  `
    + `${crossed ? '** YES **' : r.pre == null ? '' : 'no'}`,
  );
}

// --- the two things a reader is actually asking ------------------------------
const crossings = rows.filter((r) => r.pre != null && r.preBand !== r.postBand);
console.log(`\nBand crossings attributable to JIO-346: ${crossings.length}`);
for (const r of crossings) {
  console.log(
    `  ${r.username}: ${r.preBand} ${r.pre} -> ${r.postBand} ${r.post}`
    + ` (before-score bracketed ${r.bracket[0].toFixed(2)}-${r.bracket[1].toFixed(2)}`
    + ` across the rounding of ${r.post}; ${r.comments} comments, CV ${r.cv.toFixed(2)})`,
  );
}

// This is the invariant `npm run evaluate` gates its EXIT CODE on, asked of
// live data instead of the 2026-08-18 snapshot. Finding 4e's stake in one line.
const aboveLow = rows.filter((r) => r.postBand && r.postBand !== BAND.LOW && !r.error);
console.log(
  `\nevaluate's invariant on THIS live sample — no human above \`low\`: `
  + `${aboveLow.length ? 'BROKEN' : 'HOLDS'}`,
);
for (const r of aboveLow) console.log(`  ! human ${r.username} scores ${r.postBand} ${r.post}`);
if (aboveLow.length) {
  console.log(
    '\n  test/corpus/ freezes profiles, so `npm run evaluate` can still print HOLDS\n'
    + '  and exit 0 while this reads BROKEN. That difference is drift, not a bug in\n'
    + '  either one — and it is the re-capture question EVALUATION.md Finding 4e\n'
    + '  leaves open rather than settling.',
  );
}
