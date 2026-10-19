'use strict';

// ---------- Helpers ----------
// The two empty shapes a fresh player starts from. They live apart from the
// mixins so more than one of them can build a player without importing each
// other.

/** The per-run counters every player starts from. */
function blankRunStats() {
  return { maxDepth: 0, blocksDug: 0, deaths: 0, itemsCollected: 0, spikesSurvived: 0 };
}

/**
 * A truly empty inventory, without even bare hands. `weapon` is the id currently
 * equipped (or null); `armor` is a number of points of protection, not pieces;
 * `potion` is a heal that can be drunk on the field or in a fight. `initInventory`
 * is what a joining player actually gets: this blank plus the "Bare-handed"
 * weapon, so callers that want a bare player must ask for one.
 */
function blankInventory() {
  return { armor: 0, dynamite: 0, trap: 0, potion: 0, shovelUntil: 0, weapons: [], weapon: null };
}

module.exports = { blankRunStats, blankInventory };
