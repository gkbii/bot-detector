/**
 * Bands, signals and axis assembly — the vocabulary all three scorers share.
 *
 * Three rules are enforced here rather than left to each scorer's good
 * intentions:
 *
 *   1. BANDS, NOT FAKE PROBABILITIES. "73% bot" is a lie about precision this
 *      method does not have — there is no calibration set behind it and there
 *      never will be. `score` exists only so a list of accounts can be
 *      ORDERED; the UI leads with the band. Anything that presents `score` as
 *      a likelihood is misusing it.
 *
 *   2. EVERY SIGNAL CARRIES ITS OWN WEIGHT, DIRECTION AND EVIDENCE STRING, and
 *      the evidence is a sentence a human can disagree with — the measured
 *      value, the sample it came from, and what it is taken to mean. A bare
 *      number nobody can argue with is the failure mode. (Same philosophy this
 *      repo already applies to the feasibility scores on its projects page.)
 *
 *   3. ABSENCE OF EVIDENCE IS NOT EVIDENCE. A signal that could not be
 *      measured is emitted with `strength: null` and band 'insufficient-data',
 *      and is EXCLUDED from the weighted average rather than counted as a
 *      clean zero. Counting it as zero is how "we have no data" quietly
 *      becomes "this account is fine".
 */

export const BAND = Object.freeze({
  INSUFFICIENT: 'insufficient-data',
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high',
});

/** score < 30 -> low; < 65 -> moderate; >= 65 -> high. */
export const BAND_THRESHOLDS = Object.freeze({ moderate: 30, high: 65 });

/**
 * The insufficient-data gate. Thin history returns 'insufficient-data', never
 * a low score: a two-week-old account with nine comments is UNKNOWN, and
 * rendering it as "low automation" reads as a clean bill of health the data
 * cannot support — while rendering it as suspicious would smear every new
 * account on the platform. Both thresholds are here, named, in one place.
 */
export const MIN_COMMENTS_FOR_SCORING = 15;
export const MIN_HISTORY_DAYS = 14;

/**
 * An axis needs at least this fraction of its total signal weight actually
 * measured before it reports a band. Otherwise one lucky signal out of seven
 * would set the verdict for the whole axis.
 */
export const MIN_MEASURED_WEIGHT_FRACTION = 0.5;

/** strength >= this reads as "raises"; <= RAISES/LOWERS below reads as "lowers". */
const DIRECTION_RAISES_AT = 0.55;
const DIRECTION_LOWERS_AT = 0.25;

export function bandFromScore(score) {
  if (!Number.isFinite(score)) return BAND.INSUFFICIENT;
  if (score < BAND_THRESHOLDS.moderate) return BAND.LOW;
  if (score < BAND_THRESHOLDS.high) return BAND.MODERATE;
  return BAND.HIGH;
}

/**
 * Build a measured signal.
 *
 * @param {object} spec
 * @param {string} spec.key        stable identifier, used by the UI
 * @param {string} spec.label      short human name
 * @param {number} spec.weight     relative importance within its axis
 * @param {number} spec.strength   0..1, how strongly the observation argues
 *                                 FOR this axis (bot-ness / agenda-ness /
 *                                 realness). Not a probability.
 * @param {*}      spec.value      the raw measurement, for the UI to show
 * @param {string} spec.evidence   the sentence that has to justify the number
 * @param {string} [spec.direction] override the derived direction where the
 *                                 scorer knows better (see off-script dissent)
 */
export function signal({ key, label, weight, strength, value, evidence, direction }) {
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : null;
  return Object.freeze({
    key,
    label,
    band: s == null ? BAND.INSUFFICIENT : bandFromScore(s * 100),
    direction: direction ?? deriveDirection(s),
    weight,
    value: value ?? null,
    evidence,
    strength: s,
  });
}

/**
 * Build a signal we could not measure. It still appears in the output — the
 * UI should show "couldn't check this" rather than silently listing six
 * signals where the other account listed seven.
 */
export function unmeasured({ key, label, weight, value = null, evidence }) {
  return signal({ key, label, weight, strength: null, value, evidence, direction: 'neutral' });
}

function deriveDirection(strength) {
  if (strength == null) return 'neutral';
  if (strength >= DIRECTION_RAISES_AT) return 'raises';
  if (strength <= DIRECTION_LOWERS_AT) return 'lowers';
  return 'neutral';
}

/**
 * Weighted-average the measured signals into an Axis. Unmeasured signals are
 * carried through for display but contribute nothing — see rule 3 above.
 */
export function buildAxis(signals) {
  const measured = signals.filter((s) => s.strength != null);
  const totalWeight = signals.reduce((acc, s) => acc + s.weight, 0);
  const measuredWeight = measured.reduce((acc, s) => acc + s.weight, 0);

  if (!measured.length || totalWeight <= 0
      || measuredWeight / totalWeight < MIN_MEASURED_WEIGHT_FRACTION) {
    return Object.freeze({
      band: BAND.INSUFFICIENT,
      score: null,
      signals: Object.freeze(signals.map(stripInternal)),
    });
  }

  const weighted = measured.reduce((acc, s) => acc + s.weight * s.strength, 0);
  const score = Math.round((weighted / measuredWeight) * 100);

  return Object.freeze({
    band: bandFromScore(score),
    score,
    signals: Object.freeze(signals.map(stripInternal)),
  });
}

/**
 * An axis blocked by the insufficient-data gate. It carries one signal saying
 * why, so the UI has something to render other than an empty list.
 */
export function insufficientAxis(reason) {
  return Object.freeze({
    band: BAND.INSUFFICIENT,
    score: null,
    signals: Object.freeze([
      stripInternal(unmeasured({
        key: 'insufficient-history',
        label: 'Not enough history',
        weight: 1,
        evidence: reason,
      })),
    ]),
  });
}

/**
 * `strength` is the internal 0..1 the weighting runs on; the published signal
 * exposes `band` and `value` instead, so nothing downstream can start treating
 * a strength as a probability.
 */
function stripInternal(s) {
  const { strength, ...published } = s;
  return Object.freeze(published);
}
