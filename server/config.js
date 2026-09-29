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
  ITEM_WEIGHTS:            { default: 'armor:0.3,shovel:0.3,dynamite:0.2,trap:0.2', type: 'str' },

  // SPEC: discovery is per player for now, with the switch left in place for
  // the day it should be shared. When true, a block one player finds is added
  // to everybody's map.
  SHARE_DISCOVERIES: { default: false, type: 'bool' },
  MAX_NAME_LENGTH:   { default: 16,   type: 'num', min: 1, max: 64 },
};

const ITEM_IDS = ['armor', 'shovel', 'dynamite', 'trap'];

class ConfigError extends Error {}

function warn(warnings, msg) { warnings.push(msg); }

// Parse "armor:0.3,shovel:0.3" into a normalised weights object.
function parseWeights(raw) {
  const out = {};
  let total = 0;
  for (const part of String(raw).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i < 0) throw new ConfigError(`ITEM_WEIGHTS entry "${s}" is not name:weight`);
    const name = s.slice(0, i).trim();
    const w = Number(s.slice(i + 1).trim());
    if (!ITEM_IDS.includes(name)) throw new ConfigError(`ITEM_WEIGHTS has unknown item "${name}"`);
    if (!Number.isFinite(w) || w < 0) throw new ConfigError(`ITEM_WEIGHTS weight for "${name}" is not a number >= 0`);
    out[name] = w;
    total += w;
  }
  if (total <= 0) throw new ConfigError('ITEM_WEIGHTS must have a positive total weight');
  // Normalise to 1 so callers can just multiply a random number.
  for (const k of Object.keys(out)) out[k] /= total;
  for (const id of ITEM_IDS) if (out[id] === undefined) out[id] = 0;
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
    if (name === 'ITEM_WEIGHTS') {
      try {
        value = parseWeights(value);
      } catch (err) {
        if (spec.fatal) throw new ConfigError(err.message);
        warn(warnings, `config: ${err.message}, using default`);
        value = parseWeights(spec.default);
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
    shareDiscoveries: config.SHARE_DISCOVERIES,
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
};
