# Effectiveness evaluation — run against a live thread, 2026-08-05

JIO-115. The question was whether the three scores this thing produces are the
scores the accounts *should* have. Answering it needs two things the unit suite
cannot give: real accounts, and a population where the right answer is already
known.

**Method.** The thread was
[r/politics "It Wasn't a Blowout, but El-Sayed Won"](https://www.reddit.com/r/politics/comments/1vg75om/it_wasnt_a_blowout_but_elsayed_won_get_behind_him/)
(posted 13:18 UTC, sampled 18:58 UTC the same day). 496 comments retrieved via
`arctic-shift`, 236 distinct non-deleted authors. 17 of those authors were run
end-to-end through the real `fetchAccount` → `scoreAccount` path, then read by
hand — window, subreddit spread, hour histogram, comment bodies, vote scores —
to form an independent verdict to compare against.

Humans alone are not a test, because a tool that says "fine" to everyone passes
it. So the same code was pointed at **eight accounts that declare themselves
bots** in their own comment text. That is the only ground truth Reddit actually
offers: you cannot verify a paid poster from outside, but `u/RemindMeBot` is not
in dispute.

## The headline: it does separate the two populations

| | automation | agenda | authenticity |
| --- | --- | --- | --- |
| 17 thread humans | **low** ×17 (0–22) | **low** ×17 (0–17) | moderate/high ×17 (33–73) |
| 8 declared bots | **moderate** ×7, **high** ×1 | low ×6, moderate ×2 | low ×3, moderate ×5 |

No human scored above `low` on automation and no bot scored `low`. The bands do
not overlap at all, which is the result that had to hold before anything else
was worth reporting. The evidence strings are also genuinely readable —
`u/bigbjarne`'s "gaps between consecutive comments vary by 375% of their average
(CV 3.75) over 298 intervals" is a sentence a reader can disagree with, which
was the design goal.

My hand-read agreed with the verdict on **16 of the 17** humans. The
seventeenth is below, and it is a miss of a different kind.

The one place my instinct disagreed and was wrong: `u/runnertrailsBay` posted
16 comments into this one thread in 16 minutes, hammering two stock
formulations, and I read that as moderate agenda. The tool says low, because
`stock-phrasing` deliberately requires repeats to span *different threads* —
restating yourself inside one argument is what an angry person does. On the
evidence it is right and I was wrong. Similarly `u/KevinGreeneSolar` scores
clean despite a username that reads like a solar business; the tool never looks
at usernames, and a name-based heuristic would have produced a false positive
here.

## Finding 1 — 14.8% of a live thread gets no verdict at all, and it is the newest 14.8%

This is the serious one.

`fetchAccount` treats an empty `/api/users/search?author=<name>` as "no such
account" and returns `null` ([arcticShift.js](extension/lib/sources/arcticShift.js),
`if (!meta) return null`). **35 of this thread's 236 authors return empty from
that endpoint while `/api/comments/search` serves their comments normally.**
They are not deleted, suspended or mistyped — they are posting right now.

The cause is measurable and it is not lag:

* every one of the 201 indexed accounts carries the **same**
  `comment_stats_updated_at`: **2025-03-25**;
* the newest `earliest_comment_at` among indexed accounts is **2025-03-14**;
* median staleness of `last_comment_at` across them is **499 days**, and
  **0 of 196** are within a week.

So the users endpoint is not a periodically-refreshed stats blob — it is a
**frozen snapshot taken 2025-03-25**, ~16.5 months before this test. Any account
whose first comment postdates mid-March 2025 does not exist to it. The README
records this as a lag ("totals last recomputed 16 months earlier"); it is a
cutoff, and the difference matters, because a cutoff means the blind spot is
**exactly the population most worth checking**. A brand-new account is the shape
astroturf takes, and it is the shape this tool cannot see.

What the user sees for those 35 is the neutral grey "no data" badge, whose
`AccountNotFoundError` says "deleted, suspended, typo". Honest about
uncertainty, wrong about the cause.

