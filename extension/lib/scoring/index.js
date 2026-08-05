/**
 * The scoring core. THREE SEPARATE SCORES, NEVER ONE BLENDED NUMBER.
 *
 * This is the whole product thesis, so it is worth stating where the code
 * lives rather than only in a ticket. The question being asked is "is this a
 * good-faith participant or a propaganda agent", and those are not points on
 * one axis:
 *
 *   * A crude bot scores high on AUTOMATION and says nothing in particular.
 *   * A paid human posting talking points has a real account age, organic
 *     posting hours and varied language. They score CLEAN on every automation
 *     signal there is — correctly, because no machine is involved — while
 *     scoring high on AGENDA.
 *   * A real person with strong opinions scores high on AGENDA too, and is
 *     told apart from the paid poster by AUTHENTICITY, not by automation.
 *
 * Average those into one "bot score" and the paid poster — the case the whole
 * project exists to find — lands mid-scale next to the opinionated human and
 * the tool has failed at its only job. There is deliberately no combined
 * number anywhere in this module, and adding one is not a small change.
 *
 * `scoreAccount` is PURE: no network, no Date.now(), no storage. The only
 * clock is `profile.fetchedAt`, captured by the source adapter. That is what
 * makes every case in this file testable for free with a hand-built profile.
 */

import { observedSpanDays } from '../sources/profile.js';
import {
  BAND, MIN_COMMENTS_FOR_SCORING, MIN_HISTORY_DAYS, insufficientAxis,
} from './axis.js';
import { scoreAutomation } from './automation.js';
import { scoreAgenda } from './agenda.js';
import { scoreAuthenticity } from './authenticity.js';

export { BAND, MIN_COMMENTS_FOR_SCORING, MIN_HISTORY_DAYS } from './axis.js';

/**
 * @param {import('../sources/profile.js').AccountProfile} profile
 * @param {object} [opts]
 * @returns {Verdict}
 */
export function scoreAccount(profile, opts = {}) {
  if (!profile || typeof profile !== 'object') {
    throw new TypeError('scoreAccount: an AccountProfile is required');
  }

  const gate = checkHistory(profile);

  const axes = gate.sufficient
    ? {
      automation: scoreAutomation(profile, opts),
      agenda: scoreAgenda(profile, opts),
      authenticity: scoreAuthenticity(profile, opts),
    }
    : {
      automation: insufficientAxis(gate.reason),
      agenda: insufficientAxis(gate.reason),
      authenticity: insufficientAxis(gate.reason),
    };

  return Object.freeze({
    username: profile.username,
    platform: profile.platform,
    fetchedAt: profile.fetchedAt,
    automation: axes.automation,
    agenda: axes.agenda,
    authenticity: axes.authenticity,
    headline: buildHeadline(axes, profile, gate),
    coverage: profile.coverage,
  });
}

/**
 * The insufficient-data gate.
 *
 * Thin history returns 'insufficient-data', never a low score. This is the
 * rule that keeps the tool honest at its edges: absence of evidence must not
 * render as innocence, and it must not render as guilt either. A three-day-old
 * account with six comments is genuinely unknown — scoring it "low automation"
 * hands out a clean bill of health the data cannot support, and scoring it
 * suspicious smears every new user on the platform.
 *
 * Both thresholds are named constants in axis.js. The gate is all-or-nothing
 * across all three axes on purpose: partial verdicts on a thin account are
 * exactly what a reader would over-interpret.
 */
function checkHistory(profile) {
  const commentCount = profile.comments.length;
  const historyDays = Number.isFinite(profile.accountAgeDays)
    ? profile.accountAgeDays
    : observedSpanDays(profile);

  if (commentCount < MIN_COMMENTS_FOR_SCORING) {
    return {
      sufficient: false,
      reason: `Only ${commentCount} comments available (need ${MIN_COMMENTS_FOR_SCORING}). Too little history to say anything — this is not a clean result, it is no result.`,
    };
  }

  if (historyDays == null) {
    return {
      sufficient: false,
      reason: 'No usable timestamps, so the account\'s history cannot be dated at all.',
    };
  }

  if (historyDays < MIN_HISTORY_DAYS) {
    return {
      sufficient: false,
      reason: `History spans only ${Math.round(historyDays)} days (need ${MIN_HISTORY_DAYS}). Too little history to say anything — this is not a clean result, it is no result.`,
    };
  }

  return { sufficient: true, reason: null, commentCount, historyDays };
}

/**
 * One sentence naming the SHAPE of the account, built deterministically from
 * the three bands. It never collapses them into a score — it says which
 * combination we are looking at, because the combination is the finding. The
 * paid-poster case gets called out by name, since a reader glancing at "low
 * automation" would otherwise take it as an all-clear.
 */
function buildHeadline(axes, profile, gate) {
  if (!gate.sufficient) {
    return `Not enough history to judge this account. ${gate.reason}`;
  }

  const { automation, agenda, authenticity } = axes;
  const bot = automation.band;
  const push = agenda.band;
  const real = authenticity.band;

  let core;
  if (bot === BAND.HIGH) {
    core = real === BAND.HIGH
      ? 'Posting pattern looks automated, but there is real positive evidence of a person here — worth reading the signals rather than the bands.'
      : 'Posting pattern looks automated.';
  } else if (push === BAND.HIGH && real === BAND.LOW) {
    core = 'No sign of automation, but strongly single-issue with little positive evidence of a person — this is the paid-poster shape, not the bot shape, and an automation check alone would clear it.';
  } else if (push === BAND.HIGH) {
    core = 'No sign of automation, and strongly single-issue — but with genuine markers of a real person, which is what an opinionated human looks like too.';
  } else if (real === BAND.HIGH && push !== BAND.HIGH) {
    core = 'Reads like a real person: no automation markers, no single-issue push, and positive evidence of genuine participation.';
  } else if (bot === BAND.MODERATE || push === BAND.MODERATE) {
    // Never "nothing stands out" when something did. A moderate band is a
    // partial hit, and rounding it down to an all-clear is the same mistake as
    // rounding a thin history down to innocence.
    const flagged = [
      bot === BAND.MODERATE ? 'automation' : null,
      push === BAND.MODERATE ? 'agenda' : null,
    ].filter(Boolean).join(' and ');
    core = `Some ${flagged} markers, none of them conclusive${real === BAND.LOW ? ', and little positive evidence of a real person either' : ''} — read the per-signal working rather than the bands.`;
  } else if (bot === BAND.INSUFFICIENT || push === BAND.INSUFFICIENT || real === BAND.INSUFFICIENT) {
    core = 'Mixed picture, and some signals could not be measured at all — read the per-signal working rather than the bands.';
  } else {
    core = 'Nothing stands out on any axis; no strong evidence either way.';
  }

  const coverageNote = profile.coverage?.truncated
    ? ` Based on the most recent ${profile.coverage.commentsFetched} comments and ${profile.coverage.postsFetched} posts, not the account's full history.`
    : '';

  const errorNote = profile.coverage?.errors?.length
    ? ` ${profile.coverage.errors.length} part of the lookup failed, so some history is missing.`
    : '';

  return `${core}${coverageNote}${errorNote}`;
}
