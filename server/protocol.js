'use strict';

// ---------- Protocol ----------
// SPEC: "player state updates are incremental ... let the client send a hash of
// its current state and a desired action, if the server approves and sends a
// result the client makes a small update, if hashes are out of sync the server
// demands full sync and broadcasts".
//
// The draft hashed the entire discovered-block set with md5 on every action,
// which is O(world) per keypress and, worse, mismatched constantly: every dig
// that finished, death, respawn and expiry changed the server state underneath
// the client, so the next keypress got a full sync and the display lurched.
//
// This implementation keeps the same contract but swaps the hash for a
// per-player revision counter:
//   - rev is bumped every time the server changes anything about that player
//   - the client echoes rev with every action and stores the newest one it sees
//   - a mismatch means the client missed an event, so the server replies
//     { needSync: true, state } and the client takes the whole state again
// O(1) to produce and check, and a mismatch is a real signal instead of a
// routine event.

/**
 * Everything the client needs to draw its own view: the world width, the
 * surface row, and every block this player has ever discovered, with real
 * contents. Sent at login and on any full sync.
 */
function fullState(game, player, clientCfg) {
  const blocks = [];
  for (const k of player.discovered) {
    const [x, y] = k.split(',').map(Number);
    const b = game.world.currentBlock(x, y);
    if (!b) continue;
    blocks.push({ x, y, type: b.type, item: b.item });
  }
  return {
    you: game.snapshot(player),
    rev: player.rev,
    world: {
      width: game.world.width,
      surfaceY: game.world.surfaceY,
      seed: game.world.seed,
    },
    config: clientCfg || null,
    blocks,
    players: [...game.players.values()].map((p) => game.publicPlayer(p)),
  };
}

/** Result of a successful or failed action, as the ack the client receives. */
function ackFor(game, player, result, clientCfg) {
  if (result.needSync) {
    return { needSync: true, rev: player.rev, state: fullState(game, player, clientCfg) };
  }
  if (!result.ok) {
    return {
      ok: false,
      rev: player.rev,
      error: result.error,
      // errors still resync the player, otherwise a rejected move leaves the
      // client holding a position the server has already moved on from
      you: game.snapshot(player),
      delta: result.delta || null,
    };
  }
  return {
    ok: true,
    rev: player.rev,
    you: result.delta && result.delta.you ? result.delta.you : game.snapshot(player),
    delta: result.delta || null,
  };
}

/** The public half of a tick. Never carries anything private. */
function tickPayload(frame) {
  return {
    players: frame.players,
    digs: frame.digs,
    // coordinates only: a client that never discovered a cell simply ignores it,
    // so digging does not leak the contents of blocks in someone else's tunnel
    blocks: frame.blocks.map((b) => ({ x: b.x, y: b.y })),
    effects: frame.effects,
  };
}

/**
 * Spectator views, in increasing order of how much they are allowed to see.
 *
 * The old implementation had exactly one of these: every block anybody had
 * discovered, every dug cell, and every trap, sent to any socket that asked.
 * That is a cheat tool, because a bear trap is supposed to be secret (SPEC) and
 * an undiscovered block is supposed to be unknown. Filtering happens *here*, on
 * the server, so a client cannot ask for a wider view than it earned.
 *
 *   'public' - no account. Player names, positions and stats plus the starting
 *              ground. Nothing below the surface, and never a trap.
 *   'player' - a logged in account. Everything public, plus the cells that
 *              account has discovered and the traps it set itself. Other
 *              players' traps stay hidden.
 *   'admin'  - the ADMIN_SECRET. Sees the whole field, generated and
 *              undiscovered blocks and their fixed loot included, plus every
 *              trap. Can be narrowed to the aggregate of what everybody has
 *              discovered, and the bottom row is the deepest cell dug so far
 *              plus `depthMargin`.
 *
 * `cache` is a per-socket Map the function keeps up to date, so each frame
 * carries only the cells that actually changed. That keeps a 50-wide,
 * ever-deeper world from re-sending the whole map several times a second. A
 * caller that changes mode or options must hand over a fresh Map, or the first
 * frame of the new view would come out empty because the old one already
 * fingerprinted those cells.
 */
