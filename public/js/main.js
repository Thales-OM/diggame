// ---------- Main ----------
// The entry point: socket event wiring, the DOM wiring, and the render loop.
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

import { ITEM, WEAPONS } from './assets.js';
import { login, buildClassDisplay, showClassChoose, confirmClass, setOffline, toggleMenu, buildEmotePicker, hideEmotes, toggleEmotes, renderTutorialPage, tutorialNext, tutorialBack, hideRules, hideProfile, closePopups, togglePanel, showVersion } from './ui.js';
import { renderBattle, updateBattleClock, showInvite, hideInvite, showGatePrompt, hideGatePrompt, gateYes, joinBattle, sendBattle, hideInventory, toggleInventory } from './battle.js';
import { resize, renderGame, setStatus, updateHud, toast, addEffect } from './field.js';
import { socket } from './net.js';
import { state, el, applyState, takeYou, sync, pending, sendAction, reveal, markChanged } from './state.js';
import { syncSpecPanel, onSpecModeChange, setSpecFollow, applySpec, stopSpectating, toggleSpectating, applyAdminOpts, renderSpectator } from './spectator.js';

(function prefill() {
  const m = document.cookie.match(/digcode=([A-Z0-9]+)/);
  if (m) el.code.value = m[1];
})();

el.loginBtn.addEventListener('click', login);

el.classConfirm.addEventListener('click', confirmClass);

el.inviteJoin.addEventListener('click', () => {
  if (state.battleInvite) joinBattle(state.battleInvite.battleId);
});

el.inviteIgnore.addEventListener('click', hideInvite);

el.battleResultConfirm.addEventListener('click', () => sendBattle('confirmResult'));

el.closeInventory.addEventListener('click', hideInventory);

el.inventoryBtn.addEventListener('click', toggleInventory);

el.gatePromptYes.addEventListener('click', gateYes);

el.gatePromptNo.addEventListener('click', hideGatePrompt);

socket.on('serverInfo', ({ version } = {}) => showVersion(version));

socket.on('connect', () => {
  state.connected = true;
  setOffline(false);
  setStatus();
  // a reconnect means we may have missed anything at all
  if (state.me) sync();
});

socket.on('disconnect', (reason) => {
  state.connected = false;
  setStatus();
  const lost = reason === 'io server disconnect' || reason === 'transport close'
    || reason === 'transport error' || reason === 'ping timeout';
  setOffline(true, lost
    ? 'Lost connection to the server. You are not in the pit until it comes back.'
    : 'Disconnected from the server.');
});

socket.on('connect_error', () => {
  state.connected = false;
  setStatus();
  setOffline(true, 'Cannot reach the server. Retrying…');
});

socket.on('halted', ({ message } = {}) => {
  state.halted = true;
  hideGatePrompt();
  el.haltMsg.textContent = message || 'The game has been halted by a server error.';
  el.halt.classList.remove('hidden');
  el.cv.classList.add('hidden');
});

