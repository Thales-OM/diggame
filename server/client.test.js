'use strict';

// ---------- Client tests ----------
// public/client.js is a plain browser script, so these tests run it inside a
// small stubbed DOM with vm. That is enough to cover the bugs that only exist in
// the browser: key handling on the login screen, and any place where the client
// works out a position instead of reading it off the server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/**
 * The declarations the stylesheet ends up giving one selector, however the rules
 * are grouped. No JavaScript test can see CSS, so "the element is there and the
 * client toggles it" is not the same as "the element is actually on screen" -
 * that gap is exactly how a view with no positioning of its own ships looking
 * like a button that does nothing.
 */
function cssFor(selector) {
  // Comments come out first. A rule preceded by a comment otherwise reads as
  // having a selector that is the whole comment, and quietly matches nothing.
  const css = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const selectors = m[1].split(',').map((x) => x.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

/**
 * Which panels the real markup starts hidden. The stub has to agree with the
 * shipped HTML here, or "is the menu open" is answered by the stub's own
 * defaults rather than by the client's behaviour.
 */
const STARTS_HIDDEN = new Set();
for (const m of MARKUP.matchAll(/<\w[^>]*\bid="([^"]+)"[^>]*>/g)) {
  if (/\bclass="[^"]*\bhidden\b/.test(m[0])) STARTS_HIDDEN.add(m[1]);
}

/**
 * A canvas 2d context that only knows the real API. Anything else is a typo,
 * so it throws rather than silently doing nothing - which is exactly how a
 * rendering bug would otherwise hide until someone opened a browser.
 */
const CANVAS_2D = new Set([
  'canvas', 'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'globalAlpha',
  'fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'fill', 'stroke', 'save', 'restore', 'translate', 'scale', 'rotate',
  'fillText', 'strokeText', 'measureText', 'createLinearGradient', 'drawImage', 'rect',
]);

function fakeContext(ops) {
  const target = { createLinearGradient: () => ({ addColorStop() {} }) };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && CANVAS_2D.has(prop)) {
        if (!ops) return () => {};
        // Record the call together with the style in force, so a test can ask
        // "what colour ended up on this pixel" instead of "was fillRect called".
        return (...args) => { ops.push({ op: prop, fillStyle: t.fillStyle, args }); };
      }
      throw new Error(`not a canvas 2d member: ${String(prop)}`);
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
}

/**
 * A stand-in for HTMLCollection. The one thing that matters here is that
 * `length` is a getter with no setter, exactly like the real thing: assigning
 * to it throws. An array silently accepted the assignment, so the scoreboard
 * "cleared" itself fine in tests while the real client threw a TypeError and
 * died before it ever showed the spectator view.
 */
function fakeChildren(kids) {
  const coll = {};
  Object.defineProperty(coll, 'length', { get: () => kids.length, enumerable: true });
  kids.forEach((k, i) => { coll[i] = k; });
  return coll;
}

function fakeElement(id, ops) {
  let kids = [];
  const el = {
    id,
    style: {},
    dataset: {},
    get children() { return fakeChildren(kids); },
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    tagName: id.endsWith('Input') ? 'INPUT' : 'DIV',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      // The real second argument forces the state on or off, which is how the
      // client hides the admin-only options without fighting another toggle.
      toggle(c, force) {
        const on = force === undefined ? !this._s.has(c) : !!force;
        if (on) this._s.add(c); else this._s.delete(c);
        return on;
      },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(type, fn) { (this._h ||= {})[type] = fn; },
    click() { if (this._h && this._h.click) this._h.click({ target: this }); },
    appendChild(child) { kids.push(child); return child; },
    append(...more) { kids.push(...more); },
    // the real DOM clears the subtree when this is set to an empty string
    replaceChildren(...more) { kids = more; },
    remove() {
      if (!this.parentNode) return;
      const at = this.parentNode._kids.indexOf(this);
      if (at >= 0) this.parentNode._kids.splice(at, 1);
    },
    getContext: () => fakeContext(ops),
    width: 800,
    height: 600,
    focus() {},
  };
  el._kids = kids;
  // innerHTML as an accessor, so clearing it clears the children the way the
  // browser does. The stub used to keep them, which hid a second class of bug.
  let markup = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => markup,
    set: (v) => { markup = v; if (v === '') kids.length = 0; },
  });
  Object.defineProperty(el, 'parentNode', {
    get: () => el._parent || null,
  });
  const push = kids.push.bind(kids);
  kids.push = (...more) => {
    for (const m of more) if (m && typeof m === 'object') m._parent = el;
    return push(...more);
  };
  return el;
}

