# 0005 — The agenda shape signals are held to the evidence beside them

**Status:** accepted · **Evidence:** EVALUATION.md Finding 4c · **Affects:** `extension/lib/scoring/agenda.js`

This one was found by *freezing* two accounts rather than by pointing the thing
at live ones. When JIO-344 put
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

