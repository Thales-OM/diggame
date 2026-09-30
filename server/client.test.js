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

  const socketStub = {
    connected: true,
    on(event, fn) { (socketStub._h ||= {})[event] = fn; },
    emit(event, data, ack) {
      emitted.push({ event, data, ack });
      if (ack) ack({ ok: true, rev: 1, you: null });
    },
  };

  const doc = {
    cookie: '',
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: (tag) => fakeElement(tag),
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
  const src = `${SOURCE}\n;globalThis.__test = { state, applyState, takeYou, sendAction, now, el, toast, loop };`;
  vm.runInNewContext(src, sandbox, { filename: 'client.js' });

  return {
    api: sandbox.__test,
    elements,
    listeners,
    socket: socketStub,
    emitted,
    timers,
    frames,
    fire: (type, event) => listeners[type](event),
    server: (event, payload) => socketStub._h[event](payload),
  };
}

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
