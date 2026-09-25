// EVALUATION.md's ONE GENERATED BLOCK IS HELD FRESH.
//
// The document is a dated log of findings and is mostly not generated: the
// 2026-08-05 headline table is a record of a live run, kept verbatim, and each
// finding carries its measurement, the decision it forced and a "what this does
// not establish" section that no script produces. Five of the eight
// `npm run measure:*` scripts go to the network, so the document could not be
// re-rendered without re-fetching a volunteer-run free archive either.
//
// What IS a claim about today is the current band table, and that comes from the
// frozen corpus with no network. This holds it to the corpus, so the numbers a
// reader sees cannot drift from the numbers the code produces.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const evaluation = fs.readFileSync(path.join(repoRoot, 'EVALUATION.md'), 'utf8');

test('the generated band table in EVALUATION.md is not stale', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/evaluate.mjs', '--check-render'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(
    result.status,
    0,
    `EVALUATION.md's generated band table is stale -- run \`npm run evaluate -- --render\`\n${result.stdout}${result.stderr}`
  );
});

test('the markers a reader might tidy away are still there', () => {
  // Removing them does not break a render silently: `--render` throws and says
  // to restore them. This is the cheaper way to find out.
  assert.match(evaluation, /<!-- BEGIN GENERATED: current-bands -->/);
  assert.match(evaluation, /<!-- END GENERATED: current-bands -->/);
});

test('the dated 2026-08-05 table is outside the generated block', () => {
  // The whole point of generating only one block: the historical run must not be
  // rewritten by a render. If it ever lands inside the markers, a render silently
  // replaces a record of what a live thread actually scored.
  const begin = evaluation.indexOf('<!-- BEGIN GENERATED: current-bands -->');
  const dated = evaluation.indexOf('| 17 thread humans | **low** ×17 (0–22)');
  assert.ok(dated > -1, 'the 2026-08-05 headline row is gone from EVALUATION.md');
  assert.ok(dated < begin, 'the dated 2026-08-05 table has moved inside the generated block');
});

test('every measure script named in docs/evaluating.md is a registered npm script', () => {
  // The scripts used to be invoked as bare paths, one of them named after a
  // ticket. A path in prose is not discoverable and rots when a file is renamed;
  // an npm script is both the entry point and the list.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const doc = fs.readFileSync(path.join(repoRoot, 'docs', 'evaluating.md'), 'utf8');
  const named = [...doc.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'docs/evaluating.md names no npm scripts at all');
  for (const name of new Set(named)) {
    assert.ok(pkg.scripts[name], `docs/evaluating.md says \`npm run ${name}\`, which package.json does not define`);
  }
});

test('no script file is named after a ticket', () => {
  // `measure-jio329.mjs` was: a filename that means nothing to a reader without
  // Linear access, in the one public repo.
  const files = fs.readdirSync(path.join(repoRoot, 'scripts'));
  const ticketNamed = files.filter((name) => /jio[-_]?\d+/i.test(name));
  assert.deepEqual(ticketNamed, [], `scripts named after tickets: ${ticketNamed.join(', ')}`);
});
