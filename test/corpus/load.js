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
    return entry;
  });

  return {
    accounts,
    bots: accounts.filter((a) => a.class === 'bot'),
    humans: accounts.filter((a) => a.class === 'human'),
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
