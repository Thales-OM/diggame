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
  // An impassable bedrock band that curves the way down through a single gap.
  BEDROCK: 'bedrock',
  // A boss or miniboss cell. It is dug like dirt, but completing that dig starts
  // a battle instead of clearing the cell; the cell is only emptied when the
  // boss is defeated.
  BOSS: 'boss',
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

    // ---------- gates, bosses and minibosses ----------
    // All of this is a pure function of the seed, so two players (and the admin
    // view) always agree on where the walls, the gaps and the bosses are.
    this.gateEvery = Math.max(2, Math.floor(config.GATE_EVERY_N_DEPTH));
    this.gateMinDepth = Math.max(1, Math.floor(config.GATE_MIN_DEPTH));
    // key -> { kind, x, y, depth, hp, attack, gate }
    this.bossCells = new Map();
    // cells that must generate as air so a boss can be reached
    this.bossAir = new Set();
    this.buildBosses(config);
  }

  /**
   * How many gate regions to precompute. Gates themselves are recognised on
   * demand at any depth, but the scattered minibosses are a fixed list, so it
   * has to reach further than a run plausibly will - digging one cell at a time
   * makes an artificial bottom, and beyond it there is simply nothing special.
   */
  static MAX_REGIONS = 400;

  /** True when a whole-row bedrock band occupies the given depth. */
  isGateDepth(depth) {
    return depth >= this.gateMinDepth
      && (depth - this.gateMinDepth) % this.gateEvery === 0;
  }

  /** Which gate band a depth is, or -1 when it is not a gate row. */
  gateIndexOf(depth) {
    if (!this.isGateDepth(depth)) return -1;
    return Math.floor((depth - this.gateMinDepth) / this.gateEvery);
  }

  /** The single column of a gate band that is left open. */
  gapColumn(gateIndex) {
    return Math.floor(roll01(this.seed, gateIndex, 0, 9) * this.width);
  }

  /** Add a boss cell and force its eight neighbours to air. */
  addBoss(info) {
    this.bossCells.set(this.key(info.x, info.y), info);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const ax = info.x + dx, ay = info.y + dy;
        if (ax < 0 || ax >= this.width) continue;
        // never carve air through the surface row or the sky
        if (ay <= this.surfaceY) continue;
        // the gate band must stay solid except for its one gap, so the chamber
        // around a gate boss does not widen the opening
        if (this.isGateDepth(this.depthOf(ay))) continue;
        // never turn another boss into open air
        if (this.bossCells.has(this.key(ax, ay))) continue;
        this.bossAir.add(this.key(ax, ay));
      }
    }
  }

  buildBosses(config) {
    const topY = this.topY;
    const minibossHp = config.BOSS_MINIBOSS_HP;
    const minibossAtk = config.BOSS_MINIBOSS_ATTACK;

    // Gate bosses: one per band, in the gap column one row below the band.
    for (let g = 0; g <= World.MAX_REGIONS; g++) {
      const depth = this.gateMinDepth + g * this.gateEvery;
      const x = this.gapColumn(g);
      const y = topY + depth + 1;
      this.addBoss({
        kind: 'gate',
        name: `Gate Warden ${g + 1}`,
        x, y, depth,
        gate: g,
        hp: config.BOSS_BASE_HP + g * config.BOSS_HP_PER_GATE,
        attack: config.BOSS_BASE_ATTACK + g * config.BOSS_ATTACK_PER_GATE,
      });
    }

    // Minibosses: MINIBOSS_PER_REGION scattered inside each region between two
    // gates, and in the shallow region above the first gate.
    const per = Math.max(0, Math.floor(config.MINIBOSS_PER_REGION));
    if (per === 0) return;
    const regions = [];
    if (this.gateMinDepth > 3) regions.push({ id: -1, start: 2, end: this.gateMinDepth - 1 });
    for (let r = 0; r < World.MAX_REGIONS; r++) {
      const start = this.gateMinDepth + r * this.gateEvery + 1;
      const end = this.gateMinDepth + (r + 1) * this.gateEvery - 1;
      if (end > start) regions.push({ id: r, start, end });
    }
    for (const region of regions) {
      const span = region.end - region.start + 1;
      for (let i = 0; i < per; i++) {
        const r1 = roll01(this.seed, i, region.id, 20);
        const r2 = roll01(this.seed, i, region.id, 21);
        const depth = region.start + Math.floor(r1 * span);
        const x = Math.floor(r2 * this.width);
        const y = topY + depth;
        // not on top of, or touching, another boss: two chambers side by side
        // would overlap and one would pen the other in
        let clash = false;
        for (const [ax, ay] of [[x, y], ...neighbors8(x, y)]) {
          if (this.bossCells.has(this.key(ax, ay))) { clash = true; break; }
        }
        if (clash) continue;
        this.addBoss({
          kind: 'miniboss',
          name: `Cave Brute ${y}`,
          x, y, depth,
          gate: -1,
          hp: minibossHp,
          attack: minibossAtk,
        });
      }
    }
  }

  /** The boss at a cell, or null. */
  bossAt(x, y) { return this.bossCells.get(this.key(x, y)) || null; }

  /**
   * Every boss in this world, for tests, the admin view and the scoreboard. A
   * plain deterministic list: nothing here has been killed, it just describes
   * where the bosses are.
   */
  bossesFor() {
    return [...this.bossCells.values()].map((b) => ({ ...b }));
  }

  static key(x, y) { return x + ',' + y; }
  key(x, y) { return World.key(x, y); }

  inBounds(x, _y) { return x >= 0 && x < this.width; }

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

    const depth = this.depthOf(y);
    const k = this.key(x, y);

    // A boss occupies a single cell and its neighbours are open ground, so a
    // player can walk up to it and dig it to start the fight.
    const boss = this.bossCells.get(k);
    if (boss) return { x, y, type: BLOCK.BOSS, item: null, boss: boss.kind };
    if (this.bossAir.has(k)) return { x, y, type: BLOCK.AIR, item: null };

    // A gate band is one solid bedrock row with a single gap column, the only
    // way down past that depth.
    if (this.isGateDepth(depth)) {
      if (x === this.gapColumn(this.gateIndexOf(depth))) {
        return { x, y, type: BLOCK.AIR, item: null };
      }
      return { x, y, type: BLOCK.BEDROCK, item: null };
    }

    // the same measure the HUD shows, so "depth 3 stone" means what it says
    // (SPEC: depth is max(0, y - (SURFACE_Y - 1)))
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
