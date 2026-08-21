/**
 * Capture `test/corpus/` — the frozen evaluation corpus. Goes to the network on
 * purpose; it is not run by `npm test`, by `npm run evaluate`, or by anything
 * in the extension. Two other scripts here fetch: `probe-prolific-humans.mjs`,
 * which feeds this one (see PROLIFIC_HUMANS below), and `measure-jio329.mjs`.
 *
 *   node scripts/capture-corpus.mjs                 # fill in what is missing
 *   node scripts/capture-corpus.mjs --force         # re-capture everything
 *   node scripts/capture-corpus.mjs --only u/name   # one account
 *   node scripts/capture-corpus.mjs --pace-ms 2500  # gap between requests
 *
 * WHY IT EXISTS (JIO-343). EVALUATION.md's headline band table came from a
 * live run on 2026-08-05 and no profile was kept, so "the 17-human / 8-bot
 * separation is not regressed" was a claim nobody could check — every
 * reweighting proposal after it was unfalsifiable. This script re-fetches
 * those accounts through the real `fetchAccount` path and freezes the
 * resulting `buildProfile` output; `npm run evaluate` then reprints the table
 * from disk with no network at all.
 *
 * RESUME PER ACCOUNT, NOT PER RUN. Each account is one file and an existing
 * file is skipped, because arctic-shift throttles and a 25-account capture
 * that has to start over is a capture nobody will finish.
 *
 * THREE THINGS THIS CAPTURE CANNOT DO, AND SAYS SO RATHER THAN PAPERING OVER:
 *
 *  1. THE ORIGINAL 17 HUMANS ARE NOT RECOVERABLE. EVALUATION.md names three of
 *     them (runnertrailsBay, bigbjarne, KevinGreeneSolar) and no scratch
 *     script survived the run, so the other fourteen are gone. The sample is
 *     therefore RE-DERIVED from the same thread by a stated, content-blind
 *     rule (below) rather than reconstructed. The three named accounts fall
 *     inside it, which is the only corroboration available.
 *  2. FOUR OF THE EIGHT BOTS ARE NOT RECOVERABLE EITHER, for the same reason.
 *     The four EVALUATION.md names are mandatory and are admitted on that
 *     hand-read; the other four come off an ordered candidate list and have to
 *     PROVE from their own comment text that they declare themselves bots.
 *     `lib/bot-declaration.mjs` holds both bases and explains why there have to
 *     be two — u/RemindMeBot passes no pattern in 299 comments.
 *  3. THE ACCOUNTS HAVE KEPT POSTING. A 2026 re-fetch of a 2026-08-05 account
 *     returns a different newest-300 window, so a score is allowed to move.
 *     What is being frozen is the population and the method, not the day.
 *
 * Human bodies are replaced with length-matched synthetic text — see
 * `lib/synthetic-bodies.mjs` for why, and for exactly which measurements
 * survive. This script scores the REAL profile and the SYNTHESISED profile and
 * writes both verdicts into the manifest, so the cost of that substitution is
 * a number in the repository rather than an assurance in a comment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAccount } from '../extension/lib/sources/arcticShift.js';
import { scoreAccount } from '../extension/lib/scoring/index.js';
import { declarationBasis } from './lib/bot-declaration.mjs';
import { synthesizeProfileBodies } from './lib/synthetic-bodies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(ROOT, 'test', 'corpus');
const MANIFEST = path.join(CORPUS_DIR, 'manifest.json');

// --- the thread the humans come from ---------------------------------------
// EVALUATION.md: r/politics "It Wasn't a Blowout, but El-Sayed Won", posted
// 13:18 UTC on 2026-08-05 and sampled at 18:58 UTC the same day. Re-fetching
// with that cutoff and the same newest-first paging returns 496 comments and
// 235 distinct non-deleted authors against the 496 and 236 recorded then — one
// author short, sixteen months of deletions later, which is as close as this
// gets to proof that the window is the same one.
const THREAD_ID = '1vg75om';
const THREAD_SAMPLED_BEFORE = Math.floor(Date.parse('2026-08-05T18:58:00Z') / 1000);
const THREAD_COMMENT_WINDOW = 496;
const HUMAN_COUNT = 17;

/**
 * WHICH POPULATION AN ACCOUNT CAME FROM, written into its corpus file and not
 * inferred from `class`. There are two human cohorts now and they were chosen
 * by different rules, so merging them under one label would make the table
 * claim something neither sample supports.
 */
