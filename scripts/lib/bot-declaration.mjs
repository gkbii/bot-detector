/**
 * "This account declares itself a bot." — the ground truth behind the eight
 * bot entries in `test/corpus/`.
 *
 * It is the only ground truth Reddit offers. You cannot verify a paid poster
 * from outside, which is why EVALUATION.md's agenda axis has no real-world
 * validation at all and says so — but a bot that publishes "I am a bot, and
 * this action was performed automatically" is not in dispute, and that is what
 * makes the bot half of this corpus a test rather than a hunch.
 *
 * TWO BASES, AND WHICH ONE ADMITTED AN ACCOUNT IS RECORDED PER ACCOUNT.
 *
 *   `self-declaration` — one of the patterns below matched the account's own
 *   committed comment text. Re-derived from the corpus on every test run
 *   rather than trusted from the manifest, because a "ground truth" nobody
 *   re-checks is a string somebody typed once.
 *
 *   `evaluation-md` — the account is one of the four EVALUATION.md names, and
 *   was hand-read as a bot in the 2026-08-05 run this corpus exists to freeze.
 *
 * WHY THE SECOND BASIS EXISTS, which is the interesting part. `u/RemindMeBot`
 * fails every pattern below — across 299 committed comments. Its boilerplate
 * says "I will be messaging you in 5 hours…", "CLICK THIS LINK to send a PM",
 * and "RemindMeBot is switching to username summons". The only place the word
 * "bot" appears is INSIDE ITS OWN NAME. Admitting it on that would be reading
 * the username, and the one thing EVALUATION.md proved about usernames is that
 * they are a trap: `u/KevinGreeneSolar` reads like a solar business and is a
 * clean human, and a name-based heuristic would have produced a false positive
 * there. The scoring core never looks at a username, and neither does this.
 *
 * So the four EVALUATION.md accounts are admitted BY CITATION to a hand-read
 * recorded in this repository, and the four the capture chose for itself have
 * to earn it from their text. Both are named in the manifest. What is not
 * available is a pattern that quietly stretches to fit whatever we wanted in.
 */

/**
 * WHAT IS DELIBERATELY NOT HERE. Checked against the live archive on
 * 2026-08-18 while filling the four lost slots, and each of these is a
 * conscious non-admission rather than an oversight:
 *
 *   * `u/B0tRank` writes "This bot wants to find the best and worst bots on
 *     Reddit" — a self-declaration in the THIRD PERSON. A `/\bthis bot\b/`
 *     pattern would admit it, and would also match every human who ever typed
 *     "this bot is annoying". First person is the line.
 *   * `u/haikusbot` writes "I detect haikus. And sometimes, successfully." It
 *     describes its function and never claims to be a machine.
 *   * `u/WikiSummarizerBot` and `u/LimbRetrieval-Bot` publish an F.A.Q link, an
 *     opt-out link, a GitHub link and a version number. All four are proof to a
 *     reader and none of them is a sentence.
 *   * `u/of_have_bot`, `u/alphabet_order_bot` and `u/converter-bot` post their
 *     output with no footer at all.
 *
 * Eight of ten obvious bots do not say it. That is worth knowing on its own —
 * "declares itself a bot" is a far smaller population than "is a bot", which is
 * why EVALUATION.md's ground truth is eight accounts rather than a corpus, and
 * why widening these patterns until the accounts we wanted fit through them
 * would destroy the only thing that makes the eight worth anything.
 */
export const DECLARATION_PATTERNS = [
  /\bi\s*(?:'m|am)\s+(?:a|an)\s+(?:\w+\s+){0,2}bot\b/i,
  /\bthis (?:action|comment|post) was performed automatically\b/i,
  /\bbeep\s*b[o0]{2}p\b/i,
  /\bbot\b[^.]{0,80}\bcontact the (?:moderators|mods)\b/i,
];

/**
 * The four accounts EVALUATION.md names as declared bots, with what it says
 * about each. Nothing may be added here without a hand-read to cite; the
 * capture fills the other four slots from text alone.
 */
export const EVALUATION_MD_BOTS = Object.freeze({
  AutoModerator: 'EVALUATION.md Finding 3/4 — 299 comments spanning 0.0 days, 333 subreddits',
  RemindMeBot: 'EVALUATION.md headline and Finding 2 — "u/RemindMeBot is not in dispute"',
  RepostSleuthBot: 'EVALUATION.md Finding 2 — 93/100 "asks a question", all of them URLs',
  sneakpeekbot: 'EVALUATION.md Finding 2 and the JIO-290 re-measure',
});

/** How many of an account's committed comments say it in words. */
export function countDeclarations(comments) {
  let n = 0;
  for (const c of comments) {
    if (typeof c.body === 'string' && DECLARATION_PATTERNS.some((re) => re.test(c.body))) n += 1;
  }
  return n;
}

/**
 * @returns {{admitted: boolean, basis: string|null, declarations: number, note: string}}
 */
export function declarationBasis(username, comments) {
  const declarations = countDeclarations(comments);
  if (declarations > 0) {
    return {
      admitted: true,
      basis: 'self-declaration',
      declarations,
      note: `${declarations} of ${comments.length} committed comments declare it a bot in words`,
    };
  }
  if (Object.hasOwn(EVALUATION_MD_BOTS, username)) {
    return {
      admitted: true,
      basis: 'evaluation-md',
      declarations: 0,
      note: `no pattern matches its text; admitted on the 2026-08-05 hand-read — ${EVALUATION_MD_BOTS[username]}`,
    };
  }
  return {
    admitted: false,
    basis: null,
    declarations: 0,
    note: `no self-declaration in ${comments.length} comments and not one of the four EVALUATION.md names`,
  };
}
