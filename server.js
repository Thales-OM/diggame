'use strict';

// ---------- Diggame ----------
// Entry point: configuration -> storage -> world -> game -> sockets.
//
// Failure policy (SPEC): storage problems are critical. On boot a bad database
// stops the server; during play any storage error freezes the world, tells every
// connected client the game is halted, and then exits non-zero. There is no
// in-memory fallback and no silent recreate, because a game that quietly
// forgets a player's stats is worse than one that is visibly down.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { loadConfig, clientConfig, resolveDbPath, ConfigError } = require('./server/config');
const { openDatabase, StorageError } = require('./server/db');
const { World } = require('./server/world');
const { Game } = require('./server/game');
const protocol = require('./server/protocol');

// ---------- configuration ----------
let config;
let configWarnings = [];
try {
  ({ config, warnings: configWarnings } = loadConfig());
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[fatal] configuration is unusable: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
for (const w of configWarnings) console.warn(`[config] ${w}`);

const CLIENT_CONFIG = clientConfig(config);

// ---------- application ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });

app.use(express.static(path.join(__dirname, 'public')));

let halted = false;
let haltReason = null;

/** socketId -> playerId, so the bus can route targeted events. */
const socketPlayers = new Map();

let store;
let world;
let game;
let tickTimer = null;
let statsTimer = null;

function fatal(reason) {
  if (halted) return;
  halted = true;
  haltReason = reason;
  console.error(`\n[fatal] ${reason && reason.stack ? reason.stack : reason}`);
  console.error('[fatal] the game is halted; players have been notified.');

  if (tickTimer) clearInterval(tickTimer);
  if (statsTimer) clearInterval(statsTimer);
  tickTimer = statsTimer = null;

  try {
    io.emit('halted', { message: 'The game has been halted by a server error. Your account code is safe.' });
  } catch { /* the socket layer may be gone too */ }

  const delay = config.HALT_EXIT_DELAY_MS;
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
  const file = resolveDbPath(config);
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
  if (!store || halted) return;
  const world = store.currentWorld();
  if (!world) return;
  for (const { code, delta } of game.takeStatDeltas()) {
    store.upsertRunStats(world.id, code, delta);
    store.addStats(code, delta);
  }
}

// ---------- reset ----------
function endCurrentRun() {
  if (!store) return null;
  const current = store.currentWorld();
  if (!current) return null;

  // Take the final deltas for the run, including players who are already
  // disconnected: game.runTotals is keyed by account code, not by socket.
  for (const { code, delta } of game.finishRunTotals()) {
    if (!store.getAccount(code)) continue;
    store.upsertRunStats(current.id, code, delta);
    store.addStats(code, delta);
  }
  // a run counts once per player, whether or not they scored in it
  for (const code of game.runTotals.keys()) {
    if (store.getAccount(code)) store.addStats(code, { runsPlayed: 1 });
  }

  store.finaliseRunStats(current.id);
  store.endWorld(current.id, 'ended');
  const standings = store.standings(current.id);
  console.log(`[run] world #${current.id} (seed ${current.seed}) closed. Top: ${
    standings.slice(0, 3).map((s) => `${s.code}:${s.maxDepth}`).join(', ') || 'nobody'}`);
  return current;
}

function resetGame() {
  const finished = endCurrentRun();

  const seed = World.randomSeed(config);
  game.newRun(seed);

  let worldRow = null;
  if (store) {
    worldRow = store.openWorld(seed, world.width, JSON.stringify(CLIENT_CONFIG));
  }
  console.log(`[run] new world #${worldRow ? worldRow.id : '-'} (seed ${seed})`);

  for (const p of game.players.values()) {
    io.to(socketPlayers.get(p.id) || '').emit('worldReset', {
      you: game.snapshot(p),
      rev: p.rev,
      seed,
      state: protocol.fullState(game, p, CLIENT_CONFIG),
    });
  }
  return { finished, worldRow };
}

// ---------- tick ----------
let tickCount = 0;

/** Sockets that are watching the field instead of playing it. */
const spectatorSockets = new Set();

const SPECTATOR_MODES = ['public', 'player', 'admin'];

/** The filter options for one socket, rebuilt from what it is allowed to have. */
function specOptions(socket) {
  return {
    mode: socket.data.specMode,
    player: playerFor(socket),
    adminAll: socket.data.specAdminAll !== false,
    depthMargin: socket.data.specDepthMargin,
    maxMargin: config.ADMIN_VIEW_MARGIN,
  };
}

/**
 * One tick: advance the world, broadcast what everyone may see, and - for the
 * sockets that asked for it - push a spectator frame on its own slower clock.
 */
function runTick() {
  if (halted) return;
  const frame = game.tick();
  io.emit('tick', protocol.tickPayload(frame));

  tickCount++;
  const every = Math.max(1, Math.round(config.TICK_HZ / config.SPECTATOR_HZ));
  if (tickCount % every !== 0) return;
  for (const socket of spectatorSockets) {
    socket.emit('spectatorFrame', protocol.spectatorFrame(game, socket.data.specCache, specOptions(socket)));
  }
}

// ---------- sockets ----------
const bus = {
  toPlayer(player, event, payload) {
    const sid = socketPlayers.get(player.id);
    if (sid) io.to(sid).emit(event, payload);
  },
  broadcast(event, payload) {
    io.emit(event, payload);
  },
};

io.on('connection', (socket) => {
  if (halted) {
    socket.emit('halted', { message: 'The game is halted by a server error. Please try again later.' });
    socket.disconnect(true);
    return;
  }

  socket.data.playerId = null;
  socket.data.spectating = false;
  socket.data.specMode = 'public';
  socket.data.specAdminAll = true;
  socket.data.specDepthMargin = config.ADMIN_VIEW_MARGIN;
  socket.data.specCache = new Map();

  socket.on('login', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (halted) return reply({ error: 'The game is halted by a server error.' });

    // logging in twice on one socket must not leave an orphan behind
    const previous = playerFor(socket);
    if (previous) {
      flushStats();
      socketPlayers.delete(previous.id);
      game.removePlayer(previous);
      socket.data.playerId = null;
    }

    const name = String((data && data.name) || '').trim().slice(0, config.MAX_NAME_LENGTH);
    let code = String((data && data.code) || '').trim().toUpperCase();
    let modelIndex = (data && Number.isInteger(data.modelIndex)) ? data.modelIndex : 0;

    let account = code ? store.getAccount(code) : null;
    const isNew = !account;
    if (account) {
      // a returning player may rename themselves; their stats and code stay put
      if (name) store.upsertAccount(code, name, modelIndex);
      else modelIndex = account.modelIndex;
      code = account.code;
    } else {
      if (!name) return reply({ error: 'Enter a name, or the code from a previous game.' });
      do { code = genCode(); } while (store.getAccount(code));
      store.upsertAccount(code, name, modelIndex);
    }

    // one live session per account: a second login kicks the first one out
    for (const p of [...game.players.values()]) {
      if (p.code !== code) continue;
      const oldSid = socketPlayers.get(p.id);
      if (oldSid) {
        io.to(oldSid).emit('kicked', { reason: 'You logged in from somewhere else.' });
        socketPlayers.delete(p.id);
      }
      game.removePlayer(p);
    }

    const stats = store.getStats(code);
    const player = game.addPlayer({ code, name: name || (account && account.name), modelIndex, stats });
    if (!player) return reply({ error: 'The pit is full, try again in a moment.' });

    socket.data.playerId = player.id;
    socketPlayers.set(player.id, socket.id);
    store.touchAccount(code);

    reply({
      ok: true,
      code,
      name: player.name,
      model: player.modelIndex,
      state: protocol.fullState(game, player, CLIENT_CONFIG),
      stats,
      // an account that has never had the Rules dialog is a new player, even
      // if it is on its second visit: they are shown the rules once
      rulesSeen: !isNew && !!account.rulesSeen,
    });
  });

  socket.on('action', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (halted) return reply({ error: 'halted' });
    const player = playerFor(socket);
    if (!player) return reply({ error: 'not_logged_in' });

    // SPEC: incremental updates with verification. A stale rev means the client
    // missed something, so hand back the whole state instead of a delta that
    // would be applied to the wrong baseline.
    if (data && data.type === 'sync') {
      return reply({ needSync: true, rev: player.rev, state: protocol.fullState(game, player, CLIENT_CONFIG) });
    }
    if (!data || typeof data.rev !== 'number' || data.rev !== player.rev) {
      return reply({
        needSync: true,
        rev: player.rev,
        state: protocol.fullState(game, player, CLIENT_CONFIG),
      });
    }

    const result = game.action(player, { type: data.type, dir: data.dir });
    reply(protocol.ackFor(game, player, result, CLIENT_CONFIG));
  });

  socket.on('setModel', (modelIndex, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const player = playerFor(socket);
    if (!player) return reply({ error: 'not_logged_in' });
    const result = game.setModel(player, modelIndex);
    // only write when it actually changed, so a re-sent setModel is not a write
    if (result.ok && result.changed) store.setModel(player.code, player.modelIndex);
    reply(result);
  });

  // The client has no reason to wait for an answer, so it may send this with no
  // arguments at all - in which case socket.io hands the callback through as the
  // first parameter instead of the second.
  socket.on('rulesSeen', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : (typeof data === 'function' ? data : () => {});
    const player = playerFor(socket);
    // Only a real account can have read them, and only once, so the "has this
    // player seen the rules" question has exactly one answer.
    reply({ ok: !!player, marked: player ? store.markRulesSeen(player.code) : false });
  });

  /**
   * Enter (or re-enter) spectator mode. Asking again is how an admin changes
   * the options without dropping the socket, so the whole request is re-checked
   * here rather than only on the first call.
   */
  socket.on('spectate', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const req = data && typeof data === 'object' ? data : {};
    const player = playerFor(socket);

    // No mode asked for: a logged in socket watches its own discoveries, an
    // anonymous one watches the public view. That is the least it can see.
    let mode = SPECTATOR_MODES.includes(req.mode) ? req.mode : (player ? 'player' : 'public');

    if (mode === 'admin') {
      if (!config.ADMIN_SECRET) return reply({ error: 'admin_view_disabled' });
      if (String(req.secret || '') !== config.ADMIN_SECRET) return reply({ error: 'bad_admin_secret' });
    } else if (mode === 'player' && !player) {
      mode = 'public';
    }

    const adminAll = req.adminAll === undefined ? true : !!req.adminAll;
    const depthMargin = protocol.clampMargin(req.depthMargin, config.ADMIN_VIEW_MARGIN);

    // Anything that changes what the next frame contains invalidates the diff
    // cache, or the first frame of the new view would arrive empty.
    const changed = socket.data.specMode !== mode
      || socket.data.specAdminAll !== adminAll
      || socket.data.specDepthMargin !== depthMargin
      || !socket.data.spectating;
    if (changed) socket.data.specCache = new Map();

    socket.data.specMode = mode;
    socket.data.specAdminAll = adminAll;
    socket.data.specDepthMargin = depthMargin;
    socket.data.spectating = true;
    spectatorSockets.add(socket);

    reply({ ok: true, mode, depthMargin: socket.data.specDepthMargin });
    // the first frame is the whole visible world; later ones are only the diffs
    socket.emit('spectatorMode', protocol.spectatorFrame(game, socket.data.specCache, specOptions(socket)));
  });

  socket.on('unspectate', () => {
    socket.data.spectating = false;
    spectatorSockets.delete(socket);
  });

  socket.on('disconnect', () => {
    spectatorSockets.delete(socket);
    const player = playerFor(socket);
    if (!player) return;
    // flush before the player object goes away; the pending deltas are keyed by
    // account code, so nothing is lost either way
    flushStats();
    socketPlayers.delete(player.id);
    game.removePlayer(player);
  });
});

