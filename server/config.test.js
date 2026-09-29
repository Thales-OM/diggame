'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, clientConfig, resolveDbPath, parseEnvFile, parseWeights, ConfigError } = require('./config');

function tmpEnvFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diggame-cfg-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  return file;
}

test('defaults apply with no .env file at all', () => {
  const { config, warnings } = loadConfig({ env: {}, envFile: null });
  assert.strictEqual(config.WORLD_WIDTH, 50);
  assert.strictEqual(config.SURFACE_Y, 0);
  assert.strictEqual(config.DIG_TIME_MS, 900);
  assert.strictEqual(config.PORT, 3000);
  assert.strictEqual(config.SHARE_DISCOVERIES, false);
  assert.strictEqual(config.RESET_SECRET, '');
  assert.deepStrictEqual(warnings, []);
});

test('a missing .env file is not an error and is not even a warning', () => {
  const missing = path.join(os.tmpdir(), 'diggame-does-not-exist-' + Date.now(), '.env');
  const { config, warnings } = loadConfig({ env: {}, envFile: missing });
  assert.strictEqual(config.WORLD_WIDTH, 50);
  assert.deepStrictEqual(warnings, []);
});

test('the parser handles comments, quotes, export and CRLF', () => {
  const parsed = parseEnvFile([
    '# a comment',
    '',
    '  PLAIN=value  ',
    'export EXPORTED=yes',
    'SINGLE=\'raw $value\'',
    'DOUBLE="line\\nbreak"',
    'TRAILING=abc # comment here',
    'EMPTY=',
    'no_equals_sign',
    '1BAD=nope',
  ].join('\r\n'));
  assert.deepStrictEqual(parsed, {
    PLAIN: 'value',
    EXPORTED: 'yes',
    SINGLE: 'raw $value',
    DOUBLE: 'line\nbreak',
    TRAILING: 'abc',
    EMPTY: '',
  });
});

test('values are read from .env', () => {
  const file = tmpEnvFile([
    'WORLD_WIDTH=120',
    'DIG_TIME_MS=450',
    'SHARE_DISCOVERIES=true',
    'RESET_SECRET=  hunter2  ',
    '',
  ].join('\n'));
  const { config } = loadConfig({ env: {}, envFile: file });
  assert.strictEqual(config.WORLD_WIDTH, 120);
  assert.strictEqual(config.DIG_TIME_MS, 450);
  assert.strictEqual(config.SHARE_DISCOVERIES, true);
  assert.strictEqual(config.RESET_SECRET, 'hunter2');
});

test('a real environment variable beats .env', () => {
  const file = tmpEnvFile('WORLD_WIDTH=120\n');
  const { config } = loadConfig({ env: { WORLD_WIDTH: '33' }, envFile: file });
  assert.strictEqual(config.WORLD_WIDTH, 33);
});

test('boolean spellings', () => {
  for (const [raw, expected] of [['1', true], ['true', true], ['YES', true], ['on', true],
                                 ['0', false], ['false', false], ['no', false], ['off', false]]) {
    const { config } = loadConfig({ env: { SHARE_DISCOVERIES: raw }, envFile: null });
    assert.strictEqual(config.SHARE_DISCOVERIES, expected, `for ${raw}`);
  }
});

test('an unparseable value falls back to the default with a warning', () => {
  const { config, warnings } = loadConfig({ env: { DIG_TIME_MS: 'soon', SHARE_DISCOVERIES: 'maybe' }, envFile: null });
  assert.strictEqual(config.DIG_TIME_MS, 900);
  assert.strictEqual(config.SHARE_DISCOVERIES, false);
  assert.strictEqual(warnings.length, 2);
  assert.ok(warnings[0].includes('DIG_TIME_MS'));
});

test('out-of-range values fall back to the default', () => {
  const { config, warnings } = loadConfig({ env: { WORLD_WIDTH: '2', TICK_HZ: '9999' }, envFile: null });
  assert.strictEqual(config.WORLD_WIDTH, 50);
  assert.strictEqual(config.TICK_HZ, 10);
  assert.strictEqual(warnings.length, 2);
});

test('an empty value means "use the default"', () => {
  const { config } = loadConfig({ env: { WORLD_WIDTH: '', DB_PATH: '   ' }, envFile: null });
  assert.strictEqual(config.WORLD_WIDTH, 50);
  assert.strictEqual(config.DB_PATH, 'data/diggame.db');
});

test('ITEM_WEIGHTS parses and normalises', () => {
  const w = parseWeights('armor:1,shovel:1,dynamite:2');
  assert.strictEqual(w.armor, 0.25);
  assert.strictEqual(w.shovel, 0.25);
  assert.strictEqual(w.dynamite, 0.5);
  assert.strictEqual(w.trap, 0);
  assert.strictEqual(Object.values(w).reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
});

test('bad ITEM_WEIGHTS falls back to the default', () => {
  const { config, warnings } = loadConfig({ env: { ITEM_WEIGHTS: 'banana:1' }, envFile: null });
  assert.ok(config.ITEM_WEIGHTS.armor > 0);
  assert.ok(warnings.some((w) => w.includes('ITEM_WEIGHTS')));
});

test('ITEM_WEIGHTS with zero total throws', () => {
  assert.throws(() => parseWeights('armor:0'), ConfigError);
});

test('clientConfig hides secrets and paths', () => {
  const { config } = loadConfig({ env: { RESET_SECRET: 'shh', DB_PATH: '/var/lib/x.db' }, envFile: null });
  const cc = clientConfig(config);
  assert.strictEqual(cc.worldWidth, 50);
  assert.strictEqual(cc.surfaceY, 0);
  const serialised = JSON.stringify(cc);
  assert.ok(!serialised.includes('shh'));
  assert.ok(!serialised.includes('/var/lib'));
  assert.ok(!('RESET_SECRET' in cc));
  assert.ok(!('DB_PATH' in cc));
});

test('resolveDbPath is absolute and root-relative', () => {
  const { config } = loadConfig({ env: {}, envFile: null });
  assert.ok(path.isAbsolute(resolveDbPath(config)));
  const { config: abs } = loadConfig({ env: { DB_PATH: '/tmp/x.db' }, envFile: null });
  assert.strictEqual(resolveDbPath(abs), '/tmp/x.db');
});