socket.on('state', (msg) => {
  if (!msg) return;
  if (msg.you) takeYou(msg.you);
  // a death takes any open gate prompt with it
  if (msg.you && msg.you.alive === false) hideGatePrompt();
  // the server holds the authoritative class now, so keep the profile label in
  // step if it ever disagrees with what we drew
  if (msg.you && typeof msg.you.model === 'number' && msg.you.model !== state.model) {
    state.model = msg.you.model;
    buildClassDisplay();
  }
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

socket.on('battleInvite', (inv) => { if (inv) showInvite(inv); });

socket.on('battleInviteClosed', ({ battleId } = {}) => {
  if (state.battleInvite && state.battleInvite.battleId === battleId) hideInvite();
});

// A completed mist dig: the server asks whether to open the fight (or join one).
socket.on('gatePrompt', (p) => { showGatePrompt(p); });

socket.on('battleResult', (r) => {
  if (!r) return;
  if (r.result === 'win') {
    const bits = [];
    const gained = r.gained || {};
    if (gained.weapon) bits.push((WEAPONS[gained.weapon] || {}).name || gained.weapon);
    for (const [id, n] of Object.entries(gained.items || {})) {
      bits.push(`${ITEM[id] ? ITEM[id].sym : id}×${n}`);
    }
    toast(`Victory over ${r.boss}!${bits.length ? ' You gained: ' + bits.join(', ') : ''}`, 'good');
  } else if (r.result === 'lose') {
    toast(`Defeated by ${r.boss}. The gate holds.`, 'bad');
  } else if (r.result === 'cancelled') {
    toast('The fight is over.', '');
  }
});

socket.on('lootDropped', (g) => {
  if (!g) return;
  state.loot = state.loot.filter((l) => !(l.x === g.x && l.y === g.y));
  state.loot.push({ x: g.x, y: g.y, type: g.type, id: g.id });
});

socket.on('lootTaken', ({ x, y } = {}) => {
  state.loot = state.loot.filter((l) => !(l.x === x && l.y === y));
});

socket.on('worldReset', (m) => {
  toast('A new game has started!', 'good');
  state.spec.blocks = {};
  state.spec.deepestY = 0;
  state.myTraps = [];
  state.clearedWalls = new Set();
  state.battle = null;
  state.battleInvite = null;
  state.battleTarget = null;
  hideGatePrompt();
  if (m && Array.isArray(m.classes) && m.classes.length) state.classes = m.classes;
  // A class is per run, so the new run takes the old choice back. The server
  // has already detached us: there is no character to draw until we pick again.
  if (m && m.needsClass) {
    state.me = null;
    state.pendingClass = true;
    closePopups();
    hideInvite();
    renderBattle();
    showClassChoose();
    return;
  }
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
  // a fresh spectator starts on the deepest player; a previous camera position
  // is stale because the world underneath it has just been reset
  state.specCam = { x: 0, y: 0, mode: 'deepest', target: null, placed: false };
  state.keys.clear();
  state.spec.blocks = {};
  state.spec.deepestY = 0;
  applySpec(f);
  // The mine goes away, controls and all. #login does not live inside it and
  // is absolutely positioned over the whole page, so it has to be dismissed
  // separately: leaving it up is what made watching from the login screen look
  // like the button had done nothing at all.
  el.game.classList.add('hidden');
  el.login.classList.add('hidden');
  el.spec.classList.remove('hidden');
  // The options panel is only offered once we are watching, and it starts on
  // the least privileged view this socket can actually use.
  el.specPanel.classList.remove('hidden');
  syncSpecPanel();
  resize();
});

socket.on('spectatorFrame', (f) => {
  if (!state.spectator) return;
  applySpec(f);
});

// Both spectator buttons toggle, so pressing the one you pressed to get in
// takes you back out again.
document.getElementById('spectateBtn').addEventListener('click', () => toggleSpectating());

document.getElementById('specLoginBtn').addEventListener('click', () => toggleSpectating());

// Picking a mode switches the view at once. Picking Admin reveals the secret
// box (and reuses one the server already accepted); a refused remembered secret
// clears the box so it can be typed again.
el.specMode.addEventListener('change', onSpecModeChange);

el.specAggregate.addEventListener('change', applyAdminOpts);

el.specMargin.addEventListener('change', applyAdminOpts);

// The follow dropdown hands the camera to manual, to the deepest player, or to
// a named one. WASD takes it back to manual.
el.specFollow.addEventListener('change', () => setSpecFollow(el.specFollow.value));

document.getElementById('backBtn').addEventListener('click', stopSpectating);

document.getElementById('menuBtn').addEventListener('click', toggleMenu);

document.getElementById('closeProfile').addEventListener('click', hideProfile);

// The on-screen button is a toggle, like every other panel button. It used to
// only ever open the dialog, so the one key that always worked was Esc.
document.getElementById('rulesBtn').addEventListener('click', () => togglePanel('tutorial'));

document.getElementById('tutBack').addEventListener('click', tutorialBack);

document.getElementById('tutNext').addEventListener('click', tutorialNext);

document.getElementById('tutSkip').addEventListener('click', hideRules);

for (const b of document.querySelectorAll('#actions button')) {
  b.addEventListener('click', () => sendAction(b.dataset.act));
}

buildEmotePicker();

document.getElementById('emoteBtn').addEventListener('click', toggleEmotes);

document.getElementById('closeEmote').addEventListener('click', hideEmotes);

renderTutorialPage();

window.addEventListener('resize', resize);

resize();

export let last = 0;

export function loop(ts) {
  const dt = last ? Math.min(200, ts - last) : 16;
  last = ts;
  if (state.spectator) renderSpectator(dt);
  else renderGame(dt);
  if (state.battle) updateBattleClock();
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
