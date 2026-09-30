'use strict';

// ---------- Storage ----------
// node:sqlite (built in). Synchronous on purpose: it keeps the whole game loop
// free of promises, so an action and its persistence happen in the same tick.
//
// Failure policy (SPEC): if the database cannot be opened, fails an integrity
// check, or throws during play, the game is a critical error. There is no
// in-memory fallback and no silent recreate - the caller is expected to halt.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;

// One step per version, applied in order, inside a transaction.
const MIGRATIONS = [
  function v1(db) {
    db.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE accounts (
        code         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        model_index  INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE player_stats (
        code            TEXT PRIMARY KEY REFERENCES accounts(code),
        max_depth       INTEGER NOT NULL DEFAULT 0,
        deaths          INTEGER NOT NULL DEFAULT 0,
        items_collected INTEGER NOT NULL DEFAULT 0,
        blocks_dug      INTEGER NOT NULL DEFAULT 0,
        runs_played     INTEGER NOT NULL DEFAULT 0,
        spikes_survived INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE worlds (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        seed        INTEGER NOT NULL,
        width       INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        status      TEXT NOT NULL DEFAULT 'active',
        config_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE run_stats (
        world_id         INTEGER NOT NULL REFERENCES worlds(id),
        code             TEXT NOT NULL REFERENCES accounts(code),
        max_depth        INTEGER NOT NULL DEFAULT 0,
        blocks_dug       INTEGER NOT NULL DEFAULT 0,
        deaths           INTEGER NOT NULL DEFAULT 0,
        items_collected  INTEGER NOT NULL DEFAULT 0,
        spikes_survived  INTEGER NOT NULL DEFAULT 0,
        finished_at      INTEGER,
        PRIMARY KEY (world_id, code)
      ) STRICT;

      CREATE INDEX idx_run_stats_world ON run_stats(world_id, max_depth DESC);
      CREATE INDEX idx_worlds_status ON worlds(status);
    `);
  },
  // The Rules dialog pops up automatically the first time somebody plays, and
  // this is what makes "the first time" a fact about the account rather than a
  // guess from their stats: a player who logged in and left again without
  // digging has still seen it.
  function v2(db) {
    db.exec('ALTER TABLE accounts ADD COLUMN rules_seen INTEGER NOT NULL DEFAULT 0');
  },
];

const ZERO_STATS = {
  maxDepth: 0,
  deaths: 0,
  itemsCollected: 0,
  blocksDug: 0,
  runsPlayed: 0,
  spikesSurvived: 0,
};

class StorageError extends Error {}

/**
 * Open (creating if needed) and migrate the database.
 * Throws StorageError on anything it cannot recover from - callers halt.
 *
 * @param {string} file     absolute path to the db file
 * @param {object} [opts]
 * @param {() => void} [opts.onFatal]  called instead of throwing on unexpected errors
 */
function openDatabase(file, opts = {}) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  let db;
  try {
    db = new DatabaseSync(file);
  } catch (err) {
    throw new StorageError(`cannot open database at ${file}: ${err.message}`);
  }

  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 3000');
  } catch (err) {
    try { db.close(); } catch { /* already broken */ }
    throw new StorageError(`cannot configure database at ${file}: ${err.message}`);
  }

  const integrity = db.prepare('PRAGMA integrity_check').get();
  const result = integrity && (integrity.integrity_check || integrity['integrity_check']);
  if (result !== 'ok') {
    try { db.close(); } catch { /* already broken */ }
    throw new StorageError(`integrity check failed for ${file}: ${result}`);
  }

  migrate(db);
  return wrap(db, opts);
}

function migrate(db) {
  const hasMeta = db.prepare(
    "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='meta'"
  ).get();
  if (!hasMeta || hasMeta.c === 0) {
    // Fresh file: run every migration from scratch.
    db.exec('BEGIN');
    try {
      for (const m of MIGRATIONS) m(db);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new StorageError(`initial migration failed: ${err.message}`);
    }
    return;
  }

  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new StorageError(
      `database schema is version ${current}, this build only understands ${SCHEMA_VERSION} - upgrade the server or point DB_PATH elsewhere`
    );
  }
  if (current === SCHEMA_VERSION) return;

  db.exec('BEGIN');
  try {
    for (let v = current; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new StorageError(`migration to version ${SCHEMA_VERSION} failed: ${err.message}`);
  }
}

// Wrap the raw handle so every statement is funnelled through one place that
// turns a driver error into a StorageError.
function wrap(db, opts = {}) {
  const onFatal = opts.onFatal || null;

  function guard(what, fn) {
    try {
      return fn();
    } catch (err) {
      if (err instanceof StorageError) throw err;
      const wrapped = new StorageError(`${what}: ${err.message}`);
      if (onFatal) { onFatal(wrapped); return null; }
      throw wrapped;
    }
  }

  const stmts = new Map();
  function prepared(sql) {
    let s = stmts.get(sql);
    if (!s) {
      s = guard('prepare', () => db.prepare(sql));
      stmts.set(sql, s);
    }
    return s;
  }
  // node:sqlite hands back null-prototype objects; normalise so callers can
  // deepEqual against literals and inherit Object.prototype as expected.
  const plain = (row) => (row == null ? row : Object.assign({}, row));
  const run = (sql, ...params) => guard('write', () => prepared(sql).run(...params));
  const get = (sql, ...params) => guard('read', () => {
    const row = prepared(sql).get(...params);
    return row === undefined ? undefined : plain(row);
  });
  const all = (sql, ...params) => guard('read', () => prepared(sql).all(...params).map(plain));

  const store = {
    raw: db,
    run,
    get,
    all,
    exec: (sql) => guard('exec', () => db.exec(sql)),

    // ---------- accounts ----------
    getAccount(code) {
      const row = get(
        'SELECT code, name, model_index AS modelIndex, rules_seen AS rulesSeen FROM accounts WHERE code = ?',
        code
      );
      // sqlite has no boolean, so the flag comes back as 0/1 and is normalised
      // here rather than leaking a number into the protocol
      return row ? { ...row, rulesSeen: !!row.rulesSeen } : row;
    },
    upsertAccount(code, name, modelIndex) {
      const now = Date.now();
      // rules_seen is deliberately absent from the upsert: logging in again
      // must not re-arm the first-run dialog
      run(
        `INSERT INTO accounts (code, name, model_index, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name,
                                        model_index = excluded.model_index,
                                        last_seen_at = excluded.last_seen_at`,
        code, name, modelIndex, now, now
      );
      return { code, name, modelIndex };
    },
    touchAccount(code) {
      run('UPDATE accounts SET last_seen_at = ? WHERE code = ?', Date.now(), code);
    },
    setModel(code, modelIndex) {
      run('UPDATE accounts SET model_index = ? WHERE code = ?', modelIndex, code);
    },
    markRulesSeen(code) {
      const res = run('UPDATE accounts SET rules_seen = 1 WHERE code = ?', code);
      return !!(res && res.changes > 0);
    },

    // ---------- lifetime stats ----------
    getStats(code) {
      const row = get(
        `SELECT max_depth AS maxDepth, deaths, items_collected AS itemsCollected,
                blocks_dug AS blocksDug, runs_played AS runsPlayed,
                spikes_survived AS spikesSurvived
           FROM player_stats WHERE code = ?`,
        code
      );
      return row || { ...ZERO_STATS };
    },
    // delta is a partial like { deaths: 1, maxDepth: 7 }; max_* use MAX() so a
    // counter can only go up.
    addStats(code, delta) {
      const d = delta || {};
      run(
        `INSERT INTO player_stats (code, max_depth, deaths, items_collected, blocks_dug,
                                   runs_played, spikes_survived, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           max_depth       = MAX(player_stats.max_depth, excluded.max_depth),
           deaths          = player_stats.deaths + excluded.deaths,
           items_collected = player_stats.items_collected + excluded.items_collected,
           blocks_dug      = player_stats.blocks_dug + excluded.blocks_dug,
           runs_played     = player_stats.runs_played + excluded.runs_played,
           spikes_survived = player_stats.spikes_survived + excluded.spikes_survived,
           updated_at      = excluded.updated_at`,
        code,
        d.maxDepth || 0, d.deaths || 0, d.itemsCollected || 0, d.blocksDug || 0,
        d.runsPlayed || 0, d.spikesSurvived || 0,
        Date.now()
      );
    },

    // ---------- worlds (runs) ----------
    openWorld(seed, width, configJson) {
      const now = Date.now();
      const info = run(
        "INSERT INTO worlds (seed, width, created_at, status, config_json) VALUES (?, ?, ?, 'active', ?)",
        seed, width, now, configJson
      );
      return { id: Number(info.lastInsertRowid), seed, width, createdAt: now, status: 'active' };
    },
    endWorld(id, status = 'ended') {
      run("UPDATE worlds SET status = ?, ended_at = ? WHERE id = ? AND status = 'active'", status, Date.now(), id);
    },
    currentWorld() {
      return get("SELECT id, seed, width, created_at AS createdAt FROM worlds WHERE status = 'active' ORDER BY id DESC LIMIT 1");
    },
    // A world left 'active' means the process died mid-run. The run itself is
    // ephemeral, so we only record that it never finished.
    abortStaleWorlds() {
      const info = run("UPDATE worlds SET status = 'aborted', ended_at = ? WHERE status = 'active'", Date.now());
      return Number(info.changes);
    },
    worldHistory(limit = 20) {
      return all(
        `SELECT id, seed, width, created_at AS createdAt, ended_at AS endedAt, status
           FROM worlds ORDER BY id DESC LIMIT ?`,
        limit
      );
    },

    // ---------- per-run stats ----------
    upsertRunStats(worldId, code, delta) {
      const d = delta || {};
      run(
        `INSERT INTO run_stats (world_id, code, max_depth, blocks_dug, deaths, items_collected, spikes_survived)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, code) DO UPDATE SET
           max_depth       = MAX(run_stats.max_depth, excluded.max_depth),
           blocks_dug      = run_stats.blocks_dug + excluded.blocks_dug,
           deaths          = run_stats.deaths + excluded.deaths,
           items_collected = run_stats.items_collected + excluded.items_collected,
           spikes_survived = run_stats.spikes_survived + excluded.spikes_survived`,
        worldId, code,
        d.maxDepth || 0, d.blocksDug || 0, d.deaths || 0, d.itemsCollected || 0, d.spikesSurvived || 0
      );
    },
    finaliseRunStats(worldId) {
      run('UPDATE run_stats SET finished_at = ? WHERE world_id = ? AND finished_at IS NULL', Date.now(), worldId);
    },
    standings(worldId) {
      return all(
        `SELECT code, max_depth AS maxDepth, blocks_dug AS blocksDug, deaths,
                items_collected AS itemsCollected, spikes_survived AS spikesSurvived
           FROM run_stats WHERE world_id = ? ORDER BY maxDepth DESC, blocksDug DESC`,
        worldId
      );
    },

    close() {
      stmts.clear();
      try { db.close(); } catch { /* shutting down anyway */ }
    },
  };

  return store;
}

module.exports = { openDatabase, StorageError, SCHEMA_VERSION, ZERO_STATS };
