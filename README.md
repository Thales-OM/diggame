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

## Docker

The image is defined by `docker/Dockerfile`, and CI publishes it to the GitHub
Container Registry when a `v*` tag is pushed. It is built for both `linux/amd64`
and `linux/arm64`, so the same tag runs on a laptop and on a Raspberry Pi. The
SQLite file lives in `/app/data`, so a volume mounted there keeps accounts and
the running world across restarts.

Deploy the published image with `docker/docker-compose.yml`:

```sh
docker compose -f docker/docker-compose.yml up -d
```

The tag defaults to `latest`; pin a release with `DIGGAME_TAG=v0.7.0`. The
ghcr package is private by default, so either make it public or `docker login
ghcr.io` first.

To build from this checkout instead, use `docker/docker-compose.build.yml`:

```sh
docker compose -f docker/docker-compose.build.yml up -d --build
```

Both share one `diggame-data` volume. Set `RESET_SECRET`, `ADMIN_SECRET`,
`WORLD_SEED` and so on in a `.env` file next to the compose file, or leave them
out; an empty value means the feature is off.

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

You play as one of five **classes** - **Wizard**, **Knight**, **Barbarian**,
**Noble** or **Bandit**. Each has its own sprite in the pit and a larger pose in
a fight, and you may switch whenever you like from the class picker in your
profile. The class is a face, not a rule: every class digs, fights and carries
loot the same way, and more that makes them differ is still to come.

The first time you log in you are shown a short **Tutorial**, and you are shown
it once per account rather than once per visit - the server remembers that you
have read it, not your browser. It opens on the first page over the field, and
you move through it with **Back** / **Next**; the last page offers **Got it**, and
**Skip** is always there to close it. **Tutorial** (📖) in the top bar reopens it
from page one whenever you have forgotten something.

The top-bar windows - **Menu**, **Inventory**, **Emotes** and the **Tutorial** -
never stack: opening one closes the others, and entering **Spectator mode** clears
them too. The Tutorial is modal on top of that: while it is up the top-bar
buttons are locked, until you finish or skip it.

Bear traps are yours alone. Nobody else, playing, can see where you set them.
If somebody else springs one, or dynamite sweeps it away, you find out straight
away rather than next time you move.

Every so often a solid band of bedrock blocks the way, with a single gap that a
**boss** guards; between the gates lurk lesser **minibosses**. Digging into a
boss is how you meet it. A boss is one of several **species** - maggots, fairies,
an undead knight, a wyvern, an ancient god cultist between the gates, and a
fallen angel, the traces of an ancient god or a man-made abomination at them -
and the deeper you are, the nastier the species gets. The field never gives it
away: every boss cell is the same red tile, and you only learn what you are
facing when the fight opens. A miniboss is a duel you start alone; a gate boss posts
a join window to the pit first and up to four players may pile in. The player
who opened the window does not have to wait it out - their **Start** begins the
fight at once, while everyone else just watches the countdown (allies may still
join until the timer runs out). You and the
boss trade blows turn by turn - **Attack**, defend, use an item, or open the
**Skill** list for what your weapon can do (the staff offers an incantation).
A healing potion is thrown at a chosen ally: pick it, then aim with **←/→** and
press **Enter** (**Esc** cancels), and a member already at full health refuses
it with "HP is full".
Your armour is spent protecting you and any left over
comes back when the fight ends. Win and a loot window shows what you gained;
press **Confirm** to return to the field, carrying off a **weapon** if the roll
favoured you. Weapons only ever come from fights, never from the dirt.

A fight takes over the whole screen: the boss up top, your party beneath it, and
the running order down the side. Hover an item or a weapon in the inventory to
read what it does.

| key | what it does |
| --- | --- |
| arrows / `WASD` | move, and pan the spectator camera |
| `Q` | dynamite: the eight cells around you **and the one you are standing on** |
| `E` | set a bear trap under your feet |
| `I` | open the inventory: your items and your weapons (equip one here) |
| `V` | switch in and out of spectator mode |
| `M` | open and close the menu |
| `Esc` | close the open window (tutorial, emotes, inventory or menu), then spectator mode |
| `Space` / `Enter` | in a fight, attack |

Nothing is swallowed while you are typing: a name, a code or the admin secret go
into the box you are typing in, not into the mine.

## Watching

Press **Spectate**, or `V`, to watch instead of digging - no account needed. A
banner across the top says you are watching and how to get out. The camera
starts on the deepest player; the **Follow** dropdown hands it between
**Manual**, **Deepest player** and any named player, and clicking a scoreboard
row follows that player too. WASD or the arrow keys pan freely and drop the
camera back to Manual. A watched player who leaves the field, or an empty pit,
sends the camera back to Manual on its own. The button works from the login
screen too, and whichever button you pressed to start watching presses again to
stop - you do not have to reach for `Esc`.

What you see depends on who you are, and the decision is made on the server:

| mode | what you are shown |
| --- | --- |
| public | the players, their depth and their items, and the ground they stand on |
| your own | the public view, plus the cells **you** have dug and **your** traps |
| admin | the whole field, including blocks nobody has dug, and every trap |

Choosing a **Mode** switches the view straight away. The admin view is off unless
the server sets `ADMIN_SECRET`, and choosing **Admin** reveals the secret box -
type the secret and press **Enter**; the request is refused
without it. The secret is remembered in the browser once accepted, so returning
to Admin does not ask again, and a refusal forgets it and puts the box back. The
admin view reaches a set distance below the deepest cell anybody has dug rather
than the whole column, and that distance is adjustable down to 0 and up to the
server's `ADMIN_VIEW_MARGIN` ceiling. There is also an **only discovered cells**
toggle, which narrows the view back to what players have actually found.

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