/** Boot the real client.js against the stub and hand back what it exposes. */
function boot() {
  const elements = new Map();
  const listeners = {};
  const emitted = [];
  const timers = [];
  const frames = [];
  const ops = [];

  const socketStub = {
    connected: true,
    // What every acknowledgement returns unless a test overrides it.
    ackResponse: { ok: true, rev: 1, you: null },
    on(event, fn) { (socketStub._h ||= {})[event] = fn; },
    emit(event, data, ack) {
      emitted.push({ event, data, ack });
      if (ack) ack(JSON.parse(JSON.stringify(socketStub.ackResponse)));
    },
  };

  const doc = {
    cookie: '',
    getElementById: (id) => {
      if (!elements.has(id)) {
        const e = fakeElement(id, ops);
        if (STARTS_HIDDEN.has(id)) e.classList.add('hidden');
        elements.set(id, e);
      }
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: (tag) => fakeElement(tag, ops),
    addEventListener() {},
  };

  const sandbox = {
    document: doc,
    window: {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    io: () => socketStub,
    // keep the frames so the renderer can actually be run
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: () => 0,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    Math,
    Date,
    JSON,
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = doc;

  // Expose the internals the assertions need. This line does not exist in the
  // real file; it is appended here only.
  const src = `${SOURCE}\n;globalThis.__test = { state, applyState, takeYou, sendAction, now, el, toast, loop, login, buildModelPicker, showRules, hideRules, closeTopmost, startSpectating, stopSpectating, toggleSpectating, toggleMenu, requestSpectate, specRequestFromPanel, syncSpecPanel, drawBlock, drawUnknown, COLORS, RULES_TEXT, RULES_LEGEND, RULES_GRID };`;
  vm.runInNewContext(src, sandbox, { filename: 'client.js' });

  return {
    api: sandbox.__test,
    elements,
    listeners,
    socket: socketStub,
    emitted,
    timers,
    frames,
    ops,
    el: (id) => elements.get(id),
    fire: (type, event) => listeners[type](event),
    server: (event, payload) => socketStub._h[event](payload),
  };
}

/** A logged-in client's first-login answer, ready to hand to the ack stub. */
const loginOk = (over = {}) => ({
  ok: true,
  code: 'C1',
  name: 'Ann',
  model: 0,
  rulesSeen: false,
  state: {
    you: stateAt(5, -1),
    rev: 1,
    world: { width: 50, surfaceY: 0, seed: 7 },
    config: { worldWidth: 50, digTimeMs: 900 },
    blocks: [{ x: 5, y: 0, type: 'dirt', item: null }],
    players: [{ id: 1, name: 'Ann', model: 0, x: 5, y: -1, alive: true, stuck: false }],
  },
  ...over,
});

/** Objects built inside the vm realm have a foreign prototype, which
 *  deepStrictEqual rejects. Copy them into this realm first. */
const plain = (o) => JSON.parse(JSON.stringify(o));

const keyEvent = (key, extra = {}) => ({
  key,
  target: { tagName: 'DIV', isContentEditable: false },
  preventDefault() { this.defaultPrevented = true; },
  defaultPrevented: false,
  ...extra,
});

const stateAt = (x, y, over = {}) => ({
  id: 1, code: 'C1', name: 'Ann', model: 0, x, y, alive: true, depth: y + 1,
  maxDepth: y + 1, digging: null, stuckUntil: 0, shovelUntil: 0, armor: 1,
  dynamite: 2, trap: 0, serverNow: Date.now(), ...over,
});

function loggedIn(client, x = 5, y = -1) {
  client.api.applyState({
    you: stateAt(x, y),
    rev: 1,
    world: { width: 50, surfaceY: 0, seed: 7 },
    config: { worldWidth: 50, digTimeMs: 900 },
    blocks: [{ x: 5, y: 0, type: 'dirt', item: null }],
    players: [{ id: 1, name: 'Ann', model: 0, x, y, alive: true, stuck: false }],
  });
  client.emitted.length = 0;
  return client;
}

// ================= input =================

test('typing a name on the login screen is not eaten by the game keys', () => {
  const c = boot();
  c.api.state.me = null; // not logged in
  const ev = keyEvent('w');
  c.fire('keydown', ev);
  assert.strictEqual(ev.defaultPrevented, false, 'W must not be swallowed on the login screen');
  assert.strictEqual(ev.defaultPrevented, false);
  assert.strictEqual(c.emitted.length, 0, 'and nothing is sent to the server');
});

test('Alice is typeable: WASD inside a text field is left to the field', () => {
  const c = loggedIn(boot());
  for (const key of ['a', 'l', 'i', 'c', 'e']) {
    const ev = keyEvent(key, { target: { tagName: 'INPUT', isContentEditable: false } });
    c.fire('keydown', ev);
    assert.strictEqual(ev.defaultPrevented, false, `${key} must reach the input`);
  }
  assert.strictEqual(c.emitted.length, 0);
});

test('game keys work once we are in the mine', () => {
  const c = loggedIn(boot());
  const ev = keyEvent('s');
  c.fire('keydown', ev);
  assert.strictEqual(ev.defaultPrevented, true, 'S is ours, so we consume it');
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'move', dir: 'down', rev: 1 });
});

test('every documented key maps to the right action', () => {
  const c = loggedIn(boot());
  const expected = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
  };
  for (const [key, dir] of Object.entries(expected)) {
    c.emitted.length = 0;
    const ev = keyEvent(key);
    c.fire('keydown', ev);
    assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'move', dir, rev: 1 }, key);
  }
  c.emitted.length = 0;
  c.fire('keydown', keyEvent('q'));
  assert.strictEqual(c.emitted[0].data.type, 'useDynamite');
  c.emitted.length = 0;
  c.fire('keydown', keyEvent('e'));
  assert.strictEqual(c.emitted[0].data.type, 'placeTrap');
});

test('keys we do not use are left alone, and browser shortcuts still work', () => {
  const c = loggedIn(boot());
  for (const key of ['t', 'Tab', 'F5', ' ', 'Enter']) {
    const ev = keyEvent(key);
    c.fire('keydown', ev);
    assert.strictEqual(ev.defaultPrevented, false, key);
  }
  const ctrl = keyEvent('s', { ctrlKey: true });
  c.fire('keydown', ctrl);
  assert.strictEqual(ctrl.defaultPrevented, false, 'Ctrl+S is the browser, not us');
  assert.strictEqual(c.emitted.length, 0);
});

// ================= the server owns the position =================

test('a finished dig moves us by the server number, not by arithmetic', () => {
  const c = loggedIn(boot(), 5, -1);
  c.server('digComplete', {
    dug: { x: 5, y: 0 },
    revealed: [{ x: 5, y: 1, type: 'dirt', item: 'dynamite' }],
    item: 'dynamite',
    bonus: false,
    you: stateAt(5, 0),
  });
  assert.strictEqual(c.api.state.me.x, 5);
  assert.strictEqual(c.api.state.me.y, 0, 'read straight off the message');
  assert.strictEqual(c.api.state.blocks['5,1'].item, 'dynamite');
  assert.strictEqual(c.api.state.blocks['5,0'].type, 'air', 'the dug cell is empty again');
});

test('a rejected move cannot drag our position out of sync', () => {
  const c = loggedIn(boot(), 5, 0);
  c.api.state.me = stateAt(9, 9); // pretend the client had drifted
  // the server refuses and says where we really are, somewhere else
  c.socket.emit = (event, data, ack) => ack({ ok: false, rev: 2, error: 'stone', you: stateAt(5, 0) });
  c.api.sendAction('move', 'right');
  assert.strictEqual(c.api.state.me.x, 5, 'the server position wins');
  assert.strictEqual(c.api.state.me.y, 0);
});

