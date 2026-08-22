# bot-detector

Badges Reddit commenters with an account-signal read: **three separate scores**
— is a machine posting this, is this account pushing something, and is there
positive evidence of a real person — rendered inline next to each name as you
scroll a thread.

A Chrome extension is the product. It installs load-unpacked on any laptop,
scores entirely in the browser, and needs **no account, no API key and no
server** — a tool for reading a Reddit thread has to work on whichever machine
is in front of you, so nothing here depends on infrastructure you would have to
run. [Jump to the install](#install); it is five steps and no build.

There is also an **optional** Node server (`server/`) that adds exactly two
things the browser cannot do: a Claude read of what an account actually argues,
and a lookup cache shared between your machines. Nothing requires it.

```
npm test        # 171 tests, and they pass with NO node_modules installed
npm install     # only needed for the optional server's one dependency
npm start       # the optional server
```

That "no `node_modules`" property is the one worth protecting. The extension and
the scoring core have zero dependencies and must keep zero: a dependency there
would have to survive being loaded unbundled by a browser extension, and the
whole install story is "clone, load-unpacked, done".

## Layout

```
bot-detector/
  extension/                 the product — MV3, load-unpacked, no build step
    manifest.json
    background.js            the service worker: owns the lookup queue, cap, backoff, cache
    lib/sources/
      arcticShift.js         the ONLY module that knows the archive's URLs, or the word "subreddit"
      profile.js             AccountProfile — the platform-neutral shape everything downstream sees
    lib/scoring/
      index.js               scoreAccount() — three axes, no blended number, pure function
      axis.js                bands, signals, the insufficient-data gate
      automation.js          axis 1: is a machine posting this
      agenda.js              axis 2: is this account pushing something
      authenticity.js        axis 3: positive evidence of a real person
      stats.js               the shared arithmetic (entropy, CV, shingles, …)
    providers/
      index.js               the seam: local scoring, or your backend, degrading loudly
      local.js               default — fetch + score in this browser
      backend.js             optional — the wire contract with server/
    content/
      badge.js               everything drawn on the page (platform-neutral)
      reddit.js              the Reddit adapter: DOM -> {container, anchor, username}
      badge.css
    popup.html/.js           status readout: which provider produced these verdicts
    options.html/.js         settings, the backend probe, cache controls
  server/                    OPTIONAL. Adds a Claude read + a shared cache. Nothing else.
    index.js                 node:http, two routes: /api/health, /api/verdict
    config.js                the only reader of bot-detector/.env
    deterministic.js         lazily imports the EXTENSION's fetch + scoring. One implementation.
    pack.js                  the evidence pack: which comments the model may talk about
    agenda.js                the Claude call, with citation verification
    cache.js                 node:sqlite — profiles / verdicts / LLM reads, three TTLs
    username.js              normalisation as a security boundary (this value enters a URL)
  scripts/                   NOT shipped, NOT imported by anything, NOT run by npm test
    capture-corpus.mjs       fetches; rebuilds test/corpus/
    probe-prolific-humans.mjs fetches; found the >3/h people now in test/corpus/
    measure-jio329.mjs       fetches; the before/after JIO-329 sweep — EVALUATION.md 4b
    measure-agenda-shape.mjs offline; ranks the corpus on the two shape signals — EVALUATION.md 4c
    measure-reply-share.mjs  offline; the corpus reply-share spread — EVALUATION.md 4d
    measure-interval-cv.mjs  offline; the corpus interval-CV spread — EVALUATION.md 4e
    measure-topical-breadth.mjs offline; the corpus items-per-group gap — EVALUATION.md 4f
    measure-interval-crossing.mjs fetches; who JIO-346 pushed over the edge, live — EVALUATION.md 4e
    measure-quoted-titles.mjs fetches; what JIO-349's two quote strips cost a person — EVALUATION.md 2
    evaluate.mjs             reprints EVALUATION.md's band table from test/corpus/, offline
    lib/bot-declaration.mjs  what counts as "this account declares itself a bot", and why twice
    lib/synthetic-bodies.mjs length-matched stand-ins for the 19 humans' comment text
  test/                      the shared core's suite
  test/corpus/               27 frozen buildProfile outputs — the evaluation as a diff
  server/test/               the backend's suite
  docs/                      the diagram and feature list this project's public page is generated from
    architecture.md          one mermaid flowchart, stable node ids, and the reasoning
    project.json             features, each naming the diagram ids it touches
    architecture.svg         GENERATED from architecture.md -- do not hand-edit
```

## ESM, deliberately

This package sets `"type": "module"` and **it must stay that way** — do not
"fix" it to CommonJS. (It is developed alongside several CommonJS packages, so
the temptation is real; see [Where this comes from](#where-this-comes-from).)

The reason is a hard constraint, not a preference. The extension is the primary
artifact and must load unpacked with zero setup, so the scoring core lives
inside `extension/lib/` and is loaded directly by an MV3 service worker — which
only supports ES modules (`"type": "module"` in `manifest.json`). The optional
server then imports *those same files* through
`../extension/lib/...`, so there is one implementation of the scoring with no
build step, no bundler and no copy. Node 22 loads ESM natively, so honouring
the extension's constraint costs the server nothing.

The same reasoning is written into `package.json`'s `//type` comment, at the
place a reader would actually change it.

## Reddit's own API is not used, and that was checked rather than assumed

The obvious design is Reddit's own `/user/<name>/about.json`. It does not work
for us, and the project's feasibility score on the website moved from a 2 to a 4
because of what checking turned up:

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
* **`arctic-shift.photon-reddit.com` serves the same fields unauthenticated** —
  no key, no signup, no application — with permissive CORS
  (`access-control-allow-origin: *`), which is what lets the extension call it
  directly with no backend. And it is **live, not archival**: verified that the
  newest comment returned for an active account was stamped the same day.

`extension/lib/sources/arcticShift.js`'s header carries the endpoint shapes and
four behaviours confirmed against the live API. Two of them corrected an
assumption:

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
sharing that exact second. Overlap is cheap; a hole is invisible. An unknown
account is `{"data":[]}` with HTTP 200 rather than a 404, so "no such account"
is an empty array — but an empty array from the *users* endpoint alone does not
mean the account is unknown, and `fetchAccount` no longer treats it that way.
See [The blind spot](#the-blind-spot-an-account-the-index-has-never-heard-of).

`https://api.pullpush.io` was also verified serving the same ground on
2026-08-05 and is documented in that header as the escape hatch if arctic-shift
goes away. It is **not** wired up on purpose: a second live source that nothing
exercises is a second source that has silently broken by the time you need it.

## Three separate scores, never one number

This is the product thesis, so it is enforced in code rather than left in a
ticket. `extension/lib/scoring/index.js` returns three axes and there is
deliberately **no combined number anywhere**. Adding one is not a small change.

"Is this a bot" and "is this a propaganda agent" are different questions:

* A crude bot scores high on **automation** and says nothing in particular.
* A human being paid to post talking points has a real account age, organic
  posting hours and varied language. They score **clean on every automation
  signal there is** — correctly, because no machine is involved — while scoring
  high on **agenda**.
* A real person with strong opinions scores high on agenda too, and is told
  apart from the paid poster by **authenticity**, not by automation.

Average those into one "bot score" and the paid poster — the exact case the
project exists to find — lands mid-scale next to the opinionated human, and the
tool has failed at its only job. So `automation.js` is about *mechanism* and
nothing content-shaped belongs in it, and `agenda.js` is about the *shape of
participation* and no automation signal belongs in it.

The third axis exists because **a tool that can only accuse never answers the
question that was asked.** Run three suspicion scores over a normal human and
you get three shrugs, which reads as "probably fine, but…" — everyone ends up
looking slightly guilty and nobody gets vouched for. `authenticity.js`
therefore looks for things that are hard to fake *and pointless to fake*:
admitting error, staying in an argument, caring about unrelated subjects, asking
for help, and taking an unpopular position in front of your own audience. A low
score there is **not** an accusation — it means no positive evidence was found,
which is a different statement from the other two axes, and the headline is
careful to keep them apart.

The signals, with their weights:

| Automation | Agenda | Authenticity |
| --- | --- | --- |
| Round-the-clock posting (3) | Revived dormant account (3) | Takes unpopular positions on home turf (3) |
| Repeated near-identical text (2.5) | Single-subject focus (2.5) | Admits being wrong (2.5) |
| Mechanical posting rhythm (2) | Recurring stock phrases (2.5) | Stays in conversations (2) |
| Bursts across unrelated threads (2) | Posts and leaves (2) | Range of interests (2) |
| Sustained posting throughput (2) | | Asks questions (1.5) |
| Uniform comment length (1.5) | | |
| Never replies to replies (1.5) | | |
| Karma accumulation rate (1) | | |

One column in that table does not combine by plain weighted average, and it is
the one where a false positive is an accusation against a person. **Single-
subject focus and Posts and leaves are held to the evidence beside them**:
neither may argue harder than the strongest measured Recurring stock phrases or
Revived dormant account, floored at the `moderate` band edge so neither is ever
silenced. The section on it is below; the short version is that a hobbyist is
topic-concentrated and posts and leaves, and those two signals alone were
enough to band two real people.

One signal in the authenticity column is **tapered rather than trusted**. Range
of interests is multiplied by the account's items per group, because breadth and
being everywhere are the same measurement until you ask whether the account ever
went back — and the taper is withheld under 45 grouped items, where that
question has no answer yet. The section is below; the short version is that
u/AutoModerator was in 307 subreddits and took the largest vouch this signal can
award anybody.

Three signals in the automation column argue in **one direction only**, and for
the same reason as each other. Sustained posting throughput is `unmeasured`
below an ordinary rate, Mechanical posting rhythm is `unmeasured` above an
uneven one, and Never replies to replies is `unmeasured` for an account that
only ever replies. An ordinary rate, an uneven cadence and an ordinary reply
rate are all the *absence* of evidence of a machine rather than evidence of a
person — and a summon-bot has all three, because it runs when the people
summoning it say so. There is a section on each below; the short version is
that scoring any one of them as a clean zero handed u/RemindMeBot a full-weight
vote for its own humanity.

Three rules live in `axis.js` rather than in each scorer's good intentions:

1. **Bands, not fake probabilities.** "73% bot" is a lie about precision this
   method does not have — there is no calibration set behind it and there never
   will be. `score` exists only so a list can be *ordered*; the UI leads with
   the band, and the published signal does not even expose the internal 0..1
   strength, so nothing downstream can start treating it as a likelihood.
2. **Every signal carries its own weight, direction and evidence string**, and
   the evidence is a sentence a human can disagree with: the measured value, the
   sample it came from, and what it is taken to mean. A bare number nobody can
   argue with is the failure mode.
3. **Absence of evidence is not evidence.** A signal that could not be measured
   is emitted with `strength: null` and band `insufficient-data`, and is
   *excluded* from the weighted average rather than counted as a clean zero —
   counting it as zero is how "we have no data" quietly becomes "this account is
   fine". An axis also needs at least half its total signal weight actually
   measured before it reports a band at all.

## Coverage is part of every verdict

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
12-year dormancy below reached straight back through the door this check had
just opened. Live on 2026-08-18, six index-missed authors of one thread
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

## What it actually scored on a live thread

[`EVALUATION.md`](EVALUATION.md) is the 2026-08-05 run against a real
r/politics thread (236 authors, 25 accounts scored end-to-end) with eight
self-declared bots used as ground truth. The good news is the headline: no
human scored above `low` on automation and no bot scored `low` — the bands do
not overlap. Three defects it turned up, none of which the 106 tests of the day
could see:

* ~~**The users endpoint is a frozen 2025-03-25 snapshot, not a lagging one**,
  so `fetchAccount` returns `null` for every account created since~~ —
  **fixed**, see the section above. It was **14.8% of that thread** on
  2026-08-05 and **20.0%** on a 2026-08-16 re-probe, disproportionately the new
  accounts most worth checking; the growth between those two figures is what
  proves it is a cutoff rather than a lag. The scoring core never needed that
  blob.
* ~~**`asks-questions` counts `?` inside URL query strings**~~ — **fixed**, see
  the section above. It was moving a human by a point or two and taking
  RemindMeBot from 0% to 100%.
* ~~**`dormancy-revival` reports a confident weight-3 zero from windows too
  short to contain a 120-day gap**~~ — **fixed**, see the section above.

One thing the second fix does *not* address, and which the live re-run turned
up: u/sneakpeekbot still reads 94 of 299 after URL stripping, because its
template quotes other people's post titles (`#2: [Any News On The CRKD Drum
Kit?]`). Those are real questions asked by real people — just not by the account
being scored. Counting text an account is quoting as its own words is a
different defect from counting its URLs, and it is not fixed here.

## That table, frozen: `npm run evaluate`

EVALUATION.md's headline band table came from a live run on 2026-08-05, and
**not one of the 25 profiles behind it was kept**. So "the 17-human / 8-bot
separation is not regressed" was a sentence, not a command: every reweighting
proposed after it was unfalsifiable, and when JIO-290 changed two signals the
re-measure that followed could not rule out having moved the one result the
evaluation actually claimed.

`test/corpus/` fixes that. It holds those 25 accounts as serialised
`buildProfile` output — the real fetch, frozen — plus the 2 prolific humans
JIO-344 admitted, for 27 in three separately-ruled cohorts (`politics-thread`,
`prolific-probe`, `declared-bot`; `test/corpus/load.js` refuses a file that
does not name one). And:

```
npm run evaluate                # the table, the invariants, and a diff. exit 1 if anything moved
npm run evaluate -- --detail    # one line per account
npm run evaluate -- --update    # accept today's scores as the new baseline
node scripts/capture-corpus.mjs # rebuilds test/corpus/ from the live API
node scripts/probe-prolific-humans.mjs   # hunts the prolific human — EVALUATION.md 4a
node scripts/measure-jio329.mjs --corpus # JIO-329's cost, offline; --harvest/--fetch go live
node scripts/measure-agenda-shape.mjs    # the agenda hold — EVALUATION.md 4c, offline
node scripts/measure-reply-share.mjs     # the reply-share spread — EVALUATION.md 4d, offline
node scripts/measure-interval-cv.mjs     # the interval-CV spread — EVALUATION.md 4e, offline
node scripts/measure-topical-breadth.mjs # the items-per-group gap — EVALUATION.md 4f, offline
node scripts/measure-quoted-titles.mjs --sweep --profiles  # JIO-349's cost to people; goes live
node scripts/measure-interval-crossing.mjs # who JIO-346 crossed — EVALUATION.md 4e, LIVE
```

`capture-corpus.mjs`, `probe-prolific-humans.mjs` and
`measure-interval-crossing.mjs` are the three that always touch the network, and
none of them is part of `npm test`. `measure-jio329.mjs` goes either way:
`--corpus`, `--variants` and `--report` read `test/corpus/` or a state file
already on disk and fetch nothing, while `--harvest`/`--fetch` go live.
`measure-agenda-shape.mjs`, `measure-reply-share.mjs`, `measure-interval-cv.mjs`
and `measure-topical-breadth.mjs` never fetch at all — like `evaluate`, they are
JSON in and arithmetic out.

**`measure-interval-crossing.mjs` has to fetch, and that is the finding rather
than an oversight.** The other four re-measure the frozen corpus, which is what
makes them reproducible byte-for-byte — and a frozen corpus is exactly what hid
u/chilidirigible's band crossing for three days. A question about drift cannot
be answered from the snapshot the drift is measured against, so this one is
excluded from `test/corpus.test.js`'s no-network allowlist on purpose.

`scoreAccount` is pure and the corpus is JSON, so `evaluate` is arithmetic on
disk: no network, no `node_modules`, and `test/corpus.test.js` asserts that at
the import graph, because "just refresh it if it's stale" is exactly the change
that would look helpful.

**What it reproduces, and what it does not.** Re-captured across 2026-08-18/19
and scored by the code of that day, the automation column came back *exactly*
as EVALUATION.md printed it — `low ×17` for the humans, `moderate ×7, high ×1`
for the bots — and the separation the whole evaluation rested on holds with
room to spare. It has since moved three times, every time on purpose and
every time in one direction. `sustained-posting-rate` took the bots to
`moderate ×6, high ×2` and their floor from 35 to 39; JIO-345's reply-pole cut
took them to `moderate ×5, high ×3` and the floor to 44, touching no human
score at all; and JIO-346's cadence-pole cut took them to **`moderate ×2,
high ×6`** and the floor to **54**, which did move ten humans. All three are
sections above and all three are a diff in `expected.json` rather than a
paragraph, because that is now the point. The thread humans now top out at 20
and the lowest bot is 54. The two prolific humans admitted afterwards sit at 16
and 29, so the human ceiling across both cohorts is 29 and nothing sits between
29 and 54 — a wider gap bought at the cost of four points of headroom under the
band edge, which is the trade the JIO-346 section prices out. **None of the four
moved a band edge to get there**, which is EVALUATION.md Finding 4's closing
decision and the one claim in this section a reader can check with a `git diff`:
`BAND_THRESHOLDS` is unchanged since the scoring core's first commit and
`axis.js` is untouched across all four remedies.

The other two columns have moved for less deliberate reasons. The bots' agenda
column was `low ×6, moderate ×2` and is now `moderate ×8` — including all four of the accounts EVALUATION.md hand-read itself — and
their authenticity column went from `low ×3, moderate ×5` to `low ×5, moderate
×3`. That is not a regression this corpus caught, because there was no baseline
to catch it against; it is sixteen months of fresh history, JIO-290's two
signal changes and JIO-291's truncation fix all surfacing at once. JIO-347's
depth taper then took that column to **`low ×8`** (3–17) on purpose, and unlike
the drift above it is a diff in `expected.json` with a section of its own. It is
written down here rather than quietly re-baselined, because a table that lives
only in prose is exactly how a move this size stays invisible. `expected.json`
freezes *today's* numbers, so the next one is a diff.

**It is re-derived, not recovered, and that is the first thing to know.** Of the
25 accounts, EVALUATION.md names seven: three humans and four bots. The scratch
script that picked the rest did not survive the run, so fourteen human names and
four bot names are simply gone. The humans are therefore re-sampled from the
same thread by a rule fixed before any account was fetched — the authors of the
496-comment sample window, by how many comments they left in it, ties by
username — which is content-blind and cannot be tuned to produce a clean table.
Re-fetching that window returns 496 comments and 235 distinct non-deleted
authors against the 496 and 236 recorded on the day, and the three humans
EVALUATION.md does name fall out at ranks 1, 3 and 6 unprompted. That is the
only corroboration available and it is not the same thing as the original 17.

**There is a second human cohort, and it is a separate row on purpose.** The 17
above are ordinary-volume commenters *by construction* — they were picked by
comment count inside one thread — which quietly made one question unaskable of
this corpus: whether a person fast enough to trip `sustained-posting-rate` still
comes back `low`. JIO-344 went and found two (`prolific-probe`:
u/humdingler at 5.90/h and u/chilidirigible at 3.42/h, from the content-blind
sweep in EVALUATION.md Finding 4a) and froze them here. Three things about how
they are held:

* **They are `class: "human"`, so both separation invariants cover them.** A
  prolific person scored above `low` would be a false accusation exactly like
  any other, and `npm run evaluate` fails on it.
* **They are their own table row, never folded into the seventeen.** Two
  accounts from a volume sweep averaged into seventeen from one thread would
  move that row's range while it still said "thread humans", and would bury the
  only reason these two exist. `test/corpus/load.js` throws on a file whose
  `cohort` it does not recognise rather than guessing.
* **Admission is re-checkable, like the bots'.** A bot must declare itself in
  its own committed text; a prolific human must actually *fire* the rate signal
  from its own committed timestamps. An account that had slowed below the gate
  since the probe read it would otherwise sit in here pinning nothing while
  every count still added up, so `capture-corpus.mjs` refuses it and
  `test/corpus.test.js` re-derives the gate from the frozen profile.

**What they cost, said plainly.** Two accounts hand-read by one person are a
demonstration that the population exists, **not** a measured false-positive
rate — the sweep deliberately aimed at the busiest authors on Reddit, so
nothing here says how *common* a >3/h person is. And they moved a number that
mattered: the human ceiling on automation goes from 17 to 25. They also carry a
finding the ticket that admitted them did not go looking for — **both scored
agenda `moderate` (55 and 57) where all 17 thread humans were `low` (0–19)**,
on `topic-concentration` and `drive-by-ratio`, which is what a high-volume
single-subreddit hobbyist looks like to that axis. That was filed rather than
absorbed, and it is the section below: both read `low 19` now.

**Bot bodies are real; human bodies are not.** Nobody's privacy is at stake in
`u/RemindMeBot`'s boilerplate, and the bot half is precisely where the wording
*is* the evidence — Finding 2 is a claim about the characters in a URL. The
other nineteen are real people — seventeen who argued about one r/politics
thread, two who turned up in a volume sweep — and none of them agreed to have
it committed to a public repository, so their comment bodies are replaced with
length-matched filler. Not lorem ipsum: five things in the scoring
core read a body, and `scripts/lib/synthetic-bodies.mjs` reproduces four of them
exactly — the trimmed character length (`length-uniformity`), the normalised
word count, whether `stripUrls(body)` holds a `?`, and which `self-correction`
or help-seeking phrase matched, injected in canonical form. The fifth,
cross-comment shingle overlap, cannot survive and is not claimed to: the capture
scores the real profile *and* the synthesised one and writes **both** verdicts
into `manifest.json`, so the price of that substitution is a number in the
repository rather than an assurance in a comment.

One thing is deliberately *not* substituted, and it belongs here rather than in
a code comment: the humans' **post titles are committed verbatim** — 890 of
them across 17 of the 19 accounts. No scoring signal reads a title (`.title`
appears nowhere under `extension/lib/` outside the source adapter), and
blanking them would remove the only human-readable handle on what a frozen post
actually was. They are kept for that reason and it is a defensible trade, but
they are still real sentences written by real people in a public repository,
which is a cost this section owes the reader plainly.

How large that price can get is measured rather than guessed, and it is the
reason the bots keep their text. Run the same synthesis over `u/AutoModerator`'s
real 296 comments as a check: `length-uniformity` comes out bit-identical (CV
0.647, mean 718 characters), `asks-questions` bit-identical (35 of 296), and
`self-correction` bit-identical — while `near-duplicate-bodies` falls from 64 of
200 compared, peak similarity 1.00, to **zero**, and `stock-phrasing` from 615
recurring six-word phrases covering all 296 comments (the top one being "am a
bot and this action") to **none**. Automation moderate 63 → 41, agenda moderate
64 → low 28. On a template account, synthesising the bodies deletes the
evidence. On the humans, whose real values on both signals are already at the
floor, it costs what `manifest.json` says it costs — and nothing else in the
corpus is affected, because every other signal reads timestamps, groups, thread
positions and vote scores, none of which are touched.

**A bot has to prove it is one, and there are two ways because one was not
enough.** "Declares itself a bot in its own comment text" is the only ground
truth Reddit offers, so `scripts/lib/bot-declaration.mjs` checks it against the
committed bodies on every test run rather than trusting a label written once.
Then `u/RemindMeBot` failed it — across 299 comments. Its boilerplate says "I
will be messaging you in 5 hours", "CLICK THIS LINK to send a PM", and
"RemindMeBot is switching to username summons"; the only place the word "bot"
appears is inside its own name. Admitting it on that would be reading the
username, and `u/KevinGreeneSolar` two sections up is what reading usernames
costs. So the four accounts EVALUATION.md hand-read are admitted **by citation
to that hand-read**, the other four earn it from their text, and every corpus
file records which. What is deliberately not available is a pattern loosened
until the accounts we wanted fit through it.

**A green `npm run evaluate` is a regression check and nothing more.** It
compares today's code against a fixed input, which means it is blind to the
archive changing, to the fetch window changing, and to both classes of defect
this repo has actually shipped: the forged 12-year dormancy and the unbound
`globalThis.fetch`, each of which passed a fully green suite. Re-capture with
`node scripts/capture-corpus.mjs --force` and re-read the accounts by hand
before claiming anything about live behaviour. The capture is deliberately not
part of `npm test` — it is the one thing here that fetches, it paces itself
because arctic-shift answers throttling with a 422, and it resumes per account
rather than per run, because a 25-account capture that has to start over is one
nobody finishes.

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

## Being a good citizen of a free public archive

The archive is a free service run by a volunteer. Every limit in
`background.js` exists so this extension is not the reason it stops being free.

The **service worker owns the queue** and content scripts never fetch anything —
they ask via `chrome.runtime.sendMessage` and render whatever comes back. That
split is not tidiness: it is the only place where a concurrency cap, an
inter-request gap and a backoff can actually be *global*. Five open Reddit tabs
are five content scripts and one worker, so the archive sees one polite client
rather than five impatient ones. Max 3 in flight across every tab, 300ms between
lookup starts, a 250-deep queue so a long thread queues instead of flooding, and
exponential backoff to two minutes.

Badging is driven by `IntersectionObserver`, so a 4,000-comment thread never
fires 4,000 lookups — and seeing the shape of a whole thread as you scroll is
the actual point of the feature, rather than checking the one name you already
suspected. Verdicts are cached in `chrome.storage.local` for 12 hours with a
300-entry LRU cap.

There is also a hard per-lookup request ceiling of 12, and it is a *safety
property, not a tuning knob*: one badge render must never be able to become a
scraping loop, whether through a pagination bug, a cursor that stops advancing,
or an account with a pathological history. Retries count against it, so a
failing source cannot spin either. A normal lookup is 5 requests.

## Least privilege, because it reads pages you are logged into

`reddit.com` is deliberately **not** a host permission. The content script
*matches* Reddit, but the service worker cannot fetch it. That is strictly less
capability for the same install-time warning, so there is no reason not to.

The full permission set is `storage`, plus one host permission for the archive
origin. **No `tabs`, no `scripting`, no `webRequest`, no `cookies`**, and no
telemetry of any kind. `optional_host_permissions` exists only so a user who
configures their own backend can grant that one origin.

Everything drawn is purely additive and namespaced `bd-*`. Nothing reads, moves,
hides or restyles a node Reddit made — the single write to Reddit's DOM is one
`insertAdjacentElement` of our own badge, and every entry point is wrapped so
that if we throw, the page is exactly as Reddit rendered it.

In local mode, **nothing about your browsing leaves the machine except the
username being looked up**, which goes to the public archive and nowhere else.

## Install

**Requirements: Chrome 111 or newer — or any Chromium browser (Edge, Brave,
Arc, Vivaldi). That is the entire list.** No build step, no `npm install`, no
Node, no account, no API key, no server.

```sh
git clone https://github.com/gkbii/bot-detector.git
```

(Or download the ZIP from the green **Code** button and unzip it. You can also
copy out just the `extension/` directory — it is self-contained, and nothing
outside it is needed to run the extension.)

Then:

1. Open `chrome://extensions` in your browser.
2. Turn on **Developer mode** — the toggle in the top right.
3. Click **Load unpacked** and select the `extension/` directory inside your
   clone. Select the directory containing `manifest.json` itself, not the repo
   root and not `manifest.json` as a file.
4. Open any Reddit thread. Badges appear next to usernames as you scroll.

That is the whole install. Nothing to configure, and the first badge should
appear within a second or two of a username scrolling into view.

Optional bits, all off by default:

* Click the toolbar icon for a status readout — which provider produced the
  verdicts you are looking at, the queue depth, the cache size. It exists
  because local mode and backend mode look identical from the outside and only
  one of them sends usernames to a server.
* The options page (extension → Details → Extension options) toggles
  auto-scanning and post-page scanning, and is where a backend URL goes if you
  run one.

Load-unpacked extensions stay installed across restarts, but Chrome will nag
about developer mode every so often and that is expected — there is no Web
Store listing, and publishing one is not planned. Updating means `git pull` and
then the reload arrow on the extension's card in `chrome://extensions`.

### If badges never appear

* **Check `chrome://extensions` for a service-worker load error.** The
  `extension/lib/` modules are static imports, so a missing or renamed file
  there stops the worker outright rather than half-running it. Click **service
  worker** on the extension's card to open its console.
* **Click the toolbar icon.** If the popup says the worker is not answering,
  the problem is the worker, not Reddit's page. If it reports verdicts and
  queue depth, the lookups are working and the problem is on the page side.
* **Check you selected the right directory** — `extension/`, the one holding
  `manifest.json`, not the repo root.
* **A grey dashed "no data" badge is not a failure.** It is a real verdict:
  the account has too little history to score (fewer than 15 comments, or under
  14 days), and see [Coverage is part of every
  verdict](#coverage-is-part-of-every-verdict) for why that is deliberately not
  reported as a clean score. An account created after 2025-03-25 is missing
  from the upstream users index, but is no longer reported as absent for it —
  it is scored from its comment and post streams, with the missing index entry
  named in the badge's coverage list.
* The content script renders a neutral "unavailable" badge and never touches
  Reddit's own DOM when something goes wrong, so a broken lookup can degrade
  the badge but cannot break the page.

## The optional server, and the seam it plugs into

`providers/index.js` is the seam, and it is the ordinary integration-adapter
shape: a documented interface, a probe for whether the richer dependency is
actually there, and a graceful degrade to the simpler one that **says so out
loud**.

```
chrome.storage.sync.backendUrl empty (the default) -> providers/local.js
chrome.storage.sync.backendUrl set                 -> providers/backend.js
set but unreachable                                -> providers/local.js, degraded: true
```

A degraded run is never silent: `degraded` and `degradedReason` ride along with
every verdict and the expanded card prints them. Local mode looking
indistinguishable from backend mode is how someone ends up believing an LLM read
an account when nothing of the sort happened. A backend that fails is considered
down for 60 seconds before it is tried again.

The wire contract is deliberately tiny — **this is the whole seam for adding a
backend later**, in this repo or anywhere else:

```
POST {backendUrl}/api/verdict   {platform, username, deep}
     -> {verdict, provider: 'backend'}   // the same Verdict shape local produces
GET  {backendUrl}/api/health
     -> {ok: boolean, agenda: boolean}   // `agenda` = an LLM read is available
```

A backend verdict may carry exactly one extra block the local scorer never
produces, `verdict.agenda.llm`, which the panel renders when present.
Everything else must be shape-identical, so the UI has one renderer.

One note for anyone writing a *different* backend: `providers/local.js`'s
imports are static, not a `require()`-style existence probe, because dynamic
`import()` inside an MV3 module service worker is not reliably supported across
Chrome versions. The graceful-degrade half of the pattern still exists — it just
lives one layer out, in the worker's message handler and the content script's
neutral badge.

### What the server adds — and it is only these two things

1. **A Claude agenda read** (`server/agenda.js`). The judgement pattern-matching
   cannot make: the difference between narrative repetition and a person with a
   hobbyhorse, or between stock talking points and an opinion someone genuinely
   holds and has held for three years. Both look identical to a frequency
   counter. This is why an API key is involved at all, and **the key must never
   ship in the extension** — a Chrome extension's bundle is readable by anyone
   who installs it, so a key put there is a published key.
2. **A shared SQLite cache** (`server/cache.js`). A lookup done on the laptop is
   free on the desktop.

The deterministic verdict is *the extension's own code*
(`server/deterministic.js` imports `../extension/lib/...` lazily). The server
has no second opinion about it. Re-implementing the fetch or the scoring here
would immediately produce two answers to the same question that drift apart
silently.

`node:http` with no framework — two routes for an optional local backend is not
a reason to take an Express dependency. Two routes, `/api/health` and
`/api/verdict`. One npm dependency, `@anthropic-ai/sdk`, imported *lazily*, so
`npm install` is not needed to run the extension, the tests, or the
deterministic half of the server: a backend started without it still serves
verdicts and reports the missing agenda read rather than dying. Same for a
missing key — the server runs, `/api/health` says `agenda: false`, and the
extension's card says the read was unavailable.

### Setting the server up, if you want it

Requires Node 22+ (for native ESM and `node:sqlite`) and an
[Anthropic API key](https://console.anthropic.com/). Neither is needed for the
extension itself.

```sh
cp .env.example .env      # then put your key in ANTHROPIC_API_KEY
npm install               # the one dependency, @anthropic-ai/sdk
npm start                 # listens on http://localhost:3200
```

Then open the extension's options page (`chrome://extensions` → Bot Detector →
**Details** → **Extension options**), paste `http://localhost:3200` into the
backend URL field, and hit the probe button. It will tell you whether the
server answered and whether the agenda read is available. Clear the field to go
back to local scoring.

Every var is documented with its reasoning in `.env.example`. The ones that
matter are `ANTHROPIC_API_KEY`, `BOT_AGENDA_MODEL` (Opus by default — judging
whether comments are talking points or a genuinely held opinion is the one
intelligence-sensitive call here, and a cheaper model is measurably worse at
it), and `BOT_DETECTOR_ALLOWED_ORIGINS`, which you must set to your exact
`chrome-extension://<id>` if you expose the server beyond localhost.

Nothing about the server is required, and turning it off loses exactly the two
things listed above and nothing else.

### Citations are verified, not trusted

`server/pack.js` builds a numbered evidence pack in plain deterministic code —
no network, no model — which is what makes citation verification possible at
all: the model can only cite ids that this file minted. On return, every cited
id is resolved against the pack that was actually sent:

* an id that does not resolve is **dropped and reported**, never rendered;
* a finding left with no resolvable citation is **rejected outright**;
* if nothing survives, there is **no LLM block at all** rather than an
  unsupported one.

This is the identical rule `task-runner/src/chess/synthesis.js` applies to its
game citations, for the identical reason — and it matters more here. A confident
paragraph about a stranger's chess is merely wrong; **a confident paragraph
about a stranger's motives reads as true whether or not it is**, and the person
it describes is not in the room to object.

The model is asked for evidence and a band, never a verdict on a person and
never an identity claim — no guesses about who the account belongs to, who they
work for, where they are, or what they are paid. The system prompt says so and
the schema gives it nowhere to put such a claim.

Two more decisions in the pack worth keeping: it selects a **spread, not the
most recent N** (round-robin across the account's groups, and within each group
a recursive-midpoint ordering so any prefix already covers the group's whole
time range) because handing the model the newest 60 comments answers a different
question and systematically overweights whatever the account is arguing about
today. And the cap is a **privacy budget as much as a token budget** — every
comment in the pack is a piece of a real stranger's posting shipped to a third
party, so bodies are truncated rather than sent whole.

### Privacy rules the server holds itself to

Stated in `server/index.js`'s header because this thing judges real people:

* Only public data is ever touched — the same public archive the extension reads
  with no credentials. Nothing logs in as anyone, scrapes anything gated, or
  looks at private messages, votes or email.
* **Comment bodies are never logged.** Not at any level, not on error, not in
  the access line. The access log carries method, path, status, duration and the
  username looked up — nothing else.
* **Comment bodies do not outlive their cache TTL.** Expiry is a physical
  `DELETE` run on open and after every write, not a read-time filter. A row past
  its TTL is gone from disk, not merely invisible. The profile TTL is therefore
  also the retention bound on stored text.
* The cache is a `.db` file of its own, shared with nothing, because it is
  rebuildable — delete it and every entry regenerates — rather than operational
  state. Mixing it into a database that holds anything you would miss makes
  "clear the cache" dangerous. Three tables with three lifetimes: a profile is
  one fetch, a verdict is a cheap pure
  function of it, an LLM read is an Opus call. A stale verdict must not drag a
  still-valid LLM read down with it.
* `server/username.js` is a **security boundary, not a nicety**: its output is
  interpolated into an outbound URL, so anything that is not a real Reddit
  handle is rejected rather than sanitised — "sanitised" is where SSRF lives.
  Reddit handles are `[A-Za-z0-9_-]{3,20}`, a strict subset of what is safe in a
  URL path segment, so an accepted username needs no further escaping.
* The whole server is optional. Anyone uncomfortable with a shared cache or a
  third-party read runs the extension alone and loses only those two things.

## Adding a second platform

TikTok and X were the stated next targets, and both were probed against the
live services on 2026-08-18 — [`PLATFORMS.md`](PLATFORMS.md) is what came back.
The short version is that the seam holds and the *data* does not:

* **TikTok cannot be done at all.** There is no comments-by-account view
  anywhere on the platform, signed in or not, so `profile.comments` could only
  ever be filled from videos — and a video is never a reply, which makes
  `conversation-depth` and `drive-by-ratio` fire on the file format rather than
  on the account. The real payload scores `insufficient-data` on all three
  axes; the best case that does not exist yet scores a normal human at
  automation `moderate`, authenticity `0`.
* **X has one unauthenticated route and it reports the endpoint, not the
  account.** `syndication.twitter.com/srv/timeline-profile` returns 20 or 100
  items depending on the account, allows 30 accounts per 15 minutes per IP, and
  is **not a contiguous timeline**: it includes pinned tweets, the 100-item
  variant is sampled across years, and four of twelve accounts came back 279 to
  554 days stale. Across those twelve, agenda returned `insufficient-data` six
  times — and where signals did fire they fired on artefacts, scoring `@POTUS`
  `high` on dormancy from a pinned tweet and `@NYTimes` `high` on
  round-the-clock posting from a payload nine months old.

The shape underneath is nonetheless already right, and the X mapping needed no
new field:

* `profile.js`'s `AccountProfile` is **platform-neutral** — `group` not
  `subreddit`, `threadId` not `link_id`, `replyCount` not `num_comments`. The
  scoring core must never learn what a subreddit is; adding a Reddit-flavoured
  field here is how the scorers quietly become Reddit-only.
* `arcticShift.js` is the only module that knows the archive's URLs. A second
  source is a sibling file that returns the same shape.
* `content/reddit.js` is the only module that knows Reddit's DOM, and its
  selector table is the only place that DOM is described — a Reddit redesign is
  a one-table fix. A second platform is a second file next to it, not a rewrite,
  because `content/badge.js` already speaks only in bands and signals.

Nulls matter in that shape: **null, never zero**, for anything a source did not
give us. A missing karma total and a karma total of 0 are different facts, and
the scorers treat them differently. Inventing zeros turns "we don't know" into
"it's fine" three modules away. All timestamps are unix **seconds**, the
source's own unit.

## Tests

```
npm test                                  # both suites, 171 tests
node --test test/scoring.test.js           # one file
npm run evaluate                          # EVALUATION.md's band table, off frozen profiles
```

`test/` covers the shared core, `server/test/` the backend — and both globs are
in the `test` script on purpose, because a single `test/*.test.js` silently skips
the server. `test/corpus.test.js` is the odd one out: it scores the 27 frozen
accounts in `test/corpus/` and fails if any of their 81 scores moved, which is
the same check `npm run evaluate` prints as a table. See ["that table,
frozen"](#that-table-frozen-npm-run-evaluate) for what it can and cannot see. `scoreAccount` is a pure function (no network, no `Date.now()`, no
storage — the only clock is `profile.fetchedAt`, captured by the source
adapter), which is what makes every case in it testable for free with a
hand-built profile.

The suite runs with **nothing installed**. Keep it that way: the one dependency
is optional at runtime and belongs to `server/agenda.js` alone.

And keep in mind what the suite structurally cannot catch — see "a bug only the
real runtime could find" above, and the two false positives it also missed. Both
classes of bug were found by pointing the thing at live accounts. A change to
the fetch window, the pagination, or any timing signal deserves the same
treatment before it is believed.

## `docs/`, and why this repo alone has no test for it

`docs/architecture.md` is the shortest accurate description of this system:
one mermaid flowchart plus the reasoning behind the parts of it that are not
obvious. It is also machine-read — it and `docs/project.json` are what generate
this project's page on jiolab.dev, so that page cannot drift from the repo the
way a hand-maintained one does. `docs/architecture.svg` is generated from the
markdown and is not edited by hand.

**The node ids in that flowchart are an interface, not names.** Every feature in
`docs/project.json` lists the ids it touches, and that list is what highlights
the diagram. Rename `gate` and nothing errors: the feature simply highlights
nothing, which looks exactly like a feature that happens to touch no part of the
diagram. So a rename is a breaking change and both files change together.

**The diagram draws three separate paths on purpose.** `automation`, `agenda`
and `authenticity` do not meet before `verdict`. Redrawing them as a funnel into
one score would contradict [the product thesis](#three-separate-scores-never-one-number)
in the one artifact most people will actually look at.

**Re-rendering is a no-op when nothing changed.** The renderer compares bytes
and leaves the file — and its mtime — untouched on equality. Without that the
publish pipeline would commit a new SVG on every run forever, which is a
different failure from a stale diagram but just as loud.

`media` is deliberately an **empty array** rather than a placeholder entry. The
checker treats a `media[].src` naming a file that is not on disk as a hard
failure, so an entry written ahead of the file breaks the site build rather than
reserving a slot; an empty array is the supported way to say "nothing captured
yet", and the page leads with the diagram. The screenshot that belongs there is
a real Reddit thread showing inline badges, and it is captured **by hand**
(`"capture": null`): headless screenshots of an unpacked MV3 extension are
unreliable, which is a tooling limit rather than a policy one.

**Every other project in the private fleet runs the site's contract checker as
part of its own `npm test`, by loading it out of a sibling checkout. This one
must not, and that is the reason it does not.** This repo has to clone and run
on a laptop that has never heard of the machine that publishes the site — no
sibling, no shared state, nothing to configure — and a test that reached for one
would either break that guarantee or, worse, be written to skip quietly when the
sibling is missing, which is how a check comes to pass for months while checking
nothing. The trade is real and worth naming: without that test, drift here is
caught at publish time instead of at `npm test`. If you have the site checkout,
running its `scripts/validateProjectDocs.js` against this repo root is the same
check, on demand.

## Where this comes from

This is developed inside a larger private monorepo of personal projects and
mirrored out here, which is the whole explanation for two things a reader
notices:

* **Code comments occasionally reference sibling packages you cannot see** —
  a `task-runner`, a `skill-backend`, a chess project. They are pointing at
  precedent for a decision (the same citation-verification rule, the same
  `node:sqlite`-over-`better-sqlite3` choice), so the reasoning still stands on
  its own where it is written; only the cross-reference dangles.
* **`package.json` is `"private": true`.** That is deliberate and stays — it
  guards against an accidental `npm publish`. It does not restrict your use of
  the code, which is governed by the [licence](LICENSE). The extension is not
  distributed as an npm package; you install it with **Load unpacked**, per the
  [install steps](#install).

Mirrored with `git subtree`, so the history here is the real commit history of
these files rather than a squashed dump.

## Licence

[MIT](LICENSE). Do what you like with it.

It reads public data only, through a public archive, with no credentials — see
[Privacy rules the server holds itself to](#privacy-rules-the-server-holds-itself-to)
for the specific limits, which apply to the extension too. It is a tool for
reading the shape of an account's public posting, not for identifying anyone;
the model is never asked who an account belongs to, and the schema gives it
nowhere to put such a claim. Please keep it that way.
