// ---------- State ----------
// The client-side model: the state object the server owns, the DOM element
// cache, applying a server state, and the low-level action senders.

import { ERRORS } from './constants.js';
import { renderBattle } from './battle.js';
import { socket } from './net.js';
import { updateHud, toast } from './field.js';

export const state = {
  me: null,          // authoritative snapshot of *us*
  rev: 0,            // the rev that snapshot belongs to
  blocks: {},        // "x,y" -> { type, item }, only what we have discovered
  players: [],       // public snapshots of everyone, for drawing names
  myTraps: [],       // our own bear traps; secret to everyone else
  clearedWalls: new Set(), // gate depths whose mist we have opened this run
  width: 50,
  surfaceY: 0,
  code: null,
  name: null,
  model: 0,
  stats: null,
  connected: false,
  halted: false,
  spectator: false,
  // which view the server is filtering for, and the admin options we asked for
  specMode: null,
  specAdminAll: true,
  specMargin: 30,
  spec: { blocks: {}, players: [], stats: [], digs: [], traps: [], width: 50, surfaceY: 0, maxY: 0 },
  // What the spectator camera is doing, in block coordinates. `mode` is
  // 'manual' (free panning), 'deepest' (pinned to the deepest player) or
  // 'player' (stuck to `target`, a player id, which only means anything in
  // 'player' mode). Purely local: it never widens what the server sends.
  specCam: { x: 0, y: 0, mode: 'deepest', target: null, placed: false },
  keys: new Set(),   // movement keys currently held down, for the camera
  serverSkew: 0,     // Date.now() - server clock, for countdown rendering
  effects: [],       // short-lived visual effects
  flashes: {},       // "x,y" -> until, used to flash a block when it changes
  dig: null,         // { x, y, startedAt, duration } for the progress bar
  drawMe: { x: 0, y: 0 }, // interpolated render position, never gameplay state
  rulesShown: false, // has the Rules dialog been on screen this session
  tutPage: 0,        // which page of the tutorial is showing
  // the private view of the fight we are locked in, or null. Owned entirely by
  // the server: this is copied from `you.battle`, never built here.
  battle: null,
  // While a healing item is being aimed: { type, item, target }, with `target`
  // the id of the member under the cursor. Null when nothing is being picked.
  battleTarget: null,
  // loot lying on the ground, from `you.loot` plus the lootDropped/lootTaken
  // events, so a fight's leftovers appear without a full resync
  loot: [],
  // a gate boss waiting for players to join, shown until it starts or expires
  battleInvite: null,
  // a gate prompt waiting to be answered: the blocking "are you ready?" / join
  // modal. Set by the server's gatePrompt event, cleared when it is answered.
  gatePrompt: null,
  invTab: 'items',   // which inventory tab is showing: 'items' or 'weapon'
  // The class table the server hands us (id, name, desc, skills) and the entry
  // choice around it. While pendingClass is true we have not been spawned yet,
  // so the chooser owns the screen and the field is frozen behind its veil.
  classes: [],
  pendingClass: false,
  classPick: null,   // index highlighted in the chooser, not yet confirmed
};

