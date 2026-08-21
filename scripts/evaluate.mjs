/**
 * `npm run evaluate` — reprint EVALUATION.md's headline band table from the
 * frozen corpus, and fail if it moved.
 *
 *   npm run evaluate                # table + invariants + diff vs expected.json
 *   npm run evaluate -- --detail    # one line per account as well
 *   npm run evaluate -- --update    # rewrite expected.json from today's scores
 *
 * NO NETWORK. Not a soft preference — `test/corpus/` is 27 serialised
 * `buildProfile` outputs and `scoreAccount` is pure, so this whole script is
 * JSON in and arithmetic out. It runs with no `node_modules` present, like the
 * rest of the suite.
 *
 * WHY (JIO-343). The band table in EVALUATION.md came from a live run on
 * 2026-08-05 whose profiles were never kept. "Headline band separation is not
 * regressed" was therefore not a thing anyone could run, so every reweighting
 * proposed after it — the JIO-329 line of work in particular — was
 * unfalsifiable, and JIO-290's ad hoc re-measure could not rule out having
 * moved the 17-human / 8-bot separation. This turns the table into a diff.
 *
 * EXIT CODES ARE THE POINT. 0 when the table matches `expected.json` and both
 * separation invariants hold; 1 when anything moved, with the moved lines
 * printed. A definition of done can be `npm run evaluate`.
 *
 * WHAT A GREEN RUN DOES NOT MEAN. It compares today's scorers against a fixed
 * input, which is exactly what a regression check should do and exactly not
 * what a live evaluation is. It cannot see the archive changing, the fetch
 * window changing, or any of the two classes of defect this repo has actually
 * shipped (see README, "a bug only the real runtime could find"). Re-capture
 * with `node scripts/capture-corpus.mjs --force` and re-read by hand before
 * claiming anything about live behaviour.
 */

import fs from 'node:fs';
import { scoreAccount } from '../extension/lib/scoring/index.js';
import {
  AXES, EXPECTED_PATH, loadCorpus, loadExpected, loadManifest,
} from '../test/corpus/load.js';

const argv = process.argv.slice(2);
const DETAIL = argv.includes('--detail');
const UPDATE = argv.includes('--update');

const BAND_ORDER = ['low', 'moderate', 'high', 'insufficient-data'];

const {
  accounts, bots, threadHumans, prolificHumans,
} = loadCorpus();
if (!accounts.length) {
  console.error('test/corpus/ is empty — run: node scripts/capture-corpus.mjs');
  process.exit(1);
}

// Scored exactly once per account. `near-duplicate-bodies` is a pairwise
// Jaccard over the newest 200 comments, so re-scoring per table cell turns a
// half-second command into an awkward one.
const scored = accounts.map((a) => ({ ...a, verdict: scoreAccount(a.profile) }));
const verdictOf = new Map(scored.map((a) => [a.username, a.verdict]));
const table = { byUsername: {} };
for (const a of scored) {
  table.byUsername[a.username] = Object.fromEntries(
    AXES.map((axis) => [axis, { band: a.verdict[axis].band, score: a.verdict[axis].score }]),
  );
}

const manifest = loadManifest();
const capturedAt = accounts.map((a) => a.capturedAt).filter(Number.isFinite);

console.log('Frozen evaluation corpus — EVALUATION.md\'s headline table, recomputed from disk');
console.log(`test/corpus/ · ${threadHumans.length} thread humans + ${prolificHumans.length} prolific humans + ${bots.length} declared bots · captured ${
  capturedAt.length ? new Date(Math.min(...capturedAt) * 1000).toISOString().slice(0, 10) : 'unknown'
} · no network\n`);

// THREE ROWS, NOT TWO. The prolific humans were sampled by a different rule
// (a content-blind volume sweep, not one thread) and they are two accounts
// against seventeen, so folding them into the thread row would move that row's
// range while still calling it "thread humans" — and would bury the only
// reason they are in the corpus at all (JIO-344, EVALUATION.md Finding 4a).
const rows = [
  [`${threadHumans.length} thread humans`, threadHumans],
  [`${prolificHumans.length} prolific humans`, prolificHumans],
  [`${bots.length} declared bots`, bots],
];
const labelWidth = Math.max(...rows.map(([label]) => label.length));
const cells = rows.map(([label, group]) => [label, AXES.map((axis) => cell(group, axis))]);
const widths = AXES.map((_, i) => Math.max(AXES[i].length, ...cells.map(([, c]) => c[i].length)));