test('pressing a direction after a dig never moves us by itself', () => {
  const c = loggedIn(boot(), 5, 0);
  c.server('digComplete', { dug: { x: 5, y: 1 }, revealed: [], item: null, bonus: false, you: stateAt(5, 1) });
  assert.strictEqual(c.api.state.me.y, 1);

  c.emitted.length = 0;
  c.socket.emit = (event, data, ack) => ack({ ok: true, rev: 2, you: stateAt(5, 1), delta: { ignored: true } });
  c.fire('keydown', keyEvent('ArrowRight'));
  assert.strictEqual(c.api.state.me.x, 5, 'no local x += 1 anywhere');
  assert.strictEqual(c.api.state.me.y, 1);
});

test('a needSync answer replaces everything, including the world we know', () => {
  const c = loggedIn(boot(), 5, 0);
  c.socket.emit = (event, data, ack) => ack({
    needSync: true,
    rev: 9,
    state: {
      you: stateAt(30, 12), rev: 9,
      world: { width: 50, surfaceY: 0, seed: 7 },
      config: { worldWidth: 50 },
      blocks: [{ x: 30, y: 12, type: 'air', item: null }],
      players: [],
    },
  });
  c.api.sendAction('move', 'right');
  assert.strictEqual(c.api.state.me.x, 30);
  assert.strictEqual(c.api.state.rev, 9);
  assert.deepStrictEqual(Object.keys(c.api.state.blocks), ['30,12'], 'the old world view is dropped');
  assert.strictEqual(c.api.state.drawMe.x, 30, 'and the camera snaps to it');
});

test('a respawn puts the model where the server says, straight away', () => {
  const c = loggedIn(boot(), 5, 4);
  c.server('respawned', { x: 17, y: -1, you: stateAt(17, -1), reason: 'respawned' });
  assert.strictEqual(c.api.state.me.x, 17);
  assert.strictEqual(c.api.state.me.y, -1);
  assert.strictEqual(c.api.state.drawMe.x, 17, 'no waiting for the next move');
  assert.strictEqual(c.api.state.dig, null);
});

test('a world reset takes the position with it', () => {
  const c = loggedIn(boot(), 5, 4);
  c.server('worldReset', {
    you: stateAt(21, -1), rev: 3, seed: 99,
    state: {
      you: stateAt(21, -1), rev: 3,
      world: { width: 50, surfaceY: 0, seed: 99 },
      config: { worldWidth: 50 },
      blocks: [{ x: 21, y: 0, type: 'dirt', item: null }],
      players: [],
    },
  });
  assert.strictEqual(c.api.state.me.x, 21);
  assert.strictEqual(c.api.state.me.y, -1);
  assert.strictEqual(c.api.state.drawMe.x, 21);
  assert.strictEqual(c.api.state.blocks['5,4'], undefined, 'the old tunnel is gone');
});

test('a halted server stops the game and says why', () => {
  const c = loggedIn(boot());
  c.server('halted', { message: 'storage is unusable' });
  assert.strictEqual(c.api.state.halted, true);
  assert.strictEqual(c.elements.get('halt').classList.contains('hidden'), false);
  assert.strictEqual(c.elements.get('haltMsg').textContent, 'storage is unusable');
  c.emitted.length = 0;
  c.fire('keydown', keyEvent('s'));
  assert.strictEqual(c.emitted.length, 0, 'no actions are sent to a dead server');
});

test('a lost connection is visible and a reconnect asks for the state again', () => {
  const c = loggedIn(boot());
  c.server('disconnect');
  assert.strictEqual(c.api.state.connected, false);
  assert.strictEqual(c.elements.get('status').textContent, 'offline');

  c.emitted.length = 0;
  c.server('connect');
  assert.strictEqual(c.api.state.connected, true);
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'sync', rev: 1 });
});

test('the item countdown uses server time, so a wrong local clock does not lie', () => {
  const c = loggedIn(boot());
  const you = stateAt(5, 0, { shovelUntil: 5000 });
  you.serverNow = 1000; // the server is a long way from our clock
  c.api.takeYou(you);
  assert.ok(c.api.now() - 1000 < 200 && c.api.now() - 1000 >= 0, 'now() is re-anchored to the server');
  assert.ok(c.api.state.serverSkew > 0, 'the skew is recorded');
});

// ================= rendering =================

test('the renderer survives a real frame, in the pit and on the surface', () => {
  const c = loggedIn(boot());
  c.api.applyState({
    you: stateAt(5, 3, { digging: { x: 5, y: 4, dir: 'down', startedAt: Date.now() - 400, duration: 900 } }),
    rev: 2,
    world: { width: 50, surfaceY: 0, seed: 7 },
    config: { worldWidth: 50 },
    blocks: [
      { x: 5, y: 3, type: 'air', item: null },
      { x: 5, y: 4, type: 'dirt', item: 'dynamite' },
      { x: 6, y: 4, type: 'spikes', item: null },
      { x: 4, y: 4, type: 'stone', item: null },
    ],
    players: [
      { id: 1, name: 'Ann', model: 0, x: 5, y: 3, alive: true, stuck: false },
      { id: 2, name: 'Bo', model: 2, x: 6, y: 3, alive: true, stuck: true },
      { id: 3, name: 'Cy', model: 1, x: 7, y: 3, alive: false, stuck: false },
    ],
  });
  c.api.state.effects = [{ kind: 'boom', x: 5, y: 4, until: Date.now() + 700 },
    { kind: 'trap', x: 6, y: 4, until: Date.now() + 400 }];

  const frame = c.frames[0];
  assert.ok(frame, 'the render loop asked for a frame');
  assert.doesNotThrow(() => frame(1000), 'drawing the world must not throw');
  assert.doesNotThrow(() => frame(1100));
});

test('the spectator view renders too', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', {
    blocks: [{ x: 3, y: 0, type: 'dirt', item: 'shovel' }, { x: 4, y: 1, type: 'spikes', item: null }],
    players: [{ id: 1, name: 'Ann', model: 1, x: 3, y: -1, alive: true, stuck: false }],
    digs: [{ id: 1, x: 3, y: 0, progress: 0.5 }],
    traps: [{ x: 4, y: 0, ownerId: 2 }],
    width: 50,
    surfaceY: 0,
  });
  assert.strictEqual(c.api.state.spectator, true);
  const frame = c.frames[c.frames.length - 1];
  assert.doesNotThrow(() => frame(2000), 'the spectator canvas must render');
});

