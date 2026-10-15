'use strict';

// The monsters a boss can be, weakest species first. Each species owns a name
// and a pair of stat multipliers applied *on top of* the size the boss would
// have had anyway (`BOSS_MINIBOSS_*` for a miniboss, the gate formula for a gate
// boss), so moving up a species is genuinely tougher rather than a new coat of
// paint. The client keeps a sprite per `id`; the server never knows how one is
// drawn.
//
// `attacks` and `lines` are reserved for the day monsters bring their own verbs
// and battle dialogue. They are deliberately empty for now.
const MINIBOSS_SPECIES = [
  { id: 'maggot',  name: 'Overgrown Maggot',    hpMult: 0.8,  atkMult: 0.8,  attacks: [], lines: [] },
  { id: 'fairy',   name: 'Malicious Fairy',     hpMult: 0.9,  atkMult: 1.0,  attacks: [], lines: [] },
  { id: 'undead',  name: 'Undead Knight',       hpMult: 1.05, atkMult: 1.1,  attacks: [], lines: [] },
  { id: 'wyvern',  name: 'Ancient Wyvern',      hpMult: 1.25, atkMult: 1.2,  attacks: [], lines: [] },
  { id: 'cultist', name: 'Ancient God Cultist', hpMult: 1.4,  atkMult: 1.4,  attacks: [], lines: [] },
];

// The gate bosses, one per gate band, in order. A gate beyond the list reuses
// the last entry, so the endless pit never runs out of a named guardian.
const GATE_SPECIES = [
  { id: 'angel',       name: 'Fallen Angel',             hpMult: 1.0,  atkMult: 1.0,  attacks: [], lines: [] },
  { id: 'ancient',     name: 'Traces of an ancient God', hpMult: 1.15, atkMult: 1.1,  attacks: [], lines: [] },
  { id: 'butler',      name: 'Stalwart Butler',         hpMult: 1.25, atkMult: 1.15, attacks: [], lines: [] },
  { id: 'abomination', name: 'Man-made Abomination',     hpMult: 1.3,  atkMult: 1.2,  attacks: [], lines: [] },
];

/**
 * The species a miniboss at `depth` wears. One species per `tierDepth` blocks,
 * capped at the deepest, so the shallow pit holds maggots and fairies and the
 * deep pit its undead, wyverns and cultists.
 */
function minibossSpecies(depth, tierDepth) {
  const per = Math.max(1, Math.floor(tierDepth));
  const tier = Math.min(MINIBOSS_SPECIES.length - 1, Math.floor(Math.max(0, depth - 1) / per));
  return MINIBOSS_SPECIES[tier];
}

/** The species guarding gate `gate` (0-based). Gates past the list reuse the last. */
function gateSpecies(gate) {
  const i = Math.min(GATE_SPECIES.length - 1, Math.max(0, Math.floor(gate)));
  return GATE_SPECIES[i];
}

module.exports = { MINIBOSS_SPECIES, GATE_SPECIES, minibossSpecies, gateSpecies };
