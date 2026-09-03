# Evaluating the scorers

How the frozen corpus works, what `npm run evaluate` can and cannot see, and the
hand-run measurement scripts behind `EVALUATION.md`'s findings.

## That table, frozen

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

