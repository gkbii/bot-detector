// Username normalisation and validation.
//
// This is a security boundary, not a nicety: the value that comes out of here
// is interpolated into an outbound URL to the Reddit archive. Anything that
// isn't a real Reddit handle -- a path segment, a query string, an encoded
// slash, a scheme -- has to be rejected here rather than sanitised downstream,
// because "sanitised" is where SSRF lives. Reddit handles are
// [A-Za-z0-9_-]{3,20}; that character class is a strict subset of what is safe
// in a URL path segment, so an accepted username needs no further escaping.
//
// Normalisation is deliberately narrow. We accept the shapes a human actually
// pastes -- `u/name`, `/u/name`, `/user/name`, `@name`, a full profile URL --
// and nothing else. In particular we do NOT lowercase-and-hope, strip unknown
// punctuation, or take the last path segment of an arbitrary URL.

const HANDLE = /^[A-Za-z0-9_-]{3,20}$/;

const PLATFORMS = new Set(['reddit']);

/**
 * @param {unknown} raw
 * @returns {{ ok: true, username: string } | { ok: false, reason: string }}
 */
export function normaliseUsername(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'username must be a string' };
  }

  let value = raw.trim();
  if (value === '') return { ok: false, reason: 'username is empty' };

  // A pasted profile URL, but only from a host we recognise -- taking the last
  // path segment of *any* URL is how you end up fetching someone else's idea
  // of a username.
  const urlMatch = value.match(
    /^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/(?:u|user)\/([^/?#]+)/i
  );
  if (urlMatch) {
    value = urlMatch[1];
  } else {
    value = value.replace(/^\/+/, '');
    value = value.replace(/^(?:u|user)\//i, '');
    value = value.replace(/^@/, '');
    value = value.replace(/\/+$/, '');
  }

  if (!HANDLE.test(value)) {
    return {
      ok: false,
      reason: 'username must be 3-20 characters of A-Z, a-z, 0-9, underscore or hyphen',
    };
  }

  return { ok: true, username: value };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, platform: string } | { ok: false, reason: string }}
 */
export function normalisePlatform(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, platform: 'reddit' };
  if (typeof raw !== 'string') return { ok: false, reason: 'platform must be a string' };
  const value = raw.trim().toLowerCase();
  if (!PLATFORMS.has(value)) {
    return { ok: false, reason: `unsupported platform "${value}" (supported: reddit)` };
  }
  return { ok: true, platform: value };
}

export { HANDLE as USERNAME_PATTERN, PLATFORMS };
