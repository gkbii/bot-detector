// Cache behaviour: hit, miss, expiry -- and, because this stores comment
// bodies, that expiry actually removes them from disk rather than hiding them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../cache.js';

/** A cache with a clock we control, so expiry is testable without sleeping. */
function makeCache() {
  const clock = { now: 1_000_000 };
  const cache = new Cache({ dbPath: ':memory:', now: () => clock.now });
  return { cache, clock };
}

const PROFILE = {
  platform: 'reddit',
  username: 'spez',
  comments: [{ id: 'c1', body: 'a real comment body', group: 'announcements' }],
};

test('miss on an empty cache', () => {
  const { cache } = makeCache();
  assert.equal(cache.getProfile('reddit', 'spez'), null);
  assert.equal(cache.getVerdict('reddit', 'spez'), null);
  assert.equal(cache.getLlmRead('reddit', 'spez'), null);
  cache.close();
});

test('hit returns the stored value round-tripped through JSON', () => {
  const { cache } = makeCache();
  cache.putProfile('reddit', 'spez', PROFILE);
  const hit = cache.getProfile('reddit', 'spez');
  assert.deepEqual(hit.value, PROFILE);
  assert.equal(hit.storedAt, 1_000_000);
  cache.close();
});

test('the key is case-insensitive, like reddit handles', () => {
  const { cache } = makeCache();
  cache.putVerdict('reddit', 'SomeUser', { username: 'SomeUser' });
  assert.ok(cache.getVerdict('reddit', 'someuser'));
  assert.ok(cache.getVerdict('reddit', 'SOMEUSER'));
  cache.close();
});

test('a second put overwrites rather than duplicating', () => {
  const { cache } = makeCache();
  cache.putVerdict('reddit', 'spez', { v: 1 });
  cache.putVerdict('reddit', 'spez', { v: 2 });
  assert.deepEqual(cache.getVerdict('reddit', 'spez').value, { v: 2 });
  assert.equal(cache.stats().verdicts, 1);
  cache.close();
});

test('an entry expires exactly at its TTL, not before', () => {
  const { cache, clock } = makeCache();
  cache.putVerdict('reddit', 'spez', { v: 1 }, 100);

  clock.now += 99;
  assert.ok(cache.getVerdict('reddit', 'spez'), 'should still be live one second early');

  clock.now += 1; // now exactly at expires_at
  assert.equal(cache.getVerdict('reddit', 'spez'), null);
  cache.close();
});

test('the LLM read outlives the verdict -- the point of separate TTLs', () => {
  const { cache, clock } = makeCache();
  // The expensive read is cached for longer than the cheap verdict, so a
  // second-day lookup re-scores locally but does NOT pay for another Opus call.
  cache.putVerdict('reddit', 'spez', { v: 1 }, 60);
  cache.putLlmRead('reddit', 'spez', { band: 'low' }, 6000);

  clock.now += 120;
  assert.equal(cache.getVerdict('reddit', 'spez'), null, 'verdict should have expired');
  assert.ok(cache.getLlmRead('reddit', 'spez'), 'llm read should have survived');
  cache.close();
});

test('expiry DELETES comment bodies rather than merely hiding them', () => {
  // The retention rule is about what is on disk. A read-time filter would
  // leave a stranger's comment text sitting in the database indefinitely.
  const { cache, clock } = makeCache();
  cache.putProfile('reddit', 'spez', PROFILE, 100);
  assert.equal(cache.stats().profiles, 1);

  clock.now += 101;
  cache.purgeExpired();
  assert.equal(cache.stats().profiles, 0, 'expired profile row should be gone from the table');

  // And the row really is gone from the underlying table, not just uncounted.
  const rows = cache.db.prepare('SELECT COUNT(*) AS n FROM profiles').get();
  assert.equal(Number(rows.n), 0);
  cache.close();
});

test('a read of an expired entry removes it as a side effect', () => {
  const { cache, clock } = makeCache();
  cache.putProfile('reddit', 'spez', PROFILE, 10);
  clock.now += 11;
  assert.equal(cache.getProfile('reddit', 'spez'), null);
  assert.equal(cache.stats().profiles, 0);
  cache.close();
});

test('a write purges other expired rows too', () => {
  const { cache, clock } = makeCache();
  cache.putProfile('reddit', 'olduser', PROFILE, 10);
  clock.now += 11;
  cache.putProfile('reddit', 'newuser', PROFILE, 1000);
  assert.equal(cache.stats().profiles, 1);
  assert.ok(cache.getProfile('reddit', 'newuser'));
  cache.close();
});

test('a corrupt payload is a miss, not a crash', () => {
  const { cache } = makeCache();
  cache.db
    .prepare(
      'INSERT INTO verdicts (platform, username, payload, stored_at, expires_at) VALUES (?,?,?,?,?)'
    )
    .run('reddit', 'spez', '{not json', 1_000_000, 9_999_999);
  assert.equal(cache.getVerdict('reddit', 'spez'), null);
  cache.close();
});

test('forget() clears an account across all three tables', () => {
  const { cache } = makeCache();
  cache.putProfile('reddit', 'spez', PROFILE);
  cache.putVerdict('reddit', 'spez', { v: 1 });
  cache.putLlmRead('reddit', 'spez', { band: 'low' });
  assert.equal(cache.forget('reddit', 'spez'), 3);
  assert.deepEqual(cache.stats(), { profiles: 0, verdicts: 0, llm_reads: 0 });
  cache.close();
});