function playerFor(socket) {
  const id = socket.data && socket.data.playerId;
  return id ? game.players.get(id) || null : null;
}

// ---------- admin ----------
if (config.RESET_SECRET) {
  app.post('/api/reset', (req, res) => {
    if (req.query.secret !== config.RESET_SECRET) {
      res.status(403).json({ error: 'Invalid secret' });
      return;
    }
    const { finished } = resetGame();
    res.json({ ok: true, message: 'New game started', previousWorld: finished ? finished.id : null });
  });
}

// ---------- boot ----------
function boot() {
  store = openStore();
  const seed = World.randomSeed(config);
  world = new World(config, seed);
  game = new Game({ config, world, bus });

  // openStore() aborted anything a previous process left active, so a boot
  // always starts a new run. With WORLD_SEED pinned it is the same layout
  // again, but the old attempt is not resurrected.
  const worldRow = store.openWorld(seed, world.width, JSON.stringify(CLIENT_CONFIG));
  console.log(`[boot] world #${worldRow.id} (seed ${seed}), width ${world.width}`);

  tickTimer = setInterval(runTick, Math.round(1000 / config.TICK_HZ));
  statsTimer = setInterval(flushStats, config.STATS_FLUSH_MS);

  const port = config.PORT;
  server.listen(port, config.HOST, () => {
    console.log(`Diggame listening on http://localhost:${port}`);
    console.log(`[boot] reset with: npm run reset${config.RESET_SECRET ? ' (or POST /api/reset)' : ''}`);
  });
}

