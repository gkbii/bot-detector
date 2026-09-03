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

*That table is the 2026-08-05 live run and is left exactly as it printed. It
has moved four times since, every time on purpose and every time in Finding 4;
`npm run evaluate` reprints today's from the 27 frozen profiles in
`test/corpus/`, and Finding 4's closing note below carries that output.*

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
defect -- closed four days later by JIO-349, at the foot of this finding.

**AMENDED 2026-08-21 (JIO-386).** That fix ran too wide in one direction and
not wide enough in two others: the bare host rule matched numeric ratios, so
`"would you rate it 3.5/10?"` lost its question mark, while `example.com?utm=1`
and `/search?q=cats` kept theirs. A host now needs an alphabetic top-level
label, and a query counts as a link tail on its own when it carries an `=`.
Frozen-corpus scores are unmoved by it, which is a no-regression result and not
a re-measure: no account in `test/corpus/` exhibits either shape.

**RE-MEASURED LIVE 2026-08-21 (JIO-386).** 24,241 real comment bodies through
arctic-shift, 17,282 of them A/B'd through two scoring cores differing only in
`stripUrls()` — two firehose sweeps over 22 subreddits plus 22 whole profiles
(5,584 comments) through the real `fetchAccount`, scored on all three axes both
ways. **8 bodies of 17,282 (0.046%) changed, every one of them gaining text
back and not one of them a question mark**: `2.5/3.5` (u/Imgema), `1.5A/port`
(u/rogue1102), `5.2k/month` (u/Throwaway_LostOW), `15.8/16GB`
(u/NanosoftComputers), `$44.56/hour` (u/ScubaAlek) and `3.5/5` (u/Grindhoss).

The correction is to the size of the benefit, not its direction.
`asks-questions` — the signal this whole finding is about — moved on **0 of 22**
accounts, and no axis score moved on any of them. The live population of the
defect is rates and measurements, which land on the automation axis through
`normalizeWords()`; the review-rating shape the ticket was written around does
occur (u/Grindhoss) but never once beside a `?`. Bounds: 3 of the 22 profiles
were `insufficient-data` on `MIN_HISTORY_DAYS`, so 19 carry the score
comparison, and the firehose is one sweep on one day. A fourth sweep of 6,959
bodies measured what the new rules *remove* — host rule 2 firings, both genuine
links; root-relative `/path?a=b` rule **0 firings**, so that rule remains
asserted by tests and unmeasured in the wild. Finding 2's own numbers hold live:
u/RemindMeBot **0 of 300**, u/RepostSleuthBot **0 of 300**, u/AutoModerator 38
of 300. Full tables in README, "And the same rule, running the other way".

**THE RESIDUE CLOSED 2026-08-21 (JIO-349).** The separate defect left open
above — u/sneakpeekbot at 94 of 299 because its template quotes other people's
post titles — is fixed. `stripUrls()` now drops link TEXT as well as the link
target, but only on a line where nothing outside the brackets is a word of the
author's: `\#1: [someone else's title?](url) | [384 comments](url)` leaves
`\#1:  | `, while `hey [does anyone know?](url)` leaves `hey` and keeps the
question JIO-290 promised to keep.

| | before | after |
| --- | --- | --- |
| u/sneakpeekbot `asks-questions` | 97 of 299 (32%) | **0 of 299 (0%)** |
| u/sneakpeekbot authenticity | `low 16` | **`low 3`** |
| u/sneakpeekbot `near-duplicate-bodies` | 28 of 197 (14%) | **196 of 197 (99%)** |
| u/sneakpeekbot automation | `high 69` | **`high 88`** |
| every other frozen account, all 3 axes | — | unmoved |

The automation row is the same second-order effect JIO-386 saw and is worth
reading twice: the quoted titles were the ONLY varying content in that
account's bodies, so removing them does not merely stop crediting it with
questions, it reveals a template that is 99% self-similar.

**CORRECTED 2026-08-22 — that was generalised from n=1.** The sentence
originally here, "text that made a bot look more human on one axis was making
it look less templated on another", is false as a general claim and an audit
caught it. A signal-level A/B of all 27 frozen profiles shows the other three
link-carrying bots moving the OTHER way: u/RepostSleuthBot `near-duplicate-bodies`
185 of 200 -> 169, u/sub_doesnt_exist_bot 125 of 200 -> 117, u/RemindMeBot
200 -> 199, with `stock-phrasing` down for three of them as well (u/RemindMeBot
299 phrases -> 289). Stripping text usually leaves LESS to be self-similar with.
u/sneakpeekbot inverts that only because the stripped text was the sole varying
part of an otherwise fixed template. No axis score moves on any of the four, so
"every other frozen account, all 3 axes: unmoved" above stands exactly as
written — the number was right and the because-clause was one account.

The ticket's own proposed fix — strip blockquotes — is a **measured no-op**:
0 of those 299 bodies contain a `>` line.

**Cost, measured live the same day** (`node scripts/measure-quoted-titles.mjs`,
which must fetch: 19 of the 27 corpus profiles carry synthetic bodies with no
markdown links, so the corpus reports a cost of zero by construction).
**8,601 real bodies** from a content-blind sweep of 15 subreddits, plus **24
whole accounts (6,652 comments)** drawn at even ranks from that sweep's author
ranking and scored on all three axes both ways:

| | |
| --- | --- |
| bodies whose stripped text changed at all | 131 of 8,601 (1.52%) |
| bodies that lost a `?` | **2 of 8,601 (0.02%)** |
| window question rate | 14.65% → **14.63%** |
| help-seeking hits | 51 → 51 |
| `normalizeWords` tokens | 278,079 → 277,536 (0.20% removed) |
| accounts whose axis score moved | **1 of 24** (u/AutoModerator, authenticity 11 → 10) |
| band crossings | **0** |
| largest per-account `asks-questions` move | **0.7 points** (tolerance: 1–2) |

All three question marks lost across both arms were hand-read, and every one is
somebody else's text: a mod macro's canned `["How does my comment break Rule
1?"](faq)` (u/ElectricMayhem123), blockquoted anime screenshot captions
`>[wtf are they doing?](imgur)` (u/IndependentMacaroon), and a pasted article
headline `[Who Invented the Sandwich? | HISTORY](url)` on a line of its own
(u/Human_Drummer4378). **Zero authored questions were lost in 15,253 bodies.**

Bounds: one sweep on one day, and the profile arm is 24 accounts, not a rate.

**THE TWO STATED COSTS ARE NOW MEASURED (2026-08-22).** Both were written down
here and in `stats.js` before anyone had seen one, which is the only reason
either could be looked for. The `a) [title](url)` bound — the rule needs a word
of TWO letters to hold a line — is measured at **ZERO**: across two disjoint
live sweeps totalling ~17,000 bodies, **0 of 413** lines the rule killed had any
letter at all outside the brackets. It remains asserted in
`test/scoring.test.js` and unseen in the wild. The whole-body `[question?](url)`
bound is **real and it costs people questions**: u/DukeOfGeek's entire comment is
`[Dibs?](gif)` (31 -> 30 questions of 300, authenticity 34 -> 33) and
u/VintageRCFishArtist's is `[this?](youtu.be/…)` (23 -> 22 of 300, no axis
moved), one each in two independent profile arms of 20 and 24 accounts. Neither
crossed a band.

**THE SECOND HALF, CLOSED 2026-08-22 (JIO-349).** The ticket's Definition of
Done reads "quoted **or block-quoted** third-party text is excluded", and only
the first half had shipped. `normalizeWords()` has dropped `^>` and `^&gt;`
lines since it was written, so the AUTOMATION axis always read a block quote as
somebody else's words — but the strip lived one call too late for `stripUrls()`,
and therefore for `asks-questions`, to see it. The two axes disagreed about who
said what for as long as both existed, while `questionSignal`'s docstring
claimed "both halves of this signal see the same text". Moving one `.replace()`
into `stripUrls()` makes that sentence true; the docstring is corrected in the
same commit.

The frozen corpus cannot show this one either — 6 of 7,469 bodies carry a `>`
line, and the only signal that moves is u/AutoModerator's `asks-questions`,
35 -> 34 of 296, with no axis and no band. Measured live instead, **17,177
bodies over 15 subreddits** plus **24 whole accounts (6,133 comments)** drawn at
even ranks from that sweep's own author ranking, against a core with BOTH
JIO-349 rules reverted, every lost `?` re-tested against a quote-strip-only core
so the two can be attributed:

| | |
| --- | --- |
| bodies carrying a `>` line at all | 283 of 17,177 (1.65%) |
| bodies whose stripped text changed | 563 of 17,177 (3.28%) |
| bodies that lost a `?` | 51 — **2.00% of every question counted** |
| attributed: quote strip / link-text rule | **47** / 4 |
| window question rate | 14.88% → **14.58%** (0.30 points) |
| help-seeking hits | 97 → 93 |
| `normalizeWords` tokens | 547,016 → 545,860, **all of it the link rule** |
| accounts whose axis score moved | **2 of 24** |
| band crossings | **0** |
| largest per-account `asks-questions` move | **2.0 points** (tolerance: 1–2) |

**24 lost question marks hand-read across seven accounts; 23 are somebody
else's.** u/notthegoatseguy is the largest mover and the one to read: 6 of 59
lost, five of them pasted Reddit help-article titles alone on a line
(`[What is karma? – Reddit Help](url)`) and one a textbook quote-and-answer — a
person who links documentation and answers other people's questions, credited
with six questions they never asked. u/AftyOfTheUK loses 10, every one a
`>quoted question` answered in flat declaratives. The one exception is
u/VintageRCFishArtist's `[this?](url)`, which is the link-rule bound above, not
this rule.

The 2.0 sits at the TOP of the tolerance and is reported rather than rounded
off. It is a fix and not a cost — all six questions behind it were hand-read and
all six belong to somebody else — but a tolerance bounds how much a change may
move a person, not how much it will, and at this size the hand-read is the
result rather than the table. Further bounds: the pattern is anchored at column
0 and kept CHARACTER-FOR-CHARACTER as `normalizeWords()` had it, so moving it
cannot move automation — checked, not assumed: `normalizeWords()` is
byte-identical on all 7,469 frozen bodies against a core holding the old
arrangement — and the same anchor means a quote indented by a space is not
seen; 2 of the 24 profiles were `insufficient-data`,
so 22 carry the score comparison; and 24 of the 51 losses were read, chosen as
the accounts that moved most, which is a worst case rather than a sample.

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
  *(FIXED 2026-08-21, JIO-346 — Finding 4e below.)*
* **`conversation-depth` inverts for reply-bots.** RemindMeBot replies to a
  commenter 100% of the time, which the signal reads as conversational.
  *(FIXED 2026-08-21, JIO-345 — Finding 4d below.)*

Two authenticity signals also actively reward being a bot: `topical-breadth`
scored `high` for AutoModerator (333 subreddits) and RemindMeBot (175) — running
sitewide is what a bot *is*, not evidence of a person with wide interests — and
`asks-questions` per Finding 2. AutoModerator lands on authenticity **moderate
38** with both of its high signals being artifacts of automation.
*(FIXED 2026-08-21, JIO-347 — Finding 4f below.)*

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
measurement.

**SECOND BULLET FIXED 2026-08-21 (JIO-346), the same way and on the same day.**
`interval-regularity` is `unmeasured()` above CV 1.0 — the ceiling its own
`rescale` already clamped at, where 26 of the 27 frozen accounts sit and every
one of them scored the identical 0.000. Three more bots cross to `high`, no
human in the frozen corpus crosses anything, and the bots' cell becomes
**`moderate x2, high x6` with the floor at 54** against a human ceiling of 29.
Finding 4's headline — seven of eight declared bots topping out at `moderate` —
is now **two of eight**, and all three of its bullets are closed. Finding 4e has
the measurement, and the human ceiling moved 25 -> 29 to get it, which is the
part that is not free — including one human who **does** cross on live data
fetched the same day, which 4e states in full.

