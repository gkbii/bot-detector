// The HTTP surface. Every dependency is injected, so these tests touch no
// network, no Anthropic API and no file on disk (the cache is :memory:).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, isOriginAllowed } from '../index.js';
import { Cache } from '../cache.js';
import { AgendaError } from '../agenda.js';

const PROFILE = {
  platform: 'reddit',
  username: 'spez',
  id: 'abc',
  fetchedAt: '2026-08-05T00:00:00Z',
  accountAgeDays: 900,
  karma: { post: 1, comment: 2, total: 3 },
  counts: { comments: 1, posts: 0 },
  comments: [
    {
      id: 't1_1',
      createdUtc: 1_700_000_000,
      group: 'announcements',
      body: 'hello there',
      score: 5,
      threadId: 't3_1',
      parentId: null,
      isTopLevel: true,
    },
  ],
  posts: [],
  coverage: { commentsFetched: 1, commentsTotal: 1, truncated: false, sources: [], errors: [] },
};

const VERDICT = {
  username: 'spez',
  platform: 'reddit',
  fetchedAt: '2026-08-05T00:00:00Z',
  automation: { band: 'low', score: 12, signals: [] },
  agenda: { band: 'low', score: 20, signals: [] },
  authenticity: { band: 'high', score: 80, signals: [] },
  headline: 'looks like a person',
  coverage: PROFILE.coverage,
};

/** Boots the app on an ephemeral port with everything injected. */
async function withApp(overrides, run) {
  const calls = { fetch: 0, score: 0, agenda: 0 };
  const cache = new Cache({ dbPath: ':memory:' });
  const server = createApp({
    cache,
    log: () => {},
    agendaConfigured: () => true,
    loadDeterministic: async () => ({
      fetchAccount: async () => {
        calls.fetch += 1;
        return PROFILE;
      },
      scoreAccount: () => {
        calls.score += 1;
        return VERDICT;
      },
    }),
    readAgenda: async () => {
      calls.agenda += 1;
      return { read: { band: 'low', summary: 's', findings: [{ key: 'k' }] }, dropped: [] };
    },
    ...overrides,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, calls, cache });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postVerdict(base, body, headers = {}) {
  return fetch(`${base}/api/verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET /api/health reports ok and whether the agenda read is configured', async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.agenda, true);
    // A boolean about configuration, never the key itself.
    assert.equal(JSON.stringify(body).includes('sk-'), false);
  });
});

test('health reports agenda:false when no key is configured', async () => {
  await withApp({ agendaConfigured: () => false }, async ({ base }) => {
    const body = await (await fetch(`${base}/api/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.agenda, false);
  });
});

test('POST /api/verdict returns the deterministic verdict with provider:backend', async () => {
  await withApp({}, async ({ base, calls }) => {
    const res = await postVerdict(base, { platform: 'reddit', username: 'spez', deep: false });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'backend');
    assert.equal(body.verdict.headline, 'looks like a person');
    assert.equal(body.verdict.agenda.llm, undefined, 'no llm block on a shallow request');
    assert.equal(calls.agenda, 0, 'a shallow request must never spend an Opus call');
  });
});

