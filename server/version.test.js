'use strict';

// ---------- Version tests ----------
// The version the client draws comes from APP_VERSION (the image's build arg,
// the git tag) or, failing that, package.json. There is no git call to test:
// the tag that matters is the one the build was made from.

const test = require('node:test');
const assert = require('node:assert');

const { resolveVersion, normalise, packageVersion } = require('./version');

test('an explicit APP_VERSION wins over the package version', () => {
  assert.deepStrictEqual(resolveVersion({ configured: 'v0.9.0-pre5', packageVersion: '1.2.3' }), {
    version: '0.9.0-pre5',
    source: 'env',
  });
});

test('a leading v is stripped so a tag and a package version read alike', () => {
  assert.strictEqual(normalise('v0.9.0-pre5'), '0.9.0-pre5');
  assert.strictEqual(normalise('0.9.0-pre5'), '0.9.0-pre5');
  assert.strictEqual(normalise('vertex'), 'vertex', 'only a v before a digit is a prefix');
  assert.strictEqual(normalise('  v1.2.3  '), '1.2.3', 'and whitespace is trimmed');
});

test('an empty or whitespace APP_VERSION is treated as unset', () => {
  assert.strictEqual(resolveVersion({ configured: '', packageVersion: '0.9.0-pre6' }).source, 'package');
  assert.strictEqual(resolveVersion({ configured: '   ', packageVersion: '0.9.0-pre6' }).source, 'package');
});

test('the package version is the fallback', () => {
  assert.deepStrictEqual(resolveVersion({ packageVersion: '0.9.0-pre6' }), {
    version: '0.9.0-pre6',
    source: 'package',
  });
});

test('nothing anywhere is reported as unknown rather than blank', () => {
  assert.deepStrictEqual(resolveVersion({ packageVersion: '' }), { version: 'unknown', source: 'none' });
});

test('with no override it reads the real package.json, which is a real version', () => {
  assert.strictEqual(resolveVersion({}).source, 'package');
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});
