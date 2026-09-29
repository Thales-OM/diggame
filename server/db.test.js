'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, StorageError } = require('./db');

function tmpFile(name = 'test.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diggame-db-'));
  return path.join(dir, name);
}

test('boot creates the database file and its directory', () => {
  const file = path.join(tmpFile(), 'nested', 'deep', 'dig.db');
  const db = openDatabase(file);
  assert.ok(fs.existsSync(file));
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  for (const t of ['accounts', 'meta', 'player_stats', 'run_stats', 'worlds']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.close();
});

test('migration is idempotent across reopens', () => {
  const file = tmpFile();
  openDatabase(file).close();
  const db = openDatabase(file);
  db.close();
  const again = openDatabase(file);
  const v = again.get("SELECT value FROM meta WHERE key='schema_version'");
  assert.strictEqual(Number(v.value), 1);
  again.close();
});

test('a corrupt file is a fatal StorageError, never a silent recreate', () => {
  const file = tmpFile('corrupt.db');
  fs.writeFileSync(file, 'this is definitely not a sqlite database');
  assert.throws(() => openDatabase(file), StorageError);
  // The bad file must still be there for a human to look at.
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'this is definitely not a sqlite database');
});

test('a database from a newer build refuses to open', () => {
  const file = tmpFile();
  const db = openDatabase(file);
  db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
  db.close();
  assert.throws(() => openDatabase(file), /schema is version 999/);
});

test('accounts round-trip and keep the latest model', () => {
  const db = openDatabase(':memory:');
  db.upsertAccount('CODE1', 'Alice', 0);
  assert.deepStrictEqual(db.getAccount('CODE1'), { code: 'CODE1', name: 'Alice', modelIndex: 0 });
  db.upsertAccount('CODE1', 'Alice Renamed', 3);
  assert.deepStrictEqual(db.getAccount('CODE1'), { code: 'CODE1', name: 'Alice Renamed', modelIndex: 3 });
  db.setModel('CODE1', 1);
  assert.strictEqual(db.getAccount('CODE1').modelIndex, 1);
  db.close();
});

test('a new account starts from zeroed stats', () => {
  const db = openDatabase(':memory:');
  assert.strictEqual(db.getStats('NOBODY').maxDepth, 0);
  assert.strictEqual(db.getStats('NOBODY').deaths, 0);
  db.close();
});

test('counters add up and max_depth only ever rises', () => {
  const db = openDatabase(':memory:');
  db.upsertAccount('C', 'n', 0);
  db.addStats('C', { deaths: 1, itemsCollected: 2, maxDepth: 5 });
  db.addStats('C', { deaths: 1, itemsCollected: 3, maxDepth: 3, blocksDug: 4 });
  const s = db.getStats('C');
  assert.strictEqual(s.deaths, 2);
  assert.strictEqual(s.itemsCollected, 5);
  assert.strictEqual(s.blocksDug, 4);
  assert.strictEqual(s.maxDepth, 5);
  db.close();
});

test('worlds: open, current, end, and stale worlds are aborted on boot', () => {
  const file = tmpFile();
  const db = openDatabase(file);
  assert.strictEqual(db.currentWorld(), undefined);
  const w1 = db.openWorld(111, 50, '{}');
  assert.strictEqual(db.currentWorld().id, w1.id);
  db.close();

  // Reopen: the world is still marked active, as if the process had crashed.
  const db2 = openDatabase(file);
  assert.strictEqual(db2.abortStaleWorlds(), 1);
  assert.strictEqual(db2.currentWorld(), undefined);
  const w2 = db2.openWorld(222, 50, '{}');
  db2.endWorld(w2.id);
  assert.strictEqual(db2.currentWorld(), undefined);
  const hist = db2.worldHistory(10);
  assert.deepStrictEqual(hist.map((h) => h.seed).sort((a, b) => a - b), [111, 222]);
  assert.strictEqual(hist.find((h) => h.seed === 111).status, 'aborted');
  assert.strictEqual(hist.find((h) => h.seed === 222).status, 'ended');
  db2.close();
});

test('run stats accumulate per world and are separate from lifetime stats', () => {
  const db = openDatabase(':memory:');
  db.upsertAccount('C', 'n', 0);
  const w = db.openWorld(7, 50, '{}');
  db.upsertRunStats(w.id, 'C', { maxDepth: 4, blocksDug: 4 });
  db.upsertRunStats(w.id, 'C', { maxDepth: 2, blocksDug: 3, deaths: 1 });
  const rows = db.standings(w.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].maxDepth, 4);
  assert.strictEqual(rows[0].blocksDug, 7);
  assert.strictEqual(rows[0].deaths, 1);
  assert.strictEqual(db.getStats('C').blocksDug, 0);
  db.close();
});

test('standings are ordered by depth then blocks dug', () => {
  const db = openDatabase(':memory:');
  for (const code of ['deep', 'shallow', 'busy']) db.upsertAccount(code, code, 0);
  const w = db.openWorld(7, 50, '{}');
  db.upsertRunStats(w.id, 'deep', { maxDepth: 9 });
  db.upsertRunStats(w.id, 'shallow', { maxDepth: 2 });
  db.upsertRunStats(w.id, 'busy', { maxDepth: 9, blocksDug: 50 });
  assert.deepStrictEqual(db.standings(w.id).map((r) => r.code), ['busy', 'deep', 'shallow']);
  db.close();
});

test('foreign keys are enforced', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => db.upsertRunStats(1, 'GHOST', { maxDepth: 1 }));
  db.close();
});

test('an onFatal handler turns write errors into a halt instead of a throw', () => {
  const fatal = [];
  const db = openDatabase(':memory:', { onFatal: (err) => fatal.push(err) });
  db.run('DROP TABLE accounts');
  const result = db.getAccount('ANYONE');
  assert.strictEqual(result, null);
  assert.ok(fatal.length >= 1);
  assert.ok(fatal[0] instanceof StorageError);
  db.close();
});

test('stats survive closing and reopening the file', () => {
  const file = tmpFile();
  const db = openDatabase(file);
  db.upsertAccount('KEEPER', 'Keeper', 2);
  db.addStats('KEEPER', { maxDepth: 12, deaths: 4 });
  db.close();

  const db2 = openDatabase(file);
  assert.deepStrictEqual(db2.getAccount('KEEPER'), { code: 'KEEPER', name: 'Keeper', modelIndex: 2 });
  assert.strictEqual(db2.getStats('KEEPER').maxDepth, 12);
  assert.strictEqual(db2.getStats('KEEPER').deaths, 4);
  db2.close();
});
