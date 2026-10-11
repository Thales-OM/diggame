'use strict';

// ---------- Configuration ----------
// Defaults live here and are the single source of truth. `.env` is optional and
// only ever *overrides* what is declared in SPEC, so the game always boots with
// sensible values even with no `.env` file at all.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

// key -> { default, type, min, max, choices, fatal, env }
const SPEC = {
  PORT:              { default: 3000,    type: 'num',  min: 1, max: 65535, fatal: true },
  HOST:              { default: '0.0.0.0', type: 'str' },
  DB_PATH:           { default: 'data/diggame.db', type: 'str', fatal: true },
  RESET_SECRET:      { default: '',      type: 'str' },
  // Guards the admin spectator view. Empty means the view is off entirely, so a
  // server that never sets it cannot leak the field to anyone. It is kept out
  // of clientConfig below and is never echoed back to a browser.
  ADMIN_SECRET:      { default: '',      type: 'str' },
  // How far below the deepest cell anybody has dug the admin view reaches. An
  // admin may lower or raise it per session, down to 0 and up to this ceiling.
  ADMIN_VIEW_MARGIN: { default: 30,     type: 'num',  min: 0, max: 500 },
  HALT_EXIT_DELAY_MS:{ default: 3000,    type: 'num',  min: 0, max: 60000 },

  WORLD_WIDTH:       { default: 50,      type: 'num',  min: 8, max: 500, fatal: true },
  SURFACE_Y:         { default: 0,       type: 'num',  min: -1000, max: 1000, fatal: true },
  WORLD_SEED:        { default: '',      type: 'str' },

  TICK_HZ:           { default: 10,      type: 'num',  min: 1, max: 60, fatal: true },
  SPECTATOR_HZ:      { default: 4,       type: 'num',  min: 1, max: 60 },
  DIG_TIME_MS:       { default: 900,     type: 'num',  min: 10, max: 60000, fatal: true },
  SHOVEL_DIG_TIME_MS:{ default: 200,     type: 'num',  min: 10, max: 60000 },
  SHOVEL_DURATION_MS:{ default: 60000,   type: 'num',  min: 100, max: 3600000 },
  STUCK_DURATION_MS: { default: 60000,   type: 'num',  min: 100, max: 3600000 },
  // How long a player is left standing in the spikes before the death lands.
  // Zero is allowed and means "die in the same tick, but still step in first".
  SPIKES_DEATH_DELAY_MS: { default: 350,  type: 'num',  min: 0, max: 5000 },
  RESPAWN_DELAY_MS:  { default: 1500,    type: 'num',  min: 0, max: 60000 },
  STATS_FLUSH_MS:    { default: 500,     type: 'num',  min: 50, max: 60000 },

  STONE_CHANCE_BASE:       { default: 0.02,  type: 'num', min: 0, max: 1 },
  STONE_CHANCE_PER_DEPTH:  { default: 0.003, type: 'num', min: 0, max: 1 },
  STONE_CHANCE_MAX:        { default: 0.35,  type: 'num', min: 0, max: 1 },
  SPIKE_CHANCE_BASE:       { default: 0.005, type: 'num', min: 0, max: 1 },
  SPIKE_CHANCE_PER_DEPTH:  { default: 0.0008,type: 'num', min: 0, max: 1 },
  SPIKE_CHANCE_MAX:        { default: 0.09,  type: 'num', min: 0, max: 1 },
  ITEM_CHANCE:             { default: 0.10,  type: 'num', min: 0, max: 1 },
  ITEM_CHANCE_PER_DEPTH:   { default: 0.004, type: 'num', min: 0, max: 1 },
  ITEM_CHANCE_MAX:         { default: 0.25,  type: 'num', min: 0, max: 1 },
  ITEM_BONUS_BASE:         { default: 0.05,  type: 'num', min: 0, max: 1 },
  ITEM_BONUS_PER_DEPTH:    { default: 0.02,  type: 'num', min: 0, max: 1 },
  ITEM_BONUS_MAX:          { default: 0.35,  type: 'num', min: 0, max: 1 },
  ITEM_WEIGHTS:            { default: 'armor:0.25,shovel:0.25,dynamite:0.2,trap:0.15,potion:0.15', type: 'str' },

  // ---------- gates, bosses and battle ----------
  // A bedrock gate band sits one row deep at every multiple of GATE_EVERY_N_DEPTH
  // below GATE_MIN_DEPTH, with a single seed-chosen gap. The gate boss lives in
  // the gap column just below its band. Minibosses are scattered single cells
  // with their eight neighbours already dug out, MINIBOSS_PER_REGION per gate
  // region, so they always sit inside the free area between two gates.
  GATE_EVERY_N_DEPTH:      { default: 25,    type: 'num', min: 2,   max: 500 },
  GATE_MIN_DEPTH:          { default: 25,    type: 'num', min: 1,   max: 500 },
  MINIBOSS_PER_REGION:     { default: 2,     type: 'num', min: 0,   max: 20 },

  BOSS_MINIBOSS_HP:        { default: 34,    type: 'num', min: 1,   max: 100000 },
  BOSS_MINIBOSS_ATTACK:    { default: 5,     type: 'num', min: 0,   max: 100000 },
  // A gate boss grows with the gate it guards: stronger the deeper you go.
  BOSS_BASE_HP:            { default: 70,    type: 'num', min: 1,   max: 100000 },
  BOSS_HP_PER_GATE:        { default: 45,    type: 'num', min: 0,   max: 100000 },
  BOSS_BASE_ATTACK:        { default: 7,     type: 'num', min: 0,   max: 100000 },
  BOSS_ATTACK_PER_GATE:    { default: 3,     type: 'num', min: 0,   max: 100000 },
  // Loot rolled from a defeated boss, normalized like ITEM_WEIGHTS.
  WEAPON_WEIGHTS:          { default: 'sword:0.5,rapier:0.3,staff:0.2', type: 'str' },
  BOSS_ITEM_WEIGHTS:       { default: 'potion:0.5,dynamite:0.25,trap:0.25', type: 'str' },

  BATTLE_BASE_HP:          { default: 30,    type: 'num', min: 1,   max: 100000 },
  BATTLE_BASE_ATTACK:      { default: 6,     type: 'num', min: 0,   max: 100000 },
  // One carried piece of field armour becomes this many battle armour points.
  // Spent points are gone, unspent ones turn back into whole pieces.
  BATTLE_ARMOUR_PER_ITEM:  { default: 8,     type: 'num', min: 1,   max: 1000 },
  BATTLE_BOMB_DAMAGE:      { default: 18,    type: 'num', min: 0,   max: 100000 },
  BATTLE_TRAP_DAMAGE:      { default: 14,    type: 'num', min: 0,   max: 100000 },
  BATTLE_TRAP_TRIGGER_CHANCE: { default: 0.5, type: 'num', min: 0,  max: 1 },
  BATTLE_ITEM_HEAL:        { default: 12,    type: 'num', min: 0,   max: 100000 },
  BATTLE_DEFEND_MULT:      { default: 0.5,   type: 'num', min: 0,   max: 1 },
  BATTLE_PARTY_MAX:        { default: 4,     type: 'num', min: 1,   max: 16 },
  BOSS_JOIN_WINDOW_MS:     { default: 15000, type: 'num', min: 0,   max: 120000 },
  BATTLE_TURN_MS:          { default: 12000, type: 'num', min: 500, max: 120000 },
  BATTLE_TICK_MS:          { default: 250,   type: 'num', min: 25,  max: 5000 },
  BATTLE_LOG_MAX:          { default: 8,     type: 'num', min: 1,   max: 100 },

  // SPEC: discovery is per player for now, with the switch left in place for
  // the day it should be shared. When true, a block one player finds is added
  // to everybody's map.
  SHARE_DISCOVERIES: { default: false, type: 'bool' },
  MAX_NAME_LENGTH:   { default: 16,   type: 'num', min: 1, max: 64 },
  EMOTE_DURATION_MS:  { default: 2500, type: 'num', min: 100, max: 10000 },
  EMOTE_COOLDOWN_MS:  { default: 1500, type: 'num', min: 0, max: 60000 },
};

