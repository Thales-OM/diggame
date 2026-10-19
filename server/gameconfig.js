'use strict';

// ---------- Game configuration ----------
// Every rule number lives in config/game.json: the pit's shape and odds, the
// gates and bosses, the battle maths, the weapon/species/skill numbers. The file
// is mandatory and strict. A missing file, invalid JSON, an unknown key, a wrong
// type or an out-of-range value stops the server at boot. There are no silent
// defaults and no environment overrides: this file is the single source of truth
// for how the game plays. Infrastructure that is not a rule - the port, the
// database path, secrets - stays in the environment (see server/config.js).

const fs = require('fs');
const path = require('path');

const { MINIBOSS_SPECIES, GATE_SPECIES } = require('./content/monsters');

const ROOT = path.resolve(__dirname, '..');
const GAME_CONFIG_FILE = path.join(ROOT, 'config', 'game.json');

const ITEM_IDS = ['armor', 'shovel', 'dynamite', 'trap', 'potion'];
const WEAPON_IDS = ['bare', 'sword', 'rapier', 'staff'];
const LOOT_WEAPON_IDS = ['sword', 'rapier', 'staff'];
const BOSS_ITEM_IDS = ['potion', 'dynamite', 'trap'];

class ConfigError extends Error {}

// ---------- leaf spec builders ----------
const num = (key, opts = {}) => ({ kind: 'num', key, ...opts });
const bool = (key) => ({ kind: 'bool', key });
const weights = (key, ids) => ({ kind: 'weights', key, ids });
const obj = (children) => ({ kind: 'object', children });

function chance(key) { return num(key, { min: 0, max: 1 }); }

