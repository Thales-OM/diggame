// ---------- Battle ----------
// The battle overlay and the inventory: the turn view, targeting, item and
// skill menus, the gate prompt, and weapons.

import { FLASH_MS } from './constants.js';
import { ITEM, WEAPONS, spriteCanvas, BOSS_FOOT, HERO_FOOT, spriteScale, bossArt, heroArt } from './assets.js';
import { togglePanel } from './ui.js';
import { state, el, takeYou, now, sendAction } from './state.js';
import { updateHud, toast, hideTip, tipOn } from './field.js';

/** Equip a weapon we own. The server refuses this mid-fight (in_battle). */
export function equipWeapon(id) {
  if (!state.me || state.halted) return;
  sendAction('equipWeapon', undefined, { id });
}

/** Enter a gate fight that is still taking players. */
export function joinBattle(id) {
  if (!state.me || state.halted) return;
  sendAction('joinBattle', undefined, { id });
  hideInvite();
}

/**
 * The verbs the battle overlay sends. `item` is only used by useBattleItem,
 * `target` names the ally a healing item is aimed at, and `id` names the skill
 * a skill action is for.
 */
export function sendBattle(type, item, target, id) {
  if (!state.me || state.halted || !state.battle) return;
  const extra = {};
  if (item) extra.item = item;
  if (target != null) extra.target = target;
  if (id) extra.id = id;
  sendAction(type, undefined, Object.keys(extra).length ? extra : undefined);
}

export function showInventory() {
  if (!state.me || state.halted) return;
  el.inventoryPanel.classList.remove('hidden');
  renderInventory();
}

export function hideInventory() {
  el.inventoryPanel.classList.add('hidden');
}

export function toggleInventory() {
  togglePanel('inventory');
}

export function tabButton(tab, label) {
  const b = document.createElement('button');
  b.className = 'invTab' + (state.invTab === tab ? ' sel' : '');
  b.textContent = label;
  b.addEventListener('click', () => { state.invTab = tab; renderInventory(); });
  return b;
}

export function itemRow(id) {
  const meta = ITEM[id] || { sym: '?', label: id };
  const row = document.createElement('div');
  row.className = 'invRow';
  const count = id === 'shovel'
    ? Math.max(0, Math.ceil((state.me.shovelUntil - now()) / 1000)) + 's'
    : String(state.me[id] || 0);
  const label = document.createElement('span');
  label.textContent = `${meta.sym}  ${meta.label}  ×${count}`;
  row.appendChild(label);
  // A potion is the one consumable with a field use, so it gets a Use button
  // here; every other item is spent from the action bar or the battle menu.
  if (id === 'potion') {
    const btn = document.createElement('button');
    btn.className = 'invUse';
    const usable = (state.me.potion || 0) > 0 && state.me.hp < state.me.maxHp;
    btn.textContent = 'Use';
    btn.disabled = !usable;
    if (usable) btn.addEventListener('click', usePotion);
    row.appendChild(btn);
  }
  tipOn(row, `${meta.label}${meta.desc ? ` — ${meta.desc}` : ''}`);
  return row;
}

/** Drink a potion from the field: the server refuses it if the bar is full. */
export function usePotion() {
  sendAction('usePotion');
}

/** The hover blurb for a weapon: its numbers, its flavour, and any skill. */
export function weaponTip(w) {
  const parts = [`${w.name} — dmg ${w.damage} · hit ${Math.round((w.hit || 0) * 100)}% · crit ${Math.round((w.crit || 0) * 100)}%`];
  if (w.desc) parts.push(w.desc);
  if (w.skill) parts.push(`${w.skill.name}: a much heavier blow, at the cost of a turn.`);
  return parts.join('\n');
}

