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
npm test        # 117 tests, and they pass with NO node_modules installed
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
  test/                      the shared core's suite
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
| Uniform comment length (1.5) | | Asks questions (1.5) |
| Never replies to replies (1.5) | | |
| Karma accumulation rate (1) | | |

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
totals blob at all: **a stream that came back holding exactly as many items as
we asked for stopped because our limit ran out, not because the account did.**
That is what `filledCommentLimit` / `filledPostLimit` carry, and they are
consulted only where a total is absent, because where a total exists it is the
better evidence. Without them the stream-derived profile below would claim a
complete history purely because the blob was missing, and every consumer that
asks "is this window trustworthy" — `reliableTimelineStart()` above all — would
believe it.

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
scheme, and bare `host.tld/path` tokens before the test; both accounts scored
**0 of 299** on the same live data afterwards, and two humans moved 118→107 and
15→14. That ratio is the whole point: the defect was invisible on humans and
total on the adversary, which is exactly the shape a suite of hand-built
fixtures cannot see.

Two details are load-bearing. The link **text** survives, because
`[does anyone know?](url)` is a question its author wrote. And the help-seeking
patterns run over the *same stripped body*, so both halves of the signal read
what the author actually typed rather than one reading the raw text and the
other not.

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
npm test                                  # both suites, 117 tests
node --test test/scoring.test.js           # one file
```

`test/` covers the shared core, `server/test/` the backend — and both globs are
in the `test` script on purpose, because a single `test/*.test.js` silently skips
the server. `scoreAccount` is a pure function (no network, no `Date.now()`, no
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
