/**
 * The frozen evaluation corpus, as a test (JIO-343).
 *
 * `test/corpus/` holds 27 serialised `buildProfile` outputs — the 17 thread
 * humans and 8 declared bots behind EVALUATION.md's headline band table, plus
 * the 2 prolific humans of Finding 4a. This file asserts that today's scorers
 * still produce that table, which is the thing the 2026-08-05 live run could
 * never leave behind: no profile was kept from it, so "the separation is not
 * regressed" was a claim with no command under it and every reweighting
 * proposed afterwards was unfalsifiable.
 *
 * Three separate things are checked, and they fail for different reasons:
 *
 *   1. EVERY ACCOUNT'S THREE SCORES, to the point. Catches a reweighting that
 *      moved a number. Update with `npm run evaluate -- --update` AFTER
 *      reading the accounts, never to make the suite go green.
 *   2. THE TWO SEPARATION INVARIANTS — no human above `low` on automation, no
 *      bot at `low`. Catches a change that kept the scores plausible and
 *      destroyed the only result EVALUATION.md actually claimed.
 *   3. THE CORPUS ITSELF — that each bot still declares itself a bot in its
 *      own committed text, that each prolific human still sustains the rate it
 *      was admitted for, and that the synthetic-body machinery still preserves
 *      what it says it preserves.
 *
 * NO NETWORK, and the suite still runs with no `node_modules`: everything here
 * is `node:test`, `node:fs` and JSON.
 *
 * WHAT IT CANNOT DO. It compares today's code against a fixed input. It is
 * blind to the archive changing, to the fetch window changing, and to both
 * classes of bug this repo has actually shipped — the forged 12-year dormancy
 * and the unbound `fetch` — which passed a green suite. It is a regression
 * check, not an evaluation. Re-capture and re-read by hand before claiming
 * anything about live behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreAccount } from '../extension/lib/scoring/index.js';
import { normalizeWords, stripUrls } from '../extension/lib/scoring/stats.js';
import { AXES, COHORTS, loadCorpus, loadExpected } from './corpus/load.js';
import { EVALUATION_MD_BOTS, declarationBasis } from '../scripts/lib/bot-declaration.mjs';
import {
  HELP_SEEKING_CANONICAL, SELF_CORRECTION_CANONICAL, bodyMeasurements, synthesizeBody,
} from '../scripts/lib/synthetic-bodies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  accounts, bots, humans, threadHumans, prolificHumans,
} = loadCorpus();
const expected = loadExpected();

// One scoring pass for the whole file. `scoreAccount` is pure, so caching it
// changes nothing about what is asserted — but `near-duplicate-bodies` is a
// pairwise Jaccard over 200 comments and four tests scoring 25 accounts each
// would put seconds on a suite that runs in under one.
const verdicts = new Map(accounts.map((a) => [a.username, scoreAccount(a.profile)]));
const verdictOf = (account) => verdicts.get(account.username);

test('the corpus is the population EVALUATION.md scored: 17 thread humans, 8 declared bots', () => {
  assert.equal(threadHumans.length, 17);
  assert.equal(bots.length, 8);
});

/**
 * The cohorts are counted SEPARATELY and the total is asserted against their
 * sum, so an account can never join one population by being quietly missing
 * from another. `loadCorpus` already refuses an unknown cohort; this is the
 * other half — a file that lost its cohort field cannot vanish from the table
 * while `accounts.length` still looks right.
 */
test('every account belongs to exactly one of the three cohorts, and they add up', () => {
  const counts = { [COHORTS.THREAD]: 0, [COHORTS.PROLIFIC]: 0, [COHORTS.BOT]: 0 };
  for (const account of accounts) counts[account.cohort] += 1;
  assert.deepEqual(counts, { [COHORTS.THREAD]: 17, [COHORTS.PROLIFIC]: 2, [COHORTS.BOT]: 8 });
  assert.equal(accounts.length, 27);
  assert.equal(humans.length, threadHumans.length + prolificHumans.length,
    'both human cohorts must be inside `humans`, or the separation invariant stops covering one of them');
  for (const account of prolificHumans) assert.equal(account.class, 'human');
  for (const account of bots) assert.equal(account.cohort, COHORTS.BOT);
});

