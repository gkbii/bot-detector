// The Claude agenda read. No network: every test injects a fake client.
//
// The bulk of this file is the citation verifier, because that is the rule the
// whole feature rests on -- a confident paragraph about a stranger's motives
// reads as true whether or not it is, so a claim that cannot be resolved
// against the pack we actually sent does not get rendered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, selectComments, spreadOrder, renderPack } from '../pack.js';
import { AgendaError, readAgenda, resolveFindings, RESPONSE_SCHEMA } from '../agenda.js';

function comment(i, { group = 'politics', createdUtc = 1_700_000_000 + i * 86400 } = {}) {
  return {
    id: `t1_${i}`,
    createdUtc,
    group,
    body: `comment number ${i} saying something`,
    score: i,
    threadId: `t3_${i}`,
    parentId: null,
    isTopLevel: i % 2 === 0,
  };
}

function profileWith(comments) {
  return {
    platform: 'reddit',
    username: 'someone',
    id: 'abc',
    fetchedAt: '2026-08-05T00:00:00Z',
    accountAgeDays: 900,
    firstSeenUtc: 1_600_000_000,
    karma: { post: 10, comment: 900, total: 910 },
    counts: { comments: comments.length, posts: 0 },
    comments,
    posts: [],
    coverage: {
      commentsFetched: comments.length,
      commentsTotal: comments.length,
      postsFetched: 0,
      postsTotal: 0,
      truncated: false,
      oldestFetchedUtc: 1_600_000_000,
      sources: ['arctic-shift'],
      errors: [],
    },
  };
}

const PACK = buildPack(profileWith([comment(1), comment(2), comment(3)]));

function fakeClient(response, capture = {}) {
  return {
    messages: {
      create: async (params) => {
        capture.params = params;
        return response;
      },
    },
  };
}

function jsonResponse(payload) {
  return {
    stop_reason: 'end_turn',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// --- the citation verifier ------------------------------------------------

test('resolvable citations survive and carry the real comment metadata', () => {
  const { findings, dropped } = resolveFindings(
    {
      findings: [
        {
          key: 'repeated-framing',
          label: 'Same frame, three contexts',
          rationale: 'because',
          band: 'moderate',
          citations: [
            { id: 'C1', note: 'first' },
            { id: 'C3', note: 'third' },
          ],
        },
      ],
    },
    PACK
  );

  assert.equal(dropped.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].citations.length, 2);
  // Resolved against the pack, so a cached read is readable later without
  // re-deriving anything.
  assert.equal(findings[0].citations[0].commentId, 't1_1');
  assert.equal(findings[0].citations[0].group, 'politics');
});

test('an unresolvable citation is dropped and reported, the finding survives', () => {
  const { findings, dropped } = resolveFindings(
    {
      findings: [
        {
          key: 'k',
          label: 'l',
          rationale: 'r',
          band: 'low',
          citations: [
            { id: 'C1', note: 'real' },
            { id: 'C99', note: 'invented' },
          ],
        },
      ],
    },
    PACK
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].citations.length, 1, 'only the resolvable citation is kept');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].citation, 'C99');
  assert.match(dropped[0].reason, /no such comment/);
});

test('a finding whose citations ALL fail is rejected outright', () => {
  const { findings, dropped } = resolveFindings(
    {
      findings: [
        { key: 'bogus', label: 'l', rationale: 'r', band: 'high', citations: [{ id: 'C42', note: 'x' }] },
        { key: 'good', label: 'l', rationale: 'r', band: 'low', citations: [{ id: 'C2', note: 'y' }] },
      ],
    },
    PACK
  );

  assert.deepEqual(findings.map((f) => f.key), ['good']);
  // One rejection, not two: the finding-level rejection says everything the
  // per-citation one would, and reporting both double-counts it.
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].finding, 'bogus');
  assert.match(dropped[0].reason, /every citation was unresolvable/);
});

test('a finding with no citations at all is rejected', () => {
  const { findings, dropped } = resolveFindings(
    { findings: [{ key: 'k', label: 'l', rationale: 'r', band: 'high', citations: [] }] },
    PACK
  );
  assert.equal(findings.length, 0);
  assert.equal(dropped.length, 1);
});

