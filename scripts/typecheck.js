// `npm run typecheck`, and the first half of `npm test`.
//
// WHY npx AND NOT A devDependency. This repo's suite runs with NO node_modules
// installed, and that property is load-bearing: the extension is the product,
// it installs load-unpacked with zero setup, and a contributor who cannot run
// the tests without an install will not run them. So the compiler is fetched on
// demand into npm's own npx cache and never lands in the tree. Every other repo
// in the fleet reaches a single shared TypeScript install instead; this one is
// public and may not know that machine exists.
//
// @types/node comes the same way. npx installs it beside typescript in a cache
// directory tsc does not search, so the directory is derived from the PATH npx
// exports and handed over as --typeRoots. Confirmed 2026-09-24 against npm 11:
// PATH's first entry is `<npx cache>/<hash>/node_modules/.bin`.
//
// A COMPILER THAT CANNOT BE FETCHED IS A LOUD SKIP, NOT A FAILURE, because the
// alternative is that `npm test` stops working on a laptop with no network --
// which is the one environment this repo promises to run in. Set
// BOT_DETECTOR_REQUIRE_TYPECHECK=1 to make it a failure instead; `bb test` and
// `bb doctor --conformance` run on a machine that always has both.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = process.env.BOT_DETECTOR_REQUIRE_TYPECHECK === '1';
const PACKAGES = ['-p', 'typescript@5.9', '-p', '@types/node@24'];

/**
 * Fetch the compiler and report where npx put it: `@types` sits beside the
 * `.bin` directory npx prepends to PATH.
 *
 * @returns {{ typeRoots: string, error: null } | { typeRoots: null, error: string }}
 */
function resolveToolchain() {
  const probe = spawnSync(
    'npx',
    ['-y', ...PACKAGES, 'node', '-e', 'process.stdout.write(process.env.PATH.split(require("node:path").delimiter)[0])'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  const binDir = (probe.stdout || '').trim();
  if (probe.status !== 0 || !binDir) {
    return { typeRoots: null, error: (probe.stderr || '').trim() || `npx exited ${probe.status}` };
  }
  return { typeRoots: path.resolve(binDir, '..', '@types'), error: null };
}

const toolchain = resolveToolchain();

if (toolchain.typeRoots === null) {
  const line = `[bot-detector:typecheck] SKIPPED could-not-fetch-typescript detail=${JSON.stringify(toolchain.error.split('\n')[0])}`;
  if (!required) {
    console.log(line);
    console.log('[bot-detector:typecheck] the rest of the suite is unaffected; set BOT_DETECTOR_REQUIRE_TYPECHECK=1 to make this a failure');
    process.exit(0);
  }
  console.error(line);
  console.error('[bot-detector:typecheck] BOT_DETECTOR_REQUIRE_TYPECHECK=1 is set, so this is a failure');
  process.exit(1);
}

const result = spawnSync(
  'npx',
  ['-y', ...PACKAGES, 'tsc', '-p', 'tsconfig.json', '--typeRoots', toolchain.typeRoots],
  { cwd: repoRoot, stdio: 'inherit' }
);
process.exit(result.status === null ? 1 : result.status);
