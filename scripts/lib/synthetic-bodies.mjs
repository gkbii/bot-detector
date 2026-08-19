/**
 * Length-matched synthetic comment bodies, for the frozen evaluation corpus.
 *
 * WHY THIS EXISTS. `test/corpus/` freezes 25 real accounts so the headline
 * band table in EVALUATION.md can be re-measured with one command instead of a
 * live re-run (JIO-343). Eight of those accounts declare themselves bots and
 * keep their real text — nobody's privacy is at stake in `u/RemindMeBot`'s
 * boilerplate, and the bot half of the corpus is precisely where the wording
 * is the evidence. The other seventeen are real people who wrote real
 * political comments in one r/politics thread and never agreed to have them
 * committed verbatim to a public repository, so their bodies are replaced.
 *
 * WHY IT IS NOT JUST LOREM IPSUM. Replacing text changes the score unless the
 * replacement carries the same measurements. Five things in the scoring core
 * read a body, and this module reproduces each of them exactly:
 *
 *   1. `length-uniformity` (automation, weight 1.5) — the TRIMMED CHARACTER
 *      LENGTH, and nothing else about the text. Reproduced to the character.
 *   2. `near-duplicate-bodies` (automation, 2.5) and `stock-phrasing`
 *      (agenda, 2.5) — word shingles, gated on `normalizeWords().length`.
 *      The WORD COUNT is reproduced; the words themselves are drawn from a
 *      fixed lexicon by a seeded PRNG, so cross-comment repetition is
 *      destroyed. This is the one thing that is NOT preserved, and it is
 *      measured rather than assumed — see `capture-corpus.mjs`, which scores
 *      the real profile and the synthesised profile and records both.
 *   3. `asks-questions` (authenticity, 1.5) — whether `stripUrls(body)`
 *      contains a `?`. Reproduced as a literal trailing `?`.
 *   4. the help-seeking half of the same signal — reproduced by injecting the
 *      canonical form of whichever pattern the real body matched.
 *   5. `self-correction` (authenticity, 2.5) — same treatment: the canonical
 *      form of the FIRST pattern that matched, since the signal itself uses
 *      `.find()`.
 *
 * The canonical forms are the generic English phrases the patterns are made
 * of ("fair point", "does anyone know"), not the person's own sentence. They
 * carry the measurement without carrying the words.
 *
 * Everything else a signal reads — timestamps, groups, thread ids, scores,
 * reply positions, karma, account age — is metadata, is untouched, and is
 * already public.
 *
 * PURE AND SEEDED. No clock, no randomness that is not derived from the
 * account name and the comment id, so re-running the capture against the same
 * accounts produces byte-identical bodies. `test/corpus.test.js` exercises the
 * preservation properties directly.
 */

import { normalizeWords, stripUrls } from '../../extension/lib/scoring/stats.js';

/**
 * MUST STAY IN SYNC WITH `extension/lib/scoring/authenticity.js`. Duplicated
 * rather than imported because that module does not export them, and because
 * the canonical replacement string is a fact about THIS module: it is what we
 * inject, not what the scorer looks for. `test/corpus.test.js` asserts that
 * every canonical here still matches its own pattern and that the pattern
 * order matches the scorer's, so the two cannot drift silently.
 */