**The scoring core does not need the users blob.** Assembling the profile from
the comment and post streams alone (age from the oldest retrieved item, karma
left null) produces a complete, well-evidenced verdict for `u/runnertrailsBay` —
[a 110-day-old account, 122 comments across 35 subreddits](https://www.reddit.com/user/runnertrailsBay/),
the single loudest voice in this thread:

```
AUTOMATION low 12 · AGENDA low 2 · AUTHENTICITY moderate 56
  karma-velocity [insufficient-data] No karma total or account age available from the source.
  topical-breadth [high] Active in 35 groups across 122 items … (spread 0.83 of 1.00)
  sustained-threads [high] Held sustained back-and-forth in 11 of 52 threads (21%)
```

Only `karma-velocity` (weight 1 of 12.5, and already hedged in its own evidence
string) is lost, and it degrades to `insufficient-data` on its own without being
told to. That is the seam working exactly as designed — one signal reports what
it could not measure instead of the whole lookup vanishing.

**Recommended fix:** fall back to a stream-derived profile when the users index
misses, with `karma: null` and a `coverage.errors` entry naming why. Not a
guess — the run above is the real code producing the real output.

## Finding 2 — `asks-questions` counts URL query strings, and it fires on bots

`authenticity.js`'s question signal is `body.includes('?')`. A markdown link
with a query string satisfies it.

The effect on humans is nil — 1 to 2 points of drift across every human tested.
The effect on the accounts the tool exists to catch is total:

| account | "asks a question" | after stripping URLs |
| --- | --- | --- |
| u/RemindMeBot | 100/100 | **0/100** |
| u/RepostSleuthBot | 93/100 | **0/100** |
| u/sneakpeekbot | 98/100 | 23/100 |
| every human tested | 16–42% | within 2 points |

[A RemindMeBot comment](https://reddit.com/r/tipofmypenis/comments/1vgfto6/name/p1wwajz/)
contains seven `?` characters and asks nothing: they are in
`wolframalpha.com/input/?i=`, `?context=3`, and two
`reddit.com/message/compose/?to=`. The verdict reads "299 of 299 comments (100%)
ask a question" and awards a template bot the **maximum** on a signal whose
whole purpose is positive evidence of a person.

This is not general noise. It is a false positive shaped precisely like the
adversary, on the one axis that is supposed to vouch for people.

**Recommended fix:** strip URLs before the `?` test. One line, and the numbers
above are the test case.

**FIXED 2026-08-17 (JIO-290).** `stripUrls()` in `scoring/stats.js` runs before
both the `?` test and the help-seeking patterns. Re-measured live the same day:
u/RemindMeBot 295 of 299 comments -> **0 of 299**, u/RepostSleuthBot 299 -> **0**,
u/bigbjarne 118 -> 107 and u/KevinGreeneSolar 15 -> 14. u/sneakpeekbot lands at
94 of 299, not the 23 estimated here, and the residue is not URLs: its template
quotes other people's post titles (`#2: [Any News On The CRKD Drum Kit?]`).
Counting quoted third-party text as the account's own words is a separate
defect and is still open.

## Finding 3 — `dormancy-revival` returns a confident zero from windows too short to hold a gap

The heaviest agenda signal (weight 3) looks for a ≥120-day silence.
`unmeasured()` is returned only when fewer than 6 items came back — there is no
check that the retrieved window is long enough for a 120-day gap to be
*visible*.

It returned a clean `low` for **25 of 25** accounts tested, and never once
`insufficient-data` — including nine whose entire retrieved history spans under
eleven days. `u/AutoModerator`'s 299 comments span **0.0 days**, and the signal
reports: *"Longest silence in the retrieved history is 0 days (2026-08-05 to
2026-08-05), below the 120-day dormancy threshold."* Arithmetically it could not
have said anything else.

Its own truncation note admits the problem — "so any earlier dormancy is
invisible to this check" — while still contributing `strength: 0` at weight 3 to
the average. That is the README's own rule 3 inverted: absence of evidence
counted as a clean zero. The README documents fixing a false *high* here (the
forged 12-year dormancy); the fix turned it into a false *low* rather than into
"we cannot tell". Note the contrast with `posting-hour-dead-zone`, which for the
same accounts correctly reports `insufficient-data` because it checks its span
first.

Because any active account retrieves 300 comments from well under 120 days, the
weight-3 signal is a near-constant zero that dilutes every other agenda signal.

**Recommended fix:** `unmeasured()` when the reliable window is shorter than
`MIN_DORMANCY_GAP_DAYS`, the way the hour profile already gates on
`MIN_SPAN_DAYS_FOR_HOUR_PROFILE`.

**FIXED 2026-08-17 (JIO-290).** `dormancyRevivalSignal()` measures the span of
the reliable window and returns `unmeasured()` below `MIN_DORMANCY_GAP_DAYS`.
The gate is on the span alone and deliberately NOT on `coverage.truncated` — a
complete nine-day history cannot hold a 120-day silence either, and gating on
truncation would have left the defect live for young accounts. Live the same
day: RemindMeBot, RepostSleuthBot, AutoModerator and sneakpeekbot all now report
`insufficient-data` here instead of a weight-3 zero.

## Finding 4 — the automation ceiling: declared bots top out at "moderate"

Seven of eight unmistakable bots scored `moderate`, not `high`. Three
compounding reasons, all visible in the signal detail:

* **The heaviest automation signal is unavailable exactly where automation is
  highest.** `posting-hour-dead-zone` (weight 3) needs a 3-day span. A prolific
  bot's newest 300 comments cover hours, so it reads `insufficient-data` — for
  AutoModerator (0.0d), RemindMeBot (0.2d) and sneakpeekbot (1.1d). The 3-day
  rule is right; the consequence is that volume itself buys immunity from the
  strongest check.
* **`interval-regularity` measures demand, not the poster.** Summon-driven bots
  are irregular because their humans are. RemindMeBot: *"CV 1.26 … the
  irregular, clumpy spacing typical of a person."*
* **`conversation-depth` inverts for reply-bots.** RemindMeBot replies to a
  commenter 100% of the time, which the signal reads as conversational.

Two authenticity signals also actively reward being a bot: `topical-breadth`
scored `high` for AutoModerator (333 subreddits) and RemindMeBot (175) — running
sitewide is what a bot *is*, not evidence of a person with wide interests — and
`asks-questions` per Finding 2. AutoModerator lands on authenticity **moderate
38** with both of its high signals being artifacts of automation.

This is a sensitivity ceiling rather than a wrong answer: the bands still
separate cleanly, and `moderate` on automation is not an all-clear. But a reader
who treats `moderate` as "probably fine" gets the easiest case in the world
wrong.

## What this evaluation does not establish

The agenda axis has **no real-world validation** and cannot easily get one. The
automation axis was checkable because bots announce themselves; there is no
population of accounts known to be paid, so agenda rests entirely on synthetic
fixtures in `test/scoring.test.js`. Every real account tested here scored low on
it. That is consistent with a healthy thread and equally consistent with the
axis not firing — this test cannot tell those apart, and nothing in this
document should be read as evidence that the agenda axis works.

Sample size is 25 accounts in one thread on one subreddit on one day. Findings 1
through 3 are defects that reproduce deterministically; the band separation in
the headline table is a single observation, not a measured error rate.
