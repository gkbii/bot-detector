/**
 * `node scripts/measure-agenda-shape.mjs` — rank the frozen corpus on the two
 * agenda signals that describe the SHAPE of an account's participation:
 * `topic-concentration` and `drive-by-ratio` (JIO-424, EVALUATION.md Finding
 * 4c).
 *
 * NO NETWORK, no `node_modules`, like `evaluate.mjs`: `test/corpus/` is 27
 * serialised `buildProfile` outputs and `scoreAgenda` is pure, so this is JSON
 * in and arithmetic out. Run it, do not take Finding 4c's numbers on trust.
 *
 * WHY IT EXISTS. The question the ticket asked was "do these two signals
 * separate hobbyists from agenda accounts?" and it has two halves. The half
 * that CAN be measured is what this prints: how the two signals rank the only
 * two populations this repo can label — 19 humans and 8 accounts that declare
 * themselves bots. The half that cannot is stated at the bottom of the output
 * and in EVALUATION.md, and no output of this script should be read as
 * evidence about agenda accounts, because the corpus holds none.
 *
 * It reads PUBLISHED signals only — `value` and `band`, never `strength`,
 * which `axis.js` strips on purpose. So the columns here are the same numbers
 * the extension renders to a user, and nothing in this file needs the
 * instrumented-copy machinery `measure-jio329.mjs` needs.
 */

import { scoreAgenda } from '../extension/lib/scoring/agenda.js';
import { BAND_THRESHOLDS } from '../extension/lib/scoring/axis.js';
import { clamp01, rescale } from '../extension/lib/scoring/stats.js';
import { COHORTS, loadCorpus, loadManifest } from '../test/corpus/load.js';

const COHORT_LABELS = {
  [COHORTS.THREAD]: '17 thread humans (r/politics, ordinary volume)',
  [COHORTS.PROLIFIC]: '2 prolific humans (content-blind volume sweep, hand-read)',
  [COHORTS.BOT]: '8 declared bots (self-declared or EVALUATION.md hand-read)',
};

const { accounts } = loadCorpus();
const rows = accounts.map((account) => {
  const axis = scoreAgenda(account.profile);
  const of = (key) => axis.signals.find((s) => s.key === key);
  return {
    username: account.username,
    cohort: account.cohort,
    axis,
    topic: of('topic-concentration'),
    stock: of('stock-phrasing'),
    driveBy: of('drive-by-ratio'),
    dormancy: of('dormancy-revival'),
  };
});

console.log('Agenda shape signals over the frozen corpus — no network\n');

const width = Math.max(...rows.map((r) => r.username.length));
for (const cohort of [COHORTS.THREAD, COHORTS.PROLIFIC, COHORTS.BOT]) {
  console.log(`${COHORT_LABELS[cohort]}`);
  console.log(`  ${'account'.padEnd(width)}  top share  groups  drive-by  phrasing  dormancy   agenda`);
  const group = rows.filter((r) => r.cohort === cohort)
    .sort((a, b) => share(b.topic, 'topShare') - share(a.topic, 'topShare'));
  for (const r of group) {
    console.log(`  ${r.username.padEnd(width)}  ${
      percent(r.topic, 'topShare').padStart(9)}  ${
      String(r.topic.value?.distinctGroups ?? '—').padStart(6)}  ${
      percent(r.driveBy, 'share').padStart(8)}  ${
      band(r.stock).padStart(8)}  ${
      band(r.dormancy).padStart(8)}  ${
      `${r.axis.band} ${r.axis.score ?? '—'}`.padStart(13)}${
      held(r) ? '   HELD' : ''}`);
  }
  console.log('');
}

// --- the two claims Finding 4c rests on, recomputed rather than quoted ------
const labelled = (cohort) => rows.filter((r) => r.cohort === cohort);
const humans = rows.filter((r) => r.cohort !== COHORTS.BOT);
const bots = labelled(COHORTS.BOT);

const botTop = bots.map((r) => share(r.topic, 'topShare'));
const humanTop = humans.map((r) => share(r.topic, 'topShare'));
console.log('topic-concentration');
console.log(`  bots  ${range(botTop)}   humans ${range(humanTop)}`);
const topBot = Math.max(...botTop);
console.log(`  humans above the most concentrated bot (${pct(topBot)}): ${
  humanTop.filter((v) => v > topBot).length} of ${humanTop.length}`);
