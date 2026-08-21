# Platform feasibility — probed 2026-08-18

JIO-112 asks for TikTok and X/Twitter support. Before either adapter is worth
writing, two things had to be settled by real calls rather than by reading
docs: whether the data exists at all, and what it costs. This is what was
called, what came back, and which of the ticket's assumptions are now false.

Every timestamp below is UTC on **2026-08-18** unless stated otherwise. Nothing
here is a documented shape presented as a confirmed one; where I could not make
a real call, it says so.

## The short version

| | can an `AccountProfile` be built | what the real scorer did on 12 live accounts | verdict |
| --- | --- | --- | --- |
| **X/Twitter** | yes, from one unauthenticated route — but it returns **20 or 100 items depending on the account, and neither is a contiguous timeline** | agenda `insufficient-data` on 6 of 12; authenticity `low` on **12 of 12**; and where signals did fire they fired on **artefacts of the endpoint** | buildable, but it **reports the endpoint, not the account** |
| **TikTok** | no — the platform has **no comment history for any account, in any session** | all three axes `insufficient-data` | **do not build** |

Two sentences worth carrying out of this. On X the agenda axis goes dark for
exactly the accounts it exists to catch — and on the accounts where it does
report, it reported a 570-day dormancy for `@POTUS` that is a pinned tweet, and
"round-the-clock posting" for `@NYTimes` from a payload 279 days stale. On
TikTok there is nothing to score at all.

---

# X/Twitter

## Everything except one route is closed

| call | result |
| --- | --- |
| `GET api.x.com/2/users/by/username/nasa` | **401 Unauthorized** |
| `GET api.x.com/2/users/11348282/tweets` | **401 Unauthorized** |
| `POST api.x.com/1.1/guest/activate.json` (public web bearer) | **200**, issues a `guest_token` |
| `GET api.x.com/1.1/statuses/user_timeline.json` + guest token | **404** `Sorry, that page does not exist` |
| `GET api.x.com/1.1/users/show.json` + guest token | **403**, Cloudflare HTML |
| `GET api.x.com/2/users/by/username/nasa` + guest token | **403** `Unsupported Authentication ... Authenticating with Unknown is forbidden` |
| `GET x.com/nasa` server-side | **200**, 293 KB — a JS shell, no tweet text, no `og:description` |
| `GET cdn.syndication.twimg.com/timeline/profile?screen_name=nasa` | **200 with a zero-byte body** |
| `GET syndication.twitter.com/srv/timeline-profile/screen-name/nasa` | **200**, 173 KB of Next.js HTML with the timeline in `__NEXT_DATA__` |

The guest-token row is there because it is the obvious next thing anyone would
try, and it still *issues a token* — the failure is one call later, which is
exactly the shape that gets designed against. It opens nothing.

Two of these rows are failures that look like successes: a **200 with an empty
body** from `cdn.syndication.twimg.com`, and a 200-with-a-JS-shell from
`x.com`. Neither raises an error anywhere.

## The one route that works is not a timeline

`syndication.twitter.com/srv/timeline-profile/screen-name/<name>` embeds the
entries in `__NEXT_DATA__` at `props.pageProps.timeline.entries`. `timeline`
has exactly one key — `entries` — and there is no cursor, no `next` and no
pagination field anywhere in `pageProps` (checked by string search over the
whole object). Whatever it gives you is all it will give you.

Twelve accounts were fetched to find out what that is. It is two different
things:

