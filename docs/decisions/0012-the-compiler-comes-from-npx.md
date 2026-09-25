# 0012 — The typechecker is fetched with `npx`, not installed

**Decided 2026-09-24.** Status: accepted.

`npm test` typechecks, and `scripts/typecheck.js` gets `tsc` and `@types/node`
through `npx` into npm's own cache rather than from `node_modules` or from a
shared install elsewhere on the machine.

## Why not a devDependency

The suite runs with **no `node_modules` present**, and that is not an accident to
be tidied up. The extension is the product; it installs load-unpacked with zero
setup; a contributor who has to run an install before the tests work will not run
the tests. A `devDependency` makes `npm test` mean "after `npm install`", which
is the property this repo spends real effort keeping.

## Why not the shared install every other repo uses

Every other repo in the fleet reaches one TypeScript install through
`bb typecheck <repo>`, and extends a `tsconfig.base.json` by absolute path. This
repo is the only public one: it must build and test on a laptop that has never
heard of that machine, and nothing in it may reference the control plane. So
`tsconfig.json` inlines the options instead of extending the shared base, and
the compiler is fetched from the registry like any other user's would be.

## The bound this leaves, and why it is a skip rather than a failure

`npx` needs the network the first time. A machine that cannot reach the registry
therefore cannot typecheck — and on that machine `npm test` prints

```
[bot-detector:typecheck] SKIPPED could-not-fetch-typescript detail=…
```

and runs the rest of the suite. It does **not** fail, because the environment it
would fail in is exactly the offline laptop this repo promises to work on, and a
test command that stops working there is worse than an unchecked type. Set
`BOT_DETECTOR_REQUIRE_TYPECHECK=1` to invert that and make it a hard failure,
which is what a machine with a reliable network should do.

`@types/node` needs one more step: `npx` installs it in a cache directory `tsc`
does not search, so `scripts/typecheck.js` derives that directory from the `PATH`
`npx` exports and passes it as `--typeRoots`. Confirmed against npm 11 on
2026-09-24: `PATH`'s first entry is `<npx cache>/<hash>/node_modules/.bin`. If a
future npm stops doing that, the typecheck reports
`Cannot find type definition file for 'node'` rather than passing quietly.