function genCode() {
  // unambiguous alphabet: no O/0, no I/1
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ---------- crash and shutdown ----------
// Installed before the game starts, so a failure during boot is handled the same
// way as a failure during play.
process.on('uncaughtException', (err) => {
  fatal(new Error(`uncaught exception: ${err.message}`));
});
process.on('unhandledRejection', (reason) => {
  fatal(new Error(`unhandled rejection: ${reason && reason.message ? reason.message : reason}`));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\nshutting down (${signal})`);
  if (tickTimer) clearInterval(tickTimer);
  if (statsTimer) clearInterval(statsTimer);
  // close the run properly, so the next boot reports a finished game and its
  // standings rather than an aborted one
  try { if (store) { endCurrentRun(); store.close(); } } catch (err) { console.error(err.message); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (process.argv.includes('--reset')) {
  // One-shot admin command: close the current run, open a fresh world, print
  // the final standings, exit. Needs no secret and no running server.
  try {
    const s = openStore({ abortStale: false });
    const current = s.currentWorld();
    if (!current) {
      console.log('[reset] no active world, nothing to close');
    } else {
      s.endWorld(current.id, 'ended');
      s.finaliseRunStats(current.id);
      const standings = s.standings(current.id);
      console.log(`[reset] closed world #${current.id} (seed ${current.seed})`);
      if (!standings.length) console.log('[reset] nobody scored');
      for (const row of standings) {
        console.log(`  ${row.code.padEnd(10)} depth ${String(row.maxDepth).padStart(4)}  dug ${row.blocksDug}  deaths ${row.deaths}  items ${row.itemsCollected}`);
      }
    }
    const seed = World.randomSeed(config);
    const row = s.openWorld(seed, config.WORLD_WIDTH, JSON.stringify(CLIENT_CONFIG));
    console.log(`[reset] opened world #${row.id} (seed ${seed})`);
    s.close();
  } catch (err) {
    console.error(`[reset] failed: ${err instanceof StorageError ? err.message : err.stack || err}`);
    process.exit(1);
  }
} else {
  try {
    boot();
  } catch (err) {
    if (err instanceof StorageError) {
      console.error(`[fatal] storage is unusable: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