| account | items | newest item | days stale | span | largest internal gap |
| --- | ---: | --- | ---: | ---: | ---: |
| `@jack` | 101 | 2025-10-19 | **302** | 7152 d | **4363 d** |
| `@wikipedia` | 101 | 2025-02-10 | **554** | 3388 d | 365 d |
| `@elonmusk` | 100 | 2026-08-17 | 0.4 | 2859 d | **671 d** |
| `@NYTimes` | 100 | 2025-11-12 | **279** | 3205 d | **843 d** |
| `@Reuters` | 99 | 2025-08-03 | **379** | 2718 d | **767 d** |
| `@POTUS` | 21 | 2026-08-18 | 0.1 | 574 d | **570 d** |
| `@github` | 21 | 2026-08-16 | 1.2 | 17 d | 7 d |
| `@BBCWorld` | 20 | 2026-08-18 | 0.1 | 0.8 d | 0.1 d |
| `@AP` | 20 | 2026-08-18 | 0.1 | 1.5 d | 0.3 d |
| `@NASA` | 20 | 2026-08-17 | 0.4 | 5 d | 2.8 d |
| `@Interior` | 20 | 2026-08-17 | 0.6 | 4.8 d | 1.0 d |
| `@X` | 20 | 2026-08-17 | 0.3 | 117 d | 21 d |
| a handle that does not exist | 0 | — | — | — | HTTP **200**, 2,215 bytes, no `timeline` key |

The count is **stable per account** — `@NASA` returned 20 on three separate
requests and `@jack` returned 101 on three — so it is a property of the
account, not of the request, and there is no parameter that moves it.

Three things in that table are load-bearing, and none of them were in the
ticket.

**The 100-item variant is a sample, not a window.** `@jack`'s 101 entries are
one tweet from 2006, one from 2018, then a scatter across 2019–2025 — a
**4,363-day gap** inside the fetched data. `@NYTimes`, which posts many times
a day, is represented by 100 tweets spread over nine years with an 843-day
hole in the middle. These are not "the most recent N"; the gaps are the
sampler's, not the account's.

**Freshness is not guaranteed and nothing in the payload says so.** Four of the
twelve had a newest item **279 to 554 days old**, including two wire services
that post hourly. `@Reuters` and `@AP` are the same kind of account fetched
minutes apart: one came back current, the other 379 days stale. This repo has a
scar in exactly this shape already — the arctic-shift users index turned out to
be a *frozen* snapshot rather than a lagging one — and this is the same trap on
a different service.

**Even the 20-item variant is not contiguous.** `@POTUS` returned 21 items
spanning 574 days with a 570-day gap: twenty recent tweets and one pinned
tweet from January 2025 sitting above them. `@X`'s 117-day span is the same
thing. Pinned tweets are included and are not marked as such in the entry.

So the JIO-112 intake session's **101 tweets** was real — it happens to have
probed an account in the 100-item class. What it was not is 101 tweets of
*recent, contiguous history*, and that difference is the whole finding below.

Per tweet the payload carries `id_str`, `created_at`, `full_text`,
`conversation_id_str`, `in_reply_to_status_id_str`, `in_reply_to_screen_name`,
`favorite_count`, `reply_count`, `quote_count`, `retweet_count`, `lang`.
Embedded in every tweet is the full user object, including **`created_at`** (a
real account-creation date — `@NASA` is `Wed Dec 19 20:20:32 +0000 2007`),
`statuses_count` (74,158), `followers_count`, `friends_count` and `protected`.

That is enough for a genuine `AccountProfile`, and the seam held without a new
field: `group: null`, `threadId: conversation_id_str`,
`parentId: in_reply_to_status_id_str`, `score: favorite_count`,
`firstSeenUtc: user.created_at`, `counts.posts: statuses_count`. DoD item 4
survives contact with a second platform.

## The rate limit, measured rather than guessed: 30 per 15 minutes per IP

The response carries `x-rate-limit-limit: 30`. Driving it to exhaustion:
requests **1–30 returned 200** with `x-rate-limit-remaining` counting 29 → 0,
and **request 31 returned HTTP 429 `Rate limit exceeded`**. Two reset stamps
observed 15 minutes apart (`03:24:16Z` then `03:40:14Z`) fix the window.

**30 accounts per 15 minutes, or 120 an hour, per IP.** For comparison, the
Reddit source spends up to `MAX_REQUESTS_PER_LOOKUP = 12` requests on one
account and comes back with a contiguous 300-comment window; X spends one
request and comes back with 20 or 100 items that are not contiguous. The
`EVALUATION.md` thread had **236 distinct authors**, so one thread is just under
two hours of continuous polling. The quota is also easy to arrive at already
spent — both the JIO-112 triage session and the first call of this one hit 429
before doing any work at all.

