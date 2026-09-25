# 0006 — Three signals argue in one direction only

**Status:** accepted · **Supersedes:** the symmetric scoring in the first
scoring core · **Evidence:** EVALUATION.md Findings 4, 4d, 4e, 4f · **Affects:**
`extension/lib/scoring/automation.js`, `authenticity.js`

Sustained posting throughput is `unmeasured` below an ordinary rate, Mechanical
posting rhythm is `unmeasured` above an uneven one, and Never replies to replies
is `unmeasured` for an account that only ever replies. Range of interests is
tapered rather than trusted, and withheld entirely under 45 grouped items.

**The rule underneath all four: an ordinary rate, an uneven cadence, an ordinary
reply rate and a wide spread are the *absence* of evidence of a machine, not
evidence of a person.** Scoring any one of them as a clean zero hands the
account a full-weight vote for its own humanity — and a summon-bot has all
three, because it runs when the people summoning it say so.

## What each one did before

**Replying to everyone.** `conversation-depth` scored
`1 - rescale(replyShare, 0.02, 0.3)`. Never replying reads as broadcasting
rather than talking, which is true and is the half that works. But the
arithmetic ran both ways, so a reply share above 30% earned **strength 0** — the
strongest vote for humanity this axis can cast, at weight 1.5 — awarded to
u/RemindMeBot, which replies to everyone by construction.

**An uneven cadence.** `interval-regularity` scored
`1 - rescale(cv, 0.15, 1.0)`. A cadence too even to be anyone's day is a
scheduler, which is true. But `rescale` **clamps at its ceiling**, so every
account from CV 1.0 upward earned strength exactly 0.000 at weight 2 — and the
badge told them *"that is the irregular, clumpy spacing typical of a person"*.
This one cost real people points, and closing it moved ten humans.

**Running everywhere.** `topical-breadth` scored
`0.5 × how much sits outside the largest group + 0.5 × rescale(distinct groups, 2, 15)`,
and both halves saturate on sitewide automation. u/AutoModerator answers in
**307 subreddits** with 98% of itself outside the largest, took a flat 1.000 —
the largest vouch this signal can award anybody — and its badge said *range of
interests*. The second half is not merely saturated but inverted: share outside
the largest group runs 0.84–0.98 for the corpus bots against 0.03–0.87 for its
humans.

## Why a taper for breadth and `unmeasured()` for the other two

Breadth and being everywhere are the same measurement until you ask whether the
account ever went back, so the signal is multiplied by items per group rather
than gated — the question has an answer, and the answer is a scale. The taper is
**withheld under 45 grouped items**, where it does not.

The other two have no such second question available. There is nothing to
multiply an ordinary reply rate by that turns it back into evidence, so it is
excluded from the average instead. That distinction is EVALUATION.md 4f's
"why this is a taper and NOT `unmeasured()`, unlike 4d and 4e".

## What it cost

Across all four remedies **no band edge moved** — `BAND_THRESHOLDS` is unchanged
since the scoring core's first commit and `axis.js` is untouched. The declared
bots went from `moderate ×7, high ×1` to `moderate ×2, high ×6` and their floor
from 35 to 54; the human ceiling across both cohorts is 29. Nothing sits between
29 and 54, bought at the cost of four points of headroom under the band edge.
