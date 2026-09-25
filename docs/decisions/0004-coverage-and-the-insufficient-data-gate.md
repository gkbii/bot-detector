# 0004 — Coverage is part of every verdict

**Status:** accepted · **Affects:** `extension/lib/sources/profile.js`, `axis.js`

A report over 100 of an account's 2,568 comments has to say so, and it does —
on the verdict and in the headline sentence. `profile.js` derives `truncated`
itself so no caller can forget it, and reports truncation only when it can be
*proven*, so "complete" is never asserted as a positive claim. The upstream
totals blob is not recomputed live — it is a **frozen 2025-03-25 snapshot**,
which is why an account whose newest comment arrived the same day still carried
totals stamped 16 months earlier — so it can only ever prove that history is
*missing*, never that we hold all of it.

There is a second proof, and it is the only one available when there is no
totals blob at all — but it cannot be a row count. **Only the API itself saying
"nothing older" proves a stream ran out**, so `collect()` returns *why* it
stopped alongside the rows, and `commentsIncomplete` / `postsIncomplete` carry
that answer into `buildCoverage()`. Nothing re-derives it from a length.

The first version of this check did re-derive it — `rawComments.length >=
commentLimit` — and on live data that comparison is never true (JIO-291,
EVALUATION.md Finding 1a). Paging uses `before = oldest + 1` rather than
`before = oldest` on purpose: the cursor is exclusive on a **non-unique** key,
so an exact cursor silently drops any sibling sharing that second. Overlap is
cheap; a hole is invisible. The price is that every page after the first
re-serves one row we already hold, the dedupe throws it away, and a stream
paged to 300 fills every page it asks for and ends on 299. `299 >= 300` is
false, so `truncated` came back **false for the accounts with the most
history** — and only where the frozen totals blob has no entry to cover for it,
which by this section's own argument is exactly the newest and most suspect
accounts. `reliableTimelineStart()` gates solely on `coverage.truncated`, so it
returned null and the entire raw timeline was trusted as complete: the forged
12-year dormancy of EVALUATION.md Finding 3 reached straight back through the
door this check had just opened. Live on 2026-08-18, six index-missed authors of one thread
(u/Calm_Emphasis_5974 among them) each fetched 299, reported `truncated:
false`, and had real history below the cursor.

**The two kinds of evidence are OR'd, not ranked**, because they fail in
opposite directions and neither dominates. A stale-*low* `num_comments` — the
snapshot is frozen, and an account that has commented since can report a count
our own 300 exceeds — turns `fetched < total` into "we have it all" over a
300-of-5,000 window. `*Incomplete`, in the other direction, is blind to *how
much* is missing and says nothing at all about a profile the fetcher never had
to page. Either one saying "partial" is proof; only both staying silent is the
absence of it.

Two smaller things in the pager exist for the same reason. Page size is
**constant** rather than `wanted - fetched`, because a page sized to exactly
what is left comes back one row short, and the shortfall then asks for a
one-row page that can only be the duplicate again — five requests to deliver
299. And a full page can carry us past the limit *and* run the source dry in
the same request, so discarding the overshoot is itself a truncation and is
reported as one: u/Calm_Emphasis_5974 paged 100/99/99/89 to 387 rows, the last
page was short — so the source *was* exhausted — and 87 rows went in the bin
behind a `truncated: false`. That was the first cut of the fix shipping the
same defect wearing a different hat, with a green suite behind it. It was
caught by running the thing against the live API, which is the only way any of
this has ever been caught.

`insufficient-data` is its own state everywhere — its own band, its own visibly
neutral grey dashed badge reading "no data", and an all-or-nothing gate across
all three axes (fewer than 15 comments, or under 14 days of history). Thin
history never returns a low score. **Absence of evidence must not read as
innocence, and must not read as guilt either**: scoring a three-day-old account
"low automation" hands out a clean bill of health the data cannot support, and
scoring it suspicious smears every new user on the platform. Partial verdicts on
a thin account are exactly what a reader would over-interpret.

The headline never rounds a moderate band down to an all-clear either, and it
calls the paid-poster shape out by name — a reader glancing at "low automation"
would otherwise take it as an exoneration.