const COHORT_THREAD = 'politics-thread';
const COHORT_PROLIFIC = 'prolific-probe';
const COHORT_BOT = 'declared-bot';

/**
 * THE SECOND HUMAN COHORT (JIO-344). The 17 above are the authors of one
 * r/politics thread, ranked by comment count in it — ordinary-volume
 * commenters BY CONSTRUCTION. That made one question permanently unaskable of
 * this corpus: README's `sustained-posting-rate` section admitted it could not
 * see "a person who genuinely sustains more than 3 items an hour", and no
 * re-run of a thread sample can ever produce one.
 *
 * So the bound was gone and looked for. `probe-prolific-humans.mjs` ranked
 * 16,264 authors of 22 subreddits by recent volume, content-blind, and scored
 * the top 48 through the real path; seven cleared `ORDINARY_ITEMS_PER_HOUR`
 * and six of the seven hand-read as unmistakably human (EVALUATION.md Finding
 * 4a). These two are frozen out of that six:
 *
 *   u/humdingler      5.90/h — the FASTEST person found, and faster than
 *                     u/RemindMeBot at 5.5/h. It is the account that proves
 *                     the two populations overlap, which is the claim README
 *                     used to deny.
 *   u/chilidirigible  3.42/h — automation `low 25`, the highest-scoring of the
 *                     six and the one JIO-329 pushes to `moderate 32` from
 *                     this frozen profile, when it takes `conversation-depth`
 *                     and `interval-regularity` to unmeasured. Without it in
 *                     here, a real person crossing a band is a thing that
 *                     happens with `npm run evaluate` still printing OK.
 *                     It is the only account in here that crosses, and it is
 *                     NOT the whole cost: the live sweep in EVALUATION.md
 *                     Finding 4b crossed seven, five of them at rates this
 *                     signal never measures. Every human in this corpus was
 *                     sampled by volume or off one r/politics thread, so what
 *                     is pinned here is that the cost EXISTS, not its size.
 *
 * ADMISSION IS RE-CHECKABLE, like the bot half's. A bot has to declare itself
 * in its own committed text; a prolific-probe human has to actually FIRE
 * `sustained-posting-rate` from its own committed timestamps. An account that
 * quietly drifted under the gate on re-capture would otherwise sit here
 * pinning nothing at all, and `test/corpus.test.js` re-derives that gate from
 * the frozen profile rather than trusting this run.
 *
 * The hand-read is the part this repo cannot automate and does not pretend to:
 * it is Finding 4a's, on bodies that were never written to disk. Adding to
 * this list means running the probe and reading the comments.
 */
const PROLIFIC_HUMANS = ['humdingler', 'chilidirigible'];

/**
 * HOW THE 17 ARE CHOSEN, since the original selection is lost: the authors of
 * that 496-comment window, ranked by how many comments they left in it,
 * usernames breaking ties. It is content-blind and it is not chosen on the
 * outcome — the rank is fixed before a single account is fetched, so it cannot
 * be tuned to produce a clean table. The three humans EVALUATION.md names come
 * out at ranks 1, 3 and 6 of that list, unprompted.
 *
 * An account is skipped only if `scoreAccount` cannot reach a verdict on it at
 * all (the insufficient-data gate), and then the next rank is taken and the
 * skip is recorded in the manifest by name and reason. The population is
 * "thread authors with enough history to be scored", which is the population
 * the original table was about too; a silent skip would make it "thread
 * authors that scored the way we hoped".
 */
