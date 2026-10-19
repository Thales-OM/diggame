'use strict';

// ---------- Stats ----------
// Run statistics, kept as deltas so a flush is safe to run on a timer.

const { blankRunStats } = require('./helpers');

module.exports = {
  /**
   * Stat *deltas* since the last call, for the storage layer. Counters are
   * relative to what was already handed over, so a flush can run every few
   * hundred milliseconds without double counting; max_depth is absolute and is
   * max()-ed by the storage layer.
   *
   * Codes survive here after a player disconnects, so nothing is lost by
   * logging out mid-run.
   * @returns {Array<{code:string, delta:object}>}
   */
  takeStatDeltas() {
    // Snapshot the live players first. A stat can change without bumping rev
    // (blocksDug is counted after the last state change of a dig), and this is
    // the only place that can notice.
    for (const p of this.players.values()) {
      this.runTotals.set(p.code, { ...p.runStats });
    }
    const out = [];
    for (const code of this.dirtyStats) {
      const totals = this.runTotals.get(code);
      if (!totals) continue;
      const prev = this.statBaseline.get(code) || blankRunStats();
      out.push({
        code,
        delta: {
          maxDepth: totals.maxDepth,
          blocksDug: totals.blocksDug - prev.blocksDug,
          deaths: totals.deaths - prev.deaths,
          itemsCollected: totals.itemsCollected - prev.itemsCollected,
          spikesSurvived: totals.spikesSurvived - prev.spikesSurvived,
        },
      });
      this.statBaseline.set(code, { ...totals });
    }
    this.dirtyStats.clear();
    return out;
  },
  /** Forget the run totals of everybody. Only correct after storage has taken
   *  the final deltas for the run being closed. */
  clearRunTotals() {
    this.runTotals.clear();
    this.statBaseline.clear();
    this.dirtyStats.clear();
    // a new run is a new world: the old cell keys mean nothing here
    this.runDiscovered.clear();
    // and no gate wall carries over into a new pit
    this.runClearedWalls.clear();
  },
  /** Take the final deltas for a run that is about to end, in one shot. */
  finishRunTotals() {
    this.dirtyStats = new Set(this.runTotals.keys());
    return this.takeStatDeltas();
  },
  bump(player) {
    player.rev++;
    this.dirtyStats.add(player.code);
  },
  noteDepth(player) {
    const d = this.world.depthOf(player.y);
    if (d > player.maxDepth) player.maxDepth = d;
    if (d > player.runStats.maxDepth) player.runStats.maxDepth = d;
    this.updateGlobalMaxDepth();
  },
  updateGlobalMaxDepth() {
    let m = 0;
    for (const p of this.players.values()) m = Math.max(m, p.maxDepth);
    this.globalMaxDepth = m;
  }
};
