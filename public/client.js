'use strict';

// ---------- Diggame client ----------
// Three rules this file exists to enforce:
//
//  1. The server owns the position. `you` is only ever copied from a message -
//     never derived from a keypress and a success flag. That arithmetic is what
//     desynchronised the old client (BUGS: "a block does not disappear until
//     the client reloads").
//  2. Every action carries `rev`. If the server answers `needSync`, the whole
//     state is taken again. If the answers stop arriving (a dropped packet, a
//     reconnect) a timer asks for one, so a dead socket cannot leave a stale
//     view on screen.
//  3. The only local clock arithmetic is the *display* of dig progress and
//     item timers, which is a rendering nicety and is corrected by the next
//     tick. Nothing that affects gameplay is computed here.

const socket = io();
const TILE = 32;

const MODELS = [
  { body: '#e55', hat: null },
  { body: '#59f', hat: '#fc0' },
  { body: '#6c6', hat: '#fff' },
  { body: '#c6f', hat: '#000' },
  { body: '#fa0', hat: '#333' },
];

const ITEM = {
  armor: { sym: '🛡', label: 'armour' },
  shovel: { sym: '⛏', label: 'golden shovel' },
  dynamite: { sym: '💣', label: 'dynamite' },
  trap: { sym: '🪤', label: 'bear trap' },
};

const state = {
  me: null,          // authoritative snapshot of *us*
  rev: 0,            // the rev that snapshot belongs to
  blocks: {},        // "x,y" -> { type, item }, only what we have discovered
  players: [],       // public snapshots of everyone, for drawing names
  myTraps: [],       // our own bear traps; secret to everyone else
  width: 50,
  surfaceY: 0,
  code: null,
  name: null,
  model: 0,
  stats: null,
  connected: false,
  halted: false,
  spectator: false,
  spec: { blocks: {}, players: [], digs: [], traps: [], width: 50, surfaceY: 0 },
  // spectator camera, in block coordinates. follow=true keeps the old
  // auto-centring on the action; touching WASD takes manual control.
  specCam: { x: 0, y: 0, follow: true, placed: false },
  keys: new Set(),   // movement keys currently held down, for the camera
  serverSkew: 0,     // Date.now() - server clock, for countdown rendering
  effects: [],       // short-lived visual effects
  flashes: {},       // "x,y" -> until, used to flash a block when it changes
  dig: null,         // { x, y, startedAt, duration } for the progress bar
  drawMe: { x: 0, y: 0 }, // interpolated render position, never gameplay state
};

const el = {
  login: document.getElementById('login'),
  game: document.getElementById('game'),
  spec: document.getElementById('spectator'),
  name: document.getElementById('nameInput'),
  code: document.getElementById('codeInput'),
  loginBtn: document.getElementById('loginBtn'),
  loginErr: document.getElementById('loginErr'),
  inventory: document.getElementById('inventory'),
  status: document.getElementById('status'),
  stats: document.getElementById('stats'),
  pName: document.getElementById('pName'),
  pCode: document.getElementById('pCode'),
  pMaxDepth: document.getElementById('pMaxDepth'),
  pDeaths: document.getElementById('pDeaths'),
  pItems: document.getElementById('pItems'),
  pRuns: document.getElementById('pRuns'),
  modelPicker: document.getElementById('modelPicker'),
  profile: document.getElementById('profile'),
  toasts: document.getElementById('toasts'),
  cv: document.getElementById('cv'),
  halt: document.getElementById('halt'),
  haltMsg: document.getElementById('haltMsg'),
};

const ctx = el.cv.getContext('2d');
const specCv = document.getElementById('cvSpec');
const specCtx = specCv.getContext('2d');

// ================= login =================

(function prefill() {
  const m = document.cookie.match(/digcode=([A-Z0-9]+)/);
  if (m) el.code.value = m[1];
})();

