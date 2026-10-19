'use strict';

// ---------- Diggame ----------
// Entry point: configuration -> storage -> world -> game -> sockets.
//
// The pieces live apart now: context.js holds the shared state, runtime.js the
// boot/tick/reset policy, sockets.js the wire and admin.js the reset route. This
// file just wires them together and owns the process lifecycle.
//
// Failure policy (SPEC): storage problems are critical. On boot a bad database
// stops the server; during play any storage error freezes the world, tells every
// connected client the game is halted, and then exits non-zero. There is no
// in-memory fallback and no silent recreate, because a game that quietly
// forgets a player's stats is worse than one that is visibly down.

const express = require('express');
const http = require('http');
const path = require('path');
const compression = require('compression');
const { Server } = require('socket.io');

const { loadConfig, clientConfig, ConfigError } = require('./server/config');
const { StorageError } = require('./server/db');
const { World } = require('./server/world');
const { Game } = require('./server/game');
const ctx = require('./server/context');
const runtime = require('./server/runtime');
const { registerSockets } = require('./server/sockets');
const { registerAdmin } = require('./server/admin');

// ---------- configuration ----------
try {
  const { config, warnings } = loadConfig();
  ctx.config = config;
  for (const w of warnings) console.warn(`[config] ${w}`);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[fatal] configuration is unusable: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

ctx.CLIENT_CONFIG = clientConfig(ctx.config);

// ---------- application ----------
ctx.app = express();
ctx.server = http.createServer(ctx.app);
ctx.io = new Server(ctx.server, { serveClient: true });

// compress every response (the client is a few modules plus a stylesheet), and
// let the browser cache them for an hour between reloads
ctx.app.use(compression());
ctx.app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

registerSockets();
registerAdmin();

// ---------- boot ----------
function boot() {
  ctx.store = runtime.openStore();
  const seed = World.randomSeed(ctx.config);
  ctx.world = new World(ctx.config, seed);
  ctx.game = new Game({ config: ctx.config, world: ctx.world, bus: runtime.bus });

  // openStore() aborted anything a previous process left active, so a boot
  // always starts a new run. With WORLD_SEED pinned it is the same layout
  // again, but the old attempt is not resurrected.
  const worldRow = ctx.store.openWorld(seed, ctx.world.width, JSON.stringify(ctx.CLIENT_CONFIG));
  console.log(`[boot] world #${worldRow.id} (seed ${seed}), width ${ctx.world.width}`);

  ctx.tickTimer = setInterval(runtime.runTick, Math.round(1000 / ctx.config.TICK_HZ));
  ctx.statsTimer = setInterval(runtime.flushStats, ctx.config.STATS_FLUSH_MS);

  const port = ctx.config.PORT;
  ctx.server.listen(port, ctx.config.HOST, () => {
    console.log(`Diggame listening on http://localhost:${port}`);
    console.log(`[boot] reset with: npm run reset${ctx.config.RESET_SECRET ? ' (or POST /api/reset)' : ''}`);
  });
}

// ---------- crash and shutdown ----------
// Installed before the game starts, so a failure during boot is handled the same
// way as a failure during play.
process.on('uncaughtException', (err) => {
  runtime.fatal(new Error(`uncaught exception: ${err.message}`));
});
process.on('unhandledRejection', (reason) => {
  runtime.fatal(new Error(`unhandled rejection: ${reason && reason.message ? reason.message : reason}`));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\nshutting down (${signal})`);
  if (ctx.tickTimer) clearInterval(ctx.tickTimer);
  if (ctx.statsTimer) clearInterval(ctx.statsTimer);
  // close the run properly, so the next boot reports a finished game and its
  // standings rather than an aborted one
  try { if (ctx.store) { runtime.endCurrentRun(); ctx.store.close(); } } catch (err) { console.error(err.message); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (process.argv.includes('--reset')) {
  // One-shot admin command: close the current run, open a fresh world, print
  // the final standings, exit. Needs no secret and no running server.
  try {
    const s = runtime.openStore({ abortStale: false });
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
    const seed = World.randomSeed(ctx.config);
    const row = s.openWorld(seed, ctx.config.WORLD_WIDTH, JSON.stringify(ctx.CLIENT_CONFIG));
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