const HUMAN_SELECTION_RULE = 'authors of the 496-comment sample window, by descending comment count in it, ties by username; skipped only when scoreAccount returns insufficient-data';

/**
 * Declared bots. The first four are the ones EVALUATION.md names and are not
 * negotiable. The rest is an ordered candidate list of long-running Reddit
 * bots; the capture walks it and takes the first that clear the scoring gate
 * and the declaration gate, so which four land here is a fact about the
 * archive on the capture date rather than a preference. Every admitted account
 * records in its own corpus file which basis let it in.
 */
const BOT_CANDIDATES = [
  // EVALUATION.md's four. Mandatory, and admitted on its hand-read.
  'AutoModerator', 'RemindMeBot', 'RepostSleuthBot', 'sneakpeekbot',
  // Candidates for the four lost names, in the order they are tried. The list
  // is long because the declaration gate rejects most of them and that was a
  // surprise worth recording: u/WikiSummarizerBot, u/LimbRetrieval-Bot,
  // u/alphabet_order_bot and u/converter-bot are all unmistakably bots and none
  // of them says so in words — their footers are an F.A.Q link, an opt-out link
  // and a version number. "Declares itself a bot" is a much smaller population
  // than "is a bot", which is the whole reason EVALUATION.md's ground truth is
  // eight accounts and not eight hundred.
  'WikiSummarizerBot', 'AmputatorBot', 'LimbRetrieval-Bot', 'alphabet_order_bot',
  'Anti-ThisBot-IB', 'converter-bot', 'B0tRank', 'haikusbot',
  'of_have_bot', 'timee_bot', 'SaveVideo', 'FriesWithThatShake',
  'same_subreddit_bot', 'WhyNotCollegeBoard', 'sub_doesnt_exist_bot', 'stabbot',
  'SmileBot-2020', 'pekofy_bot', 'wikipedia_answer_bot', 'Reddit-Book-Bot',
  'NoGoogleAMPBot', 'TheDroidNextDoor', 'RedditSpeedBot', 'haiku_bot_',
];
const BOT_COUNT = 8;

const BASE_URL = 'https://arctic-shift.photon-reddit.com';

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const FORCE = flag('--force');
const ONLY = value('--only', null);
const PACE_MS = Number(value('--pace-ms', '2500'));

/**
 * Every request in this process goes through one pacer. arctic-shift answers
 * throttling with HTTP 422 rather than 429 (see the arcticShift.js header),
 * and `fetchAccount` only has MAX_REQUESTS_PER_LOOKUP=12 to spend including
 * retries — so a 25-account capture that leans on its backoff will exhaust the
 * budget mid-account and write a thin profile. Pacing up front is what keeps
 * the retry path for genuine trouble. It is deliberately a wrapper around the
 * real `fetch` passed in as `fetchImpl`, not a change to the adapter: the
 * whole point is that this corpus came through the code the extension runs.
 */