**CLOSED 2026-08-21 (JIO-348), and the decision is that the ceiling was resolved
by signal semantics rather than by moving weights.** That is checkable rather
than a statement of intent. `BAND_THRESHOLDS = { moderate: 30, high: 65 }` in
[axis.js](extension/lib/scoring/axis.js) is what it was in `a70e0d6`, the
scoring core's first commit, and
`git diff 1c13185~1 HEAD -- extension/lib/scoring/axis.js` — the whole span of
the four remedies — prints nothing at all. No existing signal's weight moved
either: `sustained-posting-rate` was *added* at weight 2 and the other three
remedies are an `unmeasured()` at a pole or a taper. Each of the four changed
what a signal is allowed to *say*; none changed what a signal is worth, and none
changed where a band begins.

The distinction is the finding. Closing a ceiling by lowering the `high` edge
would have moved all 27 accounts, the humans included, and bought the headline
by making the tool readier to accuse. Restating what a signal can read moves
only the accounts that signal was wrong about — which is why JIO-345 and
JIO-347 touched no human automation score at all, and why the one remedy that
did move humans says so in its own section rather than here.

The four, in the order they landed:

* **JIO-344** (first bullet) — `sustained-posting-rate` added at weight 2,
  measuring throughput across exactly the window `posting-hour-dead-zone`
  refuses. Bots' automation cell `moderate x6, high x2`, floor 39. No human
  moved.
* **JIO-345** (third bullet) — `conversation-depth` returns `unmeasured()` for
  an account with no top-level comment anywhere in its window. `moderate x5,
  high x3`, floor 44. No human moved.
* **JIO-346** (second bullet) — `interval-regularity` returns `unmeasured()`
  above CV 1.0, the ceiling its own `rescale` already clamped at. `moderate x2,
  high x6`, floor 54. Ten humans moved and the human ceiling went 25 -> 29,
  which is the part that was not free.
* **JIO-347** (the `topical-breadth` paragraph) — breadth multiplied by items
  per group, the taper withheld below 45 grouped items. Automation untouched;
  the bots' *authenticity* cell became `low x8` (3–17).

**The table, re-measured.** `npm run evaluate` on 2026-08-21 against the same 27
frozen profiles, verbatim (exit 0; `npm test` 167/167 the same day):

```
                   automation                    agenda               authenticity
17 thread humans   low ×17 (0–20)                low ×17 (0–13)       moderate ×10, high ×7 (38–81)
2 prolific humans  low ×2 (16–29)                low ×2 (19–19)       low ×1, moderate ×1 (16–52)
8 declared bots    moderate ×2, high ×6 (54–89)  moderate ×8 (36–64)  low ×8 (3–17)

Separation on automation — no human above `low`, no bot at `low`: HOLDS
```

Separation has not regressed; it is wider than on the day this document was
written. The bots' floor went 35 -> 39 -> 44 -> 54 across the four remedies,
each step quoted above, while the human ceiling moved exactly once, 25 -> 29 at
JIO-346. Nothing at all sits in the 25 points between them.

**What did not close, because it is the thing that gets hidden.** JIO-348 asked
for no declared bot capped at `moderate`, and that is not what landed: it is
**two of eight** — u/Anti-ThisBot-IB at 54 and u/sub_doesnt_exist_bot at 58,
down from seven of eight. The change that would have delivered the sentence as
written is dropping the `high` edge from 65 to 54, and that is the one change
this finding exists to refuse. It promotes by redefinition rather than by
evidence, and `BAND_THRESHOLDS` is shared by all three axes, so it would take
eight thread humans from authenticity `moderate` to `high` and three bots from
agenda `moderate` to `high` at the same time, on no new measurement whatsoever.

The residual two are the *first* bullet, unchanged. u/Anti-ThisBot-IB's 299
comments span 2.3 days against that signal's 3-day minimum, so the weight-3
`posting-hour-dead-zone` is still `insufficient-data` for it; with
`interval-regularity` and `conversation-depth` also `unmeasured()` by JIO-346
and JIO-345, only 9.0 of the axis's 15.5 weight is measured for it at all —
over `axis.js`'s half-weight gate, but not by much. JIO-344 covered that window
with a weight-2 substitute rather than closing the gap, and a weight-2
substitute for a weight-3 signal cannot restore the full range.
u/sub_doesnt_exist_bot is the opposite case and the narrower one: it is the
single frozen account `interval-regularity` still measures (CV 0.94, Finding
4e), and it reads `low` there and on `cross-thread-bursts` and `karma-velocity`
because on those three it genuinely is not extreme.

So the ceiling is a sensitivity limit and no longer a separation risk: both
survivors sit at least 25 points clear of the highest-scoring human in either
cohort, and `moderate` on automation was never an all-clear. A reader who wants the number
to be eight of eight should look for the fourth mechanism, not at
`BAND_THRESHOLDS`.

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

## Finding 4e — an uneven cadence scored as a person, and 26 of 27 accounts scored the same number

Measured on **2026-08-21** by `scripts/measure-interval-cv.mjs`, over the 27
accounts frozen in `test/corpus/`. **No network**, like Findings 4c and 4d:
`scoreAutomation` is pure and the corpus is JSON, so this is arithmetic on disk
and reproduces byte-for-byte. Run it rather than trusting the tables below.

**One section of this finding is the exception, and it is the important one.**
*What this does not establish* below rests on a **live** measurement
(`scripts/measure-interval-crossing.mjs`, which fetches), because it reports a
band crossing that the frozen corpus is three days too old to show. That part
does not reproduce byte-for-byte and is dated for that reason.

This is Finding 4's second bullet, asked properly, and it is the last of the
three. Like the third it had been sitting inside JIO-329, which would have
removed the signal outright rather than gating the end of it that inverts.

### The measurement

`interval-regularity` scored `strength = 1 - rescale(cv, 0.15, 1.0)`, and
`rescale` **clamps at its ceiling**. So a CV of 1.0 and a CV of 16.1 both
produced **strength exactly 0.000**: the maximum vote for humanity this axis
can cast, at the signal's full weight of 2.

| | interval CV | strength |
|---|---|---|
| 19 humans | 1.53 – 5.29 | **0.000, every one** |
| 7 of the 8 declared bots | 1.08 – 16.09 | **0.000, every one** |
| u/sub\_doesnt\_exist\_bot | 0.94 | 0.068 |

**26 of the 27 frozen accounts scored the same number.** u/RemindMeBot measures
CV 1.09 in the frozen window and measured 1.26 in the live 2026-08-05 one
quoted in Finding 4 — a difference of no consequence, because both sit above
the ceiling and both produced the same 0.000 and the same badge sentence:
*"that is the irregular, clumpy spacing typical of a person"*. It got that
sentence because a summon-driven bot does not own its own
rhythm. It posts when people ask it to, so the irregularity it is being
credited for is **its users' and not its own**, and the tool was reading demand
for the account as evidence about the account. Finding 4b measured the identity
from the other side and reported it in one line: this signal reads **0.000 for
ordinary people AND 0.000 for u/RemindMeBot**.

**The live arm says the same thing more starkly.** Re-run against the
whole-ranking sample harvested for Finding 4b on 2026-08-21 (10 busy
subreddits, 11,410 comments, 7,345 distinct authors, 80 accounts drawn at even
ranks from 1 to 7,344, 77 scored): **all 77 scored strength exactly 0.000
here.** Not 77 near-zeros — 77 identical zeros. A signal that returns one
constant across a content-blind sweep of a live platform is not a weak signal,
it is an unread one.

### Why the gate is the ceiling of the scale and not a number next to the corpus

Finding 4d had to draw its cut inside a three-comment margin and solved that by
making the cut categorical. Here the problem does not arise, because the
arithmetic had already chosen the number: **1.0 is where `rescale` stops**.
Above it the function is constant by construction, so the gate is not a
threshold drawn next to 19 people — it is the point the existing scale itself
gave up at, restated honestly as `unmeasured()` instead of as a confident zero.
axis.js rule 3, applied to a POLE, exactly as JIO-345 applied it.

The mechanical pole is untouched, and it is the half that separates. Below 1.0
the strength climbs to a full-weight 1.0 at CV 0.15, and
u/sub\_doesnt\_exist\_bot (CV 0.94) is the one frozen account still measured
here.

### The alternative that was not built, and why

The ticket offered a second option: measure the regularity of **response
latency** — parent comment to this account's reply — which is a rhythm the
account genuinely does own. It was probed live on 2026-08-21 rather than
assumed: `/api/comments/ids?ids=` returns `created_utc`, takes 120 ids per
request, and all 299 of u/RemindMeBot's parents are `t1_` comments, so it is
buildable.

It was still not built. It needs a new `AccountProfile` field, a second fetch
pass in `arcticShift.js` and a **re-capture of all 27 frozen profiles** before
`npm run evaluate` could measure anything about it — and PLATFORMS.md's
contiguity rule forbids populating this signal family from a payload whose
contiguity cannot be proven. Parent timestamps arrive by id lookup with no
window guarantee at all, which is the same defect Finding 1 found in the hour
histogram. That is a ticket of its own if it is ever worth one, not a detail to
be worked around inside this fix.

### What moved

17 of the 81 frozen scores, and the direction is the whole result:

| | automation |
|---|---|
| u/RemindMeBot | `high 73` → **`high 89`** |
| u/RepostSleuthBot | `high 75` → **`high 89`** |
| u/AutoModerator | `high 69` → **`high 82`** |
| u/AmputatorBot | `moderate 60` → **`high 71`** |
| u/same\_subreddit\_bot | `moderate 57` → **`high 69`** |
| u/sneakpeekbot | `moderate 57` → **`high 69`** |
| u/Anti-ThisBot-IB | `moderate 44` → `moderate 54` |
| u/sub\_doesnt\_exist\_bot | 58 → 58 (CV 0.94; still measured) |
| 10 humans | +1 to +4, **all still `low`** |

Three bots cross to `high`. The bots' cell in the headline table becomes
`moderate ×2, high ×6` with the floor at **54**, and Finding 4's "seven of
eight top out at `moderate`" is now **two of eight**. No human crosses a band,
and all 17 thread humans stay `low` with a ceiling of 20.

**A bound that was checked rather than assumed.** Taking 2 of weight away from
the loudest bots could have pushed them under `MIN_MEASURED_WEIGHT_FRACTION`
and answered `insufficient-data` for exactly the accounts the fix was aimed at
— the failure mode the 82-second window produced for `sustained-posting-rate`.
It does not. The worst case in the corpus is **9.0/15.5 = 0.581**
(u/Anti-ThisBot-IB, u/RemindMeBot and u/sneakpeekbot, each with
`posting-hour-dead-zone` and `conversation-depth` also unmeasured), which is
1.25 of weight clear of the gate.

### What this does not establish

**The human ceiling moved 25 → 29, and that is one point from the band edge.**
u/chilidirigible is the account, and the four points are not an accident of one
profile: removing 2 of 15.5 weight multiplies an ordinary score by
`mw / (mw − 2)`, and a multiplier on the score is a divisor on the band edge, so
`moderate` begins early by exactly that factor. This is Finding 4b's arithmetic
at a smaller removal, including the half of it that is easiest to drop:
**the effective edge is a property of the profile's shape and not only of the
change.** Re-fetched live on 2026-08-21, the 19 corpus humans carry three
shapes, and `30 × (mw_pre − 2) / mw_pre` gives each a different edge: **25.2**
at a pre-cut measured weight of 12.5 (three of them), **25.6** at 13.5 (fifteen
— the common shape), and **26.1** at 15.5, which is u/chilidirigible's own
all-eight-signals shape and therefore the number that governs the very account
this paragraph is about. Thinner profiles fall further: **24.5** at a pre-cut
weight of 11, the shape three of the eight declared bots have. So 25.6 is the
typical edge and not the edge — the same qualification Finding 4b made of its
own 22.2 (×1.35 at 13.5, ×1.39 at 12.5, ×1.29 at 15.5), which is easy to lose
when the figure is repeated on its own.

**And the 26–29 strip is not empty. It was measured on the day this landed, and
the account standing in it is the one named above.** All **19** corpus humans
were re-fetched live on 2026-08-21 through the shipped `fetchAccount` and scored
by the shipped `scoreAutomation`, and one of them crossed:

