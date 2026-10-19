'use strict';

// ---------- Constants ----------
// Small vocabularies the rules share: the compass, the error codes the client
// switches on, and the battle verbs and items the engine names directly.

const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const ERR = {
  DEAD: 'dead',
  DYING: 'dying',
  STUCK: 'stuck',
  WALL: 'wall',
  ABOVE_SURFACE: 'above_surface',
  STONE: 'stone',
  OCCUPIED: 'occupied',
  NOT_DIGGABLE: 'not_diggable',
  ALREADY_DIGGING: 'already_digging',
  NO_DYNAMITE: 'no_dynamite',
  NO_TRAP: 'no_trap',
  NO_ITEM: 'no_item',
  INVALID_MODEL: 'invalid_model',
  INVALID_EMOTE: 'invalid_emote',
  EMOTE_COOLDOWN: 'emote_cooldown',
  IN_BATTLE: 'in_battle',
  NOT_IN_BATTLE: 'not_in_battle',
  INVALID_WEAPON: 'invalid_weapon',
  NO_JOIN: 'no_join',
  BATTLE_FULL: 'battle_full',
  NOT_YOUR_TURN: 'not_your_turn',
  INVALID_BATTLE_ACTION: 'invalid_battle_action',
  NO_SKILL: 'no_skill',
  NO_TARGET: 'no_target',
  HP_FULL: 'hp_full',
};

/** The verbs a battle accepts; everything else is refused while locked in one. */
const BATTLE_VERBS = ['attack', 'defend', 'useBattleItem', 'skill'];

/**
 * Items that may be aimed at another member of the party. The client offers a
 * target cursor for these and ships the chosen member's id as `target`; the
 * rest (dynamite, a trap) always act for the wielder alone.
 */
const ALLY_ITEMS = new Set(['potion']);

module.exports = { DIRS, ERR, BATTLE_VERBS, ALLY_ITEMS };
