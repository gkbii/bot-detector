# 0008 — Being a good citizen of a free public archive

**Status:** accepted · **Affects:** `extension/background.js`

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