const ITEM_IDS = ['armor', 'shovel', 'dynamite', 'trap', 'potion'];
const WEAPON_IDS = ['sword', 'rapier', 'staff'];

// The allowed ids for each `*_WEIGHTS` config key, so one parser can validate
// an item table, a weapon table and a boss-loot table without knowing which is
// which.
const WEIGHT_IDS = {
  ITEM_WEIGHTS: ITEM_IDS,
  WEAPON_WEIGHTS: WEAPON_IDS,
  BOSS_ITEM_WEIGHTS: ['potion', 'dynamite', 'trap'],
};

class ConfigError extends Error {}

function warn(warnings, msg) { warnings.push(msg); }

// Parse "armor:0.3,shovel:0.3" into a normalised weights object. `ids` is the
// set of names that may appear; anything else is a fatal config error.
function parseWeights(raw, ids = ITEM_IDS) {
  const out = {};
  let total = 0;
  for (const part of String(raw).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i < 0) throw new ConfigError(`weights entry "${s}" is not name:weight`);
    const name = s.slice(0, i).trim();
    const w = Number(s.slice(i + 1).trim());
    if (!ids.includes(name)) throw new ConfigError(`weights has unknown entry "${name}"`);
    if (!Number.isFinite(w) || w < 0) throw new ConfigError(`weight for "${name}" is not a number >= 0`);
    out[name] = w;
    total += w;
  }
  if (total <= 0) throw new ConfigError('weights must have a positive total');
  // Normalise to 1 so callers can just multiply a random number.
  for (const k of Object.keys(out)) out[k] /= total;
  for (const id of ids) if (out[id] === undefined) out[id] = 0;
  return out;
}