const nonZero = rows.filter((r) => r.topic.band !== 'insufficient-data' && r.topic.band !== 'low');
console.log(`  accounts scoring above \`low\` on it: ${nonZero.length ? nonZero.map((r) => `${r.username} (${r.cohort})` ).join(', ') : 'none'}`);

const botDrive = bots.map((r) => share(r.driveBy, 'share'));
const humanDrive = humans.map((r) => share(r.driveBy, 'share'));
const threadDrive = labelled(COHORTS.THREAD).map((r) => share(r.driveBy, 'share')).sort((a, b) => a - b);
console.log('\ndrive-by-ratio');
console.log(`  bots  ${range(botDrive)}   humans ${range(humanDrive)}`);
console.log(`  the two ranges overlap: ${
  Math.min(...humanDrive) <= Math.max(...botDrive) && Math.min(...botDrive) <= Math.max(...humanDrive) ? 'YES' : 'no'}`);
console.log(`  median thread human ${pct(threadDrive[(threadDrive.length - 1) / 2])}, against a window floor of 35%`);

// --- every bound that fired, out loud --------------------------------------
const heldRows = rows.filter(held);
console.log(`\nholdShapeToCorroboration() fired on ${heldRows.length} of ${rows.length} accounts:`);
for (const r of heldRows) {
  console.log(`  · ${r.username} (${r.cohort}) — agenda ${r.axis.band} ${r.axis.score}, ${
    [r.topic, r.driveBy].filter((s) => s.value?.heldToCorroboration).map((s) => s.key).join(' and ')} held`);
}
if (!heldRows.length) console.log('  · none — nothing in the corpus is concentrated or drive-by enough to be held');

// --- the human half, on the bodies it actually had ------------------------
// The 19 human profiles carry length-matched SYNTHETIC bodies, so their
// `stock-phrasing` is not the one the live account produced — which is exactly
// the signal the hold reads for corroboration. The corpus therefore cannot
// show the corroborated branch on a real person, and a table that ignored that
// would be quietly reporting the synthesis rather than the account.
//
// What it CAN do is solve for it. `manifest.json` records each human's agenda
// score on both the real and the synthesised profile, and on this axis bodies
// feed `stock-phrasing` and nothing else — `topic-concentration` reads groups,
// `drive-by-ratio` reads thread ids, `dormancy-revival` reads timestamps. So
// the gap between the two scores IS that signal, and the strength behind it
// falls out of the weighted average. Those recorded scores predate the hold,
// so the arithmetic below is the uncapped one they were computed under.
const SHAPE_FLOOR = BAND_THRESHOLDS.moderate / 100;
const SHAPE_KEYS = new Set(['topic-concentration', 'drive-by-ratio']);
const manifest = loadManifest();
const realAgenda = new Map((manifest?.captured ?? [])
  .filter((e) => e.real && e.frozen)
  .map((e) => [e.username, e.real.agenda.score]));

console.log('\nThe same accounts on their REAL bodies, solved for rather than re-measured\n');
console.log(`  ${'account'.padEnd(width)}   recorded  implied phrasing  corroborates?  under the hold`);
for (const r of rows.filter((x) => x.cohort !== COHORTS.BOT).sort(byImplied)) {
  const implied = impliedPhrasing(r);
  if (implied == null) continue;
  console.log(`  ${r.username.padEnd(width)}  ${
    String(realAgenda.get(r.username)).padStart(9)}  ${
    implied.toFixed(2).padStart(16)}  ${
    (implied >= SHAPE_FLOOR ? 'yes' : 'no').padStart(13)}  ${
    String(realUnderHold(r, implied)).padStart(14)}`);
}
console.log(`
  A phrasing strength within 0.02 of zero is rounding on the recorded integer
  score, not a measurement. The two rows that matter are u/chilidirigible and
  u/humdingler: their real text corroborates nothing either, so the hold lands
  on their real bodies as well as on their frozen ones and takes them out of
  \`moderate\` there too. The bound worth knowing is the other end of the
  column — this rule protects an account whose phrasing AND dormancy both read
  low, and nothing else. A hobbyist with a catchphrase gets nothing from it,
  and two of these seventeen ordinary people already have one.

  And this column is OF THE CAPTURE WINDOW rather than of the account. It
  solves against the score \`manifest.json\` recorded at capture, so it moves
  whenever the account does: u/Hartacus solves to 0.37 here and read 0.08 on a
  live re-fetch on 2026-08-21. Read the shape of the column, not a row of it as
  a current measurement.`);

