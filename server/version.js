'use strict';

// ---------- Version ----------
// The build identity shown small in the corner of the client, and logged at
// boot. It is not a hand-maintained constant.
//
// A published image is built from a `v*` tag, the release workflow passes that
// tag in as APP_VERSION, and this reads it back. Everything else - a local run,
// a locally built image, an untagged build - falls back to package.json's
// version, which is kept in step with the next tag: the first commit after a
// release bumps it.
//
// Git is deliberately not consulted. It is not inside the image, and the tag
// that matters is the one the build was made from, not whatever is checked out.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Strip a leading "v" so a tag (v0.9.0) and a package version (0.9.0) read alike. */
function normalise(value) {
  const s = String(value == null ? '' : value).trim();
  return s.replace(/^v(?=\d)/, '');
}

/** The version written in package.json, or '' if it cannot be read. */
function packageVersion(root = ROOT) {
  try {
    const text = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    return String(JSON.parse(text).version || '').trim();
  } catch {
    return '';
  }
}

/**
 * Resolve the version to display.
 *
 * @param {object} [opts]
 * @param {string} [opts.configured]      APP_VERSION, set by the image's build arg
 * @param {string} [opts.root]            project root, for package.json
 * @param {string} [opts.packageVersion]  override, for tests
 * @returns {{version: string, source: 'env'|'package'|'none'}}
 */
function resolveVersion(opts = {}) {
  const root = opts.root || ROOT;

  const configured = normalise(opts.configured);
  if (configured) return { version: configured, source: 'env' };

  const pkg = normalise(opts.packageVersion === undefined ? packageVersion(root) : opts.packageVersion);
  if (pkg) return { version: pkg, source: 'package' };

  return { version: 'unknown', source: 'none' };
}

module.exports = { resolveVersion, normalise, packageVersion, ROOT };