/** Draw the inventory popup: the Items tab, or the weapons we may equip. */
export function renderInventory() {
  if (!state.me) return;
  const tabs = document.createElement('div');
  tabs.id = 'invTabRow';
  tabs.appendChild(tabButton('items', 'Items'));
  tabs.appendChild(tabButton('weapon', 'Weapon'));
  el.invTabs.replaceChildren(tabs);

  const body = document.createElement('div');
  if (state.invTab === 'weapon') {
    const owned = state.me.weapons || [];
    if (!owned.length) {
      const p = document.createElement('p');
      p.className = 'small';
      p.textContent = 'No weapons yet. Defeat a boss to earn one.';
      body.appendChild(p);
    }
    for (const id of owned) {
      const w = WEAPONS[id] || { name: id, glyph: '?', desc: '' };
      const row = document.createElement('div');
      row.className = 'invWeapon';
      const equipped = state.me.weapon === id;
      const btn = document.createElement('button');
      btn.className = 'equip' + (equipped ? ' sel' : '');
      btn.textContent = equipped ? 'Equipped' : 'Equip';
      if (!equipped) btn.addEventListener('click', () => equipWeapon(id));
      const label = document.createElement('span');
      label.className = 'wname';
      label.textContent = `${w.glyph} ${w.name}`;
      row.append(btn, label);
      // the numbers and the flavour text live on hover, not inline, so the list
      // stays one line per weapon
      tipOn(row, weaponTip(w));
      body.appendChild(row);
    }

  } else {
    for (const id of ['armor', 'dynamite', 'trap', 'potion', 'shovel']) {
      if (id === 'shovel' && !(state.me.shovelUntil > now())) continue;
      body.appendChild(itemRow(id));
    }
  }
  el.invBody.replaceChildren(body);
}

/**
 * One fighter's bar: a fixed-width track, red health painted from the left, a
 * grey armour plate laid over it (full while the armour is untouched, receding
 * as the boss chips it), and the exact numbers on top. Every bar is the same
 * width whatever the totals, so a fight can be read at a glance.
 */
export function fighterBar(hp, maxHp, armour, maxArmour) {
  const bar = document.createElement('div');
  bar.className = 'bsBar';

  const health = document.createElement('div');
  health.className = 'bsHp';
  health.style.width = (maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) * 100 : 0) + '%';

  const shield = document.createElement('div');
  shield.className = 'bsArmour';
  shield.style.width = (maxArmour > 0 ? Math.max(0, Math.min(1, armour / maxArmour)) * 100 : 0) + '%';

  const text = document.createElement('span');
  text.className = 'bsBarText';
  const points = Math.max(0, hp);
  text.textContent = maxArmour > 0
    ? `${points}/${maxHp} · ⛨ ${Math.max(0, armour)}`
    : `${points}/${maxHp}`;

  bar.append(health, shield, text);
  return bar;
}

// Last hp and armour, plus the tail of the active flash, for each combatant,
// keyed by 'boss' or a party member id. Armour is banked at the start of a fight
// and only ever falls as it soaks a blow, so a drop in either is a hit - which
// is how a fully-armoured fighter still flashes for damage that never reaches
// its health.
export const battleHpSeen = new Map();

export let lastBattleId = null;

/**
 * Record a combatant's hp and armour and report whether its sprite should flash
 * white. A drop in either opens a short flash window; a redundant render inside
 * that window keeps flashing. `at` is injectable so the window can be tested
 * without sleep.
 */
export function battleHit(id, hp, armour = 0, at = Date.now()) {
  const prev = battleHpSeen.get(id);
  if (!prev) {
    battleHpSeen.set(id, { hp, armour, until: 0 });
    return false;
  }
  const hurt = hp < prev.hp || armour < prev.armour;
  const flashing = hurt || at < prev.until;
  const until = hurt ? at + FLASH_MS : (flashing ? prev.until : 0);
  battleHpSeen.set(id, { hp, armour, until });
  return flashing;
}