test('an out-of-range band on a finding degrades to insufficient-data', () => {
  const { findings } = resolveFindings(
    {
      findings: [
        { key: 'k', label: 'l', rationale: 'r', band: 'certain', citations: [{ id: 'C1', note: 'x' }] },
      ],
    },
    PACK
  );
  assert.equal(findings[0].band, 'insufficient-data');
});

// --- readAgenda end to end (fake client) ----------------------------------

test('readAgenda returns NO llm block when nothing survives citation checking', async () => {
  const client = fakeClient(
    jsonResponse({
      band: 'high',
      summary: 'this account is coordinated',
      notes: '',
      findings: [
        { key: 'k', label: 'l', rationale: 'r', band: 'high', citations: [{ id: 'C77', note: 'x' }] },
      ],
    })
  );

  const result = await readAgenda({ pack: PACK, client });
  // An unsupported paragraph about a stranger is worse than no paragraph.
  assert.equal(result.read, null);
  assert.equal(result.dropped.length, 1);
  assert.match(result.reason, /survived citation checking/);
});

test('readAgenda returns no llm block when the model reports nothing', async () => {
  const client = fakeClient(
    jsonResponse({ band: 'insufficient-data', summary: 'nothing to say', notes: '', findings: [] })
  );
  const result = await readAgenda({ pack: PACK, client });
  assert.equal(result.read, null);
  assert.match(result.reason, /no observations/);
});

test('readAgenda returns a read when at least one finding survives', async () => {
  const client = fakeClient(
    jsonResponse({
      band: 'moderate',
      summary: 'summary text',
      notes: 'thin sample',
      findings: [
        { key: 'k', label: 'l', rationale: 'r', band: 'moderate', citations: [{ id: 'C2', note: 'x' }] },
        { key: 'bad', label: 'l', rationale: 'r', band: 'high', citations: [{ id: 'C9', note: 'x' }] },
      ],
    })
  );

  const { read } = await readAgenda({ pack: PACK, client });
  assert.equal(read.band, 'moderate');
  assert.equal(read.findings.length, 1);
  assert.equal(read.notes, 'thin sample');
  assert.equal(read.dropped.length, 1, 'the silent degradation stays visible on the read itself');
  assert.deepEqual(read.sample, { selected: 3, available: 3 });
});

// --- the refusal path -----------------------------------------------------

test('a refusal throws before content is read (content is empty on a refusal)', async () => {
  // The API returns HTTP 200 for a refusal, with empty or partial content --
  // so indexing content[0] unconditionally would throw a TypeError on exactly
  // the path where a clear error matters most.
  const client = fakeClient({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber' },
    content: [],
    model: 'claude-opus-5',
  });

  await assert.rejects(
    () => readAgenda({ pack: PACK, client }),
    (err) => {
      assert.ok(err instanceof AgendaError);
      assert.equal(err.code, 'refusal');
      assert.match(err.message, /cyber/);
      return true;
    }
  );
});

test('a refusal with no stop_details still produces a clean error', async () => {
  const client = fakeClient({ stop_reason: 'refusal', content: [] });
  await assert.rejects(() => readAgenda({ pack: PACK, client }), { code: 'refusal' });
});

test('a max_tokens stop names the knob to raise instead of blaming the model', async () => {
  const client = fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ba' }] });
  await assert.rejects(() => readAgenda({ pack: PACK, client }), (err) => {
    assert.equal(err.code, 'max-tokens');
    assert.match(err.message, /BOT_AGENDA_MAX_TOKENS/);
    return true;
  });
});

test('an unparseable body is reported as such', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });
  await assert.rejects(() => readAgenda({ pack: PACK, client }), { code: 'unparseable' });
});

test('a response with no text block is reported as such', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] });
  await assert.rejects(() => readAgenda({ pack: PACK, client }), { code: 'no-text-block' });
});

test('an empty pack is refused before any API call', async () => {
  let called = false;
  const client = { messages: { create: async () => { called = true; } } };
  await assert.rejects(
    () => readAgenda({ pack: buildPack(profileWith([])), client }),
    { code: 'empty-pack' }
  );
  assert.equal(called, false);
});

// --- the request shape (verified API details worth pinning) ----------------