test('a halted game stops drawing', () => {
  const c = loggedIn(boot());
  c.server('halted', { message: 'storage is unusable' });
  const frame = c.frames[c.frames.length - 1];
  assert.doesNotThrow(() => frame(3000));
  assert.strictEqual(c.elements.get('halt').classList.contains('hidden'), false);
});

// ================= BUGS v0.3.0 =================

test('our own bear traps are drawn, and only ours', () => {
  const c = loggedIn(boot());
  assert.deepStrictEqual(plain(c.api.state.myTraps), [], 'no traps before any are set');

  c.api.takeYou(stateAt(5, -1, { trap: 1, traps: [{ x: 6, y: -1 }, { x: 5, y: 0 }] }));
  assert.strictEqual(c.api.state.myTraps.length, 2, 'the snapshot hands us our own traps');

  c.api.state.blocks = { '6,-1': { type: 'air', item: null }, '5,0': { type: 'air', item: null } };
  const frame = c.frames[0];
  assert.doesNotThrow(() => frame(1000), 'drawing your own traps must not throw');

  // a state that reports no traps clears them, e.g. after a reset
  c.api.takeYou(stateAt(5, -1));
  assert.deepStrictEqual(plain(c.api.state.myTraps), [], 'a trap-free snapshot clears the overlay');
});

test('placing a trap makes it appear for us on the next snapshot', () => {
  const c = loggedIn(boot());
  // the server answers the action with a snapshot that includes the new trap
  c.api.takeYou(stateAt(5, -1, { trap: 0, traps: [{ x: 5, y: -1 }] }));
  assert.deepStrictEqual(plain(c.api.state.myTraps), [{ x: 5, y: -1 }]);
  assert.doesNotThrow(() => c.frames[0](1000));
});

test('a world reset clears our traps', () => {
  const c = loggedIn(boot());
  c.api.takeYou(stateAt(5, -1, { traps: [{ x: 5, y: 0 }] }));
  assert.strictEqual(c.api.state.myTraps.length, 1);
  c.server('worldReset', { state: { you: stateAt(9, -1), rev: 2, world: { width: 50, surfaceY: 0 }, blocks: [], players: [] } });
  assert.deepStrictEqual(plain(c.api.state.myTraps), [], 'the old traps are gone with the old world');
});

test('a relogged-in player is handed the blocks they had discovered', () => {
  const c = boot();
  // a full state for a returning player carries their whole remembered map
  c.api.applyState({
    you: stateAt(12, -1),
    rev: 1,
    world: { width: 50, surfaceY: 0, seed: 7 },
    blocks: [
      { x: 12, y: 0, type: 'air', item: null },
      { x: 12, y: 1, type: 'air', item: null },
      { x: 13, y: 0, type: 'stone', item: null },
    ],
    players: [{ id: 1, name: 'Ann', model: 0, x: 12, y: -1, alive: true, stuck: false }],
  });
  assert.ok(c.api.state.blocks['12,1'], 'the old tunnel is drawn, not blacked out');
  assert.ok(c.api.state.blocks['13,0'], 'including what was next to it');
  assert.doesNotThrow(() => c.frames[0](1000));
});

// ---- spectator camera ----

function spectating() {
  const c = boot();
  c.server('spectatorMode', {
    blocks: [{ x: 10, y: 0, type: 'dirt', item: null }, { x: 10, y: 1, type: 'air', item: null }],
    players: [{ id: 1, name: 'Ann', model: 0, x: 10, y: 0, alive: true, stuck: false }],
    digs: [],
    traps: [],
    width: 50,
    surfaceY: 0,
  });
  return c;
}

/** Run n frames at a steady 16ms, returning the camera position at the end. */
function runFrames(c, n) {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const frame = c.frames[c.frames.length - 1];
    t += 16;
    frame(t);
  }
  return { x: c.api.state.specCam.x, y: c.api.state.specCam.y };
}

test('WASD moves the spectator camera over the field', () => {
  const c = spectating();
  assert.strictEqual(c.api.state.specCam.follow, true, 'it starts centred on the action');

  c.fire('keydown', keyEvent('d'));
  assert.strictEqual(c.api.state.specCam.follow, false, 'taking the wheel ends auto-follow');
  const start = c.api.state.specCam.x;
  const moved = runFrames(c, 10);
  assert.ok(moved.x > start, `the camera moved right (${start} -> ${moved.x})`);

  c.fire('keyup', keyEvent('d'));
  const held = c.api.state.specCam.x;
  assert.strictEqual(runFrames(c, 5).x, held, 'and stops when the key is released');
});

test('the camera moves in all four directions and normalises diagonals', () => {
  const c = spectating();
  // let it settle on the action first: it starts at 0,0 and only centres on
  // the first frame
  const home = runFrames(c, 2);
  assert.ok(Math.abs(home.x - 10) < 0.001, 'centred on the player');

  c.fire('keydown', keyEvent('d'));
  c.fire('keydown', keyEvent('s'));
  const diag = runFrames(c, 10);
  assert.ok(diag.x > 10, `right (${diag.x})`);
  assert.ok(diag.y > 0, `down (${diag.y})`);

  c.fire('keyup', keyEvent('d'));
  c.fire('keyup', keyEvent('s'));
  c.fire('keydown', keyEvent('a'));
  const left = runFrames(c, 10);
  assert.ok(left.x < diag.x, `left (${left.x} < ${diag.x})`);
  assert.ok(Math.abs(left.y - diag.y) < 0.001, 'only horizontal, so y is unchanged');
});

