'use strict';

// ---------- Runtime ----------
// The things the server does to the world once, or on a timer: opening storage,
// flushing stats, ending and starting runs, the spectator filter, the tick, and
// the fatal-error policy. None of it touches a socket handler directly; the
// shared state lives in context.js.

const ctx = require('./context');
const { resolveDbPath } = require('./config');
const { openDatabase } = require('./db');
const { World } = require('./world');
const protocol = require('./protocol');

// ---------- fatal ----------
//
// Failure policy (SPEC): storage problems are critical. On boot a bad database
// stops the server; during play any storage error freezes the world, tells every
// connected client the game is halted, and then exits non-zero. There is no
// in-memory fallback and no silent recreate, because a game that quietly
// forgets a player's stats is worse than one that is visibly down.
function fatal(reason) {
  if (ctx.halted) return;
  ctx.halted = true;
  console.error(`\n[fatal] ${reason && reason.stack ? reason.stack : reason}`);
  console.error('[fatal] the game is halted; players have been notified.');

  if (ctx.tickTimer) clearInterval(ctx.tickTimer);
  if (ctx.statsTimer) clearInterval(ctx.statsTimer);
  ctx.tickTimer = ctx.statsTimer = null;

  try {
    ctx.io.emit('halted', { message: 'The game has been halted by a server error. Your account code is safe.' });
  } catch { /* the socket layer may be gone too */ }

  const delay = ctx.config.HALT_EXIT_DELAY_MS;
  setTimeout(() => process.exit(1), delay).unref();
}

// ---------- storage ----------
/**
 * @param {object}  [opts]
 * @param {boolean} [opts.abortStale=true]
 *   A world left 'active' belongs to a process that died. The run itself is
 *   ephemeral, so we only record that it never finished. The reset command
 *   turns this off: it is here to close that world properly, standings and all,
 *   not to write it off.
 */
function openStore({ abortStale = true } = {}) {
  const file = resolveDbPath(ctx.config);
  const s = openDatabase(file, { onFatal: fatal });
  if (abortStale) {
    const aborted = s.abortStaleWorlds();
    if (aborted) console.log(`[db] marked ${aborted} unfinished world(s) as aborted`);
  }
  return s;
}

// ---------- statistics flushing ----------
/**
 * Persist every stat delta that has accumulated since the last flush. Counters
 * are relative, so this is safe to run on a timer; max depth is absolute and
 * the storage layer keeps the highest value ever seen.
 */
function flushStats() {
  if (!ctx.store || ctx.halted) return;
  const world = ctx.store.currentWorld();
  if (!world) return;
  for (const { code, delta } of ctx.game.takeStatDeltas()) {
    ctx.store.upsertRunStats(world.id, code, delta);
    ctx.store.addStats(code, delta);
  }
}

// ---------- reset ----------
function endCurrentRun() {
  if (!ctx.store) return null;
  const current = ctx.store.currentWorld();
  if (!current) return null;

  // Take the final deltas for the run, including players who are already
  // disconnected: game.runTotals is keyed by account code, not by socket.
  for (const { code, delta } of ctx.game.finishRunTotals()) {
    if (!ctx.store.getAccount(code)) continue;
    ctx.store.upsertRunStats(current.id, code, delta);
    ctx.store.addStats(code, delta);
  }
  // a run counts once per player, whether or not they scored in it
  for (const code of ctx.game.runTotals.keys()) {
    if (ctx.store.getAccount(code)) ctx.store.addStats(code, { runsPlayed: 1 });
  }

  ctx.store.finaliseRunStats(current.id);
  ctx.store.endWorld(current.id, 'ended');
  const standings = ctx.store.standings(current.id);
  console.log(`[run] world #${current.id} (seed ${current.seed}) closed. Top: ${
    standings.slice(0, 3).map((s) => `${s.code}:${s.maxDepth}`).join(', ') || 'nobody'}`);
  return current;
}

function resetGame() {
  const finished = endCurrentRun();

  // A class is chosen per run, so the new run takes everyone back to the picker.
  // Capture who is present (and which socket owns them) before the reset wipes
  // the pit, then detach them: they are pending until they choose again.
  const present = [];
  for (const p of [...ctx.game.players.values()]) {
    present.push({ socketId: ctx.socketPlayers.get(p.id) || null, code: p.code });
    ctx.socketPlayers.delete(p.id);
    ctx.game.removePlayer(p);
  }

  const seed = World.randomSeed(ctx.config);
  ctx.game.newRun(seed);

  let worldRow = null;
  if (ctx.store) {
    worldRow = ctx.store.openWorld(seed, ctx.world.width, JSON.stringify(ctx.CLIENT_CONFIG));
  }
  console.log(`[run] new world #${worldRow ? worldRow.id : '-'} (seed ${seed})`);

  for (const { socketId, code } of present) {
    const sock = socketId ? ctx.io.sockets.sockets.get(socketId) : null;
    if (!sock) continue;
    sock.data.playerId = null;
    sock.data.pendingClass = { code };
    sock.emit('worldReset', {
      needsClass: true,
      seed,
      classes: ctx.game.classes(),
    });
  }
  return { finished, worldRow };
}

// ---------- tick ----------
const SPECTATOR_MODES = ['public', 'player', 'admin'];

/** The filter options for one socket, rebuilt from what it is allowed to have. */
function specOptions(socket) {
  return {
    mode: socket.data.specMode,
    player: playerFor(socket),
    adminAll: socket.data.specAdminAll !== false,
    depthMargin: socket.data.specDepthMargin,
    maxMargin: ctx.config.ADMIN_VIEW_MARGIN,
  };
}

/**
 * One tick: advance the world, broadcast what everyone may see, and - for the
 * sockets that asked for it - push a spectator frame on its own slower clock.
 */
function runTick() {
  if (ctx.halted) return;
  const frame = ctx.game.tick();
  ctx.io.emit('tick', protocol.tickPayload(frame));

  ctx.tickCount++;
  const every = Math.max(1, Math.round(ctx.config.TICK_HZ / ctx.config.SPECTATOR_HZ));
  if (ctx.tickCount % every !== 0) return;
  for (const socket of ctx.spectatorSockets) {
    socket.emit('spectatorFrame', protocol.spectatorFrame(ctx.game, socket.data.specCache, specOptions(socket)));
  }
}

function playerFor(socket) {
  const id = socket.data && socket.data.playerId;
  return id ? ctx.game.players.get(id) || null : null;
}

// ---------- the bus ----------
// Game never talks to a socket; it emits through this. `toPlayer` needs the
// socket lookup, `broadcast` is everyone.
const bus = {
  toPlayer(player, event, payload) {
    const sid = ctx.socketPlayers.get(player.id);
    if (sid) ctx.io.to(sid).emit(event, payload);
  },
  broadcast(event, payload) {
    ctx.io.emit(event, payload);
  },
};

// ---------- account codes ----------
function genCode() {
  // unambiguous alphabet: no O/0, no I/1
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

module.exports = {
  fatal,
  openStore,
  flushStats,
  endCurrentRun,
  resetGame,
  runTick,
  playerFor,
  specOptions,
  genCode,
  bus,
  SPECTATOR_MODES,
};
