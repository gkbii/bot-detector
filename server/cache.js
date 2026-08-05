// The shared lookup cache -- one of exactly two things this optional server
// adds over the extension running alone (the other is the Claude read). A
// lookup done on the laptop is free on the desktop because both point at the
// same backend, and the expensive half of that lookup outlives the cheap half.
//
// `node:sqlite`, not better-sqlite3: this repo uses Node's built-ins wherever
// reasonable and deliberately avoids npm dependencies that need a compiler
// toolchain (see the root CLAUDE.md). Same choice as task-runner's db.js,
// gameStore.js and vintageStore.js.
//
// A SEPARATE .db FILE from anything else in the repo. This is a rebuildable
// cache -- delete it and every entry regenerates from a Reddit fetch and, at
// worst, one Claude call -- not operational state. Mixing it into tasks.db
// would make "clear the cache" a dangerous operation.
//
// PRIVACY, AND WHY EXPIRY IS A DELETE. Only public data is ever stored here,
// but `profiles` rows hold comment BODIES, and the rule for this project is
// that comment text does not outlive its cache TTL. So expiry is not "ignore
// the row on read" -- `purgeExpired()` physically deletes it, and it runs on
// open and after every write. A row whose TTL has passed is gone from disk,
// not merely invisible. Nothing in here is ever logged.
//
// THREE TABLES, THREE LIFETIMES -- the same split reasoning as the chess and
// vintage stores. A profile is one Reddit fetch; a verdict is a pure function
// of that profile and is cheap to recompute; an LLM read is an Opus call. They
// expire independently, so a stale verdict never drags a still-valid LLM read
// down with it, and a `deep` request that finds a live profile never refetches.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

const SCHEMA_VERSION = 1;

function ensureDir(filePath) {
  if (filePath === ':memory:') return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export class Cache {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbPath] - defaults to config.dbPath; ':memory:' in tests.
   * @param {() => number} [opts.now] - injectable clock (seconds), for expiry tests.
   */
  constructor({ dbPath = config.dbPath, now = nowSeconds } = {}) {
    ensureDir(dbPath);
    this.dbPath = dbPath;
    this.now = now;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.#migrate();
    this.purgeExpired();
  }

  #migrate() {
    // One shape for all three tables: a (platform, username) key, a stored
    // JSON payload, and an absolute expiry. Only the TTL that produced
    // `expires_at` differs between them.
    for (const table of ['profiles', 'verdicts', 'llm_reads']) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          platform TEXT NOT NULL,
          username TEXT NOT NULL,
          payload TEXT NOT NULL,
          stored_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (platform, username)
        )
      `);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${table}_expires ON ${table} (expires_at)`
      );
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Usernames are case-insensitive on Reddit; the cache key follows. */
  #key(username) {
    return String(username).toLowerCase();
  }

  #get(table, platform, username) {
    const row = this.db
      .prepare(
        `SELECT payload, stored_at, expires_at FROM ${table}
          WHERE platform = ? AND username = ?`
      )
      .get(platform, this.#key(username));
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      // Miss AND remove: an expired profile still holds comment bodies, and
      // the retention rule is about what is on disk, not what is returned.
      this.db
        .prepare(`DELETE FROM ${table} WHERE platform = ? AND username = ?`)
        .run(platform, this.#key(username));
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // A corrupt row is a cache miss, not a crash -- everything here is
      // regenerable by definition.
      return null;
    }
    return { value: payload, storedAt: row.stored_at, expiresAt: row.expires_at };
  }

  #put(table, platform, username, value, ttlSeconds) {
    const storedAt = this.now();
    const expiresAt = storedAt + ttlSeconds;
    this.db
      .prepare(
        `INSERT INTO ${table} (platform, username, payload, stored_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (platform, username) DO UPDATE SET
           payload = excluded.payload,
           stored_at = excluded.stored_at,
           expires_at = excluded.expires_at`
      )
      .run(platform, this.#key(username), JSON.stringify(value), storedAt, expiresAt);
    this.purgeExpired();
    return { storedAt, expiresAt };
  }

  getProfile(platform, username) {
    return this.#get('profiles', platform, username);
  }

  putProfile(platform, username, profile, ttlSeconds = config.profileTtlSeconds) {
    return this.#put('profiles', platform, username, profile, ttlSeconds);
  }

  getVerdict(platform, username) {
    return this.#get('verdicts', platform, username);
  }

  putVerdict(platform, username, verdict, ttlSeconds = config.verdictTtlSeconds) {
    return this.#put('verdicts', platform, username, verdict, ttlSeconds);
  }

  getLlmRead(platform, username) {
    return this.#get('llm_reads', platform, username);
  }

  putLlmRead(platform, username, read, ttlSeconds = config.llmTtlSeconds) {
    return this.#put('llm_reads', platform, username, read, ttlSeconds);
  }

  /**
   * Deletes every expired row across all three tables. Called on open and
   * after each write; see the privacy note in this file's header for why this
   * is a delete rather than a read-time filter.
   */
  purgeExpired() {
    const cutoff = this.now();
    let removed = 0;
    for (const table of ['profiles', 'verdicts', 'llm_reads']) {
      const result = this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(cutoff);
      removed += Number(result.changes || 0);
    }
    return removed;
  }

  /** Test/ops helper: forget one account across all three tables. */
  forget(platform, username) {
    let removed = 0;
    for (const table of ['profiles', 'verdicts', 'llm_reads']) {
      const result = this.db
        .prepare(`DELETE FROM ${table} WHERE platform = ? AND username = ?`)
        .run(platform, this.#key(username));
      removed += Number(result.changes || 0);
    }
    return removed;
  }

  stats() {
    const out = {};
    for (const table of ['profiles', 'verdicts', 'llm_reads']) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      out[table] = Number(row.n || 0);
    }
    return out;
  }

  close() {
    this.db.close();
  }
}

export { SCHEMA_VERSION };