// The schema mirrors config/game.json exactly. Each leaf names the flat key the
// rest of the server already reads, so nothing outside this file has to know the
// file's shape. An unknown key anywhere is fatal.
const SECTIONS = {
  world: obj({
    width: num('WORLD_WIDTH', { min: 8, max: 500, integer: true }),
    surfaceY: num('SURFACE_Y', { min: -1000, max: 1000, integer: true }),
    stoneChance: obj({
      base: chance('STONE_CHANCE_BASE'),
      perDepth: chance('STONE_CHANCE_PER_DEPTH'),
      max: chance('STONE_CHANCE_MAX'),
    }),
    spikeChance: obj({
      base: chance('SPIKE_CHANCE_BASE'),
      perDepth: chance('SPIKE_CHANCE_PER_DEPTH'),
      max: chance('SPIKE_CHANCE_MAX'),
    }),
    itemChance: obj({
      base: chance('ITEM_CHANCE'),
      perDepth: chance('ITEM_CHANCE_PER_DEPTH'),
      max: chance('ITEM_CHANCE_MAX'),
    }),
    itemBonus: obj({
      base: chance('ITEM_BONUS_BASE'),
      perDepth: chance('ITEM_BONUS_PER_DEPTH'),
      max: chance('ITEM_BONUS_MAX'),
    }),
    itemWeights: weights('ITEM_WEIGHTS', ITEM_IDS),
    shareDiscoveries: bool('SHARE_DISCOVERIES'),
  }),

  timing: obj({
    digTimeMs: num('DIG_TIME_MS', { min: 10, max: 60000 }),
    shovelDigTimeMs: num('SHOVEL_DIG_TIME_MS', { min: 10, max: 60000 }),
    shovelDurationMs: num('SHOVEL_DURATION_MS', { min: 100, max: 3600000 }),
    stuckDurationMs: num('STUCK_DURATION_MS', { min: 100, max: 3600000 }),
    spikesDeathDelayMs: num('SPIKES_DEATH_DELAY_MS', { min: 0, max: 5000 }),
    respawnDelayMs: num('RESPAWN_DELAY_MS', { min: 0, max: 60000 }),
    maxNameLength: num('MAX_NAME_LENGTH', { min: 1, max: 64, integer: true }),
    emoteDurationMs: num('EMOTE_DURATION_MS', { min: 100, max: 10000 }),
    emoteCooldownMs: num('EMOTE_COOLDOWN_MS', { min: 0, max: 60000 }),
  }),

  gates: obj({
    everyNDepth: num('GATE_EVERY_N_DEPTH', { min: 2, max: 500, integer: true }),
    minDepth: num('GATE_MIN_DEPTH', { min: 1, max: 500, integer: true }),
    minibossPerRegion: num('MINIBOSS_PER_REGION', { min: 0, max: 20, integer: true }),
    speciesTierDepth: num('BOSS_SPECIES_TIER_DEPTH', { min: 1, max: 1000, integer: true }),
  }),

  bosses: obj({
    minibossHp: num('BOSS_MINIBOSS_HP', { min: 1, max: 100000 }),
    minibossAttack: num('BOSS_MINIBOSS_ATTACK', { min: 0, max: 100000 }),
    gateBaseHp: num('BOSS_BASE_HP', { min: 1, max: 100000 }),
    gateHpPerGate: num('BOSS_HP_PER_GATE', { min: 0, max: 100000 }),
    gateBaseAttack: num('BOSS_BASE_ATTACK', { min: 0, max: 100000 }),
    gateAttackPerGate: num('BOSS_ATTACK_PER_GATE', { min: 0, max: 100000 }),
    weaponWeights: weights('WEAPON_WEIGHTS', LOOT_WEAPON_IDS),
    itemWeights: weights('BOSS_ITEM_WEIGHTS', BOSS_ITEM_IDS),
  }),

  battle: obj({
    // the one pool of health a player has, on the field and in a fight alike
    maxHp: num('MAX_HP', { min: 1, max: 100000 }),
    baseAttack: num('BATTLE_BASE_ATTACK', { min: 0, max: 100000 }),
    // points of protection one armour pickup is worth, and what one spike strike
    // takes off the combined armour-then-health pool
    armourPointsPerItem: num('ARMOUR_POINTS_PER_ITEM', { min: 1, max: 1000 }),
    bombDamage: num('BATTLE_BOMB_DAMAGE', { min: 0, max: 100000 }),
    trapDamage: num('BATTLE_TRAP_DAMAGE', { min: 0, max: 100000 }),
    trapTriggerChance: chance('BATTLE_TRAP_TRIGGER_CHANCE'),
    itemHeal: num('ITEM_HEAL', { min: 0, max: 100000 }),
    defendMult: num('BATTLE_DEFEND_MULT', { min: 0, max: 1 }),
    partyMax: num('BATTLE_PARTY_MAX', { min: 1, max: 16, integer: true }),
    joinWindowMs: num('BOSS_JOIN_WINDOW_MS', { min: 0, max: 120000 }),
    turnMs: num('BATTLE_TURN_MS', { min: 500, max: 120000 }),
    bossTurnMs: num('BATTLE_BOSS_TURN_MS', { min: 0, max: 60000 }),
    tickMs: num('BATTLE_TICK_MS', { min: 25, max: 5000 }),
    logMax: num('BATTLE_LOG_MAX', { min: 1, max: 100, integer: true }),
  }),

  skills: obj({
    knightWeaponMult: num('SKILL_KNIGHT_WEAPON_MULT', { min: 1, max: 10 }),
    barbarianBareMult: num('SKILL_BARBARIAN_BARE_MULT', { min: 1, max: 10 }),
    battleCryHeal: chance('SKILL_BATTLE_CRY_HEAL'),
    nobleBuffMult: num('SKILL_NOBLE_BUFF_MULT', { min: 1, max: 10 }),
    nobleHpCost: chance('SKILL_NOBLE_HP_COST'),
    banditHitBonus: chance('SKILL_BANDIT_HIT_BONUS'),
    banditTurns: num('SKILL_BANDIT_TURNS', { min: 1, max: 10, integer: true }),
  }),
};

// weapon id -> { hit, damage, crit, critMult, [skillMult, chargeCrit] }
const WEAPON_FIELDS = ['hit', 'damage', 'crit', 'critMult'];
const WEAPON_RANGES = {
  hit: { min: 0, max: 1 },
  damage: { min: 0, max: 100000 },
  crit: { min: 0, max: 1 },
  critMult: { min: 1, max: 1000 },
  skillMult: { min: 1, max: 100 },
  chargeCrit: { min: 0, max: 1 },
};

// Every leaf spec, by the flat key it produces, so a test-only override can be
// checked exactly as the file would be.
const LEAF_BY_KEY = {};
(function index(node) {
  if (node.kind === 'object') { for (const c of Object.values(node.children)) index(c); return; }
  LEAF_BY_KEY[node.key] = node;
})(obj(SECTIONS));

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function toNumber(raw, path) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim());
  throw new ConfigError(`game config: "${path}" must be a number`);
}