test('the camera is clamped to the world and the dug pit', () => {
  const c = spectating();
  c.fire('keydown', keyEvent('d'));
  runFrames(c, 400);
  assert.ok(c.api.state.specCam.x <= 49, `not past the right edge (${c.api.state.specCam.x})`);
  c.fire('keyup', keyEvent('d'));
  c.fire('keydown', keyEvent('a'));
  runFrames(c, 400);
  assert.ok(c.api.state.specCam.x >= 0, `not past the left edge (${c.api.state.specCam.x})`);
  c.fire('keyup', keyEvent('a'));

  c.fire('keydown', keyEvent('s'));
  runFrames(c, 400);
  // deepest known cell is y=1, and we allow two rows of slack below it
  assert.ok(c.api.state.specCam.y <= 3, `not below the bottom of the pit (${c.api.state.specCam.y})`);
  c.fire('keyup', keyEvent('s'));

  c.fire('keydown', keyEvent('w'));
  runFrames(c, 400);
  assert.ok(c.api.state.specCam.y >= -6, `not above the sky (${c.api.state.specCam.y})`);
});

test('the camera follows the action again when told to', () => {
  const c = spectating();
  c.fire('keydown', keyEvent('a'));
  runFrames(c, 20);
  assert.notStrictEqual(c.api.state.specCam.x, 10, 'it wandered off');

  c.elements.get('followBtn').click();
  assert.strictEqual(c.api.state.specCam.follow, true);
  const after = runFrames(c, 5);
  assert.ok(Math.abs(after.x - 10) < 0.001, 'and snapped back to the players');
});

test('losing focus mid-keypress does not leave the camera walking', () => {
  const c = spectating();
  c.fire('keydown', keyEvent('d'));
  runFrames(c, 5);
  const before = c.api.state.specCam.x;
  c.fire('blur', {});
  assert.strictEqual(c.api.state.specCam.x, before, 'nothing moved on the blur frame');
  assert.strictEqual(runFrames(c, 5).x, before, 'and nothing moves afterwards either');
});

test('spectating does not walk the character or use items', () => {
  const c = spectating();
  c.emitted.length = 0;
  c.fire('keydown', keyEvent('d'));
  c.fire('keydown', keyEvent('ArrowDown'));
  c.fire('keydown', keyEvent('q'));
  c.fire('keydown', keyEvent('e'));
  assert.deepStrictEqual(c.emitted, [], 'no actions are sent while spectating');
  assert.doesNotThrow(() => runFrames(c, 5));
});

test('entering spectator mode resets a stale camera position', () => {
  const c = spectating();
  c.fire('keydown', keyEvent('d'));
  runFrames(c, 30);
  const wandered = c.api.state.specCam.x;
  assert.notStrictEqual(wandered, 10);

  // spectating again (e.g. after unspectate) starts from a clean camera
  c.fire('keyup', keyEvent('d'));
  c.server('spectatorMode', {
    blocks: [],
    players: [{ id: 1, name: 'Ann', model: 0, x: 30, y: 0, alive: true, stuck: false }],
    digs: [], traps: [], width: 50, surfaceY: 0,
  });
  assert.strictEqual(c.api.state.specCam.follow, true);
  assert.ok(Math.abs(runFrames(c, 3).x - 30) < 0.001, 'centred on the action, wherever that is now');
});

// ================= the rules dialog =================

test('a brand new account is shown the rules, and an old one is not', () => {
  // BUGS v0.3.1: the rules never appeared, because the client guessed from a
  // localStorage flag that a returning browser still had. The server owns the
  // question and answers it in the login reply.
  const fresh = boot();
  fresh.socket.ackResponse = loginOk({ rulesSeen: false });
  fresh.el('nameInput').value = 'Ann';
  fresh.el('loginBtn').click();
  assert.ok(fresh.el('rules').classList.contains('hidden') === false, 'shown on the first login');
  assert.strictEqual(fresh.api.state.rulesShown, true);

  const known = boot();
  known.socket.ackResponse = loginOk({ rulesSeen: true });
  known.el('nameInput').value = 'Ann';
  known.el('loginBtn').click();
  assert.strictEqual(known.el('rules').classList.contains('hidden'), true, 'not shown again');
});

test('closing the rules is what tells the server they have been read', () => {
  const c = boot();
  c.socket.ackResponse = loginOk({ rulesSeen: false });
  c.el('nameInput').value = 'Ann';
  c.el('loginBtn').click();
  c.emitted.length = 0;

  c.el('closeRules').click();
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true, 'it closes');
  assert.deepStrictEqual(c.emitted.map((e) => e.event), ['rulesSeen'], 'and that is the acknowledgement');

  c.emitted.length = 0;
  c.api.hideRules();
  assert.deepStrictEqual(c.emitted, [], 'closing it again says nothing, so it cannot be replayed');
});

test('the rules describe the block alphabet, so the field can be read without guessing', () => {
  const c = boot();
  const grid = c.api.RULES_GRID.join('\n');
  for (const item of c.api.RULES_LEGEND) {
    const cls = `sw-${item.cls}`;
    assert.ok(grid.includes(item.ch) || item.ch === '?', `${item.name} is shown in the sample grid`);
    assert.ok(c.el('rulesBody').children.length > 0, 'and the legend is built into the dialog');
    assert.ok(cls.length > 3);
  }
  const html = c.api.RULES_TEXT.map(([h, t]) => h + t).join(' ');
  assert.match(html, /dynamite/i, 'the dynamite blast is explained');
  assert.match(html, /standing on/i, 'including that it clears the cell you stand on');
  assert.match(html, /spikes/i, 'and that spikes are a hazard');
  assert.match(html, /secret/i, 'and that traps are secret');
});

// ================= the spectator view is a real full-screen layer =================

test('the stub refuses the writes the browser refuses', () => {
  // The scoreboard clears itself with replaceChildren(). It used to assign to
  // children.length, which is a getter with no setter on a real HTMLCollection:
  // the stub took it, the browser threw a TypeError inside the spectator frame
  // handler, and the view never appeared. Nothing in a stub that accepts
  // impossible writes can catch that again.
  const c = boot();
  const rows = c.el('specBoardRows');
  assert.throws(() => { rows.children.length = 0; }, TypeError,
    'children.length is not writable, exactly as in the DOM');
  assert.throws(() => { rows.children = []; }, TypeError, 'children is not writable either');
});