| | interval CV | measured weight *after* | before | after |
|---|---|---|---|---|
| **u/chilidirigible** | 2.34 | 13.5/15.5 | **`low 26`** | **`moderate 30`** |
| u/Hartacus (highest non-crossing) | 2.31 | 11.5/15.5 | `low 20` | `low 23` |
| the other 17 | 1.52 – 5.14 | 10.5 – 11.5 / 15.5 | `low 0` – `low 17` | `low 0` – `low 20` |

(The weights above are what remains *after* the cut, which is 2 less than the
`mw_pre` the edges in the paragraph above are computed from. 13.5 after = 15.5
before, and so on.)

The before column reconstructs the signal at the clamped strength 0.000 it used
to earn at weight 2; bracketing u/chilidirigible's published 30 across its
rounding gives 25.69–26.56, so the band is robust to it. It crossed, and the
crossing reproduced across four independent fetches that day.

**One of nineteen, and the other eighteen are not close** — the runner-up lands
at 23, seven points short. So this is a *narrow* falsification and it is worth
saying so: the strip is populated, not crowded, which is the same shape of
answer Finding 4b gave for JIO-329's own 22–29 strip (4.1%).

That reconstruction is exact rather than estimated, and the reason is the same
clamp this whole finding is about: above CV 1.0 the old strength was not
*approximately* zero, it was **0.000**, so re-adding 2 of weight at that
strength recovers the old score with no modelling in between.

That is a **direct falsification of the sentence this section would otherwise
have ended on**, and both halves are kept here because the gap between them is
the finding. Nobody in the *frozen* corpus was standing in the strip, and none
of the 77 accounts in the live re-run above crossed — both true, both checkable,
and neither able to see this. `test/corpus/` was captured **2026-08-18** and
u/chilidirigible drifted one point in three days; the 77-account arm's
before-scores top out at **24**, and u/chilidirigible was never in that arm at
all — it entered arm B by `--include`, which Finding 4b excludes from its rates
by design. Two zero-crossing samples were never evidence that the strip is
empty, and a third one, taken live, has now found the account standing in it.

`node scripts/measure-interval-crossing.mjs --all-humans` is this measurement,
and unlike the
four `measure-*.mjs` scripts above **it goes to the network** — necessarily, and
that is the point rather than a lapse. The frozen corpus is what hid this for
three days, so a question about drift cannot be asked of the snapshot the drift
is measured against. It is the one `measure-*` script deliberately left off
`test/corpus.test.js`'s no-network allowlist, and the guard's own comment says
so. It re-fetches accounts this repo already names, so it can tell you the
invariant broke and **cannot** tell you how crowded the strip is; Finding 4b's
whole-ranking sweep is the tool for that.

**The stake, because it is sharper than a caveat.** `test/corpus/` freezes
profiles, so `npm run evaluate` prints `Separation on automation — no human
above low, no bot at low: HOLDS` and exits 0. Against a corpus **re-captured
today** it would print `BROKEN`, name u/chilidirigible, and exit **1** —
`evaluate.mjs` gates its exit code on that invariant, so this is a red build and
not a softer table. The headline separation is therefore not comfortably true;
it is true *of a 2026-08-18 snapshot*, at exactly the boundary, on one point of
drift. Whether to re-capture the corpus is a call for the repo's owner rather
than something to be absorbed quietly here, and it is written down so that the
day it flips reads as a confirmation instead of a surprise.

**The remaining half of JIO-329 is now priced against this new baseline.**
Dropping `conversation-depth` for ordinary repliers as well would take
u/chilidirigible from `low 29` to **`moderate 32`** — the same projection
Finding 4b published before either change landed, reproduced from the frozen
profile with half of it in place. The 30-to-22.2 band-edge figure in Finding 4b
was for all 3.5 of weight at once; 2 of it has now been spent, and it bought
four bots a band rather than costing a person one.

**An adversarial bot that jitters past CV 1.0 buys exactly the silence a person
gets.** That is not a new hole — it scored a confident 0.000 before, which was
worse — but the fix does not close it, and no corpus available to this repo
holds such an account to check against. `test/scoring.test.js` asserts both
sides of the gate so the escape stays a stated bound rather than a later
discovery.

**Eight declared bots, all utility bots.** "The tool now reads six of eight as
`high`" is a statement about eight accounts that announce themselves. It is not
a detection rate.

## Finding 4f — `topical-breadth` scored 307 subreddits as a range of interests, and vouched for every bot in the corpus

Measured on **2026-08-21** by `scripts/measure-topical-breadth.mjs`, over the 27
accounts frozen in `test/corpus/`. **No network**, like Findings 4c, 4d and 4e:
`scoreAuthenticity` is pure and the corpus is JSON, so this is arithmetic on
disk and reproduces byte-for-byte. Run it rather than trusting the tables below.

**Then audited against live data the same day, and it came back with two
corrections** — both landed, both below under *The second lap*. The corpus is
19 people, and 19 people reported a gap the population does not have.

This is Finding 4's last paragraph — the authenticity half of the ceiling,
where two signals *reward* being a bot — and with `asks-questions` closed by
Finding 2 it is the last open item in JIO-329's definition of done.

### The measurement

`topical-breadth` scored `0.5 × rescale(outside-the-largest-group, 0.15, 0.75)
+ 0.5 × rescale(distinct groups, 2, 15)`, and **both halves saturate on
sitewide automation**. u/AutoModerator posts into 307 groups with 98% of itself
outside the largest, so it took a flat **1.000** — the largest vouch this signal
can award anybody — on the axis whose entire job is to say *this is a person*.

| | distinct groups | items per group | this signal |
|---|---|---|---|
| 8 declared bots | 148 – 307 | **1.24 – 2.06** | **`high` ×8** |
| 17 thread humans | 25 – 92 | 3.08 – 12.36 | `high` ×17 |
| 2 prolific humans | 6 – 9 | 41.4 – 66.7 | `low` ×2 |

**The ticket named two accounts; the corpus says all eight.** JIO-347 was filed
off Finding 4's live numbers — AutoModerator at 333 subreddits and authenticity
`moderate 38`, RemindMeBot at 175 — and the frozen 2026-08-18 window reads 307
and `low 29` for the same account. That gap is two fetch windows and the
signals JIO-345 and JIO-346 landed in between, not a regression: the *band on
this signal* is `high` in both, and it is `high` for the six bots the ticket did
not name either.

The second half is not merely saturated but **inverted**: share outside the
largest group runs **0.84 – 0.98 for the bots** against **0.03 – 0.87 for the
people**. Being everywhere is the job. u/AutoModerator's frozen window is 296
comments spanning **82 seconds** across 300-odd subreddits — one automod reply
per subreddit, which is reach with no depth anywhere in it.

### Why the taper is items per group, and why neither end is fitted to this table

Items per group separates the two frozen populations with **no overlap** —
every bot at 1.24–2.06, every human at 3.08–66.7. The signal is now
`reach × depth`, where `depth = rescale(items per group, 1, 3)`.

Neither end is a number drawn next to 27 accounts. **1.0 is the arithmetic
minimum of the measure** — one item in every group, a visit and never a return —
and **3 is a return visit rather than a drive-by**. Finding 4e could point at
the ceiling of a `rescale` and Finding 4d had to make its cut categorical inside
a three-comment margin; here the measure has a floor of its own. That
derivation is the whole defence of the constant, and it has to be, because the
margin underneath it turned out to be half what this table says — see *The
second lap*.

**The obvious rival was rejected on its own number.** The share of an account's
groups holding exactly one item does separate these populations — by **0.0023**:
u/humdingler at 0.6667 against u/RepostSleuthBot at 0.6689. A cut there is
fitted to the third decimal place of one person, and one more comment in a
group they had already visited would move it. On items per group these same 27
accounts are 1.02 apart — a like-for-like comparison of two measures over one
table, not a claim about the population.

### Why this is a taper and NOT `unmeasured()`, unlike 4d and 4e

Both of those closed an inverting signal by declining to score its bad pole, per
axis.js rule 3. **That fix would make this defect worse.** `buildAxis` averages
over MEASURED weight only, so removing a signal redistributes its weight to the
others — a penalty on a suspicion axis, and a **gift** on the axis that exists
to vouch. Taking `topical-breadth` to `unmeasured()` would have *raised* all
eight bots' authenticity scores. A signal that has read "reach without depth"
has measured something real and must score it low rather than look away, and
the evidence string names the discount it applied:

```
Active in 307 groups across 396 items; the largest accounts for 2%, leaving 98%
elsewhere (spread 0.98 of 1.00). That is 1.29 items per group — reach without
depth, which is what running sitewide looks like rather than what being curious
looks like, so the breadth credit is cut to 14% of what the reach alone would
score.
```

### What moved

8 of the 81 frozen scores, and **every one of them is a bot going down**:

| | authenticity |
|---|---|
| u/AmputatorBot | `low 25` → **`low 3`** |
| u/RemindMeBot | `low 25` → **`low 5`** |
| u/same\_subreddit\_bot | `low 25` → **`low 6`** |
| u/AutoModerator | `low 29` → **`low 8`** |
| u/RepostSleuthBot | `low 25` → **`low 13`** |
| u/Anti-ThisBot-IB | `moderate 32` → **`low 15`** |
| u/sneakpeekbot | `moderate 38` → **`low 16`** |
| u/sub\_doesnt\_exist\_bot | `moderate 38` → **`low 17`** |
| 19 humans | **not one point, in either direction** |

Three bots cross a band and the bots' authenticity cell in the headline table
becomes **`low ×8` (3–17)**, against thread humans at `moderate ×10, high ×7`
(38–81). Every frozen human is untouched because every frozen human's depth
taper is exactly 1.00. Live, 2 of 42 are tapered and neither changes band.

### The second lap — audited live on 2026-08-21, two corrections

The tables above are 27 accounts frozen on 2026-08-18. The Auditor went and
looked at accounts nobody had chosen, on the same day the taper landed.

**The sample, stated.** 11,882 distinct authors harvested from a recent window
of **24 deliberately diverse non-political subreddits** (hobbies, regions,
crafts, help-desks, general chat — not r/politics, which the frozen corpus
already is). From those, **44 accounts fetched, 42 scorable**, selected
**content-blind before a single profile was fetched**: a systematic every-297th
slice of the author list, plus the only 4 authors who appeared in 3 or more of
the 24 subs — a slice ranked on breadth, which is the counter-example being
hunted, and which cannot see items-per-group because that is not computable
until after the fetch. Every tapered and near-edge account was then hand-read
from its comment bodies. All of them read human. The artifacts were not frozen
into `test/corpus/`; the accounts are named below, so any of it can be re-fetched.

**Correction 1 — a near-floor false positive, now closed by `DEPTH_MIN_ITEMS`.**

| u/Acrobatic_Quail_6117 | |
|---|---|
| history | 21 comments + 4 posts = **25 grouped items** across **19 groups** |
| items per group | **1.32** |
| coverage | not truncated — that is the whole account |
| other axes | automation `low 0`, agenda `low 9` |
| bodies | plainly a person ("How's that moon now 😂") |
| `topical-breadth` | **`low`** — the same band as u/AutoModerator |
| authenticity | **`moderate 33` → `low 12`**, a band crossing on a real person |

Above the floor, items per group measures how an account spends its history.
At the floor it measures how much of one there is, and no history is short
enough to be evidence of automation. So the taper is now **withheld below 45
grouped items**. 45 is `REACH_FULL_CREDIT_GROUPS × DEPTH_FULL_CREDIT` — the two
constants already in the signal — and is therefore the smallest history in which
an account can satisfy both halves of it at once; below that they are in
structural conflict, since every item spent widening the reach is one
unavailable to deepen it. It is not a number chosen next to this account.