console.log(`${' '.repeat(labelWidth)}  ${AXES.map((a, i) => a.padEnd(widths[i])).join('  ')}`);
for (const [label, c] of cells) {
  console.log(`${label.padEnd(labelWidth)}  ${c.map((v, i) => v.padEnd(widths[i])).join('  ')}`);
}

// --- the two invariants the whole evaluation rested on ----------------------
// EVALUATION.md: "No human scored above `low` on automation and no bot scored
// `low`. The bands do not overlap at all, which is the result that had to hold
// before anything else was worth reporting." These are that sentence, executed.
const humansAboveLow = scored.filter((a) => a.class === 'human' && a.verdict.automation.band !== 'low');
const botsAtLow = scored.filter((a) => a.class === 'bot' && a.verdict.automation.band === 'low');
const separated = !humansAboveLow.length && !botsAtLow.length;

console.log(`\nSeparation on automation — no human above \`low\`, no bot at \`low\`: ${separated ? 'HOLDS' : 'BROKEN'}`);
for (const a of humansAboveLow) console.log(`  ! human ${a.username} scores ${a.verdict.automation.band} ${a.verdict.automation.score}`);
for (const a of botsAtLow) console.log(`  ! bot   ${a.username} scores low ${a.verdict.automation.score}`);

// --- every bound that fired, out loud ---------------------------------------
const notes = [];
if (threadHumans.length !== 17) notes.push(`${threadHumans.length} thread humans, not the 17 EVALUATION.md scored`);
if (bots.length !== 8) notes.push(`${bots.length} bots, not the 8 EVALUATION.md scored`);
// The prolific cohort is only worth anything while the rate signal actually
// measures it. If it stops firing, this corpus is back to being unable to ask
// the question it was extended to ask, and that has to be said out loud rather
// than inferred from a row that still prints.
if (!prolificHumans.length) {
  notes.push('NO prolific human in the corpus — README\'s claim that this signal\'s shape, not its gate, is what protects a >3/h person is unfalsifiable again (JIO-344)');
}
for (const account of prolificHumans) {
  const rate = verdictOf.get(account.username).automation.signals.find((sig) => sig.key === 'sustained-posting-rate');
  if (!rate || rate.band === 'insufficient-data') {
    notes.push(`prolific human ${account.username} no longer fires sustained-posting-rate, so it pins nothing`);
  } else {
    notes.push(`prolific human ${account.username} sustains ${rate.value.itemsPerHour.toFixed(2)}/h and still scores automation ${verdictOf.get(account.username).automation.band} ${verdictOf.get(account.username).automation.score}`);
  }
}
const synthetic = accounts.filter((a) => a.bodies !== 'real');
if (synthetic.length) {
  notes.push(`${synthetic.length} of ${accounts.length} accounts carry length-matched synthetic bodies, so their \`near-duplicate-bodies\` and \`stock-phrasing\` signals are NOT the ones the live account produced`);
  // Printed, not merely filed. The gap between the real profile's verdict and
  // the frozen one is the cost of not committing a stranger's comments to a
  // public repo, and a cost that only exists inside a JSON file is a cost
  // nobody reads. The capture records both; this is the worst of them.
  const gaps = [];
  for (const entry of manifest?.captured ?? []) {
    if (!entry.real || !entry.frozen) continue;
    for (const axis of AXES) {
      const from = entry.real[axis].score;
      const to = entry.frozen[axis].score;
      if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
        gaps.push({ username: entry.username, axis, from, to, size: Math.abs(from - to), rebanded: entry.real[axis].band !== entry.frozen[axis].band });
      }
    }
  }
  gaps.sort((a, b) => b.size - a.size);
  if (!gaps.length) notes.push('and not one of those substitutions moved a score at all');
  else {
    notes.push(`the substitution moves ${gaps.length} of ${synthetic.length * AXES.length} synthetic-body scores; the largest is ${gaps[0].username} ${gaps[0].axis} ${gaps[0].from} -> ${gaps[0].to}`);
    const rebanded = gaps.filter((g) => g.rebanded);
    if (rebanded.length) {
      notes.push(`and ${rebanded.length} of them cross a band: ${rebanded.map((g) => `${g.username} ${g.axis}`).join(', ')}`);
    }
  }
}
for (const skipped of manifest?.humansSkipped ?? []) notes.push(`human candidate ${skipped.username} skipped: ${skipped.reason}`);
for (const skipped of manifest?.prolificSkipped ?? []) notes.push(`prolific human candidate ${skipped.username} skipped: ${skipped.reason}`);
for (const rejected of manifest?.botsRejected ?? []) notes.push(`bot candidate ${rejected.username} rejected: ${rejected.reason}`);
if (notes.length) {
  console.log('\nBounds that fired:');
  for (const n of notes) console.log(`  · ${n}`);
}