console.log(`\nWhat this does NOT measure: whether either signal fires on an actual agenda
account. All 8 bots here are UTILITY bots, and EVALUATION.md records that no
population of known-paid accounts exists and one cannot easily be obtained. So
this ranks people against utility bots and nothing else, and the hold above is
a claim about that and only that.`);

// ---------------------------------------------------------------------------

function share(sig, field) {
  return sig.band === 'insufficient-data' ? 0 : sig.value[field];
}

function percent(sig, field) {
  return sig.band === 'insufficient-data' ? 'n/a' : pct(sig.value[field]);
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

function band(sig) {
  return sig.band === 'insufficient-data' ? 'n/a' : sig.band;
}

function held(r) {
  return r.topic.value?.heldToCorroboration === true || r.driveBy.value?.heldToCorroboration === true;
}

/**
 * Every measured signal on the axis EXCEPT `stock-phrasing`, re-derived from
 * the published `value` the same way the table above reads it — weight paired
 * with strength, and an unmeasured signal simply absent, because axis.js rule
 * 3 leaves it out of the weighted mean on both sides of the solve.
 *
 * `dormancy-revival` has to be in here and was not (JIO-424, found by the
 * Auditor). It is the heaviest signal on the axis at weight 3, so reading it
 * as an implicit zero attributes whatever it measured to phrasing instead:
 * u/KevinGreeneSolar published as 0.31, "corroborates? yes", against a true
 * 0.009 — a gap of exactly 3 × 0.2514 / 2.5 — while the live account reads
 * phrasing 0.00. It is the one account in the corpus with a dormancy gap over
 * the 120-day threshold, and 0.2514 bands `low`, so the band-based guard that
 * used to stand here could not see it.
 */
function otherStrengths(r) {
  return [
    { key: 'topic-concentration', weight: 2.5, strength: rescaleOf(r.topic, 'topShare', 0.35, 0.85) },
    { key: 'drive-by-ratio', weight: 2, strength: rescaleOf(r.driveBy, 'share', 0.35, 0.9) },
    { key: 'dormancy-revival', weight: 3, strength: dormancyStrength(r.dormancy) },
  ].filter((s) => s.strength != null);
}

function rescaleOf(sig, field, floor, ceiling) {
  return sig.band === 'insufficient-data' ? null : rescale(sig.value[field], floor, ceiling);
}

/**
 * The sub-threshold branch of `dormancy-revival` publishes a flat zero and no
 * `gapStart`; the scoring branch publishes both halves it multiplies, so the
 * strength falls straight back out of them.
 */
function dormancyStrength(sig) {
  if (sig.band === 'insufficient-data') return null;
  if (!Number.isFinite(sig.value?.gapStart)) return 0;
  return clamp01(
    rescale(sig.value.largestGapDays, 120, 730)
    * (1 - rescale(sig.value.daysSinceRevival, 365, 1095)),
  );
}

/** 2.5 for `stock-phrasing`, which is always measured here, plus the rest. */
function measuredWeight(others) {
  return 2.5 + others.reduce((acc, s) => acc + s.weight, 0);
}

/**
 * The `stock-phrasing` strength the real bodies must have had, from the agenda
 * score they produced. Null for the bots, which keep their real text anyway.
 */
function impliedPhrasing(r) {
  const real = realAgenda.get(r.username);
  if (!Number.isFinite(real)) return null;
  const others = otherStrengths(r);
  const known = others.reduce((acc, s) => acc + s.weight * s.strength, 0);
  return ((real / 100) * measuredWeight(others) - known) / 2.5;
}

/** What that account would score today, on the real bodies, under the hold. */
function realUnderHold(r, implied) {
  const others = otherStrengths(r);
  const dormancy = others.find((s) => s.key === 'dormancy-revival');
  // holdShapeToCorroboration() holds shape to the STRONGEST corroborator, so
  // dormancy belongs in this max alongside phrasing — an account revived from
  // a long sleep has evidence beside its shape even when its text has none.
  const ceiling = Math.max(SHAPE_FLOOR, implied, ...(dormancy ? [dormancy.strength] : []));
  const weighted = others.reduce((acc, s) => (
    acc + s.weight * (SHAPE_KEYS.has(s.key) ? Math.min(s.strength, ceiling) : s.strength)
  ), 2.5 * Math.max(0, implied));
  return Math.round((weighted / measuredWeight(others)) * 100);
}

function byImplied(a, b) {
  return (impliedPhrasing(b) ?? -1) - (impliedPhrasing(a) ?? -1);
}

function range(values) {
  return `${pct(Math.min(...values))}–${pct(Math.max(...values))}`.padEnd(9);
}