`cdn.syndication.twimg.com/tweet-result?id=<id>` fetches a single tweet
unauthenticated and took **40 consecutive requests with no 429**, so it is a
separate budget. It needs an id you already have, so it does not help with
discovery. Separately, modern X ids are snowflakes —
`(id >> 22) + 1288834974657` ms is the exact post time with no fetch at all —
but ids from before ~2010 (e.g. `20`) are sequential and decode to nonsense.

## Running the repo's real scorer on the real payload

Not a thought experiment: the 20 real `@NASA` tweets were mapped into
`buildProfile` and run through the real `scoreAccount` (throwaway probe in
`/tmp`, deliberately not committed).

```
@NASA  items=20  span=5.0d  ageDays=6816  statuses_count=74158
  automation    band=low                 score=15   measured 9.5/13.5 = 70.4%
      UNMEASURED w=3    posting-hour-dead-zone
      UNMEASURED w=1    karma-velocity
  agenda        band=insufficient-data   score=—    measured 4.5/10  = 45.0%
      UNMEASURED w=2.5  topic-concentration
      UNMEASURED w=3    dormancy-revival
  authenticity  band=low                 score=6    measured 6/11    = 54.5%
      UNMEASURED w=2    topical-breadth
      UNMEASURED w=3    off-script-dissent
```

> Probed against the scorer as it stood on 2026-08-18. JIO-344 has since added
> `sustained-posting-rate` (w 2), so the automation denominator is 15.5 rather
> than 13.5; the numbers in this file are left as they were measured. The new
> signal is safe on this endpoint by construction rather than by luck — a
> sampled, non-contiguous window can only ever spread N items over a *longer*
> span than they really occupied, so it can only understate a rate, and the
> signal is one-directional upward. Where it understates, it returns
> `unmeasured()`.

All twelve accounts were then put through the same path:

```
                items   automation      agenda               authenticity   posting-hour   dormancy-revival
@BBCWorld          20   moderate (32)   insufficient-data    low (0)        unmeasured     unmeasured
@NASA              20   low (15)        insufficient-data    low (6)        unmeasured     unmeasured
@AP                20   low (29)        insufficient-data    low (11)       unmeasured     unmeasured
@Interior          20   low (11)        insufficient-data    low (16)       unmeasured     unmeasured
@X                 20   low (10)        insufficient-data    low (0)        unmeasured     unmeasured
@github            21   low (10)        insufficient-data    low (13)       unmeasured     unmeasured
@POTUS             21   moderate (44)   MODERATE (56)        low (0)        unmeasured     HIGH  <- 570-day "gap"
@jack             101   low (21)        low (26)             low (7)        moderate       low
@Wikipedia        101   low (15)        low (22)             low (17)       moderate       low
@elonmusk         100   moderate (34)   low (27)             low (0)        HIGH           low
@NYTimes          100   moderate (41)   low (28)             low (0)        HIGH           low
@Reuters           99   moderate (37)   low (27)             low (0)        HIGH           low
```

Four separate things are going on, and only one of them was in the ticket.

**1. The two group-dependent axes lose weight, as expected.** X has no
subreddit analogue, so `topic-concentration` (w 2.5), `topical-breadth` (w 2)
and `off-script-dissent` (w 3) cannot be measured. This is the degradation the
ticket anticipated and the scorers report it correctly.

**2. In the 20-item class the agenda axis does not degrade — it goes dark.**
45.0% measured against `MIN_MEASURED_WEIGHT_FRACTION = 0.5` returns
`insufficient-data` for the whole axis, and it did so for six of the seven
20-item accounts. `dormancy-revival` (w 3) is unmeasured because JIO-290's span
gate requires the reliable window to span at least `MIN_DORMANCY_GAP_DAYS = 120`
— correctly, since a 120-day silence cannot fit inside 20 tweets from an active
account. `posting-hour-dead-zone` (w 3) is unmeasured because
`MIN_ITEMS_FOR_HOUR_PROFILE = 24` and the route returned 20; it missed by four
items, for every account in this class, with no page to fetch.

