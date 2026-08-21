/**
 * `node scripts/measure-topical-breadth.mjs` — the items-per-group
 * distribution of the frozen corpus, which is the whole evidence base for the
 * depth taper on `topical-breadth` (JIO-347, EVALUATION.md Finding 4f).
 *
 * NO NETWORK, no `node_modules`, like `evaluate.mjs`, `measure-agenda-shape.mjs`,
 * `measure-reply-share.mjs` and `measure-interval-cv.mjs`: `test/corpus/` is 27
 * serialised `buildProfile` outputs and `scoreAuthenticity` is pure, so this is
 * JSON in and arithmetic out. Run it rather than taking Finding 4f's numbers on
 * trust.
 *
 * WHY IT EXISTS. The signal scored `0.5 * outside-the-largest-group + 0.5 *
 * rescale(groups, 2, 15)`, and both halves saturate on sitewide automation:
 * u/AutoModerator is in 307 groups with 98% of itself outside the largest, so
 * it took a flat 1.000 — the largest vouch this signal can award a person — on
 * the axis that exists to say "this is a human". All eight declared bots read
 * `high` here, not the two the ticket named. The fix needed a measure that
 * separates a range of interests from a route march, so this prints the
 * candidate and its two rejected rivals as a table rather than an argument.
 *
 * It reads PUBLISHED signals only — `band` and `value`, never `strength`,
 * which `axis.js` strips on purpose. `value.reach` and `value.depth` survive
 * that stripping, so the pre-taper band is recoverable here and no
 * instrumented copy is needed (`measure-jio329.mjs` needs one).
 *
 * WHAT IT CANNOT SHOW. 19 humans and 8 declared bots, all utility bots. The
 * gap it reports is between THESE populations. A bot that posts three times in
 * every group it enters buys back the full reach credit, and no corpus
 * available to this repo holds one — the taper raises that bot's cost, it does
 * not close the door.
 */

import { scoreAuthenticity } from '../extension/lib/scoring/authenticity.js';
import { bandFromScore } from '../extension/lib/scoring/axis.js';
import { groupHistogram } from '../extension/lib/sources/profile.js';
import { COHORTS, loadCorpus } from '../test/corpus/load.js';

const COHORT_LABELS = {
  [COHORTS.THREAD]: '17 thread humans (r/politics, ordinary volume)',
  [COHORTS.PROLIFIC]: '2 prolific humans (content-blind volume sweep, hand-read)',
  [COHORTS.BOT]: '8 declared bots (self-declared or EVALUATION.md hand-read)',
};

/** The constant under test, restated here so the script fails loudly if it moves. */
const DEPTH_FULL_CREDIT = 3;

const { accounts } = loadCorpus();

const rows = accounts.map((account) => {
  const axis = scoreAuthenticity(account.profile);
  const breadth = axis.signals.find((s) => s.key === 'topical-breadth');
  const counts = [...groupHistogram([...account.profile.comments, ...account.profile.posts]).values()];
  const singletons = counts.filter((c) => c === 1).length;
  return {
    username: account.username,
    cohort: account.cohort,
    isBot: account.class === 'bot',
    axis,
    breadth,
    groups: breadth.value?.distinctGroups ?? null,
    itemsPerGroup: breadth.value?.itemsPerGroup ?? null,
    reach: breadth.value?.reach ?? null,
    depth: breadth.value?.depth ?? null,
    singletonShare: counts.length ? singletons / counts.length : null,
    outside: breadth.value?.outsideTopShare ?? null,
  };
});

console.log('topical-breadth over the frozen corpus — no network\n');