let nextSlot = 0;
async function pacedFetch(url, init) {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + PACE_MS;
  if (wait) await sleep(wait);
  return fetch(url, init);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const manifest = readManifest();

  if (!manifest.humanSelection || FORCE) {
    manifest.humanSelection = await selectHumanCandidates();
    writeManifest(manifest);
  }

  const bots = [];
  for (const name of BOT_CANDIDATES) {
    if (bots.length >= BOT_COUNT) break;
    const outcome = await capture(name, 'bot', COHORT_BOT, manifest);
    if (outcome.admitted) { bots.push(name); unnote(manifest, 'botsRejected', name); }
    else if (!outcome.filtered) note(manifest, 'botsRejected', { username: name, reason: outcome.reason });
    writeManifest(manifest);
  }
  if (!ONLY && bots.length < BOT_COUNT) {
    console.error(`\nBOUND FIRED: only ${bots.length} of ${BOT_COUNT} declared bots could be captured from ${BOT_CANDIDATES.length} candidates.`);
  }

  const humans = [];
  for (const { author } of manifest.humanSelection.ranked) {
    if (humans.length >= HUMAN_COUNT) break;
    const outcome = await capture(author, 'human', COHORT_THREAD, manifest);
    if (outcome.admitted) { humans.push(author); unnote(manifest, 'humansSkipped', author); }
    else if (!outcome.filtered) note(manifest, 'humansSkipped', { username: author, reason: outcome.reason });
    writeManifest(manifest);
  }
  if (!ONLY && humans.length < HUMAN_COUNT) {
    console.error(`\nBOUND FIRED: only ${humans.length} of ${HUMAN_COUNT} thread humans could be captured from ${manifest.humanSelection.ranked.length} ranked authors.`);
  }

  const prolific = [];
  for (const name of PROLIFIC_HUMANS) {
    const outcome = await capture(name, 'human', COHORT_PROLIFIC, manifest);
    if (outcome.admitted) { prolific.push(name); unnote(manifest, 'prolificSkipped', name); }
    else if (!outcome.filtered) note(manifest, 'prolificSkipped', { username: name, reason: outcome.reason });
    writeManifest(manifest);
  }
  if (!ONLY && prolific.length < PROLIFIC_HUMANS.length) {
    console.error(`\nBOUND FIRED: only ${prolific.length} of ${PROLIFIC_HUMANS.length} prolific humans could be captured. The corpus no longer holds a person above ORDINARY_ITEMS_PER_HOUR, so README's claim that the signal's shape protects one is back to being unfalsifiable.`);
  }

  if (!ONLY) {
    manifest.bots = bots;
    manifest.humans = humans;
    manifest.prolificHumans = prolific;
    writeManifest(manifest);
  }

  console.log(`\ncaptured ${bots.length} bots + ${humans.length} thread humans + ${prolific.length} prolific humans into test/corpus/`);
  console.log('now run: node scripts/evaluate.mjs --update');
}

/**
 * Fetch, score, (for humans) synthesise, verify, write. Returns whether the
 * account was admitted and why not when it was not — nothing here is allowed
 * to fail quietly, because a corpus that is silently 22 accounts still prints
 * a table.
 */
