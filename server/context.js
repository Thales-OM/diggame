'use strict';

// ---------- Context ----------
// The shared, mutable state of a running server. It used to be a stack of
// module-level `let`s in server.js; handing it around as one object is what lets
// the socket wiring, the admin route and the run lifecycle live in their own
// files without importing each other in a circle.
//
// Everything here is written once, at boot, except the flags the tick flips.

module.exports = {
  /** frozen CONFIG and the browser-facing subset of it */
  config: null,
  CLIENT_CONFIG: null,
  /** the build identity, shown in the client's corner and logged at boot */
  version: 'unknown',

  /** the http/socket layer */
  app: null,
  server: null,
  io: null,

  /** storage and the live world */
  store: null,
  world: null,
  game: null,

  /** true once the server has hit a fatal error and is winding down */
  halted: false,

  /** socketId -> playerId, so the bus can route targeted events */
  socketPlayers: new Map(),
  /** sockets that are watching the field instead of playing it */
  spectatorSockets: new Set(),

  /** the two timers, cleared on shutdown and on a fatal error */
  tickTimer: null,
  statsTimer: null,
  /** how many ticks have run, so the spectator frame can run on a slower clock */
  tickCount: 0,
};
