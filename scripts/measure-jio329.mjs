/**
 * `node scripts/measure-jio329.mjs` — the live re-measure that gates JIO-329.
 *
 *   node scripts/measure-jio329.mjs --harvest            # content-blind ranking
 *   node scripts/measure-jio329.mjs --fetch --budget-s 500   # resumable, repeat
 *   node scripts/measure-jio329.mjs --report
 *   node scripts/measure-jio329.mjs --corpus             # frozen arm, no network
 *   node scripts/measure-jio329.mjs --read u/a,u/b       # bodies, for hand-reading
 *
 * GOES TO THE NETWORK, like `capture-corpus.mjs` and `probe-prolific-humans.mjs`
 * and for the same reason, and like both it is run by hand and is not part of
 * `npm test` or `npm run evaluate`.
 *
 * WHY (JIO-405). JIO-329 takes `conversation-depth` and `interval-regularity`
 * to unmeasured because both INVERT on reply-bots. For an ordinary person both
 * read a measured value near 0.0, and axis.js averages over MEASURED weight
 * only — so removing two near-zeros from the denominator RAISES the average
 * for everybody who was not the target. The effect is arithmetic and it is not
 * small: dropping 3.5 of 15.5 weight multiplies a typical human's automation
 * score by measuredWeight / (measuredWeight - 3.5).
 *
 * WHY IT IS NOT ENOUGH TO RE-READ EVALUATION.md FINDING 4a. That finding
 * already reports 28 rises and 2 falls, but its 44 accounts are the TOP of a
 * prolific-commenter ranking, harvested to answer the RATE question. Every one
 * of them is at the extreme of the volume distribution, which is the wrong
 * population for a question about ordinary people — and it is the population
 * most likely to understate the effect, because a prolific account is the one
 * whose OTHER signals are measured too. This script samples the same firehose
 * ACROSS its whole ranking instead of off the top of it.
 *
 * HOW THE SAMPLE IS FIXED BEFORE ANYTHING IS FETCHED. `--harvest` ranks the
 * authors of a recent window of busy subreddits by their comment count in it,
 * exactly as `probe-prolific-humans.mjs` does, and then takes evenly-spaced
 * RANKS through the whole ranking — rank 1, and then a fixed stride down into
 * the tail. The stride is arithmetic on the list length, so the sample is
 * settled by the harvest and cannot be steered afterwards by anyone who does
 * not like the answer.
 *
 * HOW THE "AFTER" ARM IS COMPUTED, AND WHY IT IS AN INSTRUMENTED COPY.
 * `axis.js` publishes `band` and `value` and deliberately strips `strength`,
 * so JIO-329's arm cannot be recomputed from a public verdict. Finding 4a's
 * projections were done on a hand-instrumented copy and are therefore not
 * reproducible from anything in the repo. This script makes its own copy
 * instead: it copies `extension/lib/` to a temp directory and rewrites exactly
 * one function body — `stripInternal` becomes the identity — then imports the
 * scorer from there. The real tree is never touched, the transform is a single
 * documented substitution that fails loudly if it does not match, and re-running
 * this command reproduces the numbers.
 *
 * WHAT IT DOES NOT DO. It does not decide who is a person. Band crossings are
 * NAMED and then hand-read with `--read`, which prints bodies to the terminal
 * and writes none to disk — `probe-prolific-humans.mjs`'s rule, kept, because
 * a probe that classified humanity would be answering its own question. The
 * state file it writes for resumability holds counts, timestamps and strengths
 * and no comment text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAccount } from '../extension/lib/sources/arcticShift.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BASE_URL = 'https://arctic-shift.photon-reddit.com';

/** The two signals JIO-329 takes to unmeasured, and the axis's total weight. */
const DROPPED = ['conversation-depth', 'interval-regularity'];
const AXIS_TOTAL_WEIGHT = 15.5;
/** axis.js's own gate, re-stated here so the after-arm can be checked against it. */
const MIN_MEASURED_WEIGHT_FRACTION = 0.5;
const BAND_MODERATE = 30;
const BAND_HIGH = 65;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PAGES = Number(value('--pages', '12'));
const PACE_MS = Number(value('--pace-ms', '1000'));
const SAMPLE = Number(value('--sample', '80'));
const BUDGET_S = Number(value('--budget-s', '480'));
const STATE = value('--state', path.join(os.tmpdir(), 'bot-detector-jio329', 'state.json'));
const SUBS = value('--subs', null)?.split(',').map((s) => s.trim()) ?? [
  'AskReddit', 'AmItheAsshole', 'wallstreetbets', 'nba', 'movies',
  'soccer', 'anime', 'CryptoCurrency', 'stocks', 'baseball',
];