async function capture(username, klass, cohort, manifest) {
  if (ONLY && normalize(ONLY) !== username.toLowerCase()) return { admitted: false, filtered: true, reason: '--only' };

  // A REJECTION IS A UNIT OF WORK TOO. Re-fetching 300 comments to re-learn
  // that u/WikiSummarizerBot's footer never says "I am a bot" costs the same
  // twelve requests as capturing an account that does, and this script gets
  // interrupted — arctic-shift throttles, so a full pass is tens of minutes.
  // Resume therefore covers both outcomes; `--force` is how you re-ask.
  const rejected = [...(manifest.botsRejected ?? []), ...(manifest.humansSkipped ?? []), ...(manifest.prolificSkipped ?? [])]
    .find((e) => e.username === username);
  if (rejected && !FORCE) {
    console.log(`- ${username} (rejected by an earlier pass: ${rejected.reason})`);
    return { admitted: false, filtered: true, reason: rejected.reason };
  }

  const file = path.join(CORPUS_DIR, `${username}.json`);
  if (fs.existsSync(file) && !FORCE) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`= ${username} (cached, ${existing.profile.comments.length} comments)`);
    return { admitted: true, reason: null };
  }

  process.stdout.write(`+ ${username} … `);
  let real;
  try {
    real = await fetchAccount(username, { fetchImpl: pacedFetch });
  } catch (err) {
    console.log(`FETCH FAILED: ${err.message}`);
    return { admitted: false, reason: `fetch failed: ${err.message}` };
  }
  if (!real) {
    console.log('no such account');
    return { admitted: false, reason: 'fetchAccount returned null' };
  }

  const realVerdict = scoreAccount(real);
  if (realVerdict.automation.band === 'insufficient-data'
      && realVerdict.agenda.band === 'insufficient-data'
      && realVerdict.authenticity.band === 'insufficient-data') {
    console.log('insufficient-data — skipped');
    return { admitted: false, reason: `insufficient-data: ${realVerdict.headline}` };
  }

  // Whether an account may enter as a bot is decided by lib/bot-declaration.mjs,
  // not here: either its own committed text declares it, or it is one of the
  // four EVALUATION.md hand-read. Which basis admitted it goes into the corpus
  // file, and test/corpus.test.js re-derives the text-based half from the
  // committed bodies rather than trusting this run's label — the discipline
  // server/agenda.js applies to the model's citations, applied to our own.
  const declared = klass === 'bot' ? declarationBasis(real.username, real.comments) : null;
  if (declared && !declared.admitted) {
    console.log(`${declared.note} — skipped`);
    return { admitted: false, reason: declared.note };
  }

  // The prolific cohort's own admission gate, and the reason it is here rather
  // than in a comment: this cohort exists ONLY to hold a person the rate
  // signal actually measures. An account that has slowed below
  // ORDINARY_ITEMS_PER_HOUR since the probe read it is an ordinary human — a
  // fine account and a useless one for this job — and letting it in quietly
  // would leave the corpus claiming a counter-example it no longer contains.
  if (cohort === COHORT_PROLIFIC) {
    const rate = realVerdict.automation.signals.find((sig) => sig.key === 'sustained-posting-rate');
    if (!rate || rate.band === 'insufficient-data') {
      const seen = rate?.value?.itemsPerHour;
      const note = `does not fire sustained-posting-rate${Number.isFinite(seen) ? ` (${seen.toFixed(2)}/h)` : ''} — cannot stand in for a prolific human`;
      console.log(`${note} — skipped`);
      return { admitted: false, reason: note };
    }
  }

  let stored = plain(real);
  let synthesisWarnings = [];
  if (klass === 'human') {
    const out = synthesizeProfileBodies(stored);
    stored = out.profile;
    synthesisWarnings = out.warnings;
  }

  const frozenVerdict = scoreAccount(stored);

  fs.writeFileSync(file, `${JSON.stringify({
    username: real.username,
    class: klass,
    cohort,
    capturedAt: real.fetchedAt,
    bodies: klass === 'bot' ? 'real' : 'synthesised-length-matched',
    declaredBy: declared ? declared.basis : null,
    declarationNote: declared ? declared.note : null,
    declarations: declared ? declared.declarations : 0,
    profile: stored,
  }, null, 1)}\n`);

  note(manifest, 'captured', {
    username: real.username,
    class: klass,
    cohort,
    capturedAt: real.fetchedAt,
    comments: real.comments.length,
    posts: real.posts.length,
    declaredBy: declared ? declared.basis : null,
    declarationNote: declared ? declared.note : null,
    // BOTH verdicts, always. For a bot they are identical by construction and
    // that is worth being able to see; for a human the gap between them is the
    // exact price of not committing a stranger's political comments to a
    // public repo, and it belongs in the repo rather than in a claim.
    real: summarize(realVerdict),
    frozen: summarize(frozenVerdict),
    synthesisWarnings,
  });

  const drift = axisDrift(realVerdict, frozenVerdict);
  console.log(`${real.comments.length}c/${real.posts.length}p  ${bandLine(frozenVerdict)}${drift ? `  DRIFT ${drift}` : ''}${synthesisWarnings.length ? `  ${synthesisWarnings.length} SYNTHESIS WARNINGS` : ''}`);
  if (synthesisWarnings.length) for (const w of synthesisWarnings.slice(0, 5)) console.log(`    ! ${w}`);
  return { admitted: true, reason: null };
}

