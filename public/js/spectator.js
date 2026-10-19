// ---------- Spectator ----------
// Spectator mode: the panel, its admin options, following a player, and
// the board renderer with its own camera.

import { TILE, SPEC_ERRORS, ADMIN_SECRET_KEY, SPEC_SPEED, SPEC_MIN_Y } from './constants.js';
import { tutorialOpen, closePopups } from './ui.js';
import { resize, drawBlock, drawUnknown, drawPlayer, background } from './field.js';
import { socket } from './net.js';
import { state, el, specCv, specCtx, now } from './state.js';

/**
 * Ask the server for a view. Everything the mode needs travels with the
 * request; the server decides what of it is allowed and filters the frame, so
 * nothing here can widen what we are shown.
 */
export function requestSpectate(req) {
  el.specErr.textContent = '';
  socket.emit('spectate', req, (res) => {
    if (!res) return;
    if (res.error) {
      el.specErr.textContent = SPEC_ERRORS[res.error] || res.error;
      // a remembered secret the server refused is worse than none: drop it and
      // put the box back in front of them so the next try can be typed in
      if (res.error === 'bad_admin_secret') {
        forgetAdminSecret();
        el.specSecret.value = '';
        refreshSpecAdminOpts();
        el.specSecret.focus();
      }
      return;
    }
    if (res.mode === 'admin') storeAdminSecret(req.secret || el.specSecret.value);
    state.specMode = res.mode;
    if (typeof res.depthMargin === 'number') {
      state.specMargin = res.depthMargin;
      el.specMargin.value = String(res.depthMargin);
    }
    syncSpecPanel();
  });
}

export function readAdminSecret() {
  try { return localStorage.getItem(ADMIN_SECRET_KEY) || ''; } catch { return ''; }
}

export function storeAdminSecret(secret) {
  if (!secret) return;
  try { localStorage.setItem(ADMIN_SECRET_KEY, secret); } catch { /* private mode */ }
}

export function forgetAdminSecret() {
  try { localStorage.removeItem(ADMIN_SECRET_KEY); } catch { /* private mode */ }
}

/** The request this socket should send, given the state of the panel. */
export function specRequestFromPanel() {
  const mode = el.specMode.value;
  const req = { mode };
  if (mode === 'admin') {
    req.secret = el.specSecret.value;
    req.adminAll = !el.specAggregate.checked;
    const margin = Number(el.specMargin.value);
    req.depthMargin = Number.isFinite(margin) && margin >= 0 ? Math.floor(margin) : 0;
  }
  return req;
}

/** Show the admin-only fields only while Admin is the picked mode. This never
 * touches the select, so it is safe to run from the change handler. */
export function refreshSpecAdminOpts() {
  el.specAdminOpts.classList.toggle('hidden', el.specMode.value !== 'admin');
}

/** Reflect the agreed mode in the panel, and show admin fields only for admin. */
export function syncSpecPanel() {
  if (state.specMode) el.specMode.value = state.specMode;
  refreshSpecAdminOpts();
}

/**
 * The mode dropdown switches the view as soon as it changes. Public and player
 * are sent straight away; Admin first needs the secret, which is remembered
 * after it is accepted so coming back does not ask again.
 */
export function onSpecModeChange() {
  refreshSpecAdminOpts();
  if (el.specMode.value !== 'admin') {
    requestSpectate({ mode: el.specMode.value });
    return;
  }
  const remembered = readAdminSecret();
  if (remembered) {
    el.specSecret.value = remembered;
    requestSpectate(specRequestFromPanel());
  } else {
    el.specSecret.value = '';
    el.specSecret.focus();
  }
}

/**
 * Choose what the camera follows, from the dropdown or a click on a scoreboard
 * row. `p:<id>` pins the camera to that player, 'deepest' hands it to the
 * deepest player, and anything else is manual. The frame decides later whether
 * the named player is still there; picking never widens what is on screen.
 */
export function setSpecFollow(value) {
  const cam = state.specCam;
  if (value === 'deepest') {
    cam.mode = 'deepest';
    cam.target = null;
  } else if (typeof value === 'string' && value.startsWith('p:')) {
    cam.mode = 'player';
    cam.target = Number(value.slice(2));
  } else {
    cam.mode = 'manual';
    cam.target = null;
  }
  state.keys.clear();
  if (el.specFollow) el.specFollow.value = value;
}

