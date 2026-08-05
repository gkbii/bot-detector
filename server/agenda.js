// The Claude agenda read -- the thing pattern-matching cannot do, and the one
// intelligence-sensitive call in this project.
//
// The deterministic half (posting cadence, burstiness, group concentration,
// account age vs. volume) runs in the browser and needs no server. What it
// cannot tell you is the difference between narrative repetition and a person
// with a hobbyhorse, or between stock talking points and an opinion someone
// genuinely holds and has held consistently for three years. Both look
// identical to a frequency counter. That judgement is what this call buys, and
// it is why the default model is Opus rather than Haiku -- the same reasoning
// as task-runner's CHESS_SYNTHESIS_MODEL.
//
// A DIRECT MESSAGES API CALL, NOT A `claude -p` SPAWN. Per this repo's
// convention (see task-runner/src/chess/synthesis.js and
// src/linear/classify.js, which this is modelled on): a call whose entire
// output is one structured object is an API call with a JSON-schema response
// format, not a Claude Code session. There are no tools to run and no files to
// edit.
//
// ===========================================================================
// CITATIONS ARE VERIFIED, NOT TRUSTED. This is the load-bearing rule here.
// ===========================================================================
// Every finding must cite comment ids from the pack that pack.js built. On
// return, each cited id is resolved against the pack that was actually sent:
//
//   * an id that doesn't resolve is dropped and reported, never rendered;
//   * a finding left with no resolvable citation is rejected outright;
//   * if nothing survives, this returns NO LLM BLOCK rather than an
//     unsupported one.
//
// This is the identical rule synthesis.js applies to its game citations, for
// the identical reason -- and it matters more here. A confident paragraph
// about a stranger's chess is merely wrong; a confident paragraph about a
// stranger's motives reads as true whether or not it is, and the person it
// describes is not in the room to object.
//
// WHAT THE MODEL IS ASKED FOR. Evidence and a band. Never a verdict on the
// person, and never an identity claim -- no guesses about who the account
// belongs to, who they work for, where they are, or what they are paid. The
// system prompt says so explicitly and the schema gives it nowhere to put such
// a claim.

import config from './config.js';
import { renderPack } from './pack.js';

export class AgendaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgendaError';
    this.code = code;
  }
}

let client = null;