/* ---------------------------------------------------------------- the copy */

/**
 * Copy `extension/lib/` to a temp tree and make `stripInternal` the identity,
 * so `strength` survives into the verdict. The whole `lib/` goes, not just
 * `scoring/`, because the scorers import `../sources/profile.js` by relative
 * path. `profile.js` is pure helpers, so a second copy of it shares no state
 * with the original.
 */
async function instrumentedScorer() {
  const dir = path.join(os.tmpdir(), 'bot-detector-jio329', 'lib');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(path.join(REPO, 'extension', 'lib'), dir, { recursive: true });

  const axisPath = path.join(dir, 'scoring', 'axis.js');
  const before = fs.readFileSync(axisPath, 'utf8');
  const NEEDLE = 'function stripInternal(s) {';
  if (!before.includes(NEEDLE)) {
    throw new Error(`axis.js no longer defines ${NEEDLE} — the instrumentation is stale, fix it here rather than guessing`);
  }
  const after = before.replace(NEEDLE, `${NEEDLE}\n  return Object.freeze(s); // JIO-405 instrumentation: keep strength`);
  fs.writeFileSync(axisPath, after);

  const mod = await import(path.join(dir, 'scoring', 'index.js'));
  // Prove the patch took. A silent no-op here would make every after-arm score
  // identical to its before-arm score and read as "JIO-329 changes nothing".
  const probe = mod.scoreAccount(syntheticProfile());
  if (probe.automation.signals.every((s) => s.strength === undefined)) {
    throw new Error('instrumentation did not take: signals still have no strength');
  }
  return mod.scoreAccount;
}

/** Enough of a profile to prove the instrumentation, and nothing more. */
function syntheticProfile() {
  const now = 1_750_000_000;
  const comments = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`, createdUtc: now - i * 3600, group: 'g', body: `body number ${i} with words`,
    score: 1, threadId: `t${i}`, parentId: null, isTopLevel: i % 2 === 0,
  }));
  return {
    username: 'instrumentation-probe', platform: 'reddit', fetchedAt: now,
    createdUtc: now - 86400 * 900, karma: { comment: 900, post: 90, total: 990 },
    comments, posts: [], coverage: { errors: [] },
  };
}

/* -------------------------------------------------------------- the sample */

let nextSlot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One pacer for every request — arctic-shift answers throttling with a 422. */
async function pacedFetch(url, init) {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + PACE_MS;
  if (wait) await sleep(wait);
  return fetch(url, init);
}

async function getRows(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await pacedFetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (res.ok && body && !body.error) return Array.isArray(body.data) ? body.data : [];
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 30) : 5 * (attempt + 1);
    console.error(`  retry ${attempt}: HTTP ${res.status} ${body?.error ?? ''} — waiting ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error(`gave up on ${url}`);
}

async function harvest() {
  const counts = new Map();
  for (const sub of SUBS) {
    let before = Math.floor(Date.now() / 1000);
    let oldest = before; let newest = 0; let total = 0;
    for (let page = 0; page < PAGES; page += 1) {
      const url = `${BASE_URL}/api/comments/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc&before=${before}`;
      const rows = await getRows(url);
      if (!rows.length) break;
      for (const row of rows) {
        const author = row.author;
        if (!author || author === '[deleted]' || author === '[removed]') continue;
        counts.set(author, (counts.get(author) ?? 0) + 1);
        total += 1;
        oldest = Math.min(oldest, row.created_utc);
        newest = Math.max(newest, row.created_utc);
      }
      before = Math.min(...rows.map((r) => r.created_utc));
      if (rows.length < 100) break;
    }
    console.error(`r/${sub}: ${total} comments over ${((newest - oldest) / 3600).toFixed(1)}h`);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([author, n]) => ({ author, n }));
}

