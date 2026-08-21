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

**AMENDED 2026-08-21 (JIO-386).** That fix ran too wide in one direction and
not wide enough in two others: the bare host rule matched numeric ratios, so
`"would you rate it 3.5/10?"` lost its question mark, while `example.com?utm=1`
and `/search?q=cats` kept theirs. A host now needs an alphabetic top-level
label, and a query counts as a link tail on its own when it carries an `=`.
Frozen-corpus scores are unmoved by it, which is a no-regression result and not
a re-measure: no account in `test/corpus/` exhibits either shape.

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
  *(FIXED 2026-08-21, JIO-345 — Finding 4d below.)*

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

**THIRD BULLET FIXED 2026-08-21 (JIO-345), and separately from JIO-329.** The
inversion is closed at the pole where it is demonstrable — an account with no
top-level comment anywhere in its window is `unmeasured()` rather than a
full-weight vote for humanity — without withdrawing the discount from ordinary
reply behaviour, which is the 3.5-weight change Finding 4b priced in real
people. Five more frozen scores move, all bots, all up, and the bots' cell
becomes `moderate x5, high x3` with the floor at 44. Finding 4d has the
measurement. The second bullet, `interval-regularity`, is still open.
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

**That re-measure is Finding 4b below (JIO-405), and it did not agree with the
reading here.** These 44 accounts are the top of a volume ranking, so the
question "what does this do to ordinary people?" was still unasked. Asked
properly — evenly-spaced ranks through a whole 7,351-author ranking — the answer
is not a count of unlucky accounts at all: JIO-329 multiplies an ordinary
automation score by about 1.35, which moves the `moderate` band edge from 30
down to **22.2** on today's scale.

**Closed on 2026-08-21, in three parts.**

