# 0003 — Three separate scores, never one number

**Status:** accepted · **Affects:** `extension/lib/scoring/index.js`, `axis.js`

This is the product thesis, so it is enforced in code rather than left in a
ticket. `scoring/index.js` returns three axes and there is deliberately **no
combined number anywhere**. Adding one is not a small change.

## Why not one score

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

## Why a third axis that vouches

**A tool that can only accuse never answers the question that was asked.** Run
three suspicion scores over a normal human and you get three shrugs, which reads
as "probably fine, but…" — everyone ends up looking slightly guilty and nobody
gets vouched for. `authenticity.js` therefore looks for things that are hard to
fake *and pointless to fake*: admitting error, staying in an argument, caring
about unrelated subjects, asking for help, and taking an unpopular position in
front of your own audience. A low score there is **not** an accusation — it
means no positive evidence was found, which is a different statement from the
other two axes, and the headline is careful to keep them apart.

## The signals and their weights

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

Two columns do not combine by plain weighted average. **Single-subject focus and
Posts and leaves are held to the evidence beside them** — see
[ADR 0005](0005-shape-signals-held-to-their-evidence.md). **Range of interests is
tapered, and three automation signals argue in one direction only** — see
[ADR 0006](0006-signals-that-argue-one-way-only.md).

## Three rules in `axis.js` rather than in each scorer's good intentions

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
