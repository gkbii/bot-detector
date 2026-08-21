/**
 * `node scripts/measure-jio329.mjs` — the live re-measure that gates JIO-329.
 *
 *   node scripts/measure-jio329.mjs --harvest            # content-blind ranking
 *   node scripts/measure-jio329.mjs --fetch --budget-s 500   # resumable, repeat
 *   node scripts/measure-jio329.mjs --report
 *   node scripts/measure-jio329.mjs --resample --from A.json --rule top --state B.json
 *   node scripts/measure-jio329.mjs --variants           # the weight choice, no network
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
 * AND THE HARVEST KEEPS THE WHOLE RANKING, not just the sample it drew from it.
 * The first cut stored only the 80 picks, so asking a second question of the
 * same window — the TOP of the ranking, Finding 4a's population — meant either
 * re-harvesting into a different window or a throwaway script, and the audit
 * that first ran this needed exactly that and wrote one. `--resample` re-draws
 * from a harvest already on disk with no network at all, so the two live arms
 * below are two samples of ONE window rather than two windows, and the
 * comparison between them is about the population and not about the day.
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
 * WHY IT ALSO SCORES THE VARIANTS JIO-329 DID NOT PICK. "Drop both signals" is
 * one of four ways to spend the 3.5 weight, and a measurement that only scores
 * the chosen one cannot justify it over the others. `--variants` replays every
 * drop-set against rows already on disk — no network, no re-fetch — so the
 * question "would dropping just one have cost less?" is answered with the same
 * accounts rather than with an argument.
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
const RULE = value('--rule', 'even');
/** Names to add to a sample whatever rank they landed at, for continuity with an earlier arm. */
const INCLUDE = value('--include', '').split(',').map((s) => s.trim().replace(/^\/?(?:u|user)\//i, '')).filter(Boolean);
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
 * Draw a sample from a ranking. `even` takes evenly-spaced ranks across the
 * WHOLE ranking, which is this script's own question: what happens to ordinary
 * people, of whom the top of a volume ranking holds none. `top` takes the head
 * of it, which is Finding 4a's population and is here so the two can be
 * compared within one window rather than across two. AutoModerator is dropped
 * for the reason `probe-prolific-humans.mjs` drops it — already frozen in the
 * corpus, and not an account this is asking about.
 *
 * `--include` appends named accounts at whatever rank they actually hold, so an
 * arm can carry an earlier finding's accounts forward. They are marked, because
 * a hand-picked row in a content-blind sample is exactly the row that must not
 * be counted as though the sampler had found it.
 */
function draw(ranked, n, rule) {
  const pool = ranked.filter((r) => r.author !== 'AutoModerator');
  const picks = [];
  if (rule === 'top') {
    picks.push(...pool.slice(0, n).map((r, i) => ({ ...r, rank: i + 1 })));
  } else if (rule === 'even') {
    if (pool.length <= n) picks.push(...pool.map((r, i) => ({ ...r, rank: i + 1 })));
    else {
      for (let i = 0; i < n; i += 1) {
        const idx = Math.floor((i * (pool.length - 1)) / (n - 1));
        picks.push({ ...pool[idx], rank: idx + 1 });
      }
    }
  } else {
    throw new Error(`--rule must be 'even' or 'top', not ${JSON.stringify(rule)}`);
  }

  for (const author of INCLUDE) {
    if (picks.some((p) => p.author === author)) continue;
    const idx = pool.findIndex((p) => p.author === author);
    if (idx < 0) {
      console.error(`  --include ${author}: not in this window's ranking at all; adding at rank -1`);
      picks.push({ author, n: 0, rank: -1, included: true });
    } else {
      picks.push({ ...pool[idx], rank: idx + 1, included: true });
    }
  }
  return picks;
}

/* --------------------------------------------------------------- the state */

function loadState() {
  if (!fs.existsSync(STATE)) return null;
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}

/** A fresh state: the whole ranking, the sample drawn from it, and no rows yet. */
function stateFrom(ranked, provenance) {
  const sample = draw(ranked, SAMPLE, RULE);
  const included = sample.filter((s) => s.included).length;
  console.error(`\n${ranked.length} distinct authors; --rule ${RULE} sampled ${sample.length - included} at ranks `
    + `${sample.slice(0, 4).map((s) => s.rank).join(', ')} … ${sample[sample.length - 1 - included].rank}`
    + (included ? `, plus ${included} named by --include` : ''));
  console.error(`state: ${STATE}`);
  return {
    ...provenance,
    rule: RULE,
    distinctAuthors: ranked.length,
    totalComments: ranked.reduce((a, r) => a + r.n, 0),
    ranked,
    sample,
    rows: [],
  };
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
function project(signals, dropped) {
  const sum = (rows, f) => rows.reduce((a, s) => a + f(s), 0);
  const kept = signals.filter((s) => s.strength != null && !dropped.includes(s.key));
  const mw = sum(kept, (s) => s.weight);
  const gated = !kept.length || mw / AXIS_TOTAL_WEIGHT < MIN_MEASURED_WEIGHT_FRACTION;
  const score = gated ? null : Math.round((sum(kept, (s) => s.weight * s.strength) / mw) * 100);
  return { score, band: score == null ? 'insufficient-data' : bandOf(score), measuredWeight: mw, gated };
}

function arms(automation) {
  if (automation.score == null) return { before: null, after: null, signals: [] };
  const signals = automation.signals.map((s) => ({
    key: s.key, weight: s.weight, strength: s.strength ?? null, band: s.band,
  }));
  // The before-arm drops nothing, so its gate cannot fire — axis.js already
  // reported a score, which is what `automation.score != null` above means.
  const before = project(signals, []);
  return { before: { score: before.score, band: before.band, measuredWeight: before.measuredWeight },
    after: project(signals, DROPPED), signals };
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

/* ------------------------------------------------------------- variants */

/**
 * The four ways to spend the 3.5 weight, replayed against rows already on disk.
 * `signals` carries every strength, so no account is re-fetched and no second
 * scoring pass runs — this is the same arithmetic axis.js does, with a
 * different set of keys removed from numerator and denominator.
 */
const VARIANTS = [
  { label: 'today (drop nothing)', dropped: [] },
  { label: 'drop conversation-depth (1.5)', dropped: ['conversation-depth'] },
  { label: 'drop interval-regularity (2)', dropped: ['interval-regularity'] },
  { label: 'JIO-329: drop both (3.5)', dropped: DROPPED },
];

function variants(rows, title) {
  const scored = rows.filter((r) => !r.error && r.before && r.signals?.length);
  console.log(`\n# variants — ${title}`);
  console.log(`# ${scored.length} scored account(s); every column is recomputed from the same stored strengths`);
  if (!scored.length) return;

  // Where the class is known, the mean shift on its own says nothing: what
  // matters is whether the bots move further than the people, because that
  // difference IS the axis's discriminating power. So it is split.
  const known = scored.filter((r) => r.class);
  const signed = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
  console.log(`\n${'variant'.padEnd(32)}${'rise'.padStart(6)}${'fall'.padStart(6)}${'mean'.padStart(7)}`
    + `${'gated'.padStart(7)}${'crossings'.padStart(11)}`
    + (known.length ? `${'human'.padStart(8)}${'max'.padStart(5)}${'bot'.padStart(8)}${'min'.padStart(5)}${'gap'.padStart(6)}` : ''));

  const detail = [];
  for (const v of VARIANTS) {
    const proj = scored.map((r) => ({ r, base: project(r.signals, []), now: project(r.signals, v.dropped) }));
    const live = proj.filter((p) => p.now.score != null);
    const deltas = live.map((p) => p.now.score - p.base.score);
    const mean = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
    const crossed = live.filter((p) => p.now.band !== p.base.band);

    let classCols = '';
    if (known.length) {
      const of = (cls) => live.filter((p) => p.r.class === cls);
      const meanOf = (rows) => rows.reduce((a, p) => a + (p.now.score - p.base.score), 0) / (rows.length || 1);
      const humanMax = Math.max(...of('human').map((p) => p.now.score));
      const botMin = Math.min(...of('bot').map((p) => p.now.score));
      classCols = signed(meanOf(of('human'))).padStart(8) + String(humanMax).padStart(5)
        + signed(meanOf(of('bot'))).padStart(8) + String(botMin).padStart(5)
        + String(botMin - humanMax).padStart(6);
    }

    console.log(v.label.padEnd(32)
      + String(deltas.filter((d) => d > 0).length).padStart(6)
      + String(deltas.filter((d) => d < 0).length).padStart(6)
      + signed(mean).padStart(7)
      + String(proj.length - live.length).padStart(7)
      + String(crossed.length).padStart(11)
      + classCols);
    detail.push({ v, crossed });
  }

  for (const { v, crossed } of detail) {
    if (!crossed.length) continue;
    console.log(`\n  ${v.label} — who crosses:`);
    for (const p of crossed) {
      console.log(`    ${p.r.username.padEnd(34)} ${p.base.band} ${p.base.score} -> ${p.now.band} ${p.now.score}`);
    }
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
    console.log('node scripts/measure-jio329.mjs [--harvest] [--resample --from PATH] [--fetch]');
    console.log('  [--report] [--variants] [--corpus] [--corpus --variants] [--read u/a,u/b]');
    console.log('  --pages N --pace-ms N --sample N --rule even|top --include u/a,u/b');
    console.log('  --budget-s N --subs a,b --state PATH');
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
    saveState(stateFrom(ranked, {
      harvestedAt: new Date().toISOString(), subs: SUBS, pages: PAGES,
    }));
    return;
  }

  // Re-draw from a harvest already on disk. No network: the whole point is that
  // a second question about the SAME window costs nothing and cannot silently
  // become a question about a different day.
  if (flag('--resample')) {
    const from = value('--from', null);
    if (!from) throw new Error('--resample needs --from <state written by --harvest>');
    const src = JSON.parse(fs.readFileSync(from, 'utf8'));
    if (!src.ranked) {
      throw new Error(`${from} was written before the harvest kept its ranking; re-harvest to resample from it`);
    }
    const existing = loadState();
    if (existing?.rows?.length) {
      throw new Error(`${STATE} already holds ${existing.rows.length} fetched row(s) — resampling would orphan them; pass --state <new path>`);
    }
    saveState(stateFrom(src.ranked, {
      harvestedAt: src.harvestedAt, subs: src.subs, pages: src.pages, resampledFrom: from,
    }));
    return;
  }

  if (flag('--corpus')) {
    const scoreAccount = await instrumentedScorer();
    const rows = await corpusArm(scoreAccount);
    if (flag('--variants')) variants(rows, 'frozen corpus, test/corpus/');
    else {
      report(rows, `frozen corpus under JIO-329 — ${new Date().toISOString()}`,
        'test/corpus/, no network; the arm npm run evaluate would print the day JIO-329 lands');
    }
    return;
  }

  const state = loadState();
  if (!state) throw new Error(`no state at ${STATE} — run --harvest first`);

  if (flag('--fetch')) {
    const scoreAccount = await instrumentedScorer();
    await fetchArm(scoreAccount, state);
  }

  const provenance = `r/${state.subs.join(' r/')} · ${state.totalComments} comments · ${state.distinctAuthors} `
    + `distinct authors · ${state.sample.length} sampled, --rule ${state.rule ?? 'even'}`;

  if (flag('--variants')) {
    variants(state.rows, `${provenance}, harvested ${state.harvestedAt}`);
    return;
  }

  if (flag('--report') || flag('--fetch')) {
    report(state.rows, `measure-jio329 — harvested ${state.harvestedAt}`, provenance);
  }
}

await main();