/**
 * Keep the follow dropdown in step with the roster. On every frame, because a
 * followed player can log off at any moment: when the id is gone the camera
 * drops back to manual instead of sitting on ground they have left, and an
 * empty pit drops 'deepest' back to manual too. The options are rebuilt only
 * when the roster really changes, so the select is not churned every frame.
 */
export function syncSpecFollow() {
  const cam = state.specCam;
  const players = state.spec.players || [];
  if (cam.mode === 'player' && !players.some((p) => p.id === cam.target)) {
    cam.mode = 'manual';
    cam.target = null;
  }
  if (cam.mode === 'deepest' && players.length === 0) {
    cam.mode = 'manual';
  }
  if (!el.specFollow) return;
  const sorted = players.slice().sort((a, b) => a.name.localeCompare(b.name));
  const roster = sorted.map((p) => p.id + ':' + p.name).join('|');
  if (roster !== syncSpecFollow._roster) {
    syncSpecFollow._roster = roster;
    const option = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    };
    el.specFollow.replaceChildren(
      option('manual', 'Manual'),
      option('deepest', 'Deepest player'),
      ...sorted.map((p) => option('p:' + p.id, p.name)),
    );
  }
  el.specFollow.value = state.specCam.mode === 'player' ? 'p:' + state.specCam.target : state.specCam.mode;
}

export function applySpec(f) {
  if (!f) return;
  if (f.mode) state.specMode = f.mode;
  let deepest = state.spec.deepestY || 0;
  for (const b of f.blocks || []) {
    state.spec.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
    if (b.y > deepest) deepest = b.y;
  }
  // the deepest cell anybody knows about, so the camera can be clamped to the
  // real bottom of the pit instead of an invented one
  state.spec.deepestY = deepest;
  state.spec.players = f.players || [];
  state.spec.stats = f.stats || [];
  state.spec.digs = f.digs || [];
  state.spec.traps = f.traps || [];
  state.spec.width = f.width || state.spec.width;
  state.spec.surfaceY = f.surfaceY || 0;
  if (typeof f.maxY === 'number') state.spec.maxY = f.maxY;
  syncSpecFollow();
  clampSpecCam();
  updateSpecBoard();
}

/**
 * The scoreboard. Depth and best depth are public, so they are on every frame
 * in every mode - a spectator gets the standings without being able to see the
 * ground the players are standing on.
 */
export function updateSpecBoard() {
  const rows = el.specBoardRows;
  if (!rows) return;
  const stats = (state.spec.stats || []).slice().sort(
    (a, b) => (b.maxDepth || 0) - (a.maxDepth || 0) || a.name.localeCompare(b.name),
  );
  const t = now();
  const lead = stats.length ? Math.max(...stats.map((s) => s.maxDepth || 0)) : 0;
  const alive = new Map((state.spec.players || []).map((p) => [p.id, p]));

  // children is an HTMLCollection, whose length is a getter with no setter.
  // Assigning to it throws, which used to abort the whole spectator frame
  // before the view was ever shown - the view then silently did nothing.
  rows.replaceChildren();
  for (const s of stats) {
    const tr = document.createElement('tr');
    if (s.maxDepth === lead && lead > 0) tr.className = 'lead';
    if (alive.has(s.id) && alive.get(s.id).alive === false) tr.className = 'dead';

    const name = document.createElement('td');
    name.textContent = s.name;
    const depth = document.createElement('td');
    depth.className = 'num';
    depth.textContent = String(s.depth);
    const best = document.createElement('td');
    best.className = 'num';
    best.textContent = String(s.maxDepth);
    const items = document.createElement('td');
    const shovel = Math.max(0, Math.ceil((s.shovelUntil - t) / 1000));
    items.textContent = shovel > 0
      ? `🛡${s.armor} 💣${s.dynamite} ⛏${shovel}s`
      : `🛡${s.armor} 💣${s.dynamite} 🪤${s.trap}`;

    tr.append(name, depth, best, items);
    // Clicking a row pins the camera to that player. Only rows whose player is
    // on the field can be followed: a stat with nobody behind it would just
    // bounce straight back to manual.
    if (alive.has(s.id)) tr.addEventListener('click', () => setSpecFollow('p:' + s.id));
    rows.appendChild(tr);
  }
  el.specBoardEmpty.classList.toggle('hidden', stats.length > 0);
}

