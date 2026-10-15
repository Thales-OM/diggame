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
    style: { setProperty(name, value) { this[name] = value; } },
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

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };

  const sandbox = {
    document: doc,
    window: {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    io: () => socketStub,
    localStorage,
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
  const src = `${SOURCE}\n;globalThis.__test = { state, applyState, takeYou, sendAction, sendEmote, now, el, toast, loop, login, classTable, className, buildClassDisplay, showClassChoose, hideClassChoose, renderClassList, renderClassDesc, selectClass, confirmClass, buildEmotePicker, showEmotes, hideEmotes, toggleEmotes, emoteGlyph, EMOTE_LIST, showRules, hideRules, tutorialNext, tutorialBack, renderTutorialPage, TUTORIAL_PAGES, BLOCKS, buildWeaponList, closeTopmost, startSpectating, stopSpectating, toggleSpectating, toggleMenu, requestSpectate, specRequestFromPanel, syncSpecPanel, refreshSpecAdminOpts, onSpecModeChange, setSpecFollow, syncSpecFollow, resolveFollow, drawBlock, drawUnknown, COLORS, showTip, moveTip, hideTip, tipOn, weaponTip, fighterBar, ITEM, updateBattleClock, battleSkills, setOffline, MODELS, HERO_FIELD, HERO_BATTLE, MONSTERS, bossArt, heroArt, fieldSprite, spriteCanvas, drawPlayer, fighterEl, renderBoss, togglePanel, openPanel, closePopups, showProfile, hideProfile, tutorialOpen, battleHit };`;
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
    storage: localStorage,
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

test('a new run takes the class back and asks again, with no character on the field', () => {
  const c = loggedIn(boot(), 5, 4);
  c.api.state.classes = CLASS_FIXTURE;
  c.server('worldReset', { needsClass: true, seed: 1234, classes: CLASS_FIXTURE });
  assert.strictEqual(c.api.state.me, null, 'we are off the field');
  assert.strictEqual(c.api.state.pendingClass, true);
  assert.strictEqual(c.el('classChoose').classList.contains('hidden'), false, 'and the chooser is up');
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
  c.server('disconnect', 'transport close');
  assert.strictEqual(c.api.state.connected, false);
  assert.strictEqual(c.elements.get('status').textContent, 'offline');
  // the constant overlay, not just the little status word
  assert.strictEqual(c.elements.get('offline').classList.contains('hidden'), false, 'the veil is up');
  assert.match(c.elements.get('offlineMsg').textContent, /Lost connection/);

  c.emitted.length = 0;
  c.server('connect');
  assert.strictEqual(c.api.state.connected, true);
  assert.strictEqual(c.elements.get('offline').classList.contains('hidden'), true, 'and clears itself');
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'sync', rev: 1 });
});

test('a failed reach shows the offline overlay too, and it cannot be dismissed', () => {
  const c = boot();
  c.server('connect_error');
  assert.strictEqual(c.elements.get('offline').classList.contains('hidden'), false);
  assert.match(c.elements.get('offlineMsg').textContent, /Cannot reach/);
  // Esc, which closes every other window, must not touch it
  c.fire('keydown', keyEvent('Escape'));
  assert.strictEqual(c.elements.get('offline').classList.contains('hidden'), false);
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
  assert.strictEqual(c.api.state.specCam.mode, 'deepest', 'it starts on the deepest player');

  c.fire('keydown', keyEvent('d'));
  assert.strictEqual(c.api.state.specCam.mode, 'manual', 'taking the wheel ends the follow');
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

test('the camera follows the deepest player again when told to', () => {
  const c = spectating();
  c.fire('keydown', keyEvent('a'));
  runFrames(c, 20);
  assert.notStrictEqual(c.api.state.specCam.x, 10, 'it wandered off');

  c.api.setSpecFollow('deepest');
  assert.strictEqual(c.api.state.specCam.mode, 'deepest');
  const after = runFrames(c, 5);
  assert.ok(Math.abs(after.x - 10) < 0.001, 'and snapped back to the player');
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
  assert.strictEqual(c.api.state.specCam.mode, 'deepest');
  assert.ok(Math.abs(runFrames(c, 3).x - 30) < 0.001, 'centred on the action, wherever that is now');
});

test('the deepest follow picks the deepest living player and tracks them', () => {
  const c = spectating();
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [
      { id: 1, name: 'Ann', model: 0, x: 10, y: 2, alive: true, stuck: false },
      { id: 2, name: 'Bo', model: 0, x: 30, y: 8, alive: true, stuck: false },
    ],
    stats: [],
  });
  c.api.setSpecFollow('deepest');
  let cam = runFrames(c, 2);
  assert.ok(Math.abs(cam.x - 30) < 0.001 && Math.abs(cam.y - 8) < 0.001, 'on the deeper player');

  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [
      { id: 1, name: 'Ann', model: 0, x: 10, y: 20, alive: true, stuck: false },
      { id: 2, name: 'Bo', model: 0, x: 30, y: 8, alive: true, stuck: false },
    ],
    stats: [],
  });
  const cam2 = runFrames(c, 2);
  assert.ok(Math.abs(cam2.x - 10) < 0.001 && Math.abs(cam2.y - 20) < 0.001, 'and re-centres when the lead changes');
});

test('following a named player pins the camera to that player', () => {
  const c = spectating();
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [
      { id: 1, name: 'Ann', model: 0, x: 12, y: 4, alive: true, stuck: false },
      { id: 2, name: 'Bo', model: 0, x: 40, y: 1, alive: true, stuck: false },
    ],
    stats: [],
  });
  c.api.setSpecFollow('p:1');
  const cam = runFrames(c, 2);
  assert.ok(Math.abs(cam.x - 12) < 0.001, 'on the chosen player, not the deepest');
  assert.strictEqual(c.el('specFollow').value, 'p:1', 'and the dropdown shows the choice');
});

test('the deepest follow gives up when the pit is empty', () => {
  const c = spectating();
  c.api.setSpecFollow('deepest');
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [], players: [], stats: [],
  });
  assert.strictEqual(c.api.state.specCam.mode, 'manual', 'nobody to follow');
});

test('a followed player leaving the field returns the camera to manual', () => {
  const c = spectating();
  c.api.setSpecFollow('p:1');
  runFrames(c, 2);
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [], players: [], stats: [],
  });
  assert.strictEqual(c.api.state.specCam.mode, 'manual', 'the watched player is gone');
  assert.strictEqual(c.el('specFollow').value, 'manual', 'and the dropdown agrees');
});

test('the deepest follow holds on while everyone is dead but still listed', () => {
  const c = spectating();
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [{ id: 1, name: 'Ann', model: 0, x: 23, y: 0, alive: true, stuck: false }],
    stats: [],
  });
  c.api.setSpecFollow('deepest');
  runFrames(c, 2);
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [{ id: 1, name: 'Ann', model: 0, x: 23, y: 0, alive: false, stuck: false }],
    stats: [],
  });
  assert.strictEqual(c.api.state.specCam.mode, 'deepest', 'still following nobody in particular');
  assert.strictEqual(c.el('specFollow').value, 'deepest');
});

