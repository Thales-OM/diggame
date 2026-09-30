'use strict';

// ---------- Game rules ----------
// Everything that decides *what happens* lives here: players, movement, the dig
// state machine, spikes and armour, items, traps, dynamite and resets.
//
// This module never talks to a socket. It emits through an injected bus, which
// is what makes it runnable headless in the test suite:
//
//   bus.toPlayer(player, event, payload)   - private, goes to one player
//   bus.broadcast(event, payload)          - public, goes to everyone
//
// Every state-changing event carries the player's authoritative `you` snapshot
// (see protocol.js). The client is never expected to work out where it ended up
// from a direction and a success flag, which is what caused half of BUGS.md.

const { World, BLOCK, neighbors8, pickWeighted } = require('./world');

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
};

/**
 * How many player skins exist. The browser draws the same list in public/
 * MODELS; the server has to know the count too, or it will happily accept a
 * model index that no client can draw.
 */
const MODEL_COUNT = 5;

class Game {
  /**
   * @param {object} deps
   * @param {object} deps.config  frozen CONFIG
   * @param {World}  deps.world
   * @param {object} deps.bus     { toPlayer, broadcast }
   * @param {() => number} [deps.now]
   * @param {() => number} [deps.random]
   *
   * There is no storage here on purpose: the game hands out stat deltas and
   * server.js decides when to write them, so the rules stay testable and the
   * database is never touched from inside a rule.
   */
  constructor({ config, world, bus, now = () => Date.now(), random = () => Math.random() }) {
    this.config = config;
    this.world = world;
    this.bus = bus;
    this.now = now;
    this.random = random;

    this.players = new Map();
    this.nextId = 1;
    /** playerId -> { x, y, ownerId } bear traps, invisible to other players */
    this.traps = new Map();
    /**
     * account code -> Set of "x,y" cells that account has discovered, kept for
     * the whole run. Without this, logging back in hands you a fresh empty map
     * and everything you already dug goes dark. BUGS v0.3.0.
     */
    this.runDiscovered = new Map();
    /** block changes waiting to be flushed by the next tick broadcast */
    this.pendingBlocks = [];
    this.pendingEffects = [];
    this.globalMaxDepth = 0;
    this.dirtyStats = new Set();
    /**
     * code -> cumulative run totals, and how much of that has already been
     * handed to storage. Keyed by code rather than by player so a disconnect
     * cannot lose the run a player already earned, and a reconnect in the same
     * run continues it instead of starting again from zero.
     */
    this.runTotals = new Map();
    this.statBaseline = new Map();
  }

  // ================= players =================

  playerAt(x, y) {
    for (const p of this.players.values()) {
      if (p.alive && p.x === x && p.y === y) return p;
    }
    return null;
  }

  freeColumn() {
    const top = this.world.topY;
    const start = Math.floor(this.random() * this.world.width);
    for (let i = 0; i < this.world.width; i++) {
      const x = (start + i) % this.world.width;
      if (!this.playerAt(x, top)) return x;
    }
    return -1; // world is full
  }

  addPlayer({ code, name, modelIndex = 0, stats = null }) {
    const x = this.freeColumn();
    if (x < 0) return null;

    // a player rejoining the run they are already in keeps what they dug
    const carried = this.runTotals.get(code);
    if (!carried) this.runTotals.set(code, blankRunStats());

    // ...and keeps the map they have drawn so far. Stored by account code, not
    // by player id, because the id changes the moment they reconnect.
    const knownCells = this.runDiscovered.get(code) || new Set();
    this.runDiscovered.set(code, knownCells);

    const p = {
      id: this.nextId++,
      code,
      name,
      modelIndex,
      x,
      y: this.world.topY,
      alive: true,
      discovered: knownCells,
      inventory: { armor: 0, dynamite: 0, trap: 0, shovelUntil: 0 },
      stuckUntil: 0,
      // Set while the player is impaled on spikes: the tick kills them when it
      // passes, which is what makes stepping into the block visible.
      dyingAt: 0,
      digging: null,
      maxDepth: carried ? carried.maxDepth : 0,
      // per-run numbers, flushed to storage as deltas on a timer and at run end
      runStats: carried ? { ...carried } : blankRunStats(),
      lifetime: stats || { maxDepth: 0, deaths: 0, itemsCollected: 0, blocksDug: 0, runsPlayed: 0, spikesSurvived: 0 },
      respawnAt: 0,
      rev: 0,
    };

    this.world.revealSurface(p.discovered);
    this.players.set(p.id, p);
    this.noteDepth(p);
    return p;
  }