/**
 * Evenly-spaced ranks across the WHOLE ranking. Finding 4a took the top 48;
 * this deliberately does not, because the question is what happens to ordinary
 * people and the top of a volume ranking is nobody ordinary. AutoModerator is
 * dropped for the reason `probe-prolific-humans.mjs` drops it — already frozen
 * in the corpus, and not an account this is asking about.
 */
function stratify(ranked, n) {
  const pool = ranked.filter((r) => r.author !== 'AutoModerator');
  if (pool.length <= n) return pool.map((r, i) => ({ ...r, rank: i + 1 }));
  const picks = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor((i * (pool.length - 1)) / (n - 1));
    picks.push({ ...pool[idx], rank: idx + 1 });
  }
  return picks;
}

/* --------------------------------------------------------------- the state */

function loadState() {
  if (!fs.existsSync(STATE)) return null;
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}

/* --------------------------------------------------------------- the arms */

const bandOf = (score) => (score < BAND_MODERATE ? 'low' : score < BAND_HIGH ? 'moderate' : 'high');

/**
 * Both arms, from ONE instrumented verdict. `buildAxis` is a weighted mean over
 * the measured signals, so the after-arm is that same mean with the two
 * dropped keys removed from numerator and denominator — no second scoring pass
 * and no second copy of the tree. The measured-weight gate is re-applied,
 * because dropping 3.5 of 15.5 can push a thinly-measured account under it and
 * turn a score into `insufficient-data`.
 */
function arms(automation) {
  if (automation.score == null) return { before: null, after: null, signals: [] };
  const measured = automation.signals.filter((s) => s.strength != null);
  const sum = (rows, f) => rows.reduce((a, s) => a + f(s), 0);

  const mwA = sum(measured, (s) => s.weight);
  const scoreA = Math.round((sum(measured, (s) => s.weight * s.strength) / mwA) * 100);

  const kept = measured.filter((s) => !DROPPED.includes(s.key));
  const mwB = sum(kept, (s) => s.weight);
  const gated = !kept.length || mwB / AXIS_TOTAL_WEIGHT < MIN_MEASURED_WEIGHT_FRACTION;
  const scoreB = gated ? null : Math.round((sum(kept, (s) => s.weight * s.strength) / mwB) * 100);

  return {
    before: { score: scoreA, band: bandOf(scoreA), measuredWeight: mwA },
    after: {
      score: scoreB,
      band: scoreB == null ? 'insufficient-data' : bandOf(scoreB),
      measuredWeight: mwB,
      gated,
    },
    signals: automation.signals.map((s) => ({
      key: s.key, weight: s.weight, strength: s.strength ?? null, band: s.band,
    })),
  };
}

async function fetchArm(scoreAccount, state) {
  const deadline = Date.now() + BUDGET_S * 1000;
  const done = new Set(state.rows.map((r) => r.requested));
  const todo = state.sample.filter((s) => !done.has(s.author));
  console.error(`${state.rows.length} already measured, ${todo.length} to go, ${BUDGET_S}s budget\n`);

  for (const entry of todo) {
    if (Date.now() > deadline) {
      console.error(`\nbudget spent — ${todo.length - (state.rows.length - done.size)} still to fetch; re-run --fetch`);
      break;
    }
    process.stderr.write(`+ [rank ${entry.rank}, ${entry.n} in window] ${entry.author} … `);
    let profile;
    try {
      profile = await fetchAccount(entry.author, { fetchImpl: pacedFetch });
    } catch (err) {
      console.error(`FETCH FAILED: ${err.message}`);
      state.rows.push({ requested: entry.author, rank: entry.rank, windowCount: entry.n, error: err.message });
      saveState(state);
      continue;
    }
    if (!profile) {
      console.error('no such account');
      state.rows.push({ requested: entry.author, rank: entry.rank, windowCount: entry.n, error: 'no such account' });
      saveState(state);
      continue;
    }

    const verdict = scoreAccount(profile);
    const a = arms(verdict.automation);
    const rate = verdict.automation.signals.find((s) => s.key === 'sustained-posting-rate');
    state.rows.push({
      requested: entry.author,
      username: profile.username,
      rank: entry.rank,
      windowCount: entry.n,
      comments: profile.comments.length,
      posts: profile.posts.length,
      gatedByHistory: verdict.automation.score == null,
      itemsPerHour: rate?.value?.itemsPerHour ?? null,
      rateFired: rate != null && rate.band !== 'insufficient-data',
      ...a,
    });
    saveState(state);
    console.error(a.before
      ? `${profile.comments.length}c  ${a.before.band} ${a.before.score} -> ${a.after.band} ${a.after.score ?? ''}`
      : 'insufficient-data at the history gate');
  }
}

