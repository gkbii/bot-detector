# 0010 — This repo alone runs no test against the `docs/` contract

**Status:** accepted · **Affects:** `docs/architecture.md`, `docs/project.json`

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
one score would contradict [the product thesis](0003-three-separate-scores.md)
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