/** One combatant on the stage: pixel sprite, name, and bar. */
export function fighterEl(opts) {
  const wrap = document.createElement('div');
  wrap.className = 'bsFighter';
  if (opts.turn) wrap.classList.add('turn');
  if (opts.acting) wrap.classList.add('acting');
  if (opts.target) wrap.classList.add('target');
  if (opts.alive === false) wrap.classList.add('down');
  if (opts.hit) wrap.classList.add('hit');

  const art = opts.boss ? bossArt(opts.species, opts.kind) : heroArt(opts.model);
  const canvas = spriteCanvas(art, spriteScale(art, opts.boss ? BOSS_FOOT : HERO_FOOT));
  wrap.appendChild(canvas);

  const name = document.createElement('div');
  name.className = 'bsName';
  name.textContent = opts.alive === false ? `${opts.name} (down)` : opts.name;
  wrap.appendChild(name);

  wrap.appendChild(fighterBar(opts.hp, opts.maxHp, opts.armour || 0, opts.maxArmour || 0));
  return wrap;
}

export function renderBoss(b) {
  const wrap = fighterEl({
    boss: true,
    kind: b.boss.kind,
    species: b.boss.species,
    name: b.boss.name,
    hp: b.boss.hp, maxHp: b.boss.maxHp,
    alive: b.boss.hp > 0,
    turn: !!b.bossTurn, acting: !!b.bossTurn,
    hit: battleHit('boss', b.boss.hp),
  });
  if (el.bsBoss) el.bsBoss.replaceChildren(wrap);
}

/** The party row; the row for the actor that is up next is highlighted. */
export function renderParty(b) {
  const list = document.createElement('div');
  list.className = 'bsPartyRow';
  const aimed = state.battleTarget;
  for (const m of b.party || []) {
    const up = b.phase === 'active' && b.turn === m.id;
    list.appendChild(fighterEl({
      model: m.model, name: m.name,
      hp: m.hp, maxHp: m.maxHp, armour: m.armour, maxArmour: m.maxArmour,
      alive: m.hp > 0, turn: up, acting: up,
      target: !!(aimed && aimed.target === m.id),
      hit: battleHit(m.id, m.hp, m.armour),
    }));
  }
  if (el.bsParty) el.bsParty.replaceChildren(list);
}

/** The order still to come this round, the actor first and the boss last. */
export function renderTurnOrder(b) {
  const list = document.createElement('div');
  list.className = 'bsTurnList';

  const title = document.createElement('div');
  title.className = 'bsTurnTitle';
  title.textContent = 'Turn order';
  list.appendChild(title);

  if (b.phase === 'join') {
    const wait = document.createElement('div');
    wait.className = 'bsTurnRow';
    wait.textContent = 'Waiting for allies…';
    list.appendChild(wait);
    if (el.bsTurnOrder) el.bsTurnOrder.replaceChildren(list);
    return;
  }

  // The whole round's order: a fixed ring led by the current actor, so spending
  // a turn rotates them to the back instead of shortening the list.
  const party = b.party || [];
  const ids = party.map((m) => m.id);
  const cur = b.bossTurn ? -1 : ids.indexOf(b.turn);
  const ring = cur > 0 ? ids.slice(cur).concat(ids.slice(0, cur)) : ids.slice();
  const rows = [];
  if (b.bossTurn) rows.push({ boss: true, name: b.boss.name });
  for (const id of ring) {
    const m = party.find((p) => p.id === id);
    rows.push({ boss: false, name: m ? m.name : '?' });
  }
  if (!b.bossTurn) rows.push({ boss: true, name: b.boss.name });

  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'bsTurnRow' + (i === 0 ? ' now' : '') + (r.boss ? ' boss' : '');
    row.textContent = `${i + 1}. ${r.name}`;
    list.appendChild(row);
  });
  if (el.bsTurnOrder) el.bsTurnOrder.replaceChildren(list);
}

/** Whether an item is aimed at a party member rather than the wielder. */
export function targetableItem(item) {
  return !!(ITEM[item] && ITEM[item].ally);
}

export function itemButton(item, count, label) {
  const b = document.createElement('button');
  b.className = 'battleItem';
  b.textContent = label;
  b.disabled = !(count > 0);
  b.addEventListener('click', () => {
    if (targetableItem(item)) beginTarget('useBattleItem', item);
    else { sendBattle('useBattleItem', item); hideItemMenu(); }
  });
  return b;
}

// A healing item is aimed before it is thrown: the cursor names one member, the
// arrow keys walk it round the party, and only then is the item sent. The same
// shape will carry an ally-directed skill once one exists.

