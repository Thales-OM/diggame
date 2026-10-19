'use strict';

// ---------- Configuration ----------
// Two files, two jobs, and a hard line between them.
//
//   config/game.json   every rule number: the pit, its odds, gates, bosses,
//                      battle maths, weapons, skills. Mandatory and strict;
//                      server/gameconfig.js owns it. A missing or malformed file
//                      stops the server (SPEC).
//
//   .env               infrastructure only: where to listen, where the database
//                      lives, secrets, tick rates. Optional, and every value has
//                      a sane default here. A value that is not a number /
//                      boolean, or is out of range, falls back to the default
//                      with a warning - an unusable port should not be a crash.
//
// loadConfig() merges the two into one frozen object, so the rest of the server
// reads a single `config` with the same key names it always has.

const fs = require('fs');
const path = require('path');

const { loadGameConfig, ConfigError } = require('./gameconfig');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

// key -> { default, type, min, max, fatal, env }
const SPEC = {
  PORT:              { default: 3000,    type: 'num',  min: 1, max: 65535, fatal: true },
  HOST:              { default: '0.0.0.0', type: 'str' },
  DB_PATH:           { default: 'data/diggame.db', type: 'str', fatal: true },
  // Where the rules file lives. It is a path, not a rule, so it stays an
  // environment setting; relative paths resolve from the project root.
  GAME_CONFIG:       { default: 'config/game.json', type: 'str' },
  // The build identity shown in the client's corner. The release image sets it
  // from the git tag; empty means "derive it" (server/version.js falls back to
  // package.json). It is not a rule, so it lives here.
  APP_VERSION:       { default: '',      type: 'str' },
  RESET_SECRET:      { default: '',      type: 'str' },
  // Guards the admin spectator view. Empty means the view is off entirely, so a
  // server that never sets it cannot leak the field to anyone. It is kept out
  // of clientConfig below and is never echoed back to a browser.
  ADMIN_SECRET:      { default: '',      type: 'str' },
  // How far below the deepest cell anybody has dug the admin view reaches. An
  // admin may lower or raise it per session, down to 0 and up to this ceiling.
  ADMIN_VIEW_MARGIN: { default: 30,     type: 'num',  min: 0, max: 500 },
  HALT_EXIT_DELAY_MS:{ default: 3000,    type: 'num',  min: 0, max: 60000 },

  // Pin the world seed for reproducible worlds. A rules-like value, but it is a
  // property of the process that opens a run, not of how the game plays.
  WORLD_SEED:        { default: '',      type: 'str' },

  TICK_HZ:           { default: 10,      type: 'num',  min: 1, max: 60, fatal: true },
  SPECTATOR_HZ:      { default: 4,       type: 'num',  min: 1, max: 60 },
  STATS_FLUSH_MS:    { default: 500,     type: 'num',  min: 50, max: 60000 },
};

function warn(warnings, msg) { warnings.push(msg); }

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
 * Build the config object: infrastructure from the environment, rules from
 * config/game.json.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.env]            environment to read (default process.env)
 * @param {string|null} [opts.envFile]        .env path, or null to skip file loading
 * @param {string} [opts.gameFile]            game config path (default config/game.json)
 * @param {object} [opts.gameOverrides]       test-only flat-key rule overrides
 * @returns {{config: object, warnings: string[]}}
 * @throws {ConfigError} when the game config is missing or invalid
 */
function loadConfig(opts = {}) {
  const warnings = [];
  const base = { ...(opts.env || process.env) };
  const file = opts.envFile === undefined ? ENV_FILE : opts.envFile;
  const env = readEnvFile(file, base, warnings);

  const config = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    config[name] = coerce(name, spec, env[name], warnings);
  }

  const gameFile = opts.gameFile === undefined ? resolveGamePath(config) : opts.gameFile;
  const game = loadGameConfig({ file: gameFile, overrides: opts.gameOverrides });
  Object.assign(config, game);

  return { config: Object.freeze(config), warnings };
}

// Resolve GAME_CONFIG relative to the project root unless it is absolute.
function resolveGamePath(config) {
  const p = config.GAME_CONFIG;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
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
    battleBossTurnMs: config.BATTLE_BOSS_TURN_MS,
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
  ConfigError,
  SPEC,
  ROOT,
  ENV_FILE,
};
