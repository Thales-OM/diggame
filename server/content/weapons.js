'use strict';

// ---------- Weapons ----------
// The identity of each weapon: its id, its name, its glyph and its flavour. The
// numbers that decide how it fights - hit, damage, crit, the staff's incantation
// - live in config/game.json (WEAPON_STATS) and are merged in by buildWeapons, so
// the config file is the single source of truth the battle math reads. The
// browser keeps its own mirror in public/js/assets.js purely so the inventory
// tooltips can describe a weapon without the server shipping the numbers.
//
// A lootable weapon is earned only from a boss fight, never dug out of the dirt;
// `bare` is never loot, it is simply the empty-hands profile presented as a
// switchable weapon.

/**
 * The identity of each weapon: its id, its name, its glyph and its flavour.
 */
const WEAPON_TEMPLATE = {
  bare: {
    id: 'bare', name: 'Bare-handed', glyph: '👊',
    desc: 'No weapon. Your own two hands are always ready.',
  },
  sword: {
    id: 'sword', name: 'Sword', glyph: '🗡',
    desc: 'Basic and reliable: the most average hit rate, damage and crit chance.',
  },
  rapier: {
    id: 'rapier', name: 'Rapier', glyph: '🤺',
    desc: 'Harder to land a hit, but crits far more often, for double damage.',
  },
  staff: {
    id: 'staff', name: 'Magic Staff', glyph: '🪄',
    // the Wizard's "Magic knowledge" passive: nobody else may pick it up
    wizardOnly: true,
    skill: {
      id: 'incantation', name: 'Incantation',
      desc: 'Spend a turn to incantate: your next strike deals extra base damage, and can crit on top. A lucky crit on the incantation turn fires the spell at once.',
    },
    desc: 'Strikes like a sword, but can incantate for a much stronger blow.',
  },
};

/**
 * Merge the weapon prose above with the numbers from config/game.json.
 *   hit       chance for a strike to land (0..1)
 *   damage    added to BATTLE_BASE_ATTACK
 *   crit      chance for a landed strike to crit
 *   critMult  what a crit multiplies the strike by
 *   skill     optional: the staff's incantation, a charged heavy blow
 */
function buildWeapons(stats) {
  const out = {};
  for (const [id, tpl] of Object.entries(WEAPON_TEMPLATE)) {
    const stat = stats[id];
    const weapon = { ...tpl, hit: stat.hit, damage: stat.damage, crit: stat.crit, critMult: stat.critMult };
    if (tpl.skill) weapon.skill = { ...tpl.skill, mult: stat.skillMult, chargeCrit: stat.chargeCrit };
    out[id] = weapon;
  }
  return out;
}

module.exports = { WEAPON_TEMPLATE, buildWeapons };