/** Start aiming `item` (or a future skill); the cursor opens on the wielder. */
export function beginTarget(type, item) {
  const b = state.battle;
  if (!b || !Array.isArray(b.party) || !b.party.length) return;
  const self = b.party.find((m) => m.id === (b.me && b.me.id));
  state.battleTarget = { type, item, target: (self || b.party[0]).id };
  hideItemMenu();
  hideSkillMenu();
  renderBattle();
}

export function cycleTarget(step) {
  const b = state.battle;
  if (!state.battleTarget || !b || !Array.isArray(b.party) || !b.party.length) return;
  const at = b.party.findIndex((m) => m.id === state.battleTarget.target);
  const n = b.party.length;
  state.battleTarget.target = b.party[((at + step) % n + n) % n].id;
  renderBattle();
}

export function cancelTarget() {
  if (!state.battleTarget) return;
  state.battleTarget = null;
  renderBattle();
}

/** Use the aimed item on the highlighted member; a whole one is refused. */
export function confirmTarget() {
  const bt = state.battleTarget;
  const b = state.battle;
  if (!bt || !b) return;
  const m = b.party.find((x) => x.id === bt.target);
  if (m && m.hp >= m.maxHp) { toast('HP is full', 'bad'); return; }
  state.battleTarget = null;
  sendBattle(bt.type, bt.item, bt.target);
  renderBattle();
}

export function hideItemMenu() {
  el.battleItemMenu.classList.add('hidden');
}

export function toggleItemMenu() {
  const hidden = el.battleItemMenu.classList.contains('hidden');
  if (hidden) { buildItemMenu(); hideSkillMenu(); }
  el.battleItemMenu.classList.toggle('hidden', !hidden);
}

export function buildItemMenu() {
  const me = state.battle && state.battle.me;
  if (!me) return;
  const wrap = document.createElement('div');
  wrap.appendChild(itemButton('dynamite', me.dynamite, `💣 Dynamite ×${me.dynamite}`));
  wrap.appendChild(itemButton('trap', me.trap, `🪤 Trap ×${me.trap}`));
  wrap.appendChild(itemButton('potion', me.potion, `🧪 Potion ×${me.potion}`));
  el.battleItemMenu.replaceChildren(wrap);
}

export function hideSkillMenu() {
  el.battleSkillMenu.classList.add('hidden');
}

/**
 * The skills the fight can offer. The server names every one of them - the
 * class actives, the class passives (for their prose) and any weapon skill -
 * so the client only has to lay them out. A passive is listed but never usable.
 */
export function battleSkills() {
  const me = state.battle && state.battle.me;
  if (!me) return [];
  return me.skills || [];
}

export function toggleSkillMenu() {
  const hidden = el.battleSkillMenu.classList.contains('hidden');
  if (hidden) { buildSkillMenu(); hideItemMenu(); }
  el.battleSkillMenu.classList.toggle('hidden', !hidden);
}

export function buildSkillMenu() {
  const me = state.battle && state.battle.me;
  if (!me) return;
  const wrap = document.createElement('div');
  const skills = battleSkills();
  if (!skills.length) {
    const none = document.createElement('span');
    none.className = 'battleItem';
    none.textContent = 'No skills';
    wrap.appendChild(none);
  } else {
    for (const s of skills) {
      const passive = s.kind === 'passive';
      const usable = !passive && s.usable !== false;
      const b = document.createElement('button');
      // A passive (or a spent active) is drawn dimmer and never fires: it is
      // there so its description can be read, not to be pressed.
      b.className = 'battleItem';
      if (passive) b.classList.add('passive');
      else if (!usable) b.classList.add('spent');
      b.textContent = s.name || s.id;
      const tip = (s.desc || '') + (s.note ? '\n' + s.note : '');
      if (tip) tipOn(b, tip);
      if (usable) {
        b.addEventListener('click', () => { sendBattle('skill', null, null, s.id); hideSkillMenu(); });
      }
      wrap.appendChild(b);
    }
  }
  el.battleSkillMenu.replaceChildren(wrap);
}