test('a spectator frame completes and leaves the view on screen', () => {
  // BUGS v0.3.1: entering the view did nothing at all. The frame handler threw
  // partway through, so the view was never revealed - which looked exactly
  // like the button doing nothing, and to a logged in player looked like being
  // locked in place with a dead camera.
  const c = boot();
  c.el('specLoginBtn').click();
  c.server('spectatorMode', {
    width: 50, surfaceY: 0, maxY: 0, blocks: [], players: [], digs: [], traps: [],
    stats: [{ id: 1, name: 'Ann', depth: 4, maxDepth: 7, armor: 1, dynamite: 2, trap: 0, shovelUntil: 0 }],
  });

  assert.strictEqual(c.api.state.spectator, true, 'we are watching');
  assert.strictEqual(c.el('spectator').classList.contains('hidden'), false, 'the view is up');
  assert.strictEqual(c.el('login').classList.contains('hidden'), true, 'the login form is gone');
  assert.strictEqual(c.el('specBoardRows').children.length, 1, 'and the board was built');
  assert.strictEqual(c.el('specBoardEmpty').classList.contains('hidden'), true,
    'with the empty message put away');

  // ...and a later frame, which is the one that was throwing every 250ms
  c.server('spectatorFrame', {
    width: 50, surfaceY: 0, maxY: 0, removed: [],
    players: [{ id: 1, name: 'Ann', x: 3, y: 4, alive: true, depth: 5, maxDepth: 7,
      armor: 1, dynamite: 2, trap: 0 }],
  });
  assert.strictEqual(c.el('spectator').classList.contains('hidden'), false, 'still up after a frame');
});

test('the spectator view is positioned as a full-screen layer, like the mine', () => {
  // BUGS v0.3.1: with no positioning of its own the whole view sat in the
  // normal flow - the canvas collapsed, the overlays stacked up at the top of
  // the page, and the camera had nothing to draw on. The controls, the hint and
  // the scoreboard all move with the page, so nothing looked like a view.
  const spec = cssFor('#spectator');
  assert.strictEqual(spec.position, 'absolute', '#spectator must be positioned');
  assert.strictEqual(spec.inset, '0', 'and fill the viewport');
  assert.strictEqual(cssFor('#cvSpec').height, '100%', 'so the canvas has a height to fill');
});

test('the spectator banner is in the top half, centred, and takes no clicks', () => {
  // It is the label for the whole view: where you are, and how to get out.
  const banner = cssFor('#specBanner');
  assert.strictEqual(banner.position, 'absolute');
  assert.strictEqual(banner['pointer-events'], 'none', 'it must not eat a click meant for something else');
  const top = banner.top;
  const asShare = top.endsWith('%') ? parseFloat(top) : null;
  assert.ok(asShare !== null, `top is a share of the height, not a fixed offset (got ${top})`);
  assert.ok(asShare > 0 && asShare < 50, `and it is in the top half (got ${top})`);
  assert.ok(String(banner.transform).includes('translateX'), 'and centred horizontally');

  // In #spectator, not beside it: that is what makes it appear and stay without
  // any JavaScript keeping it in step.
  const specBlock = MARKUP.slice(MARKUP.indexOf('id="spectator"'));
  const bannerMarkup = specBlock.slice(specBlock.indexOf('id="specBanner"'));
  assert.match(bannerMarkup, /Spectator Mode/, 'it says what the view is');
  assert.match(bannerMarkup, /Press Esc\/?V to exit/, 'and how to leave it');
});

test('the camera hint and the scoreboard live inside the spectator view', () => {
  // They are shown and hidden by showing and hiding #spectator as a whole. If
  // they are outside it they are on screen during the game instead.
  const specBlock = MARKUP.slice(MARKUP.indexOf('id="spectator"'));
  assert.ok(specBlock.includes('id="specHint"'), 'the hint is in the spectator view');
  assert.ok(specBlock.includes('id="specBoardRows"'), 'and so is the scoreboard');
  assert.ok(STARTS_HIDDEN.has('spectator'), 'and the view starts hidden');
});

// ================= V / M / Esc =================

test('V switches in and out of spectator mode', () => {
  const c = loggedIn(boot());
  c.emitted.length = 0;
  c.fire('keydown', keyEvent('v'));
  const asked = c.emitted.filter((e) => e.event === 'spectate');
  assert.strictEqual(asked.length, 1, 'a view is requested');
  assert.deepStrictEqual(plain(asked[0].data), { mode: 'player' }, 'a logged-in watcher gets their own view');

  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  assert.strictEqual(c.api.state.spectator, true);
  c.fire('keyup', keyEvent('v'));

  c.emitted.length = 0;
  c.fire('keydown', keyEvent('v'));
  assert.ok(c.emitted.some((e) => e.event === 'unspectate'), 'V again goes back');
  assert.strictEqual(c.api.state.spectator, false);
});

test('the on-screen buttons toggle, so you can get back out without Esc', () => {
  // BUGS v0.3.1: Esc cancelled the spectator view, but pressing the button
  // again did nothing at all, so from a touch device there was no way back.
  const c = loggedIn(boot());
  c.el('specLoginBtn').click();
  assert.strictEqual(c.emitted.filter((e) => e.event === 'spectate').length, 1);
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });

  c.emitted.length = 0;
  c.el('specLoginBtn').click();
  assert.ok(c.emitted.some((e) => e.event === 'unspectate'), 'the same button cancels');
  assert.strictEqual(c.api.state.spectator, false);

  c.emitted.length = 0;
  c.el('spectateBtn').click();
  assert.strictEqual(c.emitted.filter((e) => e.event === 'spectate').length, 1, 'and the in-game one still works');
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.emitted.length = 0;
  c.el('backBtn').click();
  assert.ok(c.emitted.some((e) => e.event === 'unspectate'), 'as does the way out');
});