function login() {
  const name = el.name.value.trim();
  const code = el.code.value.trim().toUpperCase();
  if (!name && !code) {
    el.loginErr.textContent = 'Enter a name, or the code from a previous game.';
    return;
  }
  el.loginBtn.disabled = true;
  el.loginErr.textContent = '';
  socket.emit('login', { name, code, modelIndex: state.model }, (res) => {
    el.loginBtn.disabled = false;
    if (!res || res.error) {
      el.loginErr.textContent = (res && res.error) || 'Could not log in.';
      return;
    }
    state.code = res.code;
    state.name = res.name;
    state.model = res.model != null ? res.model : state.model;
    state.stats = res.stats || null;
    document.cookie = `digcode=${res.code}; max-age=${60 * 60 * 24 * 180}; path=/; SameSite=Lax`;
    el.login.classList.add('hidden');
    el.game.classList.remove('hidden');
    el.pName.textContent = res.name;
    el.pCode.textContent = res.code;
    buildModelPicker();
    resize();
    applyState(res.state);
  });
}

el.loginBtn.addEventListener('click', login);
for (const input of [el.name, el.code]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
}

// ================= state =================

/** Take a full authoritative state. The only way to (re)build the world view. */
function applyState(s) {
  if (!s) return;
  if (s.world) {
    state.width = s.world.width;
    state.surfaceY = s.world.surfaceY;
  }
  state.rev = typeof s.rev === 'number' ? s.rev : state.rev;
  state.blocks = {};
  for (const b of s.blocks) state.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
  state.players = s.players || [];
  takeYou(s.you);
  el.cv.classList.remove('hidden');
  updateHud();
}

/** Adopt the server's idea of where we are, and re-anchor the interpolation. */
function takeYou(you) {
  if (!you) return;
  const first = !state.me;
  state.me = you;
  // the snapshot knows which revision it was taken at, so a private event
  // (digComplete, state) is enough to keep our rev current. Without this the
  // next action goes out stale and is answered with a full resync.
  if (typeof you.rev === 'number') state.rev = you.rev;
  state.dig = you.digging ? { ...you.digging } : null;
  // our own traps: the only ones we are allowed to see (BUGS v0.3.0)
  state.myTraps = you.traps || [];
  state.serverSkew = Date.now() - (you.serverNow || Date.now());
  if (first || Math.abs(you.x - state.drawMe.x) > 2 || Math.abs(you.y - state.drawMe.y) > 2) {
    state.drawMe.x = you.x;
    state.drawMe.y = you.y;
    state.snap = true;
  }
}

/** Server time as best we can tell it, for rendering countdowns only. */
function now() { return Date.now() - state.serverSkew; }

function sync() {
  socket.emit('action', { type: 'sync', rev: state.rev }, (res) => {
    if (res && res.state) applyState(res.state);
  });
}

let pending = 0;
function sendAction(type, dir) {
  if (!state.me || state.halted) return;
  // keep the server's answers in order: a burst of keypresses must not be
  // answered out of order, which is how the old client ended up with a mix of
  // two different states
  if (pending > 8) return;
  pending++;
  socket.emit('action', { type, dir, rev: state.rev }, (res) => {
    pending--;
    if (!res) return;
    if (res.needSync) { applyState(res.state); return; }
    if (typeof res.rev === 'number') state.rev = res.rev;
    if (res.you) takeYou(res.you);
    const delta = res.delta || {};
    if (delta.revealed) reveal(delta.revealed);
    if (delta.destroyed) for (const c of delta.destroyed) markChanged(c.x, c.y);
    if (delta.trapPlaced) markChanged(delta.trapPlaced.x, delta.trapPlaced.y);
    if (!res.ok) complain(res.error);
    updateHud();
  });
}

const ERRORS = {
  stone: 'Stone — that will not budge.',
  occupied: 'Someone is standing there.',
  stuck: 'You are stuck in a bear trap!',
  wall: 'A wall.',
  above_surface: 'You cannot go higher than the surface.',
  not_diggable: 'Nothing to dig there.',
  no_dynamite: 'No dynamite left.',
  no_trap: 'No bear traps left.',
  dead: 'You are dead. Waiting to respawn…',
};

function complain(error) {
  const text = ERRORS[error] || (error ? `Cannot: ${error}` : '');
  if (text) toast(text, 'bad');
}

function reveal(cells) {
  for (const b of cells) {
    if (!b) continue;
    state.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
  }
}

function markChanged(x, y) {
  const k = x + ',' + y;
  if (state.blocks[k]) state.blocks[k] = { type: 'air', item: null };
  state.flashes[k] = now() + 350;
}

// ================= events =================

socket.on('connect', () => {
  state.connected = true;
  setStatus();
  // a reconnect means we may have missed anything at all
  if (state.me) sync();
});