**The gate costs the JIO-347 result nothing.** The smallest declared bot in the
corpus, u/Anti-ThisBot-IB, carries **299** grouped items — 6.6× the gate — and
u/AutoModerator 396. Re-fetched live on 2026-08-21 under the gate:
u/AutoModerator 315 groups at 1.27 each, breadth `low`, authenticity `low 10`;
u/RemindMeBot 245 groups at 1.23, breadth `low`, authenticity `low 3`;
u/Acrobatic_Quail_6117 back to breadth `high`, authenticity `moderate 33`.
No frozen score moves and `expected.json` is untouched by this lap.

**Correction 2 — the margin was the corpus's, not the population's.**

The claim was "no overlap, a factor of 1.49, and 3 happens to sit just under the
thinnest human". Live, the human tail runs lower:

| | items per group | tapered | authenticity |
|---|---|---|---|
| u/leilani238 | 331 items / 131 groups = **2.53** | 0.763 | `low 22`, −5.9, **no band change** |
| u/Iampepeu | 400 / 153 = **2.61** | 0.807 | `moderate 30`, −4.8, **no band change** |
| 6 more of the 42 | 3.07, 3.13, 3.23, 3.23, 3.56, 3.57 | 1.00 | within 20% of the edge |

Real headroom above the busiest corpus bot is **0.47, not 1.02**. The cut still
lands where it was aimed and the pole Delivery could not check comes back
proportionate — a genuinely broad prolific human is docked single-digit points
and stays in band — but *"the gap is wide enough that nobody is standing in it"*
was a statement about 19 people. `authenticity.js`, `measure-topical-breadth.mjs`
and the README now carry the live number beside the frozen one, and the constant
rests on its derivation instead of on the margin.

### What this does not establish

**A bot that returns to what it touches keeps the full credit.** Three items per
group buys back everything the taper takes, and no corpus available to this repo
holds an account that does it deliberately. This raises the price of the vouch,
it does not close the door — that bot has to be caught on the automation axis.

**The taper is priced by the fetch window as much as by the account.** 300
comments spread over 300 groups cannot demonstrate depth even if the account has
it; u/AutoModerator's 82-second window is the extreme case. It cuts the right
way here only because the volume that truncates the window is itself the bot
signal, and the two prolific humans in the corpus concentrate rather than spread
(41 and 67 items per group). The prolific-and-genuinely-broad human this was
written to worry about **has now been checked** — u/leilani238 and u/Iampepeu in
*The second lap* — and is docked 5.9 and 4.8 points without changing band. That
is two people on one day, not a bound that has been closed.

**It has a real cost for BROAD accounts, and it is accepted deliberately.** A
person with 200 comments across 150 different groups scores near zero here. One
comment in each of a hundred groups is the same *shape* as the adversary, and
this axis reads `low` as "we found no positive evidence" rather than as an
accusation — the other four authenticity signals are untouched and still speak
for that account. The live sweep below priced it at 5.9 and 4.8 points on two
real people, neither of whom changed band. `test/scoring.test.js` pins both ends
of the taper and both sides of the gate, because nothing in the frozen corpus
sits between 2.06 and 3.08 items per group or under 117 grouped items: a change
that moved the full-credit constant to 6, or the gate up past the smallest bot's
299, would leave `npm run evaluate` green while quietly docking half the people
on the platform or handing all eight bots their reach back.

**The sentence a tapered person reads was also written for a bot, and is not
anymore.** The `reach without depth … what running sitewide looks like` string
was drafted against u/AutoModerator at 1.29 items per group; u/leilani238 at
2.53 is docked 24% and is a person. Past **2 items per group** — where the
average group stops being a single visit — the evidence now reads *"the account
does go back to what it touches, but short of the 3 that reads as a return
rather than a look around"*. The score is identical. This axis states in its own
header that `low` is not an accusation, and the evidence string is where that
promise is either kept or broken.

**A bot with fewer than 45 grouped items is handed the gate too.** It is a
statement about how much history exists, and it cannot tell whose history is
short. Nothing in this corpus is that small and an account that thin has little
for the other signals to read either — but the door is open, and saying so is
cheaper than pretending it is not.

**Eight declared bots, all utility bots.** "No bot is vouched for by its reach"
is a statement about eight accounts that announce themselves. It is not a
detection rate.

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

---

# Appendix — narrative moved out of the README

The README carried a second, longer telling of the findings above until it
reached 1,969 lines. The prose is preserved here verbatim rather than deleted.
**It overlaps the numbered findings above and has not yet been merged into
them** — that merge is the outstanding job on this file. Where the two
disagree, the numbered finding is the one with the measurement behind it.

Verified before the move: of 88 distinctive identifiers in this text, 8 appear
nowhere else in this file (`LIVE_STRIP_URL_CASES`, `MIN_ITEMS_FOR_RATE`,
`SATURATED_ITEMS_PER_HOUR`, and five named accounts), which is why it is an
appendix rather than a deletion.

## Four false positives, all found against live accounts

The test suite passed through every one of these — 106 green tests while two of
them were live. They were found by running the thing against real accounts,
which is the only reason they are fixed. Each one now has a test that fails
without its fix; that is the actual deliverable, because the suite being green
is what let them survive in the first place.

**A forged 12-year dormancy.** Comments and posts are fetched as *separate*
newest-first windows with different depths. An account with 1.59M comments
returned its newest 299 — about an hour of activity — plus one submission from
2014. Merged naively, that reads as a twelve-year dormancy followed by a
revival, which is the single **heaviest agenda signal** (weight 3) firing on
nothing but the shape of our own pagination. `reliableTimelineStart()` now drops
everything older than the oldest item of any truncated stream: below that point
we hold partial data and cannot tell absence from not-having-asked. It is
deliberately conservative — a real gap in a complete stream gets discarded
because the *other* stream was truncated — because inventing a gap is far worse
than missing one.

**A human sleep-cycle alibi for a bot.** The same account's ~300 comments span
under six hours, and necessarily leave 18 hours of the day empty. The hour
histogram read that as "17 consecutive quiet hours, consistent with a sleep
cycle" — a perfect human alibi, manufactured entirely by the fetch window. A
sleep cycle is a claim about days, so it now needs days:
`MIN_SPAN_DAYS_FOR_HOUR_PROFILE = 3`. **That one fix moved the account from 48
to 62.**

Related, and the same species of care: a quiet hour is one holding less than
20% of the account's average hour, not one that is strictly empty. A prolific
human eventually lands a comment in every hour of the day across insomnia,
travel and timezone changes, and a strict-zero test would call them a bot for
it.

**A query string counted as a question.** `asks-questions` was
`body.includes('?')` against the raw body, so every `?context=3` and
`message/compose/?to=` in a bot's own boilerplate read as curiosity. Live on
2026-08-17, before the fix: **u/RemindMeBot 295 of 299 comments "ask a
question", u/RepostSleuthBot 299 of 299** — the maximum on the one signal whose
entire purpose is positive evidence of a *person*, awarded to two template bots.
`stripUrls()` in `stats.js` now removes markdown link targets, anything with a
scheme, bare `host.tld/path` and `host.tld?a=b` tokens, and root-relative
`/path?a=b` before the test; both accounts scored **0 of 299** on the same live
data afterwards, and two humans moved 118→107 and 15→14. That ratio is the
whole point: the defect was invisible on humans and total on the adversary,
which is exactly the shape a suite of hand-built fixtures cannot see.

Two details are load-bearing. The link **text** survives when the author wrote
a sentence around it, because `hey [does anyone know?](url)` is a question its
author asked — see "Whose words are in the brackets" below for the line where
that stops being true. And the help-seeking patterns run over the *same
stripped body*, so both halves of the signal read what the author actually
typed rather than one reading the raw text and the other not.

**And the same rule, running the other way (JIO-386).** The bare host rule was
`[\w-]+(?:\.[\w-]+)+/` — two dot-joined word chunks and a slash. A numeric
ratio is that shape, so `"would you rate it 3.5/10?"` was cut to
`"would you rate it"`: a *person* lost a genuine question, and `normalizeWords()`
lost the tokens, on the one signal that is positive evidence of a person. A
host now has to end in an **alphabetic** top-level label of two or more
letters, which `3.5/10` and `10.50/hour` fail on `5` and `50` — and so do
`U.S./Canada`, `A.I./ML` and `v1.2.3/build`, three more things the old rule
quietly ate. Stated rather than left to be discovered: a bare IPv4 literal with
a path (`1.1.1.1/help?x=1`) has no alphabetic label anywhere and survives. With
a scheme it does not, and a scheme is how anyone writes one.

The same fix closes the other direction. Requiring the slash left `?` behind in
`example.com?utm=1` and `/search?q=cats`, so a query counts as a link tail on
its own now — but only if it carries an `=`. That is what keeps
"see example.com?" a question, the promise the slash used to keep, and it is
what stops the root-relative rule reading `and/or`, `he/she` and `12/25` as
links.

Worth knowing before trusting the corpus on this one: the rewrite changes **not
one** of the 7469 stripped bodies in `test/corpus/`, and `npm run evaluate`
reprints all 81 frozen scores unmoved. That is the no-regression half and
nothing more. The corpus *cannot* show the fix — its 606 bare-`host.tld?` and
595 root-relative-`/path?` bodies all sit inside a markdown target or a scheme,
where an earlier rule already removed them, and the human half is length-matched
synthetic filler that quotes no ratios. A frozen corpus is evidence a change
broke nothing; it is never evidence the change did anything.

**So it was measured live, and the honest answer is smaller than the ticket
claimed.** On 2026-08-21, **24,241** real comment bodies through arctic-shift,
**17,282** of them run through two copies of the scoring core differing in
exactly one line — `stripUrls()`, pre- and post-fix:

| sample | bodies | measured |
| --- | --- | --- |
| firehose, 10 subs (movies, AskReddit, nba, soccer, boardgames, anime, books, buildapc, headphones, Coffee) | 4,807 | old vs new |
| firehose, 12 subs (antiwork, jobs, personalfinance, careerguidance, NoStupidQuestions, buildapcsales, techsupport, programming, webdev, pcmasterrace, Cooking, fitness) | 6,891 | old vs new |
| 22 full profiles through the real `fetchAccount`, scored twice | 5,584 | all three axes, old vs new |
| firehose, 12 subs (letterboxd, television, Games, patientgamers, gaming, boxoffice, anime, manga, programming, webdev, sysadmin, DIY) | 6,959 | what the **new** rules remove — the half a diff is blind to |

**8 of 17,282 bodies (0.046%) changed. Every one of them gained text back, none
lost any, and not one of them was a question mark.** All eight are real people
writing numbers:

| account | fragment the old rule ate |
| --- | --- |
| u/Imgema | `2.5/3.5` (drive sizes, in Greek) |
| u/rogue1102 | `1.5A/port` |
| u/Throwaway_LostOW | `5.2k/month` |
| u/NanosoftComputers | `15.8/16GB` |
| u/ScubaAlek | `$44.56/hour` |
| u/Grindhoss | `3.5/5` (a film rating, in three of the eight) |

Read that against the ticket, which was written around `"would you rate it
3.5/10?"`. The review-rating shape is real — u/Grindhoss is it — but the live
population is dominated by **rates and measurements**, and in 17,282 bodies not
one ratio sat next to a `?`. `asks-questions` moved on **0 of 22** accounts and
every axis score is identical old-vs-new on all of them. So the payout this fix
actually collects is through `normalizeWords()` on the **automation** axis,
where the restored tokens go; the question-credit case in the ticket's Benefit
section is correct in mechanism and below what 17k live bodies can resolve.
That is the finding, and it is written down here so nobody re-derives the
ticket's claim from the ticket.

Eight bodies, seven distinct comments: one Grindhoss comment was caught by both
the firehose sweep and its own profile, and is counted in each, because those
are two measurements rather than one.

Two bounds on that, said out loud rather than left in the sample size. **3 of
the 22 profiles** (u/tehluxman 93 comments, u/_justnick 202, u/Different_type7
69) came back `insufficient-data` on `MIN_HISTORY_DAYS`, so 19 carry the
score comparison, not 22. And the firehose is **one sweep on one day** — it says
what people wrote that day, not what they write.