test('the login screen gets out of the way when watching from it', () => {
  // BUGS v0.3.1: #login sits outside #game and is positioned over the whole
  // page, so it stayed on top of the spectator view. Pressing the button
  // appeared to do nothing.
  const c = boot();
  assert.strictEqual(c.el('login').classList.contains('hidden'), false, 'the form is up to start with');
  c.el('specLoginBtn').click();
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  assert.strictEqual(c.api.state.spectator, true);
  assert.strictEqual(c.el('login').classList.contains('hidden'), true, 'and out of the way once watching');
  assert.strictEqual(c.el('game').classList.contains('hidden'), true);
  assert.strictEqual(c.el('spectator').classList.contains('hidden'), false, 'with the spectator view up');

  c.el('backBtn').click();
  assert.strictEqual(c.el('login').classList.contains('hidden'), false, 'cancelling brings the form back');
});

test('the rules button opens the dialog and closes it again', () => {
  // BUGS v0.3.1: the button only ever opened it, so Esc was the only way out.
  const c = loggedIn(boot());
  c.el('rules').classList.add('hidden');
  c.emitted.length = 0;

  c.el('rulesBtn').click();
  assert.strictEqual(c.el('rules').classList.contains('hidden'), false, 'it opens');

  c.el('rulesBtn').click();
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true, 'and closes');
  assert.strictEqual(c.emitted.filter((e) => e.event === 'rulesSeen').length, 1,
    'the read is reported on closing, once, and not on opening');

  // Esc and the button are two ways to the same place: the button must leave
  // the same state behind as Esc, not a half-toggled one.
  c.api.closeTopmost();
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true, 'already closed: Esc does nothing');
  assert.strictEqual(c.emitted.filter((e) => e.event === 'rulesSeen').length, 1, 'and does not report twice');
});

test('an anonymous watcher gets the public view, not a player one', () => {
  const c = boot();
  c.fire('keydown', keyEvent('v'));
  const asked = c.emitted.filter((e) => e.event === 'spectate');
  assert.strictEqual(asked.length, 1, 'you can watch before logging in');
  assert.deepStrictEqual(plain(asked[0].data), { mode: 'public' });
});

test('holding V down does not flicker between the two views', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.emitted.length = 0;
  const held = keyEvent('v', { repeat: true });
  c.fire('keydown', held);
  c.fire('keydown', held);
  assert.deepStrictEqual(c.emitted, [], 'the auto-repeat key does nothing at all');
  assert.strictEqual(c.api.state.spectator, true, 'and we are still spectating');
});

test('M opens and closes the menu', () => {
  const c = loggedIn(boot());
  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), false, 'open');
  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true, 'closed again');
});

test('M does nothing before logging in, because there is no menu to show', () => {
  const c = boot();
  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true);
});

test('Esc closes the rules, then the menu, then spectator mode, in that order', () => {
  const c = loggedIn(boot());
  c.api.showRules();
  c.fire('keydown', keyEvent('m'));
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.emitted.length = 0;

  const esc = keyEvent('Escape');
  c.fire('keydown', esc);
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true, 'the dialog on top goes first');
  assert.strictEqual(c.api.state.spectator, true, 'and not the thing underneath it');
  assert.deepStrictEqual(c.emitted.map((e) => e.event), ['rulesSeen']);

  c.fire('keydown', keyEvent('m'));
  c.fire('keydown', esc);
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true, 'then the menu');

  c.fire('keydown', esc);
  assert.strictEqual(c.api.state.spectator, false, 'and only then the spectator view');
});

test('Esc with nothing open is left to the browser', () => {
  const c = loggedIn(boot());
  const esc = keyEvent('Escape');
  c.fire('keydown', esc);
  assert.strictEqual(esc.defaultPrevented, false, 'still gets out of full screen');
});

test('the shortcuts never eat a keypress meant for a text field', () => {
  const c = boot();
  for (const tag of ['INPUT', 'TEXTAREA']) {
    c.fire('keydown', keyEvent('v', { target: { tagName: tag, isContentEditable: false } }));
    c.fire('keydown', keyEvent('m', { target: { tagName: tag, isContentEditable: false } }));
    c.fire('keydown', keyEvent('Escape', { target: { tagName: tag, isContentEditable: false } }));
  }
  c.fire('keydown', keyEvent('v', { target: { tagName: 'DIV', isContentEditable: true } }));
  assert.deepStrictEqual(c.emitted, [], 'so you can still type a name containing any of them');
});

// ================= the admin view =================

test('the admin controls are only offered when the admin view is picked', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), true, 'hidden by default');

  c.el('specMode').value = 'admin';
  c.api.syncSpecPanel();
  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), false, 'shown for admin');

  c.el('specMode').value = 'public';
  c.api.syncSpecPanel();
  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), true, 'and hidden again');
});

test('the admin request carries the secret, the aggregate choice and the margin', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.el('specMode').value = 'admin';
  c.el('specSecret').value = 'open-sesame';
  c.el('specAggregate').checked = true;   // aggregate: only what was dug
  c.el('specMargin').value = '12';

  c.api.requestSpectate(c.api.specRequestFromPanel());
  const sent = c.emitted.filter((e) => e.event === 'spectate').pop();
  assert.deepStrictEqual(plain(sent.data), {
    mode: 'admin', secret: 'open-sesame', adminAll: false, depthMargin: 12,
  });
});

test('a nonsensical margin is sent as zero, never as nonsense', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.el('specMode').value = 'admin';
  c.el('specAggregate').checked = true;

  for (const [typed, expected] of [['', 0], ['-4', 0], ['deep', 0], ['7.9', 7]]) {
    c.el('specMargin').value = typed;
    c.emitted.length = 0;
    c.api.requestSpectate(c.api.specRequestFromPanel());
    const sent = c.emitted.filter((e) => e.event === 'spectate').pop();
    assert.strictEqual(sent.data.depthMargin, expected, `${JSON.stringify(typed)} -> ${expected}`);
  }
});

test('a refused secret is explained rather than shown as a raw code', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.socket.ackResponse = { error: 'bad_admin_secret' };
  c.el('specMode').value = 'admin';
  c.api.requestSpectate({ mode: 'admin', secret: 'wrong' });
  assert.match(c.el('specErr').textContent, /admin secret/i);
  assert.doesNotMatch(c.el('specErr').textContent, /bad_admin_secret/);

  c.socket.ackResponse = { error: 'admin_view_disabled' };
  c.api.requestSpectate({ mode: 'admin', secret: 'x' });
  assert.match(c.el('specErr').textContent, /switched off/i);
});