/** The victory window: what this player won, and the button that lets them go. */
export function renderBattleResult(b) {
  if (!el.battleResult) return;
  el.battleResultBoss.textContent = `${b.boss ? b.boss.name : 'The boss'} is defeated!`;
  const gained = (b.me && b.me.gained) || { weapon: null, items: {} };
  const lines = [];
  if (gained.weapon) {
    const w = WEAPONS[gained.weapon];
    lines.push({ cls: 'bsLootRow', text: `${(w && w.glyph) || '⚔'} ${(w && w.name) || gained.weapon}` });
  }
  for (const [id, n] of Object.entries(gained.items || {})) {
    const it = ITEM[id];
    lines.push({ cls: 'bsLootRow', text: `${(it && it.sym) || '•'} ${(it && it.label) || id} ×${n}` });
  }
  if (!lines.length) lines.push({ cls: 'bsLootNone', text: 'No loot this time.' });
  const rows = lines.map((l) => {
    const row = document.createElement('div');
    row.className = l.cls;
    row.textContent = l.text;
    return row;
  });
  el.battleResultBody.replaceChildren(...rows);
  el.battleResult.classList.remove('hidden');
}

export function actionButton(label, act, disabled) {
  const b = document.createElement('button');
  b.className = 'battleAct';
  b.textContent = label;
  b.disabled = !!disabled;
  b.addEventListener('click', act);
  return b;
}

/** Show or hide the full-screen fight and rebuild it from the server's view. */
export function renderBattle() {
  const b = state.battle;
  if (!el.battleScreen) return;
  if (!b) {
    battleHpSeen.clear();
    lastBattleId = null;
    state.battleTarget = null;
    el.battleScreen.classList.add('hidden');
    hideItemMenu();
    hideSkillMenu();
    el.battleResult.classList.add('hidden');
    hideTip();
    return;
  }
  if (b.id !== lastBattleId) {
    battleHpSeen.clear();
    lastBattleId = b.id;
  }
  el.battleScreen.classList.remove('hidden');

  // An aim only makes sense while it is still your turn and the member is here.
  if (state.battleTarget && (b.phase !== 'active' || !b.isMyTurn
      || !(b.party || []).some((m) => m.id === state.battleTarget.target))) {
    state.battleTarget = null;
  }

  renderBoss(b);
  renderParty(b);
  renderTurnOrder(b);

  const log = document.createElement('div');
  for (const line of b.log || []) {
    const p = document.createElement('div');
    p.className = 'blogLine ' + (line.kind || '');
    p.textContent = line.text;
    log.appendChild(p);
  }
  el.battleLog.replaceChildren(log);
  el.battleLog.scrollTop = el.battleLog.scrollHeight;

  if (b.phase === 'join') {
    el.battleResult.classList.add('hidden');
    const secs = Math.max(0, Math.ceil((b.joinDeadline - now()) / 1000));
    el.battleTurn.textContent = `Waiting for allies… ${secs}s`;
    const acts = document.createElement('div');
    // only the player who opened the encounter can cut the wait short
    if (b.me && b.initiator === b.me.id) {
      acts.appendChild(actionButton('Start', () => sendBattle('startBattle'), false));
    }
    el.battleActions.replaceChildren(acts);
    hideItemMenu();
    hideSkillMenu();
    return;
  }

  // The fight is won, but the party stays until everyone has seen their loot.
  if (b.phase === 'result') {
    el.battleTurn.textContent = 'Victory!';
    el.battleActions.replaceChildren();
    hideItemMenu();
    hideSkillMenu();
    renderBattleResult(b);
    return;
  }

  el.battleResult.classList.add('hidden');
  const mine = b.isMyTurn;
  const actor = b.bossTurn
    ? b.boss.name
    : ((b.party.find((m) => m.id === b.turn) || {}).name || '?');

  // Aiming a healing item: the turn line becomes the aiming prompt and the
  // verb buttons step aside, since the choice is made on the party row.
  const aimed = state.battleTarget;
  const acts = document.createElement('div');
  if (aimed) {
    const m = b.party.find((x) => x.id === aimed.target);
    const label = (ITEM[aimed.item] && ITEM[aimed.item].label) || aimed.item || 'skill';
    el.battleTurn.textContent = `Use ${label} on ${m ? m.name : '?'} · ←/→ · Enter · Esc`;
  } else {
    el.battleTurn.textContent = mine ? 'Your turn!' : `${actor}'s turn`;
    acts.appendChild(actionButton('Attack', () => sendBattle('attack'), !mine));
    acts.appendChild(actionButton('Defend', () => sendBattle('defend'), !mine));
    acts.appendChild(actionButton('Item', () => toggleItemMenu(), !mine || !b.me));
    acts.appendChild(actionButton('Skill', () => toggleSkillMenu(), !mine || !b.me));
  }
  el.battleActions.replaceChildren(acts);
  if (!mine || state.battleTarget) { hideItemMenu(); hideSkillMenu(); }
}

