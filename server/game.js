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

const { BLOCK, neighbors8, pickWeighted } = require('./world');

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
  INVALID_EMOTE: 'invalid_emote',
  EMOTE_COOLDOWN: 'emote_cooldown',
  IN_BATTLE: 'in_battle',
  NOT_IN_BATTLE: 'not_in_battle',
  INVALID_WEAPON: 'invalid_weapon',
  NO_JOIN: 'no_join',
  BATTLE_FULL: 'battle_full',
  NOT_YOUR_TURN: 'not_your_turn',
  INVALID_BATTLE_ACTION: 'invalid_battle_action',
  NO_SKILL: 'no_skill',
  NO_TARGET: 'no_target',
  HP_FULL: 'hp_full',
};

/**
 * The five playable classes. A player's `modelIndex` *is* their class: the
 * index is the wire protocol, and the browser keeps the same order in public/
 * MODELS so it can draw the matching sprite. The server needs the whole table,
 * not just a count, because a class carries skills that change how a fight
 * plays out.
 *
 * Desc and skill prose are what the browser shows in the class picker; the
 * numbers behind the active skills live in config so they can be tuned without
 * touching this list.
 */
const CLASSES = [
  {
    id: 'wizard', name: 'Wizard',
    desc: 'A scholar of the arcane. Frail in the hand, but the only class that can carry the Magic Staff and unleash its incantation.',
    skills: [
      { id: 'magic_knowledge', name: 'Magic knowledge', kind: 'passive',
        desc: 'Only a Wizard may pick up or wield the Magic Staff, and only a Wizard may incantate with it.' },
    ],
  },
  {
    id: 'knight', name: 'Knight',
    desc: 'A disciplined fighter. Balanced and dependable, and deadlier with a blade in hand.',
    skills: [
      { id: 'weapon_expertise', name: 'Weapon expertise', kind: 'passive',
        desc: 'Sword and rapier blows land harder. Stacks with critical hits.' },
    ],
  },
  {
    id: 'barbarian', name: 'Barbarian',
    desc: 'A brawler who needs no weapon. Fearsome with bare hands, and can shake off wounds with a roar.',
    skills: [
      { id: 'hardened_knuckles', name: 'Hardened knuckles', kind: 'passive',
        desc: 'Bare-handed blows land far harder than anyone else\'s. Stacks with critical hits.' },
      { id: 'battle_cry', name: 'Battle cry', kind: 'active',
        desc: 'Bellow a war cry to recover 30% of your health. Once per battle.' },
    ],
  },
  {
    id: 'noble', name: 'Noble',
    desc: 'A born leader. Spends their own blood to raise the whole party.',
    skills: [
      { id: 'noblesse_oblige', name: 'Noblesse oblige', kind: 'active',
        desc: 'Sacrifice 10% of your health to rally the party: every other member deals 25% more damage on their next turn.' },
    ],
  },
  {
    id: 'bandit', name: 'Bandit',
    desc: 'A nimble opportunist who strikes true when it matters.',
    skills: [
      { id: 'agile_footwork', name: 'Agile footwork', kind: 'active',
        desc: 'Find your footing: your next two attacks are 25% more accurate.' },
    ],
  },
];

const MODEL_COUNT = CLASSES.length;
const CLASS_BY_ID = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
const WIZARD_INDEX = CLASSES.findIndex((c) => c.id === 'wizard');

const EMOTES = ['wave', 'smile', 'shout', 'oops', 'thumbsup'];

/**
 * The identity of each weapon: its id, its name, its glyph and its flavour. The
 * numbers that decide how it fights - hit, damage, crit, the staff's incantation
 * - live in config/game.json (WEAPON_STATS) and are merged in by buildWeapons, so
 * the file is the single source of truth the battle math reads. The browser keeps
 * its own mirror in public/client.js purely so the inventory tooltips can describe
 * a weapon without the server shipping the numbers.
 *
 * A lootable weapon is earned only from a boss fight, never dug out of the dirt;
 * `bare` is never loot, it is simply the empty-hands profile presented as a
 * switchable weapon.
 */
const WEAPON_TEMPLATE = {
  bare: {
    id: 'bare', name: 'Bare-handed', glyph: '👊',
    desc: 'No weapon. Your own two hands are always ready.',
  },
  sword: {
    id: 'sword', name: 'Sword', glyph: '🗡',
    desc: 'Basic and reliable: the most average hit rate, damage and crit chance.',
  },
  rapier: {
    id: 'rapier', name: 'Rapier', glyph: '🤺',
    desc: 'Harder to land a hit, but crits far more often, for double damage.',
  },
  staff: {
    id: 'staff', name: 'Magic Staff', glyph: '🪄',
    // the Wizard's "Magic knowledge" passive: nobody else may pick it up
    wizardOnly: true,
    skill: {
      id: 'incantation', name: 'Incantation',
      desc: 'Spend a turn to incantate: your next strike deals extra base damage, and can crit on top. A lucky crit on the incantation turn fires the spell at once.',
    },
    desc: 'Strikes like a sword, but can incantate for a much stronger blow.',
  },
};

/**
 * Merge the weapon prose above with the numbers from config/game.json.
 *   hit       chance for a strike to land (0..1)
 *   damage    added to BATTLE_BASE_ATTACK
 *   crit      chance for a landed strike to crit
 *   critMult  what a crit multiplies the strike by
 *   skill     optional: the staff's incantation, a charged heavy blow
 */
function buildWeapons(stats) {
  const out = {};
  for (const [id, tpl] of Object.entries(WEAPON_TEMPLATE)) {
    const stat = stats[id];
    const weapon = { ...tpl, hit: stat.hit, damage: stat.damage, crit: stat.crit, critMult: stat.critMult };
    if (tpl.skill) weapon.skill = { ...tpl.skill, mult: stat.skillMult, chargeCrit: stat.chargeCrit };
    out[id] = weapon;
  }
  return out;
}

/** The verbs a battle accepts; everything else is refused while locked in one. */
const BATTLE_VERBS = ['attack', 'defend', 'useBattleItem', 'skill'];

/**
 * Items that may be aimed at another member of the party. The client offers a
 * target cursor for these and ships the chosen member's id as `target`; the
 * rest (dynamite, a trap) always act for the wielder alone.
 */
