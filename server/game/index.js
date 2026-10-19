'use strict';

// ---------- Game rules ----------
// Everything that decides *what happens* lives in this folder: players, movement,
// the dig state machine, spikes and armour, items, traps, dynamite and resets.
//
// The rules are one class, Game, split across mixin modules that are all assigned
// onto its prototype: players.js, stats.js, field.js, items.js, battle.js and
// lifecycle.js. Each mixin exports an object of methods; they still run with
// `this` bound to the Game instance, exactly as if they were written in the class
// body. The class shell and the constructor live here.
//
// This module never talks to a socket. It emits through an injected bus, which
// is what makes it runnable headless in the test suite:
//
//   bus.toPlayer(player, event, payload)   - private, goes to one player
//   bus.broadcast(event, payload)          - public, goes to everyone
//
// Every state-changing event carries the player's authoritative `you` snapshot
// (see protocol.js). The client is never expected to work out where they ended up
// from a direction and a success flag, which is what caused half of BUGS.md.

const { buildWeapons } = require('../content/weapons');
const { DIRS, ERR } = require('../content/constants');
const { CLASSES, MODEL_COUNT } = require('../content/classes');
const { EMOTES } = require('../content/emotes');
const { blankInventory } = require('./helpers');

const players = require('./players');
const stats = require('./stats');
const field = require('./field');
const items = require('./items');
const battle = require('./battle');
const lifecycle = require('./lifecycle');

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
    // the weapon table, its numbers read from config/game.json
    this.weapons = buildWeapons(config.WEAPON_STATS);

    this.players = new Map();
    this.nextId = 1;
    /** playerId -> { x, y, ownerId } bear traps, invisible to other players */
    this.traps = new Map();
    /** battleId -> battle. See startBossEncounter / the battle mixin. */
    this.battles = new Map();
    /** "x,y" -> battleId, so digging the same boss twice joins it instead */
    this.battleByCell = new Map();
    this.nextBattleId = 1;
    /** "x,y" -> { type: 'weapon'|'item', id } loot left on a defeated boss */
    this.groundItems = new Map();
    /** boss cells already beaten this run */
    this.defeatedBosses = new Set();
    /**
     * account code -> Set of "x,y" cells that account has discovered, kept for
     * the whole run. Without this, logging back in hands you a fresh empty map
     * and everything you already dug goes dark. BUGS v0.3.0.
     */
    this.runDiscovered = new Map();
    /**
     * code -> Set of gate depths this account has opened this run by beating the
     * gatekeeper. Keyed by code, like runDiscovered, so a reconnect keeps the
     * walls already earned; a death clears them and a new run wipes them. The
     * mist itself is never dug out globally: the wall opens per player.
     */
    this.runClearedWalls = new Map();
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
    /**
     * code -> class index chosen for the current run. A class is an entry
     * choice, not something you switch mid-run: it is remembered across a
     * reconnect, and a new run asks everyone to choose again.
     */
    this.runClasses = new Map();
  }
}

// The rules, one concern per module. Every method is written as if it were in
// the class body; this stitches them back onto the prototype.
Object.assign(Game.prototype, players, stats, field, items, battle, lifecycle);

module.exports = { Game, DIRS, ERR, MODEL_COUNT, CLASSES, EMOTES, blankInventory };