/**
 * Keep the join countdown ticking between server snapshots. The fight view is
 * only re-sent on events, so a timer written once inside renderBattle would sit
 * still until the next event - which used to be the 5s fallback sync.
 */
export function updateBattleClock() {
  const b = state.battle;
  if (!b || b.phase !== 'join' || !el.battleTurn) return;
  const secs = Math.max(0, Math.ceil((b.joinDeadline - now()) / 1000));
  el.battleTurn.textContent = `Waiting for allies… ${secs}s`;
}

export function showInvite(inv) {
  // never invite someone who is already locked in a fight (the initiator is)
  if (state.battle) return;
  state.battleInvite = inv;
  const party = Array.isArray(inv.party) ? inv.party : [];
  const who = party.length ? `fighting: ${party.join(', ')}` : 'nobody has joined yet';
  el.inviteText.textContent = `${inv.boss} blocks the way — ${who} (${party.length}/${inv.partyMax}). Join the fight?`;
  el.inviteBar.classList.remove('hidden');
}

export function hideInvite() {
  state.battleInvite = null;
  el.inviteBar.classList.add('hidden');
}

/**
 * The gate wall prompt: a blocking dialog shown when a mist dig completes. It
 * either asks whether to face the gatekeeper behind an empty wall, or offers to
 * join the fight already running there with the boss and party listed. The field
 * is frozen while it is up; Esc (or "Not yet") declines and changes nothing.
 */
export function showGatePrompt(p) {
  if (!p) return;
  if (p.you) takeYou(p.you);
  state.gatePrompt = p;
  const join = p.mode === 'join';
  el.gatePromptTitle.textContent = join ? 'A gatekeeper fight is under way' : 'A gatekeeper blocks the way';
  if (join) {
    const party = Array.isArray(p.party) ? p.party : [];
    el.gatePromptBody.textContent =
      `${p.boss} stands behind the mist — fighting: ${party.length ? party.join(', ') : 'nobody yet'}.`
      + `\n\n${p.canJoin ? 'Join them?' : 'It is no longer taking allies.'}`;
    el.gatePromptYes.textContent = 'Join';
    el.gatePromptNo.textContent = 'Ignore';
  } else {
    el.gatePromptBody.textContent =
      'You are about to enter a Gatekeeper battle.'
      + '\nEarn your right to pass through the wall.'
      + '\n\nAre you ready?';
    el.gatePromptYes.textContent = 'Fight';
    el.gatePromptNo.textContent = 'Not yet';
  }
  // a fight already full or closed can only be declined
  el.gatePromptYes.disabled = join && !p.canJoin;
  el.gatePrompt.classList.remove('hidden');
  updateHud();
}

export function hideGatePrompt() {
  state.gatePrompt = null;
  el.gatePrompt.classList.add('hidden');
}

/** Answer the prompt: open/join the fight, or step back and leave the wall. */
export function gateYes() {
  const p = state.gatePrompt;
  if (!p) { hideGatePrompt(); return; }
  if (p.mode === 'join') {
    if (p.battleId != null) joinBattle(p.battleId);
  } else {
    sendAction('enterGate');
  }
  hideGatePrompt();
}
