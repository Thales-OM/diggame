'use strict';

// ---------- Players ----------
// The roster: joining, leaving, class choice and the two views of a player
// (the private `snapshot` and the public `publicPlayer`).

const { ERR } = require('../content/constants');
const { CLASSES, MODEL_COUNT } = require('../content/classes');
const { blankInventory, blankRunStats } = require('./helpers');

module.exports = {
  /** The class table, as the browser needs it (id, name, desc, skills). */
  classes() {
    return CLASSES.map((c) => ({ id: c.id, name: c.name, desc: c.desc, skills: c.skills.map((s) => ({ ...s })) }));
  },
  /** The class an account has chosen this run, or undefined if it has not. */
  classOf(code) {
    return this.runClasses.get(code);
  },
  /** Record an account's class for this run. Refuses an unknown index. */
  setClass(code, modelIndex) {
    if (!Number.isInteger(modelIndex) || modelIndex < 0 || modelIndex >= MODEL_COUNT) {
      return { ok: false, error: ERR.INVALID_MODEL };
    }
    this.runClasses.set(code, modelIndex);
    return { ok: true, model: modelIndex };
  },
  playerAt(x, y) {
    for (const p of this.players.values()) {
      if (p.alive && p.x === x && p.y === y) return p;
    }
    return null;
  },
  freeColumn() {
    const top = this.world.topY;
    const start = Math.floor(this.random() * this.world.width);
    for (let i = 0; i < this.world.width; i++) {
      const x = (start + i) % this.world.width;
      if (!this.playerAt(x, top)) return x;
    }
    return -1; // world is full
  },
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

    // ...and keeps the gate walls they have already opened this run, for the
    // same reason.
    const clearedWalls = this.runClearedWalls.get(code) || new Set();
    this.runClearedWalls.set(code, clearedWalls);

    const p = {
      id: this.nextId++,
      code,
      name,
      modelIndex,
      x,
      y: this.world.topY,
      alive: true,
      discovered: knownCells,
      wallsCleared: clearedWalls,
      stuckUntil: 0,
      // Set while the player is impaled on spikes: the tick kills them when it
      // passes, which is what makes stepping into the block visible.
      dyingAt: 0,
      digging: null,
      // non-null while the player is locked in a boss battle; field actions are
      // refused and the client shows the battle overlay
      battleId: null,
      maxDepth: carried ? carried.maxDepth : 0,
      // per-run numbers, flushed to storage as deltas on a timer and at run end
      runStats: carried ? { ...carried } : blankRunStats(),
      lifetime: stats || { maxDepth: 0, deaths: 0, itemsCollected: 0, blocksDug: 0, runsPlayed: 0, spikesSurvived: 0 },
      respawnAt: 0,
      rev: 0,
      emote: null,
      lastEmoteAt: 0,
    };

    this.initInventory(p);
    this.world.revealSurface(p.discovered);
    this.players.set(p.id, p);
    this.noteDepth(p);
    return p;
  },
  removePlayer(player) {
    if (!player) return;
    if (player.battleId) this.leaveBattle(player, 'disconnect');
    player.respawnAt = 0; // cancel any pending respawn
    player.dyingAt = 0;
    // keep the run they earned: runTotals is keyed by account code, so the
    // final flush can still hand it to storage
    this.runTotals.set(player.code, { ...player.runStats });
    this.dirtyStats.add(player.code);
    // same for the map: the Set object itself is already in runDiscovered and
    // is the one the player mutates, so there is nothing to copy back
    this.runDiscovered.set(player.code, player.discovered);
    this.runClearedWalls.set(player.code, player.wallsCleared);
    for (const [k, t] of this.traps) {
      if (t.ownerId === player.id) this.traps.delete(k);
    }
    this.players.delete(player.id);
    this.updateGlobalMaxDepth();
  },
  playerById(id) {
    for (const p of this.players.values()) {
      if (p.id === id) return p;
    }
    return null;
  },
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
      // gate depths whose mist this player has opened; the client draws those
      // rows as tunnels for them and the server lets them walk through
      wallsCleared: [...player.wallsCleared],
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
      // the one pool of health a player has: it persists on the field and into a
      // fight, and is refilled only on spawn or respawn
      hp: player.hp,
      maxHp: player.maxHp,
      // armour points, spent before health against a spike or a boss blow
      armor: player.inventory.armor,
      dynamite: player.inventory.dynamite,
      trap: player.inventory.trap,
      potion: player.inventory.potion,
      // every weapon earned this life, and the one in hand
      weapons: [...player.inventory.weapons],
      weapon: player.inventory.weapon,
      // the private view of the fight this player is locked in, or null
      battle: this.battleView(player),
      // loot lying on the ground (never taken, so public): battle leftovers
      loot: this.groundLoot(),
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
      emote: this.liveEmote(player),
    };
  },
  /** The emote to show, or null once its duration has run out. */
  liveEmote(player) {
    return player.emote && this.now() < player.emote.until ? player.emote : null;
  },
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
      // locked in a boss fight: drawn frozen so nobody expects them to move
      inBattle: !!player.battleId,
      emote: this.liveEmote(player),
    };
  },
  /**
   * A fresh inventory for a player who is joining or respawning. Every class
   * starts with the "Bare-handed" weapon: it carries no damage bonus, but it
   * gives bare fists a home on the loadout, so a weapon can never leave you
   * unable to fight and you can always switch back to your hands.
   */
  initInventory(player) {
    player.inventory = blankInventory();
    player.inventory.weapons.push('bare');
    player.inventory.weapon = 'bare';
    // health is a fresh pool here: this is the spawn / respawn / new-run reset
    player.maxHp = this.config.MAX_HP;
    player.hp = this.config.MAX_HP;
    // a pending gate prompt does not survive a spawn/respawn/new run
    player.pendingGate = null;
  }
};