test('the follow dropdown lists manual, deepest and every player, sorted by name', () => {
  const c = spectating();
  c.server('spectatorFrame', {
    mode: 'public', width: 50, surfaceY: 0, blocks: [], digs: [], traps: [],
    players: [
      { id: 2, name: 'Bo', model: 0, x: 40, y: 1, alive: true, stuck: false },
      { id: 1, name: 'Ann', model: 0, x: 12, y: 4, alive: true, stuck: false },
    ],
    stats: [],
  });
  const opts = c.el('specFollow').children;
  const values = [];
  for (let i = 0; i < opts.length; i++) values.push(opts[i].value);
  assert.deepStrictEqual(values, ['manual', 'deepest', 'p:1', 'p:2']);
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

  c.el('tutSkip').click();
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true, 'it closes');
  assert.deepStrictEqual(c.emitted.map((e) => e.event), ['rulesSeen'], 'and that is the acknowledgement');

  c.emitted.length = 0;
  c.api.hideRules();
  assert.deepStrictEqual(c.emitted, [], 'closing it again says nothing, so it cannot be replayed');
});

test('every tutorial page carries a grid and a legend that names its blocks', () => {
  const c = boot();
  assert.ok(c.api.TUTORIAL_PAGES.length >= 8, 'the essentials are covered');
  for (const page of c.api.TUTORIAL_PAGES) {
    assert.ok(page.title && page.html, 'a page has a title and some text');
    assert.ok(page.grid && page.grid.length > 0, `${page.title} shows a slice of the field`);
    assert.ok(page.legend && page.legend.length > 0, `${page.title} names the blocks it shows`);
    const grid = page.grid.join('\n');
    for (const key of page.legend) {
      const item = c.api.BLOCKS[key];
      assert.ok(item, `${key} is a real block type`);
      // the legend is only useful if the character it names is on the page
      assert.ok(grid.includes(item.ch), `${item.name} is shown in the grid it is listed under`);
      assert.match(item.cls, /^[a-z]+( [a-z]+)?$/, 'the swatch class maps to the stylesheet');
    }
  }
});

test('the tutorial explains the hazards, the dynamite centre and the secret traps', () => {
  const c = boot();
  const html = c.api.TUTORIAL_PAGES.map((p) => p.title + p.html).join(' ');
  assert.match(html, /dynamite/i, 'the dynamite blast is explained');
  assert.match(html, /standing on/i, 'including that it clears the cell you stand on');
  assert.match(html, /spikes/i, 'and that spikes are a hazard');
  assert.match(html, /secret/i, 'and that traps are secret');
});

test('the weapons page lists every weapon with its sprite, numbers and description', () => {
  const c = boot();
  const weaponsPage = c.api.TUTORIAL_PAGES.findIndex((p) => p.weapons);
  assert.ok(weaponsPage >= 0, 'a page is dedicated to the weapons');
  c.api.state.tutPage = weaponsPage;
  c.api.renderTutorialPage();

  const flatten = (node) => {
    let out = node.textContent || '';
    for (let i = 0; i < node.children.length; i++) out += ' ' + flatten(node.children[i]);
    return out;
  };
  const body = c.el('rulesBody');
  let list = null;
  for (let i = 0; i < body.children.length; i++) {
    if (body.children[i].className === 'ruleWeapons') list = body.children[i];
  }
  assert.ok(list, 'the page draws a weapon list');
  assert.strictEqual(list.children.length, 3, 'one bullet for each weapon');

  const blob = flatten(list);
  assert.match(blob, /🗡 Sword dmg 6 · hit 80% · crit 15%/, 'the sword shows its sprite and numbers');
  assert.match(blob, /🤺 Rapier dmg 5 · hit 60% · crit 45%/, 'and so does the rapier');
  assert.match(blob, /🪄 Magic Staff dmg 6 · hit 80% · crit 10%/, 'and the staff');
  assert.match(blob, /Basic and reliable/, 'with the sword description');
  assert.match(blob, /crits far more often/, 'the rapier description');
  assert.match(blob, /Incantation: spend a turn to strike for 2.5x base damage\./, 'and the staff skill');
});

test('the tutorial opens on the first page, with Back disabled and Skip offered', () => {
  const c = boot();
  c.api.showRules();
  assert.strictEqual(c.api.state.tutPage, 0);
  assert.strictEqual(c.el('tutBack').disabled, true, 'there is nowhere back to go');
  assert.strictEqual(c.el('tutSkip').classList.contains('hidden'), false, 'Skip is offered');
  assert.strictEqual(c.el('tutNext').textContent, 'Next');
  assert.match(c.el('tutPage').textContent, /^Page 1 of \d+$/);
});

test('Next turns the page, Back steps back, and neither can run off the end', () => {
  const c = boot();
  c.api.showRules();

  c.api.tutorialBack();
  assert.strictEqual(c.api.state.tutPage, 0, 'Back on the first page does nothing');

  c.el('tutNext').click();
  assert.strictEqual(c.api.state.tutPage, 1);
  assert.strictEqual(c.el('tutBack').disabled, false, 'Back is live once there is a page behind');

  c.el('tutBack').click();
  assert.strictEqual(c.api.state.tutPage, 0);
});

test('the last page hides Skip and turns Next into Got it', () => {
  const c = boot();
  c.api.showRules();
  const last = c.api.TUTORIAL_PAGES.length - 1;
  for (let i = 0; i < last; i++) c.el('tutNext').click();
  assert.strictEqual(c.api.state.tutPage, last);
  assert.strictEqual(c.el('tutNext').textContent, 'Got it');
  assert.strictEqual(c.el('tutSkip').classList.contains('hidden'), true, 'there is nothing left to skip');
  assert.match(c.el('tutPage').textContent, new RegExp(`^Page ${last + 1} of ${last + 1}$`));
});

test('Skip and Got it both close the tutorial and record it as seen', () => {
  const skip = boot();
  skip.socket.ackResponse = loginOk({ rulesSeen: false });
  skip.el('nameInput').value = 'Ann';
  skip.el('loginBtn').click();
  skip.emitted.length = 0;
  skip.el('tutSkip').click();
  assert.strictEqual(skip.el('rules').classList.contains('hidden'), true, 'Skip closes it');
  assert.deepStrictEqual(skip.emitted.map((e) => e.event), ['rulesSeen'], 'and records it once');

  const done = boot();
  done.socket.ackResponse = loginOk({ rulesSeen: false });
  done.el('nameInput').value = 'Bob';
  done.el('loginBtn').click();
  done.emitted.length = 0;
  for (let i = 0; i < done.api.TUTORIAL_PAGES.length; i++) done.api.tutorialNext();
  assert.strictEqual(done.el('rules').classList.contains('hidden'), true, 'the last Next finishes');
  assert.deepStrictEqual(done.emitted.map((e) => e.event), ['rulesSeen']);
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

test('Esc closes the open window, topmost first, then spectator mode', () => {
  const c = loggedIn(boot());
  c.api.showRules();
  const esc = keyEvent('Escape');
  c.fire('keydown', esc);
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true, 'the tutorial goes first');
  assert.deepStrictEqual(c.emitted.map((e) => e.event), ['rulesSeen']);

  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), false);
  c.fire('keydown', esc);
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true, 'then the menu');

  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  assert.strictEqual(c.api.state.spectator, true);
  c.fire('keydown', esc);
  assert.strictEqual(c.api.state.spectator, false, 'and then the spectator view');
});

test('opening one window closes the others', () => {
  const c = loggedIn(boot());

  c.fire('keydown', keyEvent('p'));
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), false, 'P opens the emotes');

  c.fire('keydown', keyEvent('i'));
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), false, 'I opens the inventory');
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true, 'and the emotes close');

  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), false, 'M opens the menu');
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), true, 'and the inventory closes');

  // opening the tutorial from a panel closes that panel too
  c.api.openPanel('tutorial');
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true, 'the tutorial closes the menu');
  assert.strictEqual(c.el('rules').classList.contains('hidden'), false);
});

