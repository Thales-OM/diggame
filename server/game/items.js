'use strict';

// ---------- Items ----------
// The things a player can hold: armour, dynamite, traps, potions and weapons.

const { BLOCK, neighbors8 } = require('../world');
const { ERR } = require('../content/constants');
const { WIZARD_INDEX } = require('../content/classes');

module.exports = {
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
  },
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
  },
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
  },
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
  },
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
};
