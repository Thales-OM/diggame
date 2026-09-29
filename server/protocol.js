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
 * Spectator view: every block anyone has discovered, plus every dug cell, plus
 * where the traps are. Only sent to sockets that asked for it.
 *
 * `cache` is a per-socket Map that the function keeps up to date, so each frame
 * carries only the cells that actually changed. That keeps a 50-wide,
 * ever-deeper world from re-sending the whole map several times a second.
 */
function spectatorFrame(game, cache) {
  const seen = new Set();
  for (const p of game.players.values()) {
    for (const k of p.discovered) seen.add(k);
  }
  for (const k of game.world.dug) seen.add(k);

  const blocks = [];
  for (const k of seen) {
    const [x, y] = k.split(',').map(Number);
    const b = game.world.currentBlock(x, y);
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
    const b = game.world.currentBlock(...k.split(',').map(Number));
    if (b) cache.set(k, `${b.type}:${b.item || ''}`);
  }

  return {
    blocks,
    players: [...game.players.values()].map((p) => game.publicPlayer(p)),
    digs: [...game.players.values()].filter((p) => p.digging).map((p) => ({
      id: p.id,
      x: p.digging.x,
      y: p.digging.y,
      progress: Math.max(0, Math.min(1, (game.now() - p.digging.startedAt) / p.digging.duration)),
    })),
    // SPEC: traps are invisible to other players; a spectator is an observer
    traps: [...game.traps.values()].map((t) => ({ x: t.x, y: t.y, ownerId: t.ownerId })),
    width: game.world.width,
    surfaceY: game.world.surfaceY,
  };
}

module.exports = { fullState, ackFor, tickPayload, spectatorFrame };
