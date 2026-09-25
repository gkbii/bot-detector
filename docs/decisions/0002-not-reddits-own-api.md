# 0002 — Reddit's own API is not used, and that was checked rather than assumed

**Status:** accepted · **Decided:** 2026-08-05 · **Affects:**
`extension/lib/sources/arcticShift.js`

The obvious design is Reddit's own `/user/<name>/about.json`. It does not work
for us, and the project's feasibility score on the website moved from a 2 to a 4
because of what checking turned up.

## Why not Reddit

* **`https://www.reddit.com/user/<name>/about.json` returns 403 to a server
  regardless of `User-Agent`.** Verified live 2026-08-05: a browser UA gets a
  403 `text/html` challenge page, not JSON. Do not try to fix this by spoofing
  headers — it has been tried, and the block is not UA-based. There is no
  server-side path to it at all.
* **OAuth would break the product.** Every user of a load-unpacked extension
  would have to register their own Reddit application, which contradicts the
  zero-setup requirement outright. The original feasibility score of 2 was set
  by Reddit's manual API approval queue, and that gate is not on this path
  anymore.

## What is used instead

**`arctic-shift.photon-reddit.com` serves the same fields unauthenticated** —
no key, no signup, no application — with permissive CORS
(`access-control-allow-origin: *`), which is what lets the extension call it
directly with no backend. And it is **live, not archival**: verified that the
newest comment returned for an active account was stamped the same day.

`arcticShift.js`'s header carries the endpoint shapes and four behaviours
confirmed against the live API. Two of them corrected an assumption:

* **`limit` maxes out at 100, not 300.** `limit=1000` returns HTTP 400 with
  `{"error":"'limit' must be between 1 and 100"}`. A 300-comment lookup is
  therefore three paged requests — which is the only reason this module
  paginates at all.
* **Throttling is HTTP 422, not 429.** Two parallel requests produced
  `{"data":null,"error":"Timeout. Maybe slow down a bit"}` with a 422. A 422
  normally means "your request is malformed, retrying is pointless", so treating
  it that way would turn ordinary rate-limiting into a hard failure. We match on
  the message so a *genuine* validation 422 still fails fast, and back off on
  `x-ratelimit-reset`.

Pagination is `before=<unix seconds>` with `sort=desc`, and `before` is
exclusive — but we page with `before = oldest + 1` and dedupe by id anyway,
because an exclusive cursor on a non-unique key silently drops any sibling
sharing that exact second. Overlap is cheap; a hole is invisible.

An unknown account is `{"data":[]}` with HTTP 200 rather than a 404, so "no such
account" is an empty array — but an empty array from the *users* endpoint alone
does not mean the account is unknown. See
[ADR 0007](0007-the-index-does-not-decide-existence.md).

## The escape hatch is documented and deliberately not wired up

`https://api.pullpush.io` was also verified serving the same ground on
2026-08-05 and is documented in `arcticShift.js`'s header as the fallback if
arctic-shift goes away. It is **not** connected on purpose: a second live source
that nothing exercises is a second source that has silently broken by the time
you need it.