The fourth sample exists because a diff cannot see a body that *both* rules
strip, which is where a new false positive would hide. Across 6,959 bodies **4**
held something the old bare rule would have taken. The new host rule fires on
**2** of them, and both are genuine links — u/blud_13's
`people.aspx?MembershipGroupId=0`, which is exactly the query-without-a-path
shape this fix added, and u/CtrlAltWiz's `github.com/CtrlAltWiz/SiliPuTTY]()`.
The other two are what the old rule ate and this one does not. **The root-relative `/path?a=b` rule fired
zero times in 6,959 bodies.** It is asserted by tests and by JIO-290's original
bot boilerplate, and it is unmeasured in ordinary human text — a rule that has
never fired in the wild is not a rule that has been shown to be safe there.

JIO-290 still holds on the same live data: u/RemindMeBot **0 of 300**,
u/RepostSleuthBot **0 of 300**, u/AutoModerator 38 of 300. The six fragments
above are fixtures in `test/scoring.test.js` as `LIVE_STRIP_URL_CASES`, kept
apart from the hand-built list because they are evidence rather than design —
four of them (`1.5A/port`, `15.8/16GB`, `$44.56/hour`, `2.5/3.5`) are shapes
nobody here would have thought to invent.

**Whose words are in the brackets (JIO-349).** JIO-290's "the link text is the
author's" was right about people and wrong about one kind of bot, and
u/sneakpeekbot spent four days in the gap: **97 of its 299 comments still read
as questions** after the URL strip, on a template that quotes *other people's
post titles*.

```
Here's a sneak peek of /r/Thailand using the [top posts](url) of the year!

\#1: [Is it possible to bring this dog we fell in love with back to the states?](url) | [384 comments](url)
\#2: [I opened another branch of my restaurant. AMA](url) | [336 comments](url)
```

Not one of those question marks belongs to the account printing them. It is
Finding 2's false positive exactly — a template bot taking a third of the
maximum on the one signal that exists to *vouch* for a person — one layer in
from where JIO-290 stopped.

The rule now reads **what surrounds the brackets, not what is inside them**,
one line at a time: remove every `[text](target)` from the line, and if what is
left holds no word of the author's — two or more letters, any script — then
nobody wrote that line, they only listed things. `\#1: … | …` leaves `\#1:  | `
and goes. `hey [does anyone know?](url)` leaves `hey` and stays, which is how
JIO-290's promise survives intact.

Two shapes it is deliberately *not*. Stripping **all** link text fixes the
account outright (32.4% → 1.0%) and reverses that promise, so it is off the
table. A `#N:`-shaped rule would fit one bot's template and nothing else, and
would be the kind of fix that has to be rewritten for the next bot. The
ticket's own suggestion — strip blockquotes — is a **measured no-op**: 0 of
those 299 bodies contain a `>` line at all.

| | before | after |
| --- | --- | --- |
| u/sneakpeekbot `asks-questions` | 97 of 299 (32%) | **0 of 299 (0%)** |
| u/sneakpeekbot authenticity | `low 16` | **`low 3`** |
| u/sneakpeekbot `near-duplicate-bodies` | 28 of 197 (14%) | **196 of 197 (99%)** |
| u/sneakpeekbot automation | `high 69` | **`high 88`** |
| the other 26 frozen accounts, all three axes | — | not one point |

That third row is the part worth sitting with. `normalizeWords()` shares
`stripUrls()`, so the automation axis reads the same text — and the quoted
titles were the **only varying content** in that account's bodies. Removing
them does not merely stop crediting a bot with questions; it uncovers a
template that is 99% self-similar to itself.

That is one account, and the tempting generalisation from it — *text that made
a bot look more human on one axis was making it look less templated on another*
— **is wrong, and an audit measured it wrong.** A signal-level A/B of all 27
frozen profiles finds the other three link-carrying bots moving the *other*
way: u/RepostSleuthBot `near-duplicate-bodies` 185 of 200 → **169**,
u/sub_doesnt_exist_bot 125 of 200 → **117**, u/RemindMeBot 200 → **199**, and
`stock-phrasing` down for three of them too (u/RemindMeBot 299 phrases → 289).
Stripping text usually leaves *less* to be self-similar with; u/sneakpeekbot
inverts that only because the stripped text was the sole varying part of an
otherwise fixed template. No axis score moves on any of the four, which is why
the row above still reads "not one point" — the number was right and the
because-clause was n=1.

**What it costs a person, measured live rather than asserted.** The corpus
cannot answer this: 19 of the 27 frozen profiles carry length-matched
*synthetic* bodies that contain no markdown links, so pointed at `test/corpus/`
the cost is zero by construction. `node scripts/measure-quoted-titles.mjs`
fetches for that reason, and on 2026-08-21 it A/B'd **8,601 real bodies** from
a content-blind sweep of 15 subreddits, then **24 whole accounts (6,652
comments)** drawn at even ranks from that sweep's own author ranking and scored
on all three axes through two copies of the core differing in one line:

| | |
| --- | --- |
| bodies whose stripped text changed at all | 131 of 8,601 (1.52%) |
| bodies that lost a `?` | **2 of 8,601 (0.02%)** |
| the window's question rate | 14.65% → **14.63%** |
| help-seeking hits | 51 → 51 |
| `normalizeWords` tokens | 278,079 → 277,536 (0.20% removed) |
| accounts whose axis score moved | **1 of 24** — u/AutoModerator, authenticity `low 11` → `low 10` |
| band crossings | **0** |
| largest per-account `asks-questions` move | **0.7 points** (the tolerance JIO-290 set is 1–2) |

Three question marks were lost across both arms and all three were hand-read.
Every one is somebody else's text:

| account | what it lost | what it actually is |
| --- | --- | --- |
| u/ElectricMayhem123 | `["How does my comment break Rule 1?"](faq)` | a mod macro's canned FAQ label, alone on its line |
| u/IndependentMacaroon | `>[wtf are they doing?](imgur)` | blockquoted anime screenshot captions — Reddit's own quote marker agreeing with the rule |
| u/Human_Drummer4378 | `[Who Invented the Sandwich? \| HISTORY](url)` | a pasted article headline, cited under the person's own sentence |

**Zero authored questions were lost in 15,253 bodies.** Bounds, out loud: one
sweep on one day, and the profile arm is 24 accounts, not a rate. Escaped
brackets are not a bound but they are a trap: three real corpus titles are
`\[gendered\]`-shaped, and a link-text pattern of `[^\]]*` stops at the first
`\]`, matches nothing, and makes the whole fix a silent no-op on them.

Two costs this rule was known to carry were written down here before anyone had
seen one, and an audit has since gone and looked for both. **The `a) [title](url)`
bound is measured at zero** — across two disjoint live sweeps totalling ~17,000
bodies, **0 of 413** lines the rule killed had any letter at all outside the
brackets, so the shape remains asserted by `test/scoring.test.js` and unseen in
the wild. **The whole-body `[question?](url)` bound is real and costs people
questions**: u/DukeOfGeek's entire comment is `[Dibs?](gif)` (31 → 30 questions
of 300, authenticity 34 → 33) and u/VintageRCFishArtist's is `[this?](youtu.be/…)`
(23 → 22 of 300, no axis moved) — one each in two independent profile arms.
Neither crossed a band. Writing a cost down is how it gets found; leaving it as
"asserted rather than measured" is how it stays a guess.

**And the question you were answering (JIO-349, second half).** The rule above
closed the bot's route in. It left a person's: a block quote of the parent
comment. `>Do you know what an agenda is?` followed by "Yes, that's why I'm
asking what you think mine is here" is one question asked by *somebody else* and
answered by this account, and `asks-questions` scored the reply for it.

The strip that fixes it is not new and was never in dispute — `normalizeWords()`
has dropped `^>` and `^&gt;` lines since it was written, so the **automation**
axis had always read a quote as somebody else's words. It simply lived one call
too late for `stripUrls()`, and therefore for `asks-questions`, to see it. The
two axes disagreed about who said what for as long as both existed, and the
signal's own docstring claimed they could not. Moving one `.replace()` up a call
makes that sentence true.

The corpus cannot show this either — 6 of 7,469 frozen bodies carry a `>` line —
so it was A/B'd live the same way, **17,177 bodies over 15 subreddits** and
**24 whole accounts (6,133 comments)** drawn at even ranks from that sweep's own
author ranking, against a core with *both* JIO-349 rules reverted — the ticket's
tolerance is about the ticket, so the arm reverts the ticket, and every lost `?`
is then re-tested against a quote-strip-only core so the two rules can be told
apart:

| | |
| --- | --- |
| bodies carrying a `>` line at all | 283 of 17,177 (1.65%) |
| bodies whose stripped text changed | 563 of 17,177 (3.28%) |
| bodies that lost a `?` | 51 of 17,177 — **2.00% of every question counted** |
| …attributed: the quote strip / the link-text rule | **47** / 4 |
| the window's question rate | 14.88% → **14.58%**, i.e. **0.30 points** |
| help-seeking hits | 97 → 93 |
| `normalizeWords` tokens | 547,016 → 545,860 (0.21%) — **all of it the link rule**; the quote move removes exactly zero, because the before arm still carries `normalizeWords()`'s own copy of that strip |
| accounts whose axis score moved | **2 of 24** (2 more were `insufficient-data`) |
| band crossings | **0** |
| largest per-account `asks-questions` move | **2.0 points** — the top of the 1–2 tolerance, not inside it with room |

**24 lost question marks were hand-read across seven accounts, and 23 are
somebody else's.** The largest mover is the one to read: u/notthegoatseguy loses
6 of 59, five of them pasted Reddit help-article titles
(`[What is karma? – Reddit Help](url)`, alone on a line) and one a textbook
quote-and-answer — a person who links documentation and answers other people's
questions, scored for six questions they did not ask. u/AftyOfTheUK loses 10,
every one a `>quoted question` answered in flat declaratives. The single
exception is u/VintageRCFishArtist's `[this?](url)` above, which is the
link-rule bound, not this one.

That 2.0 is the number to be uncomfortable with and it is stated rather than
rounded off. It sits at the top of the tolerance JIO-290 set, and it is a *fix*
rather than a *cost* — every question behind it was hand-read and six of six
belong to somebody else. A tolerance is a bound on how much a change may move a
person's score, not a promise it will not; when the move is this big the
hand-read is the deliverable, not the table.

Bounds on this half, out loud. The pattern is anchored hard at column 0 and was
kept **character-for-character** as `normalizeWords()` had it, so that moving it
could not move the automation axis. That is checked rather than assumed:
`normalizeWords()` is **byte-identical on all 7,469 frozen bodies** against a
core carrying the old arrangement, which is the whole reason the move is safe —
and it is also why **a quote indented by a space is not seen**.
Widening it is a change to automation, not to this signal, and belongs to
whoever measures that. Two of the 24 profiles were `insufficient-data`, so 22
carry the score comparison; one sweep, one day; and 51 lost question marks were
found but 24 hand-read — the seven accounts read are the ones that moved most,
which is the worst case and not a sample.

**A confident zero from a window no gap could fit in.** `dormancy-revival`
(weight 3, the heaviest agenda signal) gated only on item *count*. 299 comments
spanning 0.0 days clear that easily, and it then reported "longest silence is 0
days, below the 120-day threshold" — arithmetically the only sentence available,
presented as a finding. Across the 25 accounts in `EVALUATION.md` it returned a
clean `low` 25 times and `insufficient-data` never, so a weight-3 signal was a
near-constant zero diluting every other agenda signal. It now measures the span
of the reliable window first and returns `unmeasured()` below
`MIN_DORMANCY_GAP_DAYS`, the way `posting-hour-dead-zone` has always gated on
`MIN_SPAN_DAYS_FOR_HOUR_PROFILE`.

The gate is on the **span alone, deliberately not on `coverage.truncated`**. A
complete nine-day history cannot hold a 120-day silence either, so gating on
truncation would have left the bug live for precisely the young accounts this
axis gets pointed at — and a young account looking clean on the heaviest agenda
signal is the failure mode worth caring about. There is a test for the complete
case specifically, so nobody narrows it back.

