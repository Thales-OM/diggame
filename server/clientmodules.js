'use strict';

// ---------- Client modules ----------
// public/js holds the browser client as real ES modules. The running page loads
// them natively (type="module"), but the tests want one script they can hand to
// vm.runInNewContext against the stub DOM. This reads the modules, orders them
// so a module is defined before the bodies that use it, and glues them into a
// single classic script by stripping the import and export keywords.
//
// The result is only as good as the sources being consistent, so the same file
// exposes a static check: every imported name must be exported by the module it
// names, and no two modules may declare the same top-level name (a collision
// would be silent, because everything lands in one scope).

const fs = require('node:fs');
const path = require('node:path');

const CLIENT_DIR = path.join(__dirname, '..', 'public', 'js');

/** The module file names, in a stable order. */
function listModules(dir = CLIENT_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
}

/** Pull the imports and the exported names out of one module's text. */
function parseModule(text) {
  const imports = [];
  const importRe = /^import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w.-]+)\.js['"]\s*;?\s*$/gm;
  for (const m of text.matchAll(importRe)) {
    const targets = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const parts = s.split(/\s+as\s+/);
        return { imported: parts[0].trim(), local: (parts[1] || parts[0]).trim() };
      });
    imports.push({ spec: m[2], targets });
  }
  const bareRe = /^import\s*['"]\.\/([\w.-]+)\.js['"]\s*;?\s*$/gm;
  for (const m of text.matchAll(bareRe)) imports.push({ spec: m[1], targets: [] });
  const exports = [];
  const exportRe = /^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(exportRe)) exports.push(m[1]);
  return { imports, exports };
}

/** Drop the import lines and the export keyword, leaving a plain script. */
function stripModule(text) {
  return text
    .replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^import\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}

/** Every module, parsed, keyed by name (the file name without .js). */
function readModules(dir = CLIENT_DIR) {
  return listModules(dir).map((file) => {
    const name = file.replace(/\.js$/, '');
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    return { name, file, text, ...parseModule(text) };
  });
}

/**
 * Depth-first order so a dependency lands before whoever imports it. Cycles are
 * fine to break: the client's modules only reach across a cycle from inside a
 * function, and function declarations hoist. `input` and `main` are the two
 * modules with top-level side effects, so they are pinned to the end, in that
 * order, whatever the graph says.
 */
function orderModules(modules) {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const order = [];
  const done = new Set();
  const open = new Set();
  const visit = (name) => {
    if (done.has(name) || open.has(name) || !byName.has(name)) return;
    open.add(name);
    for (const imp of byName.get(name).imports) visit(imp.spec);
    open.delete(name);
    done.add(name);
    order.push(name);
  };
  for (const m of modules) visit(m.name);

  const tail = ['input', 'main'].filter((n) => byName.has(n));
  const head = order.filter((n) => !tail.includes(n));
  return [...head, ...tail];
}

/** The whole client as one classic script, ready for vm. */
function loadClientSource(dir = CLIENT_DIR) {
  const modules = readModules(dir);
  const byName = new Map(modules.map((m) => [m.name, m]));
  const body = orderModules(modules)
    .map((name) => stripModule(byName.get(name).text).trim())
    .join('\n\n');
  return body + '\n';
}

/**
 * Everything the sources must satisfy for the glue above to be correct.
 * @returns {string[]} one message per problem, empty when the sources are sound
 */
function moduleIssues(dir = CLIENT_DIR) {
  const modules = readModules(dir);
  const byName = new Map(modules.map((m) => [m.name, m]));
  const issues = [];

  // One flat scope after concatenation, so a duplicate declaration is a
  // SyntaxError at best and a silent clobber at worst.
  const owner = new Map();
  for (const m of modules) {
    for (const name of m.exports) {
      if (owner.has(name)) {
        issues.push(`${name} is declared in both ${owner.get(name)} and ${m.name}`);
      } else {
        owner.set(name, m.name);
      }
    }
  }

  for (const m of modules) {
    for (const imp of m.imports) {
      const target = byName.get(imp.spec);
      if (!target) {
        issues.push(`${m.name} imports from ./${imp.spec}.js, which does not exist`);
        continue;
      }
      for (const t of imp.targets) {
        if (!target.exports.includes(t.imported)) {
          issues.push(`${m.name} imports ${t.imported} from ${imp.spec}, which does not export it`);
        }
      }
    }
  }

  return issues;
}

module.exports = { CLIENT_DIR, listModules, parseModule, stripModule, readModules, orderModules, loadClientSource, moduleIssues };
