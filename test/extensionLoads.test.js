// WHAT CHROME WILL AND WILL NOT LOAD, asserted here because the unit suite
// cannot see it and neither can the typechecker.
//
// Two incidents are behind this file. `fetchImpl = globalThis.fetch` unbound
// works fine in Node, so all 106 tests passed, and an MV3 service worker threw
// `Illegal invocation` -- every lookup in the real extension failed. And the
// reason `extension/lib/**` is still `.js` while `server/**` is `.ts`: browsers
// do not strip TypeScript types, so renaming one of those files breaks the
// product while every Node test keeps passing, because Node strips them happily.
//
// None of this proves the extension works -- only a live run does that, which is
// what EVALUATION.md and decision 0010 are about. It proves the extension still
// LOADS, which is the failure these changes could introduce invisibly.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(repoRoot, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));

/** Every file under extension/, repo-relative. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(repoRoot, full));
  }
  return out;
}
const files = walk(extensionDir);
const scripts = files.filter((f) => f.endsWith('.js'));

test('nothing under extension/ is a .ts file', () => {
  // Decision 0011. A browser has no type stripping, so a .ts file here is a file
  // Chrome cannot parse -- and Node would run every test against it regardless.
  const typescript = files.filter((f) => /\.m?ts$/.test(f));
  assert.deepEqual(typescript, [], `extension/ must stay JavaScript: ${typescript.join(', ')}`);
});

test('no module under extension/ imports a .ts file or anything from server/', () => {
  // The dependency runs one way only: server/ borrows from extension/, never the
  // reverse. An import of server/config.ts would load in Node and break Chrome.
  for (const relative of scripts) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const specifiers = [...source.matchAll(/(?:^|\s)(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /\.m?ts$/, `${relative} imports ${specifier}, which a browser cannot parse`);
      assert.doesNotMatch(specifier, /(^|\/)server\//, `${relative} imports ${specifier} -- extension/ must not depend on server/`);
      assert.ok(
        specifier.startsWith('.'),
        `${relative} imports the bare specifier "${specifier}": there is no bundler and no node_modules in the extension`
      );
    }
  }
});

test('every relative import under extension/ resolves to a file that exists', () => {
  // The worker's imports are static, so a renamed file stops it outright with
  // nothing but a load error on chrome://extensions to say why.
  for (const relative of scripts) {
    const absolute = path.join(repoRoot, relative);
    const source = fs.readFileSync(absolute, 'utf8');
    const specifiers = [...source.matchAll(/(?:^|\s)(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/gm)].map((m) => m[1]);
    for (const specifier of specifiers) {
      const target = path.resolve(path.dirname(absolute), specifier);
      assert.ok(fs.existsSync(target), `${relative} imports ${specifier}, which does not exist`);
    }
  }
});

test('the classic content scripts import nothing at all', () => {
  // Chrome does not support ES modules for declaratively-injected content
  // scripts. An `import` here is not a type error or a test failure -- it is a
  // content script that silently never runs on the page.
  for (const relative of manifest.content_scripts.flatMap((entry) => entry.js)) {
    const source = fs.readFileSync(path.join(extensionDir, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /^\s*(import|export)\s/m,
      `extension/${relative} is a declaratively-injected content script and cannot use ES modules`
    );
  }
});

test('every file manifest.json names exists', () => {
  const named = [
    manifest.background.service_worker,
    manifest.options_ui.page,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css || [])]),
  ];
  for (const relative of named) {
    assert.ok(fs.existsSync(path.join(extensionDir, relative)), `manifest.json names ${relative}, which does not exist`);
  }
});

test('the service worker is declared as a module, since it uses import', () => {
  assert.equal(manifest.background.type, 'module');
});

test('fetch is bound where it is handed to the scoring core', () => {
  // The `Illegal invocation` incident, as an assertion. An unbound
  // `globalThis.fetch` passed for 106 tests and failed every real lookup.
  const source = fs.readFileSync(path.join(extensionDir, 'providers', 'local.js'), 'utf8');
  assert.match(
    source,
    /fetchImpl:\s*globalThis\.fetch\.bind\(globalThis\)/,
    'providers/local.js must bind fetch: an MV3 worker throws Illegal invocation on an unbound one'
  );
});
