/**
 * `node scripts/measure-quoted-titles.mjs` — the live A/B that gates JIO-349.
 *
 *   node scripts/measure-quoted-titles.mjs --sweep --budget-s 480   # resumable, repeat
 *   node scripts/measure-quoted-titles.mjs --profiles --budget-s 480 # resumable, repeat
 *   node scripts/measure-quoted-titles.mjs --report
 *
 * GOES TO THE NETWORK, like `capture-corpus.mjs`, `probe-prolific-humans.mjs`,
 * `measure-jio329.mjs` and `measure-interval-crossing.mjs`, and for the same
 * reason. Run by hand; not part of `npm test` or `npm run evaluate`.
 *
 * WHY IT HAS TO FETCH. JIO-349 stops `stripUrls()` from crediting an account
 * with question marks nobody on that account wrote — inside link text it only
 * listed, or inside a block quote it was replying to.
 * The frozen corpus proves the fix on the bot — u/sneakpeekbot's
 * `asks-questions` goes 97 of 299 to 0 of 299 — and proves nothing at all
 * about the cost, because 19 of the 27 corpus profiles carry length-matched
 * SYNTHETIC bodies (`scripts/lib/synthetic-bodies.mjs`) that contain no
 * markdown links. The one number the Definition of Done names — "human
 * question rates move by no more than JIO-290's 1-2 point tolerance" — is
 * therefore unmeasurable from disk, by construction.
 *
 * TWO ARMS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
 *
 *   --sweep     Every body of a recent window of busy subreddits, A/B'd at the
 *               `stripUrls()` level. This is the BODY rate: how much ordinary
 *               human text the new rule touches at all. Content-blind — it
 *               takes whoever commented, which is the population the tolerance
 *               is about.
 *   --profiles  Whole accounts through the real `fetchAccount`, scored on all
 *               three axes both ways. This is the SCORE move: a body rate of
 *               "0.1% of bodies changed" would still be a problem if those
 *               bodies were concentrated in one person's history, and only a
 *               per-account arm can see that.
 *
 * The sweep's authors are ranked by comment count in the window and the
 * profile arm draws evenly-spaced RANKS from that ranking, so the profile
 * sample is settled by the sweep and cannot be re-drawn by anyone who dislikes
 * the answer. Both arms write to one state file and both are resumable by
 * wall-clock budget, because a measurement nobody can finish in one sitting is
 * a measurement nobody runs.
 *
 * HOW THE "BEFORE" ARM IS COMPUTED. `extension/lib/` is copied to a temp tree
 * and rewritten back to the state of the code before JIO-349: `stripUrls()`'s
 * call to `stripUnauthoredLinkText` becomes the identity, its block-quote
 * strip is removed, and `normalizeWords()` gets back the private copy of that
 * strip it used to carry. The real tree is never touched, every substitution
 * fails loudly if its needle has moved, and the patched copy is PROVEN to
 * differ from the original on a fixture per rule before any number is believed
 * — a silent no-op there would print "nothing moved" and read as a clean
 * result. This is `measure-jio329.mjs`'s device, kept, for the reason it was
 * built: a before-arm reconstructed by hand in the script drifts away from the
 * code it claims to be a copy of.
 *
 * TWO RULES, ATTRIBUTED SEPARATELY. JIO-349 landed in two commits — the link
 * TEXT rule first, the block-quote strip after an audit found the ticket's
 * second Definition-of-Done bullet unmet. The before arm reverts both, because
 * the tolerance the ticket names is about the ticket; but every lost `?` is
 * also re-tested against a quote-strip-only arm, so the report can say which
 * of the two rules took it. A combined number that stays inside tolerance
 * bounds both rules; an attribution is what tells you whether the next one is
 * affordable.
 *
 * WHAT IT DOES NOT DO. It does not decide who is a person. Every account it
 * names is named as an account whose score MOVED, for a human to read; it
 * writes no comment text to disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripUrls, normalizeWords } from '../extension/lib/scoring/stats.js';
import { scoreAccount } from '../extension/lib/scoring/index.js';
import { fetchAccount } from '../extension/lib/sources/arcticShift.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BASE_URL = 'https://arctic-shift.photon-reddit.com';
const AXES = ['automation', 'agenda', 'authenticity'];

/** authenticity.js's list, copied so the sweep can count help-seeking both ways. */
const HELP_SEEKING_PATTERNS = [
  /\bdoes anyone know\b/i,
  /\bcan (?:someone|anyone)\b/i,
  /\bhow do i\b/i,
  /\bany (?:idea|advice|suggestions|recommendations)\b/i,
  /\bam i missing\b/i,
  /\bwhat am i doing wrong\b/i,
  /\bnot sure (?:if|how|what|why)\b/i,
  /\bgenuine question\b/i,
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PAGES = Number(value('--pages', '12'));
const PACE_MS = Number(value('--pace-ms', '900'));
const SAMPLE = Number(value('--sample', '24'));
const BUDGET_S = Number(value('--budget-s', '480'));
const STATE = value('--state', path.join(os.tmpdir(), 'bot-detector-jio349', 'state.json'));
const SUBS = value('--subs', null)?.split(',').map((s) => s.trim()) ?? [
  'AskReddit', 'AmItheAsshole', 'wallstreetbets', 'nba', 'movies',
  'soccer', 'anime', 'CryptoCurrency', 'stocks', 'baseball',
  'todayilearned', 'explainlikeimfive', 'buildapc', 'personalfinance', 'NoStupidQuestions',
];

/* ---------------------------------------------------------------- the copy */

/**
 * Substitutions that walk `extension/lib/scoring/stats.js` back to the code as
 * it stood before JIO-349. Each is asserted present, so a rewrite upstream
 * stops this script rather than silently measuring nothing.
 */
const REVERSIONS = [
  // The block-quote strip, added in JIO-349's second commit. Removing it here
  // also restores the pre-JIO-349 ORDER: nothing was stripped before the link
  // rule ran.
  ["return stripUnauthoredLinkText(text.replace(QUOTED_LINE, ' '))", 'return stripUnauthoredLinkText(text)'],
  // The link TEXT rule, JIO-349's first commit.
  ['return stripUnauthoredLinkText(text)', 'return String(text)'],
  // `normalizeWords()` used to carry its own copy of the quote strip. Put it
  // back, or the before arm understates the AUTOMATION axis rather than
  // measuring it.
  [
    "    .toLowerCase()\n    .replace(/[^a-z0-9'\\s]/g, ' ')",
    "    .toLowerCase()\n    .replace(/^&gt;.*$/gm, ' ')\n    .replace(/^>.*$/gm, ' ')\n    .replace(/[^a-z0-9'\\s]/g, ' ')",
  ],
];

/** The one rule of the two whose cost the audit asked to see attributed. */
const QUOTE_ONLY = [REVERSIONS[0]];

/**
 * Copy `extension/lib/` to a temp tree under `tag/` and apply `reversions`,
 * giving a scoring core identical to today's except for the named rules.
 * Verified against a fixture before it is used.
 */
async function armWith(tag, reversions, fixture) {
  const dir = path.join(os.tmpdir(), 'bot-detector-jio349', tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(path.join(REPO, 'extension', 'lib'), dir, { recursive: true });

  const statsPath = path.join(dir, 'scoring', 'stats.js');
  let src = fs.readFileSync(statsPath, 'utf8');
  for (const [needle, replacement] of reversions) {
    if (!src.includes(needle)) {
      throw new Error(`stats.js no longer contains ${JSON.stringify(needle)} — this substitution is stale, fix it here rather than guessing`);
    }
    src = src.replace(needle, replacement);
  }
  fs.writeFileSync(statsPath, src);

  const mod = await import(path.join(dir, 'scoring', 'index.js'));
  const stats = await import(path.join(dir, 'scoring', 'stats.js'));

  // Prove the patch took. A silent no-op here would make every before-arm
  // number identical to its after-arm number and read as "nothing moved".
  if (!stats.stripUrls(fixture).includes('?')) {
    throw new Error(`the ${tag} arm still strips this: the substitution did not take`);
  }
  if (stripUrls(fixture).includes('?')) {
    throw new Error(`the after-arm does NOT strip this: there is nothing here to measure (${tag})`);
  }
  return { scoreAccount: mod.scoreAccount, stripUrls: stats.stripUrls, normalizeWords: stats.normalizeWords };
}

/** Both JIO-349 rules reverted — the arm the ticket's tolerance is about. */
const beforeArm = () => armWith(
  'lib',
  REVERSIONS,
  '\\#1: [Is this a question?](https://example.com/a) | [3 comments](https://example.com/b)',
);

/** Only the block-quote strip reverted, so a lost `?` can be attributed. */
const quoteOnlyArm = () => armWith('lib-quote', QUOTE_ONLY, '>Is this a question?\nno.');

/* ------------------------------------------------------------- the network */

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

/* ------------------------------------------------------------------- state */

function readState() {
  if (!fs.existsSync(STATE)) return null;
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 1)}\n`);
  console.error(`state -> ${STATE}`);
}

function emptyState() {
  return {
    startedAt: new Date().toISOString(),
    subs: SUBS,
    pages: PAGES,
    sweep: {
      done: [], bodies: 0, changed: 0, questionsBefore: 0, questionsAfter: 0, questionsLost: 0,
      helpBefore: 0, helpAfter: 0, wordsBefore: 0, wordsAfter: 0, byAuthor: {}, examples: [],
      // Attribution of the two rules. `quotedBodies` is how much of ordinary
      // human text the quote strip can reach at all; `lostToQuote` is how much
      // of `questionsLost` it, rather than the link rule, accounts for.
      quotedBodies: 0, lostToQuote: 0, lostToLinkText: 0,
    },
    profiles: { sample: [], rows: [] },
  };
}

/* ------------------------------------------------------------------- sweep */

/**
 * Page each subreddit's recent comments and A/B every body. Resumable at
 * subreddit granularity: `sweep.done` names the ones already folded in, so a
 * second call continues rather than double-counting.
 */
async function sweep(state, before, quoteOnly) {
  const deadline = Date.now() + BUDGET_S * 1000;
  const s = state.sweep;
  for (const sub of SUBS) {
    if (s.done.includes(sub)) continue;
    if (Date.now() > deadline) {
      console.error(`budget spent — ${SUBS.length - s.done.length} subreddits left, run --sweep again`);
      return false;
    }
    let cursor = Math.floor(Date.now() / 1000);
    let seen = 0;
    for (let page = 0; page < PAGES; page += 1) {
      const url = `${BASE_URL}/api/comments/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc&before=${cursor}`;
      const rows = await getRows(url);
      if (!rows.length) break;
      for (const row of rows) {
        const body = row.body;
        const author = row.author;
        if (typeof body !== 'string' || !body.length) continue;
        if (!author || author === '[deleted]' || author === '[removed]') continue;
        seen += 1;
        s.bodies += 1;

        if (/^(?:&gt;|>)/im.test(body)) s.quotedBodies += 1;

        const oldText = before.stripUrls(body);
        const newText = stripUrls(body);
        const oldQ = oldText.includes('?');
        const newQ = newText.includes('?');
        if (oldQ) s.questionsBefore += 1;
        if (newQ) s.questionsAfter += 1;
        if (oldQ && !newQ) {
          s.questionsLost += 1;
          // Which of the two rules took it. The quote-only arm still runs the
          // link rule, so a `?` it also loses is one the link rule already had;
          // a `?` it KEEPS is one only the quote strip removes.
          if (quoteOnly.stripUrls(body).includes('?')) s.lostToQuote += 1;
          else s.lostToLinkText += 1;
          if (s.examples.length < 25) s.examples.push({ author, sub, len: body.length });
        }
        if (HELP_SEEKING_PATTERNS.some((re) => re.test(oldText))) s.helpBefore += 1;
        if (HELP_SEEKING_PATTERNS.some((re) => re.test(newText))) s.helpAfter += 1;
        s.wordsBefore += before.normalizeWords(body).length;
        s.wordsAfter += normalizeWords(body).length;
        if (oldText !== newText) s.changed += 1;

        const a = (s.byAuthor[author] ??= { n: 0, before: 0, after: 0 });
        a.n += 1;
        if (oldQ) a.before += 1;
        if (newQ) a.after += 1;
      }
      cursor = Math.min(...rows.map((r) => r.created_utc));
      if (rows.length < 100) break;
    }
    s.done.push(sub);
    console.error(`r/${sub}: ${seen} bodies (${s.bodies} total, ${s.changed} changed)`);
    writeState(state);
  }
  return true;
}

/* ---------------------------------------------------------------- profiles */

/** Evenly-spaced ranks through the sweep's whole author ranking, rank 1 first. */
function drawSample(byAuthor, size) {
  const ranked = Object.entries(byAuthor)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([author]) => author);
  if (ranked.length <= size) return ranked;
  const stride = Math.floor(ranked.length / size);
  return Array.from({ length: size }, (_, i) => ranked[i * stride]);
}

async function profiles(state, before) {
  const deadline = Date.now() + BUDGET_S * 1000;
  if (!state.profiles.sample.length) {
    state.profiles.sample = drawSample(state.sweep.byAuthor, SAMPLE);
    writeState(state);
  }
  const done = new Set(state.profiles.rows.map((r) => r.username));
  for (const username of state.profiles.sample) {
    if (done.has(username)) continue;
    if (Date.now() > deadline) {
      console.error(`budget spent — ${state.profiles.sample.length - done.size} profiles left, run --profiles again`);
      return false;
    }
    let profile;
    try {
      profile = await fetchAccount(username, { fetchImpl: pacedFetch });
    } catch (err) {
      console.error(`  ${username}: ${err.message}`);
      state.profiles.rows.push({ username, error: String(err.message) });
      done.add(username);
      writeState(state);
      continue;
    }
    if (!profile) {
      console.error(`  ${username}: no such account`);
      state.profiles.rows.push({ username, error: 'not found' });
      done.add(username);
      writeState(state);
      continue;
    }
    const a = before.scoreAccount(profile);
    const b = scoreAccount(profile);
    const q = (v) => v.authenticity.signals.find((s) => s.key === 'asks-questions')?.value ?? {};
    state.profiles.rows.push({
      username,
      comments: profile.comments.length,
      before: Object.fromEntries(AXES.map((x) => [x, { band: a[x].band, score: a[x].score }])),
      after: Object.fromEntries(AXES.map((x) => [x, { band: b[x].band, score: b[x].score }])),
      questionsBefore: q(a).questions ?? null,
      questionsAfter: q(b).questions ?? null,
      questionSample: q(a).sample ?? null,
    });
    done.add(username);
    const row = state.profiles.rows.at(-1);
    console.error(`  ${username}: questions ${row.questionsBefore} -> ${row.questionsAfter} of ${row.questionSample}`);
    writeState(state);
  }
  return true;
}

/* ------------------------------------------------------------------ report */

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(2)}%` : 'n/a');

