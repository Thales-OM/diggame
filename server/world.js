'use strict';

// ---------- World ----------
// Deterministic generation: every block is a pure function of (worldSeed, x, y),
// so two players who discover the same cell always see the same thing.
//
// Surface model (SPEC "start on the ground with green grass and blue sky"):
//   y <  SURFACE_Y   sky (air). The highest cell a player can stand in is
//                    SURFACE_Y - 1, i.e. you stand ON the surface, not inside it.
//   y == SURFACE_Y   the surface row: always dirt, never stone or spikes, never
//                    carries an item, and is drawn with grass on top.
//   y >  SURFACE_Y   the pit: stone / spikes / dirt, dirt may contain items.
//
// "Du" state (blocks that have been dug out) is NOT part of generation. It lives
// in a per-run Set and is layered on top by currentBlock(). Mixing the two - the
// bug that made walking a dug tunnel re-trigger the dig timer - is impossible
// here because generation functions are the only source of "what is naturally
// here" and currentBlock() is the only source of "what is here now".

const BLOCK = {
  AIR: 'air',
  DIRT: 'dirt',
  STONE: 'stone',
  SPIKES: 'spikes',
};

// ---------- deterministic hash ----------
function hashCoord(seed, x, y) {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y + 100000, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 0..1 float from a coordinate, stable for a given seed. */
function roll01(seed, x, y, salt = 0) {
  return (hashCoord(seed, Math.imul(x, 31) + salt, y) % 100000) / 100000;
}

function pickWeighted(weights, r) {
  let acc = 0;
  for (const [id, w] of Object.entries(weights)) {
    acc += w;
    if (r < acc) return id;
  }
  return Object.keys(weights)[0] || null;
}

class World {
  /**
   * @param {object} config  frozen CONFIG from server/config
   * @param {number} seed
   */
  constructor(config, seed) {
    this.config = config;
    this.seed = seed >>> 0;
    this.width = config.WORLD_WIDTH;
    this.surfaceY = config.SURFACE_Y;
    this.topY = this.surfaceY - 1; // highest cell a player may occupy
    /** cells that have been dug out during the current run */
    this.dug = new Set();
  }

  static key(x, y) { return x + ',' + y; }
  key(x, y) { return World.key(x, y); }

  inBounds(x, y) { return x >= 0 && x < this.width; }

  /** Random seed. Honours CONFIG.WORLD_SEED so a run can be pinned/reproduced. */
  static randomSeed(config) {
    const pinned = config.WORLD_SEED;
    if (pinned !== undefined && pinned !== null && String(pinned).trim() !== '') {
      const n = Number(pinned);
      if (Number.isFinite(n)) return Math.abs(Math.trunc(n)) >>> 0;
    }
    return Math.floor(Math.random() * 0x100000000) >>> 0;
  }

  // ---------- generation ----------
  /**
   * What is naturally generated at (x, y). Never reflects dug-out state.
   * @returns {{x:number,y:number,type:string,item:string|null}|null}
   *   null when the cell is outside the world
   */
  generatedBlock(x, y) {
    if (!this.inBounds(x, y)) return null;
    const cfg = this.config;

    if (y < this.surfaceY) {
      return { x, y, type: BLOCK.AIR, item: null };
    }
    if (y === this.surfaceY) {
      // The surface row is always plain dirt: a fair, visible, walkable floor.
      return { x, y, type: BLOCK.DIRT, item: null };
    }

    // the same measure the HUD shows, so "depth 3 stone" means what it says
    // (SPEC: depth is max(0, y - (SURFACE_Y - 1)))
    const depth = this.depthOf(y);
    const r = roll01(this.seed, x, y, 1);

    const stoneChance = Math.min(cfg.STONE_CHANCE_MAX, cfg.STONE_CHANCE_BASE + depth * cfg.STONE_CHANCE_PER_DEPTH);
    const spikeChance = Math.min(cfg.SPIKE_CHANCE_MAX, cfg.SPIKE_CHANCE_BASE + depth * cfg.SPIKE_CHANCE_PER_DEPTH);

    if (r < stoneChance) return { x, y, type: BLOCK.STONE, item: null };
    if (r < stoneChance + spikeChance) return { x, y, type: BLOCK.SPIKES, item: null };

    // Dirt: deterministic item roll, so a block's loot is the same for everyone
    // who ever sees it and a player can decide whether it is worth digging.
    const itemChance = Math.min(cfg.ITEM_CHANCE_MAX, cfg.ITEM_CHANCE + depth * cfg.ITEM_CHANCE_PER_DEPTH);
    const ir = roll01(this.seed, x, y, 2);
    const item = ir < itemChance ? pickWeighted(cfg.ITEM_WEIGHTS, roll01(this.seed, x, y, 3)) : null;
    return { x, y, type: BLOCK.DIRT, item };
  }

  // ---------- current state ----------
  /** The cell as it exists right now: generation, overlaid with dug-out cells. */
  currentBlock(x, y) {
    const gen = this.generatedBlock(x, y);
    if (!gen) return null;
    if (!this.dug.has(this.key(x, y))) return gen;
    // A dug cell advertises no item. The item inside it belongs to whoever dug
    // it, and the moment they take it the block is empty: keeping it on the
    // cell made every player who had discovered that block keep seeing the
    // loot drawn on it forever, on every resync, long after it was collected.
    return { x, y, type: BLOCK.AIR, item: null };
  }

  isDug(x, y) { return this.dug.has(this.key(x, y)); }

  /**
   * Mark a cell as dug. Returns the block that was removed, or null.
   *
   * Whatever the block held is gone with it. A dig hands the item to the
   * digger and a blast buries it, and either way the cell stops offering it.
   */
  digOut(x, y) {
    const gen = this.generatedBlock(x, y);
    if (!gen || this.dug.has(this.key(x, y))) return null;
    this.dug.add(this.key(x, y));
    return gen;
  }

  /**
   * Reveal a player's surroundings: the cell they occupy plus the four
   * orthogonal neighbours, each with its real contents. This is what SPEC calls
   * discovering left/right/down, and it is the only reason a client can draw
   * anything other than "unknown".
   *
   * @param {Set<string>} discovered  the player's own discovery set, mutated
   * @returns {Array} only the cells that were not already known
   */
  revealAround(discovered, x, y) {
    const fresh = [];
    const cells = [
      [x, y],
      [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ];
    for (const [cx, cy] of cells) {
      const k = this.key(cx, cy);
      if (discovered.has(k)) continue;
      const b = this.currentBlock(cx, cy);
      if (!b) continue; // out of bounds: nothing to reveal
      discovered.add(k);
      fresh.push(b);
    }
    return fresh;
  }

  /**
   * First discovery of the whole surface row, so a fresh player sees the ground
   * and the sky (SPEC) instead of standing in the dark on a black screen.
   */
  revealSurface(discovered) {
    const fresh = [];
    for (let x = 0; x < this.width; x++) {
      for (const y of [this.topY, this.surfaceY]) {
        const k = this.key(x, y);
        if (discovered.has(k)) continue;
        const b = this.currentBlock(x, y);
        if (!b) continue;
        discovered.add(k);
        fresh.push(b);
      }
    }
    return fresh;
  }

  /**
   * How deep a row is, in blocks dug below the spawn line. Zero is where
   * everybody starts (y = topY, standing on the surface), and it is the same
   * measure the generation ramps use, so "depth 3 stone" means exactly what the
   * player's HUD says at depth 3.
   */
  depthOf(y) { return Math.max(0, y - this.topY); }

  // ---------- run lifecycle ----------
  clearRun() {
    this.dug.clear();
  }
}

function neighbors4(x, y) { return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]; }
function neighbors8(x, y) {
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx || dy) out.push([x + dx, y + dy]);
    }
  }
  return out;
}

module.exports = { World, BLOCK, neighbors4, neighbors8, hashCoord, roll01, pickWeighted };
