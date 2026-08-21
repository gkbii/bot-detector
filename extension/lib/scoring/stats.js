/**
 * Pure statistics and text helpers shared by the three scorers.
 *
 * Nothing here touches the network, the clock, or the AccountProfile shape —
 * it is all arrays in, numbers out. That is what makes the scorers testable
 * for free, and it keeps each signal module about *judgement* rather than
 * about arithmetic.
 */

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Map a measurement onto 0..1 between two named endpoints. Every signal's
 * thresholds are expressed as a `rescale(value, floor, ceiling)` call so the
 * numbers that decide a verdict are visible at the call site instead of buried
 * in a formula.
 */
export function rescale(value, floor, ceiling) {
  if (!Number.isFinite(value)) return null;
  if (floor === ceiling) return value >= ceiling ? 1 : 0;
  return clamp01((value - floor) / (ceiling - floor));
}

export function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Coefficient of variation — stdev / mean. Unitless, which is the whole point:
 * it compares the *regularity* of a cadence without caring whether the account
 * posts every 10 seconds or every 10 hours.
 */
export function coefficientOfVariation(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (!Number.isFinite(m) || m <= 0) return null;
  const sd = stdev(xs);
  return sd == null ? null : sd / m;
}

/** Shannon entropy in bits over a list of counts. */
export function entropyBits(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let h = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Entropy as a fraction of the maximum for `buckets` buckets. `buckets` is
 * explicit rather than inferred from the data: for posting hours it is always
 * 24 whether or not the account uses all 24, and inferring it would make an
 * account that posts in exactly two hours, evenly, score a perfect 1.0.
 */
export function normalizedEntropy(counts, buckets) {
  const h = entropyBits(counts);
  if (h == null || buckets <= 1) return null;
  return clamp01(h / Math.log2(buckets));
}

/**
 * Longest run of zero-count buckets, treating the array as a ring. Hours wrap
 * — a sleep cycle of 22:00-06:00 is one 8-hour dead zone, and a linear scan
 * would see it as two short ones and conclude the account never sleeps.
 * Returns the run length and where it starts.
 */
export function longestZeroRunCircular(counts) {
  const n = counts.length;
  if (n === 0) return { length: 0, start: null };
  if (counts.every((c) => c === 0)) return { length: n, start: 0 };

  let best = { length: 0, start: null };
  let run = 0;
  let runStart = null;

  // Two laps: the second lets a run that wraps past the end complete.
  for (let i = 0; i < n * 2; i += 1) {
    const idx = i % n;
    if (counts[idx] === 0) {
      if (run === 0) runStart = idx;
      run += 1;
      if (run > best.length && run <= n) best = { length: run, start: runStart };
    } else {
      run = 0;
      runStart = null;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Remove every link from a body, leaving only what the author actually typed.
 *
 * Load-bearing, and not merely cosmetic (JIO-290, EVALUATION.md Finding 2):
 * `asks-questions` was `body.includes('?')`, so a markdown link with a query
 * string counted as a question. u/RemindMeBot scored 100/100 on the one signal
 * whose whole purpose is positive evidence of a PERSON, on the strength of
 * `?context=3` and two `message/compose/?to=` links. Four shapes are stripped,
 * because bot boilerplate uses all four:
 *
 *   * markdown link targets, including protocol-relative ones (`](/message/…)`)
 *     which none of the other rules would see;
 *   * anything with a scheme, `https://…` through `mailto:`;
 *   * bare `host.tld/path` and `host.tld?a=b` tokens;
 *   * root-relative `/path?a=b`, which has no host at all.
 *
 * The link TEXT survives on purpose: `[does anyone know?](url)` is a question
 * its author wrote, and dropping it would trade one blind spot for another.
 *
 * WHAT MAKES A HOST A HOST (JIO-386). The bare rule was `[\w-]+(?:\.[\w-]+)+/`
 * — two dot-joined word chunks and a slash — and a numeric ratio is exactly
 * that shape. "would you rate it 3.5/10?" was cut to "would you rate it", so a
 * person lost a genuine question on the one signal that is positive evidence
 * of a person, and `normalizeWords()` lost the tokens too. The rule now asks
 * for an ALPHABETIC top-level label of two or more letters, which `3.5/10` and
 * `10.50/hour` fail on `5` and `50` — and so do `U.S./Canada`, `A.I./ML` and
 * `v1.2.3/build`, three more things the old rule quietly ate. The cost of that
 * shape rule, stated rather than discovered: a bare IPv4 literal with a path
 * (`1.1.1.1/help?x=1`) has no alphabetic label anywhere and is NOT stripped.
 * With a scheme it is, and a scheme is how anyone actually writes one.
 *
 * WHAT MAKES A TAIL A LINK. Requiring the slash was JIO-290's own tradeoff,
 * and it left `?` behind in `example.com?utm=1` and `/search?q=cats` — the
 * defect JIO-290 fixed, surviving in the two shapes it did not cover. A query
 * now counts as a link tail on its own, but only if it carries an `=`: that is
 * what keeps "see example.com?" and "is it example.com?" questions, which is
 * the promise the slash used to keep. The root-relative rule needs the `=` for
 * a sharper reason — without it `and/or`, `he/she` and `12/25` are all one
 * lenient rule away from being links.
 *
 * `normalizeWords()` below shares this rather than keeping its own narrower
 * `https?://` strip, so there is one definition of "this is a link, not
 * something a person said". A/B'd against three live accounts before landing:
 * every band and every axis score identical, with u/RemindMeBot's duplicate
 * similarity moving 0.912 -> 0.915 and its stock-phrase count 308 -> 314 —
 * marginally MORE template detected, because the link boilerplate that used to
 * survive as stray words no longer dilutes the shingles.
 *
 * JIO-386's rewrite was re-A/B'd the same way, over all 7469 bodies in
 * `test/corpus/`: not one stripped body differs, and `npm run evaluate`
 * reprints all 81 frozen scores unmoved. That is the no-regression half only.
 * The corpus CANNOT show the fix — the 606 bodies carrying a bare `host.tld?`
 * and the 595 carrying a root-relative `/path?` are all inside a markdown
 * target or a scheme, so an earlier rule had already removed them, and the
 * human half of the corpus is length-matched synthetic filler that quotes no
 * ratios. A frozen corpus is proof a change broke nothing, never proof it did
 * anything; the tests in `test/scoring.test.js` are where the fix is asserted.
 */
export function stripUrls(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\]\([^\s)]*/g, '](')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\bmailto:\S+/gi, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*|\?[^\s?]*=\S*)/gi, ' ')
    .replace(/(^|[\s(])\/[\w./-]*\?[^\s?]*=\S*/g, '$1 ');
}

/**
 * Words, lowercased, with urls, quoted text and punctuation removed. Quotes
 * are dropped because a reply that quotes its parent otherwise looks like a
 * near-duplicate of whatever it is answering.
 */
export function normalizeWords(text) {
  if (typeof text !== 'string') return [];
  return stripUrls(text)
    .toLowerCase()
    .replace(/^&gt;.*$/gm, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Set of n-word shingles. Order-sensitive, which is what catches templates. */
export function shingles(words, n) {
  const set = new Set();
  for (let i = 0; i + n <= words.length; i += 1) {
    set.add(words.slice(i, i + n).join(' '));
  }
  return set;
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Strip a short type prefix from an id (`t3_abc123` -> `abc123`).
 *
 * Deliberately generic. The scorers need to ask "is this comment in the thread
 * of that post", and the two ids come from different endpoints with different
 * prefixing conventions. A `t3_`-aware comparison in a scorer would be Reddit
 * knowledge leaking past the source boundary; this is a shape rule
 * (`<letter><digits>_`) that is simply a no-op on platforms that don't prefix.
 */
export function bareId(id) {
  if (typeof id !== 'string') return null;
  return id.replace(/^[a-z]\d+_/i, '');
}

/** Format a unix-seconds timestamp as YYYY-MM-DD. Pure — reads no clock. */
export function formatDate(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return 'unknown';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Format a 0..1 SHARE. Clamped, because a share above 100% is a bug. */
export function pct(fraction) {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}

/**
 * Format an unbounded ratio as a percentage. Separate from `pct` because a
 * coefficient of variation routinely exceeds 1 — real accounts measure CV 4.5
 * — and clamping it to "100%" next to a printed "CV 4.54" makes the evidence
 * string contradict itself.
 */
export function ratioPct(ratio) {
  if (!Number.isFinite(ratio)) return 'unknown';
  return `${Math.round(ratio * 100)}%`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}
