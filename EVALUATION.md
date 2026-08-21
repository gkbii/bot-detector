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

**FIXED 2026-08-17 (JIO-291).** `fetchAccount` asks the comment and post
streams before believing an index miss, and returns `null` only when all three
endpoints agree the account is absent. Re-measured live the same day:
`u/runnertrailsBay` — one of the 35 — scores **`automation low 12 · agenda low
2 · authenticity moderate 55`** off 145 comments with no index entry at all
(agenda and automation exactly as predicted above; authenticity 55 rather than
56 because JIO-290's URL-stripping landed in between). A re-probe on 2026-08-16
put the blind spot at **20.0%**, up from the 14.8% measured here on 2026-08-05
— a lag shrinks, a cutoff widens, and that growth is the evidence.

Three things the fix decides, rather than falls into. A users-endpoint *request
failure* still throws: an outage is not an absent account, and falling back on
it would produce a stream of confident-looking thin profiles. `firstSeenUtc`
from the oldest retrieved item is a **floor**, so an old prolific account whose
window filled up trips `MIN_HISTORY_DAYS` and is gated to `insufficient-data` —
deliberately, because what we hold in that case is 300 comments spanning forty
minutes and scoring it would be a verdict on our own pagination. And a stream
that stopped for a reason of our own now reports `coverage.truncated` on that
basis alone, since with no totals blob it is the only proof available and
without it the merged timeline would look complete — Finding 3's forged dormancy
arriving through a different door. *The first version of that last check counted
rows and did not work at all; see Finding 1a.*

## Finding 1a — the truncation flag that Finding 1 added never fired on a real account

Found by audit on 2026-08-18, one day after the fix above, and it is worth
reading as a unit with it: the check that was supposed to close the
forged-dormancy door was `rawComments.length >= commentLimit`, and on live data
that comparison is **never true**.

The cause is a deliberate decision two hundred lines away. Pagination uses
`before = oldest + 1` rather than `before = oldest`, because the cursor is
exclusive (`<`) on a **non-unique** key, so an exact cursor silently drops any
sibling sharing that second — overlap is cheap, a hole is invisible. The price
is that every page after the first arrives holding one row we already have, the
dedupe throws it away, and **a stream paged to 300 fills every page it asks for
and ends on 299.** `299 >= 300` is false, so `coverage.truncated` came back
`false` for the accounts with the *most* history.

Where the users index has an entry, `num_comments` covers for it —
`u/spez` read 299 of 2568 and was correctly truncated. Where it does not, which
by Finding 1's own argument is exactly the newest and most suspect accounts,
nothing did. `reliableTimelineStart()` gates solely on `coverage.truncated`, so
it returned `null` and the entire raw timeline was trusted as complete. Finding
3's forged dormancy, reached through the door Finding 1 had just opened.

Measured live on 2026-08-18 across six index-missed authors of the same thread
— `Calm_Emphasis_5974`, `HunterSpecial1549`, `Admirable-Gold3447`,
`Avalon_Within`, `SpartyParty9119`, `Due_Degree2802` — **6 of 6 fetched 299,
reported `truncated: false`, and had real history below the cursor.**

**FIXED 2026-08-18 (JIO-291).** Three changes, and the middle one is the point:

* `collect()` returns **why it stopped** alongside the rows, and nothing
  re-derives that from a row count. A count is arithmetic about our own paging;
  only a short or empty page is the API making a statement about the account.
* Page size is **constant**, not `wanted - fetched`. A page sized to exactly
  what is left comes back one short, and the shortfall then asks for a one-row
  page that can only be the duplicate again — five requests to deliver 299. A
  full page absorbs the overlap: four requests, 300 rows.
* `buildCoverage` **OR**s the two kinds of evidence instead of ranking them.
  They fail in opposite directions: a frozen-snapshot `num_comments` can be
  stale-*low* enough that our own 300 exceeds it, at which point
  `fetched < total` reads as "we have it all" over a 300-of-5000 window.

Re-measured live after the fix, same six accounts: all six now fetch the full
300, report `truncated: true`, and carry a real `reliableTimelineStart` instead
of `null`. `u/spez` is unchanged. The other direction holds too —
`u/Calm_Emphasis_5974` asked for 900 comments and 900 posts returns its entire
387 and 65, `truncated: false`, `reliableTimelineStart` `null`.

**Two lessons, both already this repo's rules, both broken anyway.**

*A stub that does not honour the cursor cannot observe a cursor bug.* All 117
tests passed. `pages a 300-comment request into three requests` served a fresh
non-overlapping page per call and ignored `before` outright; `a stream-derived
profile that filled our own limit` pinned `commentLimit` to 100 and was answered
in a single page. Neither ever paginated a real history, so neither could see
the boundary row. The regression tests use a stub that answers `before`
exclusively, the way the live API does.

*And the first cut of this very fix shipped the same defect wearing a different
hat.* Slicing the overshoot back to `wanted` is **itself** a truncation, and a
full page can carry us past the limit and run the source dry in the same
request — the stream is genuinely exhausted while the view we return is not.
`u/Calm_Emphasis_5974` paged 100/99/99/89 to 387 rows, the last page was short,
and 87 rows went in the bin behind a `truncated: false`. Green tests all the way
through; caught only by running it against the live API. A bound that fires says
so out loud, and the slice is a bound.

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

**FIRST BULLET FIXED 2026-08-20 (JIO-344).** `sustained-posting-rate` (weight 2)
measures items per hour across the reliable window and covers exactly the window
`posting-hour-dead-zone` refuses. It can, because throughput survives truncation
while a schedule does not: an hour histogram built from AutoModerator's
82-second window is measuring our pagination, but 297 items in 82 seconds is a
fact about the account whatever we failed to fetch.
`MIN_SPAN_DAYS_FOR_HOUR_PROFILE` is untouched — it is Finding 1's fix and stays.

The signal is one-directional: below 3 items/hour it returns `unmeasured()`,
never a low score, because an ordinary rate is the absence of evidence of a
machine rather than evidence of a person. Against the frozen corpus the six
scores that moved are all bots — AutoModerator `moderate 63 -> high 69`,
RemindMeBot 62 -> 64, sneakpeekbot 47 -> 50, Anti-ThisBot-IB 35 -> 39,
RepostSleuthBot 76 -> 75, sub_doesnt_exist_bot 53 -> 52 — no human moved at all,
and the bots' cell in the table above becomes `moderate x6, high x2` with the
floor at 39. The ceiling is raised, not removed: the other two bullets
(`interval-regularity` measuring demand, `conversation-depth` inverting for
reply-bots) are JIO-329 and are still open.
## Finding 4a — the prolific human the rate signal "cannot see" is real, and most of the accounts it catches are people

Measured live on **2026-08-20**, against the API, by
`scripts/probe-prolific-humans.mjs`. Reproduce with that script; it is the only
way this question can be asked, because no re-run of `test/corpus/` can answer
it — the 17 humans in there are the authors of one r/politics thread and are
ordinary-volume commenters by construction.

**Sample.** Two content-blind sweeps of 22 subreddits, ~23,000 recent comments,
16,264 distinct authors. The top of each ranking — 48 accounts, AutoModerator
excluded as already frozen — was fetched through `fetchAccount` and scored with
`scoreAccount`. 44 produced a rate. **7 fired the signal. Six of the seven read
as unmistakably human on a hand-read of their bodies.**

| account | items | span | per hour | hand-read | automation |
|---|---:|---:|---:|---|---|
| u/humdingler | 300 | 2.1d | **5.90** | human | low 14 |
| u/BriackYOLO | 316 | 2.4d | **5.53** | human | low 10 |
| u/regardus_maximus | 300 | 3.0d | **4.13** | human | low 8 |
| u/zombawombacomba | 300 | 3.2d | **3.92** | human | low 10 |
| u/verified-trader | 307 | 3.4d | 3.76 | bot (WSB BanBet) | moderate 40 |
| u/chilidirigible | 300 | 3.7d | **3.42** | human | low 25 |
| u/Mg29reaper | 322 | 4.2d | **3.18** | human | low 7 |

**There is no gap.** README says the frozen humans top out at 0.92/h and the
five bots run 5.5–13,039/h, and that "the gate sits in the gap". The gap is an
artifact of a corpus with no prolific human in it. u/humdingler, a person
posting reaction GIFs in r/Superstonk, sustains **5.90/h — above u/RemindMeBot's
5.5/h**, the slowest of the five bots the signal was added for. The two
populations overlap, so **no value of `ORDINARY_ITEMS_PER_HOUR` separates
them**: raising the gate to 6 would silence RemindMeBot and still measure
u/humdingler.

**The decision is right anyway, for a different reason than the one written
down.** Every one of the six people stays `low`. What protects them is the
*shape* of the signal, not the position of its gate — one-directional, floored
at `RATE_FLOOR_STRENGTH = 0.5`, log-scaled, and weight 2 of 15.5. A human at
5.90/h earns strength 0.573, i.e. 0.073 above neutral. That is the sentence the
README should be making, and `ORDINARY_ITEMS_PER_HOUR` should not be moved on
the strength of this finding.

**What it costs, in the world this signal was built for.** JIO-329 will take
`conversation-depth` and `interval-regularity` to unmeasured — the same premise
README uses for its own 9.0/15.5 arithmetic, applied here to humans instead of
bots. Under it, **u/chilidirigible, a fifteen-year r/anime regular, goes `low
25` → `moderate 33`**, and the rate signal supplies the last +4 of it (without
the signal: `low 29`). One real person crosses a band. Projections in this
paragraph were computed on an instrumented copy with `axis.js`'s `stripInternal`
bypassed, because published signals expose `band` and not `strength` by design;
they are not reproducible from the public output.

**A larger effect belongs to JIO-329, not here.** Dropping two signals that read
**0.0** for ordinary people removes measured zeros from a weighted average and
therefore raises it. Across the same 44 accounts, **28 scores rise and 2 fall**,
and u/Mysterious_Sleep7443 crosses `low 23` → `moderate 33` at 0.53/h — a rate
at which this signal never fires at all. JIO-329 needs its own live re-measure
before it lands.

**Still open.** The evidence string asserts throughput "above the 3 an hour a
person keeps up", which is a claim about people that six live accounts refute,
and it is printed *on the account being judged*. README's "gate sits in the gap"
says the same thing. Per README's own rule, a prolific human belongs in
`test/corpus/` — u/humdingler at 5.90/h is the account that pins it.

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

Finding 1a is not from this run at all — it is a defect in Finding 1's own fix,
found by auditing it a day later and measured against the live API on
2026-08-18. It is filed here rather than in a ticket because a fix that reopens
the hole it closed belongs next to the finding it claims to have closed.

Finding 4a is not from this run either, and it is an audit of Finding 4's fix
rather than of the original sample: 48 accounts from a content-blind sweep of 22
subreddits, measured live on 2026-08-20 and classified by hand. Its six humans
are a demonstration that the population exists, not a measured false-positive
rate — the sweep was deliberately aimed at the busiest authors on the platform,
so nothing here says how *common* a >3/h person is among ordinary accounts.
