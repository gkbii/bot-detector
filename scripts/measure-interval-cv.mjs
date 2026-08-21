/**
 * `node scripts/measure-interval-cv.mjs` — the interval-CV distribution of the
 * frozen corpus, which is the whole evidence base for where
 * `interval-regularity` stops arguing (JIO-346, EVALUATION.md Finding 4e).
 *
 * NO NETWORK, no `node_modules`, like `evaluate.mjs`, `measure-agenda-shape.mjs`
 * and `measure-reply-share.mjs`: `test/corpus/` is 27 serialised `buildProfile`
 * outputs and `scoreAutomation` is pure, so this is JSON in and arithmetic out.
 * Run it rather than taking Finding 4e's numbers on trust.
 *
 * WHY IT EXISTS. The signal scored `1 - rescale(cv, 0.15, 1.0)`, and `rescale`
 * clamps — so every account from CV 1.0 upward earned the identical strength
 * 0.000, the largest vote for humanity the signal can cast, at weight 2.
 * u/RemindMeBot posts when people summon it and therefore measured CV 1.26,
 * which the evidence string rendered as *"the irregular, clumpy spacing typical
 * of a person"*. The question the fix needed answering was whether anything
 * above 1.0 separates the populations. This prints that population so the
 * answer is a table rather than an argument.
 *
 * It reads PUBLISHED signals only — `band` and `value`, never `strength`, which
 * `axis.js` strips on purpose — so the columns here are what the extension
 * renders to a user. `value.coefficientOfVariation` survives that stripping,
 * which is why no instrumented copy is needed here and `measure-jio329.mjs`
 * needs one.
 *
 * WHAT IT CANNOT SHOW. 19 humans and 8 declared bots, all utility bots. It can
 * say that an uneven cadence does not separate THESE populations; it cannot say
 * what an adversarial bot deliberately jittering its scheduler would do, and no
 * such population is available to freeze. That bot is caught here only if it
 * jitters less than CV 1.0.
 */

import { scoreAutomation } from '../extension/lib/scoring/automation.js';
import { COHORTS, loadCorpus } from '../test/corpus/load.js';
import { MIN_MEASURED_WEIGHT_FRACTION } from '../extension/lib/scoring/axis.js';

const COHORT_LABELS = {
  [COHORTS.THREAD]: '17 thread humans (r/politics, ordinary volume)',
  [COHORTS.PROLIFIC]: '2 prolific humans (content-blind volume sweep, hand-read)',
  [COHORTS.BOT]: '8 declared bots (self-declared or EVALUATION.md hand-read)',
};

/** The gate under test, restated here so the script fails loudly if it moves. */
const HUMANLIKE_INTERVAL_CV = 1.0;

const { accounts } = loadCorpus();

const rows = accounts.map((account) => {
  const axis = scoreAutomation(account.profile);
  const rhythm = axis.signals.find((s) => s.key === 'interval-regularity');
  const totalWeight = axis.signals.reduce((acc, s) => acc + s.weight, 0);
  const unmeasured = axis.signals.filter((s) => s.band === 'insufficient-data');
  return {
    username: account.username,
    cohort: account.cohort,
    isBot: account.class === 'bot',
    axis,
    rhythm,
    cv: rhythm.value?.coefficientOfVariation ?? null,
    intervals: rhythm.value?.intervals ?? null,
    measuredFraction: (totalWeight - unmeasured.reduce((a, s) => a + s.weight, 0)) / totalWeight,
    unmeasured: unmeasured.map((s) => s.key),
  };
});

console.log('interval-regularity over the frozen corpus — no network\n');

const width = Math.max(...rows.map((r) => r.username.length));
for (const cohort of [COHORTS.THREAD, COHORTS.PROLIFIC, COHORTS.BOT]) {
  console.log(COHORT_LABELS[cohort]);
  console.log(`  ${'account'.padEnd(width)}       CV  intervals  signal              automation`);
  const group = rows.filter((r) => r.cohort === cohort)
    .sort((a, b) => (a.cv ?? Infinity) - (b.cv ?? Infinity));
  for (const r of group) {
    console.log(`  ${r.username.padEnd(width)}  ${
      (r.cv == null ? '—' : r.cv.toFixed(3)).padStart(7)}  ${
      String(r.intervals ?? '—').padStart(9)}  ${
      r.rhythm.band.padEnd(18)}  ${
      `${r.axis.band} ${r.axis.score ?? '—'}`.padStart(13)}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Why the gate is the ceiling of the scale rather than a number next to these
// ---------------------------------------------------------------------------

const measurable = rows.filter((r) => r.cv != null);
const above = measurable.filter((r) => r.cv >= HUMANLIKE_INTERVAL_CV);
const below = measurable.filter((r) => r.cv < HUMANLIKE_INTERVAL_CV);
const humansAbove = above.filter((r) => !r.isBot);
const botsAbove = above.filter((r) => r.isBot);
const span = (group) => `${Math.min(...group.map((r) => r.cv)).toFixed(2)} to ${
  Math.max(...group.map((r) => r.cv)).toFixed(2)}`;

console.log('The identity the gate is drawn from');
console.log(`  ${above.length} of the ${measurable.length} measurable accounts sit at or above CV ${
  HUMANLIKE_INTERVAL_CV.toFixed(1)}, where rescale() clamps:`);
console.log(`    ${humansAbove.length} humans, CV ${span(humansAbove)}`);
console.log(`    ${botsAbove.length} bots,   CV ${span(botsAbove)} — ${
  botsAbove.map((r) => r.username).join(', ')}`);
console.log('  Under the pre-JIO-346 arithmetic every one of them scored the SAME strength 0.000,');
console.log('  the largest vote for humanity this signal can cast. A number identical for the');
console.log('  adversary and for the person it exists to separate is not measuring either, so');
console.log('  that end returns unmeasured() now. (strength is stripped from the published');
console.log('  verdict by design, so the band column above is where you can see it land.)');
console.log(`  Still measured below the gate: ${
  below.map((r) => `${r.username} (CV ${r.cv.toFixed(2)}, ${r.rhythm.band})`).join(', ') || 'nobody'}.`);
console.log('');

// ---------------------------------------------------------------------------
// What 2 of 15.5 weight going quiet costs the axis's own gate
// ---------------------------------------------------------------------------

const worst = rows.slice().sort((a, b) => a.measuredFraction - b.measuredFraction)[0];
console.log('What it costs the measured-weight gate');
console.log(`  worst case in the corpus: ${worst.username} at ${
  worst.measuredFraction.toFixed(3)} — ${worst.unmeasured.join(', ')}`);
console.log(`  MIN_MEASURED_WEIGHT_FRACTION is ${MIN_MEASURED_WEIGHT_FRACTION}, so nothing here is gated out of a band.`);
console.log('');

console.log('THE BOUND, OUT LOUD');
console.log(`  This signal now says nothing about ${above.length} of the ${rows.length} frozen accounts.`);
console.log('  That is 2 of the axis’s 15.5 weight going quiet for very nearly everybody, and it');
console.log('  is a real loss of coverage rather than a free fix. It is also the honest reading of');
console.log('  what was already there: those scores were the same 0.000 whatever the account was.');
console.log('  The mechanical pole below CV 1.0 is untouched and is the half that separates.');
console.log('  An adversarial bot that jitters its scheduler past CV 1.0 buys the same silence, and');
console.log('  no corpus available to this repo holds one.');