test('the tutorial is modal: it locks the top buttons and blocks the other windows', () => {
  const c = loggedIn(boot());
  c.api.showRules();
  assert.strictEqual(c.el('topControls').classList.contains('locked'), true, 'the row is locked');

  // every other window is refused while the tutorial is up
  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true, 'the menu cannot open over it');
  c.fire('keydown', keyEvent('i'));
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), true, 'nor the inventory');
  c.fire('keydown', keyEvent('p'));
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true, 'nor the emotes');
  c.fire('keydown', keyEvent('v'));
  assert.strictEqual(c.api.state.spectator, false, 'nor spectator mode');

  // ending it is what unlocks the row
  c.el('tutSkip').click();
  assert.strictEqual(c.el('rules').classList.contains('hidden'), true);
  assert.strictEqual(c.el('topControls').classList.contains('locked'), false, 'the row is live again');

  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), false, 'and a window opens now');
});

test('spectator mode closes the panels, and a panel leaves spectator mode', () => {
  const c = loggedIn(boot());
  c.fire('keydown', keyEvent('m'));
  assert.strictEqual(c.el('profile').classList.contains('hidden'), false);

  c.fire('keydown', keyEvent('v'));
  assert.strictEqual(c.emitted.filter((e) => e.event === 'spectate').length, 1);
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  assert.strictEqual(c.api.state.spectator, true);
  assert.strictEqual(c.el('profile').classList.contains('hidden'), true, 'the menu closed behind us');

  c.emitted.length = 0;
  c.fire('keydown', keyEvent('i'));
  assert.ok(c.emitted.some((e) => e.event === 'unspectate'), 'opening a window leaves the view');
  assert.strictEqual(c.api.state.spectator, false);
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), false, 'and the inventory is up');
});

test('the locked top row is a style, and the top buttons are a uniform square', () => {
  const locked = cssFor('#topControls.locked');
  assert.strictEqual(locked['pointer-events'], 'none', 'the buttons take no clicks while the tutorial is up');
  assert.ok(locked.opacity, 'and are visibly dimmed so that reads');

  const btn = cssFor('#topControls button');
  assert.strictEqual(btn.width, '40px', 'every top button is the same width');
  assert.strictEqual(btn.height, '40px', 'and the same height');
  assert.strictEqual(btn.padding, '0');
  // the old rule shrank only the eye glyph, which is why it looked smaller
  assert.notStrictEqual(cssFor('#topControls #spectateBtn')['font-size'], '14px');
});

test('the follow selector sits in its own bold, dark box', () => {
  const label = cssFor('#specControls #specFollowLabel');
  assert.ok(label.background, 'it has a background, so Follow is not just hanging over the field');
  assert.strictEqual(label['font-weight'], '700', 'and is bold');
  assert.ok(label.padding, 'with room around it');
  assert.ok(label.border, 'and an edge');
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

test('picking Admin reveals the secret field before anything is sent', () => {
  // BUGS v0.7.0: the field only appeared after a successful admin spectate,
  // which is impossible without the secret - so the secret could never be typed.
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), true, 'hidden to start');

  c.el('specMode').value = 'admin';
  c.el('specMode')._h.change();
  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), false, 'the field is there to type into');
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

test('picking a different view mode switches instead of snapping back', () => {
  // BUGS v0.7.0-pre2: the change handler re-ran syncSpecPanel, which wrote the
  // agreed mode straight back into the select, so the mode never actually changed.
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.api.state.specMode = 'player';            // the view we are currently on
  c.socket.ackResponse = { mode: 'public' };  // the server grants what we ask
  c.el('specMode').value = 'public';
  c.el('specMode')._h.change();

  const sent = c.emitted.filter((e) => e.event === 'spectate').pop();
  assert.strictEqual(plain(sent.data).mode, 'public', 'the new mode is the one requested');
  assert.strictEqual(c.el('specMode').value, 'public', 'and the select keeps it, not the old mode');
});

test('picking Admin with no remembered secret reveals the box and waits', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.api.state.specMode = 'player';
  c.el('specMode').value = 'admin';
  c.el('specMode')._h.change();

  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), false, 'the box is shown');
  assert.strictEqual(c.el('specSecret').value, '');
  assert.strictEqual(c.emitted.filter((e) => e.event === 'spectate').length, 0, 'nothing is sent without a secret');
});

test('an accepted admin secret is remembered and reused next time', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.socket.ackResponse = { mode: 'admin', depthMargin: 30 };
  c.el('specMode').value = 'admin';
  c.el('specSecret').value = 'open-sesame';
  c.api.requestSpectate(c.api.specRequestFromPanel());
  assert.strictEqual(c.storage.getItem('diggame.adminSecret'), 'open-sesame');

  // leave Admin, then come back: the remembered secret is filled in and sent
  c.emitted.length = 0;
  c.socket.ackResponse = { mode: 'public' };
  c.el('specMode').value = 'public';
  c.el('specMode')._h.change();
  c.socket.ackResponse = { mode: 'admin', depthMargin: 30 };
  c.el('specMode').value = 'admin';
  c.el('specMode')._h.change();

  assert.strictEqual(c.el('specSecret').value, 'open-sesame', 'the box is filled from storage');
  const sent = c.emitted.filter((e) => e.event === 'spectate').pop();
  assert.strictEqual(plain(sent.data).secret, 'open-sesame', 'and sent without retyping');
});

test('a remembered secret the server refuses is forgotten and asked for again', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.storage.setItem('diggame.adminSecret', 'stale');
  c.socket.ackResponse = { error: 'bad_admin_secret' };
  c.el('specMode').value = 'admin';
  c.el('specMode')._h.change();

  assert.strictEqual(c.storage.getItem('diggame.adminSecret'), null, 'the stale secret is dropped');
  assert.strictEqual(c.el('specSecret').value, '', 'and the box is cleared');
  assert.strictEqual(c.el('specAdminOpts').classList.contains('hidden'), false, 'the box is back to retype into');
  assert.match(c.el('specErr').textContent, /admin secret/i);
});

test('pressing Enter in the secret box sends the admin request', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.socket.ackResponse = { mode: 'admin', depthMargin: 30 };
  c.el('specMode').value = 'admin';
  c.el('specSecret').value = 'typed';
  c.el('specSecret')._h.keydown({ key: 'Enter' });

  const sent = c.emitted.filter((e) => e.event === 'spectate').pop();
  assert.strictEqual(plain(sent.data).secret, 'typed');
});