socket.on('disconnect', () => {
  state.connected = false;
  setStatus();
  toast('Connection lost. Reconnecting…', 'bad');
});

socket.on('connect_error', () => {
  state.connected = false;
  setStatus();
});

socket.on('halted', ({ message } = {}) => {
  state.halted = true;
  el.haltMsg.textContent = message || 'The game has been halted by a server error.';
  el.halt.classList.remove('hidden');
  el.cv.classList.add('hidden');
});

socket.on('state', (msg) => {
  if (!msg) return;
  if (msg.you) takeYou(msg.you);
  updateHud();
  if (msg.reason === 'trapped') toast('A bear trap! You are stuck for a minute.', 'bad');
  if (msg.reason === 'died') toast('You died!', 'bad');
  if (msg.reason === 'trapRemoved') toast('One of your bear traps is gone.', 'bad');
});

socket.on('digComplete', (m) => {
  if (m.dug) markChanged(m.dug.x, m.dug.y);
  if (m.revealed) reveal(m.revealed);
  if (m.you) takeYou(m.you);
  if (m.item) toast(`Found ${ITEM[m.item] ? ITEM[m.item].sym + ' ' + ITEM[m.item].label : m.item}!`, 'good');
  if (m.bonus) toast('Behind the pack, and lucky.', 'good');
  updateHud();
});

socket.on('digAborted', (m) => {
  if (m.you) takeYou(m.you);
  toast(m.reason === 'blown_up' ? 'Somebody dynamited your dig.' : 'The block you were digging is gone.', 'bad');
  updateHud();
});

socket.on('respawned', (m) => {
  if (m.you) takeYou(m.you);
  state.drawMe.x = m.x != null ? m.x : state.me.x;
  state.drawMe.y = m.y != null ? m.y : state.me.y;
  toast('Respawned at the surface.', 'good');
  updateHud();
});

socket.on('blockDug', ({ x, y }) => markChanged(x, y));

socket.on('sharedDiscovery', ({ blocks }) => {
  // only sent when SHARE_DISCOVERIES is on
  reveal(blocks);
});

socket.on('boom', ({ x, y } = {}) => {
  addEffect('boom', x, y);
  if (state.me && Math.abs(state.me.x - x) <= 1 && Math.abs(state.me.y - y) <= 1) toast('BOOM!', 'good');
});

socket.on('trapTriggered', ({ x, y } = {}) => addEffect('trap', x, y));

socket.on('toast', ({ text, kind } = {}) => toast(text, kind));

socket.on('worldReset', (m) => {
  toast('A new game has started!', 'good');
  state.spec.blocks = {};
  state.spec.deepestY = 0;
  state.myTraps = [];
  if (m && m.state) applyState(m.state);
  else sync();
});

socket.on('kicked', ({ reason } = {}) => {
  toast(reason || 'You were disconnected.', 'bad');
  setTimeout(() => location.reload(), 1500);
});

socket.on('tick', (frame) => {
  if (state.spectator) return;
  if (frame.players) state.players = frame.players;
  for (const b of frame.blocks) markChanged(b.x, b.y);
  if (state.me && state.me.digging && !state.dig) state.dig = { ...state.me.digging };
  for (const e of frame.effects || []) addEffect(e.kind, e.x, e.y);
  // a targeted state event may have been missed; the next action will ask for
  // a full state anyway, and this keeps the HUD honest in the meantime
  if (state.me && !state.me.digging) state.dig = null;
});

socket.on('spectatorMode', (f) => {
  state.spectator = true;
  // a fresh spectator starts centred on the action; a previous camera position
  // is stale because the world underneath it has just been reset
  state.specCam = { x: 0, y: 0, follow: true, placed: false };
  state.keys.clear();
  state.spec.blocks = {};
  state.spec.deepestY = 0;
  applySpec(f);
  el.game.classList.add('hidden');
  el.spec.classList.remove('hidden');
  resize();
});

socket.on('spectatorFrame', (f) => {
  if (!state.spectator) return;
  applySpec(f);
});

// ================= spectator =================

