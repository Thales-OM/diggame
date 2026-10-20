'use strict';

// ---------- Client module consistency ----------
// The browser loads public/js as real ES modules, but the client tests glue them
// into one classic script. That glue is only valid while the sources agree with
// each other, so these checks guard the graph itself: no duplicate top-level
// names, no import of a name the target does not export, and a concatenation
// that still parses.

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const { readModules, loadClientSource, moduleIssues } = require('./clientmodules');

test('client modules are internally consistent', () => {
  assert.deepStrictEqual(moduleIssues(), []);
});

test('every module is reachable from the entry point', () => {
  // The browser only evaluates what main.js imports, so a module the glue reads
  // but nothing imports would silently never run (this is how the input module,
  // and with it every keyboard handler, once fell out of the page).
  const modules = readModules();
  const byName = new Map(modules.map((m) => [m.name, m]));
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !byName.has(name)) return;
    seen.add(name);
    for (const imp of byName.get(name).imports) visit(imp.spec);
  };
  visit('main');
  for (const m of modules) {
    assert.ok(seen.has(m.name), `${m.name} is never imported from main.js`);
  }
});

test('the entry points are glued last, in order', () => {
  const modules = readModules();
  const { orderModules } = require('./clientmodules');
  const order = orderModules(modules);
  assert.deepStrictEqual(order.slice(-2), ['input', 'main']);
});

test('the glued client is one script with no module keywords left', () => {
  const source = loadClientSource();
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /^\s*export\b/m);
  // Throws if the concatenation does not parse.
  new vm.Script(source, { filename: 'client.js' });
});