export const SELF_CORRECTION_CANONICAL = [
  [/\bi was wrong\b/i, 'i was wrong'],
  [/\byou(?:'| a)?re right\b/i, 'youre right'],
  [/\bfair (?:point|enough)\b/i, 'fair point'],
  [/\bgood (?:catch|point)\b/i, 'good point'],
  [/\bi stand corrected\b/i, 'i stand corrected'],
  [/\bi misremembered\b/i, 'i misremembered'],
  [/\bi misread\b/i, 'i misread'],
  [/\bmy (?:mistake|bad)\b/i, 'my mistake'],
  [/\bi'?m wrong\b/i, 'im wrong'],
  [/\bcorrection\b/i, 'correction'],
  [/(?:^|\s)edit\s*[:\-]/i, ' edit:'],
  [/\bTIL\b/, 'TIL'],
  [/\bturns out i\b/i, 'turns out i'],
  [/\bthanks for (?:the )?correct/i, 'thanks for correcting'],
];

export const HELP_SEEKING_CANONICAL = [
  [/\bdoes anyone know\b/i, 'does anyone know'],
  [/\bcan (?:someone|anyone)\b/i, 'can someone'],
  [/\bhow do i\b/i, 'how do i'],
  [/\bany (?:idea|advice|suggestions|recommendations)\b/i, 'any advice'],
  [/\bam i missing\b/i, 'am i missing'],
  [/\bwhat am i doing wrong\b/i, 'what am i doing wrong'],
  [/\bnot sure (?:if|how|what|why)\b/i, 'not sure if'],
  [/\bgenuine question\b/i, 'genuine question'],
];

/**
 * Filler vocabulary. Deliberately bland, concrete and topic-free: the point is
 * to occupy the right number of words and characters while saying nothing, so
 * that nothing in the frozen corpus can be mistaken for something a real
 * person wrote. Kept large enough (200+) that a chance 6-word collision across
 * two comments — which would forge a `stock-phrasing` hit — is not a thing
 * that happens: 200^6 is 6.4e13 and an account contributes at most ~2e4
 * six-grams.
 */
const LEXICON = ('alder amber anchor apple arbor arch arrow ash aspen atlas attic autumn awning axle '
  + 'badge bamboo barrel basin beacon beam bell birch biscuit blanket bloom board bolt boulder bracket '
  + 'branch brass bridge bristle bronze brook broom bucket bundle burrow cabin cable cactus canal candle '
  + 'canvas canyon carpet cavern cedar cellar chalk channel chapel chart chimney cinder cistern clay cliff '
  + 'clover coast cobble compass copper coral cotton crate creek crest crown crystal cupboard current curtain '
  + 'cushion dahlia daisy dawn delta desk dial ditch dock dome doorway drift dune dusk eagle ember estuary '
  + 'fabric fathom feather fennel fern ferry fiddle field filament finch flagstone flannel flask fleece flint '
  + 'foliage forge fountain foyer freckle frost furrow gable garden gate gauge gazebo ginger glacier glade glass '
  + 'granite grate gravel grove gully gutter hamlet handle harbor hatch hazel headland hearth heather hedge '
  + 'hollow honey hoop horizon hostel hutch inlet iris ironwood ivy jasmine jetty juniper kettle keystone kiln '
  + 'knoll lantern larch lattice lavender ledge lichen lighthouse lilac linen lintel lobby locket lumber mantle '
  + 'maple marble marigold marsh meadow mesa millet mineral mirror mist moor mortar mosaic moss nettle nickel '
  + 'oak oat orchard outcrop paddle pane pantry parcel pasture pebble pewter pillar pine plateau plaza pollen '
  + 'poplar porch prairie quarry quartz quill rafter railing rapids ravine reed reef ridge rivulet rope rowan '
  + 'rudder rushes saddle sage sandbar sapling satchel scaffold seam sedge shale shelf shingle shutter silt '
  + 'sinew slate sleet slope sorrel spindle spire spruce stairway stem stipple stone stoop stove strand stream '
  + 'stucco sumac summit swale sycamore tarn teal terrace thicket thimble thistle thorn thread tidepool timber '
  + 'tinder toolshed torrent tower trellis trestle trough tundra tunnel turret twine valley vane vault veranda '
  + 'vine wagon walnut watercourse weathervane wharf wicker willow window woodland yarrow').split(/\s+/);

/**
 * A body whose normalised word count is ZERO — a comment that was nothing but
 * a link, or nothing but a quote of its parent — cannot be filled with words
 * without inventing one. A run of full stops is the only filler that survives
 * `normalizeWords` as the empty list while still occupying the right number of
 * characters.
 */
const NO_WORD_FILLER = '.';

/** mulberry32, seeded from a string. Deterministic across machines and runs. */
function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The measurements a body contributes to the three axes. */
export function bodyMeasurements(body) {
  const text = typeof body === 'string' ? body : '';
  const stripped = stripUrls(text);
  return {
    length: text.trim().length,
    words: normalizeWords(text).length,
    hasQuestionMark: stripped.includes('?'),
    selfCorrectionIndex: SELF_CORRECTION_CANONICAL.findIndex(([re]) => re.test(text)),
    helpSeeking: HELP_SEEKING_CANONICAL.some(([re]) => re.test(stripped)),
  };
}

/**
 * Build one synthetic body carrying the same measurements as `realBody`.
 *
 * @param {string} realBody
 * @param {string} seedText  stable per comment — `${username}:${commentId}`
 * @returns {{ body: string, warnings: string[] }} `warnings` names every
 *          measurement that could NOT be reproduced. It is never swallowed:
 *          the caller writes it into the corpus manifest, because a corpus
 *          that quietly failed to match is worse than one that says so.
 */
export function synthesizeBody(realBody, seedText) {
  const want = bodyMeasurements(realBody);
  const warnings = [];

  // Reserved, in order: the self-correction phrase, the help-seeking phrase,
  // then filler. Injected phrases are never padded or trimmed — mutating them
  // is how the regex they exist to satisfy stops matching.
  const fixed = [];
  if (want.selfCorrectionIndex >= 0) {
    fixed.push(...SELF_CORRECTION_CANONICAL[want.selfCorrectionIndex][1].trim().split(/\s+/));
  }
  if (want.helpSeeking) {
    fixed.push(...HELP_SEEKING_CANONICAL.find(([re]) => re.test(stripUrls(realBody)))[1].split(/\s+/));
  }

  // `?` costs one character and no words: normalizeWords drops punctuation.
  const suffix = want.hasQuestionMark ? '?' : '';
  const targetLength = want.length - suffix.length;

  if (want.words === 0) {
    const body = NO_WORD_FILLER.repeat(Math.max(0, targetLength)) + suffix;
    return finish(body, want, warnings);
  }

  const rand = seededRandom(seedText);
  const words = [...fixed];
  while (words.length < want.words) words.push(LEXICON[Math.floor(rand() * LEXICON.length)]);
  if (words.length > want.words) {
    warnings.push(`word count ${words.length} > ${want.words}: the preserved phrases alone are longer than the original`);
  }

  // Which words may be resized. Never the injected phrases.
  const flexible = [];
  for (let i = fixed.length; i < words.length; i += 1) flexible.push(i);

  // Characters we must land on, excluding the single spaces between words.
  let budget = targetLength - (words.length - 1) - words.reduce((a, w) => a + w.length, 0);

  // Too short: grow filler words a letter at a time, round-robin, so no single
  // word becomes an implausible slab.
  for (let i = 0; budget > 0 && flexible.length; i += 1, budget -= 1) {
    const at = flexible[i % flexible.length];
    words[at] += 'e';
  }
  // Too short and NOTHING is growable — the whole body is a preserved phrase,
  // e.g. a human whose entire comment was "TIL." Full stops take up the
  // remaining characters without changing the word count, because
  // normalizeWords drops them. Found by the case above: without this the body
  // came out one character short and reported it as a warning, which would
  // have moved `length-uniformity` by a hair for no reason.
  let tail = '';
  if (budget > 0 && !flexible.length) { tail = '.'.repeat(budget); budget = 0; }
  // Too long: shave filler words, never below one letter.
  for (let pass = 0; budget < 0 && pass < 64; pass += 1) {
    let shaved = false;
    for (const at of flexible) {
      if (budget >= 0) break;
      if (words[at].length > 1) { words[at] = words[at].slice(0, -1); budget += 1; shaved = true; }
    }
    if (!shaved) break;
  }
  // Still too long: the original was mostly punctuation or markup, so there is
  // no room for this many words. Drop filler rather than miss the length.
  while (budget < 0 && flexible.length) {
    const at = flexible.pop();
    budget += words[at].length + 1;
    words.splice(at, 1);
  }
  if (budget !== 0) warnings.push(`length off by ${budget} after adjustment`);

  return finish(words.join(' ') + tail + suffix, want, warnings);
}

function finish(body, want, warnings) {
  // VERIFY, DO NOT ASSUME. Everything above is arithmetic that can be one off;
  // this re-measures the thing we actually produced and reports each property
  // that came out different. The capture refuses to write a corpus file whose
  // warnings are non-empty unless told to.
  const got = bodyMeasurements(body);
  for (const key of ['length', 'words', 'hasQuestionMark', 'selfCorrectionIndex', 'helpSeeking']) {
    if (got[key] !== want[key]) warnings.push(`${key}: wanted ${want[key]}, produced ${got[key]}`);
  }
  return { body, warnings: [...new Set(warnings)] };
}

/**
 * Replace every comment body in a profile. Returns a new profile object — the
 * input is frozen, and the corpus writer wants a plain serialisable one anyway.
 */
export function synthesizeProfileBodies(profile) {
  const warnings = [];
  const comments = profile.comments.map((c, i) => {
    const { body, warnings: w } = synthesizeBody(c.body, `${profile.username}:${c.id ?? i}`);
    for (const message of w) warnings.push(`${c.id ?? `#${i}`}: ${message}`);
    return { ...c, body };
  });
  // Post TITLES are left alone: no scoring signal reads a title (grep for
  // `.title` outside the source adapter), and blanking them would remove the
  // one human-readable handle on what a frozen post actually was.
  return { profile: { ...profile, comments }, warnings };
}