  removePlayer(player) {
    if (!player) return;
    player.respawnAt = 0; // cancel any pending respawn
    player.dyingAt = 0;
    // keep the run they earned: runTotals is keyed by account code, so the
    // final flush can still hand it to storage
    this.runTotals.set(player.code, { ...player.runStats });
    this.dirtyStats.add(player.code);
    // same for the map: the Set object itself is already in runDiscovered and
    // is the one the player mutates, so there is nothing to copy back
    this.runDiscovered.set(player.code, player.discovered);
    for (const [k, t] of this.traps) {
      if (t.ownerId === player.id) this.traps.delete(k);
    }
    this.players.delete(player.id);
    this.updateGlobalMaxDepth();
  }

  // ================= statistics =================

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
  }

  /** Forget the run totals of everybody. Only correct after storage has taken
   *  the final deltas for the run being closed. */
  clearRunTotals() {
    this.runTotals.clear();
    this.statBaseline.clear();
    this.dirtyStats.clear();
    // a new run is a new world: the old cell keys mean nothing here
    this.runDiscovered.clear();
  }

  /** Take the final deltas for a run that is about to end, in one shot. */
  finishRunTotals() {
    this.dirtyStats = new Set(this.runTotals.keys());
    return this.takeStatDeltas();
  }
  bump(player) {
    player.rev++;
    this.dirtyStats.add(player.code);
  }

  noteDepth(player) {
    const d = this.world.depthOf(player.y);
    if (d > player.maxDepth) player.maxDepth = d;
    if (d > player.runStats.maxDepth) player.runStats.maxDepth = d;
    this.updateGlobalMaxDepth();
  }

  updateGlobalMaxDepth() {
    let m = 0;
    for (const p of this.players.values()) m = Math.max(m, p.maxDepth);
    this.globalMaxDepth = m;
  }

  // ================= derived state =================

  isStuck(player) { return this.now() < player.stuckUntil; }
  isDying(player) { return !!player.dyingAt && this.now() >= player.dyingAt; }
  hasShovel(player) { return this.now() < player.inventory.shovelUntil; }

  digDuration(player) {
    return this.hasShovel(player) ? this.config.SHOVEL_DIG_TIME_MS : this.config.DIG_TIME_MS;
  }

  /** The player's authoritative private snapshot. This is the single source of
   *  truth for where they are; the client must never derive it. */
  /**
   * The traps this player has set. Bear traps are secret: nobody else may see
   * where they are, but the person who set one has to be able to see their own
   * traps, or they have no idea what they are protecting. BUGS v0.3.0.
   */
  trapsOf(player) {
    const out = [];
    for (const t of this.traps.values()) {
      if (t.ownerId === player.id) out.push({ x: t.x, y: t.y });
    }
    return out;
  }

  /**
   * Remove the trap on a cell and tell its owner. A trap is secret, so nothing
   * goes out to the other players; but the owner is the one person who is
   * drawing it, and their view has to be corrected the moment it is gone
   * rather than at their next action. BUGS v0.3.0.
   */
  removeTrap(key) {
    const trap = this.traps.get(key);
    if (!trap) return null;
    this.traps.delete(key);
    const owner = this.playerById(trap.ownerId);
    if (owner) {
      this.bump(owner);
      this.bus.toPlayer(owner, 'state', {
        you: this.snapshot(owner),
        reason: 'trapRemoved',
        trap: { x: trap.x, y: trap.y },
      });
    }
    return trap;
  }

  playerById(id) {
    for (const p of this.players.values()) {
      if (p.id === id) return p;
    }
    return null;
  }

  snapshot(player) {
    const now = this.now();
    return {
      id: player.id,
      code: player.code,
      name: player.name,
      model: player.modelIndex,
      x: player.x,
      y: player.y,
      alive: player.alive,
      depth: this.world.depthOf(player.y),
      maxDepth: player.maxDepth,
      digging: player.digging
        ? {
            x: player.digging.x,
            y: player.digging.y,
            dir: player.digging.dir,
            startedAt: player.digging.startedAt,
            duration: player.digging.duration,
          }
        : null,
      stuckUntil: player.stuckUntil,
      // > 0 while the player is on the spikes waiting to die, so the client can
      // show the step-in and then the death as two things
      dyingAt: player.dyingAt,
      shovelUntil: player.inventory.shovelUntil,
      armor: player.inventory.armor,
      dynamite: player.inventory.dynamite,
      trap: player.inventory.trap,
      // only the owner's own traps, and only in the private snapshot: this is
      // never part of publicPlayer or the tick, so it cannot leak
      traps: this.trapsOf(player),
      // absolute server timestamps, so the client can render countdowns on
      // server time instead of guessing at its own clock
      serverNow: now,
      // the revision this snapshot was taken at, so a client that only ever
      // sees private events (digComplete, state) still knows where it stands
      // and its next action is not rejected as stale
      rev: player.rev,
    };
  }

  publicPlayer(player) {
    const now = this.now();
    return {
      id: player.id,
      name: player.name,
      model: player.modelIndex,
      x: player.x,
      y: player.y,
      alive: player.alive,
      stuck: now < player.stuckUntil,
      // so the step into the spikes is something other players watch happen
      // too, rather than a disappearance next to the block
      dying: !!player.dyingAt,
    };
  }

  // ================= actions =================

  /**
   * Change a player's skin.
   *
   * BUGS v0.3.0: the handler used to write `player.modelIndex` straight from the
   * socket, which meant the change did not bump rev and nothing was sent back.
   * The client only redraws *itself* from its own snapshot, so the new skin sat
   * there until the next dig, move or item use happened to answer with one.
   * Emitting the private snapshot here makes the change instant, and the rev
   * bump makes the next action go out against a current baseline.
   *
   * @returns {{ok:boolean, error?:string, model?:number, changed?:boolean}}
   */
  setModel(player, modelIndex) {
    if (!Number.isInteger(modelIndex) || modelIndex < 0 || modelIndex >= MODEL_COUNT) {
      return { ok: false, error: ERR.INVALID_MODEL };
    }
    if (player.modelIndex === modelIndex) {
      return { ok: true, changed: false, model: player.modelIndex };
    }
    player.modelIndex = modelIndex;
    this.bump(player);
    this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: 'modelChanged' });
    return { ok: true, changed: true, model: modelIndex };
  }

  /**
   * Entry point for anything a player asks to do.
   * @returns {{ok:boolean, error?:string, ignored?:boolean, delta?:object}}
   */
  action(player, { type, dir }) {
    if (!player) return { ok: false, error: 'not_logged_in' };
    if (type === 'sync') return { ok: true };
    if (!player.alive) return { ok: false, error: ERR.DEAD };
    // Impaled: the spikes have them and the next thing that happens is a death.
    if (player.dyingAt) return { ok: false, error: ERR.DYING };

    switch (type) {
      case 'move': return this.requestMove(player, dir);
      case 'useDynamite': return this.useDynamite(player);
      case 'placeTrap': return this.placeTrap(player);
      default: return { ok: false, error: 'unknown_action' };
    }
  }

  /**
   * A move request. Three outcomes:
   *  - we are already digging that exact cell -> ignore, timer untouched
   *  - the cell is passable now               -> move immediately
   *  - the cell is dirt                       -> start (or restart) a dig
   */
  requestMove(player, dir) {
    const d = DIRS[dir];
    if (!d) return { ok: false, error: 'invalid_dir' };
    if (this.isStuck(player)) return { ok: false, error: ERR.STUCK };

    const nx = player.x + d[0];
    const ny = player.y + d[1];

    if (ny < this.world.topY) return { ok: false, error: ERR.ABOVE_SURFACE };

    // Same cell we are already digging: BUGS "pressing the same direction
    // restarts the wait time". Ignore instead of cancelling.
    if (player.digging && player.digging.x === nx && player.digging.y === ny) {
      return { ok: true, ignored: true, delta: { ignored: true, digging: this.snapshot(player).digging } };
    }

    this.cancelDig(player, dir);

    const trapKey = this.world.key(nx, ny);
    const trap = this.traps.get(trapKey);
    if (trap && trap.ownerId !== player.id) {
      this.removeTrap(trapKey);
      player.stuckUntil = this.now() + this.config.STUCK_DURATION_MS;
      this.bump(player);
      this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: 'trapped' });
      this.bus.broadcast('trapTriggered', { x: nx, y: ny });
      this.bus.toPlayer(player, 'toast', { text: 'A bear trap! Stuck for a minute.', kind: 'bad' });
      return { ok: false, error: ERR.STUCK, delta: { trapped: true, you: this.snapshot(player) } };
    }

    const target = this.world.currentBlock(nx, ny);
    if (!target) return { ok: false, error: ERR.WALL };

    if (target.type === BLOCK.AIR) {
      if (this.playerAt(nx, ny)) return { ok: false, error: ERR.OCCUPIED };
      const revealed = this.enterCell(player, nx, ny);
      return { ok: true, delta: { moved: true, revealed, you: this.snapshot(player) } };
    }

    if (target.type === BLOCK.STONE) return { ok: false, error: ERR.STONE };

    if (target.type === BLOCK.SPIKES) {
      if (this.playerAt(nx, ny)) return { ok: false, error: ERR.OCCUPIED };
      if (player.inventory.armor > 0) {
        // SPEC: armour survives one spikes hit. The spikes block is preserved,
        // so walking out and back in costs another piece.
        player.inventory.armor -= 1;
        player.runStats.spikesSurvived += 1;
        const revealed = this.enterCell(player, nx, ny);
        this.bump(player);
        this.bus.toPlayer(player, 'toast', {
          text: 'Your armour takes the spikes.', kind: player.inventory.armor > 0 ? '' : 'bad',
        });
        return { ok: true, delta: { moved: true, revealed, spikesAbsorbed: true, you: this.snapshot(player) } };
      }
      // No armour: step into the spikes first and die there. Killing on the
      // spot left the model standing in the cell it came from, so the player
      // was never impaled by the block they walked into - they just vanished
      // next to it. The move succeeds, and the tick finishes the job, so the
      // step-in is something you can watch.
      const revealed = this.enterCell(player, nx, ny);
      player.digging = null;
      player.dyingAt = this.now() + this.config.SPIKES_DEATH_DELAY_MS;
      this.bump(player);
      this.bus.toPlayer(player, 'toast', { text: 'The spikes have you.', kind: 'bad' });
      return {
        ok: true,
        delta: { moved: true, revealed, dying: true, you: this.snapshot(player) },
      };
    }

    // dirt: start a dig
    const dig = {
      x: nx,
      y: ny,
      dir,
      startedAt: this.now(),
      duration: this.digDuration(player),
    };
    player.digging = dig;
    this.bump(player);
    return { ok: true, delta: { digging: { ...dig }, you: this.snapshot(player) } };
  }

  /** Put a player into a cell they are allowed to occupy, and reveal it. */
  enterCell(player, x, y) {
    player.x = x;
    player.y = y;
    this.noteDepth(player);
    const revealed = this.world.revealAround(player.discovered, x, y);
    this.bump(player);
    this.shareIfEnabled(player, revealed);
    return revealed;
  }

  /**
   * SPEC: discovery is private per player, but the switch is left in place for
   * the day it should be shared. When it is on, what one player finds is added to
   * everybody's map, so a tunnel dug by one player is mapped for the rest.
   */
  shareIfEnabled(player, fresh) {
    if (!this.config.SHARE_DISCOVERIES || !fresh.length) return;
    for (const other of this.players.values()) {
      if (other.id === player.id) continue;
      for (const b of fresh) other.discovered.add(this.world.key(b.x, b.y));
    }
    this.bus.broadcast('sharedDiscovery', { from: player.id, blocks: fresh });
  }

  cancelDig(player, reason = 'cancelled') {
    if (!player.digging) return false;
    player.digging = null;
    this.bump(player);
    return reason;
  }

  // ================= dig resolution =================

  /**
   * Called every tick. Completes any dig whose timer expired, re-validating the
   * world first: dynamite or another player may have removed the cell, or the
   * digger may have died or logged out in the meantime.
   * @returns {Array} players whose dig completed this tick
   */
  resolveDigs(now = this.now()) {
    const finished = [];
    for (const player of [...this.players.values()]) {
      const d = player.digging;
      if (!d) continue;
      if (now - d.startedAt < d.duration) continue;

      player.digging = null;

      if (!player.alive) { this.bump(player); continue; }

      const target = this.world.currentBlock(d.x, d.y);
      if (!target || target.type !== BLOCK.DIRT) {
        // Somebody blew it up or someone else took it.
        this.bump(player);
        this.bus.toPlayer(player, 'digAborted', { x: d.x, y: d.y, reason: 'gone', you: this.snapshot(player) });
        continue;
      }

      this.completeDig(player, d);
      finished.push(player);
    }
    return finished;
  }

  completeDig(player, d) {
    const block = this.world.generatedBlock(d.x, d.y);
    const before = { x: player.x, y: player.y };

    let item = block.item;
    let bonus = false;
    if (!item) {
      // Catch-up rule (SPEC): a player who is behind the leader gets a
      // consolation roll when they dig an empty block.
      const deficit = Math.max(0, this.globalMaxDepth - this.world.depthOf(d.y));
      const chance = Math.min(
        this.config.ITEM_BONUS_MAX,
        this.config.ITEM_BONUS_BASE + deficit * this.config.ITEM_BONUS_PER_DEPTH
      );
      if (deficit > 0 && this.random() < chance) {
        item = pickWeighted(this.config.ITEM_WEIGHTS, this.random());
        bonus = true;
      }
    }

    this.world.digOut(d.x, d.y);
    this.pendingBlocks.push({ x: d.x, y: d.y });

    const revealed = this.enterCell(player, d.x, d.y);
    player.runStats.blocksDug += 1;

    if (item) {
      this.grant(player, item);
      player.runStats.itemsCollected += 1;
    }

    this.bus.broadcast('blockDug', { x: d.x, y: d.y });
    this.bus.toPlayer(player, 'digComplete', {
      from: before,
      dug: { x: d.x, y: d.y },
      revealed,
      item,
      bonus,
      you: this.snapshot(player),
    });
    if (bonus) {
      this.bus.toPlayer(player, 'toast', { text: `Behind the pack, and lucky: ${item}!`, kind: 'good' });
    }
  }

  grant(player, item) {
    const inv = player.inventory;
    switch (item) {
      case 'armor': inv.armor += 1; break;
      case 'dynamite': inv.dynamite += 1; break;
      case 'trap': inv.trap += 1; break;
      case 'shovel': inv.shovelUntil = this.now() + this.config.SHOVEL_DURATION_MS; break;
      default: return false;
    }
    this.bump(player);
    return true;
  }

  // ================= items =================

  useDynamite(player) {
    if (player.inventory.dynamite <= 0) return { ok: false, error: ERR.NO_DYNAMITE };
    // using an item interrupts whatever you were digging
    this.cancelDig(player, 'dynamite');
    player.inventory.dynamite -= 1;

    const destroyed = [];
    for (const [dx, dy] of neighbors8(player.x, player.y)) {
      // A trap always sits on a cell that is already dug out, because that is
      // the only kind of cell a player can stand in. It has to be swept up
      // before the air check below, or a blast would leave it sitting in the
      // rubble untouched. The owner is told, so their view corrects itself.
      this.removeTrap(this.world.key(dx, dy));

      const b = this.world.currentBlock(dx, dy);
      if (!b || b.type === BLOCK.AIR) continue;
      this.world.digOut(dx, dy);
      destroyed.push({ x: dx, y: dy });
      this.pendingBlocks.push({ x: dx, y: dy });
      // anyone mid-dig towards a cell that just vanished must be told
      for (const other of this.players.values()) {
        if (other.digging && other.digging.x === dx && other.digging.y === dy) {
          other.digging = null;
          this.bump(other);
          this.bus.toPlayer(other, 'digAborted', { x: dx, y: dy, reason: 'blown_up', you: this.snapshot(other) });
        }
      }
    }

    this.bump(player);
    this.pendingEffects.push({ kind: 'boom', x: player.x, y: player.y });
    this.bus.broadcast('boom', { x: player.x, y: player.y });
    return { ok: true, delta: { destroyed, you: this.snapshot(player) } };
  }

  placeTrap(player) {
    if (player.inventory.trap <= 0) return { ok: false, error: ERR.NO_TRAP };
    this.cancelDig(player, 'trap');
    player.inventory.trap -= 1;
    const k = this.world.key(player.x, player.y);
    this.traps.set(k, { ownerId: player.id, x: player.x, y: player.y });
    this.bump(player);
    this.pendingEffects.push({ kind: 'trapPlaced', x: player.x, y: player.y });
    return { ok: true, delta: { trapPlaced: { x: player.x, y: player.y }, you: this.snapshot(player) } };
  }

  // ================= death and respawn =================

  kill(player, reason) {
    if (!player.alive) return;
    player.alive = false;
    player.digging = null;
    player.dyingAt = 0;
    player.runStats.deaths += 1;
    player.respawnAt = this.now() + this.config.RESPAWN_DELAY_MS;
    this.bump(player);
    this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: 'died', cause: reason });
  }

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
  }

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
      player.inventory = { armor: 0, dynamite: 0, trap: 0, shovelUntil: 0 };
      this.world.revealSurface(player.discovered);
      this.bump(player);
      this.bus.toPlayer(player, 'respawned', {
        x: player.x,
        y: player.y,
        you: this.snapshot(player),
        reason: 'respawned',
      });
    }
  }

  // ================= run lifecycle =================

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

    for (const p of this.players.values()) {
      const x = this.freeColumn();
      p.x = x >= 0 ? x : 0;
      p.y = this.world.topY;
      p.alive = true;
      p.digging = null;
      p.respawnAt = 0;
      p.stuckUntil = 0;
      p.inventory = { armor: 0, dynamite: 0, trap: 0, shovelUntil: 0 };
      p.maxDepth = 0;
      p.runStats = blankRunStats();
      p.discovered = new Set();
      this.world.revealSurface(p.discovered);
      // clearRunTotals() above emptied the map of remembered cells, so start
      // this player a fresh one that the run will now carry for them
      this.runDiscovered.set(p.code, p.discovered);
      this.runTotals.set(p.code, blankRunStats());
      this.dirtyStats.add(p.code);
      this.bump(p);
    }
    this.updateGlobalMaxDepth();
    return this.world.seed;
  }

  // ================= tick =================

  /**
   * One server tick: advance the world, then hand the caller everything that
   * needs broadcasting.
   * @returns {{players:Array, digs:Array, blocks:Array, effects:Array}}
   */
  tick(now = this.now()) {
    this.resolveDigs(now);
    this.resolveDeaths(now);
    this.resolveRespawns(now);

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

}

/** The per-run counters every player starts from. */
function blankRunStats() {
  return { maxDepth: 0, blocksDug: 0, deaths: 0, itemsCollected: 0, spikesSurvived: 0 };
}

module.exports = { Game, DIRS, ERR, MODEL_COUNT };
