// ---------- Input ----------
// Keyboard handling, and the popup stack that decides what Esc closes.

import { KEYS, SHORTCUTS, CODE_KEYS } from './constants.js';
import { cycleTarget, cancelTarget, confirmTarget, hideItemMenu, hideSkillMenu, hideInvite, hideGatePrompt, gateYes, sendBattle, hideInventory } from './battle.js';
import { login, hideEmotes, hideRules, togglePanel } from './ui.js';
import { requestSpectate, specRequestFromPanel, syncSpecFollow, stopSpectating, toggleSpectating } from './spectator.js';
import { state, el, sendAction } from './state.js';

for (const input of [el.name, el.code]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
}

el.specSecret.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') requestSpectate(specRequestFromPanel());
});

/**
 * Esc closes the topmost thing on screen, and only that. The tutorial first,
 * then the menu, then spectator mode: a dialog opened on top of a panel is the
 * one the reader meant to dismiss.
 * @returns {boolean} whether something was actually closed
 */
export function closeTopmost() {
  if (state.gatePrompt) { hideGatePrompt(); return true; }
  if (!el.rules.classList.contains('hidden')) { hideRules(); return true; }
  if (!el.emotePanel.classList.contains('hidden')) { hideEmotes(); return true; }
  if (!el.inventoryPanel.classList.contains('hidden')) { hideInventory(); return true; }
  if (state.battleTarget) { cancelTarget(); return true; }
  if (!el.battleItemMenu.classList.contains('hidden')) { hideItemMenu(); return true; }
  if (!el.battleSkillMenu.classList.contains('hidden')) { hideSkillMenu(); return true; }
  if (state.battleInvite) { hideInvite(); return true; }
  if (!el.profile.classList.contains('hidden')) { el.profile.classList.add('hidden'); return true; }
  if (state.spectator) { stopSpectating(); return true; }
  return false;
}

export function typingInAField(t) {
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}

export function keyOf(e) {
  return CODE_KEYS[e.code] || e.key;
}

// Scoped to the game view, and it never blocks typing: a keypress while the
// login form or a text field has focus is left alone (BUGS: "the keydown
// handler preventsDefault's on everything, so you cannot type your name").
window.addEventListener('keydown', (e) => {
  if (state.halted) return;
  if (typingInAField(e.target)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const key = keyOf(e);
  if (key === 'Escape') {
    // nothing open? leave the key to the browser, which uses it to leave full
    // screen and to cancel things
    if (closeTopmost()) e.preventDefault();
    return;
  }

  // The gate prompt owns the screen until it is answered: Enter accepts and
  // everything else is swallowed so the field cannot move underneath it.
  if (state.gatePrompt) {
    e.preventDefault();
    if ((key === 'Enter' || key === ' ') && !el.gatePromptYes.disabled) gateYes();
    return;
  }

  const shortcut = SHORTCUTS[key];
  if (shortcut) {
    e.preventDefault();
    // holding V down must not flicker between the two views
    if (!e.repeat) {
      if (shortcut === 'menu') togglePanel('profile');
      else if (shortcut === 'emotes') togglePanel('emotes');
      else if (shortcut === 'inventory') togglePanel('inventory');
      else toggleSpectating();
    }
    return;
  }

  // Locked in a fight: the field verbs are frozen, so the canvas does not move
  // and nothing is sent. While a healing item is being aimed the arrows walk the
  // cursor and Enter throws it; otherwise Space/Enter is the Action verb.
  if (state.battle) {
    e.preventDefault();
    if (state.battleTarget) {
      if (key === 'ArrowLeft' || key === 'a') cycleTarget(-1);
      else if (key === 'ArrowRight' || key === 'd') cycleTarget(1);
      else if (key === ' ' || key === 'Enter') confirmTarget();
      return;
    }
    if ((key === ' ' || key === 'Enter') && state.battle.isMyTurn && state.battle.phase === 'active') {
      sendBattle('attack');
    }
    return;
  }

  const dir = KEYS[key];
  if (!dir) return;

  // Spectating: the arrow keys and WASD drive the camera over the field instead
  // of moving a character (BUGS v0.3.0). Q and E are ignored here, so a
  // spectating player cannot dig or place traps from the spectator view.
  // Checked before state.me, because a socket may spectate without playing.
  if (state.spectator) {
    if (dir === 'useDynamite' || dir === 'placeTrap') return;
    e.preventDefault();
    if (state.specCam.mode !== 'manual') {
      state.specCam.mode = 'manual';
      state.specCam.target = null;
      syncSpecFollow();
    }
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
  const dir = KEYS[keyOf(e)];
  if (dir) state.keys.delete(dir);
});

// Releasing focus mid-keypress would otherwise leave a key stuck down.
window.addEventListener('blur', () => state.keys.clear());
