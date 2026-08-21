/**
 * `node scripts/measure-reply-share.mjs` — the reply-share distribution of the
 * frozen corpus, which is the whole evidence base for where `conversation-depth`
 * stops arguing (JIO-345, EVALUATION.md Finding 4d).
 *
 * NO NETWORK, no `node_modules`, like `evaluate.mjs` and
 * `measure-agenda-shape.mjs`: `test/corpus/` is 27 serialised `buildProfile`
 * outputs and `scoreAutomation` is pure, so this is JSON in and arithmetic out.
 * Run it rather than taking Finding 4d's numbers on trust.
 *
 * WHY IT EXISTS. The signal used to score `1 - rescale(replyShare, …)`, so a
 * 100% reply rate earned strength 0 — a full-weight vote for humanity handed to
 * u/RemindMeBot by the exact mechanism that makes it a bot. Fixing that needs
 * one number: where, in a population this repo can label, does a reply rate
 * stop separating anything? This prints that population.
 *
 * It reads PUBLISHED signals only — `band` and `value`, never `strength`, which
 * `axis.js` strips on purpose — so the columns here are what the extension
 * renders to a user, and nothing here needs the instrumented-copy machinery
 * `measure-jio329.mjs` needs.
 *
 * WHAT IT CANNOT SHOW. 19 humans and 8 declared bots, all utility bots. It can
 * say that a reply rate does not separate THESE populations above the cut; it
 * cannot say what the twentieth human does, which is exactly why the cut below
 * is categorical rather than a percentile of these 19 points.
 */

import { scoreAutomation } from '../extension/lib/scoring/automation.js';
import { COHORTS, loadCorpus } from '../test/corpus/load.js';

const COHORT_LABELS = {
  [COHORTS.THREAD]: '17 thread humans (r/politics, ordinary volume)',
  [COHORTS.PROLIFIC]: '2 prolific humans (content-blind volume sweep, hand-read)',
  [COHORTS.BOT]: '8 declared bots (self-declared or EVALUATION.md hand-read)',
};

const { accounts } = loadCorpus();

const rows = accounts.map((account) => {
  const axis = scoreAutomation(account.profile);
  const depth = axis.signals.find((s) => s.key === 'conversation-depth');
  return {
    username: account.username,
    cohort: account.cohort,
    isBot: account.class === 'bot',
    axis,
    depth,
    replies: depth.value?.replies ?? null,
    topLevel: depth.value?.topLevel ?? null,
    sample: depth.value?.sample ?? null,
    replyShare: depth.value?.replyShare ?? null,
  };
});

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

console.log('conversation-depth over the frozen corpus — no network\n');

const width = Math.max(...rows.map((r) => r.username.length));
for (const cohort of [COHORTS.THREAD, COHORTS.PROLIFIC, COHORTS.BOT]) {
  console.log(COHORT_LABELS[cohort]);
  console.log(`  ${'account'.padEnd(width)}  replies  top-level  reply share  signal              automation`);
  const group = rows.filter((r) => r.cohort === cohort)
    .sort((a, b) => (b.replyShare ?? -1) - (a.replyShare ?? -1));
  for (const r of group) {
    console.log(`  ${r.username.padEnd(width)}  ${
      String(r.replies ?? '—').padStart(7)}  ${
      String(r.topLevel ?? '—').padStart(9)}  ${
      pct(r.replyShare).padStart(11)}  ${
      r.depth.band.padEnd(18)}  ${
      `${r.axis.band} ${r.axis.score ?? '—'}`.padStart(13)}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// The margin the cut has to live in
// ---------------------------------------------------------------------------

const measurable = rows.filter((r) => r.replyShare != null);
const humans = measurable.filter((r) => !r.isBot);
const bots = measurable.filter((r) => r.isBot);
const replyBots = bots.filter((r) => r.topLevel === 0);
const humanTop = humans.slice().sort((a, b) => a.topLevel - b.topLevel)[0];
const humanCeiling = humans.slice().sort((a, b) => b.replyShare - a.replyShare)[0];

console.log('The separation, in one paragraph');
console.log(`  ${replyBots.length} of ${bots.length} bots have NO top-level comment in the window: ${
  replyBots.map((r) => `${r.username} ${r.replies}/${r.sample}`).join(', ')}.`);
console.log(`  Every one of the ${humans.length} humans has at least one. The thinnest is u/${
  humanTop.username} at ${humanTop.topLevel} of ${humanTop.sample} (${pct(humanCeiling.replyShare)} replies).`);
console.log(`  So the whole job is separating ${pct(humanCeiling.replyShare)} from 100.0% — a margin of ${
  humanTop.topLevel} comment(s). A percentile drawn off ${humans.length} points would not survive the ${
  humans.length + 1}th human; "no top-level comment anywhere in the window" is a fact about the window instead.`);
console.log('');

const gated = rows.filter((r) => r.depth.band === 'insufficient-data' && r.topLevel === 0);
const lowBots = bots.filter((r) => r.depth.band === 'low');
console.log('What the cut does');
console.log(`  unmeasured on the reply pole: ${gated.map((r) => r.username).join(', ') || 'nobody'}`);
console.log(`  bots still banding low on this signal: ${lowBots.map((r) => r.username).join(', ') || 'none'}`);
console.log(`  humans banding low on this signal: ${humans.filter((r) => r.depth.band === 'low').length} of ${humans.length} — unchanged, the discount below the cut is untouched (JIO-329, not this).`);
console.log('');

console.log('THE BOUND, OUT LOUD');
console.log('  A reply-bot that drops one top-level comment in 300 escapes this cut and still');
console.log('  scores a measured zero. Closing that needs a threshold inside the margin above,');
console.log('  next to a real account. Nothing in this corpus can justify one.');