test('changing an admin option re-sends the frame, but only while Admin is showing', () => {
  const c = loggedIn(boot());
  c.server('spectatorMode', { blocks: [], players: [], digs: [], traps: [], width: 50, surfaceY: 0 });
  c.socket.ackResponse = { mode: 'admin', depthMargin: 9 };
  c.el('specMode').value = 'admin';
  c.emitted.length = 0;

  c.el('specMargin').value = '9';
  c.el('specMargin')._h.change();
  const sent = c.emitted.filter((e) => e.event === 'spectate').pop();
  assert.strictEqual(plain(sent.data).depthMargin, 9, 'the new margin is sent');

  // off the admin view the options are hidden, so their changes send nothing
  c.el('specMode').value = 'public';
  c.emitted.length = 0;
  c.el('specAggregate')._h.change();
  assert.strictEqual(c.emitted.filter((e) => e.event === 'spectate').length, 0);
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

test('a boss cell is a red tile with crossed swords, not a skull', () => {
  const c = boot();
  const ops = [];
  c.api.drawBlock(fakeContext(ops), 0, 0, 'boss', null, 0, -1);
  const tile = ops.find((o) => o.op === 'fillRect' && o.args[2] === 32 && o.args[3] === 32);
  assert.strictEqual(tile.fillStyle, c.api.COLORS.boss, 'the whole tile is the boss colour');
  assert.strictEqual(c.api.COLORS.boss, '#c62828', 'which is battle red, not the old purple');
  assert.ok(ops.filter((o) => o.op === 'stroke').length >= 3, 'blades, guards and hilts are stroked');
  assert.ok(ops.some((o) => o.op === 'moveTo') && ops.some((o) => o.op === 'lineTo'), 'drawn as sword lines');
  assert.ok(!ops.some((o) => o.op === 'fillText'), 'and no skull glyph is painted');
});

// ================= the entry class choice =================

/** The class list the server ships in the login reply, trimmed to what the
 *  chooser reads. Order matches the sprite mirror. */
const CLASS_FIXTURE = [
  { id: 'wizard', name: 'Wizard', desc: 'A scholar of the deep.', skills: [
    { id: 'magic_knowledge', name: 'Magic knowledge', kind: 'passive', desc: 'Only a Wizard may carry the staff.' },
  ] },
  { id: 'knight', name: 'Knight', desc: 'A fighter in plate.', skills: [
    { id: 'weapon_expertise', name: 'Weapon expertise', kind: 'passive', desc: 'Blades bite harder.' },
  ] },
  { id: 'barbarian', name: 'Barbarian', desc: 'A bare-knuckled brawler.', skills: [
    { id: 'hardened_knuckles', name: 'Hardened knuckles', kind: 'passive', desc: 'Fists bite harder.' },
    { id: 'battle_cry', name: 'Battle cry', kind: 'active', desc: 'Roar to heal once.' },
  ] },
  { id: 'noble', name: 'Noble', desc: 'A leader of the party.', skills: [
    { id: 'noblesse_oblige', name: 'Noblesse oblige', kind: 'active', desc: 'Rally your allies.' },
  ] },
  { id: 'bandit', name: 'Bandit', desc: 'A quick opportunist.', skills: [
    { id: 'agile_footwork', name: 'Agile footwork', kind: 'active', desc: 'Sharpen your aim.' },
  ] },
];

test('a new account sees the class chooser, and only Confirm spawns the character', () => {
  const c = boot();
  c.socket.ackResponse = {
    ok: true, code: 'C2', name: 'New', needsClass: true, rulesSeen: true, classes: CLASS_FIXTURE,
  };
  c.el('nameInput').value = 'New';
  c.el('loginBtn').click();

  assert.strictEqual(c.el('classChoose').classList.contains('hidden'), false, 'the chooser is up');
  assert.strictEqual(c.el('game').classList.contains('hidden'), false, 'over the game shell');
  assert.strictEqual(c.api.state.me, null, 'and we are not on the field yet');

  // one card per class, each a sprite with the name beneath it
  const cards = c.el('classList').children;
  assert.strictEqual(cards.length, 5, 'one card per class');
  const names = Array.from(cards).map((k) => k.children[k.children.length - 1].textContent);
  assert.deepStrictEqual(names, ['Wizard', 'Knight', 'Barbarian', 'Noble', 'Bandit']);

  // Confirm is dark and unresponsive until a class is picked
  assert.strictEqual(c.el('classConfirm').disabled, true);
  c.emitted.length = 0;

  cards[1].click();
  assert.strictEqual(c.api.state.classPick, 1);
  const picked = c.el('classList').children[1];
  assert.strictEqual(picked.classList.contains('sel'), true, 'the picked class is highlighted');
  assert.strictEqual(c.el('classConfirm').disabled, false, 'and Confirm wakes up');

  c.el('classConfirm').click();
  const sent = c.emitted.filter((e) => e.event === 'chooseClass');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(plain(sent[0].data), { modelIndex: 1 });
});

test('the chooser describes a class and lists its skills, passives marked passive', () => {
  const c = boot();
  c.api.state.classes = CLASS_FIXTURE;
  c.api.showClassChoose();

  // nothing picked: the prompt is showing, not a class
  assert.match(c.el('classDesc').children[0].textContent, /Hover a class/);

  c.api.renderClassDesc(2);
  const body = c.el('classDesc').children;
  assert.strictEqual(body[0].textContent, 'Barbarian', 'the class is named');
  assert.match(body[1].textContent, /brawler/, 'with its description');
  const kinds = Array.from(body).slice(2).map((row) => row.className);
  assert.ok(kinds.some((k) => /passive/.test(k)), 'a passive skill is listed');
  assert.ok(kinds.some((k) => /active/.test(k)), 'an active skill is listed');
});

test('a new account reads the rules before it picks a class', () => {
  const c = boot();
  c.socket.ackResponse = {
    ok: true, code: 'C3', name: 'New', needsClass: true, rulesSeen: false, classes: CLASS_FIXTURE,
  };
  c.el('nameInput').value = 'New';
  c.el('loginBtn').click();

  assert.strictEqual(c.el('rules').classList.contains('hidden'), false, 'the rules come first');
  assert.strictEqual(c.el('classChoose').classList.contains('hidden'), true, 'the chooser waits');
  c.emitted.length = 0;

  c.api.hideRules();
  assert.ok(c.emitted.some((e) => e.event === 'rulesSeen'), 'closing it records it');
  assert.strictEqual(c.el('classChoose').classList.contains('hidden'), false, 'then the chooser opens');
});

test('confirming a class takes the server\'s answer and clears the chooser', () => {
  const c = boot();
  c.socket.ackResponse = {
    ok: true, code: 'C4', name: 'Ann', model: 3, classes: CLASS_FIXTURE,
    state: { you: stateAt(5, -1), rev: 1, world: { width: 50, surfaceY: 0, seed: 7 }, blocks: [], players: [] },
  };
  c.api.state.classes = CLASS_FIXTURE;
  c.api.showClassChoose();
  c.api.selectClass(3);
  assert.strictEqual(c.el('classConfirm').disabled, false);
  c.el('classConfirm').click();

  assert.strictEqual(c.el('classChoose').classList.contains('hidden'), true, 'the chooser closes');
  assert.strictEqual(c.api.state.pendingClass, false);
  assert.strictEqual(c.api.state.model, 3, 'the server names the class we ended up as');
  assert.strictEqual(c.el('pClass').textContent, 'Noble', 'and the profile names it');
});

// ================= the classes and the monsters =================

const { MINIBOSS_SPECIES, GATE_SPECIES } = require('./monsters');

/** Every char a pixel table uses must be in its palette, or it is invisible. */
function artIsSound(art, width) {
  assert.ok(art && art.palette && Array.isArray(art.pixels), 'has a palette and pixels');
  const pal = new Set(Object.keys(art.palette));
  for (const row of art.pixels) {
    assert.strictEqual(row.length, width, `"${row}" is ${width} wide`);
    for (const ch of row) {
      assert.ok(ch === '.' || pal.has(ch), `"${ch}" has a colour`);
    }
  }
}

test('every class has its own field and battle art', () => {
  const c = boot();
  assert.strictEqual(c.api.MODELS.length, 5, 'five classes, matching the server');
  assert.strictEqual(new Set(c.api.MODELS.map((m) => m.id)).size, 5, 'with distinct ids');
  for (const m of c.api.MODELS) {
    assert.ok(m.name, `${m.id} has a display name`);
    artIsSound(c.api.HERO_FIELD[m.id], 16);
    artIsSound(c.api.HERO_BATTLE[m.id], 20);
  }
  // the field sprite is pre-rendered at 2x, so it fills one 32px tile
  const sprite = c.api.fieldSprite(0);
  assert.strictEqual(sprite.width, 32);
  assert.strictEqual(sprite.height, 32);
});

test('every monster the server can roll has art the client can draw', () => {
  const c = boot();
  const all = [...MINIBOSS_SPECIES, ...GATE_SPECIES];
  for (const s of all) {
    artIsSound(c.api.MONSTERS[s.id], 20);
  }
  for (const id of Object.keys(c.api.MONSTERS)) {
    assert.ok(all.some((s) => s.id === id), `the client invents no species the server cannot name: ${id}`);
  }
});

test('a boss draws its species art, falling back to its kind', () => {
  const c = boot();
  const widthOf = (boss) => {
    c.api.renderBoss({ boss, bossTurn: false });
    return c.el('bsBoss').children[0].children[0].width;
  };
  // 20px monster art at 7x
  assert.strictEqual(widthOf({ name: 'Undead Knight', kind: 'miniboss', species: 'undead', hp: 5, maxHp: 5 }), 140);
  // a fight started before species existed still has a pose to draw
  assert.strictEqual(widthOf({ name: 'Cave Brute', kind: 'miniboss', hp: 5, maxHp: 5 }), 112, 'brute for a miniboss');
  assert.strictEqual(widthOf({ name: 'Gate Warden', kind: 'gate', hp: 5, maxHp: 5 }), 112, 'warden for a gate');
});

test('the field blits a class sprite, and a flat marker for the dead', () => {
  const c = boot();
  const ctx = c.el('cv').getContext();

  c.ops.length = 0;
  c.api.drawPlayer(ctx, { model: 2, name: 'Bo', alive: true }, 32, 64);
  const blit = c.ops.find((o) => o.op === 'drawImage');
  assert.ok(blit, 'one blit paints the whole class');
  assert.strictEqual(blit.args[1], 32, 'at the tile x');
  assert.strictEqual(blit.args[2], 64, 'and the tile y');

  c.ops.length = 0;
  c.api.drawPlayer(ctx, { model: 0, name: 'Ann', alive: false }, 0, 0);
  assert.ok(!c.ops.some((o) => o.op === 'drawImage'), 'no sprite for a body');
  assert.ok(c.ops.some((o) => o.op === 'fillRect'), 'just a flat grey marker');
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

// ================= emotes (v0.5.0) =================

test('the emote picker offers exactly the emotes the bubble can draw', () => {
  const c = boot();
  const ids = plain(c.api.EMOTE_LIST).map((e) => e.id);
  assert.deepStrictEqual(ids, ['wave', 'smile', 'shout', 'oops', 'thumbsup']);
  for (const em of c.api.EMOTE_LIST) {
    assert.strictEqual(c.api.emoteGlyph(em.id), em.glyph, `${em.id} draws its own glyph`);
    assert.ok(em.label, `${em.id} has a tooltip`);
  }
  assert.strictEqual(c.api.emoteGlyph('moonwalk'), '😊', 'an unknown emote still has something to draw');
});

test('the emote popup is filled with one button per emote', () => {
  const c = boot();
  const buttons = c.el('emoteList').children;
  assert.strictEqual(buttons.length, c.api.EMOTE_LIST.length, 'one button per emote');
  const ids = [];
  for (let i = 0; i < buttons.length; i++) ids.push(buttons[i].dataset.emote);
  assert.deepStrictEqual(ids, plain(c.api.EMOTE_LIST).map((e) => e.id));
});

test('picking an emote sends it and gets the popup out of the way', () => {
  // BUGS v0.5.0-pre1: the buttons were wired, but nothing was ever sent that
  // the server would take, so no bubble appeared anywhere. This checks the
  // button actually asks the server for a known emote.
  const c = loggedIn(boot());
  c.api.showEmotes();
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), false, 'the popup is open');
  c.emitted.length = 0;

  c.el('emoteList').children[0].click();
  const sent = c.emitted.filter((e) => e.event === 'action');
  assert.strictEqual(sent.length, 1, 'one action is sent');
  assert.deepStrictEqual(plain(sent[0].data), { type: 'emote', id: 'wave', rev: 1 });
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true, 'and it closes behind us');
});

test('P opens and closes the emote popup', () => {
  const c = loggedIn(boot());
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true, 'starts closed');
  c.fire('keydown', keyEvent('p'));
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), false, 'P opens it');
  c.fire('keydown', keyEvent('p'));
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true, 'P closes it again');
});