> On X the agenda axis is measurable **only** for an account whose fetched
> window spans more than 120 days — one posting less than twice a month. The
> busier the account, the less this tool can say about it. Agenda is the axis
> that catches the paid poster, and the paid poster is not posting twice a
> month.

The gates are not the bug. JIO-290 put the span gate in because the signal was
otherwise returning a confident "no dormancy" from a window too short to hold
one, 25 times out of 25. Relaxing it, or lowering
`MIN_MEASURED_WEIGHT_FRACTION`, would buy an X agenda score by re-introducing
the exact defect that was just fixed.

**3. Where the axes *do* light up, they are reading the endpoint rather than
the account. This is the serious one.**

* `@POTUS` scores `dormancy-revival` **high** on a 570-day gap, which drags the
  whole agenda axis to `moderate (56)`. There is no dormancy. There is a pinned
  tweet from January 2025 sitting above twenty tweets from this week. The
  account posts daily.
* `@NYTimes`, `@Reuters` and `@elonmusk` score `posting-hour-dead-zone`
  **high** — "round-the-clock posting", the heaviest automation signal —
  computed from 100 tweets *sampled across eight years*. And the `@NYTimes` and
  `@Reuters` payloads were 279 and 379 days stale when it was computed.

`reliableTimelineStart` cannot catch either of these. It trims everything
*below* the oldest item of a truncated stream, and these gaps are **internal**
to the fetched window, not at its edge. The forged-dormancy failure this repo
already fixed once arrives here through a door that guard does not cover.

**4. Every one of the twelve scored authenticity `low`** — six of them exactly
0, none above 17. On Reddit, `EVALUATION.md` measured the opposite: 17 of 17
thread humans scored moderate-to-high (33–73) on authenticity, and that
separation is what tells the opinionated human from the paid poster. On X the
axis loses its two heaviest positive-evidence signals to the missing `group`
and what remains — self-correction, staying in conversations, asking questions
— is close to zero for the accounts I could sample.

That last point needs its caveat stated rather than buried: ten of the twelve
are institutional accounts, and an institution genuinely does not admit it was
wrong or ask questions, so `low` may be the right answer for them. The two
individuals in the sample, `@jack` and `@elonmusk`, scored 7 and 0. Two is not
a sample. **This is the one number in this document that most needs a real
population behind it before anyone builds on it**, and getting one means
scoring ordinary private individuals, which is not something I did.

**The authenticity axis also has only 4.5 points of margin.** 6/11 clears the
50% gate. `sustained-threads` (w 2) needs `MIN_THREADS = 5` distinct
conversations; an account whose 20 tweets sit in four or fewer — a
self-threading account, which is a common propaganda shape — drops to
4/11 = 36.4% and that axis goes dark too. Then only automation reports, and
automation is the axis this whole project exists to say is not enough.

## What the paid API costs for this tool's actual workload

`docs.x.com` (fetched 2026-08-18): X moved to **pay-per-usage** — "No
subscriptions—pay only for what you use" — with **"Posts: Read | $0.005 per
resource"**, owned reads at $0.001, and pay-per-use "capped at 3 million Post
reads per monthly billing cycle". Reads bill **per resource returned**, not per
request. The Basic/Pro tiers the ticket refers to are closed to new signups.

Priced against the workload `EVALUATION.md` actually measured — one r/politics
thread, **236 distinct non-deleted authors**:

| tweets fetched per account | resources per thread | **cost per thread** | threads/month at the 3M cap |
| --- | --- | --- | --- |
| 100 | 23,600 | **$118.00** | ~127 |
| 20 (parity with the free route) | 4,720 | **$23.60** | ~635 |

The $0.001 "owned read" rate does not apply: it is for the developer's own
data, not for scoring strangers.