const ALLY_ITEMS = new Set(['potion']);


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
    /** battleId -> battle. See startBossEncounter / the battle section below. */
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

  // ================= classes =================

  /** The class table, as the browser needs it (id, name, desc, skills). */
  classes() {
    return CLASSES.map((c) => ({ id: c.id, name: c.name, desc: c.desc, skills: c.skills.map((s) => ({ ...s })) }));
  }

  /** The class an account has chosen this run, or undefined if it has not. */
  classOf(code) {
    return this.runClasses.get(code);
  }

  /** Record an account's class for this run. Refuses an unknown index. */
  setClass(code, modelIndex) {
    if (!Number.isInteger(modelIndex) || modelIndex < 0 || modelIndex >= MODEL_COUNT) {
      return { ok: false, error: ERR.INVALID_MODEL };
    }
    this.runClasses.set(code, modelIndex);
    return { ok: true, model: modelIndex };
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
  }

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
    // and no gate wall carries over into a new pit
    this.runClearedWalls.clear();
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

  /** True when a player has opened the mist wall at the depth of a row. */
  hasClearedWall(player, y) {
    return player.wallsCleared.has(this.world.depthOf(y));
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
  }

  /** The emote to show, or null once its duration has run out. */
  liveEmote(player) {
    return player.emote && this.now() < player.emote.until ? player.emote : null;
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
      // locked in a boss fight: drawn frozen so nobody expects them to move
      inBattle: !!player.battleId,
      emote: this.liveEmote(player),
    };
  }

  // ================= actions =================

  /**
   * Entry point for anything a player asks to do.
   * @returns {{ok:boolean, error?:string, ignored?:boolean, delta?:object}}
   */
  action(player, { type, dir, id, item, target }) {
    if (!player) return { ok: false, error: 'not_logged_in' };
    if (type === 'sync') return { ok: true };
    if (!player.alive) return { ok: false, error: ERR.DEAD };
    // Impaled: the spikes have them and the next thing that happens is a death.
    if (player.dyingAt) return { ok: false, error: ERR.DYING };

    // Answering a gate prompt is the one field verb that keeps its pending cell;
    // every other action supersedes it, so a prompt can never be answered for a
    // tile the player has already moved on from.
    if (type !== 'enterGate') player.pendingGate = null;

    // The fight owns a small set of verbs. Everything else is refused while a
    // player is locked in one, so a battle cannot be walked out of by keypress.
    if (BATTLE_VERBS.includes(type)) return this.battleAction(player, type, { id, item, target });
    if (type === 'joinBattle') return this.joinBattle(player, id);
    // A gate fight opens a join window, but the party need not sit through all
    // of it: startBattle begins at once and the window stays open for latecomers.
    if (type === 'startBattle') return this.startBattle(player);
    // The fight is won but nobody is let go until they have seen what they won.
    if (type === 'confirmResult') return this.confirmResult(player);
    if (player.battleId) return { ok: false, error: ERR.IN_BATTLE };

    switch (type) {
      case 'move': return this.requestMove(player, dir);
      case 'enterGate': return this.enterGate(player);
      case 'useDynamite': return this.useDynamite(player);
      case 'usePotion': return this.usePotion(player);
      case 'placeTrap': return this.placeTrap(player);
      case 'emote': return this.doEmote(player, id);
      case 'equipWeapon': return this.equipWeapon(player, id);
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
      // BUGS v0.3.0: you step *into* the trap cell and only then are you stuck.
      // Returning early left the player standing on the previous block, which
      // read as "the trap is not where it is drawn" and put their model one
      // tile away from the one they were snapped to.
      this.removeTrap(trapKey);
      player.x = nx;
      player.y = ny;
      this.noteDepth(player);
      const revealed = this.world.revealAround(player.discovered, nx, ny);
      this.shareIfEnabled(player, revealed);
      player.stuckUntil = this.now() + this.config.STUCK_DURATION_MS;
      this.bump(player);
      const you = this.snapshot(player);
      this.bus.toPlayer(player, 'state', { you, reason: 'trapped' });
      this.bus.broadcast('trapTriggered', { x: nx, y: ny });
      this.bus.toPlayer(player, 'toast', { text: 'A bear trap! Stuck for a minute.', kind: 'bad' });
      return { ok: false, error: ERR.STUCK, delta: { trapped: true, moved: true, revealed, you } };
    }

    const target = this.world.currentBlock(nx, ny);
    if (!target) return { ok: false, error: ERR.WALL };

    if (target.type === BLOCK.AIR) {
      if (this.playerAt(nx, ny)) return { ok: false, error: ERR.OCCUPIED };
      const revealed = this.enterCell(player, nx, ny);
      return { ok: true, delta: { moved: true, revealed, you: this.snapshot(player) } };
    }

    if (target.type === BLOCK.MIST && this.hasClearedWall(player, ny)) {
      // this player has opened the wall at this depth: walk through it like air
      if (this.playerAt(nx, ny)) return { ok: false, error: ERR.OCCUPIED };
      const revealed = this.enterCell(player, nx, ny);
      return { ok: true, delta: { moved: true, revealed, you: this.snapshot(player) } };
    }

    if (target.type === BLOCK.STONE) return { ok: false, error: ERR.STONE };

    if (target.type === BLOCK.SPIKES) {
      if (this.playerAt(nx, ny)) return { ok: false, error: ERR.OCCUPIED };
      // One spike strike takes the same points of damage as an armour pickup is
      // worth, and it is spent against the combined pool: armour first, and only
      // what is left over comes off health. So a fighter with 3 points left and
      // 30 health is left on 25 health, not dead.
      const dmg = this.config.ARMOUR_POINTS_PER_ITEM;
      const absorbed = Math.min(player.inventory.armor, dmg);
      player.inventory.armor -= absorbed;
      player.hp = Math.max(0, player.hp - (dmg - absorbed));
      const revealed = this.enterCell(player, nx, ny);
      if (player.hp > 0) {
        player.runStats.spikesSurvived += 1;
        const through = dmg - absorbed;
        this.bus.toPlayer(player, 'toast', {
          text: through > 0 ? 'The spikes bite through your armour.' : 'Your armour takes the spikes.',
          kind: player.inventory.armor > 0 ? '' : 'bad',
        });
        return { ok: true, delta: { moved: true, revealed, spikesAbsorbed: true, you: this.snapshot(player) } };
      }
      // The strike was enough: step into the spikes and die there. Killing on
      // the spot left the model standing in the cell it came from, so the player
      // was never impaled by the block they walked into - they just vanished
      // next to it. The move succeeds, and the tick finishes the job, so the
      // step-in is something you can watch.
      player.digging = null;
      player.dyingAt = this.now() + this.config.SPIKES_DEATH_DELAY_MS;
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
    this.pickupGround(player, x, y);
    return revealed;
  }

  /** Loot lying on the ground, as a flat list, for snapshots and spectator views. */
  groundLoot() {
    const list = [];
    for (const [k, g] of this.groundItems) {
      const [x, y] = k.split(',').map(Number);
      list.push({ x, y, type: g.type, id: g.id });
    }
    return list;
  }

  /**
   * Loot left on the ground by a defeated boss is collected by stepping onto it.
   * An item is taken and consumed. A weapon the player does not yet own is
   * added to their pack (and equipped if their hands are empty); a weapon they
   * already own is left exactly where it is, so it is never destroyed by being
   * walked over.
   */
  pickupGround(player, x, y) {
    const k = this.world.key(x, y);
    const g = this.groundItems.get(k);
    if (!g) return;
    if (g.type === 'weapon') {
      if (player.inventory.weapons.includes(g.id)) return; // duplicate stays put
      const w = this.weapons[g.id];
      // the Magic Staff is wizard-only: it stays on the ground for a Wizard
      if (w && w.wizardOnly && player.modelIndex !== WIZARD_INDEX) {
        this.bus.toPlayer(player, 'toast', { text: `Only a Wizard can carry the ${w.name}.`, kind: 'bad' });
        return;
      }
      player.inventory.weapons.push(g.id);
      this.groundItems.delete(k);
      this.bump(player);
      this.bus.broadcast('lootTaken', { x, y });
      this.bus.toPlayer(player, 'toast', { text: `Took ${w ? w.name : g.id}.`, kind: 'good' });
      return;
    }
    if (this.grant(player, g.id)) {
      this.groundItems.delete(k);
      this.bus.broadcast('lootTaken', { x, y });
      this.bus.toPlayer(player, 'toast', { text: `Took ${g.id}.`, kind: 'good' });
    }
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

  doEmote(player, id) {
    if (!Array.isArray(EMOTES) || EMOTES.length === 0) return { ok: false, error: ERR.INVALID_EMOTE };
    if (typeof id !== 'string' || !EMOTES.includes(id)) {
      return { ok: false, error: ERR.INVALID_EMOTE };
    }
    const now = this.now();
    if (player.lastEmoteAt && now - player.lastEmoteAt < this.config.EMOTE_COOLDOWN_MS) {
      return { ok: false, error: ERR.EMOTE_COOLDOWN };
    }
    player.lastEmoteAt = now;
    player.emote = { id, until: now + this.config.EMOTE_DURATION_MS };
    this.bump(player);
    return { ok: true, delta: { emote: player.emote } };
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
      if (!target || (target.type !== BLOCK.DIRT && target.type !== BLOCK.BOSS && target.type !== BLOCK.MIST)) {
        // Somebody blew it up or someone else took it.
        this.bump(player);
        this.bus.toPlayer(player, 'digAborted', { x: d.x, y: d.y, reason: 'gone', you: this.snapshot(player) });
        continue;
      }

      // A boss is dug like dirt, but finishing the dig starts a fight rather
      // than clearing the cell. The cell only opens when the boss is beaten.
      if (target.type === BLOCK.BOSS) {
        this.startBossEncounter(player, d.x, d.y);
        continue;
      }

      // Mist is dug like dirt too, but the dig does not clear it: the player
      // stays put and is asked whether to open the gatekeeper fight.
      if (target.type === BLOCK.MIST) {
        this.promptGate(player, d.x, d.y);
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
      // armour is banked as points, not whole pieces: one pickup is worth a
      // fixed number of points of protection
      case 'armor': inv.armor += this.config.ARMOUR_POINTS_PER_ITEM; break;
      case 'dynamite': inv.dynamite += 1; break;
      case 'trap': inv.trap += 1; break;
      case 'potion': inv.potion += 1; break;
      case 'shovel': inv.shovelUntil = this.now() + this.config.SHOVEL_DURATION_MS; break;
      default: return false;
    }
    this.bump(player);
    return true;
  }

  /**
   * Put an owned weapon in your hands. Free to do in the field, but the fight
   * locks your loadout: action() refuses this wholesale while battleId is set.
   * The Magic Staff is wizard-only (its "Magic knowledge" passive), so nobody
   * else may take it in hand even if they somehow own one.
   */
  equipWeapon(player, id) {
    if (player.battleId) return { ok: false, error: ERR.IN_BATTLE };
    if (!player.inventory.weapons.includes(id)) return { ok: false, error: ERR.INVALID_WEAPON };
    const w = this.weapons[id];
    if (w && w.wizardOnly && player.modelIndex !== WIZARD_INDEX) {
      return { ok: false, error: ERR.INVALID_WEAPON };
    }
    player.inventory.weapon = id;
    this.bump(player);
    return { ok: true, delta: { you: this.snapshot(player) } };
  }

  // ================= items =================

  useDynamite(player) {
    if (player.inventory.dynamite <= 0) return { ok: false, error: ERR.NO_DYNAMITE };
    // using an item interrupts whatever you were digging
    this.cancelDig(player, 'dynamite');
    player.inventory.dynamite -= 1;

    // BUGS v0.3.0: the blast covers the cell you are standing on too, not just
    // the eight around it. A player can only stand in a dug cell, so this is
    // what sweeps up a trap under their own boots and what turns the spikes they
    // survived on into open air. neighbours8() is left alone - it is also the
    // shape of other things - and the centre is prepended here.
    const cells = [[player.x, player.y], ...neighbors8(player.x, player.y)];

    const destroyed = [];
    for (const [dx, dy] of cells) {
      // A trap always sits on a cell that is already dug out, because that is
      // the only kind of cell a player can stand in. It has to be swept up
      // before the air check below, or a blast would leave it sitting in the
      // rubble untouched. The owner is told, so their view corrects itself.
      this.removeTrap(this.world.key(dx, dy));

      const b = this.world.currentBlock(dx, dy);
      if (!b || b.type === BLOCK.AIR) continue;
      // A gate wall and a boss are the two things a blast must not open: the
      // wall is the only way down that is supposed to be earned, and killing a
      // boss with dynamite would skip the fight entirely.
      if (b.type === BLOCK.MIST || b.type === BLOCK.BOSS) continue;
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

  /**
   * Drink a healing potion on the field. A potion is the one consumable that can
   * be used out of a fight too, which is what turns the health a player carries
   * into something they can top up between fights rather than only inside one.
   */
  usePotion(player) {
    if (player.inventory.potion <= 0) return { ok: false, error: ERR.NO_ITEM };
    // no point pouring it down a full throat: refuse and keep the potion
    if (player.hp >= player.maxHp) return { ok: false, error: ERR.HP_FULL };
    this.cancelDig(player, 'potion');
    player.inventory.potion -= 1;
    player.hp = Math.min(player.maxHp, player.hp + this.config.ITEM_HEAL);
    this.bump(player);
    return { ok: true, delta: { healed: true, you: this.snapshot(player) } };
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

  // ================= boss battles =================

  /**
   * A completed dig on a boss cell. For a miniboss the fight begins at once and
   * the digger fights alone. Gate walls have no cells of their own any more: a
   * gate fight is opened from enterGate after the mist dig prompts the player.
   *
   * The boss cell is left standing until the fight is won: it is only dug out
   * (and its loot dropped) by winBattle, so nobody can walk past it mid-fight.
   */
  startBossEncounter(player, x, y) {
    const key = this.world.key(x, y);
    const existing = this.battleByCell.get(key);
    if (existing && this.battles.has(existing)) return this.joinBattle(player, existing);
    if (this.defeatedBosses.has(key)) return { ok: false, error: ERR.NOT_DIGGABLE };

    const info = this.world.bossAt(x, y);
    if (!info) return { ok: false, error: ERR.NOT_DIGGABLE };

    const battle = this.openBattle(player, { x, y }, info);
    if (info.kind === 'miniboss') {
      this.beginBattle(battle);
    } else {
      this.broadcastInvite(battle);
      this.syncBattle(battle, 'battleStart');
    }
    return { ok: true, delta: { battle: this.battleView(player) } };
  }

  /**
   * Create a battle over a cell and put the first player in it. Shared by the
   * miniboss dig and the gate prompt so both battles are built exactly alike.
   */
  openBattle(player, cell, info) {
    const key = this.world.key(cell.x, cell.y);
    const battle = {
      id: this.nextBattleId++,
      kind: info.kind,
      cellKey: key,
      cell: { x: cell.x, y: cell.y },
      boss: {
        kind: info.kind, species: info.species, name: info.name, gate: info.gate,
        hp: info.hp, maxHp: info.hp, attack: info.attack,
      },
      phase: 'join',
      initiator: player.id,
      party: [],
      queue: [],
      round: 0,
      // true while the boss is taking its own (timed) turn between rounds
      bossTurn: false,
      joinDeadline: this.now() + (info.kind === 'gate' ? this.config.BOSS_JOIN_WINDOW_MS : 0),
      // flips once the pit has been told the window is shut, so the broadcast
      // goes out exactly once however the fight ends
      joinClosed: false,
      deadline: 0,
      log: [],
      result: null,
      trapArmed: false,
    };
    this.battles.set(battle.id, battle);
    this.battleByCell.set(key, battle.id);
    this.battlePush(battle, `${info.name} blocks the way!`, 'bad');
    this.addToParty(battle, player);
    this.bump(player);
    return battle;
  }

  /**
   * A completed dig on a mist cell. The dig does not clear the wall and the
   * player does not move: the server asks whether they want to open the
   * gatekeeper fight. If a fight is already running on that cell the prompt is a
   * join offer instead, with the boss and the party so far.
   */
  promptGate(player, x, y) {
    const battleId = this.battleByCell.get(this.world.key(x, y));
    const battle = battleId != null ? this.battles.get(battleId) : null;
    player.pendingGate = { x, y };
    this.bump(player);

    if (battle) {
      const open = !battle.joinClosed
        && (battle.phase === 'join'
          || (battle.phase === 'active' && this.now() < battle.joinDeadline));
      const full = battle.party.length >= this.config.BATTLE_PARTY_MAX;
      this.bus.toPlayer(player, 'gatePrompt', {
        mode: 'join',
        x, y,
        canJoin: open && !full,
        battleId: battle.id,
        boss: battle.boss.name,
        party: battle.party.map((m) => m.name),
        partyMax: this.config.BATTLE_PARTY_MAX,
        you: this.snapshot(player),
      });
      return;
    }

    this.bus.toPlayer(player, 'gatePrompt', { mode: 'enter', x, y, you: this.snapshot(player) });
  }

  /**
   * Answer a gate prompt. The pending cell is the tile the player dug into; if a
   * fight is there they join it, otherwise a new gate fight opens and they step
   * onto the wall tile. They are only moved once the fight is theirs, and the
   * field is frozen from that moment, so the wall cannot be walked past by
   * giving up - leaving it only happens by winning or dying.
   */
  enterGate(player) {
    const pg = player.pendingGate;
    player.pendingGate = null;
    if (!pg) return { ok: false, error: ERR.NOT_DIGGABLE };
    const { x, y } = pg;

    // still beside the tile we were prompted about?
    if (Math.abs(player.x - x) + Math.abs(player.y - y) !== 1) {
      return { ok: false, error: ERR.NOT_DIGGABLE };
    }
    const target = this.world.currentBlock(x, y);
    if (!target || target.type !== BLOCK.MIST) return { ok: false, error: ERR.NOT_DIGGABLE };

    const key = this.world.key(x, y);
    const existingId = this.battleByCell.get(key);
    if (existingId != null && this.battles.has(existingId)) return this.joinBattle(player, existingId);
    if (this.playerAt(x, y)) return { ok: false, error: ERR.OCCUPIED };

    const info = this.world.gateInfo(this.world.gateIndexOf(this.world.depthOf(y)));
    const battle = this.openBattle(player, { x, y }, info);
    this.enterCell(player, x, y);
    if (info.kind === 'gate') {
      this.broadcastInvite(battle);
      this.syncBattle(battle, 'battleStart');
    }
    return { ok: true, delta: { battle: this.battleView(player) } };
  }

  /** Tell the pit a gate fight is open and who has joined it so far. */
  broadcastInvite(battle) {
    if (battle.kind !== 'gate') return;
    const initiator = this.playerById(battle.initiator);
    this.bus.broadcast('battleInvite', {
      battleId: battle.id,
      kind: battle.kind,
      boss: battle.boss.name,
      cell: battle.cell,
      endsAt: battle.joinDeadline,
      partyMax: this.config.BATTLE_PARTY_MAX,
      initiator: initiator ? initiator.name : null,
      party: battle.party.map((m) => m.name),
    });
  }

  /** Add a player to a battle's party. The health they carry on the field walks
   *  in with them; their armour is held in escrow for the fight. */
  addToParty(battle, player) {
    const w = this.weapons[player.inventory.weapon];
    const profile = w || this.weapons.bare;
    const cls = CLASSES[player.modelIndex] || CLASSES[0];
    const member = {
      id: player.id,
      name: player.name,
      model: player.modelIndex,
      cls: cls.id,
      hp: player.hp,
      maxHp: player.maxHp,
      attack: this.config.BATTLE_BASE_ATTACK + profile.damage,
      hit: profile.hit,
      crit: profile.crit,
      critMult: profile.critMult,
      weapon: w ? w.id : null,
      skill: w && w.skill ? w.skill.id : null,
      skillMult: w && w.skill ? w.skill.mult : 1,
      chargeCrit: w && w.skill ? w.skill.chargeCrit : 0,
      armour: 0,
      // the escrow this member started the fight with, so the client can draw the
      // armour overlay receding as it is spent
      maxArmour: 0,
      defending: false,
      incantation: false,
      // ---- class skills ----
      // a permanent damage multiplier from a passive (Knight, Barbarian)
      damageMult: this.classDamageMult(cls, w),
      // one-shot rally from a Noble's "Noblesse oblige", consumed on their turn
      rallied: false,
      // remaining attacks with a Bandit's accuracy buff
      aimBuff: 0,
      // per-battle uses left for the actives that are rationed
      usesLeft: cls.id === 'barbarian' ? { battle_cry: 1 } : {},
    };
    // field armour is held in escrow for the fight: it is already points, so it
    // moves across untouched and whatever is left comes straight back when the
    // fight ends
    member.armour = player.inventory.armor;
    member.maxArmour = member.armour;
    player.inventory.armor = 0;
    battle.party.push(member);
    player.battleId = battle.id;
    this.bump(player);
    return member;
  }

  /**
   * The passive damage multiplier a class brings to a fight. Multiplicative and
   * applied before any crit, so a Knight's blade and a Barbarian's bare hands
   * both "stack with crits".
   */
  classDamageMult(cls, w) {
    if (cls.id === 'knight' && w && (w.id === 'sword' || w.id === 'rapier')) {
      return this.config.SKILL_KNIGHT_WEAPON_MULT;
    }
    if (cls.id === 'barbarian' && (!w || w.id === 'bare')) return this.config.SKILL_BARBARIAN_BARE_MULT;
    return 1;
  }

  /** What one member can see on the Skills tab: their class skills, then any
   *  weapon skill. Passives are listed but never usable. */
  memberSkills(member) {
    const out = [];
    const cls = CLASS_BY_ID[member.cls] || CLASSES[0];
    for (const s of cls.skills) {
      if (s.kind === 'passive') {
        out.push({ id: s.id, name: s.name, kind: 'passive', desc: s.desc, usable: false });
      } else {
        const left = member.usesLeft[s.id];
        const usable = left === undefined || left > 0;
        out.push({
          id: s.id, name: s.name, kind: 'active', desc: s.desc,
          usable, note: usable ? '' : 'Spent for this battle.',
        });
      }
    }
    const w = this.weapons[member.weapon];
    if (w && w.skill) {
      out.push({ id: w.skill.id, name: w.skill.name, kind: 'active', desc: w.skill.desc, usable: true, note: '' });
    }
    return out;
  }

  /** Hand back whatever health and armour the member still holds and detach them.
   *  A member who fell has no health to give back, and their kill routes the
   *  player through respawn with a full pool. */
  releaseMember(battle, member) {
    const p = this.playerById(member.id);
    if (p) {
      p.inventory.armor += member.armour;
      p.hp = Math.max(0, member.hp);
      p.battleId = null;
      this.bump(p);
    }
    const i = battle.party.indexOf(member);
    if (i >= 0) battle.party.splice(i, 1);
    const qi = battle.queue.indexOf(member.id);
    if (qi >= 0) battle.queue.splice(qi, 1);
  }

  /** Start the fight and roll the first round. The join window is closed
   *  separately by closeJoinWindow, so an early startBattle does not shut out
   *  allies who may still arrive until the original deadline. */
  beginBattle(battle) {
    if (battle.phase !== 'join') return;
    battle.phase = 'active';
    battle.round = 1;
    battle.bossTurn = false;
    battle.queue = battle.party.map((m) => m.id);
    battle.deadline = this.now() + this.config.BATTLE_TURN_MS;
    this.battlePush(battle, 'The battle begins!', 'good');
    this.syncBattle(battle, 'battleBegin');
  }

  /** The moment the pit is told no more allies may join. */
  closeJoinWindow(battle) {
    if (battle.joinClosed) return;
    battle.joinClosed = true;
    if (battle.kind === 'gate') this.bus.broadcast('battleInviteClosed', { battleId: battle.id });
  }

  /** Only the player who opened the encounter cuts the wait short. */
  startBattle(player) {
    const battle = this.battles.get(player.battleId);
    if (!battle || battle.phase !== 'join') return { ok: false, error: ERR.NO_JOIN };
    if (battle.initiator !== player.id) return { ok: false, error: ERR.NO_JOIN };
    this.beginBattle(battle);
    return { ok: true, delta: { battle: this.battleView(player) } };
  }

  currentMember(battle) {
    if (battle.phase !== 'active') return null;
    const id = battle.queue[0];
    return battle.party.find((m) => m.id === id) || null;
  }

  /** Route a battle verb. The turn is consumed by a successful action. */
  battleAction(player, type, { item, target, id } = {}) {
    const battle = this.battles.get(player.battleId);
    if (!battle) return { ok: false, error: ERR.NOT_IN_BATTLE };
    if (battle.phase !== 'active') return { ok: false, error: ERR.NOT_YOUR_TURN };
    const cur = this.currentMember(battle);
    if (!cur || cur.id !== player.id) return { ok: false, error: ERR.NOT_YOUR_TURN };
    const member = cur;

    const res = this.applyVerb(battle, member, type, { item, target, id });
    if (!res.ok) return res;
    if (res.consumed && battle.phase === 'active') this.advanceTurn(battle);
    return { ok: true, delta: { battle: this.battleView(player) } };
  }

  applyVerb(battle, member, type, { item, target, id }) {
    switch (type) {
      case 'attack':
        this.memberAttack(battle, member, false);
        return { ok: true, consumed: true };
      case 'skill':
        return this.useSkill(battle, member, id, target);
      case 'defend':
        member.defending = true;
        this.battlePush(battle, `${member.name} braces for the next blow.`);
        return { ok: true, consumed: true };
      case 'useBattleItem':
        return this.useBattleItem(battle, member, item, target);
      default:
        return { ok: false, error: ERR.INVALID_BATTLE_ACTION };
    }
  }

  /** One strike. `special` fires the staff's charged blow; an incantation in
   *  progress is spent by it too. */
  memberAttack(battle, member, special) {
    const skill = special || member.incantation;
    member.incantation = false;

    // A Bandit's buff lifts the odds of landing, and is spent on the attack
    // whether it lands or not.
    const aim = member.aimBuff > 0 ? this.config.SKILL_BANDIT_HIT_BONUS : 0;
    if (member.aimBuff > 0) member.aimBuff -= 1;
    const hit = Math.min(0.99, member.hit + aim);

    if (this.random() >= hit) {
      this.battlePush(battle, `${member.name} swings and misses.`);
      return;
    }
    // the passive multiplier, then any one-shot rally from a Noble, both before
    // the crit so they "stack with crits"
    let dmg = member.attack * member.damageMult;
    if (member.rallied) dmg *= this.config.SKILL_NOBLE_BUFF_MULT;
    dmg = Math.round(dmg);
    if (skill) dmg = Math.round(dmg * member.skillMult);
    let crit = false;
    if (this.random() < member.crit) {
      crit = true;
      dmg = Math.round(dmg * member.critMult);
    }
    battle.boss.hp = Math.max(0, battle.boss.hp - dmg);
    const how = skill ? 'spell' : 'blow';
    this.battlePush(
      battle,
      `${member.name}'s ${how}${crit ? ' critically' : ''} hits ${battle.boss.name} for ${dmg}.`,
      'good'
    );
    if (battle.boss.hp <= 0) this.winBattle(battle);
  }

  /**
   * Use a skill by id. Two families live here: the Magic Staff's charged
   * incantation (a weapon skill, wizard-only by virtue of who may hold the
   * staff) and the class actives. A passive has no id that reaches here.
   */
  useSkill(battle, member, skillId, target) {
    if (target != null && !battle.party.some((m) => m.id === Number(target))) {
      return { ok: false, error: ERR.NO_TARGET };
    }
    if (skillId === 'incantation' || (!skillId && member.skill)) {
      return this.useIncantation(battle, member);
    }
    if (member.cls === 'barbarian' && skillId === 'battle_cry') {
      if (!(member.usesLeft.battle_cry > 0)) return { ok: false, error: ERR.NO_SKILL };
      member.usesLeft.battle_cry -= 1;
      const heal = Math.round(member.maxHp * this.config.SKILL_BATTLE_CRY_HEAL);
      member.hp = Math.min(member.maxHp, member.hp + heal);
      this.battlePush(battle, `${member.name} roars a battle cry and recovers ${heal}.`, 'good');
      return { ok: true, consumed: true };
    }
    if (member.cls === 'noble' && skillId === 'noblesse_oblige') {
      const cost = Math.max(1, Math.round(member.maxHp * this.config.SKILL_NOBLE_HP_COST));
      member.hp = Math.max(1, member.hp - cost);
      let raised = 0;
      for (const m of battle.party) {
        if (m.id === member.id) continue;
        m.rallied = true;
        raised += 1;
      }
      this.battlePush(
        battle,
        raised
          ? `${member.name} rallies the party, paying ${cost} health.`
          : `${member.name} has nobody to rally, but pays ${cost} health.`,
        raised ? 'good' : 'bad'
      );
      return { ok: true, consumed: true };
    }
    if (member.cls === 'bandit' && skillId === 'agile_footwork') {
      member.aimBuff = this.config.SKILL_BANDIT_TURNS;
      this.battlePush(battle, `${member.name} finds their footing (+${Math.round(this.config.SKILL_BANDIT_HIT_BONUS * 100)}% aim for ${member.aimBuff} attacks).`, 'good');
      return { ok: true, consumed: true };
    }
    return { ok: false, error: ERR.NO_SKILL };
  }

  /** The staff's charged heavy blow: a turn to speak, a turn to release. */
  useIncantation(battle, member) {
    if (!member.skill) return { ok: false, error: ERR.NO_SKILL };
    if (member.incantation) {
      // already charged: this turn releases the spell
      this.memberAttack(battle, member, true);
      return { ok: true, consumed: true };
    }
    member.incantation = true;
    this.battlePush(battle, `${member.name} begins an incantation...`);
    // A lucky spark can fire the spell the very turn it is spoken, which is the
    // only way the charge does not cost a full turn.
    if (this.random() < member.chargeCrit) {
      this.battlePush(battle, '...and the spell bursts out at once!', 'good');
      this.memberAttack(battle, member, true);
    }
    return { ok: true, consumed: true };
  }

  useBattleItem(battle, member, item, target) {
    const p = this.playerById(member.id);
    if (!p) return { ok: false, error: ERR.NOT_IN_BATTLE };
    // A healing item may be aimed at an ally; the rest act on the wielder. An
    // absent target means the wielder themselves.
    let on = member;
    if (ALLY_ITEMS.has(item)) {
      on = target == null ? member : battle.party.find((m) => m.id === Number(target));
      if (!on) return { ok: false, error: ERR.NO_TARGET };
    }
    switch (item) {
      case 'dynamite':
        if (p.inventory.dynamite <= 0) return { ok: false, error: ERR.NO_DYNAMITE };
        p.inventory.dynamite -= 1;
        battle.boss.hp = Math.max(0, battle.boss.hp - this.config.BATTLE_BOMB_DAMAGE);
        this.battlePush(battle, `${member.name} hurls dynamite for ${this.config.BATTLE_BOMB_DAMAGE}.`, 'good');
        if (battle.boss.hp <= 0) this.winBattle(battle);
        return { ok: true, consumed: true };
      case 'trap':
        if (p.inventory.trap <= 0) return { ok: false, error: ERR.NO_TRAP };
        p.inventory.trap -= 1;
        battle.trapArmed = true;
        this.battlePush(battle, `${member.name} arms a trap for the boss.`);
        return { ok: true, consumed: true };
      case 'potion':
        if (p.inventory.potion <= 0) return { ok: false, error: ERR.NO_ITEM };
        // No point pouring it down a full member's throat: refuse and keep the
        // turn and the potion.
        if (on.hp >= on.maxHp) return { ok: false, error: ERR.HP_FULL };
        p.inventory.potion -= 1;
        on.hp = Math.min(on.maxHp, on.hp + this.config.ITEM_HEAL);
        this.battlePush(
          battle,
          on === member
            ? `${member.name} drinks a potion and recovers.`
            : `${member.name} heals ${on.name}.`,
          'good'
        );
        return { ok: true, consumed: true };
      default:
        return { ok: false, error: ERR.INVALID_BATTLE_ACTION };
    }
  }

  /** Pass the turn on. When the round is spent the boss gets a turn of its own. */
  advanceTurn(battle) {
    if (battle.phase !== 'active') return;
    const leaving = battle.party.find((m) => m.id === battle.queue[0]);
    battle.queue.shift();
    // A Noble's rally covers exactly one turn of the member it raised: it is
    // gone once that member's turn is spent, whether or not they attacked.
    if (leaving) leaving.rallied = false;
    if (battle.queue.length === 0) {
      this.startBossTurn(battle);
      return;
    }
    battle.deadline = this.now() + this.config.BATTLE_TURN_MS;
    this.syncBattle(battle, 'battleTurn');
  }

  /**
   * The party's round is spent. The boss does not swing yet: it takes a turn of
   * its own for BATTLE_BOSS_TURN_MS, so everyone can see whose turn it is before
   * the blow lands.
   */
  startBossTurn(battle) {
    battle.bossTurn = true;
    battle.deadline = this.now() + this.config.BATTLE_BOSS_TURN_MS;
    this.syncBattle(battle, 'bossTurn');
  }

  /** The boss's timed turn has come: it acts, then a new party round begins. */
  resolveBossTurn(battle) {
    if (battle.phase !== 'active' || !battle.bossTurn) return;
    battle.bossTurn = false;
    this.bossTurn(battle);
    if (battle.phase !== 'active') return; // win or loss already broadcast
    this.refillRound(battle);
    battle.deadline = this.now() + this.config.BATTLE_TURN_MS;
    this.syncBattle(battle, 'battleTurn');
  }

  refillRound(battle) {
    battle.round += 1;
    for (const m of battle.party) m.defending = false;
    battle.queue = battle.party.map((m) => m.id);
  }

  bossTurn(battle) {
    if (!battle.party.length) { this.loseBattle(battle); return; }
    // A member falling inside the boss's turn calls back into leaveBattle, which
    // must not then run another boss turn underneath this one.
    battle.resolving = true;
    try {
      this.bossTurnBody(battle);
    } finally {
      battle.resolving = false;
    }
  }

  bossTurnBody(battle) {
    // A planted trap gets its chance at the top of the boss's turn, before it
    // swings. It only deals damage; the boss still acts whether or not it fires.
    if (battle.trapArmed) {
      battle.trapArmed = false;
      if (this.random() < this.config.BATTLE_TRAP_TRIGGER_CHANCE) {
        battle.boss.hp = Math.max(0, battle.boss.hp - this.config.BATTLE_TRAP_DAMAGE);
        this.battlePush(battle, `The trap snaps shut on ${battle.boss.name} for ${this.config.BATTLE_TRAP_DAMAGE}.`, 'good');
        if (battle.boss.hp <= 0) { this.winBattle(battle); return; }
      } else {
        this.battlePush(battle, 'The trap is dodged.');
      }
    }
    const target = battle.party[Math.floor(this.random() * battle.party.length)];
    let dmg = battle.boss.attack;
    if (target.defending) dmg = Math.max(1, Math.round(dmg * this.config.BATTLE_DEFEND_MULT));
    const absorbed = Math.min(target.armour, dmg);
    target.armour -= absorbed;
    const through = dmg - absorbed;
    target.hp -= through;
    this.battlePush(
      battle,
      `${battle.boss.name} strikes ${target.name} for ${through}${absorbed ? ` (${absorbed} soaked)` : ''}.`,
      'bad'
    );
    if (target.hp <= 0) this.memberFalls(battle, target);
  }

  /** A party member's HP reached zero: they die, respawn and leave the fight. */
  memberFalls(battle, member) {
    const p = this.playerById(member.id);
    this.battlePush(battle, `${member.name} falls to ${battle.boss.name}.`, 'bad');
    if (p) this.kill(p, 'boss'); // kill() routes through leaveBattle
    else this.leaveBattle({ battleId: battle.id, id: member.id });
  }

  /** Leave a fight for any reason (death, disconnect, cancellation). */
  leaveBattle(player, _reason) {
    const id = player && player.battleId;
    if (!id) return;
    const battle = this.battles.get(id);
    if (!battle) { if (player) player.battleId = null; return; }
    const member = battle.party.find((m) => m.id === player.id);
    if (member) {
      this.battlePush(battle, `${member.name} leaves the fight.`);
      this.releaseMember(battle, member);
    }
    if (battle.phase === 'join') {
      if (!battle.party.length) this.cancelBattle(battle);
      else this.syncBattle(battle, 'battleLeave');
      return;
    }
    // A win is waiting on confirmations; someone who leaves now (a disconnect)
    // simply forfeits theirs, and the last one out takes the battle with them.
    if (battle.phase === 'result') {
      if (!battle.party.length) this.forgetBattle(battle);
      else this.syncBattle(battle, 'battleLeave');
      return;
    }
    if (battle.phase !== 'active') return;
    if (!battle.party.length) { this.loseBattle(battle); return; }
    // if the round now has nobody left to act, the boss takes its turn - but
    // never underneath a boss turn that is already running
    if (!battle.resolving && !battle.bossTurn && battle.queue.length === 0 && battle.party.length) {
      this.startBossTurn(battle);
      return;
    }
    this.syncBattle(battle, 'battleLeave');
  }

  joinBattle(player, battleId) {
    const n = Number(battleId);
    const battle = Number.isFinite(n) ? this.battles.get(n) : null;
    if (player.battleId) return { ok: true, delta: { battle: this.battleView(player) } };
    // A gate fight may already be under way and still be taking allies: the
    // window, not the first blow, is what shuts the door.
    const open = battle
      && !battle.joinClosed
      && (battle.phase === 'join'
        || (battle.phase === 'active' && this.now() < battle.joinDeadline));
    if (!open) return { ok: false, error: ERR.NO_JOIN };
    if (battle.party.some((m) => m.id === player.id)) return { ok: true };
    if (battle.party.length >= this.config.BATTLE_PARTY_MAX) return { ok: false, error: ERR.BATTLE_FULL };
    this.addToParty(battle, player);
    // A latecomer joins at the back of the round; during the boss's own turn
    // the queue is rebuilt from the party when it ends, so there is nothing to
    // append to yet.
    if (battle.phase === 'active' && !battle.bossTurn) battle.queue.push(player.id);
    this.battlePush(battle, `${player.name} joins the fight.`, 'good');
    // refresh the pit's invite with the grown party list
    this.broadcastInvite(battle);
    this.syncBattle(battle, 'battleJoin');
    return { ok: true, delta: { battle: this.battleView(player) } };
  }

  winBattle(battle) {
    if (battle.phase === 'over' || battle.phase === 'result') return;
    battle.phase = 'result';
    battle.result = 'win';
    battle.deadline = 0;
    this.closeJoinWindow(battle);

    const { x, y } = battle.cell;
    const survivors = battle.party.slice();

    if (battle.kind === 'gate') {
      // The mist is never dug out globally: a win marks the whole depth open for
      // each member's account, so the row reads as a tunnel only for them. The
      // cell keeps its battle mapping until the battle is gone, so a player who
      // digs it meanwhile is offered the (now closed) fight, not an occupied
      // tile.
      const depth = this.world.depthOf(y);
      for (const m of survivors) {
        const p = this.playerById(m.id);
        if (p) this.markWallCleared(p, depth);
      }
    } else {
      this.world.digOut(x, y);
      this.pendingBlocks.push({ x, y });
      this.defeatedBosses.add(battle.cellKey);
      this.battleByCell.delete(battle.cellKey);
    }

    battle.loot = this.rollLoot(battle, survivors);
    const payout = this.buildPayout(battle, survivors);
    battle.payout = payout;
    for (const m of survivors) {
      const p = this.playerById(m.id);
      if (p) this.applyPayout(p, payout);
    }
    this.battlePush(battle, `${battle.boss.name} is defeated!`, 'good');
    // Hold here: the party stays frozen on the result screen until each player
    // confirms their winnings. confirmResult is what detaches them.
    this.syncBattle(battle, 'battleWin');
    this.dropGroundLoot(battle.cell, payout.ground);
    this.bus.broadcast('bossDefeated', { x, y, name: battle.boss.name, kind: battle.kind });
  }

  /** Open the mist wall at a depth for one player's whole run. */
  markWallCleared(player, depth) {
    player.wallsCleared.add(depth);
    this.runClearedWalls.set(player.code, player.wallsCleared);
    this.bump(player);
  }

  /** Drop a finished battle and free the cell it was fought over. */
  forgetBattle(battle) {
    this.battles.delete(battle.id);
    this.battleByCell.delete(battle.cellKey);
  }

  /** A player has read the loot screen; hand them back to the field. */
  confirmResult(player) {
    const battle = this.battles.get(player.battleId);
    if (!battle || battle.phase !== 'result') return { ok: false, error: ERR.NOT_IN_BATTLE };
    const member = battle.party.find((m) => m.id === player.id);
    if (!member) return { ok: false, error: ERR.NOT_IN_BATTLE };
    const gained = this.gainedFor(battle, player.id);
    this.releaseMember(battle, member);
    if (!battle.party.length) this.forgetBattle(battle);
    this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: 'battleEnd' });
    this.bus.toPlayer(player, 'battleResult', { result: 'win', boss: battle.boss.name, gained });
    return { ok: true, delta: { battle: null } };
  }

  loseBattle(battle) {
    if (battle.phase === 'over') return;
    battle.phase = 'over';
    battle.result = 'lose';
    battle.deadline = 0;
    this.closeJoinWindow(battle);
    battle.boss.hp = battle.boss.maxHp; // the boss is fresh for the next attempt
    this.battleByCell.delete(battle.cellKey);
    this.battlePush(battle, `The party is beaten. ${battle.boss.name} endures.`, 'bad');
    this.syncBattle(battle, 'battleLose');
    this.finishBattle(battle, { result: 'lose', boss: battle.boss.name });
  }

  cancelBattle(battle) {
    if (battle.phase === 'over') return;
    battle.phase = 'over';
    battle.result = 'cancelled';
    this.closeJoinWindow(battle);
    this.battleByCell.delete(battle.cellKey);
    this.syncBattle(battle, 'battleCancel');
    this.finishBattle(battle, { result: 'cancelled', boss: battle.boss.name });
  }

  /** Detach everyone, tell them how it ended, and forget the battle. */
  finishBattle(battle, result) {
    const members = battle.party.slice();
    battle.party = [];
    battle.queue = [];
    this.forgetBattle(battle);
    for (const m of members) {
      const p = this.playerById(m.id);
      if (!p) continue;
      // a fight that ends without a wipe gives back the health and armour still
      // held, the same settlement a player who leaves mid-fight gets
      p.inventory.armor += m.armour;
      p.hp = Math.max(0, m.hp);
      p.battleId = null;
      this.bump(p);
      // a final private snapshot clears the battle view and unfreezes the field,
      // and battleResult carries the outcome so the client can announce it after
      // the overlay has gone
      this.bus.toPlayer(p, 'state', { you: this.snapshot(p), reason: 'battleEnd' });
      if (result) this.bus.toPlayer(p, 'battleResult', result);
    }
  }

  /** Leave the win's leftovers on the ground around the boss cell. */
  dropGroundLoot(cell, ground) {
    if (!ground || !ground.length) return;
    const spots = [[cell.x, cell.y], ...neighbors8(cell.x, cell.y)];
    let i = 0;
    for (const g of ground) {
      while (i < spots.length) {
        const [x, y] = spots[i++];
        const b = this.world.currentBlock(x, y);
        if (!b || b.type !== BLOCK.AIR) continue;
        if (this.groundItems.has(this.world.key(x, y))) continue;
        this.groundItems.set(this.world.key(x, y), g);
        this.bus.broadcast('lootDropped', { x, y, ...g });
        break;
      }
    }
  }

  /** Roll the loot table for a defeated boss. Weapons go to one survivor;
   *  consumables are pooled so they can be split evenly. */
  rollLoot(battle, survivors) {
    const weapons = [];
    if (survivors.length) {
      const w = pickWeighted(this.config.WEAPON_WEIGHTS, this.random());
      // bare hands are not loot; a misconfigured table cannot hand them out
      if (w && w !== 'bare') weapons.push(w);
    }
    const pools = battle.kind === 'gate' ? 3 : 1;
    const items = {};
    for (let i = 0; i < pools; i++) {
      const it = pickWeighted(this.config.BOSS_ITEM_WEIGHTS, this.random());
      if (it) items[it] = (items[it] || 0) + 1;
    }
    return { weapons, items };
  }

  /**
   * Work out who gets what. Consumables are divided equally between the members
   * still in the fight, with the remainder going to the initiator. The single
   * weapon goes, in join order, to the first survivor who does not already own
   * it; if everybody owns it, it is dropped on the boss cell instead.
   */
  buildPayout(battle, survivors) {
    const order = survivors.slice().sort((a, b) => {
      if (a.id === battle.initiator) return -1;
      if (b.id === battle.initiator) return 1;
      return battle.party.indexOf(a) - battle.party.indexOf(b);
    });
    const payout = { weapons: {}, items: {}, ground: [] };

    for (const id of battle.loot.weapons) {
      const w = this.weapons[id];
      const taker = order.find((m) => {
        const p = this.playerById(m.id);
        if (!p || p.inventory.weapons.includes(id)) return false;
        // a wizard-only weapon only ever goes to the class that can use it;
        // otherwise it is left on the ground for one to find
        if (w && w.wizardOnly && p.modelIndex !== WIZARD_INDEX) return false;
        return true;
      });
      if (taker) {
        payout.weapons[taker.id] = id;
      } else {
        payout.ground.push({ type: 'weapon', id });
      }
    }

    const n = survivors.length || 1;
    for (const [item, count] of Object.entries(battle.loot.items)) {
      let remaining = count;
      for (let i = 0; i < order.length && remaining > 0; i++) {
        const share = Math.floor(count / n) + (i === 0 ? count % n : 0);
        if (share <= 0) continue;
        payout.items[order[i].id] = { ...(payout.items[order[i].id] || {}), [item]: share };
        remaining -= share;
      }
      // nobody left to take the last of it: drop it on the ground too
      if (remaining > 0) payout.ground.push({ type: 'item', id: item });
    }
    return payout;
  }

  /** What one member took from a won fight, for the loot window. */
  gainedFor(battle, playerId) {
    const payout = battle.payout || { weapons: {}, items: {} };
    return {
      weapon: payout.weapons[playerId] || null,
      items: { ...(payout.items[playerId] || {}) },
    };
  }

  applyPayout(player, payout) {
    const w = payout.weapons[player.id];
    if (w) {
      player.inventory.weapons.push(w);
      // do not auto-equip new weapons
    }
    const items = payout.items[player.id] || {};
    for (const [id, count] of Object.entries(items)) {
      for (let i = 0; i < count; i++) this.grant(player, id);
    }
    this.bump(player);
  }

  /** Called every tick: open windows, run out turn timers. */
  resolveBattles(now = this.now()) {
    for (const battle of [...this.battles.values()]) {
      if (battle.phase === 'join') {
        if (now >= battle.joinDeadline) {
          this.beginBattle(battle);
          this.closeJoinWindow(battle);
        }
        continue;
      }
      if (battle.phase !== 'active') continue;
      // the fight may have started early, so the window can lapse mid-battle
      if (!battle.joinClosed && now >= battle.joinDeadline) this.closeJoinWindow(battle);
      if (battle.bossTurn) {
        if (now >= battle.deadline) this.resolveBossTurn(battle);
        continue;
      }
      if (now >= battle.deadline) {
        const member = this.currentMember(battle);
        if (member) {
          this.battlePush(battle, `${member.name} hesitates.`, 'bad');
          this.memberAttack(battle, member, false);
        }
        if (battle.phase === 'active') this.advanceTurn(battle);
      }
    }
  }

  /** The private view of an in-progress fight for one player. */
  battleView(player) {
    if (!player || !player.battleId) return null;
    const battle = this.battles.get(player.battleId);
    if (!battle) return null;
    const bossTurn = !!battle.bossTurn;
    const cur = battle.phase === 'active' && !battle.bossTurn ? battle.queue[0] : null;
    const me = battle.party.find((m) => m.id === player.id) || null;
    return {
      id: battle.id,
      kind: battle.kind,
      phase: battle.phase,
      // who opened the encounter: only they may cut the join window short
      initiator: battle.initiator,
      boss: {
        name: battle.boss.name, kind: battle.boss.kind, species: battle.boss.species,
        gate: battle.boss.gate,
        hp: battle.boss.hp, maxHp: battle.boss.maxHp, attack: battle.boss.attack,
      },
      cell: battle.cell,
      round: battle.round,
      // 'boss' while the boss takes its own turn, a party id otherwise (or null
      // during the join window)
      turn: battle.bossTurn ? 'boss' : cur,
      bossTurn: battle.bossTurn,
      // the rest of the round's order, the current actor first. `turn` names the
      // current actor; this is the queue behind them, so `[turn, ...queue]` is
      // the order still to come this round.
      queue: battle.queue.slice(),
      isMyTurn: !battle.bossTurn && cur === player.id,
      turnDelayMs: bossTurn ? this.config.BATTLE_BOSS_TURN_MS : this.config.BATTLE_TURN_MS,
      deadline: battle.deadline,
      joinDeadline: battle.joinDeadline,
      partyMax: this.config.BATTLE_PARTY_MAX,
      party: battle.party.map((m) => ({
        id: m.id, name: m.name, model: m.model, hp: m.hp, maxHp: m.maxHp,
        armour: m.armour, maxArmour: m.maxArmour,
        defending: m.defending, incantation: m.incantation, weapon: m.weapon,
      })),
      me: me ? {
        id: me.id, model: me.model,
        hp: me.hp, maxHp: me.maxHp, armour: me.armour, maxArmour: me.maxArmour,
        defending: me.defending,
        incantation: me.incantation,
        weapon: me.weapon,
        // the class and weapon skills this member can see on the Skills tab,
        // passives included so their descriptions are readable
        skills: this.memberSkills(me),
        // what is left in the bag, so the battle item menu can count each one
        dynamite: player.inventory.dynamite,
        trap: player.inventory.trap,
        potion: player.inventory.potion,
        // on a win still waiting to be confirmed, what this member walked away
        // with, so the loot window can list it
        gained: battle.phase === 'result' ? this.gainedFor(battle, player.id) : null,
      } : null,
      log: battle.log,
      trapArmed: battle.trapArmed,
      result: battle.result,
      loot: battle.result === 'win' ? battle.loot : null,
    };
  }

  battlePush(battle, text, kind = '') {
    battle.log.push({ text, kind });
    const max = this.config.BATTLE_LOG_MAX;
    if (battle.log.length > max) battle.log.splice(0, battle.log.length - max);
  }

  /** Push the current battle view to every member (and their frozen snapshot). */
  syncBattle(battle, reason) {
    for (const m of battle.party) {
      const p = this.playerById(m.id);
      if (p) this.syncBattleTo(p, reason);
    }
  }

  syncBattleTo(player, reason) {
    this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: reason || 'battle' });
  }

  // ================= death and respawn =================

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

}

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

module.exports = { Game, DIRS, ERR, MODEL_COUNT, CLASSES, EMOTES, blankInventory };
