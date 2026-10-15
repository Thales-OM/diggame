'use strict';

// The monsters a boss can be, weakest species first. Each species owns a name
// and an id; the pair of stat multipliers (`hpMult`, `atkMult`) applied *on top
// of* the size the boss would have had anyway (`BOSS_MINIBOSS_*` for a miniboss,
// the gate formula for a gate boss) live in config/game.json and are merged in by
// the caller, so moving up a species is genuinely tougher rather than a new coat
// of paint. The client keeps a sprite per `id`; the server never knows how one is
// drawn.
//
// `attacks` and `lines` are reserved for the day monsters bring their own verbs
// and battle dialogue. They are deliberately empty for now.
const MINIBOSS_SPECIES = [
  { id: 'maggot',  name: 'Overgrown Maggot',    attacks: [], lines: [] },
  { id: 'fairy',   name: 'Malicious Fairy',     attacks: [], lines: [] },
  { id: 'undead',  name: 'Undead Knight',       attacks: [], lines: [] },
  { id: 'wyvern',  name: 'Ancient Wyvern',      attacks: [], lines: [] },
  { id: 'cultist', name: 'Ancient God Cultist', attacks: [], lines: [] },
];

// The gate bosses, one per gate band, in order. A gate beyond the list reuses
// the last entry, so the endless pit never runs out of a named guardian.
const GATE_SPECIES = [
  { id: 'angel',       name: 'Fallen Angel',             attacks: [], lines: [] },
  { id: 'ancient',     name: 'Traces of an ancient God', attacks: [], lines: [] },
  { id: 'butler',      name: 'Stalwart Butler',          attacks: [], lines: [] },
  { id: 'abomination', name: 'Man-made Abomination',     attacks: [], lines: [] },
];

/** A template with the numbers from config/game.json laid over it. */
function withStats(template, stats) {
  return stats ? { ...template, ...stats } : template;
}

/**
 * The species a miniboss at `depth` wears. One species per `tierDepth` blocks,
 * capped at the deepest, so the shallow pit holds maggots and fairies and the
 * deep pit its undead, wyverns and cultists.
 */
function minibossSpecies(depth, tierDepth, stats) {
  const per = Math.max(1, Math.floor(tierDepth));
  const tier = Math.min(MINIBOSS_SPECIES.length - 1, Math.floor(Math.max(0, depth - 1) / per));
  const template = MINIBOSS_SPECIES[tier];
  return withStats(template, stats && stats[template.id]);
}

/** The species guarding gate `gate` (0-based). Gates past the list reuse the last. */
function gateSpecies(gate, stats) {
  const i = Math.min(GATE_SPECIES.length - 1, Math.max(0, Math.floor(gate)));
  const template = GATE_SPECIES[i];
  return withStats(template, stats && stats[template.id]);
}

module.exports = { MINIBOSS_SPECIES, GATE_SPECIES, minibossSpecies, gateSpecies };