function spectatorFrame(game, cache, opts = {}) {
  const world = game.world;
  const mode = opts.mode === 'player' || opts.mode === 'admin' ? opts.mode : 'public';
  const player = mode === 'player' ? opts.player : null;
  if (mode === 'player' && !player) {
    // a mode was asked for that this socket has not earned; fall back rather
    // than fall open
    return spectatorFrame(game, cache, { ...opts, mode: 'public' });
  }

  /** the cells this view is allowed to describe, in any order */
  let seen;
  /** how far down the view reaches; the camera is clamped to it */
  let bottomY = world.surfaceY;

  if (mode === 'admin' && opts.adminAll) {
    // The whole field, down to the deepest cell anybody has dug plus the
    // margin. currentBlock() gives the generated block for a cell that is
    // still there - loot included - and the dug-out air cell for one that is
    // not, so this is a view of the world as it is, not as it was found. A dug
    // cell never shows the loot that was in it, exactly as it never does for
    // the player who took it: taken is taken, for every view.
    const margin = clampMargin(opts.depthMargin, opts.maxMargin);
    bottomY = world.topY + game.globalMaxDepth + margin;
    seen = new Set();
    for (let x = 0; x < world.width; x++) {
      for (let y = world.surfaceY; y <= bottomY; y++) seen.add(world.key(x, y));
    }
  } else {
    // public: the starting ground only. player: that plus their own map.
    // admin with the aggregate toggle on: the union of what everybody found.
    seen = new Set();
    for (let x = 0; x < world.width; x++) seen.add(world.key(x, world.surfaceY));
    if (mode === 'player') {
      for (const k of player.discovered) seen.add(k);
    } else if (mode === 'admin') {
      for (const p of game.players.values()) {
        for (const k of p.discovered) seen.add(k);
      }
      for (const k of world.dug) seen.add(k);
    }
    for (const k of seen) {
      const y = Number(k.slice(k.indexOf(',') + 1));
      if (y > bottomY) bottomY = y;
    }
  }

  const blocks = [];
  for (const k of seen) {
    const [x, y] = k.split(',').map(Number);
    const b = world.currentBlock(x, y);
    if (!b) continue;
    const fingerprint = `${b.type}:${b.item || ''}`;
    if (cache.get(k) === fingerprint) continue;
    blocks.push({ x, y, type: b.type, item: b.item });
  }

  // refresh the cache: drop cells nobody knows about any more, update the rest
  for (const k of cache.keys()) {
    if (!seen.has(k)) cache.delete(k);
  }
  for (const k of seen) {
    const b = world.currentBlock(...k.split(',').map(Number));
    if (b) cache.set(k, `${b.type}:${b.item || ''}`);
  }

  // The camera follows the action even when the action is in a part of the
  // field this view may not describe: knowing that somebody is digging at row
  // 40 is public, it is what is *in* row 40 that is not.
  for (const p of game.players.values()) if (p.y > bottomY) bottomY = p.y;
  for (const p of game.players.values()) {
    if (p.digging && p.digging.y > bottomY) bottomY = p.digging.y;
  }

  // Traps: secret by default. A player sees only their own, the public view
  // sees none, and the admin view sees all of them.
  let traps = [];
  if (mode === 'admin') {
    traps = [...game.traps.values()].map((t) => ({ x: t.x, y: t.y, ownerId: t.ownerId }));
  } else if (mode === 'player') {
    traps = game.trapsOf(player);
  }

  return {
    mode,
    blocks,
    players: [...game.players.values()].map((p) => game.publicPlayer(p)),
    stats: [...game.players.values()].map((p) => spectatorStats(game, p)),
    digs: [...game.players.values()].filter((p) => p.digging).map((p) => ({
      id: p.id,
      x: p.digging.x,
      y: p.digging.y,
      progress: Math.max(0, Math.min(1, (game.now() - p.digging.startedAt) / p.digging.duration)),
    })),
    traps,
    width: world.width,
    surfaceY: world.surfaceY,
    maxY: bottomY,
  };
}

/**
 * What a spectator is allowed to know about a player: how deep they are and
 * what they are carrying. No code, no model index, no account of their own -
 * a spectator gets the scoreboard, not the login.
 */
function spectatorStats(game, p) {
  return {
    id: p.id,
    name: p.name,
    depth: game.world.depthOf(p.y),
    maxDepth: p.maxDepth,
    armor: p.inventory.armor,
    dynamite: p.inventory.dynamite,
    trap: p.inventory.trap,
    // When the golden shovel runs out, the same field name the private
    // snapshot uses, so a spectator countdown is read off the server's clock
    // rather than a second, differently-named one.
    shovelUntil: p.inventory.shovelUntil,
  };
}

/** How deep below the deepest dig the admin view goes unless told otherwise. */
const DEFAULT_DEPTH_MARGIN = 30;

/**
 * A depth margin is a non-negative whole number of blocks. Anything else - a
 * negative number, a string, NaN, a missing value - falls back to the server's
 * configured default, so a hostile or careless request cannot ask for a view
 * that is arbitrarily deep or arbitrarily shallow.
 */
function clampMargin(value, fallback) {
  const f = Number(fallback);
  const base = Number.isFinite(f) && f >= 0 ? Math.floor(f) : DEFAULT_DEPTH_MARGIN;
  // Checked before coercing: Number(null), Number('') and Number(false) are all
  // 0, so asking "is this a number?" afterwards would let an absent value look
  // like a deliberate request for a zero-deep view.
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return base;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return base;
  return Math.min(500, Math.floor(n));
}

module.exports = {
  fullState, ackFor, tickPayload, spectatorFrame, clampMargin, DEFAULT_DEPTH_MARGIN,
};