## The agenda axis banded a hobbyist, and shape was all it had

The section above is four false positives found by pointing the thing at live
accounts. This is a fifth, found by *freezing* two of them: when JIO-344 put
u/humdingler and u/chilidirigible into `test/corpus/` to answer a question
about posting rate, they arrived wearing an agenda badge nobody had asked
about. **Both scored agenda `moderate` — 55 and 57 — where all 17 thread humans
were `low` (0–19).** A reaction-GIF poster in r/Superstonk and a fifteen-year
r/anime regular, told they might be pushing something.

The whole of it came from two signals, and `scripts/measure-agenda-shape.mjs`
ranks the frozen corpus on both (no network — the corpus is JSON and
`scoreAgenda` is pure):

* **Single-subject focus ranks the corpus backwards against its only ground
  truth.** Seven of the eight declared bots hold the bottom seven places at
  2–7% top-group share, the eighth reaches 16%, and 16 of the 19 humans beat
  it. The only two accounts in the corpus this signal scores above `low` are
  the two hobbyists, at 77% and 97%. Of course: a utility bot serves the whole
  site, and u/AutoModerator posts in 307 groups against u/chilidirigible's 6.
* **Posts and leaves separates nothing.** Bots span 0–91%, people 3–87%, and
  the signal's own window floor of 0.35 sits *at the median thread human* of
  0.36. u/Hartacus — an ordinary r/politics commenter — reads **87%, the same
  as u/chilidirigible**. What separated the two was the other signal alone: 38
  groups against 6.

So the axis was banding people on their volume and their choice of subreddit,
while `stock-phrasing` measured a real **zero** for both and `dormancy-revival`
could not see a 120-day gap inside their 2- and 4-day windows. That is the
axis's most consequential false positive and it was not hypothetical: it was
the badge those two accounts were wearing.

**The fix is not a threshold, deliberately.** There is no separating value to
move one to: the bots are already *below* every account Single-subject focus
fires on, so a threshold that separated the two populations would have to fire
on low concentration — it would have to run backwards. `agenda.js` has said since it was written that
"none of these signals is damning alone — a hobbyist is topic-concentrated" and
that they are "weighted to be read together". A weighted mean does not read
anything together, so `holdShapeToCorroboration()` makes that sentence
executable: **a shape signal may argue as hard as the strongest measured
`stock-phrasing` or `dormancy-revival` beside it, and no harder**, floored at
the `moderate` band edge so it can always take the axis to the edge of an
accusation on its own and never past it. Both accounts read `low 19` now, four
thread humans move down within `low`, and **not one bot moves by a point** —
every one of the eight reads `high` on stock phrasing, so nothing of theirs is
held.

**It is graded rather than a gate, and that is the load-bearing half.** An
on/off rule at the same edge would have taken u/chilidirigible from agenda 30
to **68** on a stock-phrasing strength moving 0.29 to 0.31 — and two of the 17
thread humans sit within 0.11 of that line on their real bodies, at 0.37 and
0.40. A cliff that steep standing next to real accounts is a false positive
waiting for the next re-capture, so there is a test that walks a hobbyist's
phrasing coverage from 0% to 20% and fails if any step moves the score by more
than 12 points.

**Strongest, not weakest — and until recently nothing could tell.** Holding
shape to the *weakest* measured corroborator rather than the strongest passed
the whole suite and `npm run evaluate`: no account in the corpus and no other
fixture had both corroborators measured with one of them strong, so `max` was
unpinned prose. The second propagandist fixture is exactly that shape — a
talking point recurring across threads beside a `dormancy-revival` measured at
**zero** over a 300-day span. A `min` there holds a real propagandist to the
band edge on the strength of evidence it does *not* have, which is this rule
inverted; the test fails on it now.

**Every hold says so on the account being judged**, in the evidence string, on
screen: the measurement it made, which signal beside it set the ceiling and
what that signal reads — or that nothing beside it reads above low, and that
one of the two could not be measured at all — and that it was therefore held. A
discount applied silently is one nobody can argue with. That last clause is the
case both live accounts were actually in: captured over 2- and 4-day windows,
neither could be measured for dormancy at all, and *we did not look* must not
render as *we looked and found nothing*. It had no test until now — dropping
the filter that produces it passed the whole suite and `evaluate`, because
`Math.max` swallows the unmeasured `null` and no score moves.

**Two bounds on it, stated because they are not obvious.** First, nothing
committed to this repository exercises the corroborated path on a real person —
all 19 human profiles carry synthetic bodies, so their stock phrasing is not
the live account's, and only the two propagandist fixtures in
`test/scoring.test.js` take the un-held branch. That gap is why the real bodies
were solved for rather than assumed: `manifest.json` records each human's
agenda score on both profiles, bodies feed stock phrasing and nothing else on
this axis, so the difference *is* that signal. Both hobbyists come out held on their real bodies
too — 63 → 25 and 55 → 19. A live re-fetch of ten accounts on 2026-08-21
confirmed all three: 55 → `low` 19 and 64 → `low` 26 for the two hobbyists,
u/bigbjarne un-held at a live stock phrasing of 0.45 — the first real account
to take the corroborated branch — and the three bots in it unmoved. That run
was a hand check and is **not** reproducible from this repo: the committed
script is offline on purpose, and a re-fetch today returns a different window.

Second, and this is the honest limit: **the rule protects an account whose
phrasing and dormancy both read low, and nothing else.** Two of the seventeen
ordinary humans clear the corroboration floor on their own real text, at 0.37
and 0.40. A hobbyist with a catchphrase gets nothing from this fix.

And the thing this cannot say at all: whether either signal fires on an actual
agenda account. The eight bots in the corpus are *utility* bots; there is no
population of accounts known to be paid, and `EVALUATION.md` has recorded from
the start that one cannot easily be obtained. An axis made harder to fire is
not thereby an axis that fires correctly.

## Volume bought immunity from the strongest check

The section above is four false positives. This is the opposite failure and it
had been sitting in `EVALUATION.md` as Finding 4 since the live run: **seven of
eight unmistakable bots topped out at `moderate` on automation.** Not a wrong
answer — the bands still separated — but a reader who takes `moderate` as
"probably fine" gets the easiest case on the platform wrong.

The first of its three causes is the one this section is about, and it is
structural rather than a bug: **`posting-hour-dead-zone` is unavailable exactly
where automation is highest.** It is the heaviest signal in the axis (weight 3)
and it needs a 3-day span, for the very good reason two sections up — a sleep
cycle is a claim about days, and 299 comments spanning an hour manufacture a
17-hour "sleep gap" out of nothing but our own fetch window. But the more
prolific the account, the shorter the window its per-lookup limit covers, so
the guard fires hardest on the loudest bots. In `test/corpus/`, five of the
eight reach it: u/AutoModerator's reliable window is 297 items spanning **82
seconds**, u/RemindMeBot's is 10.4 hours. Being fast enough is a way to buy
your way out of the strongest check there is.

Weakening `MIN_SPAN_DAYS_FOR_HOUR_PROFILE` is not the fix. It is a fix, for a
false positive that was live. So `sustained-posting-rate` (weight 2) fills that
window instead, and the reason it *can* is the whole of why this section
exists:

**Throughput survives truncation; a schedule does not.** An hour histogram
built from 82 seconds is measuring our pagination — the account did not choose
to be silent in the other 23 hours, we simply never asked. A *rate* built from
the same 82 seconds is a ratio of two things we genuinely observed. 297 items
in 82 seconds is a fact about the account no matter how much older history we
failed to fetch, and no amount of missing history can make it smaller. That
asymmetry is why one signal has to gate on days and the other does not, and it
is the sentence to reread before anyone "harmonises" the two guards.

Three things about it are load-bearing.

**It is one-directional: an ordinary rate is `unmeasured`, never a low score.**
Below `ORDINARY_ITEMS_PER_HOUR` the signal reports nothing at all, and its
evidence string says in as many words that this is not a clean result. Everyone
on the platform posts at an ordinary rate; scoring that as a measured zero
would hand a free vote-for-a-person to every patient bot in the world in
exchange for a signal that only ever fires on the loud ones. The measured range
therefore starts at 0.5 rather than 0, because a strength under 0.25 reads as
`direction: 'lowers'` in `axis.js` and would drag the average down — which is
precisely the vote this signal is not allowed to cast.

**The gate is where throughput becomes worth weighing — it is NOT a ceiling on
people, and there is no gap for it to sit in.** 3 items/hour is 72 a day
sustained across the entire retrieved window, nights included. This section
used to argue the number from a gap: the frozen humans top out at 0.92/h and
the five bots run 5.5–13,039/h, so put the gate between them. That gap was an
artifact of a corpus with no prolific human in it, and going and looking
destroyed it (EVALUATION.md Finding 4a). A content-blind sweep of 22
subreddits found seven accounts above the gate and **six of the seven hand-read
as people**, the fastest of them at **5.90/h — above u/RemindMeBot's 5.5/h**.
The populations overlap. No value of `ORDINARY_ITEMS_PER_HOUR` separates them:
raising it to 6 silences RemindMeBot and still measures the human.

**So what protects a prolific person is the shape of this signal, not the
position of its gate**, and that is the sentence to keep. One-directional, so
an ordinary rate is `unmeasured` and never a vote either way. Floored at
`RATE_FLOOR_STRENGTH = 0.5`, so the measured range starts at neutral. Log-scaled
to `SATURATED_ITEMS_PER_HOUR`, so the distance from 3/h to 300/h is what the
strength is spent on rather than the distance from 3/h to 6/h. And weight 2 of
15.5. Put together, the 5.90/h human earns strength **0.573** — 0.073 above
neutral — and scores automation `low 16`. u/humdingler (5.90/h, `low 16`) and
u/chilidirigible (3.42/h, `low 29`) are frozen in `test/corpus/` and
`test/corpus.test.js` asserts both halves of that: that they still clear the
gate, and that they are still `low`. A claim about shape is exactly the kind
that keeps sounding true after it stops being true, so it is pinned to two real
people rather than left in this paragraph.

Moving the threshold is therefore not the lever it looks like. It cannot buy
separation that does not exist, and the two errors it trades between still do
not cost the same: a missed bot is a `moderate` band instead of a `high` one,
and a caught human is a false accusation.

**The 82-second window is what fixes the minimum-span guard at 60 seconds, and
the arithmetic is not close.** Before this signal the five bots measured 10.5
of the axis's 13.5 weight, with only the hour profile missing. Both remaining
signals invert on reply-bots, and both have since gone: JIO-345 took
`conversation-depth` to unmeasured for those five and JIO-346 has now taken
`interval-regularity` at the pole where it inverts — which is 7.0/13.5 = 0.519,
one signal above `MIN_MEASURED_WEIGHT_FRACTION`. Add
this signal and have it *fire*: 9.0/15.5 = 0.581, and the axis still reports.
Add it and have it stay silent — which any minimum span of an hour or more
would do to AutoModerator — and it is 7.0/15.5 = **0.452**, below the gate.
That is strictly worse than never adding the signal at all: the loudest bot on
Reddit would come back `insufficient-data`. A guard that looks merely cautious
can invert the thing it is guarding, so 60 seconds is there only to stop a
degenerate window dividing by zero, and the real guard is on item count
(`MIN_ITEMS_FOR_RATE = 30`) where "sustained" actually lives.

It is deliberately not a duplicate of the two signals it sits next to.
`cross-thread-bursts` wants a run inside 120 seconds and says nothing about the
other 23 hours; this is the average over the whole window and is diluted by
every quiet stretch in it — an account that drains a queue once a day scores
there and not here. `interval-regularity` is a coefficient of variation, which
is unitless on purpose and reports only whether a rhythm is *mechanical*, so a
summon-driven bot posting as irregularly as the humans summoning it is now
`unmeasured` there (JIO-346) rather than scored clean. This asks the question CV
deliberately refuses, and asks it of a window CV has to give up on: not how
evenly, but how much.