function coerceLeaf(spec, raw, path) {
  if (spec.kind === 'num') {
    const n = toNumber(raw, path);
    if (!Number.isFinite(n)) throw new ConfigError(`game config: "${path}" must be a finite number`);
    if (spec.integer && !Number.isInteger(n)) throw new ConfigError(`game config: "${path}" must be a whole number`);
    if (spec.min !== undefined && n < spec.min) throw new ConfigError(`game config: "${path}" is below the minimum ${spec.min}`);
    if (spec.max !== undefined && n > spec.max) throw new ConfigError(`game config: "${path}" is above the maximum ${spec.max}`);
    return n;
  }
  if (spec.kind === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const s = raw.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
    }
    throw new ConfigError(`game config: "${path}" must be true or false`);
  }
  if (spec.kind === 'weights') {
    if (!isPlainObject(raw)) throw new ConfigError(`game config: "${path}" must be an object of weights`);
    const out = {};
    let total = 0;
    for (const id of spec.ids) {
      if (!(id in raw)) throw new ConfigError(`game config: "${path}" is missing the weight for "${id}"`);
      const n = toNumber(raw[id], `${path}.${id}`);
      if (!Number.isFinite(n) || n < 0) throw new ConfigError(`game config: "${path}.${id}" must be a number >= 0`);
      out[id] = n;
      total += n;
    }
    for (const id of Object.keys(raw)) {
      if (!spec.ids.includes(id)) throw new ConfigError(`game config: "${path}" has an unknown entry "${id}"`);
    }
    if (total <= 0) throw new ConfigError(`game config: "${path}" must have a positive total`);
    for (const id of spec.ids) out[id] /= total;
    return out;
  }
  throw new ConfigError(`game config: internal error for "${path}"`);
}

function validateNode(node, value, path, out) {
  if (node.kind === 'object') {
    if (!isPlainObject(value)) throw new ConfigError(`game config: "${path}" must be an object`);
    for (const [key, child] of Object.entries(node.children)) {
      if (!(key in value)) throw new ConfigError(`game config: "${path}.${key}" is missing`);
      validateNode(child, value[key], `${path}.${key}`, out);
    }
    for (const key of Object.keys(value)) {
      if (!(key in node.children)) throw new ConfigError(`game config: "${path}.${key}" is not a known setting`);
    }
    return;
  }
  out[node.key] = coerceLeaf(node, value, path);
}

function readWeapons(raw) {
  if (raw === undefined) throw new ConfigError('game config: "weapons" is missing');
  if (!isPlainObject(raw)) throw new ConfigError('game config: "weapons" must be an object');
  for (const id of Object.keys(raw)) {
    if (!WEAPON_IDS.includes(id)) throw new ConfigError(`game config: "weapons.${id}" is not a known weapon`);
  }
  const out = {};
  for (const id of WEAPON_IDS) {
    if (!(id in raw)) throw new ConfigError(`game config: "weapons.${id}" is missing`);
    const w = raw[id];
    if (!isPlainObject(w)) throw new ConfigError(`game config: "weapons.${id}" must be an object`);
    const fields = id === 'staff' ? [...WEAPON_FIELDS, 'skillMult', 'chargeCrit'] : WEAPON_FIELDS;
    for (const f of fields) {
      if (!(f in w)) throw new ConfigError(`game config: "weapons.${id}.${f}" is missing`);
    }
    for (const f of Object.keys(w)) {
      if (!fields.includes(f)) throw new ConfigError(`game config: "weapons.${id}.${f}" is not a known field`);
    }
    const stat = {};
    for (const f of fields) {
      const n = toNumber(w[f], `weapons.${id}.${f}`);
      const r = WEAPON_RANGES[f];
      if (!Number.isFinite(n) || n < r.min || n > r.max) {
        throw new ConfigError(`game config: "weapons.${id}.${f}" must be between ${r.min} and ${r.max}`);
      }
      stat[f] = n;
    }
    out[id] = stat;
  }
  return out;
}