if (DETAIL) {
  console.log('\nPer account:');
  const width = Math.max(...scored.map((a) => a.username.length));
  const LABELS = { 'politics-thread': 'human', 'prolific-probe': 'FAST ', 'declared-bot': 'bot  ' };
  for (const cohort of ['politics-thread', 'prolific-probe', 'declared-bot']) {
    for (const a of scored.filter((x) => x.cohort === cohort)) {
      console.log(`  ${LABELS[cohort]} ${a.username.padEnd(width)}  ${
        AXES.map((axis) => `${axis.slice(0, 4)} ${String(a.verdict[axis].band).padEnd(16)} ${String(a.verdict[axis].score ?? '—').padStart(3)}`).join(' · ')
      }`);
    }
  }
}

// --- the diff ---------------------------------------------------------------
if (UPDATE) {
  fs.writeFileSync(EXPECTED_PATH, `${JSON.stringify(table, null, 1)}\n`);
  console.log(`\nwrote ${EXPECTED_PATH}`);
  process.exit(separated ? 0 : 1);
}

const expected = loadExpected();
if (!expected) {
  console.error('\nNo test/corpus/expected.json — run: npm run evaluate -- --update');
  process.exit(1);
}

const diffs = diff(expected.byUsername, table.byUsername);
if (diffs.length) {
  console.log(`\n${diffs.length} ${diffs.length === 1 ? 'score has' : 'scores have'} moved since expected.json:`);
  for (const line of diffs) console.log(`  ${line}`);
  console.log('\nIf the move is intended, re-read the accounts by hand and then: npm run evaluate -- --update');
}

console.log(`\n${diffs.length === 0 && separated ? 'OK' : 'FAILED'}`);
process.exit(diffs.length === 0 && separated ? 0 : 1);

// ---------------------------------------------------------------------------

/** "low ×17 (0–22)" / "moderate ×7, high ×1 (34–66)" — EVALUATION.md's cell. */
function cell(group, axis) {
  if (!group.length) return '—';
  const verdicts = group.map((a) => verdictOf.get(a.username)[axis]);
  const counts = new Map();
  for (const v of verdicts) counts.set(v.band, (counts.get(v.band) ?? 0) + 1);
  const bands = [...counts.entries()]
    .sort((a, b) => BAND_ORDER.indexOf(a[0]) - BAND_ORDER.indexOf(b[0]))
    .map(([band, n]) => `${band} ×${n}`)
    .join(', ');
  const scores = verdicts.map((v) => v.score).filter(Number.isFinite);
  // An axis with no scores at all is all-insufficient-data; printing a range
  // for it would invent one.
  const range = scores.length ? ` (${Math.min(...scores)}–${Math.max(...scores)})` : '';
  return `${bands}${range}`;
}

function diff(before, after) {
  const out = [];
  for (const username of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!after[username]) { out.push(`${username}: gone from the corpus`); continue; }
    if (!before[username]) { out.push(`${username}: new in the corpus`); continue; }
    for (const axis of AXES) {
      const a = before[username][axis];
      const b = after[username][axis];
      if (a.band !== b.band || a.score !== b.score) {
        out.push(`${username} ${axis}: ${a.band} ${a.score} -> ${b.band} ${b.score}`);
      }
    }
  }
  return out.sort();
}