**What it moved, and what it did not.** Against the frozen corpus, six scores
changed and **every one of them is a bot**: AutoModerator `moderate 63 -> high
69`, RemindMeBot 62 → 64, sneakpeekbot 47 → 50, Anti-ThisBot-IB 35 → 39, and —
because a weighted average works in both directions — RepostSleuthBot 76 → 75
and sub_doesnt_exist_bot 53 → 52. Not one of the 17 thread humans moved by a
single point, because for all 17 the signal is unmeasured. The bot floor rose
from 35 to 39 and their ceiling stayed at 17.

That was measured before the corpus had a prolific human in it, and admitting
two narrowed the margin it describes: **the human ceiling on automation is now
25, not 17** (u/chilidirigible, 3.42/h), against a bot floor of 39. The bands
still do not overlap and the separation invariant still holds, but 14 points of
gap is the honest number and 22 was the number a thread sample happened to
produce. (JIO-345 has since taken that floor to 44 and the gap to 19 without
moving a human, and JIO-346 then took it to 54 — and unlike JIO-345 it *did*
move the ceiling, from 25 to **29**, so the gap in force is 25 points against a
ceiling four points nearer the band edge. Both are sections below.) Each cohort
is printed as its own row by `npm run evaluate` so that one can never quietly
widen the other.

**What it measures that you might not expect it to**, stated because this
started life as a bound nobody had checked. A person who genuinely sustains
more than 3 items an hour across a truncated window — 300 comments inside a
four-day argument — *is* measured here. The old text said so and added that the
corpus held no such human to check it against, which made it an honest bound
and an unfalsifiable one: `test/corpus/`'s 17 humans are the authors of one
r/politics thread and are ordinary-volume commenters by construction, so no
re-run of it could ever produce the counter-example.

**THAT BOUND FIRED — see EVALUATION.md, Finding 4a.** `node
scripts/probe-prolific-humans.mjs` went and looked: 22 subreddits, ~23,000
comments, 16,264 distinct authors ranked before anything was fetched. Seven of
the top 48 cleared the gate and six hand-read as people. They are not rare
freaks — they are a GIF poster in r/Superstonk, a fifteen-year r/anime regular,
a baseball fan in September. Two of them are now in `test/corpus/` as the
`prolific-probe` cohort, and `npm run evaluate` prints their rate and their
band on every run.

The `sustained` framing is the mitigation and it is not a proof: one furious
evening is diluted by the rest of the window, and 30 items is the floor below
which the signal refuses to call anything a rate.

**The residue that is still real, and it has a name and a number.** At 3.42/h
u/chilidirigible scores automation `low 29` — well above the 20 the thread
humans top out at, mostly on `posting-hour-dead-zone`, which for once *does*
measure them (a 3.7-day window, and a long-running r/anime regular with no
6-hour quiet stretch in it). That was `low 25` until JIO-346 took
`interval-regularity` to unmeasured above CV 1.0; **half of JIO-329's premise
has now landed, and this account absorbed 4 of its points.** Recomputed from
the frozen profile with the other half applied — `conversation-depth` going
unmeasured for ordinary repliers too — they come out **`moderate 32`, and
without this signal `low 28`**, which are the same two numbers this section
projected before either change landed. So this signal supplies the 4 points
that cross the band, and JIO-329 supplies the rest by removing measured
near-zeros from a weighted average. It was written down before any of it landed
rather than found afterwards, and u/chilidirigible is in the corpus precisely
so that `npm run evaluate` fails on the day it happens instead of printing
`OK` — which it did, on 2026-08-21, twice. (Those two projections are not
reproducible from the public verdict — `axis.js` publishes `band` and not
`strength` by design — so they were computed on an instrumented copy of
`stripInternal`. EVALUATION.md Finding 4a measured 33/29 for the same account
against its live 2026-08-20 window; 32/28 is the frozen 2026-08-21 one, and it
reproduced unchanged after JIO-346 spent 2 of the 3.5 weight.)

**"A cost of the two changes together" was the wrong reading, and the sentence
that said so is gone.** It was true of u/chilidirigible and it does not
generalise, which the whole-ranking sweep in **EVALUATION.md Finding 4b** then
showed: of the seven live accounts that cross under JIO-329, **five cross with
this signal `unmeasured`**, at 0.01 to 2.26 items an hour. Two of them have no
measured evidence of automation whatsoever beyond `posting-hour-dead-zone` and
land on exactly 30. So this signal is not a co-author of JIO-329's cost — it
was simply the only lens available on the day, because the only prolific human
then in the corpus was one it happened to measure.

**What that sweep established, and it belongs here rather than only there.**
JIO-329 removes 3.5 of 15.5 weight, so for an ordinary profile at the measured
weight of 13.5 that was common **when the sweep ran** it multiplies the
automation score by 13.5/10 = **1.35** — and a multiplier on the score is a
divisor on the band edge. `moderate` stops beginning at 30 and begins at
**22.2**. Measured against 124 live accounts, every single one scoring 22–29
then crossed and nothing at 21 or below did.

**Read those numbers against the scale of the day they were taken, because 2 of
the 3.5 has since landed.** JIO-346 (below) took `interval-regularity` to
`unmeasured` for very nearly everybody, so the common human measured weight is
now **11.5**, not 13.5 — 15 of the 19 frozen humans, and every ordinary account
in the live arm. 22.2 is the *destination* of all 3.5 of weight, not the edge in
force now: today's effective edge is about **25.6** for that shape, and JIO-329's
remaining 1.5 (`conversation-depth` for ordinary repliers) is what carries it
the rest of the way to 22.2. EVALUATION.md Finding 4e prices that half against
the new baseline.

The lever the band-edge figure is sensitive to is `MIN_MEASURED_WEIGHT_FRACTION`
and the weights themselves, **not** `ORDINARY_ITEMS_PER_HOUR` and not the band
edge — moving `moderate` to 35 would still leave two of the seven above it and
would silently re-band the other two axes, which have nothing to do with any of
this.

## Replying to everyone is not evidence of a person

The section above is one of the three reasons EVALUATION.md's Finding 4 gave
for seven of eight declared bots topping out at `moderate`. This is another of
them, and it is the one where the tool was not merely blind but **actively
wrong**.

`conversation-depth` scored `1 - rescale(replyShare, 0.02, 0.3)`. Never
replying to another commenter reads as broadcasting rather than talking, which
is true and is the half of the signal that works. But the arithmetic ran both
ways, so a reply share above 30% earned **strength 0** — the strongest vote for
humanity this axis can cast, at the signal's full weight. **u/RemindMeBot
replies to a summoning commenter 299 times out of 299 and does nothing else at
all, and was cleared by the exact mechanism that makes it a bot.** JIO-405
measured the same thing from the other side and found the two populations
identical here: the signal reads **0.000 for ordinary people AND 0.000 for
u/RemindMeBot**.

**The whole separation is three comments, which is what decides the shape of
the fix.** Measured over the frozen corpus by `node
scripts/measure-reply-share.mjs` (no network — it reads `test/corpus/` and
nothing else): the five summon-bots sit at exactly 100.0% replies, and the 19
humans run from u/Hartacus at 40.0% up to u/MundaneFacts at **99.0%**. That is
3 top-level comments in 300 standing between a person and every reply-bot in
the corpus. A percentile drawn off 19 human data points at a margin that thin
would not survive the twentieth human, so there is no threshold to pick.

**So the cut is a fact about the window rather than a number.** An account with
**no top-level comment anywhere in its retrieved history** returns
`unmeasured()` — axis.js rule 3, applied to a *pole* of a measurement rather
than to a sample that was too thin. Every human in the corpus clears it; the
thinnest clears it by three comments and the rest by ten or more. The broadcast
pole is untouched and still separates: u/AmputatorBot (21.7% replies),
u/AutoModerator (8.4%) and u/RepostSleuthBot (8.0%) all sit below every human
in the corpus and are read exactly as before.

**What it moved.** Five of the 81 frozen scores, every one a bot, every one
upward: u/RemindMeBot `moderate 64 → high 73`, u/sub_doesnt_exist_bot 52 → 58,
u/same_subreddit_bot 51 → 57, u/sneakpeekbot 50 → 57, u/Anti-ThisBot-IB 39 →
44. Not one human moved by a point, because all 19 have top-level comments and
for all 19 the signal is measured exactly as it was. The bot floor rose from 39
to 44 against an unchanged human ceiling of 25, so the gap widened from 14
points to 19, and Finding 4's "seven of eight top out at `moderate`" became
five of eight. (JIO-346, the section below, then took it to two of eight — and
moved the human ceiling, which this change did not.)

**A bound that was checked rather than assumed:** taking 1.5 of weight away
from the five loudest bots could have pushed them under
`MIN_MEASURED_WEIGHT_FRACTION` and turned the fix into an `insufficient-data`
verdict for exactly the accounts it was aimed at — the failure mode the
82-second window produced above. It does not. The worst case is 11.0/15.5 =
**0.710**, which is 3.25 of weight clear of the gate.

**Two limits, stated here because neither is visible in a passing suite.**

A reply-bot that drops a single top-level comment in 300 escapes this cut and
still collects its zero. Closing that needs a threshold inside the
three-comment margin, next to a real account, and nothing in this corpus can
justify one. `test/scoring.test.js` asserts the escape as well as the catch, so
it stays a stated bound rather than something found later.

And **the discount below the cut is untouched.** An ordinary reply rate still
votes for a person at full weight, and all 19 frozen humans still band `low` on
this signal. Withdrawing *that* is JIO-329 — 3.5 of 15.5 weight, together with
`interval-regularity` — and all 3.5 of it moves the `moderate` band edge from 30
to 22.2 for every account on the platform, at a measured cost on real people
that this change deliberately does not pay. (**2 of that 3.5 has now landed**,
in JIO-346 two sections down: the edge is already at roughly 25.6 for the common
shape, and it is `conversation-depth`'s remaining 1.5 that would take it to
22.2.) The two are separable and this one is the half that costs nobody a band.
The section below is the other signal in that pair, gated the same way and on
the same day, and it is **not** free: it moved the human ceiling four points.

## An uneven cadence is not evidence of a person

The last of Finding 4's three reasons, closed on the same day as the one above
and in the same shape — and unlike that one, **this one cost real people
points.**

`interval-regularity` scored `1 - rescale(cv, 0.15, 1.0)`. A cadence too even
to be anyone's day is a scheduler, which is true and is the half of the signal
that works. But `rescale` **clamps at its ceiling**, so every account from CV
1.0 upward earned **strength exactly 0.000** — the strongest vote for humanity
this axis can cast, at weight 2 — and the badge told them *"that is the
irregular, clumpy spacing typical of a person"*.

**A summon-driven bot does not own its own rhythm.** u/RemindMeBot posts when
people ask it to, so its irregularity is its users' irregularity, and the tool
was reading demand for the account as evidence about the account. Everything
that arrives on human demand was actively discounted for arriving on human
demand.

**The number to look at is how many accounts scored the same.** `node
scripts/measure-interval-cv.mjs` (no network — `test/corpus/` and nothing
else): **26 of the 27 frozen accounts sit at or above CV 1.0**, all 19 humans
(1.53 to 5.29) and seven of the eight declared bots (1.08 to 16.09), and every
one of them scored 0.000. The live arm is starker — re-run against the
whole-ranking sweep of ten busy subreddits harvested for EVALUATION.md Finding
4b, **all 77 scored accounts returned strength exactly 0.000**. Not 77
near-zeros; one constant, 77 times. A signal that returns the same number for a
content-blind sample of a live platform is not a weak signal, it is an unread
one.

**So the gate is the ceiling of the existing scale, not a number picked next to
a population.** At or above CV 1.0 the signal returns `unmeasured()` — axis.js
rule 3 again, applied to a *pole*. Finding 4d had to reason its way to a
categorical cut because its margin was three comments wide; here the arithmetic
had already chosen, because 1.0 is where `rescale` stopped varying. Below it
nothing changes: the strength still climbs to a full-weight 1.0 at CV 0.15, and
u/sub_doesnt_exist_bot (CV 0.94) is the one frozen account still measured.

