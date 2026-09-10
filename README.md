# bot-detector

Badges Reddit commenters with an account-signal read: **three separate scores**
— is a machine posting this, is this account pushing something, and is there
positive evidence of a real person — rendered inline next to each name as you
scroll a thread.

A Chrome extension is the product. It installs load-unpacked on any laptop,
scores entirely in the browser, and needs **no account, no API key and no
server**. There is also an optional Node server that adds a Claude read and a
shared cache; nothing requires it.

```sh
npm test        # 185 tests, and they pass with NO node_modules installed
npm install     # only needed for the optional server's one dependency
npm start       # the optional server
```

## Install

**Requirements: Chrome 112 or newer — or any Chromium browser (Edge, Brave,
Arc, Vivaldi). That is the entire list.** No build step, no `npm install`, no
Node, no account, no API key, no server.

```sh
git clone https://github.com/gkbii/bot-detector.git
```

(Or download the ZIP from the green **Code** button and unzip it. You can also
copy out just the `extension/` directory — it is self-contained.)

1. Open `chrome://extensions` in your browser.
2. Turn on **Developer mode** — the toggle in the top right.
3. Click **Load unpacked** and select the `extension/` directory inside your
   clone. Select the directory containing `manifest.json` itself, not the repo
   root and not `manifest.json` as a file.
4. Open any Reddit thread. A small "bot?" button appears next to usernames as
   you scroll; click one to fetch and score that account. The panel opens on
   the short read — the headline, the three bands, and only the checks that
   stood out, each in plain language with a "see an example" link to one
   concrete comment or post behind the finding and a "why?" that unfolds the
   full evidence sentence. **Full report** switches to every signal with its
   working and weight; nothing is removed, only folded.

That is the whole install. Nothing to configure, and the first button should
appear within a second or two of a username scrolling into view.

Optional bits, all off by default:

* Click the toolbar icon for a status readout — which provider produced the
  verdicts you are looking at, the queue depth, the cache size. It exists
  because local mode and backend mode look identical from the outside and only
  one of them sends usernames to a server.
* The options page (extension → Details → Extension options) toggles the check
  buttons, automatic lookup-on-scroll and post-page scanning, and is where a
  backend URL goes if you run one.

Load-unpacked extensions stay installed across restarts, but Chrome will nag
about developer mode every so often — there is no Web Store listing, and
publishing one is not planned. Updating means `git pull` and then the reload
arrow on the extension's card.

### If badges never appear

* **Check `chrome://extensions` for a service-worker load error.** The
  `extension/lib/` modules are static imports, so a missing or renamed file
  stops the worker outright. Click **service worker** on the card for its
  console.
* **Click the toolbar icon.** If the popup says the worker is not answering,
  the problem is the worker, not Reddit's page.
* **Check you selected the right directory** — `extension/`, the one holding
  `manifest.json`.
* **A grey dashed "no data" badge is not a failure.** It is a real verdict: the
  account has too little history to score (fewer than 15 comments, or under 14
  days). See [ADR 0004](docs/adr/0004-coverage-and-the-insufficient-data-gate.md)
  for why that is deliberately not reported as a clean score.
* The content script never touches Reddit's own DOM when something goes wrong,
  so a broken lookup can degrade the badge but cannot break the page.

## What the badges mean

Three axes, and there is deliberately **no combined number anywhere**. "Is this
a bot" and "is this a propaganda agent" are different questions: a human paid to
post talking points scores clean on every automation signal there is —
correctly, because no machine is involved. Average them and that account, the
exact case this exists to find, lands mid-scale next to an opinionated human.

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

Three rules are enforced in `axis.js` rather than left to each scorer's good
intentions: **bands, not fake probabilities**; **every signal carries its own
evidence string** a human can disagree with; and **absence of evidence is not
evidence** — an unmeasurable signal is excluded from the average rather than
counted as a clean zero.

Why three axes and not one, why the weights are what they are, and which signals
argue in one direction only: [ADR 0003](docs/adr/0003-three-separate-scores.md).

## The optional server

Off by default. Setting a backend URL in the options page swaps
`providers/local.js` for `providers/backend.js`; an unreachable backend falls
back to local and **says so** on every verdict, because local mode and backend
mode are otherwise indistinguishable from the outside.