1. *The evidence string.* It asserted throughput "above the 3 an hour a person
   keeps up" — a claim about people that six live accounts refute, printed *on
   the account being judged*. It now claims only what was measured: the rate,
   that this signal begins weighing throughput above 3/h, and that throughput
   at this level is uncommon and is weighed rather than taken as proof. The
   unmeasured branch said the same thing ("only reports throughput a person
   cannot reach") and was reworded with it. `test/scoring.test.js` now fails if
   either string mentions a person, a human or people at all; the rule is
   describe the account, not the population.
2. *README's rationale.* "The gate sits in the gap" is replaced by the
   shape-based argument this finding actually supports — one-directional,
   `RATE_FLOOR_STRENGTH = 0.5`, log-scaled to 300/h, weight 2 of 15.5, so the
   5.90/h human earns strength 0.573 and scores `low 14`.
   `ORDINARY_ITEMS_PER_HOUR` was **not** moved, for the reason above: there is
   no separating value.
3. *The corpus.* u/humdingler and u/chilidirigible are frozen in `test/corpus/`
   as a second human cohort, `prolific-probe`, held separately from the 17
   thread humans because they were sampled by a different rule. u/humdingler is
   the overlap (faster than u/RemindMeBot); u/chilidirigible is the cost. On the
   frozen 2026-08-21 profile that cost re-measures slightly smaller than it did
   live here: `low 25` today, **`moderate 32`** under JIO-329's premise and
   `low 28` without this signal, against the 33/29 recorded above from the
   2026-08-20 window. The band it crosses and the 4 points this signal supplies
   are the same either way. Both accounts are `class: "human"`, so the
   separation invariants cover them, and admission is re-checked from the
   frozen timestamps rather than trusted — an account that drifts below the
   gate is refused rather than left in the corpus pinning nothing.

**What admitting them changed, and what it did not.** The separation invariant
holds: no human above `low`, no bot at `low`. The margin narrows — the human
ceiling on automation goes **17 → 25** against an unchanged bot floor of 39, so
the honest gap is 14 points rather than the 22 a thread-only sample produced.
Nothing else moved; no thread human's score and no bot's score changed by a
point, because the two new accounts are new rows rather than a reweighting.

**One thing this finding did not go looking for, filed rather than absorbed.**
Both prolific humans score agenda **`moderate` (55 and 57)** where all 17
thread humans are `low` (0–19) — `topic-concentration` and `drive-by-ratio`
both reading `high`. That is what a high-volume single-subreddit hobbyist looks
like to the agenda axis, it is a different axis from the one this ticket is
about, and it is a question for its own ticket rather than something to fix
under a rate signal. **That ticket was JIO-424 and it is Finding 4c below.**
Both accounts are `low` on agenda now, on their frozen bodies and on their real
ones.

## Finding 4b — JIO-329 does not raise the risk of a `moderate`, it moves the band edge from 30 to 22

Measured live on **2026-08-21** by `scripts/measure-jio329.mjs`, which is
committed and is the only way to ask this question: `axis.js` publishes `band`
and deliberately strips `strength`, so a JIO-329 arm cannot be recomputed from
a public verdict at all. The script scores an **instrumented copy** of
`extension/lib/` — `stripInternal` rewritten to the identity in a temp tree,
one substitution that throws if it stops matching — and refuses to run if the
patch silently no-ops, because a no-op would make every after-score identical
to its before-score and read as *"JIO-329 changes nothing"*.

**Why this finding exists at all.** Finding 4a closed with one line of
arithmetic and one account: dropping two signals that read 0.0 for ordinary
people removes measured zeros from a weighted average and therefore raises it,
and u/chilidirigible crossed. That was 44 accounts off the **top** of a
prolific-commenter ranking, harvested to answer a different question. The
population JIO-329 is about is everybody it was not aimed at.

### The measurement

One content-blind harvest — 10 subreddits, 11,425 comments, **7,351 distinct
authors** ranked before anything was fetched — sampled twice, with **no second
harvest**, so the difference between the two arms is the population and not the
day:

| arm | sample | scored | rise / fall / same | mean | crossings |
|---|---|---:|---|---:|---:|
| **A — whole ranking** | 80 at even ranks 1…7350 | 78 | **59 / 6 / 13** | **+2.6** | **4** |
| **B — top of ranking** | ranks 1–48, plus the two named in 4a | 46 | 32 / 2 / 12 | +2.3 | 3 |
| **C — frozen corpus** | `test/corpus/`, no network | 27 | 20 / 0 / 7 | +6.5 | 6 |

Arm C is the arm `npm run evaluate` will print the day JIO-329 lands, and it is
reproducible by anyone at any time: `node scripts/measure-jio329.mjs --corpus`.

### Every account scoring 22–29 today crosses. All of them. That is not a sample result

The seven live crossings are not seven unlucky accounts. For an account whose
automation signals are otherwise near zero — which is what an ordinary person
looks like — the score is a weighted mean over measured weight, so removing 3.5
of it multiplies the score by `mw / (mw - 3.5)`: **×1.35** at the common
measured weight of 13.5, ×1.39 at 12.5, ×1.29 at 15.5.

A multiplier on the score is a **divisor on the band edge**. `moderate` starts
at 30, so after JIO-329 it starts at **30 / 1.35 = 22.2** on today's scale.
Sorting both live arms by today's score and checking that prediction against
what actually happened:

* **every one of the 7 accounts scoring 22–29 today crossed** into `moderate`;
* **no account scoring 21 or less crossed**, in either arm;
* there were no other crossings, and nothing was lost to the measured-weight
  gate in any arm.

So the honest statement is not *"4 of 78 crossed"* — that is a fact about how
many people happen to live in an 8-point band. It is: **JIO-329 lowers the
effective `moderate` threshold for a typical human profile from 30 to 22.2, and
then the sample only says how crowded that strip is.**

How crowded, stated so it cannot be read as better than it is: **5 of the 122
content-blind accounts, 4.1%**. Two of arm B's three crossings are
u/chilidirigible and u/Mysterious_Sleep7443, carried in **by name** from Finding
4a because they are the accounts that raised this question — they are in the
table below and they are excluded from that rate, because an account picked for
being interesting cannot also be evidence of how often interesting turns up.
`--include` marks such rows in the state file for exactly this reason.

**Half the population is one signal wide, and it is always the same signal.**
38 of arm A's 78 accounts have exactly one non-zero automation signal, and for
every one of the 38 it is `posting-hour-dead-zone` (weight 3). For that shape
the axis *is* that one signal:
3s/13.5 today, 3s/10 after. At full strength that is precisely **22 → 30**, the
band edge to the point.

### The seven, named, with the signal that carried each

Hand-read with `--read`, which prints bodies and writes none. All seven read as
people: a WSB options trader, a WNBA and r/nba fan, a UK nostalgia poster, a
motorcyclist, an AskReddit regular, a crypto poster, a fifteen-year r/anime
regular.

| account | arm | today | after | carried by | rate |
|---|---|---|---|---|---|
| u/-PMYourTastefulNudes | B (rank 24) | low 27 | **moderate 39** | `cross-thread-bursts` 1.00×2 | 6.08/h, fired |
| u/chilidirigible | B (rank 954) | low 27 | **moderate 34** | `posting-hour-dead-zone` 0.79×3 | 3.33/h, fired |
| u/outsidehere | A (rank 5489) | low 25 | **moderate 34** | `posting-hour-dead-zone` 0.63×3, `cross-thread-bursts` 0.66×2 | 2.26/h, **unmeasured** |
| u/upyoursbigtime | A (rank 6977) | low 24 | **moderate 33** | `posting-hour-dead-zone` 0.97×3 | 0.05/h, **unmeasured** |
| u/Mysterious_Sleep7443 | B (rank 5129) | low 23 | **moderate 32** | `posting-hour-dead-zone` 0.95×3 | 0.52/h, **unmeasured** |
| u/nickmarvin | A (rank 5210) | low 22 | **moderate 30** | `posting-hour-dead-zone` 1.00×3, alone | 0.01/h, **unmeasured** |
| u/TheFansHitTheShit | A (rank 6698) | low 22 | **moderate 30** | `posting-hour-dead-zone` 1.00×3, alone | 0.05/h, **unmeasured** |

**Five of the seven cross with `sustained-posting-rate` unmeasured**, at rates
of 0.01 to 2.26 an hour. Finding 4a's one crossing could be read as a cost
shared with JIO-344, and README says so; these five cannot. They are JIO-329's
own, and the two at exactly 30 have **no other measured evidence of automation
at all** — `posting-hour-dead-zone` is their entire score.

**And the largest single rise is a person, one point below `high`.**
u/insomniac4sure goes `moderate 47` → `moderate 64` (+17) — one point under
`high`. The account posts in r/lymphoma about living off grapes during chemo and
tells an AmItheAsshole story about a brother-in-law who stayed three years, and
it plays two mobile games that post on its behalf: *"I solved this puzzle in 13
moves"*, forty-odd times, plus a referral link. `near-duplicate-bodies` is right
about the text and wrong about the account. It did not cross a band, so no rule
here names it; it is named anyway, because "nothing crossed above `moderate`"
would otherwise be a true sentence covering a 64.

### Re-justifying the weight choice against this, rather than against the premise

3.5 weight can be spent four ways, and `--variants` replays all four against the
same stored strengths — no re-fetch, no second scoring pass. Against
`test/corpus/`, where the class of every account is known:

| variant | bots → `high` | humans crossing | human mean | human max | bot mean | bot min | **gap** |
|---|---:|---:|---:|---:|---:|---:|---:|
| today | 0 | 0 | — | 25 | — | 39 | **14** |
| drop `conversation-depth` (1.5) | 1 | 0 | +0.8 | 28 | +4.4 | 44 | **16** |
| drop `interval-regularity` (2) | 2 | 0 | +0.9 | 29 | +10.4 | 46 | **17** |
| **JIO-329 — drop both (3.5)** | **5** | 1 | +1.9 | 32 | **+17.3** | 54 | **22** |

**Dropping both is the right call, and the reason is the last column.** Finding
4 is that seven of eight declared bots top out at `moderate`; dropping both is
the only variant that breaks that for most of them — **five** of the eight reach
`high`, against two for `interval-regularity` alone and one for
`conversation-depth` alone. And the axis does not merely inflate: the bots
move **nine times further than the people** (+17.3 against +1.9), so the gap
between the human ceiling and the bot floor **widens from 14 points to 22**. The
change costs people a band and buys back more separation than it spends. On the
live arms, where no class is known, the same shape holds and is sharper:
dropping either signal **alone** costs **zero** crossings in arm A, and dropping
both costs four. The cost is in the last 1.5 of weight, not spread across it.

**Two levers the measurement rules out, so that nobody spends a week on them.**
`ORDINARY_ITEMS_PER_HOUR` is not one: five of the seven crossed with that signal
unmeasured, and Finding 4a already established there is no separating value for
it. Nor is the band edge: moving `moderate` from 30 to 35 would spare five of
the seven and leave u/-PMYourTastefulNudes at 39 and u/chilidirigible at 34
regardless, while silently re-banding the agenda and authenticity axes, which
have nothing to do with this. And no test on the two signals' own values can
separate the populations either — **`conversation-depth` and
`interval-regularity` read 0.000 for the people here AND 0.000 for
u/RemindMeBot**. That identity is exactly why dropping them helps the bots and
hurts the people in the same motion, and why the separation has to come from
the other signals rather than from a smarter condition on these two.

### What this does not establish

Seven hand-read accounts are a demonstration, not a false-positive rate. The
sweep is content-blind but it is a sweep of ten busy subreddits over a few
hours, so "4.1% of accounts sit in the 22–29 strip" is a statement about that
window and not about Reddit — and the two arms disagree about it even inside
that window (4 of 78 sampled by rank, 1 of 44 sampled off the top). The
band-edge arithmetic is the durable half and does not depend on the sample at
all.

**None of the seven is frozen.** They are live accounts that will keep posting,
and a re-run tomorrow gets a different newest-300 window and different numbers —
the disagreement below is that effect, not a bug. u/chilidirigible is in
`test/corpus/` already (JIO-344) and crosses there too, so `npm run evaluate`
does fail on the day JIO-329 lands; what is *not* pinned is that the cost lands
on **ordinary** accounts as well as prolific ones, because every human in the
corpus was sampled by volume or by one r/politics thread.

**An earlier run of arm A disagreed, and the disagreement is the point.** The
audit that first ran this script, four hours earlier on the same day and against
its own harvest, measured the whole-ranking arm at 41 rise / 9 fall / 27
unchanged, mean +1.2, **zero crossings**, top after-score 28 — and read that as
JIO-329 being free for ordinary people. Its top-of-ranking arm reproduces here
exactly (33/2/12, mean +2.3, three crossings); its whole-ranking arm does not.
Two windows, two answers, and **the band-edge arithmetic explains both**: that
run's ranking simply had nobody in the 22–29 strip. A zero-crossing sweep is
therefore not evidence that the strip is empty, which is the trap a sample-count
framing walks into and a band-edge framing does not.

## Finding 4c — the two agenda signals that banded a hobbyist rank the corpus backwards

Measured on **2026-08-21** by `scripts/measure-agenda-shape.mjs`, over the 27
accounts frozen in `test/corpus/`. **No network** — `scoreAgenda` is pure and
the corpus is JSON, so unlike Findings 4a and 4b this one is arithmetic on disk
and reproduces byte-for-byte. Run it rather than trusting the tables below.

Finding 4a closed by filing one line it had not gone looking for: both prolific
humans score agenda `moderate` 55 and 57 where all 17 thread humans are `low`.
This is that line, asked properly.

### The measurement

`topic-concentration` — share of activity in the single largest group:

| | range | above `low` on the signal |
|---|---|---|
| 8 declared bots | **2–16%** | none |
| 17 thread humans | 13–49% | none |
| 2 prolific humans | **77%, 97%** | both |

It ranks the corpus **backwards against its only ground truth.** Seven of the
eight bots hold the bottom seven places at 2–7%; the eighth, u/RemindMeBot at
16%, is beaten by 16 of the 19 humans. The only two accounts in the whole
corpus that this signal scores above `low` are the two hand-read hobbyists. Of
course they are: a utility bot serves the whole site, and u/AutoModerator posts
in 307 groups against u/chilidirigible's 6.

`drive-by-ratio` — share of engagements the account never came back to:

| | range | median |
|---|---|---|
| 8 declared bots | **0–91%** | 3.5% |
| 17 thread humans | 3–87% | **36%** |
| 2 prolific humans | 72%, 87% | — |

It separates nothing. The ranges are nested, five of the eight bots read 0–7%,
and the signal's own window floor of 0.35 sits **at the median thread human**,
so it reads above zero for 9 of the 17. u/Hartacus — an ordinary r/politics
commenter, agenda `low` — sits at **87%, the same as u/chilidirigible.** What
separated the two was topic concentration alone: 38 groups against 6.

So the axis banded a fifteen-year r/anime regular and a reaction-GIF poster on
**their volume and their choice of subreddit**, with `stock-phrasing` measuring
a real zero for both and `dormancy-revival` unable to see a 120-day gap inside
their 2- and 4-day windows. That is this axis's most consequential false
positive, and unlike Finding 4a's it is not hypothetical: it is the badge those
two accounts were wearing.

### The half of the DoD that cannot be measured, said plainly

The ticket asked whether these signals separate hobbyists from **agenda
accounts**. They do not separate hobbyists from anything the corpus can label,
and the second half of that question is unanswerable here: the 8 declared bots
are *utility* bots, and the closing section of this document already records
that no population of known-paid accounts exists and one cannot easily be
obtained. There is no self-declaration analogue for a paid poster.

Nothing below should be read as evidence about agenda accounts. It is a
statement about people.

### The decision: hold the shape signals to the evidence beside them

`agenda.js` has said since it was written that "none of these signals is
damning alone — a hobbyist is topic-concentrated" and that they are "weighted
to be read together". A weighted mean does not read anything together; it lets
two signals out of four carry a band on their own, which is exactly what
happened. So `holdShapeToCorroboration()` makes the sentence executable:

> A shape signal — `topic-concentration`, `drive-by-ratio` — may argue as hard
> as the strongest measured `stock-phrasing` or `dormancy-revival` beside it,
> and no harder. Floored at the `moderate` band edge, so it is never silenced
> and can always take the axis to the edge of an accusation on its own.

Three things about it.

**No threshold was moved, deliberately.** There is no separating value to move
one to. On `topic-concentration` the bots are already *below* every account
this fires on, so a threshold that separated the two populations would have to
fire on LOW concentration — it would have to run backwards. Moving one on this evidence would be the error
Finding 4a named on `ORDINARY_ITEMS_PER_HOUR`, in a place where it would be
harder to see.

**It is graded, not a gate, and that is the load-bearing half.** An on/off rule
at the band edge would have taken u/chilidirigible from agenda 30 to **68** on
a `stock-phrasing` strength moving 0.29 to 0.31 — and two of the 17 thread
humans sit within 0.11 of that line on their real bodies, at 0.37 and 0.40. A
cliff that steep next to real accounts is a false positive waiting for the next
re-capture.
`test/scoring.test.js` walks a hobbyist's phrasing coverage from 0% to 20% and
fails if any step moves the score by more than 12 points; today the whole ramp
is 14 → 51 in steps of nine or fewer.

**An unmeasured corroborating signal corroborates nothing.** Same direction
`axis.js` rule 3 already runs in: we do not have the evidence, so we do not
make the accusation. Both prolific humans are in exactly that position on
`dormancy-revival`.

### What moved

Six of the 81 frozen scores, all downward, and **two bands**: u/humdingler
`moderate 55 → low 19` and u/chilidirigible `moderate 57 → low 19`. Four thread
humans move within `low` (u/Hartacus 19 → 6, u/Aubenabee and u/bigbjarne to 9,
u/Tobeck to 6), which takes the thread-human agenda ceiling from 19 to 13. **No
bot moved by a point** — all eight read `high` on `stock-phrasing`, so nothing
of theirs is held — and the automation separation the whole evaluation rests on
is untouched. `npm run evaluate` exits 0.

### What this does not establish

**The corroborated branch is not exercised by a real person anywhere in this
corpus.** All 19 human profiles carry length-matched synthetic bodies, so their
`stock-phrasing` — the signal the hold reads — is not the one the live account
produced. Only the synthetic fixtures in `test/scoring.test.js` take the
un-held path. A frozen corpus is evidence a change broke nothing; it is never
evidence the change did anything. The live re-fetch at the end of this finding
is what closes that gap.

**Two halves of the rule went unpinned by the corpus, and both are pinned by
fixtures now.** Holding shape to the *weakest* measured corroborator instead of
the strongest passed all 154 tests and `evaluate`: no account here and no
fixture had both corroborators measured with one of them strong. A second
propagandist fixture is that shape — a talking point recurring across threads
beside a `dormancy-revival` measured at ZERO over a 300-day span. Separately,
dropping the filter that keeps an UNMEASURED corroborator out of the ceiling
also passed everything: `Math.max` swallows the `null` so no score moves, and
the only casualty is the evidence string, which stops saying "one of the two
could not be measured at all" — the sentence both prolific humans get, and the
one place `axis.js` rule 3 is visible to a user. A short-window hobbyist
fixture pins it.

**So the real bodies were solved for rather than assumed.** `manifest.json`
records each human's agenda score on both the real and the synthesised profile,
and on this axis bodies feed `stock-phrasing` and nothing else —
`topic-concentration` reads groups, `drive-by-ratio` reads thread ids,
`dormancy-revival` reads timestamps. The gap between the two recorded scores
*is* that signal, so its strength falls out of the weighted average. The script
prints the whole column; the four rows that matter:

| account | recorded, real bodies | implied `stock-phrasing` | under the hold |
|---|---:|---:|---:|
| u/chilidirigible | 63 | 0.16 | **25** |
| u/humdingler | 55 | 0.00 | **19** |
| u/bigbjarne | 27 | 0.40 | 26 (not held — its own text corroborates) |
| u/Hartacus | 28 | 0.37 | 17 |

Both prolific humans are held on their real bodies too, and leave `moderate`
there as well. That is derived from scores `manifest.json` already recorded,
not re-measured against the API.

**That column had a defect, found in review and corrected here.**
`impliedPhrasing()` solved the weighted average for `stock-phrasing` without
subtracting `dormancy-revival`, so wherever dormancy was MEASURED and non-zero
its weight — 3, the heaviest on the axis — was attributed to phrasing instead.
One account in the corpus is affected: u/KevinGreeneSolar published as **0.31,
"corroborates: yes"** against a true **0.009**, a gap of exactly
3 × 0.2514 / 2.5, and the live account reads phrasing 0.00. The band-based
guard standing in its place could not see it, because 0.2514 bands `low`. No
score in this finding was wrong — the two errors cancel wherever the hold does
not bind, and the one affected account is not held — but the count of ordinary
humans clearing the corroboration floor was published as three and is two.

**And the bound that column exposes is the real limit of this rule.** It
protects an account whose phrasing *and* dormancy both read low, and nothing
else. Two of the seventeen ordinary humans clear the corroboration floor on
their own real text (0.37–0.40) — **a hobbyist with a catchphrase gets nothing
from this fix.** Both still score `low` today, on a weighted average that never
had a problem with them; but if a concentrated, drive-by account with a
sign-off ever bands `moderate`, this rule will not have been what failed, and
it will not have helped either.

**The derivation is not a live re-measure — but one has since been run.** The
column above is deliberately offline: the question is about two accounts
already frozen, and re-fetching them would have changed the very window the
ticket was filed against. So the live check was done *after* the change landed,
on **2026-08-21**, over ten accounts through the real `fetchAccount`, purely to
put the derivation against the API:

| account | live, pre-hold | live, under the hold | derived |
|---|---:|---:|---:|
| u/humdingler | 55 | **low 19** | 55 → 19 |
| u/chilidirigible | 64 | **low 26** | 63 → 25 |
| u/bigbjarne | 28 | 28 — not held, live phrasing 0.45 | 27 → 26 |
| u/AmputatorBot, u/RepostSleuthBot, u/RemindMeBot | — | unmoved | unmoved |

Both prolific humans leave `moderate` on their live bodies, which is the
finding. u/bigbjarne is the more useful row: at a live `stock-phrasing` of 0.45
it is the first REAL account to exercise the corroborated branch, which until
then only a fixture had.

**And it is a hand check, not a command.** It is not reproducible from this
repo — `measure-agenda-shape.mjs` stays offline on purpose, and a re-fetch
today returns different numbers again. That is visible in the live phrasing
itself, which tracks the derived column without being it: u/chilidirigible
reads 0.18 live against 0.16 derived, and u/Hartacus 0.08 against 0.37. The
derived column is of the CAPTURE WINDOW; the account has moved since.

## Finding 4d — a 100% reply rate scored as evidence of a person, and the whole margin is three comments

Measured on **2026-08-21** by `scripts/measure-reply-share.mjs`, over the 27
accounts frozen in `test/corpus/`. **No network**, like Finding 4c and unlike
4a and 4b: `scoreAutomation` is pure and the corpus is JSON, so this is
arithmetic on disk and reproduces byte-for-byte. Run it rather than trusting
the tables below.

This is Finding 4's third bullet, asked properly. It was written down a year of
tickets ago as an observation — *"`conversation-depth` inverts for reply-bots"*
— and left inside JIO-329, which would have removed the signal outright.

### The measurement

`conversation-depth` scored `strength = 1 - rescale(replyShare, 0.02, 0.3)`. So
a reply share at or above 30% earned **strength 0**: the maximum vote for
humanity this axis can cast, at the signal's full weight of 1.5.

| | reply share | top-level comments in the window |
|---|---|---|
| 5 summon-bots | **100.0%** (299/299, 300/300) | **zero, all five** |
| 19 humans | 40.0% – **99.0%** | 3 – 124 |
| 3 broadcast bots | 8.0% – 21.7% | 234 – 275 |

u/RemindMeBot replies to a summoning commenter 299 times out of 299 and does
nothing else at all, and collected a full-weight vote for its own humanity for
it. **The mechanism that makes it a bot is the mechanism that cleared it.**
Finding 4b measured the identity underneath that from the other side: this
signal reads **0.000 for ordinary people AND 0.000 for u/RemindMeBot**.

The other pole is fine and is untouched. u/AmputatorBot (21.7%),
u/AutoModerator (8.4%) and u/RepostSleuthBot (8.0%) all sit below every human
in the corpus, and never replying at all is genuinely what broadcasting looks
like.

### Why the cut is categorical rather than a percentile

**The entire separation is 99.0% against 100.0%.** u/MundaneFacts, an ordinary
r/politics commenter, drops 3 top-level comments in 300; the five bots drop
none in 300. A threshold drawn anywhere in that gap is a threshold drawn off 19
human data points at a margin of three comments, and it would not survive the
twentieth human.

So the rule is not a threshold at all: **no top-level comment anywhere in the
retrieved window** returns `unmeasured()`. That is a property of the window
rather than a number somebody picked, and it is the only value in this
distribution that is not standing inside the margin. axis.js rule 3, applied to
a POLE of a measurement rather than to a sample that was too thin.

### What moved

Five of the 81 frozen scores, all of them bots, all upward:

| account | automation |
|---|---|
| u/RemindMeBot | `moderate 64` → **`high 73`** |
| u/sub_doesnt_exist_bot | 52 → 58 |
| u/same_subreddit_bot | 51 → 57 |
| u/sneakpeekbot | 50 → 57 |
| u/Anti-ThisBot-IB | 39 → 44 |

**Not one human moved by a single point** — all 19 have top-level comments, so
for all 19 the signal is measured exactly as it was. The bots' cell in the
headline table becomes `moderate ×5, high ×3` with the floor at **44**, and the
gap between the human ceiling (25, u/chilidirigible) and the bot floor widens
from 14 points to **19**. Finding 4's "seven of eight top out at `moderate`" is
now five of eight.

### What this does not establish

**A reply-bot that drops one top-level comment in 300 escapes this and still
collects its zero.** Closing that needs a threshold inside the three-comment
margin, next to a real account, and nothing in this corpus can justify one. The
bound is stated in `automation.js` and asserted in `test/scoring.test.js` so it
stays a stated limit rather than a later discovery.

**The discount below the cut is untouched.** An ordinary reply rate still votes
for a person at full weight, and every one of the 19 humans still bands `low`
on this signal. Withdrawing that is JIO-329 — 3.5 of 15.5 weight together with
`interval-regularity` — and it has a measured cost on real people that this
change deliberately does not pay: Finding 4b crossed seven live accounts into
`moderate`, u/chilidirigible among them.

**Eight declared bots, five of which reply.** "No reply-bot in this corpus gets
a vote for its humanity" is a statement about five accounts. It is not a
false-negative rate, and the corpus holds no *adversarial* reply-bot — one
built to look conversational — because no such population is available to
freeze.

## What this evaluation does not establish

The agenda axis has **no real-world validation** and cannot easily get one. The
automation axis was checkable because bots announce themselves; there is no
population of accounts known to be paid, so agenda rests entirely on synthetic
fixtures in `test/scoring.test.js`. Every real account tested here scored low on
it. That is consistent with a healthy thread and equally consistent with the
axis not firing — this test cannot tell those apart, and nothing in this
document should be read as evidence that the agenda axis works.

Finding 4c narrows that further and in one direction only. It measured what two
of the four agenda signals do to **people**, found that one of them ranks 16 of
the 19 humans above every bot in the corpus and the other separates nothing at
all, and held both to the evidence beside them. It says nothing
about what they do to an agenda account, because there is still no population
to ask. An axis that has now been made harder to fire is not thereby an axis
that fires correctly.

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
The two now frozen in `test/corpus/` inherit that limit exactly: they make the
counter-example re-runnable, and two hand-read accounts are still not a rate.