**Not probed.** I could not confirm these prices against a live billed call —
that needs a developer account and a credit purchase, which is George's to
make. The figures are from X's own docs on 2026-08-18, and they are documented,
not measured. The 401s above *are* measured, so the "no free read path" half of
the ticket's premise is confirmed by real calls.

## Where the ticket is wrong about X

* **"no free API since 2023; the paid tiers are expensive and rate-limited"** —
  still true, and now further along: the tiers themselves are gone, replaced by
  pay-per-use in February 2026.
* **"the realistic path is reading the timeline already rendered in the user's
  own logged-in session"** — needs restating in both directions. There *is* an
  unauthenticated route, so no logged-in session is needed at all, which is
  better than the ticket assumed. But reading *other* accounts' timelines from
  the user's session is not reading what is rendered on the page in front of
  them: it is issuing authenticated calls to x.com's internal GraphQL API with
  the user's cookies, at one call per commenter. That spends the user's own
  account's rate limit and their account's standing on our lookups. It does not
  belong behind the extension's least-privilege posture.
* **"the automation signals that need a long timeline degrade and the scorers
  must report that rather than score around it"** — this is where the ticket's
  model of the problem is wrong, in a way that matters. It assumes a short
  history and graceful degradation. What is actually there is **two failure
  modes, and only the first one degrades**:
  1. the 20-item accounts, where the axes correctly go quiet — agenda
     `insufficient-data` on six of seven; and
  2. the accounts whose payload is sampled, stale, or carries a pinned tweet,
     where the axes are **confidently wrong**. A short history the scorers can
     report on. A history with holes the scorers cannot tell from real silence
     is a different problem, and it is the one this endpoint hands you.

  There is no "report the limitation" fix for the second mode, because nothing
  in the payload distinguishes a sampled gap from a real one. The account is
  the only place that information exists and the endpoint does not return it.

---

# TikTok

## What the unauthenticated surface gives

`GET https://www.tiktok.com/@nasa` → **200**, 368 KB, with
`__UNIVERSAL_DATA_FOR_REHYDRATION__` →
`__DEFAULT_SCOPE__['webapp.user-detail'].userInfo`:

* `user.createTime` = `1784562949`, plus `id`, `secUid`, `privateAccount`,
  `commentSetting`
* `stats` = `{followerCount: 986600, videoCount: 28, heartCount: 4600000, ...}`
* `itemList` — **present, and `length === 0`**

That last point settles a disagreement in the ticket thread: the intake session
reported an empty `itemList`, the triage session reported it absent. On
2026-08-18 the key is **present under `userInfo` and the array is empty**.
Either way it carries no items.

A handle that does not exist returns **HTTP 200** with `statusCode: 10221` and
`userInfo: null` — one more failure that looks like a success.

## Comments are client-side, and the field proves it

`GET https://www.tiktok.com/@complex/video/7626254334065511711` → **200**, with
`webapp.video-detail.itemInfo.itemStruct` carrying `createTime`,
`author.createTime`, `authorStats`, and `stats.commentCount: 10` — alongside
**`comments: []`**, present and empty.

The ticket says TikTok comments are rendered client-side. That is now
confirmed by the strongest available evidence: the server ships the field, ships
a count of 10 next to it, and ships it empty.

The two APIs that would fill it are signed:

| call | result |
| --- | --- |
| `/api/comment/list/?aweme_id=…` (minimal params) | 200, `{"status_code":5}` |
| `/api/comment/list/?…` (full browser param set) | **200 with a zero-byte body** |
| `/api/post/item_list/?secUid=…` | **200 with a zero-byte body** |
| `/tag/nasa` | 200, no item scope in the payload at all |

They need the `X-Bogus`/`msToken` params the page generates. A content script
inside the user's own session could borrow them; a server could not.

Two more measured details. TikTok **video** ids encode their own timestamp —
`id >> 32` is unix seconds, and for `7626254334065511711` that gives
`2026-04-08T05:21:45Z` against the payload's own `createTime` of `05:21:59Z`,
14 seconds out. TikTok **user** ids do not: `@nasa`'s decodes to 2026-07-20
while `user.createTime` says 2026-07-16. Use `createTime`, never the id, for
account age.