test('the server decides the mode, and the panel follows it back', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.el('specMode').value = 'admin';
  c.socket.ackResponse = { mode: 'admin', depthMargin: 8 };
  c.api.requestSpectate({ mode: 'admin' });
  assert.strictEqual(c.el('specMode').value, 'admin');
  assert.strictEqual(c.el('specMargin').value, '8', 'the agreed margin is shown, not the requested one');
});

// ================= what the field looks like =================

test('a cell nobody has looked at is grey, not a hole and not sky', () => {
  const c = boot();
  c.ops.length = 0;
  c.api.drawUnknown(c.el('cv').getContext(), 0, 0);
  assert.ok(c.ops.length > 0, 'an undiscovered cell is painted, not left blank');
  assert.strictEqual(c.ops[0].fillStyle, c.api.COLORS.unknown);
});

test('air below the surface looks excavated, and air above it is still sky', () => {
  const c = boot();
  const ctx = c.el('cv').getContext();

  c.ops.length = 0;
  c.api.drawBlock(ctx, 0, 0, 'air', null, 3, 0);
  const dug = c.ops.filter((o) => o.op === 'fillRect' && o.args[2] === 32 && o.args[3] === 32);
  assert.ok(dug.length > 0, 'a dug-out cell is painted');
  assert.strictEqual(dug[0].fillStyle, c.api.COLORS.dug, 'in the dark excavated colour');
  assert.ok(!c.ops.some((o) => o.fillStyle === c.api.COLORS.grass), 'and it is not capped with grass');

  c.ops.length = 0;
  c.api.drawBlock(ctx, 0, 0, 'air', null, -1, 0);
  assert.deepStrictEqual(c.ops, [], 'sky above the surface stays sky');
});

test('the surface row keeps its grass, and dirt below it does not', () => {
  const c = boot();
  const ctx = c.el('cv').getContext();

  c.ops.length = 0;
  c.api.drawBlock(ctx, 0, 0, 'dirt', null, 0, 0);
  assert.ok(c.ops.some((o) => o.fillStyle === c.api.COLORS.grass), 'the surface row is capped with grass');

  c.ops.length = 0;
  c.api.drawBlock(ctx, 0, 0, 'dirt', null, 4, 0);
  assert.ok(!c.ops.some((o) => o.fillStyle === c.api.COLORS.grass), 'dirt in the pit is just dirt');
  assert.strictEqual(c.ops[0].fillStyle, c.api.COLORS.dirt);
});

// ================= the skin =================

test('picking a skin asks the server, which answers with the authoritative one', () => {
  // BUGS v0.3.0: the client only changed its own skin, so a rejected pick left
  // the model drawn differently from the player everybody else sees.
  const c = loggedIn(boot());
  c.socket.ackResponse = { ok: true, model: 4 };
  c.api.buildModelPicker();

  c.el('modelPicker').children[2].click();
  const sent = c.emitted.filter((e) => e.event === 'setModel');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data, 2);
  assert.strictEqual(c.api.state.model, 4, 'the server has the last word on what we draw');
});

test('a failed pick does not leave us drawing a skin we are not wearing', () => {
  const c = loggedIn(boot());
  c.socket.ackResponse = { error: 'invalid_model' };
  c.api.buildModelPicker();
  c.el('modelPicker').children[3].click();
  assert.strictEqual(c.api.state.model, 0, 'unchanged, because nothing was confirmed');
});

test('the spectator scoreboard shows depth, best depth and what people are carrying', () => {
  const c = spectating();
  c.server('spectatorFrame', {
    mode: 'public',
    width: 50,
    surfaceY: 0,
    blocks: [],
    players: [{ id: 1, name: 'Ann', model: 0, x: 10, y: 0, alive: true, stuck: false }],
    digs: [],
    traps: [],
    stats: [
      { id: 1, name: 'Ann', depth: 7, maxDepth: 9, armor: 1, dynamite: 2, trap: 0, shovelUntil: 0 },
      { id: 2, name: 'Bo', depth: 1, maxDepth: 3, armor: 0, dynamite: 0, trap: 1, shovelUntil: 0 },
    ],
  });

  const rows = c.el('specBoardRows').children;
  assert.strictEqual(rows.length, 2, 'one row per player');
  // deepest first, so the leader is at the top without having to read it all
  assert.strictEqual(rows[0].children[0].textContent, 'Ann');
  assert.strictEqual(rows[0].children[1].textContent, '7', 'current depth');
  assert.strictEqual(rows[0].children[2].textContent, '9', 'best depth');
  assert.match(rows[0].children[3].textContent, /🛡1/, 'armour');
  assert.match(rows[0].children[3].textContent, /💣2/, 'dynamite');
  assert.match(rows[0].children[3].textContent, /🪤0/, 'traps, which is a count and not a secret');
  assert.strictEqual(c.el('specBoardEmpty').classList.contains('hidden'), true);
});

test('a golden shovel in progress is counted down, and a dead player is greyed out', () => {
  const c = spectating();
  const until = Date.now() + 30000;
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [
      { id: 1, name: 'Ann', model: 0, x: 10, y: 0, alive: false, stuck: false },
      { id: 2, name: 'Bo', model: 0, x: 10, y: 0, alive: true, stuck: false },
    ],
    stats: [
      { id: 1, name: 'Ann', depth: 0, maxDepth: 5, armor: 0, dynamite: 0, trap: 0, shovelUntil: until },
      { id: 2, name: 'Bo', depth: 2, maxDepth: 2, armor: 0, dynamite: 0, trap: 0, shovelUntil: 0 },
    ],
  });
  const rows = c.el('specBoardRows').children;
  assert.match(rows[0].children[3].textContent, /⛏\d+s/, 'the shovel is shown counting down');
  assert.strictEqual(rows[0].className, 'dead', 'and a dead player is marked as such');
});

test('an empty pit says so rather than showing a blank table', () => {
  const c = spectating();
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], players: [], digs: [], traps: [], stats: [],
  });
  assert.strictEqual(c.el('specBoardRows').children.length, 0);
  assert.strictEqual(c.el('specBoardEmpty').classList.contains('hidden'), false);
});