test('P does nothing before logging in, because a watcher has no face to pull', () => {
  const c = boot();
  c.fire('keydown', keyEvent('p'));
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true);
});

test('Esc closes the emote popup like every other dialog', () => {
  const c = loggedIn(boot());
  c.api.showEmotes();
  const esc = keyEvent('Escape');
  c.fire('keydown', esc);
  assert.strictEqual(c.el('emotePanel').classList.contains('hidden'), true, 'the popup is closed');
  assert.strictEqual(esc.defaultPrevented, true, 'and the key was consumed');
});

test('the emote popup has a position of its own, so it is not a button that does nothing', () => {
  const css = cssFor('#emotePanel');
  assert.strictEqual(css.position, 'absolute', 'it is placed, not left in the flow');
  assert.ok(css.top, 'with a top');
  assert.ok(css.right, 'and a right');
  assert.ok(css['z-index'], 'and a layer above the field');
});

test('our own emote bubble is drawn while it lasts, and gone once it lapses', () => {
  const c = loggedIn(boot());
  const base = {
    rev: 2,
    world: { width: 50, surfaceY: 0, seed: 7 },
    config: { worldWidth: 50 },
    blocks: [{ x: 5, y: 3, type: 'air', item: null }],
  };

  c.api.applyState({
    ...base,
    you: stateAt(5, 3, { emote: { id: 'wave', until: Date.now() + 5000 } }),
    players: [],
  });
  c.ops.length = 0;
  c.frames[c.frames.length - 1](1000);
  assert.ok(
    c.ops.some((o) => o.op === 'fillText' && o.args[0] === '👋'),
    'the wave glyph is drawn above our head',
  );

  c.api.applyState({
    ...base,
    rev: 3,
    you: stateAt(5, 3, { emote: { id: 'wave', until: Date.now() - 1 } }),
    players: [],
  });
  c.ops.length = 0;
  c.frames[c.frames.length - 1](2000);
  assert.ok(
    !c.ops.some((o) => o.op === 'fillText' && o.args[0] === '👋'),
    'a lapsed emote is not drawn',
  );
});

// ================= inventory & battle =================

test('I opens the inventory popup and Esc closes it', () => {
  const c = loggedIn(boot());
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), true, 'starts closed');
  c.fire('keydown', keyEvent('i'));
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), false, 'I opens it');
  const esc = keyEvent('Escape');
  c.fire('keydown', esc);
  assert.strictEqual(c.el('inventoryPanel').classList.contains('hidden'), true, 'Esc closes it');
  assert.strictEqual(esc.defaultPrevented, true);
});

test('equipping a weapon sends its id, and the hand follows the server', () => {
  const c = loggedIn(boot());
  c.api.applyState({
    you: stateAt(5, -1, { weapons: ['sword', 'rapier'], weapon: 'sword', potion: 0 }),
    rev: 2,
    world: { width: 50, surfaceY: 0, seed: 7 },
    config: { worldWidth: 50 },
    blocks: [],
    players: [],
  });
  c.fire('keydown', keyEvent('i'));
  // the weapon tab, then the Equip button on the unequipped rapier
  const tabs = c.el('invTabs').children[0].children;
  tabs[1].click();
  c.emitted.length = 0;
  const body = c.el('invBody').children[0];
  // rows are sword then rapier; the rapier's Equip button is its first child
  body.children[1].children[0].click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'equipWeapon', rev: 2, id: 'rapier' });
});

