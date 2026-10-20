// ---------- Ui ----------
// Everything that is not the pit or a fight: login, class choice, the
// tutorial, the menus and the emote picker.

import { BLOCKS, TUTORIAL_PAGES, EMOTE_LIST, POPUP } from './constants.js';
import { MODELS, WEAPONS, HERO_BATTLE, spriteCanvas, CARD_FOOT, spriteScale, heroArt } from './assets.js';
import { resize, updateHud, toast } from './field.js';
import { socket } from './net.js';
import { state, el, applyState, sendEmote } from './state.js';
import { stopSpectating } from './spectator.js';

export function login() {
  const name = el.name.value.trim();
  const code = el.code.value.trim().toUpperCase();
  if (!name && !code) {
    el.loginErr.textContent = 'Enter a name, or the code from a previous game.';
    return;
  }
  el.loginBtn.disabled = true;
  el.loginErr.textContent = '';
  socket.emit('login', { name, code }, (res) => {
    el.loginBtn.disabled = false;
    if (!res || res.error) {
      el.loginErr.textContent = (res && res.error) || 'Could not log in.';
      return;
    }
    if (Array.isArray(res.classes) && res.classes.length) state.classes = res.classes;
    state.code = res.code;
    state.name = res.name;
    state.stats = res.stats || null;
    document.cookie = `digcode=${res.code}; max-age=${60 * 60 * 24 * 180}; path=/; SameSite=Lax`;
    el.login.classList.add('hidden');
    el.game.classList.remove('hidden');
    el.pName.textContent = res.name;
    el.pCode.textContent = res.code;
    resize();
    // A class is the price of entry: an account that has not chosen one for
    // this run has no character on the field yet. Only chooseClass spawns it,
    // so the chooser (after the rules, for a brand new account) comes first.
    if (res.needsClass) {
      state.pendingClass = true;
      state.me = null;
      if (!res.rulesSeen) showRules();
      else showClassChoose();
      return;
    }
    state.model = res.model != null ? res.model : state.model;
    state.pendingClass = false;
    buildClassDisplay();
    applyState(res.state);
    // The server owns the "is this a new player" question, so the dialog is
    // shown for exactly the accounts that have never been shown it.
    if (!res.rulesSeen) showRules();
  });
}

/** The class table to lay out, falling back to the sprite mirror if the server
 *  has not handed us one (tests, or a very old reply). */
export function classTable() {
  if (state.classes && state.classes.length) return state.classes;
  return MODELS.map((m) => ({ id: m.id, name: m.name, desc: '', skills: [] }));
}

/** The class name for an index, preferring the server's table. */
export function className(i) {
  const c = classTable()[i];
  return c ? c.name : (MODELS[i] ? MODELS[i].name : `Class ${i}`);
}

/** Show the chosen class in the profile. */
export function buildClassDisplay() {
  if (!el.pClass) return;
  el.pClass.textContent = state.model == null ? '—' : className(state.model);
}

/**
 * The entry chooser. It is a mandatory modal and is deliberately not in the
 * POPUP registry: Esc must not be able to leave a player classless.
 */
export function showClassChoose() {
  state.pendingClass = true;
  state.classPick = null;
  renderClassList();
  renderClassDesc(null);
  el.classConfirm.disabled = true;
  el.classChoose.classList.remove('hidden');
  if (el.topControls) el.topControls.classList.add('locked');
}

export function hideClassChoose() {
  el.classChoose.classList.add('hidden');
  if (el.topControls) el.topControls.classList.remove('locked');
}

/** One card per class: a large sprite with the name beneath it. */
export function renderClassList() {
  const table = classTable();
  const cards = [];
  table.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'cCard';
    if (i === state.classPick) card.classList.add('sel');
    card.dataset.index = String(i);
    const art = HERO_BATTLE[c.id] || heroArt(i);
    if (art) card.appendChild(spriteCanvas(art, spriteScale(art, CARD_FOOT), null, 'cSprite'));
    const name = document.createElement('div');
    name.className = 'cName';
    name.textContent = c.name;
    card.appendChild(name);
    // hovering previews the description; a click commits the highlight
    card.addEventListener('mouseenter', () => renderClassDesc(i));
    card.addEventListener('focus', () => renderClassDesc(i));
    card.addEventListener('click', () => selectClass(i));
    cards.push(card);
  });
  el.classList.replaceChildren(...cards);
}

