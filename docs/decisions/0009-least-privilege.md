# 0009 — Least privilege, because it reads pages you are logged into

**Status:** accepted · **Affects:** `extension/manifest.json`, `extension/content/`

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