Also worth recording because it constrains the *server* half of this repo:
TikTok's `robots.txt` (fetched 2026-08-18) is `Disallow: /` for 25 named
agents including `ClaudeBot`, `anthropic-ai`, `Claude-User`, `GPTBot` and
`CCBot`, and for `User-agent: *` it is allow-list shaped — `/foryou`,
`/discover`, `/tag`, `/share`, `/music`, `/about` — with `/@user` on neither
list. An in-browser content script in the user's own session is a different
posture from a crawler; the optional backend is not.

## The thing that actually settles it

The triage session asked for one specific probe: whether any unauthenticated
endpoint yields per-item timestamps for a **commenter** rather than a creator.
The answer is no, and the reason is broader than "unauthenticated":

> **TikTok has no comment-history surface for a user in any session, signed in
> or not.** There is no "comments by this account" view, so TikTok's own UI
> never calls such an endpoint, so there is no endpoint for a content script to
> borrow. A comment exists only under the video it was left on.

That is checked, not remembered. The page ships its own translation bundle —
2,451 strings in `webapp.i18n-translation` — and the profile-tab keys in it are
`Videos`, `pcWeb_repostTab` (Reposts), `liked` and
`sortbyvv_profile_tab_text_favorites` (Favorites). Every string reading
"Comments" belongs to an inbox or push-notification key (`Inbox_Comments`,
`push_comments`, `bc_comments`, `fixed_comments`). The site has no name for a
profile comments tab because it has no such tab.

So `profile.comments` can only ever be filled from **videos**, and that fails
twice over.

**First, on the real payload.** Feeding the actual `@nasa` response — 986k
followers, 28 videos, a verified creator, the most generous case the
unauthenticated surface offers — into the repo's real `scoreAccount`:

```
@nasa ageDays=28 videoCount=28 itemList=0
  automation    insufficient-data
  agenda        insufficient-data
  authenticity  insufficient-data
  headline: Not enough history to judge this account. Only 0 comments
            available (need 15).
```

**Second, and worse, on the best case that does not exist yet.** Grant a
content script the signed `item_list` call, and map all 28 videos into
`comments`. The following is an explicitly labelled **simulation, not a probe**
— the timestamps and captions are invented; only the *shape* is real (no
`group`, one item per thread, never a reply). To keep it honest I built the
most human-looking creator I could: irregular posting intervals, 28 distinct
captions of randomly varied length with no repeated phrasing.

```
automation    band=moderate            score=35   measured 12.5/13.5 = 92.6%
   high       w=1.5  conversation-depth
agenda        band=insufficient-data   score=—    measured  4.5/10   = 45.0%
   high       w=2    drive-by-ratio
authenticity  band=low                 score=0    measured  6/11     = 54.5%
   low        w=2.5  self-correction
   low        w=2    sustained-threads
   low        w=1.5  asks-questions
headline: Some automation markers, none of them conclusive, and little
          positive evidence of a real person either
```

A real human creator, behaving as unlike a bot as I could make them, lands on
**automation moderate and authenticity zero**. The signals doing it are
structural rather than behavioural, and they would fire identically for every
TikTok account alive:

* `conversation-depth` reads **high** because a video is never a reply to a
  reply.
* `drive-by-ratio` reads **high** because the author never follows up in any
  data we have.
* `sustained-threads`, `asks-questions` and `self-correction` all read **low**
  because a caption is not a conversation.

That is 8.5 points of weight across two axes deciding a verdict from the file
format rather than from the account. It inverts this repo's own rule 3 —
absence of evidence becoming evidence — and it would smear every TikTok user
the badge touched.

## Where the ticket is wrong about TikTok

The ticket says *"it is possible that TikTok simply cannot support the agenda
scoring, and finding that out early is worth more than building toward it."*
That was the right instinct and the answer is yes — but it understates the
result in a way that changes the decision. TikTok cannot support **any** of the
three axes, and the cause is not thin account history, which an adapter might
have worked around. It is that the platform has no comment history for anyone.
Nothing in the scoring core is at fault and no source adapter can fix it.