function report(state) {
  const s = state.sweep;
  console.log(`measure-quoted-titles — JIO-349, started ${state.startedAt}`);
  console.log(`  subreddits swept: ${s.done.length} of ${state.subs.length} (${s.done.join(', ') || 'none'})`);
  console.log('');
  console.log('BODY ARM — every body of the window, A/B\'d at stripUrls()');
  console.log(`  bodies                    ${s.bodies}`);
  console.log(`  bodies whose text changed ${s.changed} (${pct(s.changed, s.bodies)})`);
  console.log(`  read as a question before  ${s.questionsBefore} (${pct(s.questionsBefore, s.bodies)})`);
  console.log(`  read as a question after   ${s.questionsAfter} (${pct(s.questionsAfter, s.bodies)})`);
  console.log(`  questions lost            ${s.questionsLost} (${pct(s.questionsLost, s.bodies)} of bodies, ${pct(s.questionsLost, s.questionsBefore)} of questions)`);
  console.log(`    of which the quote strip ${s.lostToQuote}; the link-text rule ${s.lostToLinkText}`);
  console.log(`  bodies carrying a > line  ${s.quotedBodies} (${pct(s.quotedBodies, s.bodies)})`);
  console.log(`  help-seeking before/after ${s.helpBefore} / ${s.helpAfter}`);
  console.log(`  normalizeWords tokens     ${s.wordsBefore} -> ${s.wordsAfter} (${pct(s.wordsBefore - s.wordsAfter, s.wordsBefore)} removed)`);

  const authors = Object.entries(s.byAuthor);
  const moved = authors.filter(([, a]) => a.before !== a.after);
  console.log('');
  console.log(`  authors in the window: ${authors.length}; authors whose question count moved: ${moved.length}`);
  const worst = moved
    .map(([author, a]) => [author, a, Math.abs(a.before - a.after) / a.n])
    .sort((x, y) => y[2] - x[2])
    .slice(0, 10);
  for (const [author, a, drift] of worst) {
    console.log(`    u/${author}: ${a.before} -> ${a.after} of ${a.n} in-window bodies (${(drift * 100).toFixed(1)} points)`);
  }

  const rows = state.profiles.rows.filter((r) => !r.error);
  console.log('');
  console.log(`PROFILE ARM — whole accounts, all three axes both ways (${rows.length} scored, ${state.profiles.rows.length - rows.length} failed)`);
  let movedScores = 0;
  let movedBands = 0;
  for (const r of rows) {
    const deltas = AXES
      .filter((x) => r.before[x].score !== r.after[x].score || r.before[x].band !== r.after[x].band)
      .map((x) => `${x} ${r.before[x].band} ${r.before[x].score} -> ${r.after[x].band} ${r.after[x].score}`);
    const qMoved = r.questionsBefore !== r.questionsAfter;
    if (deltas.length) movedScores += 1;
    movedBands += AXES.filter((x) => r.before[x].band !== r.after[x].band).length;
    if (deltas.length || qMoved) {
      const q = `questions ${r.questionsBefore} -> ${r.questionsAfter} of ${r.questionSample}`;
      console.log(`  u/${r.username} (${r.comments} comments): ${q}${deltas.length ? ` | ${deltas.join(' | ')}` : ''}`);
    }
  }
  console.log(`  accounts with any axis score moved: ${movedScores} of ${rows.length}`);
  console.log(`  BAND crossings: ${movedBands}`);
  const qPoints = rows
    .filter((r) => r.questionSample)
    .map((r) => Math.abs(r.questionsBefore - r.questionsAfter) / r.questionSample);
  if (qPoints.length) {
    console.log(`  largest asks-questions move: ${(Math.max(...qPoints) * 100).toFixed(1)} points (DoD tolerance: 1-2)`);
  }
}

/* -------------------------------------------------------------------- main */

const wants = flag('--sweep') || flag('--profiles') || flag('--report');
if (!wants) {
  console.log('node scripts/measure-quoted-titles.mjs [--sweep] [--profiles] [--report] [--budget-s N]');
  process.exit(2);
}

let state = readState() ?? emptyState();

if (flag('--sweep') || flag('--profiles')) {
  const before = await beforeArm();
  if (flag('--sweep')) await sweep(state, before, await quoteOnlyArm());
  if (flag('--profiles')) {
    if (!state.sweep.done.length) throw new Error('--profiles draws its sample from the sweep; run --sweep first');
    await profiles(state, before);
  }
  writeState(state);
  state = readState();
}

report(state);