async function getClient() {
  if (client) return client;
  if (!config.anthropicApiKey) {
    throw new AgendaError(
      'no-api-key',
      'ANTHROPIC_API_KEY not set in bot-detector/.env -- the agenda read is unavailable; ' +
        'the deterministic verdict still works.'
    );
  }
  // Imported lazily so this module (and its tests) load without the SDK
  // installed -- the deterministic half of the server has no need of it.
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (err) {
    throw new AgendaError(
      'sdk-missing',
      `@anthropic-ai/sdk is not installed in bot-detector/ (${err.message})`
    );
  }
  client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

/** Test-only: injects a fake client (an object exposing `messages.create`). */
export function _setClientForTests(fake) {
  client = fake;
}

/** Test-only: forces a fresh client. */
export function _resetClientForTests() {
  client = null;
}

const BANDS = ['insufficient-data', 'low', 'moderate', 'high'];

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    band: {
      type: 'string',
      enum: BANDS,
      description:
        "How strongly the sample supports the reading that this account is pushing an agenda rather than talking. 'insufficient-data' when the sample is too thin or too varied to say -- use it freely; it is the correct answer more often than not.",
    },
    summary: {
      type: 'string',
      description:
        'Two or three sentences describing what the account actually does, in plain language, as evidence rather than as a verdict. Describe the posting, not the person.',
    },
    findings: {
      type: 'array',
      description:
        'Zero to five specific, separately-evidenced observations. Zero is a valid answer when the sample supports nothing.',
      items: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'A short lowercase slug for this observation, e.g. "repeated-framing" or "single-issue-focus".',
          },
          label: {
            type: 'string',
            description: 'A short human-readable label, under 60 characters.',
          },
          rationale: {
            type: 'string',
            description:
              'What in the cited comments supports this, and -- explicitly -- what would explain it innocently. If the innocent explanation fits as well, say so and band this low.',
          },
          band: {
            type: 'string',
            enum: BANDS,
            description: 'How strongly the cited comments support this specific observation.',
          },
          citations: {
            type: 'array',
            description:
              'The comments this observation is about. Use only ids listed in the pack. Citations are checked; an observation whose citations do not resolve is discarded entirely.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A comment id from the pack, e.g. "C7".' },
                note: {
                  type: 'string',
                  description: 'A short phrase on what this specific comment shows.',
                },
              },
              required: ['id', 'note'],
              additionalProperties: false,
            },
          },
        },
        required: ['key', 'label', 'rationale', 'band', 'citations'],
        additionalProperties: false,
      },
    },
    notes: {
      type: 'string',
      description:
        'What the sample cannot settle: size, coverage gaps, topics absent from it. Empty string if none.',
    },
  },
  required: ['band', 'summary', 'findings', 'notes'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You are reading a sample of one public forum account's own comments and describing what its posting looks like. Everything you are given is public.

You are NOT deciding whether this account is a bot, and you are NOT reaching a verdict on a person. Automation is measured separately by deterministic signals you never see. Your job is narrower and harder: does this account's writing show the marks of an agenda being pushed, or is it a person talking?

The distinction you are being paid for is the one frequency counting cannot make:

- Narrative repetition versus a hobbyhorse. Someone who brings up the same subject constantly is usually just interested in it. What is different is a repeated FRAME arriving pre-assembled — the same rhetorical construction, the same handful of phrasings, the same move deployed across contexts where a person would have varied their argument.
- Stock talking points versus a genuine opinion held consistently. Consistency is not suspicious; people are consistent. What is different is an argument that never develops, never concedes a point, never gets adapted to what it is replying to, and never shows any sign of the person having thought about it since the first time.
- Topic concentration versus coordination. A single-issue account is a normal thing to be.

Every observation you make must cite specific comment ids from the pack. Those citations are checked against the pack afterwards, and an observation whose citations do not resolve is discarded — an uncited claim does not survive, so do not make one.

State the innocent explanation. For each observation, say what would explain it if this is an ordinary person, and if that explanation fits the evidence just as well, say so and band the observation low. The failure mode of this task is a fluent paragraph that reads as true about a stranger who is not here to correct it. Prefer 'insufficient-data' and prefer saying nothing to reaching.

Never speculate about identity. Do not guess or imply who the account belongs to, their real name, nationality, employer, politics, whether they are paid, or which organisation they might act for. Describe the posting. If your sentence is about a person rather than about comments, delete it.

Note what the sample cannot settle. It is a spread across the account's groups and history, not the whole of it.`;

export function buildUserMessage(rendered) {
  return `Here is the evidence pack.\n\n${rendered}\n\nWhat does this account's posting look like?`;
}

/**
 * Resolves a response's citations against the pack that produced it.
 *
 * Returns `{ findings, dropped }`: `findings` carry resolved citations
 * (real comment id, group, date) so a cached read is readable later without
 * re-deriving anything, and `dropped` lists what was thrown away and why. See
 * this file's header for why this is not a trust-the-model path.
 *
 * Deliberately does NOT throw when everything is rejected -- the caller
 * returns no LLM block in that case, which is the correct outcome, not an
 * error condition.
 */
export function resolveFindings(parsed, pack) {
  const findings = [];
  const dropped = [];

  for (const finding of parsed.findings || []) {
    const citations = [];
    // Held per-finding rather than pushed straight into `dropped`: if the
    // finding itself goes on to fail, the one finding-level rejection says
    // everything these would have, and reporting both double-counts it.
    const badCitations = [];

    for (const citation of finding.citations || []) {
      const entry = pack.byId.get(citation.id);
      if (!entry) {
        badCitations.push({
          finding: finding.key || finding.label || '(unnamed)',
          citation: citation.id,
          reason: 'no such comment in the evidence pack',
        });
        continue;
      }
      citations.push({
        id: entry.id,
        note: citation.note,
        commentId: entry.comment.id,
        group: entry.comment.group,
        createdUtc: entry.comment.createdUtc,
        threadId: entry.comment.threadId,
      });
    }

    if (citations.length === 0) {
      dropped.push({
        finding: finding.key || finding.label || '(unnamed)',
        citation: null,
        reason:
          'every citation was unresolvable, so nothing supports this observation' +
          (badCitations.length ? ` (${badCitations.map((c) => c.citation).join(', ')})` : ''),
      });
      continue;
    }

    dropped.push(...badCitations);
    findings.push({
      key: finding.key,
      label: finding.label,
      rationale: finding.rationale,
      band: BANDS.includes(finding.band) ? finding.band : 'insufficient-data',
      citations,
    });
  }

  return { findings, dropped };
}

/**
 * Runs the agenda read over one evidence pack.
 *
 * @param {object} params
 * @param {object} params.pack - a pack.js buildPack() result.
 * @param {object} [params.client] - injectable client (tests).
 * @returns {Promise<{ read: object|null, dropped: Array<object>, reason?: string }>}
 *   `read` is null when no finding survived citation checking -- the caller
 *   attaches no LLM block in that case.
 * @throws {AgendaError} on refusal, a max_tokens stop, an unparseable
 *   response, a missing key or a missing SDK. Every one of those leaves the
 *   deterministic verdict intact; the caller reports the failure alongside it.
 */
export async function readAgenda({
  pack,
  client: injected,
  model = config.agendaModel,
  maxTokens = config.agendaMaxTokens,
} = {}) {
  if (!pack || !Array.isArray(pack.entries) || pack.entries.length === 0) {
    throw new AgendaError('empty-pack', 'readAgenda(): the evidence pack has no comments in it');
  }

  const anthropic = injected || (await getClient());

  const response = await anthropic.messages.create({
    model,
    // Thinking is ON BY DEFAULT on Opus 5 and is deliberately not disabled --
    // this is exactly the kind of judgement it helps with. It also counts
    // against max_tokens together with the response text, which is why the
    // budget is well above what the JSON itself needs.
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    // Structured output. NOT the deprecated top-level `output_format`, and
    // deliberately not combined with citations (incompatible) -- our citations
    // are pack ids we verify ourselves, which is stronger anyway.
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    // No temperature / top_p / top_k: all three are rejected on Opus 5.
    messages: [{ role: 'user', content: buildUserMessage(renderPack(pack)) }],
  });

  // MUST come before touching `content`: a refusal is an HTTP 200 with empty
  // or partial content, so `content[0]` would throw on the one path where a
  // clear error matters most.
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category || 'unspecified';
    throw new AgendaError(
      'refusal',
      `Claude declined to read this account (safety refusal, category: ${category})`
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new AgendaError(
      'max-tokens',
      `readAgenda(): hit max_tokens (${maxTokens}) before finishing -- raise BOT_AGENDA_MAX_TOKENS`
    );
  }

  const textBlock = (response.content || []).find((block) => block.type === 'text');
  if (!textBlock) {
    throw new AgendaError('no-text-block', 'readAgenda(): no text block in Claude response');
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new AgendaError(
      'unparseable',
      `readAgenda(): failed to parse Claude's JSON response: ${err.message}`
    );
  }

  const { findings, dropped } = resolveFindings(parsed, pack);

  if (findings.length === 0) {
    return {
      read: null,
      dropped,
      reason:
        dropped.length > 0
          ? 'no observation survived citation checking'
          : 'the model reported no observations',
    };
  }

  return {
    read: {
      band: BANDS.includes(parsed.band) ? parsed.band : 'insufficient-data',
      summary: parsed.summary || '',
      notes: parsed.notes || '',
      findings,
      dropped,
      model: response.model || model,
      usage: response.usage || null,
      readAt: new Date().toISOString(),
      sample: { selected: pack.selected, available: pack.available },
    },
    dropped,
  };
}

export { BANDS };
