/**
 * One line per event, tagged by domain, so `[bot-detector:http]` greps every
 * request line and nothing else.
 *
 * Fields are `key=value`; a value containing whitespace or a quote is
 * JSON-quoted. `undefined` fields are dropped, so a caller can pass an
 * optional field without composing the object conditionally.
 *
 * PRIVACY, and it is the reason this exists rather than a bare console prefix.
 * A comment body must never reach a log line (see the privacy block at the top
 * of `server/index.ts`). Fields are scalars only: passing an object gets its
 * `String()` form, which is `[object Object]` rather than a body that leaked
 * because someone spread a profile into a log call.
 *
 * Lives in extension/ for the same reason errors.js does: the extension has to
 * stay copy-out-able, so nothing it imports may sit above it, and the server
 * imports in the other direction.
 */

/** @typedef {Record<string, string | number | boolean | null | undefined>} LogFields */

/** @param {LogFields} [fields] */
export function formatFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = String(value);
      return /[\s"]/.test(text) ? `${key}=${JSON.stringify(text)}` : `${key}=${text}`;
    })
    .join(' ');
}

/** @param {string} domain @param {string} event @param {LogFields} [fields] */
export function formatLine(domain, event, fields = {}) {
  const tail = formatFields(fields);
  return `[bot-detector:${domain}] ${event}${tail ? ` ${tail}` : ''}`;
}

/** @param {string} domain @param {string} event @param {LogFields} [fields] */
export function log(domain, event, fields = {}) {
  console.log(formatLine(domain, event, fields));
}

/** @param {string} domain @param {string} event @param {LogFields} [fields] */
export function logError(domain, event, fields = {}) {
  console.error(formatLine(domain, event, fields));
}