function applySpec(f) {
  if (!f) return;
  let deepest = state.spec.deepestY || 0;
  for (const b of f.blocks || []) {
    state.spec.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
    if (b.y > deepest) deepest = b.y;
  }
  // the deepest cell anybody knows about, so the camera can be clamped to the
  // real bottom of the pit instead of an invented one
  state.spec.deepestY = deepest;
  state.spec.players = f.players || [];
  state.spec.digs = f.digs || [];
  state.spec.traps = f.traps || [];
  state.spec.width = f.width || state.spec.width;
  state.spec.surfaceY = f.surfaceY || 0;
  clampSpecCam();
}

document.getElementById('spectateBtn').addEventListener('click', () => socket.emit('spectate'));

// Hand the camera back to auto-follow. WASD takes it away again.
document.getElementById('followBtn').addEventListener('click', () => {
  state.specCam.follow = true;
  state.keys.clear();
});

document.getElementById('backBtn').addEventListener('click', () => {
  socket.emit('unspectate');
  state.spectator = false;
  state.keys.clear();
  el.spec.classList.add('hidden');
  el.game.classList.remove('hidden');
  el.cv.classList.remove('hidden');
  resize();
});

document.getElementById('menuBtn').addEventListener('click', () => el.profile.classList.toggle('hidden'));
document.getElementById('closeProfile').addEventListener('click', () => el.profile.classList.add('hidden'));

for (const b of document.querySelectorAll('#actions button')) {
  b.addEventListener('click', () => sendAction(b.dataset.act));
}

function buildModelPicker() {
  el.modelPicker.innerHTML = '';
  MODELS.forEach((m, i) => {
    const d = document.createElement('div');
    d.className = 'm' + (i === state.model ? ' sel' : '');
    d.style.background = m.body;
    if (m.hat) d.style.boxShadow = `inset 0 8px 0 ${m.hat}`;
    d.addEventListener('click', () => {
      state.model = i;
      socket.emit('setModel', i);
      buildModelPicker();
    });
    el.modelPicker.appendChild(d);
  });
}

// ================= input =================

// Scoped to the game view, and it never blocks typing: a keypress while the
// login form or a text field has focus is left alone (BUGS: "the keydown
// handler preventsDefault's on everything, so you cannot type your name").
const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
  q: 'useDynamite', Q: 'useDynamite',
  e: 'placeTrap', E: 'placeTrap',
};

function typingInAField(t) {
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}

// ---- input ----
// Scoped to the game view, and it never blocks typing: a keypress while the
// login form or a text field has focus is left alone (BUGS: "the keydown
// handler preventsDefault's on everything, so you cannot type your name").
window.addEventListener('keydown', (e) => {
  if (state.halted) return;
  if (typingInAField(e.target)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const dir = KEYS[e.key];
  if (!dir) return;

  // Spectating: the arrow keys and WASD drive the camera over the field instead
  // of moving a character (BUGS v0.3.0). Q and E are ignored here, so a
  // spectating player cannot dig or place traps from the spectator view.
  // Checked before state.me, because a socket may spectate without playing.
  if (state.spectator) {
    if (dir === 'useDynamite' || dir === 'placeTrap') return;
    e.preventDefault();
    state.specCam.follow = false;   // manual control from here on
    state.keys.add(dir);
    return;
  }

  // Not logged in yet: the login form owns the keyboard, including the letters
  // that would otherwise be movement keys.
  if (!state.me) return;

  // only swallow the keys we actually use, and only arrows and letters
  e.preventDefault();
  if (dir === 'useDynamite') sendAction('useDynamite');
  else if (dir === 'placeTrap') sendAction('placeTrap');
  else sendAction('move', dir);
});

// Held keys need a matching release, or the camera walks away on its own.
window.addEventListener('keyup', (e) => {
  const dir = KEYS[e.key];
  if (dir) state.keys.delete(dir);
});
// Releasing focus mid-keypress would otherwise leave a key stuck down.
window.addEventListener('blur', () => state.keys.clear());

// ================= hud =================

function setStatus() {
  const bits = [];
  if (!state.connected) bits.push('offline');
  if (state.me && !state.me.alive) bits.push('DEAD');
  const stuck = state.me ? Math.max(0, Math.ceil((state.me.stuckUntil - now()) / 1000)) : 0;
  if (stuck > 0) bits.push(`STUCK ${stuck}s`);
  el.status.textContent = bits.join(' · ');
  el.status.className = !state.connected ? 'bad' : '';
}

function updateHud() {
  if (!state.me) return;
  const m = state.me;
  const inv = [`🛡 ${m.armor}`, `💣 ${m.dynamite}`, `🪤 ${m.trap}`];
  const shovel = Math.max(0, Math.ceil((m.shovelUntil - now()) / 1000));
  if (shovel > 0) inv.push(`⛏ ${shovel}s`);
  el.inventory.textContent = inv.join('   ');
  setStatus();

  const depth = m.maxDepth || 0;
  const parts = [`depth ${depth}`];
  if (m.alive && m.digging) parts.push('digging…');
  el.stats.textContent = parts.join('  ·  ');
  updateProfile();
}

function updateProfile() {
  if (!state.stats) return;
  el.pMaxDepth.textContent = state.stats.maxDepth;
  el.pDeaths.textContent = state.stats.deaths;
  el.pItems.textContent = state.stats.itemsCollected;
  el.pRuns.textContent = state.stats.runsPlayed;
}

function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function addEffect(kind, x, y) {
  if (x == null || y == null) return;
  state.effects.push({ kind, x, y, until: Date.now() + (kind === 'boom' ? 700 : 400) });
  if (state.effects.length > 40) state.effects.splice(0, state.effects.length - 40);
}

// ================= rendering =================

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  el.cv.width = w; el.cv.height = h;
  specCv.width = w; specCv.height = h;
}
window.addEventListener('resize', resize);
resize();

