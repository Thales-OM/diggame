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
| `ADMIN_SECRET` | empty | enables the admin spectator view when set; nobody can reach it while it is empty |
| `ADMIN_VIEW_MARGIN` | `30` | how far below the deepest dig the admin view reaches (0–500) |

Every value is optional and out-of-range values fall back to the default with a
warning on startup. Secrets are never sent to a browser.

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
| `server/config.test.js` | defaults, `.env` parsing, coercion, validation, secret hiding |
| `server/db.test.js` | schema, migrations, repositories, fatal errors |
| `server/world.test.js` | generation determinism, discovery, depth |
| `server/game.test.js` | every rule: movement, digs, traps, dynamite, spikes, skins, death, stats |
| `server/protocol.test.js` | revisions, acks, full state, the three spectator views |
| `server/client.test.js` | the browser client, run against a stubbed DOM that rejects what the DOM rejects |
| `server/e2e.test.js` | the real server driven with real sockets |

A stub DOM is only worth having if it fails the way the browser fails. It
refuses the writes the DOM refuses, so a line like `element.children.length = 0`
- which throws a `TypeError` in a real page and used to throw on every
spectator frame, killing the view - cannot pass in here. A green suite is not
proof the page works; when something only misbehaves in a browser, drive a real
one.

## Playing

Log in with a name and you get an account code back. Keep it: that code brings
your stats and the ground you have uncovered back to you next time, so you pick
up digging exactly where the map left off (in a new free column, not in the
hole you were last in).

The first time you log in you are shown the rules, and you are shown them once
per account rather than once per visit - the server remembers that you have read
them, not your browser. **Rules** in the top bar reopens them whenever you have
forgotten something.

Bear traps are yours alone. Nobody else, playing, can see where you set them.
If somebody else springs one, or dynamite sweeps it away, you find out straight
away rather than next time you move.

| key | what it does |
| --- | --- |
| arrows / `WASD` | move, and pan the spectator camera |
| `Q` | dynamite: the eight cells around you **and the one you are standing on** |
| `E` | set a bear trap under your feet |
| `V` | switch in and out of spectator mode |
| `M` | open and close the menu |
| `Esc` | close the rules, then the menu, then spectator mode |

Nothing is swallowed while you are typing: a name, a code or the admin secret go
into the box you are typing in, not into the mine.

## Watching

Press **Spectate**, or `V`, to watch instead of digging - no account needed. A
banner across the top says you are watching and how to get out. The camera
follows the action until you pan it, and **Follow** hands it back. The button
works from the login screen too, and whichever button you pressed to start
watching presses again to stop - you do not have to reach for `Esc`.

What you see depends on who you are, and the decision is made on the server:

| mode | what you are shown |
| --- | --- |
| public | the players, their depth and their items, and the ground they stand on |
| your own | the public view, plus the cells **you** have dug and **your** traps |
| admin | the whole field, including blocks nobody has dug, and every trap |

The admin view is off unless the server sets `ADMIN_SECRET`, and needs the
secret typed into the panel. It reaches a set distance below the deepest cell
anybody has dug rather than the whole column, and that distance is adjustable
down to 0 and up to the server's `ADMIN_VIEW_MARGIN` ceiling. There is also an
**only discovered cells** toggle, which narrows the view back to what players
have actually found.

A cell nobody has looked at is drawn grey, so the pit reads as rock you have not
looked into yet. A cell you have dug out is drawn as dark open dirt.

```sh
ADMIN_SECRET=$(openssl rand -hex 16)   # in .env
```

Leave it unset and nobody can be shown the field at all.

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