function coerce(name, spec, raw, warnings) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return spec.default;

  if (spec.type === 'num') {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) {
      warn(warnings, `config: ${name}="${raw}" is not a number, using default ${spec.default}`);
      return spec.default;
    }
    if (spec.min !== undefined && n < spec.min) {
      warn(warnings, `config: ${name}=${n} is below minimum ${spec.min}, using default ${spec.default}`);
      return spec.default;
    }
    if (spec.max !== undefined && n > spec.max) {
      warn(warnings, `config: ${name}=${n} is above maximum ${spec.max}, using default ${spec.default}`);
      return spec.default;
    }
    return n;
  }

  if (spec.type === 'bool') {
    const s = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    warn(warnings, `config: ${name}="${raw}" is not a boolean, using default ${spec.default}`);
    return spec.default;
  }

  return String(raw).trim();
}

// Minimal .env parser. Node's process.loadEnvFile() only ever writes into
// process.env, which makes "a real environment variable beats .env" impossible
// to express (and impossible to test), so we parse the file ourselves.
// Supported: comments, blank lines, `export ` prefix, CRLF, optional single or
// double quotes, escapes inside double quotes, and trailing comments after an
// unquoted value. A bare `KEY=` is an empty string, which the coercers treat as
// "not set".
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end < 0) {
        value = value.slice(1);
      } else {
        value = value.slice(1, end);
        if (quote === '"') value = value.replace(/\\(n|r|t|\\|")/g, (m, c) =>
          ({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' })[c]);
      }
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

// Read .env and layer it *under* the given environment, so a real environment
// variable always wins over the file and a missing file is a no-op.
function readEnvFile(file, base, warnings) {
  if (!file) return base;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return base; // no .env at all is perfectly normal
    warn(warnings, `config: could not read ${file} (${err.message}) - using defaults`);
    return base;
  }
  const fromFile = parseEnvFile(text);
  const merged = { ...fromFile, ...base };
  return merged;
}

/**
 * Build the config object.
 * @param {object} [opts]
 * @param {object|null} [opts.env]        environment to read (default process.env)
 * @param {string|null} [opts.envFile]    .env path, or null to skip file loading
 * @returns {{config: object, warnings: string[]}}
 */
function loadConfig(opts = {}) {
  const warnings = [];
  const base = { ...(opts.env || process.env) };
  const file = opts.envFile === undefined ? ENV_FILE : opts.envFile;
  const env = readEnvFile(file, base, warnings);

  const config = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    let value = coerce(name, spec, env[name], warnings);
    if (WEIGHT_IDS[name]) {
      try {
        value = parseWeights(value, WEIGHT_IDS[name]);
      } catch (err) {
        if (spec.fatal) throw new ConfigError(err.message);
        warn(warnings, `config: ${name}: ${err.message}, using default`);
        value = parseWeights(spec.default, WEIGHT_IDS[name]);
      }
    }
    config[name] = value;
  }

  // Cross-field sanity: a config that boots but cannot be played is fatal.
  if (config.SHOVEL_DIG_TIME_MS > config.DIG_TIME_MS) {
    warn(warnings, `config: SHOVEL_DIG_TIME_MS (${config.SHOVEL_DIG_TIME_MS}) exceeds DIG_TIME_MS (${config.DIG_TIME_MS}) - the golden shovel would be a downgrade`);
  }

  return { config: Object.freeze(config), warnings };
}

// The slice of config the browser is allowed to see. Never includes secrets or paths.
function clientConfig(config) {
  return {
    worldWidth: config.WORLD_WIDTH,
    surfaceY: config.SURFACE_Y,
    digTimeMs: config.DIG_TIME_MS,
    shovelDigTimeMs: config.SHOVEL_DIG_TIME_MS,
    shovelDurationMs: config.SHOVEL_DURATION_MS,
    stuckDurationMs: config.STUCK_DURATION_MS,
    spikesDeathDelayMs: config.SPIKES_DEATH_DELAY_MS,
    shareDiscoveries: config.SHARE_DISCOVERIES,
    adminViewMargin: config.ADMIN_VIEW_MARGIN,
    gateEveryNDepth: config.GATE_EVERY_N_DEPTH,
    battleTurnMs: config.BATTLE_TURN_MS,
    bossJoinWindowMs: config.BOSS_JOIN_WINDOW_MS,
    battlePartyMax: config.BATTLE_PARTY_MAX,
  };
}

// Resolve DB_PATH relative to the project root unless it is absolute.
function resolveDbPath(config) {
  const p = config.DB_PATH;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

module.exports = {
  loadConfig,
  clientConfig,
  resolveDbPath,
  parseEnvFile,
  parseWeights,
  ConfigError,
  SPEC,
  ROOT,
  ENV_FILE,
  ITEM_IDS,
  WEAPON_IDS,
  WEIGHT_IDS,
};