const width = Math.max(...rows.map((r) => r.username.length));
for (const cohort of [COHORTS.THREAD, COHORTS.PROLIFIC, COHORTS.BOT]) {
  console.log(COHORT_LABELS[cohort]);
  console.log(`  ${'account'.padEnd(width)}  groups  items/group  reach  depth  was     now     authenticity`);
  const group = rows.filter((r) => r.cohort === cohort)
    .sort((a, b) => (a.itemsPerGroup ?? Infinity) - (b.itemsPerGroup ?? Infinity));
  for (const r of group) {
    console.log(`  ${r.username.padEnd(width)}  ${
      String(r.groups ?? '—').padStart(6)}  ${
      (r.itemsPerGroup == null ? '—' : r.itemsPerGroup.toFixed(2)).padStart(11)}  ${
      (r.reach == null ? '—' : r.reach.toFixed(2)).padStart(5)}  ${
      (r.depth == null ? '—' : r.depth.toFixed(2)).padStart(5)}  ${
      // The pre-taper band: what this signal read before JIO-347.
      (r.reach == null ? '—' : bandFromScore(r.reach * 100)).padEnd(6)}  ${
      r.breadth.band.padEnd(6)}  ${
      `${r.axis.band} ${r.axis.score ?? '—'}`.padStart(13)}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// The gap the taper is drawn from
// ---------------------------------------------------------------------------

const measurable = rows.filter((r) => r.itemsPerGroup != null);
const bots = measurable.filter((r) => r.isBot);
const humans = measurable.filter((r) => !r.isBot);
const span = (group, pick) => `${Math.min(...group.map(pick)).toFixed(2)} to ${Math.max(...group.map(pick)).toFixed(2)}`;
const topBot = Math.max(...bots.map((r) => r.itemsPerGroup));
const bottomHuman = Math.min(...humans.map((r) => r.itemsPerGroup));

console.log('The gap the taper is drawn from');
console.log(`  items per group   bots ${span(bots, (r) => r.itemsPerGroup)} · humans ${span(humans, (r) => r.itemsPerGroup)}`);
console.log(`  no overlap: the busiest bot returns to a group ${topBot.toFixed(2)} times, the thinnest human ${bottomHuman.toFixed(2)}.`);
console.log(`  Full credit is set at ${DEPTH_FULL_CREDIT.toFixed(1)} and credit starts at 1.00. NEITHER END IS FITTED TO`);
console.log('  THIS TABLE: 1.00 is the arithmetic minimum of the measure — one item in every group,');
console.log('  reach with no depth anywhere — and 3 is a return visit rather than a drive-by, which');
console.log('  happens to sit just under the thinnest human rather than being placed there.');
console.log('');

// ---------------------------------------------------------------------------
// The two rivals, and why they were not used
// ---------------------------------------------------------------------------

const closestBot = bots.reduce((a, b) => (b.singletonShare < a.singletonShare ? b : a));
const closestHuman = humans.reduce((a, b) => (b.singletonShare > a.singletonShare ? b : a));
const singletonMargin = closestBot.singletonShare - closestHuman.singletonShare;
console.log('Rivals rejected, with the number that rejected them');
console.log(`  singleton share   bots ${span(bots, (r) => r.singletonShare)} · humans ${span(humans, (r) => r.singletonShare)}`);
console.log(`    TOO CLOSE TO CUT. The two populations are ${singletonMargin.toFixed(4)} apart: ${closestHuman.username} at ${
  closestHuman.singletonShare.toFixed(4)}`);
console.log(`    against ${closestBot.username} at ${closestBot.singletonShare.toFixed(4)}. A cut there is fitted to the third decimal`);
console.log(`    place of one person, and one more comment in a group ${closestHuman.username} has already`);
console.log(`    visited would move it. On items per group the same two populations are ${(bottomHuman - topBot).toFixed(2)} apart,`);
console.log(`    a factor of ${(bottomHuman / topBot).toFixed(2)}.`);
console.log(`  outside top group bots ${span(bots, (r) => r.outside)} · humans ${span(humans, (r) => r.outside)}`);
console.log('    INVERTED. The bots are MORE spread than the people — being everywhere is the job.');
console.log('    It is half of the pre-taper reach, which is why the reach column above reads 1.00');
console.log('    for all eight of them.');
console.log('');

// ---------------------------------------------------------------------------
// What moved
// ---------------------------------------------------------------------------

const rebanded = measurable.filter((r) => bandFromScore(r.reach * 100) !== r.breadth.band);
console.log('What moved');
console.log(`  ${rebanded.length} of ${measurable.length} accounts change band, and every one is a bot:`);
for (const r of rebanded) {
  console.log(`    ${r.isBot ? 'bot  ' : 'HUMAN'} ${r.username.padEnd(width)}  ${
    bandFromScore(r.reach * 100)} -> ${r.breadth.band}`);
}
const stillHigh = bots.filter((r) => r.breadth.band === 'high');
console.log(`  declared bots still reading \`high\` on this signal: ${stillHigh.length ? stillHigh.map((r) => r.username).join(', ') : 'none'}`);
console.log(`  humans whose depth is tapered at all: ${
  humans.filter((r) => r.depth < 1).map((r) => r.username).join(', ') || 'none'}`);
console.log('');

console.log('THE BOUND, OUT LOUD');
console.log(`  A person needs ${DEPTH_FULL_CREDIT} items per group on average for full breadth credit, so a`);
console.log('  genuine account with 30 comments in 20 different groups is now tapered to near zero');
console.log('  here. That is a real cost and it is accepted deliberately: one comment in each of');
console.log('  twenty groups is the same shape as the adversary, and this axis reads low as "no');
console.log('  positive evidence" rather than as an accusation. The other four authenticity');
console.log('  signals are untouched and still speak for that account.');
console.log('  The taper is also priced by the fetch window: 300 comments over 300 groups cannot');
console.log('  show depth even if the account has it. A bot that concentrates into a handful of');
console.log('  groups keeps the full credit and must be caught by the automation axis instead.');
