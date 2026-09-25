// THE TWO DUPLICATES IN content/badge.js ARE HELD TO THE REAL MODULES.
//
// Chrome does not support ES modules for declaratively-injected content scripts,
// so `content/badge.js` and `content/reddit.js` cannot import `extension/errors.js`
// or `extension/log.js` at all. badge.js therefore carries its own `codedError`
// and `formatLine` on `window.__bdUI`, which the two content scripts share
// through the isolated world's globals.
//
// A duplicate that nothing compares is how two implementations drift, and this
// repo's own history says so: the worker message protocol lived as a comment
// block at the top of background.js until it became registry/events.ts. So the
// duplication is allowed and the comparison is a test -- the codes come from
// errors.js, and the line format is checked against log.js's own output rather
// than against a copy of the format string.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERRORS, ERROR_CODES, BotDetectorError, AccountNotFoundError, AgendaError, codedError } from '../extension/errors.js';
import { formatLine, formatFields } from '../extension/log.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const badgeSource = fs.readFileSync(path.join(repoRoot, 'extension', 'content', 'badge.js'), 'utf8');

/**
 * badge.js's `formatLine`, lifted out of the source and evaluated.
 *
 * Reading the shipped text rather than re-typing the function is the point: a
 * copy that has been edited fails here, and a copy that has been deleted fails
 * to extract.
 */
function badgeFormatLine() {
  const start = badgeSource.indexOf('function formatLine(domain, event, fields) {');
  assert.notEqual(start, -1, 'content/badge.js no longer defines formatLine');
  const end = badgeSource.indexOf('\n  }', start);
  const body = badgeSource.slice(start, end + 4);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return formatLine;`)();
}

test('badge.js formats a log line exactly as extension/log.js does', () => {
  const theirs = badgeFormatLine();
  const cases = [
    ['content', 'standing-down', { at: 'observer' }],
    ['content', 'standing-down', { at: 'two words', n: 3, flag: true }],
    ['lookup', 'no-fields', {}],
    ['lookup', 'undefined-dropped', { kept: 1, dropped: undefined }],
    ['worker', 'quoted', { detail: 'has "a quote" in it' }],
  ];
  for (const [domain, event, fields] of cases) {
    assert.equal(
      theirs(domain, event, fields),
      formatLine(domain, event, fields),
      `badge.js's formatLine disagrees with log.js on ${JSON.stringify([domain, event, fields])}`
    );
  }
});

test('a field with no value is dropped rather than printed as undefined', () => {
  assert.equal(formatFields({ a: 1, b: undefined }), 'a=1');
});

test('a coded error carries code, domain and an HTTP status from one place', () => {
  const err = new BotDetectorError('not-found', 'No archive data for u/nobody');
  assert.equal(err.code, 'not-found');
  assert.equal(err.domain, 'lookup');
  assert.equal(err.httpStatus, 404);
  assert.equal(err.name, 'BotDetectorError');
  assert.ok(err instanceof Error);
});

test('kind is an alias of code, because it crosses the sendMessage boundary', () => {
  // providers/index.js branches on `err.kind === 'rate-limited'` and the worker
  // envelope sends both. Dropping the alias breaks the queue's backoff silently.
  const err = new BotDetectorError('rate-limited');
  assert.equal(err.kind, err.code);
  assert.equal(err.kind, 'rate-limited');
});

test('AccountNotFoundError keeps the username and the not-found code', () => {
  const err = new AccountNotFoundError('someone');
  assert.equal(err.code, 'not-found');
  assert.equal(err.username, 'someone');
  assert.match(err.message, /u\/someone/);
  assert.ok(err instanceof BotDetectorError);
});

test('AgendaError keeps its (code, message) signature and instanceof', () => {
  // server/index.ts folds an AgendaError into the verdict instead of failing the
  // request, and it identifies one with instanceof.
  const err = new AgendaError('refusal', 'Claude declined to read this account');
  assert.equal(err.code, 'refusal');
  assert.equal(err.httpStatus, ERRORS.refusal.httpStatus);
  assert.ok(err instanceof AgendaError);
  assert.ok(err instanceof BotDetectorError);
});

test('codedError attaches extra fields without losing the code', () => {
  const err = codedError('rate-limited', 'slow down', { retryAfterMs: 1500 });
  assert.equal(err.code, 'rate-limited');
  assert.equal(err.retryAfterMs, 1500);
});

test('an undeclared code does not silently produce an undefined code', () => {
  const err = new BotDetectorError('not-a-real-code');
  assert.match(err.message, /undeclared error code/);
  assert.ok(ERROR_CODES.includes(err.code), 'the fallback code must itself be declared');
  assert.equal(typeof err.httpStatus, 'number');
});

test('no source file throws a bare Error, including the content scripts', () => {
  // test/conformance.test.cjs asserts this for extension/ and server/ as the
  // fleet standard. Repeated here for the reason that matters locally: the two
  // content scripts cannot import the taxonomy, so they are the files where the
  // easy thing to write is the wrong one.
  for (const relative of ['extension/content/badge.js', 'extension/content/reddit.js']) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /throw new (Error|TypeError)\(/,
      `${relative} throws a bare error -- use UI.codedError(code, message)`
    );
  }
});