test('the weapon tab offers bare hands, so a weapon can always be put away', () => {
  const c = loggedIn(boot());
  c.api.applyState({
    you: stateAt(5, -1, { weapons: ['bare', 'sword'], weapon: 'sword', potion: 0 }),
    rev: 2,
    world: { width: 50, surfaceY: 0, seed: 7 },
    config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  c.fire('keydown', keyEvent('i'));
  c.el('invTabs').children[0].children[1].click();
  const body = c.el('invBody').children[0];
  assert.strictEqual(body.children.length, 2, 'bare hands and the sword are both listed');
  const bareRow = body.children[0];
  assert.match(bareRow.children[1].textContent, /Bare-handed/, 'the first row is bare hands');
  c.emitted.length = 0;
  bareRow.children[0].click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'equipWeapon', rev: 2, id: 'bare' });
});

test('a battle state shows the full-screen fight, and clearing it hides it', () => {
  const c = loggedIn(boot());
  const battle = {
    id: 3, kind: 'miniboss', phase: 'active', round: 1, turn: 1, isMyTurn: true,
    bossTurn: false, turnDelayMs: 12000, deadline: Date.now() + 12000, joinDeadline: 0, partyMax: 4,
    boss: { name: 'Cave Brute', kind: 'miniboss', hp: 10, maxHp: 20, attack: 5 },
    cell: { x: 5, y: 3 }, queue: [1],
    party: [{ id: 1, name: 'Ann', hp: 30, maxHp: 30, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null, model: 0 }],
    me: { hp: 30, maxHp: 30, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null, skill: null, dynamite: 0, trap: 0, potion: 0, model: 0 },
    log: [{ text: 'A Cave Brute blocks the way!', kind: 'bad' }],
  };
  c.api.applyState({
    you: stateAt(5, 2, { battle }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  assert.strictEqual(c.el('battleScreen').classList.contains('hidden'), false, 'the fight is on screen');
  assert.strictEqual(c.el('bsBoss').children.length, 1, 'the boss is drawn up top');
  assert.strictEqual(c.el('bsParty').children.length, 1, 'and the party row below');
  assert.strictEqual(c.el('battleTurn').textContent, 'Your turn!', 'with the call to act');
  assert.ok(c.el('bsTurnOrder').children[0].children.length >= 3, 'and the running order');

  c.api.applyState({
    you: stateAt(5, 2, { battle: null }),
    rev: 3, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  assert.strictEqual(c.el('battleScreen').classList.contains('hidden'), true, 'and gone when the fight ends');
  assert.strictEqual(c.el('tooltip').classList.contains('hidden'), true, 'with no tooltip left behind');
});

test('the field keys are frozen in a fight, so nothing moves behind it', () => {
  const c = loggedIn(boot());
  c.api.state.battle = { id: 1, phase: 'active', isMyTurn: true, party: [], me: null, boss: {}, log: [] };
  const ev = keyEvent('s');
  c.fire('keydown', ev);
  assert.strictEqual(ev.defaultPrevented, true, 'the key is consumed');
  assert.strictEqual(c.emitted.filter((e) => e.event === 'action').length, 0, 'and no move is sent');
});

test('a gate invite reaches the pit, and Join sends the battle id', () => {
  const c = loggedIn(boot());
  c.server('battleInvite', { battleId: 9, kind: 'gate', boss: 'Gate Warden 1', partyMax: 4, cell: { x: 3, y: 3 } });
  assert.strictEqual(c.el('inviteBar').classList.contains('hidden'), false, 'the invite is showing');

  c.emitted.length = 0;
  c.el('inviteJoin').click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'joinBattle', rev: 1, id: 9 });
  assert.strictEqual(c.el('inviteBar').classList.contains('hidden'), true, 'and it closes behind the click');
});

test('the fight takes over the screen, and the popups are placed of their own', () => {
  const screen = cssFor('#battleScreen');
  assert.strictEqual(screen.position, 'fixed', 'the fight is pinned over the whole viewport');
  assert.strictEqual(screen.inset, '0', 'covering every edge');
  assert.ok(screen['z-index'], 'and above the field');
  assert.ok(cssFor('#bsTurnOrder').position, 'the running order is placed too');
  const tip = cssFor('#tooltip');
  assert.strictEqual(tip.position, 'fixed', 'the tooltip floats over everything');
  assert.strictEqual(tip['white-space'], 'pre-line', 'keeping the stat line and the prose apart');
  const inv = cssFor('#inventoryPanel');
  assert.strictEqual(inv.position, 'absolute', 'the inventory is placed');
  assert.ok(inv.top && inv.right, 'with a top and a right');
  const result = cssFor('#battleResult');
  assert.strictEqual(result.position, 'absolute', 'the loot window is placed over the fight');
  assert.ok(result['z-index'], 'and above it');
  assert.ok(cssFor('.bsFighter.target').filter, 'the heal cursor is something to see');
});

/** A minimal fight view the renderBattle tests can hand to applyState. */
function battleState(over = {}) {
  return {
    id: 1, kind: 'gate', phase: 'active', bossTurn: false, turn: 1, isMyTurn: true,
    initiator: 1, joinDeadline: 0, deadline: 0, queue: [1], partyMax: 4,
    boss: { name: 'Gate Warden', kind: 'gate', hp: 10, maxHp: 10 },
    party: [{ id: 1, name: 'Ann', model: 0, hp: 10, maxHp: 10, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null }],
    me: { id: 1, model: 0, hp: 10, maxHp: 10, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null, skill: null, skills: [], dynamite: 0, trap: 0, potion: 0 },
    log: [],
    ...over,
  };
}

test('a gate fight can be started early from the battle screen', () => {
  const c = loggedIn(boot());
  const b = battleState({ phase: 'join', turn: null, isMyTurn: false, joinDeadline: Date.now() + 10000 });
  c.api.applyState({
    you: stateAt(5, 2, { battle: b }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  assert.match(c.el('battleTurn').textContent, /Waiting for allies/);
  const start = c.el('battleActions').children[0].children[0];
  assert.strictEqual(start.textContent, 'Start', 'the wait can be cut short');

  c.emitted.length = 0;
  start.click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'startBattle', rev: 2 });
});

test('only the initiator is offered the Start button', () => {
  // BUGS v0.6.0-pre3: every member could skip the wait, not just the one who
  // opened the fight.
  const c = loggedIn(boot());
  const b = battleState({
    phase: 'join', turn: null, isMyTurn: false, joinDeadline: Date.now() + 10000,
    initiator: 2,
  });
  c.api.applyState({
    you: stateAt(5, 2, { battle: b }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  assert.match(c.el('battleTurn').textContent, /Waiting for allies/);
  assert.strictEqual(c.el('battleActions').children[0].children.length, 0, 'an ally gets no skip button');
});

test('the running order keeps its size and rotates to the acting member', () => {
  // BUGS v0.6.0-pre3: the order shrank as every member spent their turn.
  const c = loggedIn(boot());
  const party = [1, 2, 3].map((id, i) => ({
    id, name: ['Ann', 'Bo', 'Cy'][i], model: 0, hp: 10, maxHp: 10,
    armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null,
  }));
  function show(turn) {
    c.api.applyState({
      you: stateAt(5, 2, { battle: battleState({ party, turn, isMyTurn: turn === 1, queue: [turn] }) }),
      rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
      blocks: [], players: [],
    });
    const list = c.el('bsTurnOrder').children[0];
    return { rows: Array.from(list.children).slice(1) };
  }

  const first = show(2);
  assert.strictEqual(first.rows.length, 4, 'three members and the boss, always');
  assert.match(first.rows[0].textContent, /1\. Bo/, 'the current actor leads');
  assert.match(first.rows[0].className, /now/, 'and is highlighted');

  const next = show(3);
  assert.strictEqual(next.rows.length, 4, 'the order does not shorten as turns pass');
  assert.match(next.rows[0].textContent, /1\. Cy/, 'it just rotates to the new actor');
  assert.match(next.rows[1].textContent, /2\. Ann/);
});

test('the battle item and skill menus swap instead of stacking', () => {
  // BUGS v0.6.0-pre3: opening one tab left the other open.
  const c = loggedIn(boot());
  const me = { ...battleState().me, weapon: 'staff', skill: 'incantation', potion: 1 };
  const b = battleState({ me });
  c.api.applyState({
    you: stateAt(5, 2, { battle: b }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  const itemTab = c.el('battleActions').children[0].children[2];
  const skillTab = c.el('battleActions').children[0].children[3];

  itemTab.click();
  assert.strictEqual(c.el('battleItemMenu').classList.contains('hidden'), false, 'the items open');
  skillTab.click();
  assert.strictEqual(c.el('battleSkillMenu').classList.contains('hidden'), false, 'the skills open');
  assert.strictEqual(c.el('battleItemMenu').classList.contains('hidden'), true, 'and the items close');

  itemTab.click();
  assert.strictEqual(c.el('battleItemMenu').classList.contains('hidden'), false, 'and back again');
  assert.strictEqual(c.el('battleSkillMenu').classList.contains('hidden'), true, 'with the skills closed');
});

test('a fighter flashes white when its hp drops', () => {
  const c = loggedIn(boot());
  const b = battleState({
    boss: { name: 'Gate Warden', kind: 'gate', hp: 10, maxHp: 10 },
    party: [{ id: 1, name: 'Ann', model: 0, hp: 10, maxHp: 10, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null }],
    me: { ...battleState().me, id: 1 },
  });
  applyBattle(c, b);
  assert.strictEqual(c.el('bsBoss').children[0].classList.contains('hit'), false, 'no flash on the first look');

  b.boss.hp = 4;
  b.party[0].hp = 6;
  applyBattle(c, b);
  assert.strictEqual(c.el('bsBoss').children[0].classList.contains('hit'), true, 'the boss flashes');
  assert.strictEqual(c.el('bsParty').children[0].children[0].classList.contains('hit'), true, 'and the wounded member');

  // the state event and the action's ack both rebuild the fight with the same
  // hp: the second render must not wipe the flash before it is painted
  applyBattle(c, b);
  assert.strictEqual(c.el('bsBoss').children[0].classList.contains('hit'), true,
    'a redundant re-render keeps the flash alive');
});

test('a blow soaked entirely by armour still flashes the fighter', () => {
  const c = loggedIn(boot());
  const b = battleState({
    boss: { name: 'Gate Warden', kind: 'gate', hp: 10, maxHp: 10 },
    party: [{
      id: 1, name: 'Ann', model: 0, hp: 10, maxHp: 10,
      armour: 12, maxArmour: 12, defending: false, incantation: false, weapon: null,
    }],
    me: { ...battleState().me, id: 1 },
  });
  applyBattle(c, b);
  assert.strictEqual(c.el('bsParty').children[0].children[0].classList.contains('hit'), false,
    'no flash before the blow');

  // the blow is fully absorbed: hp holds, only the armour overlay recedes
  b.party[0].armour = 5;
  applyBattle(c, b);
  assert.strictEqual(c.el('bsParty').children[0].children[0].classList.contains('hit'), true,
    'the armoured fighter flashes even though its hp never moved');
});

test('the flash window closes so a settled fighter stops flashing', () => {
  const c = boot();
  const t = 1000;
  assert.strictEqual(c.api.battleHit('boss', 10, 0, t), false, 'first sighting never flashes');
  assert.strictEqual(c.api.battleHit('boss', 4, 0, t + 1), true, 'a drop flashes');
  assert.strictEqual(c.api.battleHit('boss', 4, 0, t + 2), true, 'and again while the window is open');
  assert.strictEqual(c.api.battleHit('boss', 4, 0, t + 5000), false, 'but not once it has passed');
  assert.strictEqual(c.api.battleHit('boss', 9, 0, t + 5001), false, 'a heal never flashes');
  // armour tells the same story as hp: a fall is a hit, a hold is nothing
  assert.strictEqual(c.api.battleHit('ann', 10, 12, t), false, 'armour on first sighting never flashes');
  assert.strictEqual(c.api.battleHit('ann', 10, 5, t + 1), true, 'a soaked blow flashes without an hp drop');
  assert.strictEqual(c.api.battleHit('ann', 10, 5, t + 5000), false, 'and settles once the window passes');
});

test('the damage flash is a real white animation', () => {
  assert.match(STYLES, /\.bsFighter\.hit\s+\.bsSprite\s*\{[^}]*animation:bsHit/);
  assert.match(STYLES, /@keyframes bsHit\s*\{[^}]*brightness\(0\)\s*invert\(1\)/);
});

// ================= healing-item targeting =================

const twoUp = () => ([
  { id: 1, name: 'Ann', model: 0, hp: 10, maxHp: 10, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null },
  { id: 2, name: 'Bo', model: 0, hp: 6, maxHp: 10, armour: 0, maxArmour: 0, defending: false, incantation: false, weapon: null },
]);

function applyBattle(c, battle) {
  c.api.applyState({
    you: stateAt(5, 2, { battle }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
}

/** Open the Item tab and click the potion, which should start aiming. */
function aimPotion(c) {
  c.el('battleActions').children[0].children[2].click();
  c.el('battleItemMenu').children[0].children[2].click();
}

test('a healing item opens a target cursor on the wielder instead of firing', () => {
  const c = loggedIn(boot());
  const me = { ...battleState().me, id: 1, potion: 1 };
  applyBattle(c, battleState({ party: twoUp(), me, queue: [1, 2] }));

  aimPotion(c);

  assert.strictEqual(c.el('battleItemMenu').classList.contains('hidden'), true, 'the item menu closes');
  assert.deepStrictEqual(plain(c.api.state.battleTarget), { type: 'useBattleItem', item: 'potion', target: 1 });
  assert.match(c.el('battleTurn').textContent, /Use potion on Ann/);
  assert.strictEqual(c.el('battleActions').children[0].children.length, 0, 'the verbs step aside for the aim');
  assert.strictEqual(c.el('bsParty').children[0].children[0].classList.contains('target'), true, 'the cursor lights the wielder');
  assert.strictEqual(c.emitted.length, 0, 'and nothing is sent until the throw');
});

test('the arrow keys walk the cursor and Enter throws the item', () => {
  const c = loggedIn(boot());
  const me = { ...battleState().me, id: 1, potion: 1 };
  applyBattle(c, battleState({ party: twoUp(), me, queue: [1, 2] }));
  aimPotion(c);

  c.fire('keydown', keyEvent('ArrowRight'));
  assert.strictEqual(c.api.state.battleTarget.target, 2, 'the cursor walks to the next member');
  assert.match(c.el('battleTurn').textContent, /Use potion on Bo/);
  assert.strictEqual(c.el('bsParty').children[0].children[1].classList.contains('target'), true, 'and the highlight follows');

  c.emitted.length = 0;
  c.fire('keydown', keyEvent('Enter'));
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'useBattleItem', item: 'potion', target: 2, rev: 2 });
  assert.strictEqual(c.api.state.battleTarget, null, 'the aim is spent');
});

test('a potion aimed at a whole-health member is refused with a message', () => {
  const c = loggedIn(boot());
  const party = twoUp();
  party[1].hp = 10;
  const me = { ...battleState().me, id: 1, potion: 1 };
  applyBattle(c, battleState({ party, me, queue: [1, 2] }));
  aimPotion(c);
  c.fire('keydown', keyEvent('ArrowRight'));

  c.emitted.length = 0;
  c.fire('keydown', keyEvent('Enter'));
  assert.strictEqual(c.emitted.length, 0, 'no wasted throw is sent');
  assert.strictEqual(c.api.state.battleTarget.target, 2, 'and the cursor stays put');
  const toasts = c.el('toasts').children;
  assert.strictEqual(toasts[toasts.length - 1].textContent, 'HP is full');
});

test('Escape drops the target cursor without throwing anything', () => {
  const c = loggedIn(boot());
  const me = { ...battleState().me, id: 1, potion: 1 };
  applyBattle(c, battleState({ party: twoUp(), me, queue: [1, 2] }));
  aimPotion(c);

  c.fire('keydown', keyEvent('Escape'));
  assert.strictEqual(c.api.state.battleTarget, null, 'the aim is gone');
  assert.strictEqual(c.el('battleActions').children[0].children.length, 4, 'and the verbs are back');
  assert.strictEqual(c.emitted.length, 0, 'with nothing thrown');
});

test('a non-targetable item still fires in one click', () => {
  const c = loggedIn(boot());
  const me = { ...battleState().me, dynamite: 1 };
  applyBattle(c, battleState({ me, queue: [1] }));

  c.el('battleActions').children[0].children[2].click();
  c.el('battleItemMenu').children[0].children[0].click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'useBattleItem', item: 'dynamite', rev: 2 });
  assert.strictEqual(c.api.state.battleTarget, null, 'no cursor for a thrown explosive');
});


test('the join countdown ticks every frame instead of waiting for a sync', () => {
  // BUGS v0.6.0-pre3: the countdown only moved when the 5s fallback sync fired.
  const c = loggedIn(boot());
  const b = battleState({ phase: 'join', turn: null, isMyTurn: false, joinDeadline: Date.now() + 4000 });
  c.api.applyState({
    you: stateAt(5, 2, { battle: b }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  c.frames[c.frames.length - 1](1000);
  assert.match(c.el('battleTurn').textContent, /4s/, 'four seconds on the clock');

  c.api.state.battle.joinDeadline = Date.now() + 900;
  c.frames[c.frames.length - 1](1016);
  assert.match(c.el('battleTurn').textContent, /1s/, 'and it moves without a server event');
});

test('the Skill button lists class skills, offering actives and dimming passives', () => {
  const c = loggedIn(boot());
  const skills = [
    { id: 'hardened_knuckles', name: 'Hardened knuckles', kind: 'passive', desc: 'Fists bite harder.', usable: false },
    { id: 'battle_cry', name: 'Battle cry', kind: 'active', desc: 'Roar to heal.', usable: true },
  ];
  const me = { ...battleState().me, weapon: 'staff', skill: 'incantation', skills };
  const b = battleState({ me });
  c.api.applyState({
    you: stateAt(5, 2, { battle: b }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  const acts = c.el('battleActions').children[0].children;
  assert.strictEqual(acts[0].textContent, 'Attack', 'the old Action label is gone');
  const skill = acts[3];
  assert.strictEqual(skill.textContent, 'Skill');
  skill.click();
  assert.strictEqual(c.el('battleSkillMenu').classList.contains('hidden'), false, 'the menu opens');

  const menu = c.el('battleSkillMenu').children[0].children;
  assert.strictEqual(menu[0].textContent, 'Hardened knuckles');
  assert.ok(menu[0].classList.contains('passive'), 'a passive is drawn as one');
  assert.strictEqual(menu[1].textContent, 'Battle cry');
  assert.strictEqual(menu[1].classList.contains('passive'), false);

  // the passive does nothing when pressed; the active sends its id
  c.emitted.length = 0;
  menu[0].click();
  assert.strictEqual(c.emitted.length, 0, 'a passive never fires');
  menu[1].click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'skill', rev: 2, id: 'battle_cry' });
  assert.strictEqual(c.el('battleSkillMenu').classList.contains('hidden'), true, 'and the menu closes');

  // a fighter with no skills says so rather than offering a dead button
  c.api.state.battle.me.skills = [];
  assert.deepStrictEqual(plain(c.api.battleSkills()), []);
  c.el('battleActions').children[0].children[3].click();
  assert.strictEqual(c.el('battleSkillMenu').children[0].children[0].textContent, 'No skills');
});

test('a won fight shows the loot window, and Confirm sends the release', () => {
  const c = loggedIn(boot());
  const b = battleState({
    phase: 'result', isMyTurn: false, turn: null,
    me: { ...battleState().me, gained: { weapon: 'rapier', items: { potion: 2 } } },
  });
  c.api.applyState({
    you: stateAt(5, 2, { battle: b }),
    rev: 2, world: { width: 50, surfaceY: 0, seed: 7 }, config: { worldWidth: 50 },
    blocks: [], players: [],
  });
  assert.strictEqual(c.el('battleResult').classList.contains('hidden'), false, 'the loot window is up');
  assert.match(c.el('battleResultBoss').textContent, /defeated/);
  assert.strictEqual(c.el('battleResultBody').children.length, 2, 'the weapon and the potions');

  c.emitted.length = 0;
  c.el('battleResultConfirm').click();
  assert.deepStrictEqual(plain(c.emitted[0].data), { type: 'confirmResult', rev: 2 });
});

test('the tooltip follows the pointer and hides on the way out', () => {
  const c = boot();
  c.api.showTip('Amour +5', { clientX: 100, clientY: 50 });
  const tip = c.el('tooltip');
  assert.strictEqual(tip.classList.contains('hidden'), false, 'shown');
  assert.strictEqual(tip.textContent, 'Amour +5');
  assert.strictEqual(tip.style.left, '116px', 'offset from the pointer');
  assert.strictEqual(tip.style.top, '66px');
  c.api.moveTip({ clientX: 10, clientY: 20 });
  assert.strictEqual(tip.style.left, '26px', 'and it keeps up as the mouse moves');
  c.api.hideTip();
  assert.strictEqual(tip.classList.contains('hidden'), true, 'gone again');
});

test('a weapon tooltip carries the stats, the flavour and any skill', () => {
  const c = boot();
  const text = c.api.weaponTip({
    name: 'Iron Sword', damage: 6, hit: 0.8, crit: 0.15,
    desc: 'A trusty blade.', skill: { name: 'Cleave' },
  });
  assert.match(text, /Iron Sword/);
  assert.match(text, /\b6\b/, 'its damage');
  assert.match(text, /A trusty blade\./, 'the flavour text');
  assert.match(text, /Cleave/, 'and the skill, when there is one');
  assert.doesNotMatch(c.api.weaponTip({ name: 'Stick', damage: 2, hit: 0.5, crit: 0 }), /skill|Cleave/i);
});

test('ground loot is added and removed by the drop and take events', () => {
  const c = loggedIn(boot());
  c.server('lootDropped', { x: 4, y: 4, type: 'weapon', id: 'rapier' });
  assert.deepStrictEqual(plain(c.api.state.loot), [{ x: 4, y: 4, type: 'weapon', id: 'rapier' }]);
  c.server('lootTaken', { x: 4, y: 4 });
  assert.deepStrictEqual(plain(c.api.state.loot), [], 'stepped on, so it is gone');
});

test('bedrock and boss blocks have their own colours', () => {
  const c = boot();
  assert.ok(c.api.COLORS.bedrock, 'bedrock is coloured, not left as unknown grey');
  assert.ok(c.api.COLORS.boss, 'and so is a boss');
});