/** The thread window, re-fetched, ranked. No comment body is kept or written. */
async function selectHumanCandidates() {
  console.log(`fetching r/politics thread ${THREAD_ID} up to ${new Date(THREAD_SAMPLED_BEFORE * 1000).toISOString()} …`);
  const seen = new Map();
  let before = THREAD_SAMPLED_BEFORE;

  while (seen.size < THREAD_COMMENT_WINDOW) {
    const url = new URL('/api/comments/search', BASE_URL);
    url.searchParams.set('link_id', THREAD_ID);
    url.searchParams.set('limit', String(Math.min(100, THREAD_COMMENT_WINDOW - seen.size + 4)));
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('before', String(before));

    const rows = await getWithRetry(url.toString());
    if (!rows.length) break;
    let added = 0;
    for (const row of rows) if (!seen.has(row.id)) { seen.set(row.id, row); added += 1; }
    if (added === 0) break;
    before = Math.min(...rows.map((r) => r.created_utc)) + 1;
    if (rows.length < 100) break;
  }

  const window = [...seen.values()]
    .filter((r) => r.created_utc < THREAD_SAMPLED_BEFORE)
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, THREAD_COMMENT_WINDOW);

  const counts = new Map();
  for (const row of window) {
    const author = row.author;
    if (!author || author === '[deleted]' || author === '[removed]') continue;
    counts.set(author, (counts.get(author) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([author, comments]) => ({ author, comments }));

  console.log(`  ${window.length} comments, ${ranked.length} distinct non-deleted authors`);
  return {
    threadId: THREAD_ID,
    sampledBefore: THREAD_SAMPLED_BEFORE,
    commentsRetrieved: window.length,
    distinctAuthors: ranked.length,
    rule: HUMAN_SELECTION_RULE,
    // Only as deep as the capture could ever reach. Publishing the whole
    // ranking would be publishing a list of 235 people who commented on one
    // political thread, which is not needed to reproduce anything.
    ranked: ranked.slice(0, HUMAN_COUNT + 8),
  };
}

async function getWithRetry(url) {
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

// ---------------------------------------------------------------------------

function summarize(verdict) {
  return {
    automation: { band: verdict.automation.band, score: verdict.automation.score },
    agenda: { band: verdict.agenda.band, score: verdict.agenda.score },
    authenticity: { band: verdict.authenticity.band, score: verdict.authenticity.score },
  };
}

function axisDrift(a, b) {
  const parts = [];
  for (const axis of ['automation', 'agenda', 'authenticity']) {
    if (a[axis].band !== b[axis].band || a[axis].score !== b[axis].score) {
      parts.push(`${axis} ${a[axis].band}/${a[axis].score}→${b[axis].band}/${b[axis].score}`);
    }
  }
  return parts.join(', ');
}

function bandLine(v) {
  return `automation ${v.automation.band} ${v.automation.score} · agenda ${v.agenda.band} ${v.agenda.score} · authenticity ${v.authenticity.band} ${v.authenticity.score}`;
}

/** Frozen nested objects -> plain JSON-able ones. */
function plain(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function normalize(name) {
  return name.trim().replace(/^\/?(?:u|user)\//i, '').toLowerCase();
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return { capturedWith: 'scripts/capture-corpus.mjs' };
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);
}

/**
 * Drop a stale entry. An account rejected by an older run of this script and
 * admitted by this one must stop being listed as rejected, or `npm run
 * evaluate` reports a bound that is no longer firing — which is the same
 * failure as not reporting one that is.
 */
function unnote(manifest, key, username) {
  if (manifest[key]) manifest[key] = manifest[key].filter((e) => e.username !== username);
}

function note(manifest, key, entry) {
  manifest[key] = (manifest[key] ?? []).filter((e) => e.username !== entry.username);
  manifest[key].push(entry);
  manifest[key].sort((a, b) => a.username.localeCompare(b.username));
}

await main();
