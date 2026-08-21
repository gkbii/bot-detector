/**
 * `node scripts/probe-prolific-humans.mjs` — go and look for the account
 * `sustained-posting-rate` says it cannot see.
 *
 *   node scripts/probe-prolific-humans.mjs                 # harvest, fetch, score
 *   node scripts/probe-prolific-humans.mjs --only u/name   # score named accounts
 *   node scripts/probe-prolific-humans.mjs --subs a,b,c    # different firehose
 *   node scripts/probe-prolific-humans.mjs --read 8        # bodies, for hand-reading
 *   node scripts/probe-prolific-humans.mjs --pages 14 --pace-ms 900
 *
 * GOES TO THE NETWORK. The second script here that does, after
 * `capture-corpus.mjs`, and like that one it is not part of `npm test`, `npm
 * run evaluate`, or anything the extension loads.
 *
 * WHY (JIO-344). README's section on this signal ends by naming the bound it
 * cannot see: "a person who genuinely sustains more than 3 items an hour
 * across a truncated window ... would be measured here, and the corpus
 * contains no such human to check that against." That is an honest bound and
 * it is also unfalsifiable from `test/corpus/`, because the 17 humans in there
 * were selected as the authors of ONE r/politics thread — ordinary-volume
 * commenters by construction. No re-run of the frozen corpus can ever produce
 * the counter-example, so the only way to answer it is to go outside and look.
 *
 * HOW IT LOOKS, AND WHY IT IS CONTENT-BLIND. It ranks the authors of a recent
 * window of busy subreddits by how many comments they left in it, then fetches
 * the top of that list through the real `fetchAccount` and scores it with the
 * real `scoreAccount`. The ranking is fixed before a single profile is
 * fetched, so it cannot be tuned to produce the answer anyone wants — the same
 * discipline `capture-corpus.mjs` applies to its human selection.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not classify. Whether a firing
 * account is a person is a HAND-READ — `--read` prints bodies to the terminal
 * for exactly that, and nothing here writes a comment body to disk. A probe
 * that guessed at humanity would be answering the question it was built to
 * ask. It also writes nothing into `test/corpus/`: admitting an account there
 * is `capture-corpus.mjs`'s job, with the body synthesis that goes with it.
 */

import { fetchAccount } from '../extension/lib/sources/arcticShift.js';
import { scoreAccount } from '../extension/lib/scoring/index.js';

const BASE_URL = 'https://arctic-shift.photon-reddit.com';

/**
 * Argument-heavy, high-traffic, and deliberately not political. The frozen
 * corpus is 17 people from one r/politics thread; repeating that subreddit
 * would re-sample the population whose limits are the reason this exists.
 */