/* -------------------------------------------------------------- the report */

function report(rows, title, note) {
  console.log(`\n# ${title}`);
  if (note) console.log(`# ${note}`);

  const reached = rows.filter((r) => !r.error);
  const scored = reached.filter((r) => r.before);
  const gatedByHistory = reached.filter((r) => r.gatedByHistory);

  console.log(`\nCOVERAGE. ${rows.length} account(s) in the sample; ${rows.length - reached.length} could not be`);
  console.log(`fetched; ${gatedByHistory.length} returned insufficient-data at the history gate and have no`);
  console.log(`score in either arm; ${scored.length} produced an automation score and are what follows.`);
  if (!scored.length) return;

  const rise = scored.filter((r) => r.after.score != null && r.after.score > r.before.score);
  const fall = scored.filter((r) => r.after.score != null && r.after.score < r.before.score);
  const same = scored.filter((r) => r.after.score != null && r.after.score === r.before.score);
  const lost = scored.filter((r) => r.after.score == null);
  const crossed = scored.filter((r) => r.after.score != null && r.after.band !== r.before.band);

  const deltas = scored.filter((r) => r.after.score != null).map((r) => r.after.score - r.before.score);
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  console.log(`\nDIRECTION. ${rise.length} rise, ${fall.length} fall, ${same.length} unchanged,`);
  console.log(`${lost.length} lose their score entirely to the measured-weight gate.`);
  console.log(`Mean shift ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(1)} points, median ${median >= 0 ? '+' : ''}${median}, worst ${Math.max(...deltas)}.`);

  console.log(`\n${'account'.padEnd(26)}${'rank'.padStart(6)}${'mw'.padStart(6)}${'before'.padStart(14)}${'after'.padStart(16)}${'Δ'.padStart(5)}`);
  for (const r of [...scored].sort((a, b) => (b.after.score ?? -1) - (a.after.score ?? -1))) {
    const d = r.after.score == null ? '—' : `${r.after.score - r.before.score >= 0 ? '+' : ''}${r.after.score - r.before.score}`;
    console.log(
      r.username.padEnd(26)
      + String(r.rank).padStart(6)
      + r.before.measuredWeight.toFixed(1).padStart(6)
      + `${r.before.band} ${r.before.score}`.padStart(14)
      + `${r.after.band} ${r.after.score ?? ''}`.padStart(16)
      + d.padStart(5)
      + (r.after.band !== r.before.band ? '  <-- CROSSES' : ''),
    );
  }

  console.log(`\n${crossed.length} of ${scored.length} scored account(s) cross a band, plus ${lost.length} that lose their score.`);
  for (const r of [...crossed, ...lost]) carried(r);
  return { scored, crossed, lost, rise, fall };
}

/**
 * What carried a crossing. The rise is arithmetic — removing a near-zero from a
 * weighted mean — so the honest answer names the two removed strengths AND the
 * signals whose weight the average now falls on.
 */
function carried(r) {
  const dropped = r.signals.filter((s) => DROPPED.includes(s.key) && s.strength != null);
  console.log(`\n--- ${r.username}: ${r.before.band} ${r.before.score} -> ${r.after.band} ${r.after.score ?? 'insufficient-data'}`);
  if (r.after.score == null) {
    console.log(`    measured weight falls ${r.before.measuredWeight.toFixed(1)} -> ${r.after.measuredWeight.toFixed(1)} of ${AXIS_TOTAL_WEIGHT}`
      + ` = ${(r.after.measuredWeight / AXIS_TOTAL_WEIGHT).toFixed(3)}, under MIN_MEASURED_WEIGHT_FRACTION ${MIN_MEASURED_WEIGHT_FRACTION}.`);
  }
  console.log(`    removed: ${dropped.map((s) => `${s.key} strength ${s.strength.toFixed(3)} (weight ${s.weight})`).join(', ') || 'neither was measured'}`);
  const rest = r.signals.filter((s) => s.strength != null && !DROPPED.includes(s.key))
    .sort((a, b) => b.weight * b.strength - a.weight * a.strength);
  console.log(`    the average now rests on: ${rest.map((s) => `${s.key} ${s.strength.toFixed(2)}×${s.weight}`).join(', ')}`);
  if (r.itemsPerHour != null) {
    console.log(`    sustained-posting-rate: ${r.itemsPerHour.toFixed(2)}/h, ${r.rateFired ? 'FIRED' : 'unmeasured — this crossing is JIO-329 alone'}`);
  }
}

