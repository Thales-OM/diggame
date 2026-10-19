'use strict';

// ---------- Field ----------
// The field verbs: movement, digs, traps, emotes and their derived state.

const { BLOCK, pickWeighted } = require('../world');
const { DIRS, ERR, BATTLE_VERBS } = require('../content/constants');
const { WIZARD_INDEX } = require('../content/classes');
const { EMOTES } = require('../content/emotes');

module.exports = {
  isStuck(player) { return this.now() < player.stuckUntil; },
  isDying(player) { return !!player.dyingAt && this.now() >= player.dyingAt; },
  hasShovel(player) { return this.now() < player.inventory.shovelUntil; },
  digDuration(player) {
    return this.hasShovel(player) ? this.config.SHOVEL_DIG_TIME_MS : this.config.DIG_TIME_MS;
  },
  /** True when a player has opened the mist wall at the depth of a row. */
  hasClearedWall(player, y) {
    return player.wallsCleared.has(this.world.depthOf(y));
  },
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
  },
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
  },
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
  },
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
  },
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
  },
  /** Loot lying on the ground, as a flat list, for snapshots and spectator views. */
  groundLoot() {
    const list = [];
    for (const [k, g] of this.groundItems) {
      const [x, y] = k.split(',').map(Number);
      list.push({ x, y, type: g.type, id: g.id });
    }
    return list;
  },
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
  },
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
  },
  cancelDig(player, reason = 'cancelled') {
    if (!player.digging) return false;
    player.digging = null;
    this.bump(player);
    return reason;
  },
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
  },
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
  },
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
};