**The alternative, and why it was not built.** The other option on the ticket
was to measure **response latency** — parent comment to this account's reply —
which is a rhythm the account genuinely does own. It was probed live rather
than assumed: `/api/comments/ids?ids=` returns `created_utc` 120 ids at a time
and all 299 of u/RemindMeBot's parents are comments, so it is buildable. It
needs a new `AccountProfile` field, a second fetch pass in `arcticShift.js` and
a re-capture of all 27 frozen profiles before `npm run evaluate` could measure
it — and PLATFORMS.md's contiguity rule forbids feeding this signal family from
a payload whose contiguity cannot be proven, which parent timestamps fetched by
id lookup cannot. That is a ticket of its own if it is ever worth one.

**What it moved.** 17 of the 81 frozen scores. Seven bots: u/RemindMeBot `high
73 → 89`, u/RepostSleuthBot `high 75 → 89`, u/AutoModerator `high 69 → 82`,
u/AmputatorBot `moderate 60 → high 71`, u/same_subreddit_bot and u/sneakpeekbot
both `moderate 57 → high 69`, u/Anti-ThisBot-IB `moderate 44 → 54`. Three of
those cross a band, the bot floor rises from 44 to 54, and Finding 4's "seven of
eight top out at `moderate`" becomes **two of eight**. The worst
measured-weight case is 9.0/15.5 = **0.581**, still 1.25 of weight clear of
`MIN_MEASURED_WEIGHT_FRACTION`, so no bot was gated into `insufficient-data` by
its own fix.

**And ten humans, which is the part that is not free.** They move +1 to +4 and
in the frozen corpus all stay `low`, but **u/chilidirigible's ceiling went
25 → 29, one point under the band edge.** That is not an accident of one
profile: removing 2 of 15.5 weight multiplies an ordinary score by `mw/(mw−2)`,
and a multiplier on the score is a divisor on the band edge. **That edge is
shape-dependent, not universal.** `30×(mw_pre−2)/mw_pre` across the 19 corpus
humans as they measure live: **25.2** at a pre-cut weight of 12.5 (three of
them), **25.6** at 13.5 (fifteen — the common shape), **26.1** at 15.5, which is
u/chilidirigible's own all-eight-signals shape and so the figure that actually
governs this account. Thinner profiles fall further — 24.5 at 11, the shape
three of the eight bots have. Quote 25.6 as the typical edge, not as the edge.

**And one human did cross — live, on the day this landed.** All 19 corpus humans
were re-fetched 2026-08-21 through the shipped `fetchAccount`
(`node scripts/measure-interval-crossing.mjs --all-humans`). One crossed:
**u/chilidirigible scores automation `moderate 30`** today, where reconstructing
`interval-regularity` at the clamped 0.000 it used to earn at weight 2 puts the
same fetch at **`low 26`** before the change — bracketed 25.69–26.56 across the
rounding, so the band is robust to it, and reproduced across four independent
fetches. So "nobody in the corpus was standing in the 26–29 strip" and "none of
the 77 live accounts crossed" are both true and **neither is the whole story**:
`test/corpus/` was captured 2026-08-18 and this account drifted a point in three
days, and the 77-account sweep's before-scores top out at 24 with
u/chilidirigible not in that arm at all.

**One of nineteen, and the other eighteen are not close** — the runner-up
(u/Hartacus, `low 23`) is seven points short. The strip is populated, not
crowded. But two zero-crossing samples were never evidence that it was empty,
and the account found standing in it is the same one both of those sentences
name as the human ceiling.

**Which makes the corpus load-bearing in a way worth saying out loud.** `npm run
evaluate` gates its exit code on `no human above low, no bot at low`; against a
corpus re-captured today it would print `BROKEN`, name u/chilidirigible and exit
1. The separation holds *of a 2026-08-18 snapshot*, at the boundary, on one
point of drift — not comfortably. EVALUATION.md Finding 4e carries the full
measurement and the re-capture question, which is George's call and not one to
settle inside this change. The band-edge arithmetic is still the durable half,
and it says this change spent most of the human cost JIO-329 was priced for.

**Two bounds, stated because neither is visible in a passing suite.**

This signal now says **nothing at all** about 26 of the 27 frozen accounts — 2
of the axis's 15.5 weight going quiet for very nearly everybody. That is a real
loss of coverage, not a free fix. It is also the honest reading of what was
already there, because those 26 scores were the same 0.000 whatever the account
was.

And **a scheduler that jitters past CV 1.0 buys exactly the silence a person
gets.** It is not a new hole — it collected a confident vote for its humanity
before, which was worse — but this does not close it, and no population
available to this repo holds an adversarial bot to check against.
`test/scoring.test.js` asserts both sides of the gate, so the escape stays a
stated bound rather than something found later.

## Running everywhere is not a range of interests

Finding 4's last paragraph, and the one that lands on the axis that exists to
**vouch** for people rather than to suspect them.

`topical-breadth` scored `0.5 × how much sits outside the largest group + 0.5 ×
rescale(distinct groups, 2, 15)`, and both halves saturate on sitewide
automation. u/AutoModerator answers in **307 subreddits** with 98% of itself
outside the largest, so it took a flat **1.000** — the largest vouch this signal
can award anybody — and its badge said *range of interests*. The second half is
not merely saturated but inverted: share outside the largest group runs 0.84–0.98
for the corpus bots against 0.03–0.87 for its humans. **Being everywhere is the
job.**

**The ticket named two accounts. The measurement said all eight.** JIO-347 was
filed off u/AutoModerator (333 subreddits, live) and u/RemindMeBot (175); `node
scripts/measure-topical-breadth.mjs` (no network — `test/corpus/` and nothing
else) reads `high` here for **every declared bot in the corpus**, none of which
had been re-checked because the ticket did not name them.

**The discriminator is items per group.** In the corpus every bot sits at
**1.24–2.06** — they visit, they never return — and every human at
**3.08–66.7**. So the signal is now `reach × depth`, with
`depth = rescale(items per group, 1, 3)`. Neither end of that is a number picked
next to a population: **1.0 is the arithmetic minimum of the measure** (one item
in every group, reach with no depth anywhere), and **3 is a return visit rather
than a drive-by**.

**The gap is about half what those 27 accounts said, and that is worth knowing
before anyone moves the constant.** A content-blind live sweep of 42 scorable
accounts on 2026-08-21 — the Auditor's, ranked before a profile was fetched —
put the human tail at **2.53** rather than 3.08, with 6 of the 42 within 20% of
the edge. Real headroom above the busiest corpus bot is **0.47, not 1.02**. The
cut still lands where it was aimed and the two humans past the edge lose 5.9 and
4.8 authenticity points **without changing band**, but "nobody is standing in the
gap" was a statement about 19 people. The constant rests on its derivation, not
on that margin.

**And below 45 grouped items the taper is withheld entirely**, because that is
where it stops measuring the account and starts measuring its size. The same
sweep found a 25-item person in 19 groups — 1.32 items each, automation `low 0`,
stream not truncated — reading the *same breadth band as u/AutoModerator* and
falling `moderate 33 → low 12` for it. 45 is `15 groups × 3 items`, the two
constants already in the signal: it is the smallest history in which an account
can satisfy both halves at once, and under it every item spent widening the
reach is one unavailable to deepen it. The gate costs the fix nothing — the
smallest declared bot in the corpus carries **299** grouped items, 6.6× the gate
— and because withholding a discount is generous, the evidence string names it
the same way it names the discount.

The obvious rival was rejected on its own number. The share of an account's
groups holding exactly one item *does* separate these populations — by
**0.0023**, u/humdingler at 0.6667 against u/RepostSleuthBot at 0.6689. A cut
there is fitted to the third decimal place of one person.

**And this one is a taper, not an `unmeasured()`, unlike the two sections above
it.** Both of those closed an inverting signal by declining to score its bad
pole. Here that same fix makes the defect *worse*: `buildAxis` averages over
measured weight only, so dropping a signal redistributes its weight — a penalty
on a suspicion axis and a **gift** on a vouching one. Going `unmeasured()` would
have raised all eight bots' authenticity scores. A signal that has read "reach
without depth" has measured something and must score it low rather than look
away, and the evidence string names the discount out loud: *"That is 1.29 items
per group — reach without depth … so the breadth credit is cut to 14% of what
the reach alone would score."*

**A discount is a discount; only the floor of the measure is a description.**
That sentence was written for u/AutoModerator at 1.29, and the live sweep put
two hand-read people inside the taper at 2.53 and 2.61, docked about 20%. Being
told your account "looks like running sitewide" is an accusation this axis says
outright that it does not make, so past **2 items per group** — where the
average group stops being a single visit — the wording is a plain discount
instead: *"the account does go back to what it touches, but short of the 3 that
reads as a return rather than a look around."* Same arithmetic, and
`test/scoring.test.js` pins the split, because the sentence is the part a real
person actually reads.

**What it moved.** 8 of the 81 frozen scores, every one a bot going down:
u/AmputatorBot `low 25 → 3`, u/RemindMeBot `25 → 5`, u/same_subreddit_bot
`25 → 6`, u/AutoModerator `low 29 → 8`, u/RepostSleuthBot `25 → 13`,
u/Anti-ThisBot-IB `moderate 32 → low 15`, u/sneakpeekbot `moderate 38 → low 16`,
u/sub_doesnt_exist_bot `moderate 38 → low 17`. Three cross a band, the bots'
authenticity cell becomes `low ×8` (3–17) against thread humans at 38–81, and
**not one human moved a point in either direction** — every frozen human's taper
is exactly 1.00. Live, two of 42 are tapered and neither changes band.

**Three bounds, stated because a passing suite shows none of them.**

A genuine *broad* account — 200 comments across 150 different groups — still
scores near zero here, and the gate does not help it: 45 items buys room for a
thin history, not a wide one. That is a real cost, accepted deliberately: one
comment in each of a hundred groups is the same *shape* as the adversary, and
`low` on this axis means no positive evidence was found rather than that
anything was found. The other four authenticity signals are untouched and still
speak for that account, and the live sweep priced the cost at 5.9 and 4.8 points
with no band change. `test/scoring.test.js` pins **both** ends of the taper and
**both** sides of the gate, because nothing in the corpus sits between 2.06 and
3.08 items per group or under 117 grouped items — a change that moved the
full-credit constant to 6, or the gate up past the smallest bot's 299, would
leave `npm run evaluate` green while quietly docking half the people on the
platform or handing all eight bots their reach back.

**A bot with fewer than 45 grouped items gets the gate too.** It is a statement
about how much history there is, and it cannot tell whose history is short.
Nothing in the corpus is that small, and an account that thin has little for any
of the other signals to read either — but the door is open and saying so is
cheaper than pretending it is not.

And **a bot that returns to what it touches keeps the full credit.** Three items
per group buys back everything the taper takes; no population available to this
repo holds an account doing it on purpose. This raises the price of the vouch
rather than closing the door, and that bot has to be caught on the automation
axis instead.

## The blind spot: an account the index has never heard of

The defects above are false positives. This one is the opposite and it is
worse, because a false positive is at least visible: **the newest 15–20% of a
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
  on the account — the same mistake as the forged dormancy above, arriving
  through a different door. There is a test asserting the gate fires, so nobody
  "fixes" it into a clean band later.

Understating age is also the safe direction on its own terms: it can only ever
push a verdict *towards* `insufficient-data`, never towards a clean score.


## A bug only the real runtime could find

`extension/lib/sources/arcticShift.js` defaults its injected fetch to
`globalThis.fetch.bind(globalThis)`. The `.bind` is load-bearing, not defensive
style.

The default is later called as `ctx.fetchImpl(...)`, which hands `fetch` a
receiver that is not the global scope. **Node does not care, so every one of the
106 tests passed either way.** But in an MV3 service worker `fetch` is a native
WebIDL method that requires its own global as the receiver, and an unbound
reference throws `Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal
invocation` — on *every single lookup*. Every badge in the actual unpacked
extension failed while the suite was green.

It cannot be caught by a test in Node, because the injected stub is a plain
function with no receiver rules. The comment at the fix says exactly that, so
the next reader does not simplify it back.

