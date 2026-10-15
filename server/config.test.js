'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, clientConfig, resolveDbPath, parseEnvFile, ConfigError } = require('./config');

function tmpEnvFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diggame-cfg-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  return file;
}

test('defaults apply with no .env file at all', () => {
  const { config, warnings } = loadConfig({ env: {}, envFile: null });
  assert.strictEqual(config.PORT, 3000);
  assert.strictEqual(config.HOST, '0.0.0.0');
  assert.strictEqual(config.RESET_SECRET, '');
  assert.strictEqual(config.ADMIN_SECRET, '', 'the admin view is off unless a secret is set');
  assert.strictEqual(config.ADMIN_VIEW_MARGIN, 30);
  assert.strictEqual(config.TICK_HZ, 10);
  // the rules still come through the merge, read from config/game.json
  assert.strictEqual(config.WORLD_WIDTH, 50);
  assert.strictEqual(config.BATTLE_TURN_MS, 30000, 'a full player turn is relaxed');
  assert.deepStrictEqual(warnings, []);
});

test('the admin secret and depth margin are read and bounded', () => {
  const { config } = loadConfig({ env: { ADMIN_SECRET: '  open-sesame  ', ADMIN_VIEW_MARGIN: '45' }, envFile: null });
  assert.strictEqual(config.ADMIN_SECRET, 'open-sesame');
  assert.strictEqual(config.ADMIN_VIEW_MARGIN, 45);

  // a margin is a non-negative whole number of blocks, and an out-of-range or
  // unparseable one falls back rather than booting into a broken view
  const { config: zero, warnings: none } = loadConfig({ env: { ADMIN_VIEW_MARGIN: '0' }, envFile: null });
  assert.strictEqual(zero.ADMIN_VIEW_MARGIN, 0, 'zero is a real value, not "unset"');
  assert.deepStrictEqual(none, []);

  const { config: bad, warnings } = loadConfig({ env: { ADMIN_VIEW_MARGIN: 'deep' }, envFile: null });
  assert.strictEqual(bad.ADMIN_VIEW_MARGIN, 30);
  assert.ok(warnings.some((w) => w.includes('ADMIN_VIEW_MARGIN')));

  const { config: neg } = loadConfig({ env: { ADMIN_VIEW_MARGIN: '-5' }, envFile: null });
  assert.strictEqual(neg.ADMIN_VIEW_MARGIN, 30, 'a negative depth is not a depth');

  const { config: huge } = loadConfig({ env: { ADMIN_VIEW_MARGIN: '99999' }, envFile: null });
  assert.strictEqual(huge.ADMIN_VIEW_MARGIN, 30, 'and an absurd one falls back to the default');
});

test('a missing .env file is not an error and is not even a warning', () => {
  const missing = path.join(os.tmpdir(), 'diggame-does-not-exist-' + Date.now(), '.env');
  const { config, warnings } = loadConfig({ env: {}, envFile: missing });
  assert.strictEqual(config.PORT, 3000);
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
    'PORT=4100',
    'DB_PATH=data/other.db',
    'ADMIN_SECRET=  hunter2  ',
    '',
  ].join('\n'));
  const { config } = loadConfig({ env: {}, envFile: file });
  assert.strictEqual(config.PORT, 4100);
  assert.strictEqual(config.DB_PATH, 'data/other.db');
  assert.strictEqual(config.ADMIN_SECRET, 'hunter2');
});

test('a real environment variable beats .env', () => {
  const file = tmpEnvFile('PORT=4100\n');
  const { config } = loadConfig({ env: { PORT: '33' }, envFile: file });
  assert.strictEqual(config.PORT, 33);
});

test('an unparseable value falls back to the default with a warning', () => {
  const { config, warnings } = loadConfig({ env: { PORT: 'soon', TICK_HZ: 'maybe' }, envFile: null });
  assert.strictEqual(config.PORT, 3000);
  assert.strictEqual(config.TICK_HZ, 10);
  assert.strictEqual(warnings.length, 2);
  assert.ok(warnings[0].includes('PORT'));
});

test('out-of-range values fall back to the default', () => {
  const { config, warnings } = loadConfig({ env: { PORT: '99999', TICK_HZ: '9999' }, envFile: null });
  assert.strictEqual(config.PORT, 3000);
  assert.strictEqual(config.TICK_HZ, 10);
  assert.strictEqual(warnings.length, 2);
});

test('an empty value means "use the default"', () => {
  const { config } = loadConfig({ env: { PORT: '', DB_PATH: '   ' }, envFile: null });
  assert.strictEqual(config.PORT, 3000);
  assert.strictEqual(config.DB_PATH, 'data/diggame.db');
});

test('a missing game config is fatal, not a silent set of defaults', () => {
  const missing = path.join(os.tmpdir(), 'diggame-no-game-' + Date.now() + '.json');
  assert.throws(() => loadConfig({ env: {}, envFile: null, gameFile: missing }), ConfigError);
});

test('GAME_CONFIG points the loader at an alternate rules file', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'game.json'), 'utf8'));
  shipped.world.width = 33;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diggame-rules-'));
  const file = path.join(dir, 'game.json');
  fs.writeFileSync(file, JSON.stringify(shipped));
  const { config } = loadConfig({ env: { GAME_CONFIG: file }, envFile: null });
  assert.strictEqual(config.WORLD_WIDTH, 33, 'the named file wins over the default path');
});

test('the game config is merged in and overridable for tests', () => {
  const { config } = loadConfig({ env: {}, envFile: null, gameOverrides: { BATTLE_TURN_MS: 1234 } });
  assert.strictEqual(config.BATTLE_TURN_MS, 1234);
  assert.ok(config.WEAPON_STATS.sword);
});

test('clientConfig hides secrets and paths', () => {
  const { config } = loadConfig({
    env: { RESET_SECRET: 'shh', ADMIN_SECRET: 'open-sesame', DB_PATH: '/var/lib/x.db' },
    envFile: null,
  });
  const cc = clientConfig(config);
  assert.strictEqual(cc.worldWidth, 50);
  assert.strictEqual(cc.surfaceY, 0);
  assert.strictEqual(cc.battleTurnMs, 30000, 'the screen needs the turn lengths');
  assert.strictEqual(cc.battleBossTurnMs, 2500);
  const serialised = JSON.stringify(cc);
  assert.ok(!serialised.includes('shh'));
  assert.ok(!serialised.includes('open-sesame'), 'the admin secret never reaches a browser');
  assert.ok(!serialised.includes('/var/lib'));
  assert.ok(!('RESET_SECRET' in cc));
  assert.ok(!('ADMIN_SECRET' in cc));
  assert.ok(!('DB_PATH' in cc));

  // the default the admin depth box starts on is not a secret, so it is shared
  assert.strictEqual(cc.adminViewMargin, 30);
});

test('resolveDbPath is absolute and root-relative', () => {
  const { config } = loadConfig({ env: {}, envFile: null });
  assert.ok(path.isAbsolute(resolveDbPath(config)));
  const { config: abs } = loadConfig({ env: { DB_PATH: '/tmp/x.db' }, envFile: null });
  assert.strictEqual(resolveDbPath(abs), '/tmp/x.db');
});