**Do not build the TikTok adapter.** If it is ever revisited, there is exactly
one fact to re-probe first: whether TikTok has added a per-user comment view.
Everything else follows from that one bit.

---

# What I could not see

* **The TikTok commenter population is unmeasured.** The comment list is
  signed, so I could not enumerate who comments on a video and could not
  measure how many of them have any videos at all. The ticket's "thin history"
  claim is therefore still unquantified. It no longer decides anything — the
  blocker above is structural, not statistical — but it is not something I
  checked.
* **X pay-per-use prices are documented, not billed.** No live billed call was
  made; that needs George's developer account.
* **One IP only.** I did not test the syndication route from a second address,
  so "per-IP" is inferred from two sessions on this machine both hitting the
  same counter, not proven.
* **Twelve X accounts, ten of them institutional.** That is the sample behind
  every X number here. It is enough to establish the *mechanisms* — the two
  response classes, the sampling, the staleness, the pinned tweet — because
  those are properties of the endpoint. It is **not** enough to establish what
  the bands do to the population this tool actually scores, which is ordinary
  individuals replying in a thread. I had no source of such handles that did
  not amount to probing private individuals, and I did not manufacture one.
* **No protected or suspended X account was tested** for its response shape.
  A handle that does not exist returns HTTP 200 with no `timeline` key, which
  is at least detectable; protected and suspended are untested.
* **One 15-minute window's worth of freshness.** `@jack` returned the same
  302-day-stale payload on three requests, but all three were inside one
  window. Whether a stale account ever refreshes is not something I watched.

# If this is picked up

**TikTok: close it.** Nothing here is fixable by an adapter.

**X: do not build the adapter as the ticket describes it.** The seam is proven
— the mapping needed no new `AccountProfile` field, which is DoD item 4 —
but shipping badges from this endpoint would put confident, wrong verdicts on
real accounts, and `@POTUS` scoring `moderate` on agenda from a pinned tweet is
what that looks like. If it is built anyway, these are the conditions:

1. **The endpoint's gaps must be treated as unknown, not as silence.** Today
   `reliableTimelineStart` only trims below the oldest fetched item. An X
   source would need the equivalent guard for gaps *inside* the window — or,
   simpler and more honest, must never populate `posting-hour-dead-zone`,
   `interval-regularity` or `dormancy-revival` from a payload it cannot prove
   is contiguous. Which, on this endpoint, is all of them.
   `sustained-posting-rate` is the one exception and does not need the guard,
   for the reason noted above the twelve-account table: a gap the endpoint
   invented makes the measured rate lower, never higher.
2. **Staleness must be measured and carried.** `fetchedAt` minus the newest
   item was 279–554 days for four of twelve accounts. That belongs in
   `coverage` and on the badge; nothing currently expresses "this data is a
   year old".
3. It reports **two axes, not three**, for any account posting more than about
   twice a month — and the missing one is agenda.
4. `posting-hour-dead-zone` is unmeasurable at 20 items against a threshold of
   24. Lowering `MIN_ITEMS_FOR_HOUR_PROFILE` to buy it back is a real question
   that needs its own evidence; doing it for convenience would be the same
   mistake JIO-290 just undid — and note the accounts where it *did* fire are
   precisely the ones whose data cannot support it.
5. The lookup budget is **30 accounts per 15 minutes per IP**. In-browser that
   is per user and merely slow. On the optional shared backend it is one quota
   for every user at once, so **the backend should not offer X**.
6. Every badge must say "N of `statuses_count` posts". `truncated` is provably
   always true, and this is the platform where that matters most.

The cheapest next step is not an adapter. It is one more probe: score forty
ordinary individual X accounts pulled from the replies of a live political
thread, and see whether authenticity `low` at 12 of 12 holds outside the
institutional sample. If it does, X cannot tell the opinionated human from the
paid poster either, and the second platform is not worth building at all.
