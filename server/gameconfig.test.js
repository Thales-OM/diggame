'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadGameConfig, ConfigError, GAME_CONFIG_FILE, ITEM_IDS, WEAPON_IDS } = require('./gameconfig');

/** The shipped file, as a mutable object to poke holes in per test. */
function base() {
  return JSON.parse(fs.readFileSync(GAME_CONFIG_FILE, 'utf8'));
}

function writeJson(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diggame-game-'));
  const file = path.join(dir, 'game.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

const load = (obj) => loadGameConfig({ file: writeJson(obj) });

test('the shipped config loads and exposes every rule as a flat key', () => {
  const config = loadGameConfig({ file: GAME_CONFIG_FILE });
  assert.strictEqual(config.WORLD_WIDTH, 50);
  assert.strictEqual(config.MAX_HP, 30);
  assert.strictEqual(config.ARMOUR_POINTS_PER_ITEM, 8);
  assert.strictEqual(config.SKILL_KNIGHT_WEAPON_MULT, 1.3);
  assert.strictEqual(typeof config.SHARE_DISCOVERIES, 'boolean');
  assert.strictEqual(config.WEAPON_STATS.sword.damage, 6);
  assert.strictEqual(config.WEAPON_STATS.staff.skillMult, 2.5);
  assert.deepStrictEqual(config.SPECIES_STATS.miniboss.maggot, { hpMult: 0.8, atkMult: 0.8 });
});

test('weights are normalised and every allowed id is present', () => {
  const config = loadGameConfig({ file: GAME_CONFIG_FILE });
  for (const [key, ids] of [['ITEM_WEIGHTS', ITEM_IDS], ['WEAPON_WEIGHTS', ['sword', 'rapier', 'staff']]]) {
    const w = config[key];
    assert.deepStrictEqual(Object.keys(w).sort(), [...ids].sort(), `${key} lists every id`);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${key} sums to 1`);
  }
});

test('each weapon has exactly the fields it needs', () => {
  const config = loadGameConfig({ file: GAME_CONFIG_FILE });
  assert.deepStrictEqual(Object.keys(config.WEAPON_STATS).sort(), [...WEAPON_IDS].sort());
  for (const id of WEAPON_IDS) {
    const w = config.WEAPON_STATS[id];
    assert.strictEqual(typeof w.hit, 'number');
    assert.strictEqual(typeof w.damage, 'number');
    assert.strictEqual(typeof w.crit, 'number');
    assert.strictEqual(typeof w.critMult, 'number');
  }
  assert.strictEqual(typeof config.WEAPON_STATS.staff.skillMult, 'number');
});

test('a missing file is fatal', () => {
  const missing = path.join(os.tmpdir(), 'diggame-no-such-' + Date.now() + '.json');
  assert.throws(() => loadGameConfig({ file: missing }), ConfigError);
});

test('invalid JSON is fatal', () => {
  assert.throws(() => load('{ not json'), ConfigError);
});

test('a JSON value that is not an object is fatal', () => {
  assert.throws(() => load('[]'), ConfigError);
});

test('an unknown section is fatal', () => {
  const raw = base();
  raw.balance = {};
  assert.throws(() => load(raw), ConfigError);
});

test('an unknown key inside a section is fatal', () => {
  const raw = base();
  raw.world.gravity = 9.8;
  assert.throws(() => load(raw), ConfigError);
});

test('a missing key is fatal', () => {
  const raw = base();
  delete raw.battle.maxHp;
  assert.throws(() => load(raw), ConfigError);
});

test('a wrong type is fatal', () => {
  const raw = base();
  raw.battle.maxHp = 'thirty';
  assert.throws(() => load(raw), ConfigError);
});

test('an out-of-range value is fatal', () => {
  const raw = base();
  raw.world.itemChance.base = 5;
  assert.throws(() => load(raw), ConfigError);
});

test('a non-whole value for a whole-number setting is fatal', () => {
  const raw = base();
  raw.world.width = 50.5;
  assert.throws(() => load(raw), ConfigError);
});

test('the species list must match the client art, id for id and in order', () => {
  const raw = base();
  raw.species.miniboss[1].id = 'sprite';
  assert.throws(() => load(raw), ConfigError);

  const raw2 = base();
  raw2.species.gate.pop();
  assert.throws(() => load(raw2), ConfigError);
});

test('a weight with a zero total is fatal', () => {
  const raw = base();
  raw.world.itemWeights = { armor: 0, shovel: 0, dynamite: 0, trap: 0, potion: 0 };
  assert.throws(() => load(raw), ConfigError);
});

test('test overrides are validated and unknown keys are ignored', () => {
  const config = loadGameConfig({
    file: GAME_CONFIG_FILE,
    overrides: { MAX_HP: 99, NOT_A_RULE: 5 },
  });
  assert.strictEqual(config.MAX_HP, 99);
  assert.ok(!('NOT_A_RULE' in config));
  assert.throws(() => loadGameConfig({ file: GAME_CONFIG_FILE, overrides: { MAX_HP: -1 } }), ConfigError);
});
