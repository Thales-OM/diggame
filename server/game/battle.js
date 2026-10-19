'use strict';

// ---------- Battle ----------
// Boss and gatekeeper fights: the party, the turn engine, skills, loot and
// the private battle view the client renders.

const { BLOCK, neighbors8, pickWeighted } = require('../world');
const { ERR, ALLY_ITEMS } = require('../content/constants');
const { CLASSES, CLASS_BY_ID, WIZARD_INDEX } = require('../content/classes');

module.exports = {
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
  /** The moment the pit is told no more allies may join. */
  closeJoinWindow(battle) {
    if (battle.joinClosed) return;
    battle.joinClosed = true;
    if (battle.kind === 'gate') this.bus.broadcast('battleInviteClosed', { battleId: battle.id });
  },
  /** Only the player who opened the encounter cuts the wait short. */
  startBattle(player) {
    const battle = this.battles.get(player.battleId);
    if (!battle || battle.phase !== 'join') return { ok: false, error: ERR.NO_JOIN };
    if (battle.initiator !== player.id) return { ok: false, error: ERR.NO_JOIN };
    this.beginBattle(battle);
    return { ok: true, delta: { battle: this.battleView(player) } };
  },
  currentMember(battle) {
    if (battle.phase !== 'active') return null;
    const id = battle.queue[0];
    return battle.party.find((m) => m.id === id) || null;
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
  /**
   * The party's round is spent. The boss does not swing yet: it takes a turn of
   * its own for BATTLE_BOSS_TURN_MS, so everyone can see whose turn it is before
   * the blow lands.
   */
  startBossTurn(battle) {
    battle.bossTurn = true;
    battle.deadline = this.now() + this.config.BATTLE_BOSS_TURN_MS;
    this.syncBattle(battle, 'bossTurn');
  },
  /** The boss's timed turn has come: it acts, then a new party round begins. */
  resolveBossTurn(battle) {
    if (battle.phase !== 'active' || !battle.bossTurn) return;
    battle.bossTurn = false;
    this.bossTurn(battle);
    if (battle.phase !== 'active') return; // win or loss already broadcast
    this.refillRound(battle);
    battle.deadline = this.now() + this.config.BATTLE_TURN_MS;
    this.syncBattle(battle, 'battleTurn');
  },
  refillRound(battle) {
    battle.round += 1;
    for (const m of battle.party) m.defending = false;
    battle.queue = battle.party.map((m) => m.id);
  },
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
  },
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
  },
  /** A party member's HP reached zero: they die, respawn and leave the fight. */
  memberFalls(battle, member) {
    const p = this.playerById(member.id);
    this.battlePush(battle, `${member.name} falls to ${battle.boss.name}.`, 'bad');
    if (p) this.kill(p, 'boss'); // kill() routes through leaveBattle
    else this.leaveBattle({ battleId: battle.id, id: member.id });
  },
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
  },
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
  },
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
  },
  /** Open the mist wall at a depth for one player's whole run. */
  markWallCleared(player, depth) {
    player.wallsCleared.add(depth);
    this.runClearedWalls.set(player.code, player.wallsCleared);
    this.bump(player);
  },
  /** Drop a finished battle and free the cell it was fought over. */
  forgetBattle(battle) {
    this.battles.delete(battle.id);
    this.battleByCell.delete(battle.cellKey);
  },
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
  },
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
  },
  cancelBattle(battle) {
    if (battle.phase === 'over') return;
    battle.phase = 'over';
    battle.result = 'cancelled';
    this.closeJoinWindow(battle);
    this.battleByCell.delete(battle.cellKey);
    this.syncBattle(battle, 'battleCancel');
    this.finishBattle(battle, { result: 'cancelled', boss: battle.boss.name });
  },
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
  },
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
  },
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
  },
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
  },
  /** What one member took from a won fight, for the loot window. */
  gainedFor(battle, playerId) {
    const payout = battle.payout || { weapons: {}, items: {} };
    return {
      weapon: payout.weapons[playerId] || null,
      items: { ...(payout.items[playerId] || {}) },
    };
  },
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
  },
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
  },
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
  },
  battlePush(battle, text, kind = '') {
    battle.log.push({ text, kind });
    const max = this.config.BATTLE_LOG_MAX;
    if (battle.log.length > max) battle.log.splice(0, battle.log.length - max);
  },
  /** Push the current battle view to every member (and their frozen snapshot). */
  syncBattle(battle, reason) {
    for (const m of battle.party) {
      const p = this.playerById(m.id);
      if (p) this.syncBattleTo(p, reason);
    }
  },
  syncBattleTo(player, reason) {
    this.bus.toPlayer(player, 'state', { you: this.snapshot(player), reason: reason || 'battle' });
  }
};
