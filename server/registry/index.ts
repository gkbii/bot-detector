// The registries, in one place. `scripts/render-registry.js` renders them into
// docs/registry.md and .env.example; test/registry.test.js fails when either
// rendered file is stale, and when a registry has drifted from the code it
// describes. A fresh agent reads docs/registry.md first.
//
// COMMANDS is read out of package.json rather than restated, so the list cannot
// disagree with the scripts it names. ERRORS comes from extension/errors.js for
// the same reason -- one taxonomy, rendered, not a second copy.

import { readFileSync } from 'node:fs';
import { ENV } from './env.ts';
import { ROUTES } from './routes.ts';
import { EVENTS } from './events.ts';
import { ERRORS } from '../../extension/errors.js';

export interface Command {
  readonly name: string;
  readonly run: string;
}

/** npm scripts, read from package.json so the list cannot drift from it. */
export function commands(packageJsonPath: string): Command[] {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
  return Object.entries(pkg.scripts ?? {}).map(([name, run]) => ({ name, run }));
}

export { ENV, ROUTES, EVENTS, ERRORS };