test('a bad username is rejected at the boundary, before any fetch', async () => {
  await withApp({}, async ({ base, calls }) => {
    for (const username of ['../etc/passwd', 'ab', 'spez/comments', '', null, 'a b']) {
      const res = await postVerdict(base, { username });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(username)}`);
      const body = await res.json();
      assert.ok(body.error);
    }
    assert.equal(calls.fetch, 0, 'nothing hostile reached the outbound fetch');
  });
});

test('an unsupported platform is rejected', async () => {
  await withApp({}, async ({ base }) => {
    const res = await postVerdict(base, { platform: 'twitter', username: 'spez' });
    assert.equal(res.status, 400);
  });
});

test('a non-JSON body is a 400, not a 500', async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(res.status, 400);
  });
});

test('an unknown account is a 404', async () => {
  await withApp(
    {
      loadDeterministic: async () => ({
        fetchAccount: async () => null,
        scoreAccount: () => VERDICT,
      }),
    },
    async ({ base }) => {
      const res = await postVerdict(base, { username: 'nobodyhere' });
      assert.equal(res.status, 404);
    }
  );
});

test('a second lookup is served from the cache without refetching', async () => {
  await withApp({}, async ({ base, calls }) => {
    await postVerdict(base, { username: 'spez' });
    const res = await postVerdict(base, { username: 'spez' });
    const body = await res.json();
    assert.equal(calls.fetch, 1, 'the second lookup hit the shared cache');
    assert.equal(body.cached.verdict, true);
  });
});

test('deep:true attaches verdict.agenda.llm and caches it', async () => {
  await withApp({}, async ({ base, calls }) => {
    const first = await (await postVerdict(base, { username: 'spez', deep: true })).json();
    assert.equal(first.verdict.agenda.llm.band, 'low');
    assert.equal(calls.agenda, 1);

    const second = await (await postVerdict(base, { username: 'spez', deep: true })).json();
    assert.equal(second.verdict.agenda.llm.band, 'low');
    assert.equal(second.cached.llm, true);
    assert.equal(calls.agenda, 1, 'the expensive read is not paid for twice');
  });
});

test('deep:true on an already-scored account reuses the cached profile, no refetch', async () => {
  await withApp({}, async ({ base, calls }) => {
    await postVerdict(base, { username: 'spez', deep: false });
    await postVerdict(base, { username: 'spez', deep: true });
    assert.equal(calls.fetch, 1);
    assert.equal(calls.agenda, 1);
  });
});

test('an agenda refusal still returns the deterministic verdict, with the reason', async () => {
  await withApp(
    {
      readAgenda: async () => {
        throw new AgendaError('refusal', 'Claude declined to read this account');
      },
    },
    async ({ base }) => {
      const res = await postVerdict(base, { username: 'spez', deep: true });
      assert.equal(res.status, 200, 'the deterministic half is unaffected by an LLM failure');
      const body = await res.json();
      assert.equal(body.verdict.headline, 'looks like a person');
      assert.equal(body.verdict.agenda.llm, undefined);
      assert.equal(body.verdict.agenda.llmError.code, 'refusal');
    }
  );
});

test('an unsupported read (nothing survived citations) attaches no llm block', async () => {
  await withApp(
    {
      readAgenda: async () => ({
        read: null,
        dropped: [{ finding: 'x', reason: 'unresolvable' }],
        reason: 'no observation survived citation checking',
      }),
    },
    async ({ base, cache }) => {
      const body = await (await postVerdict(base, { username: 'spez', deep: true })).json();
      assert.equal(body.verdict.agenda.llm, undefined);
      assert.equal(body.verdict.agenda.llmError.code, 'unsupported');
      // Never cached: an unsupported result should be retried, not remembered.
      assert.equal(cache.getLlmRead('reddit', 'spez'), null);
    }
  );
});

test('a missing deterministic half is a 503 that says which file it wanted', async () => {
  await withApp(
    {
      loadDeterministic: async () => {
        const err = new Error('could not load ../extension/lib/scoring/index.js');
        err.code = 'deterministic-unavailable';
        throw err;
      },
    },
    async ({ base }) => {
      const res = await postVerdict(base, { username: 'spez' });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.match(body.error, /scoring\/index\.js/);
    }
  );
});

test('unknown routes and wrong methods', async () => {
  await withApp({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/verdict`)).status, 405);
    assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
  });
});

// --- CORS -----------------------------------------------------------------

test('a chrome-extension origin is echoed back, whatever the install id', async () => {
  await withApp({}, async ({ base }) => {
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const res = await postVerdict(base, { username: 'spez' }, { origin });
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('vary'), 'Origin');
  });
});

test('a preflight is answered with 204 and the allow headers', async () => {
  await withApp({}, async ({ base }) => {
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const res = await fetch(`${base}/api/verdict`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });
});

test('a disallowed origin is refused outright', async () => {
  await withApp({}, async ({ base }) => {
    const res = await postVerdict(base, { username: 'spez' }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });
});

test('isOriginAllowed matches schemes, exact origins and port variants', () => {
  const allowed = ['chrome-extension://', 'http://localhost', 'https://bot.jiolab.dev'];
  assert.equal(isOriginAllowed('chrome-extension://anything', allowed), true);
  assert.equal(isOriginAllowed('http://localhost', allowed), true);
  assert.equal(isOriginAllowed('http://localhost:5173', allowed), true);
  assert.equal(isOriginAllowed('https://bot.jiolab.dev', allowed), true);
  assert.equal(isOriginAllowed('https://evil.example', allowed), false);
  assert.equal(isOriginAllowed('http://localhost.evil.example', allowed), false);
  // No Origin header at all is not a browser request; CORS is not the control.
  assert.equal(isOriginAllowed(undefined, allowed), true);
  assert.equal(isOriginAllowed('https://anything', ['*']), true);
});