function readSpecies(raw) {
  if (raw === undefined) throw new ConfigError('game config: "species" is missing');
  if (!isPlainObject(raw)) throw new ConfigError('game config: "species" must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'miniboss' && key !== 'gate') throw new ConfigError(`game config: "species.${key}" is not a known group`);
  }
  const out = {};
  for (const [group, template] of [['miniboss', MINIBOSS_SPECIES], ['gate', GATE_SPECIES]]) {
    const list = raw[group];
    if (!Array.isArray(list)) throw new ConfigError(`game config: "species.${group}" must be an array`);
    if (list.length !== template.length) {
      throw new ConfigError(`game config: "species.${group}" must list the ${template.length} species in order`);
    }
    const byId = {};
    template.forEach((tpl, i) => {
      const entry = list[i];
      const where = `species.${group}[${i}]`;
      if (!isPlainObject(entry)) throw new ConfigError(`game config: "${where}" must be an object`);
      if (entry.id !== tpl.id) {
        throw new ConfigError(`game config: "${where}.id" must be "${tpl.id}" to match the client's art`);
      }
      for (const f of ['hpMult', 'atkMult']) {
        if (!(f in entry)) throw new ConfigError(`game config: "${where}.${f}" is missing`);
      }
      for (const f of Object.keys(entry)) {
        if (f !== 'id' && f !== 'hpMult' && f !== 'atkMult') throw new ConfigError(`game config: "${where}.${f}" is not a known field`);
      }
      const hpMult = toNumber(entry.hpMult, `${where}.hpMult`);
      const atkMult = toNumber(entry.atkMult, `${where}.atkMult`);
      if (!Number.isFinite(hpMult) || hpMult <= 0) throw new ConfigError(`game config: "${where}.hpMult" must be a number > 0`);
      if (!Number.isFinite(atkMult) || atkMult < 0) throw new ConfigError(`game config: "${where}.atkMult" must be a number >= 0`);
      byId[tpl.id] = { hpMult, atkMult };
    });
    out[group] = byId;
  }
  return out;
}

// Parse "dynamite:1,trap:1" into weights, for the test-only override path. Rows
// a name the file would not list are an error; names left out weigh zero.
function parseWeightString(raw, ids, path) {
  const out = {};
  let total = 0;
  for (const part of String(raw).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i < 0) throw new ConfigError(`game config: "${path}" entry "${s}" is not name:weight`);
    const name = s.slice(0, i).trim();
    const w = Number(s.slice(i + 1).trim());
    if (!ids.includes(name)) throw new ConfigError(`game config: "${path}" has an unknown entry "${name}"`);
    if (!Number.isFinite(w) || w < 0) throw new ConfigError(`game config: "${path}.${name}" must be a number >= 0`);
    out[name] = w;
    total += w;
  }
  if (total <= 0) throw new ConfigError(`game config: "${path}" must have a positive total`);
  for (const id of Object.keys(out)) out[id] /= total;
  for (const id of ids) if (out[id] === undefined) out[id] = 0;
  return out;
}

/**
 * Apply test-only overrides on top of a validated config. Overrides name the
 * flat keys directly. Unknown keys are ignored so a test helper can pass a bag
 * of settings that mixes game and infrastructure without tripping the strict
 * file loader. Values are checked exactly as the file's would be, except that a
 * weight may be given in the compact "id:weight" string form for convenience.
 */
function applyOverrides(out, overrides) {
  for (const [key, raw] of Object.entries(overrides || {})) {
    const spec = LEAF_BY_KEY[key];
    if (!spec) continue;
    if (spec.kind === 'weights' && typeof raw === 'string') {
      out[key] = parseWeightString(raw, spec.ids, key);
    } else {
      out[key] = coerceLeaf(spec, raw, key);
    }
  }
  return out;
}

/**
 * Load and validate config/game.json.
 * @param {object} [opts]
 * @param {string} [opts.file]           path to the game config (default config/game.json)
 * @param {object} [opts.overrides]      test-only flat-key overrides
 * @returns {object} the frozen flat game config
 * @throws {ConfigError} on any problem at all
 */
function loadGameConfig(opts = {}) {
  const file = opts.file === undefined ? GAME_CONFIG_FILE : opts.file;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'the file is missing' : err.message;
    throw new ConfigError(`game config ${file}: ${why}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`game config ${file} is not valid JSON: ${err.message}`);
  }
  if (!isPlainObject(raw)) throw new ConfigError(`game config ${file} must contain a JSON object`);

  for (const key of Object.keys(raw)) {
    if (!(key in SECTIONS) && key !== 'weapons' && key !== 'species') {
      throw new ConfigError(`game config: "${key}" is not a known section`);
    }
  }

  const out = {};
  for (const [name, node] of Object.entries(SECTIONS)) {
    if (!(name in raw)) throw new ConfigError(`game config: section "${name}" is missing`);
    validateNode(node, raw[name], name, out);
  }
  out.WEAPON_STATS = readWeapons(raw.weapons);
  out.SPECIES_STATS = readSpecies(raw.species);

  applyOverrides(out, opts.overrides);
  return Object.freeze(out);
}

module.exports = {
  loadGameConfig,
  GAME_CONFIG_FILE,
  ConfigError,
  SECTIONS,
  ITEM_IDS,
  WEAPON_IDS,
  LOOT_WEAPON_IDS,
  BOSS_ITEM_IDS,
};
