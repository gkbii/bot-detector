# 0011 — The typed half is the server; the extension stays checked-as-JavaScript

**Decided 2026-09-24.** Status: accepted.

The fleet code standard asks for `.ts` sources on Node's native type stripping,
no build step. `server/` is all `.ts` and typechecks `strict`. `extension/` is
deliberately not, and both halves of that are load-bearing.

## Why the extension cannot be `.ts`

Chrome loads `extension/` unpacked, and the MV3 service worker imports
`extension/lib/**` directly as ESM. **Browsers do not strip TypeScript types.**
Renaming those files to `.ts` does not fail a test — every Node test would keep
passing, because Node strips types happily — it fails only in the one place the
product actually runs. That is the same shape as the `fetchImpl` bug: unbound
`globalThis.fetch` worked in Node for all 106 tests and threw
`Illegal invocation` in the real worker, so every lookup in the real extension
failed. A build step would resolve it and is refused for a different reason: the
product installs load-unpacked with no build step, which is the whole point.

## Why it is not typechecked as JavaScript either

`allowJs` + `checkJs` is how a repo adopts one file at a time, so the extension
could be checked in place without renaming anything. Measured on 2026-09-24:
747 errors, and the bulk are not sloppiness. `content/`, `options.js`,
`popup.js` and `background.js` are written against the DOM and the `chrome.*`
extension API, whose ambient types are an npm package (`@types/chrome`). **This
repo's entire test suite runs with no `node_modules` present**, and four packages
in the fleet keep that property on purpose. Buying type coverage for the
extension with a dependency that must be installed before the tests run costs
more than it returns.

So `tsconfig.json` includes `server/**` and the two modules the server imports
from `extension/` (`errors.js`, `log.js`), which are checked as JavaScript and
carry JSDoc types for exactly that reason.

## What is given up, stated plainly

The extension's 5,600 lines are not type-checked by anything. What covers them
is the test suite and, for everything the suite structurally cannot see, a live
run against real accounts — which is already the rule here, for the reason ADR
0010 and `EVALUATION.md` both give.

## Superseded if

`@types/chrome` and DOM lib types become resolvable without an install, or the
extension grows a build step for some other reason. Then the extension joins the
typed half one directory at a time; `checkJs` is already on.