/**
 * WHY THIS COHORT EXISTS, as a test rather than as a comment (JIO-344).
 *
 * README used to say the gate at `ORDINARY_ITEMS_PER_HOUR = 3` "sits in the
 * gap" between people and bots. It does not: a content-blind sweep found six
 * people above it, one of them faster than u/RemindMeBot (EVALUATION.md
 * Finding 4a). What actually keeps those people `low` is the SHAPE of the
 * signal — one-directional, floored at 0.5, log-scaled, weight 2 of 15.5 — and
 * a claim about shape is exactly the kind that stays true-sounding after it
 * stops being true. So it is pinned to two real profiles.
 *
 * If this fails, something made the axis harsher on a person the tool is
 * likelier to be pointed at than any bot. HAND-READ THE ACCOUNT before
 * touching either the threshold or this test.
 */
test('a prolific human fires the rate signal and STILL scores automation low', () => {
  assert.ok(prolificHumans.length, 'the corpus no longer holds a >3/h human — Finding 4a is unfalsifiable again');

  for (const account of prolificHumans) {
    const verdict = verdictOf(account);
    const rate = verdict.automation.signals.find((sig) => sig.key === 'sustained-posting-rate');

    // Admitted for a rate, so the rate has to still be there. An account that
    // drifted under the gate would sit in the corpus pinning nothing while
    // every count above it still added up.
    assert.ok(rate, `${account.username} has no sustained-posting-rate signal at all`);
    assert.notEqual(rate.band, 'insufficient-data',
      `${account.username} no longer fires the signal it was admitted for (${rate.value?.itemsPerHour?.toFixed(2) ?? '—'}/h)`);
    assert.ok(rate.value.itemsPerHour > 3,
      `${account.username} sustains ${rate.value.itemsPerHour.toFixed(2)}/h, which is not above the gate`);

    // The finding itself.
    assert.equal(verdict.automation.band, 'low',
      `${account.username} sustains ${rate.value.itemsPerHour.toFixed(2)}/h and now scores automation ${verdict.automation.band} ${verdict.automation.score} — a person crossed a band`);
  }

  // u/humdingler at 5.90/h is the specific account that refutes the "gap":
  // faster than u/RemindMeBot at 5.5/h, so the two populations overlap and no
  // value of ORDINARY_ITEMS_PER_HOUR separates them.
  const fastest = prolificHumans
    .map((a) => verdictOf(a).automation.signals.find((sig) => sig.key === 'sustained-posting-rate'))
    .reduce((a, b) => (b.value.itemsPerHour > a.value.itemsPerHour ? b : a));
  const slowestBot = bots
    .map((a) => verdictOf(a).automation.signals.find((sig) => sig.key === 'sustained-posting-rate'))
    .filter((sig) => sig && sig.band !== 'insufficient-data')
    .reduce((a, b) => (b.value.itemsPerHour < a.value.itemsPerHour ? b : a));
  assert.ok(fastest.value.itemsPerHour > slowestBot.value.itemsPerHour,
    `the fastest frozen human (${fastest.value.itemsPerHour.toFixed(2)}/h) no longer overlaps the slowest frozen bot (${slowestBot.value.itemsPerHour.toFixed(2)}/h) — if this is real and not a re-capture artifact, README's rewritten threshold section needs re-reading`);
});

test('every frozen account still scores exactly what expected.json records', () => {
  assert.ok(expected, 'test/corpus/expected.json is missing — run: npm run evaluate -- --update');
  for (const account of accounts) {
    const verdict = verdictOf(account);
    const want = expected.byUsername[account.username];
    assert.ok(want, `${account.username} is in the corpus but not in expected.json`);
    for (const axis of AXES) {
      assert.deepEqual(
        { band: verdict[axis].band, score: verdict[axis].score },
        want[axis],
        `${account.username} ${axis} moved`,
      );
    }
  }
  assert.equal(Object.keys(expected.byUsername).length, accounts.length,
    'expected.json names accounts the corpus no longer holds');
});