const DEFAULT_SUBS = [
  'AskReddit', 'AmItheAsshole', 'wallstreetbets', 'nba', 'movies',
  'soccer', 'anime', 'CryptoCurrency', 'stocks', 'baseball',
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PAGES = Number(value('--pages', '12'));
const PACE_MS = Number(value('--pace-ms', '1000'));
const READ = Number(value('--read', '0'));
const TOP = Number(value('--top', '25'));
const SUBS = value('--subs', null)?.split(',').map((s) => s.trim()) ?? DEFAULT_SUBS;
const ONLY = value('--only', null)?.split(',').map(normalize) ?? null;

/**
 * One pacer for every request, for the reason `capture-corpus.mjs` documents:
 * arctic-shift answers throttling with a 422 and `fetchAccount` has only
 * MAX_REQUESTS_PER_LOOKUP to spend including retries, so leaning on its
 * backoff produces a thin profile rather than a failure anyone would notice.
 */
let nextSlot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pacedFetch(url, init) {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + PACE_MS;
  if (wait) await sleep(wait);
  return fetch(url, init);
}

async function getRows(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await pacedFetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (res.ok && body && !body.error) return Array.isArray(body.data) ? body.data : [];
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 30) : 5 * (attempt + 1);
    console.error(`  retry ${attempt}: HTTP ${res.status} ${body?.error ?? ''} — waiting ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error(`gave up on ${url}`);
}

/** The firehose, ranked. No body is kept — only an author and a count. */
async function harvest() {
  const counts = new Map();
  for (const sub of SUBS) {
    let before = Math.floor(Date.now() / 1000);
    let oldest = before;
    let newest = 0;
    let total = 0;
    for (let page = 0; page < PAGES; page += 1) {
      const url = `${BASE_URL}/api/comments/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc&before=${before}`;
      const rows = await getRows(url);
      if (!rows.length) break;
      for (const row of rows) {
        const author = row.author;
        if (!author || author === '[deleted]' || author === '[removed]') continue;
        counts.set(author, (counts.get(author) ?? 0) + 1);
        total += 1;
        oldest = Math.min(oldest, row.created_utc);
        newest = Math.max(newest, row.created_utc);
      }
      before = Math.min(...rows.map((r) => r.created_utc));
      if (rows.length < 100) break;
    }
    console.error(`r/${sub}: ${total} comments over ${((newest - oldest) / 3600).toFixed(1)}h`);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([author, n]) => ({ author, n }));
}

async function main() {
  let names;
  if (ONLY) {
    names = ONLY;
  } else {
    const ranked = await harvest();
    console.error(`\n${ranked.length} distinct authors; taking the top ${TOP}\n`);
    // AutoModerator is in every one of these windows and is already in the
    // corpus. It is not the account this probe is looking for.
    names = ranked.filter((r) => r.author !== 'AutoModerator').slice(0, TOP).map((r) => r.author);
  }

  const rows = [];
  for (const name of names) {
    process.stderr.write(`+ ${name} … `);
    let profile;
    try {
      profile = await fetchAccount(name, { fetchImpl: pacedFetch });
    } catch (err) {
      console.error(`FETCH FAILED: ${err.message}`);
      continue;
    }
    if (!profile) { console.error('no such account'); continue; }

    const verdict = scoreAccount(profile);
    const rate = verdict.automation.signals.find((s) => s.key === 'sustained-posting-rate');
    // `insufficient-data` on the signal is this signal's own "says nothing":
    // below ORDINARY_ITEMS_PER_HOUR it returns unmeasured() by design.
    const fired = rate != null && rate.band !== 'insufficient-data';
    rows.push({
      username: profile.username,
      comments: profile.comments.length,
      posts: profile.posts.length,
      itemsPerHour: rate?.value?.itemsPerHour ?? null,
      items: rate?.value?.items ?? null,
      spanDays: rate?.value?.spanSeconds != null ? rate.value.spanSeconds / 86400 : null,
      fired,
      signalBand: rate?.band ?? null,
      automation: { band: verdict.automation.band, score: verdict.automation.score },
      evidence: rate?.evidence ?? null,
      bodies: READ > 0 && fired ? profile.comments.slice(0, READ).map((c) => c.body) : null,
    });
    console.error(`${profile.comments.length}c/${profile.posts.length}p  ${rate?.value?.itemsPerHour?.toFixed(2) ?? '—'}/h  ${fired ? 'FIRED' : 'silent'}  automation ${verdict.automation.band} ${verdict.automation.score ?? ''}`);
  }

  report(rows);
}

function report(rows) {
  const scored = rows.filter((r) => r.itemsPerHour != null);
  scored.sort((a, b) => b.itemsPerHour - a.itemsPerHour);

  console.log(`\n# probe-prolific-humans — ${new Date().toISOString()}`);
  console.log(`# ${ONLY ? 'named accounts' : `r/${SUBS.join(' r/')}`}\n`);
  console.log(`${'account'.padEnd(24)}${'items'.padStart(6)}${'span(d)'.padStart(9)}${'per hour'.padStart(10)}  ${'signal'.padEnd(18)}automation`);
  for (const r of scored) {
    console.log(
      r.username.padEnd(24)
      + String(r.items).padStart(6)
      + r.spanDays.toFixed(2).padStart(9)
      + r.itemsPerHour.toFixed(2).padStart(10)
      + '  ' + (r.fired ? 'FIRED' : 'unmeasured').padEnd(18)
      + `${r.automation.band} ${r.automation.score ?? ''}`,
    );
  }
  const unscorable = rows.filter((r) => r.itemsPerHour == null);
  if (unscorable.length) {
    console.log(`\n${unscorable.length} account(s) the signal could not reach a rate for: ${unscorable.map((r) => r.username).join(', ')}`);
  }

  const fired = scored.filter((r) => r.fired);
  console.log(`\n${fired.length} of ${rows.length} fired the signal.`);
  if (!fired.length) {
    console.log('No account in this sweep sustains ORDINARY_ITEMS_PER_HOUR. That is one');
    console.log('sweep on one day, and it is NOT evidence that no such account exists.');
    return;
  }

  console.log('\nEVERY ONE OF THESE NEEDS A HAND-READ. This probe does not and must not');
  console.log('decide which are people; re-run with --read 8 to print bodies. A firing');
  console.log('account that reads as human is the counter-example README asks for, and');
  console.log('it belongs in test/corpus/ via capture-corpus.mjs before anyone touches');
  console.log('ORDINARY_ITEMS_PER_HOUR.\n');
  for (const r of fired) {
    console.log(`--- ${r.username} — ${r.automation.band} ${r.automation.score ?? ''}`);
    console.log(`    ${r.evidence}`);
    if (r.bodies) for (const b of r.bodies) console.log(`      ${JSON.stringify((b ?? '').slice(0, 140))}`);
  }
}

function normalize(name) {
  return name.trim().replace(/^\/?(?:u|user)\//i, '');
}

if (flag('--help')) {
  console.log('node scripts/probe-prolific-humans.mjs [--only u/a,u/b] [--subs a,b]'
    + ' [--pages N] [--pace-ms N] [--top N] [--read N]');
  process.exit(0);
}

await main();