const COLORS = { dirt: '#8b5a2b', grass: '#4a8a2c', stone: '#8a8a8a', spikes: '#c8c8c8', unknown: '#1b1b1b' };

function drawBlock(c, sx, sy, type, item, surface) {
  if (type === 'air' || type == null) return;
  const isSurface = surface && type === 'dirt';
  c.fillStyle = isSurface ? '#6b4a2a' : COLORS[type] || COLORS.unknown;
  c.fillRect(sx, sy, TILE, TILE);

  if (type === 'dirt') {
    c.fillStyle = 'rgba(0,0,0,0.15)';
    for (let i = 0; i < 4; i++) c.fillRect(sx + (i * 7) % TILE, sy + (i * 11) % TILE, 3, 3);
  } else if (type === 'stone') {
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    c.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
  } else if (type === 'spikes') {
    c.fillStyle = '#333';
    for (let i = 0; i < 4; i++) {
      const px = sx + i * 8 + 2;
      c.beginPath();
      c.moveTo(px, sy + TILE);
      c.lineTo(px + 4, sy + 6);
      c.lineTo(px + 8, sy + TILE);
      c.fill();
    }
  }

  if (isSurface) {
    // grass on top of the surface row
    c.fillStyle = COLORS.grass;
    c.fillRect(sx, sy, TILE, 6);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(sx, sy, TILE, 2);
  }

  if (item) {
    c.fillStyle = '#ff0';
    c.font = '16px sans-serif';
    c.textAlign = 'center';
    c.fillText((ITEM[item] || {}).sym || '?', sx + TILE / 2, sy + TILE / 2 + 6);
  }
}

function drawFlash(c, sx, sy) {
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 2;
  c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
}

function drawPlayer(c, p, sx, sy) {
  const m = MODELS[p.model] || MODELS[0];
  if (!p.alive) {
    c.fillStyle = 'rgba(120,120,120,0.5)';
    c.fillRect(sx + 4, sy + 8, TILE - 8, TILE - 10);
    return;
  }
  c.fillStyle = m.body;
  c.fillRect(sx + 4, sy + 8, TILE - 8, TILE - 10);
  c.fillStyle = '#f2c48d';
  c.fillRect(sx + 8, sy + 2, TILE - 16, 10);
  if (m.hat) {
    c.fillStyle = m.hat;
    c.fillRect(sx + 6, sy, TILE - 12, 4);
  }
  c.fillStyle = '#000';
  c.fillRect(sx + 11, sy + 6, 2, 2);
  c.fillRect(sx + TILE - 13, sy + 6, 2, 2);
  if (p.stuck) {
    c.strokeStyle = '#f44';
    c.lineWidth = 2;
    c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
  }
  c.font = '12px sans-serif';
  c.textAlign = 'center';
  c.strokeStyle = '#000';
  c.lineWidth = 3;
  c.strokeText(p.name, sx + TILE / 2, sy - 4);
  c.fillStyle = '#fff';
  c.fillText(p.name, sx + TILE / 2, sy - 4);
}

