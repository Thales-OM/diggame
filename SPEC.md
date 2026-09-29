- each player can open the page and first time are prompted to enter the name (not necessary to be unique) or enter a code to their player account 
- for each new user a unique code is generated that allows them to login and is placed in cookies so that user can reenter game easily. The code is also shown to them on their profile window (pop up over game when you click a menu button on top right).
- the main gameplay is that users start on the ground with green grass and blue sky and must dig down.
- the game is 2d, the players and spectators view it sideways 
- the game is N blocks wide constant
- the game is multiplayer 
- each user is displayed with their name over their player avatar, user can pick from several player models
- each player takes exactly one block of space and can't encroach on other players
- the way down is theoretically endless and randomly generated 
- when the game starts the players can see the ground blocks and the sky when they dig down or sideways (of course they can dig only down when they start the game ON the ground) and take up a new block they discover which blocks are left/right/down and that is added to the blocks they observed and remember (even if they move from this place they still see on the screen which type of block these were, if some other player digs them then they of course disappear and they now only see the remaining dark blocks next to them that they haven't discovered yet and must be adjacent to (up/dow/left/right) to see which they are.
- i think the game must have a spectator mode when you can view the field with blocks revealed and see players moving on the field)
- I am still unsure whether another player discovering a block info must be passes on to other users, so leave space for this in code, but for now I think the discovered blocks info is not shared.
- the ground contains obstacles like stones which cannot be digged through and spikes, when you dig into them you die and start from the ground up (because you see adjacent blocks it's not that big of a punishment, it's easy to dodge them).
- simple dirt blocks can contain items, like armour (survive one spikes block hit), golden shovel - dig faster for one minute, dynamite - allows to clear all 8 blocks that surround you right now (regardless of whether they are stone or spikes, also destroys items), bear trap  (plant it, it is invisible to other players, player caught is stuck for 1 minute).
- balance the game so that players that are behind get shovels and dynamite more often 
- player state updates are incremental (e.g. let client send a hash of its current state and a desired action, if the server approves and sends a result (e.g. what you discovered in this block) the client makes a small update, if hashes are out of sync - the server demands full sync and broadcasts)
- server has a handle to reset the current game field (e.g. i want to start a new game (the players progress, scores and history of old runs are preserved)

---

# Implementation notes

Everything below was decided while building the code, not in the original
spec. It is here because the code depends on it and would otherwise look
arbitrary.

## Geometry

- The surface row is `y = SURFACE_Y` (default 0): always plain dirt, drawn with
  grass on top, never stone or spikes, never a cache. The highest cell a player
  can stand in is `y = SURFACE_Y - 1`, i.e. you stand *on* the ground, not
  inside it. `y < SURFACE_Y` is sky and cannot be entered.
- Depth is measured from the spawn line: `depth = max(0, y - (SURFACE_Y - 1))`.
  Depth 0 is where everybody starts, and it is the same measure the generation
  ramps use, so "depth 3 stone" means what the HUD says at depth 3.

## Digging

- Digging the same cell again is ignored outright, timer untouched. Any other
  valid direction, or using an item, cancels the dig and starts the new one.
  A direction that cannot happen (a wall, a stone block, the sky) changes
  nothing, so a mistyped keypress cannot cost you a dig in progress.
- When a dig finishes the player moves into the cell in the same tick, and the
  completion message carries the authoritative position. The client never works
  out where it ended up.
- A dig is revalidated at the end: if the cell was blown up or taken by someone
  else, the dig is aborted and the player is told, instead of the block
  silently vanishing under them.

## Items

- Blocks with a seeded item show it once discovered, so a block can be judged
  before it is dug.
- The catch-up bonus is a consolation roll on an *empty* block, and only for a
  player strictly behind the leader. The chance scales with the depth deficit
  and is capped by `ITEM_BONUS_MAX`.
- Armour absorbs one spikes hit: the piece is consumed, the spikes block is
  preserved, and the player ends up standing in it. Walking out and back in
  costs another piece. A player with no armour dies.

## Protocol

- The original "hash of your state" is replaced by a per-player revision
  counter. Hashing the whole discovered-block set is O(world) per keypress and
  mismatched constantly, which turned full sync into the normal case and made
  the display lurch. `rev` is O(1), and a mismatch now means the client really
  did miss something.
- Every action echoes `rev`. A mismatch is answered with `needSync` plus the
  whole state, including real block contents. Rejections also resync, so a
  refused move cannot leave the client holding a stale position.
- The private snapshot carries `rev` too. It used to travel only beside the
  snapshot, so a client that had only seen private events (`digComplete`,
  `state`) had no way to learn the new revision and its next action was thrown
  away as stale. Private events are the fast path, so they have to be enough
  on their own.
- Discovery is remembered per run and per account, so relogging in brings back
  the map you had found. It is a memory, not a position: you still arrive in a
  new free column. The server keeps the sets in memory only, since a run does
  not outlive the process.
- `SHARE_DISCOVERIES` leaves other players' revisions alone on purpose. A
  shared finding does not change the recipient's own state, so their `rev`
  still matches and the next action is not answered with a pointless resync.
- Bear traps are secret to other *players*: the owner is told where their own
  are, and everybody else is not, or the trap is no protection. A spectator
  sees the whole field, traps included, which is the point of hiding them. The
  owner is also told the moment a trap is gone, so their view corrects itself
  instead of waiting for their next action.
- Broadcasts carry public information only: positions, dig progress, and the
  *coordinates* of dug cells, never their contents. A client applies a dug cell
  only if it had discovered it. Discovered blocks are not shared, but
  `SHARE_DISCOVERIES` is left in the code as a switch.
- The 10 Hz tick is a safety net for other players' movements. Your own state
  arrives with the answer to your own action.
- Countdowns (shovel, stuck, dig bar) are rendered on a clock re-anchored to
  the server's `serverNow`, so a wrong local clock cannot lie. They are
  presentation only and never feed back into gameplay.

## Spectating

- The camera follows the action by default. WASD or the arrow keys pan it away
  and a "follow" button brings it back. Camera keys are purely local: they
  never send an action, so they cannot move, dig or place anything.
- Panning is clamped to the world and to the deepest row anybody has reached,
  so the camera cannot wander into empty space that has nothing to show.
- Diagonals are normalised, so moving two ways at once is not faster than one.
  Held keys are dropped on blur, so alt-tabbing mid-keypress does not leave the
  camera walking on its own.

## Storage

- `node:sqlite`, no extra dependency. Node >= 22.21 is required.
- Accounts and lifetime stats are permanent. Worlds (runs) record their seed,
  width and config. Per-run stats are kept per world for the final standings.
- A run in progress is ephemeral: a restart starts a new world, and the world
  left `active` by a dead process is marked `aborted` rather than resurrected.
- Stats are handed to storage as *deltas*, keyed by account code, so a periodic
  flush, a disconnect and the end of a run cannot double count, and a player who
  logs out mid-run does not lose what they dug.
- A storage failure is critical: on boot the server refuses to start, and during
  play it freezes the game, tells every client, and exits non-zero. There is no
  in-memory fallback and no silent recreate.

## Configuration

- All tunables live in `server/config.js` with defaults, and can be overridden by
  environment variables or an optional `.env` file (real environment wins).
  Secrets never reach the client: `clientConfig()` is an explicit allow-list.
- `RESET_SECRET` empty (the default) disables the HTTP reset endpoint entirely.
  `npm run reset` always works, because it is a local command and needs no
  secret.

## Modules

| file | what it owns |
| --- | --- |
| `server.js` | boot, socket wiring, tick broadcast, stat flushing, reset, fatal halt |
| `server/config.js` | defaults, parsing, validation, client-safe config |
| `server/db.js` | schema, migrations, every SQL statement |
| `server/world.js` | generation, dug state, discovery, depth |
| `server/game.js` | rules: movement, digs, traps, dynamite, spikes, death, runs |
| `server/protocol.js` | full state, action acks, tick payload, spectator frames |
| `public/client.js` | rendering and input; never decides anything |

`game.js` never calls a socket method: it emits through an injected
`bus.toPlayer` / `bus.broadcast`, which is what lets the whole rule set be tested
headless.

## Bug status

| BUGS.md | fixed by |
| --- | --- |
| move to the next dug square is not automatic | dig completion moves the player in the same tick and sends the position; `game.test.js`, `protocol.test.js`, `e2e.test.js` |
| moving along a dug path triggers a dig | dug cells read as air and are entered directly; `game.test.js` |
| respawn shows the player in the wrong place | respawn carries an authoritative `you` and the client snaps to it; `game.test.js`, `client.test.js` |
| skin change needs a move to show | `model` is in the public snapshot, so the next 10 Hz tick carries it; `game.test.js` |
| game reset does not move the player | `worldReset` carries a full state and the new position; `e2e.test.js`, `client.test.js` |
| ground layer must be dirt with grass | the surface row is always dirt and the client draws grass on it; `world.test.js` |
| pressing the same direction restarts the dig | same cell is ignored, timer untouched; `game.test.js` |
| WASD blocked on the login screen | the handler is scoped to the mine and never touches typing; `client.test.js` |
| a keypress after a dig moves the player anyway | the client adopts `you` from the message and never does position arithmetic; `client.test.js` |
| spawning inside the top dirt layer | players stand on `SURFACE_Y - 1`, above the surface row; `world.test.js`, `e2e.test.js` |
| armour does not protect from spikes | armour is consumed per entry and the player survives into the cell; `game.test.js` |
| traps only visible to spectators | the private snapshot carries the owner's own traps, and nothing else does; they are also cleared for the owner the moment one is sprung or blown up; `game.test.js`, `client.test.js`, `e2e.test.js` |
| relogin conceals revealed blocks | discovery is remembered per account for the run and restored on login; `game.test.js`, `e2e.test.js` |
| spectator camera cannot move | WASD and the arrows pan the camera, clamped to the world and deepest row reached, with a follow button to hand it back; `client.test.js` |

Fixed on the way, and not in BUGS.md:

| problem | fixed by |
| --- | --- |
| dynamite left bear traps standing in the rubble | the trap is swept up before the blast's air check, and its owner is told; `game.test.js` |
| a private event gave the client no new revision, so the next action was rejected as stale | the snapshot carries `rev`, and the client adopts it; `game.test.js`, `client.test.js`, `e2e.test.js` |
| the generation ramps counted depth one row further down than the HUD did | generation uses the same `depthOf` the HUD shows; `world.test.js` |