export const el = {
  login: document.getElementById('login'),
  game: document.getElementById('game'),
  spec: document.getElementById('spectator'),
  name: document.getElementById('nameInput'),
  code: document.getElementById('codeInput'),
  loginBtn: document.getElementById('loginBtn'),
  specLoginBtn: document.getElementById('specLoginBtn'),
  loginErr: document.getElementById('loginErr'),
  health: document.getElementById('health'),
  healthBar: document.getElementById('healthBar'),
  healthFill: document.getElementById('healthFill'),
  healthText: document.getElementById('healthText'),
  inventory: document.getElementById('inventory'),
  status: document.getElementById('status'),
  stats: document.getElementById('stats'),
  pName: document.getElementById('pName'),
  pCode: document.getElementById('pCode'),
  pMaxDepth: document.getElementById('pMaxDepth'),
  pDeaths: document.getElementById('pDeaths'),
  pItems: document.getElementById('pItems'),
  pRuns: document.getElementById('pRuns'),
  pClass: document.getElementById('pClass'),
  profile: document.getElementById('profile'),
  emotePanel: document.getElementById('emotePanel'),
  emoteList: document.getElementById('emoteList'),
  inventoryBtn: document.getElementById('inventoryBtn'),
  inventoryPanel: document.getElementById('inventoryPanel'),
  invTabs: document.getElementById('invTabs'),
  invBody: document.getElementById('invBody'),
  closeInventory: document.getElementById('closeInventory'),
  battleScreen: document.getElementById('battleScreen'),
  bsBoss: document.getElementById('bsBoss'),
  bsParty: document.getElementById('bsParty'),
  bsTurnOrder: document.getElementById('bsTurnOrder'),
  battleLog: document.getElementById('battleLog'),
  battleActions: document.getElementById('battleActions'),
  battleItemMenu: document.getElementById('battleItemMenu'),
  battleSkillMenu: document.getElementById('battleSkillMenu'),
  battleTurn: document.getElementById('battleTurn'),
  battleResult: document.getElementById('battleResult'),
  battleResultBoss: document.getElementById('battleResultBoss'),
  battleResultBody: document.getElementById('battleResultBody'),
  battleResultConfirm: document.getElementById('battleResultConfirm'),
  tooltip: document.getElementById('tooltip'),
  inviteBar: document.getElementById('inviteBar'),
  inviteText: document.getElementById('inviteText'),
  inviteJoin: document.getElementById('inviteJoin'),
  inviteIgnore: document.getElementById('inviteIgnore'),
  gatePrompt: document.getElementById('gatePrompt'),
  gatePromptTitle: document.getElementById('gatePromptTitle'),
  gatePromptBody: document.getElementById('gatePromptBody'),
  gatePromptYes: document.getElementById('gatePromptYes'),
  gatePromptNo: document.getElementById('gatePromptNo'),
  rules: document.getElementById('rules'),
  rulesBody: document.getElementById('rulesBody'),
  tutPage: document.getElementById('tutPage'),
  tutBack: document.getElementById('tutBack'),
  tutNext: document.getElementById('tutNext'),
  tutSkip: document.getElementById('tutSkip'),
  toasts: document.getElementById('toasts'),
  cv: document.getElementById('cv'),
  halt: document.getElementById('halt'),
  haltMsg: document.getElementById('haltMsg'),
  offline: document.getElementById('offline'),
  offlineMsg: document.getElementById('offlineMsg'),
  classChoose: document.getElementById('classChoose'),
  classList: document.getElementById('classList'),
  classDesc: document.getElementById('classDesc'),
  classConfirm: document.getElementById('classConfirm'),
  specPanel: document.getElementById('specPanel'),
  specMode: document.getElementById('specMode'),
  specAdminOpts: document.getElementById('specAdminOpts'),
  specSecret: document.getElementById('specSecret'),
  specAggregate: document.getElementById('specAggregate'),
  specMargin: document.getElementById('specMargin'),
  specErr: document.getElementById('specErr'),
  specBoardRows: document.getElementById('specBoardRows'),
  specBoardEmpty: document.getElementById('specBoardEmpty'),
  specFollow: document.getElementById('specFollow'),
  topControls: document.getElementById('topControls'),
};

export const ctx = el.cv.getContext('2d');

export const specCv = document.getElementById('cvSpec');

export const specCtx = specCv.getContext('2d');

/** Take a full authoritative state. The only way to (re)build the world view. */
export function applyState(s) {
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
export function takeYou(you) {
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
  // the gate depths we have opened, so the field can draw that mist as a tunnel
  state.clearedWalls = new Set(you.wallsCleared || []);
  // the fight we are locked in and the loot on the ground, both server-owned
  state.battle = you.battle || null;
  if (Array.isArray(you.loot)) state.loot = you.loot;
  state.serverSkew = Date.now() - (you.serverNow || Date.now());
  if (first || Math.abs(you.x - state.drawMe.x) > 2 || Math.abs(you.y - state.drawMe.y) > 2) {
    state.drawMe.x = you.x;
    state.drawMe.y = you.y;
    state.snap = true;
  }
  renderBattle();
}

/** Server time as best we can tell it, for rendering countdowns only. */
export function now() { return Date.now() - state.serverSkew; }

export function sync() {
  socket.emit('action', { type: 'sync', rev: state.rev }, (res) => {
    if (res && res.state) applyState(res.state);
  });
}

export let pending = 0;

export function sendAction(type, dir, extra) {
  if (!state.me || state.halted) return;
  // keep the server's answers in order: a burst of keypresses must not be
  // answered out of order, which is how the old client ended up with a mix of
  // two different states
  if (pending > 8) return;
  pending++;
  socket.emit('action', { type, dir, rev: state.rev, ...(extra || {}) }, (res) => {
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

export function sendEmote(id) {
  if (!state.me || state.halted) return;
  if (pending > 8) return;
  pending++;
  socket.emit('action', { type: 'emote', id, rev: state.rev }, (res) => {
    pending--;
    if (!res) return;
    if (res.needSync) { applyState(res.state); return; }
    if (typeof res.rev === 'number') state.rev = res.rev;
    if (res.you) takeYou(res.you);
    const delta = res.delta || {};
    if (delta.emote) {
      if (state.me) state.me.emote = delta.emote;
    }
    updateHud();
  });
}

export function complain(error) {
  const text = ERRORS[error] || (error ? `Cannot: ${error}` : '');
  if (text) toast(text, 'bad');
}

export function reveal(cells) {
  for (const b of cells) {
    if (!b) continue;
    state.blocks[b.x + ',' + b.y] = { type: b.type, item: b.item };
  }
}

export function markChanged(x, y) {
  const k = x + ',' + y;
  if (state.blocks[k]) state.blocks[k] = { type: 'air', item: null };
  state.flashes[k] = now() + 350;
}
