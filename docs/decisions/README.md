# Decisions

One file per decision, with the alternatives that lost. A decision belongs here
when it is still in force and cannot be asserted by a test -- everything that
CAN be asserted is a test instead, and `docs/registry.md` carries what is
generated. These were extracted from the README, which had grown to 1,969 lines
by keeping every argument in the order it was made.

A decision that is later reversed gets a **Superseded by** line and stays; it is
not deleted, because the reasoning that lost is the reason nobody re-proposes
it.

| | |
| --- | --- |
| [0001](0001-esm-deliberately.md) | ESM, deliberately — do not "fix" this to CommonJS |
| [0002](0002-not-reddits-own-api.md) | Reddit's own API is not used, and that was checked |
| [0003](0003-three-separate-scores.md) | Three separate scores, never one number |
| [0004](0004-coverage-and-the-insufficient-data-gate.md) | Coverage is part of every verdict |
| [0005](0005-shape-signals-held-to-their-evidence.md) | The agenda shape signals are held to the evidence beside them |
| [0006](0006-signals-that-argue-one-way-only.md) | Three signals argue in one direction only |
| [0007](0007-the-index-does-not-decide-existence.md) | The users index does not decide whether an account exists |
| [0008](0008-good-citizen-of-a-free-archive.md) | Being a good citizen of a free public archive |
| [0009](0009-least-privilege.md) | Least privilege, because it reads pages you are logged into |
| [0010](0010-docs-contract-has-no-test-here.md) | This repo alone runs no test against the `docs/` contract |
| [0011](0011-the-extension-is-not-typechecked.md) | The typed half is the server; the extension stays checked-as-JavaScript |
| [0012](0012-the-compiler-comes-from-npx.md) | The typechecker is fetched with `npx`, not installed |
