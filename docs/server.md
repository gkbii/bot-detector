# The optional server

Nothing here is required. Turning the server off loses exactly two things — a
Claude agenda read and a shared cache — and nothing else.

## The seam it plugs into

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

