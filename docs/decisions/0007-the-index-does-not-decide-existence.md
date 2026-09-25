# 0007 — The users index does not decide whether an account exists

**Status:** accepted · **Evidence:** EVALUATION.md Finding 1 · **Affects:** `extension/lib/sources/arcticShift.js`

EVALUATION.md's other findings are false positives. This one is the opposite,
and it is worse, because a false positive is at least visible: **the newest 15–20% of a
live thread got no verdict at all**, and the badge blamed the account for it.

`fetchAccount` used to treat an empty `/api/users/search` as "no such account"
and return `null` — one line, `if (!meta) return null`. Against a real
r/politics thread on 2026-08-05, **35 of 236 authors (14.8%) returned empty
from that endpoint while `/api/comments/search` served their comments
normally.** They were not deleted, suspended or mistyped. They were posting at
the time we asked.

**It is a cutoff, not a lag, and that is the whole point.** Every one of the
201 indexed accounts in that thread carried the *same*
`comment_stats_updated_at` — 2025-03-25. The newest `earliest_comment_at` among
them was 2025-03-14, and 0 of 196 had commented within a week of the probe.
That is not a stats blob being recomputed slowly; it is a snapshot taken once.
A re-probe on 2026-08-16 measured **20.0%**, up from 14.8% eleven days earlier,
and **the growth is the proof**: a lag shrinks, a cutoff widens every day that
passes. So the blind spot is not random — it is *exactly* the population most
worth checking, because a brand-new account is the shape astroturf takes.

The fix is that **the users index does not get to decide whether an account
exists**. On a miss we ask the comment and post streams anyway and, if either
serves anything, assemble the profile from those alone. Live, after the fix,
`u/runnertrailsBay` — the loudest voice in that thread and one of the 35 —
scores `automation low 12 · agenda low 2 · authenticity moderate 55` off 145
comments and no index entry at all.

Four things are load-bearing:

* **Absence has to be agreed by all three endpoints.** An index miss with empty
  streams is still `null`, because a deleted or mistyped name has to stay
  distinguishable from a new one. Splitting that single test in two is the fix
  in miniature, and both halves are asserted.
* **A request failure still throws; only an *empty result* falls back.** An
  outage and an absent account are different facts. Falling back on a 500 would
  quietly convert a broken endpoint into a stream of confident-looking thin
  profiles that all resemble young accounts — the exact reading the tool is
  meant to be careful about.
* **`karma` stays `null`, never `0`**, per rule 1 of `profile.js`, and
  `karma-velocity` (weight 1 of 12.5) degrades to `insufficient-data` *on its
  own* with no special-casing. That is the seam working: one signal reports what
  it could not measure instead of the whole lookup vanishing.
* **`firstSeenUtc` from the oldest retrieved item is a *floor*, not an age**,
  and `coverage.errors` says so in the words the badge renders. This was decided
  deliberately rather than fallen into: for an old, prolific, comment-only
  account whose window filled up, the understated age trips `MIN_HISTORY_DAYS`
  and gates the whole verdict to `insufficient-data`. That is the answer we
  want. What we actually hold in that case is 300 comments spanning forty
  minutes, and scoring it would be a verdict on our own pagination rather than
  on the account — the same mistake as the forged dormancy in EVALUATION.md
  Finding 3, arriving through a different door. There is a test asserting the
  gate fires, so nobody "fixes" it into a clean band later.

Understating age is also the safe direction on its own terms: it can only ever
push a verdict *towards* `insufficient-data`, never towards a clean score.