export function selectClass(i) {
  state.classPick = i;
  renderClassList();
  renderClassDesc(i);
  el.classConfirm.disabled = false;
}

/** The prose panel: what the class is, and what its skills do. */
export function renderClassDesc(i) {
  if (i == null) {
    const hint = document.createElement('p');
    hint.className = 'small';
    hint.textContent = 'Hover a class to read what it does, then pick one and confirm.';
    el.classDesc.replaceChildren(hint);
    return;
  }
  const c = classTable()[i];
  if (!c) return;
  const nodes = [];
  const h = document.createElement('h3');
  h.textContent = c.name;
  nodes.push(h);
  if (c.desc) {
    const p = document.createElement('p');
    p.textContent = c.desc;
    nodes.push(p);
  }
  for (const s of c.skills || []) {
    const row = document.createElement('div');
    row.className = 'skill ' + (s.kind === 'passive' ? 'passive' : 'active');
    const b = document.createElement('b');
    b.textContent = s.name;
    row.appendChild(b);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind === 'passive' ? 'Passive' : 'Active';
    row.appendChild(kind);
    if (s.desc) {
      const d = document.createElement('div');
      d.textContent = s.desc;
      row.appendChild(d);
    }
    nodes.push(row);
  }
  el.classDesc.replaceChildren(...nodes);
}

export function confirmClass() {
  if (state.classPick == null) return;
  el.classConfirm.disabled = true;
  const index = state.classPick;
  socket.emit('chooseClass', { modelIndex: index }, (res) => {
    if (!res || res.error) {
      el.classConfirm.disabled = false;
      toast((res && res.error) || 'Could not choose a class.', 'bad');
      return;
    }
    if (Array.isArray(res.classes) && res.classes.length) state.classes = res.classes;
    state.code = res.code || state.code;
    state.name = res.name || state.name;
    state.stats = res.stats || state.stats;
    state.model = res.model != null ? res.model : index;
    state.pendingClass = false;
    state.classPick = null;
    if (el.pName) el.pName.textContent = state.name;
    buildClassDisplay();
    hideClassChoose();
    applyState(res.state);
    updateHud();
  });
}

/** The build the server is running, shown small in the corner of both the login
 *  screen and the field. Empty until the server says hello. */
export function showVersion(version) {
  const text = version ? `version: ${version}` : '';
  if (el.version) el.version.textContent = text;
  if (el.gameVersion) el.gameVersion.textContent = text;
}

/**
 * The offline veil. It is not a toast and not a popup: it stays up, over
 * everything, for as long as the connection is down, and nothing the player
 * presses can dismiss it. Clearing it is the connect handler's job alone.
 */
export function setOffline(on, msg) {
  if (!el.offline) return;
  if (msg) el.offlineMsg.textContent = msg;
  el.offline.classList.toggle('hidden', !on);
}

export function toggleMenu() {
  if (!state.me) return;
  togglePanel('profile');
}

export function emoteGlyph(id) {
  const found = EMOTE_LIST.find((e) => e.id === id);
  return found ? found.glyph : '😊';
}

/** Fill the popup once: the buttons never change, only the panel shows. */
export function buildEmotePicker() {
  el.emoteList.replaceChildren();
  for (const em of EMOTE_LIST) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.emote = em.id;
    b.title = em.label;
    b.textContent = em.glyph;
    // Picking one sends it and gets out of the way, so the bubble is not hidden
    // behind the panel the reader just clicked.
    b.addEventListener('click', () => { sendEmote(em.id); hideEmotes(); });
    el.emoteList.appendChild(b);
  }
}

export function showEmotes() {
  if (!state.me || state.halted) return;
  el.emotePanel.classList.remove('hidden');
}

export function hideEmotes() {
  el.emotePanel.classList.add('hidden');
}

export function toggleEmotes() {
  togglePanel('emotes');
}

/** The weapons page's bullet list, built from the display mirror so it stays
 *  in step with the tooltip numbers the inventory shows. */