function drawDigBar(c, sx, sy, dig) {
  const progress = Math.max(0, Math.min(1, (now() - dig.startedAt) / dig.duration));
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fillRect(sx, sy, TILE, TILE);
  c.fillStyle = 'rgba(255,220,80,0.5)';
  c.fillRect(sx, sy + TILE * (1 - progress), TILE, TILE * progress);
  c.strokeStyle = '#ffd050';
  c.lineWidth = 2;
  c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
}

function drawEffect(c, e, cx, cy) {
  const t = 1 - (e.until - Date.now()) / (e.kind === 'boom' ? 700 : 400);
  const sx = e.x * TILE - cx, sy = e.y * TILE - cy;
  if (e.kind === 'boom') {
    c.fillStyle = `rgba(255,${180 - t * 160},0,${0.7 * (1 - t)})`;
    c.beginPath();
    c.arc(sx + TILE / 2, sy + TILE / 2, (4 + t * 40), 0, Math.PI * 2);
    c.fill();
  } else {
    c.strokeStyle = `rgba(255,80,80,${1 - t})`;
    c.lineWidth = 3;
    c.strokeRect(sx + 4, sy + 4, TILE - 8, TILE - 8);
  }
}

function background(c, W, H) {
  const grd = c.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#87ceeb');
  grd.addColorStop(0.35, '#5a5a5a');
  grd.addColorStop(1, '#1a1a1a');
  c.fillStyle = grd;
  c.fillRect(0, 0, W, H);
}

function renderGame(dt) {
  const W = el.cv.width, H = el.cv.height;
  background(ctx, W, H);
  if (!state.me) return;

  // Interpolate towards the authoritative position. This is presentation only:
  // a dropped frame or a slow packet makes it smoother, never wrong, and a
  // teleport-sized jump snaps instead of sliding.
  const tx = state.me.x, ty = state.me.y;
  const k = state.snap ? 1 : Math.min(1, dt / 60);
  state.drawMe.x += (tx - state.drawMe.x) * k;
  state.drawMe.y += (ty - state.drawMe.y) * k;
  state.snap = false;
  const cx = state.drawMe.x * TILE - W / 2 + TILE / 2;
  const cy = state.drawMe.y * TILE - H / 2 + TILE / 2;

  const x0 = Math.floor(cx / TILE) - 1, y0 = Math.floor(cy / TILE) - 1;
  const x1 = Math.ceil((cx + W) / TILE) + 1, y1 = Math.ceil((cy + H) / TILE) + 1;
  const t = now();

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sx = x * TILE - cx, sy = y * TILE - cy;
      if (x < 0 || x >= state.width) {
        ctx.fillStyle = '#000';
        ctx.fillRect(sx, sy, TILE, TILE);
        continue;
      }
      const b = state.blocks[x + ',' + y];
      if (b) drawBlock(ctx, sx, sy, b.type, b.item, y === state.surfaceY);
      const f = state.flashes[x + ',' + y];
      if (f && f > t) drawFlash(ctx, sx, sy);
    }
  }
  for (const k2 of Object.keys(state.flashes)) if (state.flashes[k2] < t) delete state.flashes[k2];

  // Our own bear traps. Nobody else can see these, so this is the only place
  // they appear in the game view (BUGS v0.3.0). Drawn under the players.
  ctx.fillStyle = 'rgba(255,60,60,0.4)';
  ctx.strokeStyle = 'rgba(255,80,80,0.9)';
  ctx.lineWidth = 2;
  for (const tr of state.myTraps) {
    const tx = tr.x * TILE - cx + 4, ty = tr.y * TILE - cy + 4;
    ctx.fillRect(tx, ty, TILE - 8, TILE - 8);
    ctx.strokeRect(tx, ty, TILE - 8, TILE - 8);
  }

  if (state.dig) {
    const sx = state.dig.x * TILE - cx, sy = state.dig.y * TILE - cy;
    drawDigBar(ctx, sx, sy, state.dig);
  }

  for (const p of state.players) {
    if (!state.me || p.id === state.me.id) continue;
    const sx = p.x * TILE - cx, sy = p.y * TILE - cy;
    if (sx < -TILE || sx > W + TILE || sy < -TILE || sy > H + TILE) continue;
    drawPlayer(ctx, p, sx, sy);
  }

  // ourselves last, so we are never hidden behind someone else
  drawPlayer(ctx, { ...state.me, alive: true, stuck: state.me.stuckUntil > t },
    state.drawMe.x * TILE - cx, state.drawMe.y * TILE - cy);

  state.effects = state.effects.filter((e) => e.until > Date.now());
  for (const e of state.effects) drawEffect(ctx, e, cx, cy);
}

