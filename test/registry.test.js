// THE REGISTRIES ARE HELD TO THE CODE THEY DESCRIBE.
//
// Two kinds of assertion here, and the second is the one that earns its keep.
//
// Freshness: docs/registry.md and .env.example are generated, so a registry
// edit that was not re-rendered is a stale document nobody notices. That is a
// re-render and a string compare.
//
// Drift: a registry that merely *exists* beside the code rots. Every entry is
// tied back to the thing it claims to describe -- an env var to the field
// config.ts exposes, a route to the handler index.ts registers, a worker message
// to the handler background.js actually has. This repo's own history is the
// argument: the message protocol was a comment block at the top of
// background.js, which is a list nothing compares.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAll } from '../scripts/render-registry.js';
import { ENV, ROUTES, EVENTS } from '../server/registry/index.ts';
import config from '../server/config.ts';
import { ERRORS, ERROR_CODES } from '../extension/errors.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

test('docs/registry.md and .env.example are what the registries render', () => {
  for (const [relative, expected] of Object.entries(renderAll())) {
    assert.equal(
      read(relative),
      expected,
      `${relative} is stale -- run \`npm run registry\` and commit the result`
    );
  }
});

test('every declared env var is a field config.ts actually exposes', () => {
  for (const entry of ENV) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(config, entry.field),
      `registry/env.ts declares ${entry.key} -> config.${entry.field}, which config.ts does not expose`
    );
  }
});

test('config.ts reads no environment variable the registry does not declare', () => {
  // The whole point of routing config through the registry: a knob that is not
  // in docs/registry.md does not exist. This catches a `process.env.FOO` added
  // straight to config.ts, which is the shortcut the shape invites.
  const source = read('server/config.ts');
  const declared = new Set(ENV.map((entry) => entry.key));
  const referenced = [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const key of referenced) {
    assert.ok(declared.has(key), `server/config.ts reads ${key}, which registry/env.ts does not declare`);
  }
});

test('every route names a handler, and index.ts registers exactly those handlers', () => {
  const source = read('server/index.ts');
  const registered = [...source.matchAll(/^\s{4}(health|verdict):/gm)].map((m) => m[1]);
  const named = [...new Set(ROUTES.map((route) => route.handler))].sort();
  assert.deepEqual(registered.sort(), named, 'the handler map in index.ts and the ROUTES table disagree');
});

test('no two routes share a method and a path', () => {
  const seen = new Set();
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), `ROUTES declares ${key} twice`);
    seen.add(key);
  }
});

test('every declared worker message is a handler background.js registers, and vice versa', () => {
  const source = read('extension/background.js');
  const handlers = [...source.matchAll(/^\s{2}async (BD_[A-Z_]+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(
    handlers.sort(),
    EVENTS.map((event) => event.name).sort(),
    'registry/events.ts and background.js’s handler map disagree'
  );
});

test('the classic content scripts use only codes the taxonomy declares', () => {
  // content/badge.js and content/reddit.js cannot import errors.js -- Chrome
  // does not support ES modules for declaratively-injected content scripts --
  // so badge.js has its own factory and the codes are literals. This is the
  // comparison that keeps the second list honest.
  const sources = ['extension/content/badge.js', 'extension/content/reddit.js'];
  for (const relative of sources) {
    const used = [...read(relative).matchAll(/codedError\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
    for (const code of used) {
      assert.ok(
        ERROR_CODES.includes(code),
        `${relative} throws code "${code}", which extension/errors.js does not declare`
      );
    }
  }
});

test('every error spec is internally consistent: the key is the code', () => {
  for (const [key, spec] of Object.entries(ERRORS)) {
    assert.equal(key, spec.code, `ERRORS key "${key}" does not match its own code "${spec.code}"`);
    assert.ok(spec.summary.length > 0, `${key} has no summary, so docs/registry.md would render a blank cell`);
    assert.ok(
      spec.httpStatus >= 400 && spec.httpStatus < 600,
      `${key} has httpStatus ${spec.httpStatus}, which is not a failure status`
    );
  }
});

test('an undeclared code is a loud defect rather than a silent default', async () => {
  const { BotDetectorError } = await import('../extension/errors.js');
  const err = new BotDetectorError('no-such-code-anywhere', 'detail');
  assert.match(err.message, /undeclared error code/);
  // It still carries a usable code, because something downstream will branch on
  // one and `undefined` is the failure this guards against.
  assert.ok(ERROR_CODES.includes(err.code));
});