test('the headline separation holds: no human above low automation, no bot at low', () => {
  for (const account of humans) {
    const { band, score } = verdictOf(account).automation;
    assert.equal(band, 'low', `human ${account.username} scores automation ${band} ${score}`);
  }
  for (const account of bots) {
    const { band, score } = verdictOf(account).automation;
    assert.notEqual(band, 'low', `declared bot ${account.username} scores automation low ${score}`);
    assert.notEqual(band, 'insufficient-data', `declared bot ${account.username} is unscored`);
  }
});

/**
 * The bot label is RE-DERIVED from the committed bodies rather than trusted
 * from the file that claims it. A frozen "ground truth" nobody re-checks is a
 * string somebody typed once — the same reason `server/agenda.js` resolves
 * every LLM citation against the evidence pack instead of believing it.
 */
test('every declared bot is admitted on a basis this repo can still re-check', () => {
  for (const account of bots) {
    assert.equal(account.bodies, 'real', `${account.username} must keep its real bodies to stay checkable`);
    const basis = declarationBasis(account.username, account.profile.comments);
    assert.ok(basis.admitted, `${account.username}: ${basis.note}`);
    assert.equal(basis.basis, account.declaredBy,
      `${account.username} is filed as ${account.declaredBy} but re-checks as ${basis.basis}`);
  }
});

/**
 * The citation basis is a bounded exception, not a back door: only the four
 * accounts EVALUATION.md hand-read may use it, and everything else in the bot
 * half has to say so in its own words.
 */
test('at most the four EVALUATION.md bots lean on the hand-read rather than their own text', () => {
  const cited = bots.filter((b) => b.declaredBy === 'evaluation-md');
  assert.ok(cited.length <= 4, `${cited.length} bots admitted by citation`);
  for (const b of cited) {
    assert.ok(Object.hasOwn(EVALUATION_MD_BOTS, b.username),
      `${b.username} is admitted by citation but EVALUATION.md does not name it`);
  }
  const selfDeclared = bots.filter((b) => b.declaredBy === 'self-declaration');
  assert.equal(cited.length + selfDeclared.length, bots.length, 'a bot is filed under neither basis');
});

test('human bodies are synthetic, bot bodies are real', () => {
  for (const account of humans) assert.equal(account.bodies, 'synthesised-length-matched');
  for (const account of bots) assert.equal(account.bodies, 'real');
});

// ---------------------------------------------------------------------------
// The synthesis, tested on its own terms. If these break, the human half of
// the corpus stops measuring what the live accounts measured — silently,
// because the scores would simply be different numbers that still look fine.
// ---------------------------------------------------------------------------

const SYNTHESIS_CASES = [
  'lol',
  '',
  'Fair point, I misread that — see https://example.com/a?b=2',
  'Does anyone know how this works? Not sure if it does.',
  '&gt; quoted line\n\nThat is a very long reply with several clauses, none of which matter here.',
  '[link](https://x.com/y?z=1)',
  'TIL that the thing I said upthread was wrong, my mistake.',
  'TIL.',
  'Correction',
  'Fair enough?',
  'a'.repeat(4000),
];

test('synthesised bodies preserve length, word count, question marks and both phrase signals', () => {
  for (const real of SYNTHESIS_CASES) {
    const { body, warnings } = synthesizeBody(real, `seed:${real.length}`);
    assert.deepEqual(warnings, [], `warnings for ${JSON.stringify(real.slice(0, 40))}`);
    assert.deepEqual(bodyMeasurements(body), bodyMeasurements(real),
      `measurements differ for ${JSON.stringify(real.slice(0, 40))}`);
  }
});