const SPEC_SPEED = 9;      // blocks per second
const SPEC_MIN_Y = -6;     // a couple of rows of sky above the surface

/** How deep anybody has dug, so the camera can stop at the bottom of the pit. */
function specDeepestY() {
  let m = state.spec.surfaceY;
  for (const p of state.spec.players) if (p.alive) m = Math.max(m, p.y);
  for (const d of state.spec.digs) m = Math.max(m, d.y);
  // discovered cells only go as deep as the deepest dig, but be safe and use
  // whatever the world itself has opened up
  m = Math.max(m, state.spec.deepestY || 0);
  return m;
}

function clampSpecCam() {
  const c = state.specCam;
  const maxX = Math.max(0, state.spec.width - 1);
  const maxY = specDeepestY() + 2;
  c.x = Math.min(maxX, Math.max(0, c.x));
  c.y = Math.min(maxY, Math.max(SPEC_MIN_Y, c.y));
}

function moveSpecCam(dt) {
  const c = state.specCam;
  const k = state.keys;
  // diagonals are faster, same as a normal 8-way walk
  const dx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
  const dy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
  if (!dx && !dy) return false;
  c.follow = false;
  const len = Math.hypot(dx, dy) || 1;
  const step = SPEC_SPEED * (dt / 1000);
  c.x += (dx / len) * step;
  c.y += (dy / len) * step;
  clampSpecCam();
  return true;
}

function renderSpectator(dt) {
  const c = specCtx, W = specCv.width, H = specCv.height;
  background(c, W, H);
  const ps = state.spec.players;

  moveSpecCam(dt || 16);

  if (state.specCam.follow) {
    // auto-centre on the action, the way the spectator view used to behave
    let sx = 0, sy = 0, n = 0;
    for (const p of ps) if (p.alive) { sx += p.x; sy += p.y; n++; }
    if (!n) { sx = state.spec.width / 2; sy = state.spec.surfaceY; }
    else { sx /= n; sy /= n; }
    state.specCam.x = sx;
    state.specCam.y = sy;
  }
  clampSpecCam();

  const cx = state.specCam.x * TILE - W / 2, cy = state.specCam.y * TILE - H / 2;

  const x0 = Math.floor(cx / TILE) - 1, y0 = Math.floor(cy / TILE) - 1;
  const x1 = Math.ceil((cx + W) / TILE) + 1, y1 = Math.ceil((cy + H) / TILE) + 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x * TILE - cx, py = y * TILE - cy;
      if (x < 0 || x >= state.spec.width) {
        c.fillStyle = '#000';
        c.fillRect(px, py, TILE, TILE);
        continue;
      }
      const b = state.spec.blocks[x + ',' + y];
      if (b) drawBlock(c, px, py, b.type, b.item, y === state.spec.surfaceY);
    }
  }

  c.fillStyle = 'rgba(255,0,0,0.35)';
  for (const t of state.spec.traps) {
    c.fillRect(t.x * TILE - cx + 4, t.y * TILE - cy + 4, TILE - 8, TILE - 8);
  }
  for (const d of state.spec.digs) {
    c.fillStyle = 'rgba(255,220,80,0.35)';
    c.fillRect(d.x * TILE - cx, d.y * TILE - cy, TILE, TILE);
  }
  for (const p of ps) drawPlayer(c, p, p.x * TILE - cx, p.y * TILE - cy);
}

let last = 0;
function loop(ts) {
  const dt = last ? Math.min(200, ts - last) : 16;
  last = ts;
  if (state.spectator) renderSpectator(dt);
  else renderGame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// countdowns and the shovel timer need a nudge even when nothing is happening
setInterval(() => { if (state.me) updateHud(); }, 500);

// If the socket goes quiet, ask for a full state. Catches the case where an
// event was lost but the connection itself looks fine.
setInterval(() => {
  if (state.me && !state.halted && !pending) sync();
}, 5000);