export function buildWeaponList() {
  const list = document.createElement('ul');
  list.className = 'ruleWeapons';
  for (const id of Object.keys(WEAPONS)) {
    const w = WEAPONS[id];
    // bare hands are not won from a fight, so they are not on the loot page
    if (id === 'bare') continue;
    const li = document.createElement('li');
    const glyph = document.createElement('span');
    glyph.className = 'wg';
    glyph.textContent = w.glyph;
    const name = document.createElement('b');
    name.textContent = w.name;
    const stats = document.createElement('span');
    stats.className = 'wstats';
    stats.textContent = `dmg ${w.damage} · hit ${Math.round(w.hit * 100)}% · crit ${Math.round(w.crit * 100)}%`;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = ` - ${w.desc}`;
    li.append(glyph, name, stats, note);
    if (w.skill) {
      const skill = document.createElement('span');
      skill.className = 'note wskill';
      skill.textContent = `${w.skill.name}: spend a turn to strike for ${w.skill.mult}x base damage.`;
      li.appendChild(skill);
    }
    list.appendChild(li);
  }
  return list;
}

/** Draw one tutorial page into the dialog, footer included. */
export function renderTutorialPage() {
  const page = TUTORIAL_PAGES[state.tutPage];
  el.rulesBody.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = page.title;
  const text = document.createElement('p');
  text.innerHTML = page.html;
  el.rulesBody.append(heading, text);

  if (page.weapons) el.rulesBody.appendChild(buildWeaponList());

  if (page.grid) {
    const grid = document.createElement('pre');
    grid.className = 'ruleGrid';
    grid.textContent = page.grid.join('\n');
    el.rulesBody.appendChild(grid);
  }

  if (page.legend) {
    const legend = document.createElement('ul');
    legend.className = 'ruleLegend';
    for (const key of page.legend) {
      const item = BLOCKS[key];
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = `swatch sw-${item.cls}`;
      sw.textContent = item.ch;
      const label = document.createElement('b');
      label.textContent = item.name;
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = ` - ${item.note}`;
      li.append(sw, label, note);
      legend.appendChild(li);
    }
    el.rulesBody.appendChild(legend);
  }

  const last = state.tutPage === TUTORIAL_PAGES.length - 1;
  el.tutPage.textContent = `Page ${state.tutPage + 1} of ${TUTORIAL_PAGES.length}`;
  el.tutBack.disabled = state.tutPage === 0;
  el.tutSkip.classList.toggle('hidden', last);
  el.tutNext.textContent = last ? 'Got it' : 'Next';
}

/**
 * Show the tutorial, always from the first page. Closing it is what tells the
 * server it has been read, so the dialog opens by itself exactly once per
 * account rather than once per visit.
 */
export function showRules() {
  state.tutPage = 0;
  renderTutorialPage();
  el.rules.classList.remove('hidden');
  state.rulesShown = true;
  if (el.topControls) el.topControls.classList.toggle('locked', true);
}

/** Turn the page; on the last page Next finishes, the same as Got it. */
export function tutorialNext() {
  if (state.tutPage >= TUTORIAL_PAGES.length - 1) { hideRules(); return; }
  state.tutPage += 1;
  renderTutorialPage();
}

export function tutorialBack() {
  if (state.tutPage === 0) return;
  state.tutPage -= 1;
  renderTutorialPage();
}

export function hideRules() {
  el.rules.classList.add('hidden');
  if (el.topControls) el.topControls.classList.toggle('locked', false);
  // The rules were read by an account, which may not have spawned yet: a player
  // still choosing a class has a code but no player object.
  if ((state.me || state.code) && state.rulesShown) {
    state.rulesShown = false;
    socket.emit('rulesSeen');
  }
  // A brand new account reads the rules first, and only then picks a class.
  if (state.pendingClass) showClassChoose();
}

/** The windows behind the top-right buttons are mutually exclusive. */
export function tutorialOpen() {
  return !el.rules.classList.contains('hidden');
}

export function showProfile() {
  if (!state.me) return;
  el.profile.classList.remove('hidden');
}

export function hideProfile() {
  el.profile.classList.add('hidden');
}

export function closePopups() {
  for (const p of Object.values(POPUP)) if (p.isOpen()) p.close();
}

export function openPanel(name) {
  const p = POPUP[name];
  if (!p) return;
  if (name !== 'tutorial' && tutorialOpen()) return;
  // Spectator mode is one more surface in the same exclusive set: opening a
  // panel leaves the view first, and the panel then opens over the field.
  if (state.spectator) stopSpectating();
  for (const [key, pp] of Object.entries(POPUP)) {
    if (key !== name && pp.isOpen()) pp.close();
  }
  p.open();
}

export function togglePanel(name) {
  const p = POPUP[name];
  if (!p) return;
  if (p.isOpen()) { p.close(); return; }
  openPanel(name);
}