/** Enter spectator mode. The view depends on whether there is an account. */
export function startSpectating() {
  if (state.spectator) return;
  closePopups();
  const mode = state.me ? 'player' : 'public';
  el.specMode.value = mode;
  syncSpecPanel();
  requestSpectate({ mode });
}

export function stopSpectating() {
  socket.emit('unspectate');
  state.spectator = false;
  state.keys.clear();
  el.spec.classList.add('hidden');
  el.specPanel.classList.add('hidden');
  // an anonymous watcher has nowhere else to go back to
  if (state.me) {
    el.game.classList.remove('hidden');
    el.cv.classList.remove('hidden');
  } else {
    el.login.classList.remove('hidden');
  }
  resize();
}

export function toggleSpectating() {
  if (tutorialOpen()) return;
  if (state.spectator) stopSpectating();
  else startSpectating();
}

// Re-send the admin frame when its own options change, but only while it is the
// view on show - there is no Apply button to do it by hand.
export const applyAdminOpts = () => {
  if (el.specMode.value === 'admin') requestSpectate(specRequestFromPanel());
};

/** How deep anybody has dug, so the camera can stop at the bottom of the pit. */
export function specDeepestY() {
  let m = state.spec.surfaceY;
  for (const p of state.spec.players) if (p.alive) m = Math.max(m, p.y);
  for (const d of state.spec.digs) m = Math.max(m, d.y);
  // the server says how far down this view is allowed to show, which is the
  // bottom of what it sent plus wherever the action currently is
  m = Math.max(m, state.spec.maxY || 0);
  // discovered cells only go as deep as the deepest dig, but be safe and use
  // whatever the world itself has opened up
  m = Math.max(m, state.spec.deepestY || 0);
  return m;
}

export function clampSpecCam() {
  const c = state.specCam;
  const maxX = Math.max(0, state.spec.width - 1);
  const maxY = specDeepestY() + 2;
  c.x = Math.min(maxX, Math.max(0, c.x));
  c.y = Math.min(maxY, Math.max(SPEC_MIN_Y, c.y));
}

export function moveSpecCam(dt) {
  const c = state.specCam;
  const k = state.keys;
  // diagonals are faster, same as a normal 8-way walk
  const dx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
  const dy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
  if (!dx && !dy) return false;
  c.mode = 'manual';   // taking the wheel ends whatever was being followed
  c.target = null;
  const len = Math.hypot(dx, dy) || 1;
  const step = SPEC_SPEED * (dt / 1000);
  c.x += (dx / len) * step;
  c.y += (dy / len) * step;
  clampSpecCam();
  return true;
}

/**
 * Put the camera where the chosen follow mode wants it this frame. The server
 * only sends players who are still on the field, so a missing target means the
 * watched player logged off: the camera drops back to manual rather than
 * parking on stale ground. `deepest` follows the deepest living player and,
 * while everyone is dead, holds the last player it watched if they are still
 * listed; it only gives up (to manual) when the pit is empty.
 * @returns {boolean} whether the camera was moved
 */
export function resolveFollow() {
  const c = state.specCam;
  const players = state.spec.players;

  if (c.mode === 'player') {
    const t = players.find((p) => p.id === c.target);
    if (!t) {
      c.mode = 'manual';
      c.target = null;
      return false;
    }
    c.x = t.x;
    c.y = t.y;
    return true;
  }

  if (c.mode === 'deepest') {
    if (players.length === 0) {
      c.mode = 'manual';
      return false;
    }
    // the deepest one still alive, or the last one watched while nobody is
    let deep = null;
    for (const p of players) if (p.alive && (!deep || p.y > deep.y)) deep = p;
    if (!deep) deep = players.find((p) => p.id === c.target) || null;
    if (!deep) for (const p of players) if (!deep || p.y > deep.y) deep = p;
    c.target = deep.id;
    c.x = deep.x;
    c.y = deep.y;
    return true;
  }

  return false;
}

export function renderSpectator(dt) {
  const c = specCtx, W = specCv.width, H = specCv.height;
  background(c, W, H);
  const ps = state.spec.players;

  moveSpecCam(dt || 16);
  resolveFollow();
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
      if (b) drawBlock(c, px, py, b.type, b.item, y, state.spec.surfaceY);
      // the public view deliberately knows nothing below the surface, and it is
      // greyed out rather than left blank, exactly like an undiscovered cell
      else if (y >= state.spec.surfaceY) drawUnknown(c, px, py);
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
