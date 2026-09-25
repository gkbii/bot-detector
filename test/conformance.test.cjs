'use strict';

// THE FLEET CODE STANDARD, AS A TEST. Copied verbatim from
// ~/.bigbrain/lib/conformance/conformance.test.cjs into <repo>/test/ -- never
// edited in place: `bb doctor --conformance` fails on a copy that differs
// from the template, so a rule changes in one file and lands everywhere.
// The rules are ~/.bigbrain/STANDARD.md. Per-repo knobs live in package.json
// under "conformance": { "srcDirs": ["src"], "server": false }.
//
// Self-contained on purpose: node:test and node:fs only, no control-plane
// require, so the same file runs in bot-detector on a laptop that has never
// heard of this machine. A .cjs file so it runs unchanged in a CommonJS
// package and in one whose package.json says "type": "module".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const opts = { srcDirs: ['src'], server: false, ...(pkg.conformance || {}) };
const CLAUDE_MD_LINES = 80;
const FILE_LINES = 800;
const SOURCE_RE = /\.(ts|js|mjs|cjs|mts)$/;
const TEST_RE = /\.test\.(ts|js|mjs|cjs|mts)$/;
// The copied control-plane skeleton (bb doctor --skeleton) is verbatim by rule and throws its own bare Error on purpose.
const SKELETON_RE = /^(bigbrain|env)\.js$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (SOURCE_RE.test(entry.name) && !TEST_RE.test(entry.name) && !SKELETON_RE.test(entry.name)) out.push(p);
  }
  return out;
}
const sources = opts.srcDirs.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (p) => path.relative(ROOT, p);
const lines = (p) => (fs.readFileSync(p, 'utf8').match(/\n/g) || []).length; // wc -l semantics, same as bb doctor
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

test('errors are a taxonomy: one errors module, no bare throw new Error in src', () => {
  const hasModule = opts.srcDirs.some((d) => ['errors.ts', 'errors.js', 'errors/index.ts', 'errors/index.js'].some((f) => exists(d, f)));
  assert.ok(hasModule, `no ${opts.srcDirs.join('|')}/errors.{ts,js}: every thrown error is a coded class from one module`);
  const bare = sources.filter((p) => /\bthrow new Error\(/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert.deepEqual(bare, [], `bare throw new Error( in: ${bare.join(', ')} -- use a coded class from the errors module`);
});

test('features are registries: src/registry renders docs/registry.md through an npm script', () => {
  const hasRegistry = opts.srcDirs.some((d) => exists(d, 'registry'));
  assert.ok(hasRegistry, `no ${opts.srcDirs.join('|')}/registry/: routes, jobs, commands, events, env and errors are exported data`);
  assert.ok(exists('docs', 'registry.md'), 'docs/registry.md is missing: `npm run registry` renders it from src/registry');
  assert.ok(pkg.scripts && pkg.scripts.registry, 'package.json has no "registry" script');
});

test('context files are maps: CLAUDE.md within 80 lines, README and package.json free of ticket ids', () => {
  if (exists('CLAUDE.md')) {
    const n = lines(path.join(ROOT, 'CLAUDE.md'));
    assert.ok(n <= CLAUDE_MD_LINES, `CLAUDE.md is ${n} lines, budget ${CLAUDE_MD_LINES}: pointers and invariants only`);
  }
  if (exists('README.md')) {
    const ids = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').match(/\bJIO-\d+\b/g) || [];
    assert.equal(ids.length, 0, `README.md cites ${ids.length} ticket ids (${[...new Set(ids)].slice(0, 5).join(', ')}): README is install and use only`);
  }
  assert.ok(!/\bJIO-\d+\b/.test(pkg.description || ''), 'package.json description cites a ticket id');
});

test('one entry point per action: test always, start and restart for a server', () => {
  // A library or a job-only repo has nothing to start; a server has one way
  // to start and one way to restart, both npm scripts.
  const s = pkg.scripts || {};
  for (const name of ['test', ...(opts.server ? ['start', 'restart'] : [])]) {
    assert.ok(s[name], `package.json has no "${name}" script`);
  }
});

test('interfaces are declared: .ts sources typecheck inside npm test', () => {
  const ts = sources.filter((p) => /\.m?ts$/.test(p));
  if (!ts.length) return;
  assert.ok(exists('tsconfig.json'), 'tsconfig.json is missing while .ts sources exist');
  assert.match(String((pkg.scripts || {}).test || ''), /typecheck/, 'the test script does not run the typecheck');
});

test('file size is a soft ratchet: docs/size-exceptions.json may only shrink', (t) => {
  const exceptionsPath = path.join(ROOT, 'docs', 'size-exceptions.json');
  const exceptions = fs.existsSync(exceptionsPath) ? JSON.parse(fs.readFileSync(exceptionsPath, 'utf8')) : {};
  const over = sources.map((p) => [rel(p), lines(p)]).filter(([, n]) => n > FILE_LINES);
  for (const [file, n] of over) {
    if (!(file in exceptions)) t.diagnostic(`${file} is ${n} lines, over ${FILE_LINES}: split it, or list it in docs/size-exceptions.json`);
    else assert.ok(n <= exceptions[file], `${file} grew from ${exceptions[file]} to ${n} lines: the exception list only ratchets down`);
  }
  for (const [file, recorded] of Object.entries(exceptions)) {
    const p = path.join(ROOT, file);
    assert.ok(fs.existsSync(p), `docs/size-exceptions.json lists ${file}, which no longer exists: remove it`);
    assert.ok(lines(p) > FILE_LINES, `${file} is now under ${FILE_LINES} lines: remove it from docs/size-exceptions.json`);
    assert.ok(Number.isInteger(recorded), `docs/size-exceptions.json: ${file} must record its line count`);
  }
});