It adds exactly two things and nothing else: a **Claude agenda read** — the
judgement pattern-matching cannot make, between stock talking points and an
opinion someone genuinely holds — and a **shared SQLite cache**. The
deterministic verdict is the extension's own code, imported lazily; the server
has no second opinion about it.

```sh
cp .env.example .env      # then put your key in ANTHROPIC_API_KEY
npm install               # the one dependency, @anthropic-ai/sdk
npm start                 # listens on http://localhost:3200
```

Requires Node 22+. Full setup, the wire contract for writing a different
backend, citation verification and the privacy rules the server holds itself
to: [`docs/server.md`](docs/server.md).

## Layout

```
extension/     the product — MV3, load-unpacked, no build step
  lib/sources/   the ONLY modules that know an archive's URLs
  lib/scoring/   scoreAccount() — three axes, no blended number, pure function
  providers/     the seam: local scoring, or your backend, degrading loudly
  content/       the badge, and the Reddit DOM adapter
server/        OPTIONAL. A Claude read + a shared cache. Nothing else.
scripts/       NOT shipped, NOT imported, NOT run by npm test
test/corpus/   27 frozen buildProfile outputs — the evaluation as a diff
docs/          the diagram and feature list this project's public page is built from
```

The full annotated tree is in [`docs/architecture.md`](docs/architecture.md).

## Tests

```sh
npm test                          # both suites, 185 tests
node --test test/scoring.test.js  # one file
npm run evaluate                  # the band table, off the frozen corpus
```

The suite runs with **nothing installed** — keep it that way. `scoreAccount` is
a pure function (no network, no `Date.now()`), which is what makes every case in
it testable for free with a hand-built profile.

Keep in mind what the suite structurally *cannot* catch: every defect that
mattered here was found by pointing the thing at live accounts, not by the 106
green tests running at the time. A change to the fetch window, the pagination,
or any timing signal deserves the same treatment before it is believed.
[`docs/evaluating.md`](docs/evaluating.md) is the harness and the hand-run
measurement scripts.

## Where to read more

* [`EVALUATION.md`](EVALUATION.md) — what it actually scored against a live
  r/politics thread, and every defect that turned up since. The eight findings
  behind the current weights all live here.
* [`PLATFORMS.md`](PLATFORMS.md) — TikTok and X, probed against the live
  services. The seam holds; the data does not.
* [`docs/adr/`](docs/adr/) — one file per decision, with the alternatives that
  lost:

  | | |
  | --- | --- |
  | [0001](docs/adr/0001-esm-deliberately.md) | ESM, deliberately — do not "fix" this to CommonJS |
  | [0002](docs/adr/0002-not-reddits-own-api.md) | Reddit's own API is not used, and that was checked |
  | [0003](docs/adr/0003-three-separate-scores.md) | Three separate scores, never one number |
  | [0004](docs/adr/0004-coverage-and-the-insufficient-data-gate.md) | Coverage is part of every verdict |
  | [0005](docs/adr/0005-shape-signals-held-to-their-evidence.md) | The agenda shape signals are held to the evidence beside them |
  | [0006](docs/adr/0006-signals-that-argue-one-way-only.md) | Three signals argue in one direction only |
  | [0007](docs/adr/0007-the-index-does-not-decide-existence.md) | The users index does not get to decide whether an account exists |
  | [0008](docs/adr/0008-good-citizen-of-a-free-archive.md) | Being a good citizen of a free public archive |
  | [0009](docs/adr/0009-least-privilege.md) | Least privilege, because it reads pages you are logged into |
  | [0010](docs/adr/0010-docs-contract-has-no-test-here.md) | This repo alone runs no test against the `docs/` contract |

## Where this comes from

Developed inside a larger private monorepo and mirrored out here with
`git subtree`, so the history is real rather than a squashed dump. Two things a
reader notices: **code comments occasionally reference sibling packages you
cannot see** — they point at precedent for a decision, so the reasoning stands
where it is written and only the cross-reference dangles; and **`package.json`
is `"private": true`**, which guards against an accidental `npm publish` and
does not restrict your use of the code.

## Licence

[MIT](LICENSE). Do what you like with it.

It reads public data only, through a public archive, with no credentials. It is
a tool for reading the shape of an account's public posting, not for identifying
anyone; the model is never asked who an account belongs to, and the schema gives
it nowhere to put such a claim. Please keep it that way.
