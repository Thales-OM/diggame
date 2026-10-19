'use strict';

// ---------- Lifecycle ----------
// Death, respawn, the run lifecycle and the tick that drives it all.

const { blankRunStats } = require('./helpers');

module.exports = {
  kill(player, reason) {
    if (!player.alive) return;
    // dying in a fight takes you out of it and forfeits your share
    if (player.battleId) this.leaveBattle(player, 'died');
    player.alive = false;
    player.digging = null;
    player.dyingAt = 0;
    // Death refreshes the walls: every gate must be earned again on the way down
    // from the surface. The same Set lives in runClearedWalls, so clearing it
    // here is what a reconnect would see too.
    player.wallsCleared.clear();
    player.runStats.deaths += 1;
    player.respawnAt = this.now() + this.config.RESPAWN_DELAY_MS;
    this.bump(player);
    this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: 'died', cause: reason });
  },
  /**
   * Finish a death that was started by walking into spikes: the player is
   * standing in the cell and the spikes have had their moment, so the death
   * lands now. Driven from the tick, not from the action, which is what makes
   * the step into the block something to see.
   */
  resolveDeaths(now = this.now()) {
    for (const player of [...this.players.values()]) {
      if (!player.alive || !player.dyingAt) continue;
      if (now < player.dyingAt) continue;
      this.kill(player, 'spikes');
    }
  },
  /** Respawn anyone whose timer expired. Guarded so a logout or a reset during
   *  the death animation cannot drop a player back into a stale world. */
  resolveRespawns(now = this.now()) {
    for (const player of [...this.players.values()]) {
      if (player.alive || !player.respawnAt) continue;
      if (now < player.respawnAt) continue;
      player.respawnAt = 0;
      const x = this.freeColumn();
      if (x < 0) { player.respawnAt = now + 1000; continue; }
      player.x = x;
      player.y = this.world.topY;
      player.alive = true;
      player.stuckUntil = 0;
      player.dyingAt = 0;
      this.initInventory(player);
      this.world.revealSurface(player.discovered);
      this.bump(player);
      this.bus.toPlayer(player, 'respawned', {
        x: player.x,
        y: player.y,
        you: this.snapshot(player),
        reason: 'respawned',
      });
    }
  },
  /**
   * Start a brand new run on a fresh seed. Accounts and lifetime stats survive;
   * the pit, the loot and everyone's position do not.
   *
   * The caller must have taken `finishRunTotals()` for the run being closed
   * before calling this, or the last run's numbers are dropped.
   * @returns {number} the new seed
   */
  newRun(seed) {
    this.world.seed = seed >>> 0;
    this.world.clearRun();
    this.traps.clear();
    this.pendingBlocks.length = 0;
    this.pendingEffects.length = 0;
    this.globalMaxDepth = 0;
    this.clearRunTotals();
    // A new run is a new pit: no fight carries over, no gate has been beaten and
    // no loot is lying on the ground.
    this.battles.clear();
    this.battleByCell.clear();
    this.groundItems.clear();
    this.defeatedBosses.clear();
    // A new run is a fresh choice: the class an account picked does not carry
    // over, so every player is asked again when they (re)enter.
    this.runClasses.clear();

    for (const p of this.players.values()) {
      const x = this.freeColumn();
      p.x = x >= 0 ? x : 0;
      p.y = this.world.topY;
      p.alive = true;
      p.digging = null;
      p.respawnAt = 0;
      p.stuckUntil = 0;
      p.battleId = null;
      this.initInventory(p);
      p.maxDepth = 0;
      p.runStats = blankRunStats();
      p.discovered = new Set();
      p.wallsCleared = new Set();
      this.world.revealSurface(p.discovered);
      this.runDiscovered.set(p.code, p.discovered);
      this.runClearedWalls.set(p.code, p.wallsCleared);
      this.runTotals.set(p.code, blankRunStats());
      this.dirtyStats.add(p.code);
      p.emote = null;
      p.lastEmoteAt = 0;
      this.bump(p);
    }
    this.updateGlobalMaxDepth();
    return this.world.seed;
  },
  /**
   * One server tick: advance the world, then hand the caller everything that
   * needs broadcasting.
   * @returns {{players:Array, digs:Array, blocks:Array, effects:Array}}
   */
  tick(now = this.now()) {
    this.resolveDigs(now);
    this.resolveDeaths(now);
    this.resolveRespawns(now);
    this.resolveBattles(now);

    const now2 = this.now();
    const digs = [];
    for (const p of this.players.values()) {
      if (!p.digging) continue;
      const d = p.digging;
      digs.push({
        id: p.id,
        x: d.x,
        y: d.y,
        startedAt: d.startedAt,
        duration: d.duration,
        progress: Math.max(0, Math.min(1, (now2 - d.startedAt) / d.duration)),
      });
    }

    const blocks = this.pendingBlocks.splice(0, this.pendingBlocks.length);
    const effects = this.pendingEffects.splice(0, this.pendingEffects.length);
    return {
      players: [...this.players.values()].map((p) => this.publicPlayer(p)),
      digs,
      blocks,
      effects,
    };
  }
};