test('the request uses a json_schema output_config and no sampling parameters', async () => {
  const capture = {};
  const client = fakeClient(
    jsonResponse({ band: 'low', summary: 's', notes: '', findings: [] }),
    capture
  );
  await readAgenda({ pack: PACK, client });

  const { params } = capture;
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.format.schema, RESPONSE_SCHEMA);
  // The deprecated top-level parameter must not be used.
  assert.equal(params.output_format, undefined);
  // All three return a 400 on Opus 5.
  assert.equal(params.temperature, undefined);
  assert.equal(params.top_p, undefined);
  assert.equal(params.top_k, undefined);
  // Thinking is on by default and is deliberately not disabled.
  assert.equal(params.thinking, undefined);
  assert.ok(params.max_tokens >= 8000, 'the budget must leave room for thinking + JSON');
  assert.ok(params.system.includes('Never speculate about identity'));
});

test('the schema is strict enough for structured outputs', () => {
  assert.equal(RESPONSE_SCHEMA.additionalProperties, false);
  assert.deepEqual(RESPONSE_SCHEMA.required, ['band', 'summary', 'findings', 'notes']);
  const finding = RESPONSE_SCHEMA.properties.findings.items;
  assert.equal(finding.additionalProperties, false);
  assert.equal(finding.properties.citations.items.additionalProperties, false);
  // Nowhere to put an identity claim.
  assert.deepEqual(Object.keys(finding.properties).sort(), [
    'band',
    'citations',
    'key',
    'label',
    'rationale',
  ]);
});

// --- the pack (deterministic, no network) ---------------------------------

test('the pack caps comments and spreads them across groups, not the most recent N', () => {
  const comments = [
    ...Array.from({ length: 40 }, (_, i) => comment(i, { group: 'politics' })),
    ...Array.from({ length: 5 }, (_, i) => comment(100 + i, { group: 'cooking' })),
    ...Array.from({ length: 2 }, (_, i) => comment(200 + i, { group: 'knitting' })),
  ];
  const pack = buildPack(profileWith(comments), { maxComments: 10 });

  assert.equal(pack.selected, 10);
  assert.equal(pack.available, 47);
  const groups = new Set(pack.entries.map((e) => e.comment.group));
  // A most-recent-10 slice would have picked knitting only; a spread must
  // represent every place the account posts.
  assert.deepEqual([...groups].sort(), ['cooking', 'knitting', 'politics']);
});

test('pack ids are C1..Cn in chronological order and resolve back to comments', () => {
  const pack = buildPack(profileWith([comment(3), comment(1), comment(2)]));
  assert.deepEqual(pack.entries.map((e) => e.id), ['C1', 'C2', 'C3']);
  assert.deepEqual(pack.entries.map((e) => e.comment.id), ['t1_1', 't1_2', 't1_3']);
  assert.equal(pack.byId.get('C2').comment.id, 't1_2');
});

test('empty and whitespace-only comments never enter the pack', () => {
  const pack = buildPack(
    profileWith([comment(1), { ...comment(2), body: '   ' }, { ...comment(3), body: '' }])
  );
  assert.equal(pack.selected, 1);
});

test('long bodies are truncated rather than dropped, so ids stay stable', () => {
  const long = { ...comment(1), body: 'x'.repeat(5000) };
  const pack = buildPack(profileWith([long]), { maxCommentChars: 50 });
  assert.equal(pack.selected, 1);
  assert.ok(pack.entries[0].text.length < 100);
  assert.match(pack.entries[0].text, /truncated/);
});

test('spreadOrder covers the whole range and its prefixes are spread', () => {
  const order = spreadOrder(8);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(spreadOrder(0).length, 0);
  // A 3-element prefix of an 8-element range must not all sit at one end.
  const prefix = order.slice(0, 3);
  assert.ok(Math.max(...prefix) - Math.min(...prefix) >= 3);
});

test('selectComments is a no-op when the account is under the cap', () => {
  const comments = [comment(2), comment(1)];
  assert.deepEqual(selectComments(comments, 10).map((c) => c.id), ['t1_1', 't1_2']);
});

test('renderPack prints the ids the model is told to cite, and no more', () => {
  const rendered = renderPack(PACK);
  assert.match(rendered, /^C1 \[/m);
  assert.match(rendered, /Cite these by id exactly as written/);
  assert.match(rendered, /Sample: 3 of 3 available comments/);
  assert.doesNotMatch(rendered, /C4/);
});
