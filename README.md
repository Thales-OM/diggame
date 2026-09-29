# Diggame

A multiplayer incremental dig game. Everyone shares one procedurally generated
column of dirt, stone and spikes, digs as deep as they dare, and competes to be
the first to the bottom.

## Requirements

- **Node 22.21 or newer.** The server uses the built-in `node:sqlite`, so there
  is no database to install and no build step.
- Dependencies: `express` and `socket.io` at runtime, `socket.io-client` for
  the end-to-end tests.

## Running

```sh
npm install
npm start          # http://localhost:3000
```

Settings come from the environment, or from an optional `.env` file you can copy
from `.env.example`. A real environment variable always wins over the file, and
a missing `.env` is not an error.

```sh
cp .env.example .env
```

| variable | default | what it does |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | where to listen |
| `DB_PATH` | `./data/diggame.db` | SQLite file; its directory is created for you |
| `WORLD_SEED` | random | pin the world seed to replay a layout |
| `RESET_SECRET` | empty | enables `POST /api/reset?secret=…` when set |

## Starting a new game

A run (a "world") is temporary: new seed, new pit, everybody back on the surface.
Accounts, lifetime stats and the history of finished runs are kept.

```sh
npm run reset                      # local, no secret needed
```

With `RESET_SECRET` set you can also reset a running server over HTTP:

```sh
curl -X POST "http://localhost:3000/api/reset?secret=$RESET_SECRET"
```

The endpoint does not exist unless `RESET_SECRET` is configured.

## Tests

```sh
npm test
```

Everything runs on the built-in test runner, with no network and no database
server:

| suite | covers |
| --- | --- |
| `server/config.test.js` | defaults, `.env` parsing, coercion, validation |
| `server/db.test.js` | schema, migrations, repositories, fatal errors |
| `server/world.test.js` | generation determinism, discovery, depth |
| `server/game.test.js` | every rule: movement, digs, traps, dynamite, spikes, death, stats |
| `server/protocol.test.js` | revisions, acks, full state, spectator frames |
| `server/client.test.js` | the browser client, run against a stubbed DOM |
| `server/e2e.test.js` | the real server driven with real sockets |

## Playing

Log in with a name and you get an account code back. Keep it: that code brings
your stats and the ground you have uncovered back to you next time, so you pick
up digging exactly where the map left off (in a new free column, not in the
hole you were last in).

Bear traps are yours alone. Nobody else, playing, can see where you set them; a
spectator can. If somebody else springs one, or dynamite sweeps it away, you
find out straight away rather than next time you move.

Press **Spectate** to watch the field instead of digging. The camera follows
the action until you press WASD or the arrow keys, and the **Follow** button
hands it back.

## Layout

```
server.js              boot, sockets, ticking, stat flushing, reset, fatal halt
server/config.js       defaults, parsing, validation, client-safe config
server/db.js           schema, migrations, SQL
server/world.js        generation, dug state, discovery
server/game.js         the rules; no socket calls, events go through a bus
server/protocol.js     full state, action acks, tick payload, spectator frames
public/client.js       rendering and input; decides nothing
```

`SPEC.md` records the design decisions and the status of every item in
`BUGS.md`.
