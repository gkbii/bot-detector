/**
 * Read the frozen evaluation corpus off disk. NO NETWORK, EVER — that is the
 * whole point of the directory next to this file (JIO-343).
 *
 * Shared by `scripts/evaluate.mjs` and `test/corpus.test.js` so there is one
 * definition of what the corpus IS, and so a corpus file that stops being
 * loaded shows up as a count that went down rather than as nothing at all.
 *
 * Node built-ins only, and plain `JSON.parse` on `buildProfile` output rather
 * than a rebuild through `buildProfile()`: the serialised profile is the
 * artifact being frozen, so anything that re-derived a field from it would be
 * testing today's `buildProfile` against itself instead of testing today's
 * scorers against a fixed input. `scoreAccount` reads plain objects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXPECTED_PATH = path.join(CORPUS_DIR, 'expected.json');
export const MANIFEST_PATH = path.join(CORPUS_DIR, 'manifest.json');

/** The three axes, in the column order EVALUATION.md's table prints them. */
export const AXES = ['automation', 'agenda', 'authenticity'];

/**
 * The three populations in here, which were sampled by three different rules
 * and are NOT interchangeable (JIO-344).
 *
 *   politics-thread  17 authors of one r/politics thread, by comment count in
 *                    it. Ordinary-volume commenters by construction — which is
 *                    exactly why they could never answer whether a PROLIFIC
 *                    person trips `sustained-posting-rate`.
 *   prolific-probe   humans found by a content-blind volume sweep of 22
 *                    subreddits and hand-read (EVALUATION.md Finding 4a). They
 *                    are here to hold that one question open, and they are a
 *                    demonstration that the population exists — NOT a measured
 *                    false-positive rate, because the sweep deliberately aimed
 *                    at the busiest authors on the platform.
 *   declared-bot     accounts admitted by `scripts/lib/bot-declaration.mjs`.
 *
 * Every separation invariant applies to BOTH human cohorts — a prolific person
 * that scored above `low` would be a false accusation just the same. Only the
 * counts and the table labels distinguish them, so that a row reading
 * "17 thread humans" keeps meaning 17 thread humans.
 */
export const COHORTS = {
  THREAD: 'politics-thread',
  PROLIFIC: 'prolific-probe',
  BOT: 'declared-bot',
};
const KNOWN_COHORTS = new Set(Object.values(COHORTS));

/**
 * Every account file, sorted by username so the table is byte-stable.
 * Anything that is not an account file (the manifest, the expectation, this
 * module) is excluded by name rather than by guessing at shape.
 */
export function loadCorpus() {
  const skip = new Set(['manifest.json', 'expected.json']);
  const files = fs.readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json') && !skip.has(f))
    .sort();

  const accounts = files.map((file) => {
    const entry = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8'));
    if (!entry.profile || !entry.class) throw new Error(`${file}: not a corpus account file`);
    // REQUIRED, not defaulted. A cohort this module quietly guessed at is how
    // a probe human would end up counted as the eighteenth thread human and
    // the table would go on reading exactly as plausibly as before.
    if (!KNOWN_COHORTS.has(entry.cohort)) {
      throw new Error(`${file}: cohort ${JSON.stringify(entry.cohort)} is not one of ${[...KNOWN_COHORTS].join(', ')}`);
    }
    return entry;
  });

  const inCohort = (cohort) => accounts.filter((a) => a.cohort === cohort);
  return {
    accounts,
    bots: accounts.filter((a) => a.class === 'bot'),
    // Every human, both cohorts — this is what the separation invariants run
    // over, and adding a cohort must never shrink it.
    humans: accounts.filter((a) => a.class === 'human'),
    threadHumans: inCohort(COHORTS.THREAD),
    prolificHumans: inCohort(COHORTS.PROLIFIC),
  };
}

export function loadExpected() {
  if (!fs.existsSync(EXPECTED_PATH)) return null;
  return JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
}

export function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}