/* ------------------------------------------------------------ frozen arm */

async function corpusArm(scoreAccount) {
  const { loadCorpus } = await import('../test/corpus/load.js');
  const { accounts } = loadCorpus();
  const rows = [];
  for (const entry of accounts) {
    const verdict = scoreAccount(entry.profile);
    const a = arms(verdict.automation);
    const rate = verdict.automation.signals.find((s) => s.key === 'sustained-posting-rate');
    rows.push({
      requested: entry.profile.username,
      username: `${entry.profile.username} [${entry.class === 'bot' ? 'bot' : entry.cohort}]`,
      rank: 0,
      windowCount: 0,
      cohort: entry.cohort,
      class: entry.class,
      gatedByHistory: verdict.automation.score == null,
      itemsPerHour: rate?.value?.itemsPerHour ?? null,
      rateFired: rate != null && rate.band !== 'insufficient-data',
      ...a,
    });
  }
  return rows;
}

/* -------------------------------------------------------------------- cli */

async function main() {
  if (flag('--help')) {
    console.log('node scripts/measure-jio329.mjs [--harvest] [--fetch] [--report] [--corpus] [--read u/a,u/b]');
    console.log('  --pages N --pace-ms N --sample N --budget-s N --subs a,b --state PATH');
    return;
  }

  if (flag('--read')) {
    const names = value('--read', '').split(',').map((s) => s.trim().replace(/^\/?(?:u|user)\//i, ''));
    for (const name of names) {
      const profile = await fetchAccount(name, { fetchImpl: pacedFetch });
      console.log(`\n=== u/${name} — ${profile ? `${profile.comments.length} comments` : 'NOT FOUND'}`);
      for (const c of (profile?.comments ?? []).slice(0, Number(value('--n', '10')))) {
        console.log(`  [${c.group}] ${JSON.stringify((c.body ?? '').slice(0, 200))}`);
      }
    }
    return;
  }

  if (flag('--harvest')) {
    const ranked = await harvest();
    const sample = stratify(ranked, SAMPLE);
    saveState({
      harvestedAt: new Date().toISOString(),
      subs: SUBS, pages: PAGES,
      distinctAuthors: ranked.length,
      totalComments: ranked.reduce((a, r) => a + r.n, 0),
      sample,
      rows: [],
    });
    console.error(`\n${ranked.length} distinct authors; sampled ${sample.length} at ranks `
      + `${sample.slice(0, 4).map((s) => s.rank).join(', ')} … ${sample.at(-1).rank}`);
    console.error(`state: ${STATE}`);
    return;
  }

  if (flag('--corpus')) {
    const scoreAccount = await instrumentedScorer();
    const rows = await corpusArm(scoreAccount);
    report(rows, `frozen corpus under JIO-329 — ${new Date().toISOString()}`,
      'test/corpus/, no network; the arm npm run evaluate would print the day JIO-329 lands');
    return;
  }

  const state = loadState();
  if (!state) throw new Error(`no state at ${STATE} — run --harvest first`);

  if (flag('--fetch')) {
    const scoreAccount = await instrumentedScorer();
    await fetchArm(scoreAccount, state);
  }

  if (flag('--report') || flag('--fetch')) {
    report(state.rows, `measure-jio329 — harvested ${state.harvestedAt}`,
      `r/${state.subs.join(' r/')} · ${state.totalComments} comments · ${state.distinctAuthors} distinct authors · `
      + `${state.sample.length} sampled at even ranks through the whole ranking`);
  }
}

await main();