test('synthesis is deterministic: same account, same comment, same bytes', () => {
  const a = synthesizeBody('Some ordinary sentence about nothing in particular.', 'u/x:abc');
  const b = synthesizeBody('Some ordinary sentence about nothing in particular.', 'u/x:abc');
  const c = synthesizeBody('Some ordinary sentence about nothing in particular.', 'u/x:abd');
  assert.equal(a.body, b.body);
  assert.notEqual(a.body, c.body);
});

test('synthesised bodies say nothing: no real comment text survives', () => {
  // Every synthetic word is either lexicon filler or one of the canonical
  // phrases, so a synthesised corpus cannot leak a sentence somebody wrote.
  const canonical = new Set([
    ...SELF_CORRECTION_CANONICAL.flatMap(([, p]) => normalizeWords(p)),
    ...HELP_SEEKING_CANONICAL.flatMap(([, p]) => normalizeWords(p)),
  ]);
  const real = 'Michigan turnout collapsed in the suburbs and nobody wants to say so out loud.';
  const { body } = synthesizeBody(real, 'u/x:leak');
  for (const word of normalizeWords(real)) {
    if (canonical.has(word)) continue;
    assert.ok(!normalizeWords(body).includes(word), `"${word}" survived into the synthetic body`);
  }
});

/**
 * THE DRIFT GUARD. `synthetic-bodies.mjs` carries its own copy of
 * authenticity.js's two pattern lists, because that module does not export
 * them. A pattern added there and not here would mean the corpus stops
 * preserving a signal it claims to preserve — and every score would still look
 * perfectly reasonable. So the copies are compared against the real source
 * text, in order.
 */
test('the synthesis pattern lists have not drifted from authenticity.js', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension/lib/scoring/authenticity.js'), 'utf8');
  const lists = {
    SELF_CORRECTION_PATTERNS: SELF_CORRECTION_CANONICAL,
    HELP_SEEKING_PATTERNS: HELP_SEEKING_CANONICAL,
  };
  for (const [name, ours] of Object.entries(lists)) {
    const block = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
    assert.ok(block, `could not find ${name} in authenticity.js`);
    const theirs = [...block[1].matchAll(/^\s*(\/(?:[^\n\\/]|\\.|\[[^\]]*\])+\/[a-z]*),$/gm)].map((m) => m[1]);
    assert.equal(theirs.length, ours.length, `${name}: authenticity.js has ${theirs.length} patterns, synthetic-bodies.mjs mirrors ${ours.length}`);
    theirs.forEach((literal, i) => {
      assert.equal(String(ours[i][0]), literal, `${name}[${i}] differs from authenticity.js`);
    });
  }
});

test('every canonical replacement still matches the pattern it stands in for', () => {
  for (const [re, canonical] of SELF_CORRECTION_CANONICAL) {
    assert.ok(re.test(canonical), `self-correction canonical "${canonical}" no longer matches ${re}`);
  }
  for (const [re, canonical] of HELP_SEEKING_CANONICAL) {
    assert.ok(re.test(stripUrls(canonical)), `help-seeking canonical "${canonical}" no longer matches ${re}`);
  }
});

/**
 * The DoD of the ticket that created this directory: `npm run evaluate` prints
 * the table WITH NO NETWORK AT RUN TIME. Asserted at the import graph rather
 * than trusted, because a reviewer adding a "just refresh it if it's stale"
 * fetch is exactly the change that would look helpful. It matches IMPORTS, not
 * mentions — both files name `capture-corpus.mjs` in prose, and telling a
 * reader where to go is not the same as going there.
 */
test('nothing on the evaluate path can reach the network', () => {
  const forbidden = /from\s+['"][^'"]*(?:sources\/arcticShift|capture-corpus)/;
  for (const rel of ['scripts/evaluate.mjs', 'test/corpus/load.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(/.test(code), `${rel} calls fetch`);
    assert.ok(!forbidden.test(code), `${rel} imports something that fetches`);
  }
});
