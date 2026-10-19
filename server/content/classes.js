'use strict';

// ---------- Classes ----------
// The prose half of a class: its id, name, description and the skills it shows
// in the picker. The numbers that decide what those skills *do* live in
// config/game.json, so a class can be rebalanced without touching this file.

/**
 * The five playable classes. A player's `modelIndex` *is* their class: the
 * index is the wire protocol, and the browser keeps the same order in public/
 * MODELS so it can draw the matching sprite. The server needs the whole table,
 * not just a count, because a class carries skills that change how a fight
 * plays out.
 *
 * Desc and skill prose are what the browser shows in the class picker; the
 * numbers behind the active skills live in config so they can be tuned without
 * touching this list.
 */
const CLASSES = [
  {
    id: 'wizard', name: 'Wizard',
    desc: 'A scholar of the arcane. Frail in the hand, but the only class that can carry the Magic Staff and unleash its incantation.',
    skills: [
      { id: 'magic_knowledge', name: 'Magic knowledge', kind: 'passive',
        desc: 'Only a Wizard may pick up or wield the Magic Staff, and only a Wizard may incantate with it.' },
    ],
  },
  {
    id: 'knight', name: 'Knight',
    desc: 'A disciplined fighter. Balanced and dependable, and deadlier with a blade in hand.',
    skills: [
      { id: 'weapon_expertise', name: 'Weapon expertise', kind: 'passive',
        desc: 'Sword and rapier blows land harder. Stacks with critical hits.' },
    ],
  },
  {
    id: 'barbarian', name: 'Barbarian',
    desc: 'A brawler who needs no weapon. Fearsome with bare hands, and can shake off wounds with a roar.',
    skills: [
      { id: 'hardened_knuckles', name: 'Hardened knuckles', kind: 'passive',
        desc: 'Bare-handed blows land far harder than anyone else\'s. Stacks with critical hits.' },
      { id: 'battle_cry', name: 'Battle cry', kind: 'active',
        desc: 'Bellow a war cry to recover 30% of your health. Once per battle.' },
    ],
  },
  {
    id: 'noble', name: 'Noble',
    desc: 'A born leader. Spends their own blood to raise the whole party.',
    skills: [
      { id: 'noblesse_oblige', name: 'Noblesse oblige', kind: 'active',
        desc: 'Sacrifice 10% of your health to rally the party: every other member deals 25% more damage on their next turn.' },
    ],
  },
  {
    id: 'bandit', name: 'Bandit',
    desc: 'A nimble opportunist who strikes true when it matters.',
    skills: [
      { id: 'agile_footwork', name: 'Agile footwork', kind: 'active',
        desc: 'Find your footing: your next two attacks are 25% more accurate.' },
    ],
  },
];

const MODEL_COUNT = CLASSES.length;
const CLASS_BY_ID = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
const WIZARD_INDEX = CLASSES.findIndex((c) => c.id === 'wizard');

module.exports = { CLASSES, MODEL_COUNT, CLASS_BY_ID, WIZARD_INDEX };
