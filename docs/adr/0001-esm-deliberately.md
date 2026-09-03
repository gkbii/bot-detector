# 0001 — ESM, deliberately

**Status:** accepted · **Affects:** `package.json`, `extension/manifest.json`

This package sets `"type": "module"` and **it must stay that way** — do not
"fix" it to CommonJS. It is developed alongside several CommonJS packages, so
the temptation is real.

The reason is a hard constraint, not a preference. The extension is the primary
artifact and must load unpacked with zero setup, so the scoring core lives
inside `extension/lib/` and is loaded directly by an MV3 service worker — which
only supports ES modules (`"type": "module"` in `manifest.json`). The optional
server then imports *those same files* through `../extension/lib/...`, so there
is one implementation of the scoring with no build step, no bundler and no copy.
Node 22 loads ESM natively, so honouring the extension's constraint costs the
server nothing.

The same reasoning is written into `package.json`'s `//type` comment, at the
place a reader would actually change it.
