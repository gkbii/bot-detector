// Username validation is a security boundary, not a formatting nicety: the
// value it returns is interpolated into an outbound URL. These tests are
// mostly about what gets REJECTED.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePlatform, normaliseUsername } from '../username.js';

test('accepts a plain handle', () => {
  assert.deepEqual(normaliseUsername('spez'), { ok: true, username: 'spez' });
});

test('accepts the full legal character class and both length bounds', () => {
  assert.equal(normaliseUsername('a_b-C9').username, 'a_b-C9');
  assert.equal(normaliseUsername('abc').username, 'abc'); // 3 = minimum
  assert.equal(normaliseUsername('a'.repeat(20)).username, 'a'.repeat(20)); // 20 = maximum
});

test('preserves case rather than lowercasing', () => {
  // Reddit handles display with their original case; the cache key lowercases
  // separately, so normalisation must not destroy it here.
  assert.equal(normaliseUsername('SomeUser').username, 'SomeUser');
});

test('strips the shapes a human actually pastes', () => {
  for (const raw of ['u/spez', '/u/spez', '/user/spez', '@spez', '  spez  ', 'spez\n', 'user/spez/']) {
    assert.equal(normaliseUsername(raw).username, 'spez', `failed for ${JSON.stringify(raw)}`);
  }
});

test('accepts a reddit profile URL', () => {
  assert.equal(normaliseUsername('https://www.reddit.com/user/spez').username, 'spez');
  assert.equal(normaliseUsername('https://old.reddit.com/u/spez/comments').username, 'spez');
  assert.equal(normaliseUsername('http://reddit.com/user/spez?sort=new').username, 'spez');
});

test('rejects a URL on any other host rather than taking its last path segment', () => {
  // The whole point: "take the last segment of whatever URL you were given" is
  // how a validator becomes an SSRF.
  const result = normaliseUsername('https://evil.example.com/user/spez');
  assert.equal(result.ok, false);
});

test('rejects path traversal, separators and anything else URL-significant', () => {
  const hostile = [
    '../../etc/passwd',
    'spez/../admin',
    'spez%2f..%2fadmin',
    'spez/comments',
    'spez?sort=new',
    'spez#frag',
    'spez&x=1',
    'http://169.254.169.254/latest/meta-data',
    'localhost:3200',
    'a b',
    'spez\nadmin',
    'spez.json',
    'spez@example.com',
  ];
  for (const raw of hostile) {
    const result = normaliseUsername(raw);
    assert.equal(result.ok, false, `should have rejected ${JSON.stringify(raw)}`);
    assert.match(result.reason, /username must be/);
  }
});

test('rejects wrong lengths and wrong types', () => {
  assert.equal(normaliseUsername('ab').ok, false); // too short
  assert.equal(normaliseUsername('a'.repeat(21)).ok, false); // too long
  assert.equal(normaliseUsername('').ok, false);
  assert.equal(normaliseUsername('   ').ok, false);
  assert.equal(normaliseUsername(undefined).ok, false);
  assert.equal(normaliseUsername(null).ok, false);
  assert.equal(normaliseUsername(12345).ok, false);
  assert.equal(normaliseUsername(['spez']).ok, false);
  assert.equal(normaliseUsername({ toString: () => 'spez' }).ok, false);
});

test('platform defaults to reddit and rejects anything else', () => {
  assert.deepEqual(normalisePlatform(undefined), { ok: true, platform: 'reddit' });
  assert.deepEqual(normalisePlatform(''), { ok: true, platform: 'reddit' });
  assert.deepEqual(normalisePlatform('Reddit'), { ok: true, platform: 'reddit' });
  assert.equal(normalisePlatform('twitter').ok, false);
  assert.equal(normalisePlatform(7).ok, false);
});
