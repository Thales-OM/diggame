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
  before it is dug. Once dug, the cell is air with no item, for everyone: the
  loot is on the block until it is taken, and gone after. It is not drawn back
  onto the open cell by a resync, a reconnect, or a spectator view.
- The catch-up bonus is a consolation roll on an *empty* block, and only for a
  player strictly behind the leader. The chance scales with the depth deficit
  and is capped by `ITEM_BONUS_MAX`.
- Armour absorbs one spikes hit: the piece is consumed, the spikes block is
  preserved, and the player ends up standing in it. Walking out and back in
  costs another piece.
- With no armour, walking into spikes is a move that succeeds: the player steps
  into the cell, and the death lands `SPIKES_DEATH_DELAY_MS` later from the tick.
  Killing on the spot left the model standing in the cell it came from, so the
  player was never impaled by the block they walked into - they just vanished
  next to it. The step-in has to be something you can watch. A dying player
  cannot move, dig, or place anything, and the death is paid once however many
  ticks pass.
- A bear trap moves you *into* the cell it was set on, and only then holds you
  there. Standing next to a trap and then being teleported half a cell to one
  side left the player stuck on a cell they were never really on, and the trap
  under the real cell stayed armed. The cell is revealed to the victim (and
  shared, if `SHARE_DISCOVERIES` is on) so their map agrees with where they are.
- A dynamite blast is the eight neighbours **and the cell the player is standing
  on**. The centre is the case that matters: surviving spikes with armour leaves
  you standing on them, and a blast that skipped its own centre could never free
  you. The centre cell is dug like any other, so the player ends up in open air,
  unharmed by their own blast.

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
- Countdowns (shovel, stuck, dig bar) are rendered on a clock re-anchored to the
  server's `serverNow`, so a wrong local clock cannot lie. They are
  presentation only and never feed back into gameplay.
- `setModel` is validated server-side against `MODEL_COUNT` and answered with an
  ack. A valid change bumps `rev` and pushes a private snapshot
  (`reason: "modelChanged"`) straight away, so the player who changed their own
  skin sees it without waiting for the next tick or the next unrelated action;
  everybody else sees it on the next broadcast. An index that is not a whole
  number in range is refused with `ERR.INVALID_MODEL` and changes nothing, and
  the client never pre-commits a pick it has not had confirmed, so a refused
  pick cannot leave the local model drawn differently from the player's.
- `rulesSeen` is a column on the account, not a browser flag, so "has this
  player been shown the rules" survives a new browser, another device, and the
  cookie being cleared. The login reply carries the answer, and closing the
  dialog is what records it. A localStorage guess was wrong for exactly the
  players it mattered for: the ones who came back on a new machine.

## Rendering

- A cell nobody has discovered is painted flat grey, so the pit reads as rock
  nobody has looked into yet rather than as a hole. The only exception is the
  sky above the surface, which stays sky: an undiscovered cell up there is
  nothing at all, not something hidden.
- Air below the surface is drawn as dark excavated dirt with a speckle, and
  never with the grass cap. `air` is ambiguous in the payload - it is both "you
  dug this" and "this was never anything" - and `y >= SURFACE_Y` is what tells
  the two apart, so a tunnel reads as a tunnel and a hole in the ground is not
  mistaken for one.

## Spectating

There are three views, and the *server* decides which one a socket gets. The
mode is a request, never an entitlement: anything unrecognised falls back to
`public`, so a guessed or hand-edited request cannot open a view.

| mode | who | what a frame contains |
| --- | --- | --- |
| `public` | anybody, logged in or not | player positions and public stats, and the surface ground only |
| `player` | a logged-in socket | the public view, plus the cells *this account* discovered and *its own* traps |
| `admin` | a socket with `ADMIN_SECRET` | the whole generated field, fixed items included, every player's cells and every trap |

- A `player` frame is per account. Somebody else's digging is not in it, which
  is why a fresh account's view is identical to the public one.
- An admin frame reaches `deepest cell anybody has dug + depthMargin`, never
  the whole column, so it stays a view of the action. `depthMargin` is a
  non-negative whole number; anything else - negative, fractional, a string, a
  missing value, an absurd one - is replaced by the server's
  `ADMIN_VIEW_MARGIN` or capped at 500. It is checked before coercion, because
  `Number(null)` and `Number('')` are both `0` and an absent value must not look
  like a deliberate request for a zero-deep view.
- The admin `aggregate` toggle narrows the frame back to the union of what
  players have actually discovered, which is the view to use when checking that
  a run's map is consistent rather than when reading the pit.
- Knowing that somebody is digging at row 40 is public. What is in row 40 is
  not, and the camera (`maxY`) is free to follow them down without any cell
  coming with it.
- Frames are diffed against a per-socket cache, and the cache is discarded
  whenever the view changes, so the first frame of a new mode is never empty.
  Cells that leave the view are dropped from the cache, which keeps a
  long-running spectator from accumulating the whole world.

## Spectating controls

- The camera follows the action by default. WASD or the arrow keys pan it away
  and a "follow" button brings it back. Camera keys are purely local: they
  never send an action, so they cannot move, dig or place anything. Q and E are
  ignored outright while spectating.
- Panning is clamped to the world and to the deepest row anybody has reached,
  so the camera cannot wander into empty space that has nothing to show.
- Diagonals are normalised, so moving two ways at once is not faster than one.
  Held keys are dropped on blur, so alt-tabbing mid-keypress does not leave the
  camera walking on its own.
- `V` toggles spectator mode, `M` toggles the menu, and `Esc` closes exactly
  one thing: the rules if they are open, then the menu, then spectator mode.
  That order is "topmost first", so a dialog opened over a panel is the one the
  reader meant to dismiss. With nothing open, `Esc` is left to the browser so
  full screen still works.
- Every shortcut is checked after the text-field guard and before the movement
  table, so none of them can be typed into a name or a password box. Auto-repeat
  is ignored, so holding `V` cannot flicker between the two views.
- The top controls are a wrapping flex row, which is what stops the back and
  follow buttons from landing on top of each other in a narrow window.

## Storage

- `node:sqlite`, no extra dependency. Node >= 22.21 is required.
- Accounts and lifetime stats are permanent. Worlds (runs) record their seed,
  width and config. Per-run stats are kept per world for the final standings.
- The schema is versioned and migrated forward on open, so a database written by
  an older build keeps working: an account that predates the rules dialog simply
  has `rules_seen = 0` and is shown the rules once, and the account write path
  never overwrites a column it was not asked about.
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
- `ADMIN_SECRET` empty (the default) disables the admin spectator view
  entirely: not even a logged-in player can be shown the field, so a server that
  never opts in cannot leak it. It is checked on every `spectate` request, not
  once at connect, because the view is re-requested whenever the options change.
  It is a dedicated setting rather than a reuse of `RESET_SECRET`, so the two
  do not have to be the same string, and it is never echoed to a browser.
- `ADMIN_VIEW_MARGIN` is the default and the fallback depth margin (30). It is a
  non-negative whole number of blocks, bounded 0..500; an unparseable or
  out-of-range value is a startup warning and the default. `0` is a real value
  and means "the view stops at the deepest dig".

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
| skin change needs a move to show | the index is validated and answered with an ack, and a valid change bumps `rev` and pushes a private `modelChanged` snapshot immediately, so the player who changed it sees it at once; `game.test.js`, `client.test.js`, `e2e.test.js` |
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
| trap leaves the player standing beside it | stepping into a trap moves the player into the trap's cell first, so position and cell agree; `game.test.js` |
| dynamite does not clear the cell you stand on | the blast is the eight neighbours plus its own centre, which is the cell a player survives spikes on; `game.test.js` |
| skin index is trusted from the socket | `Game.setModel` accepts only a whole number in `0..MODEL_COUNT` and refuses the rest with `ERR.INVALID_MODEL`; the client does not pre-commit a pick it has not had confirmed; `game.test.js`, `e2e.test.js` |
| no rules are ever shown, or they are shown to the wrong people | `rules_seen` is a migrated account column answered in the login reply, and closing the dialog is what records it; `db.test.js`, `client.test.js`, `e2e.test.js` |
| back and follow buttons overlap | the top controls are a wrapping flex row, and the two button groups are laid out as a row; `client.test.js` |
| an undiscovered cell is indistinguishable from a dug one | unknown cells are flat grey underground, excavated air is dark speckled dirt without a grass cap, and the sky above the surface stays sky; `client.test.js` |
| any spectator can be shown the whole field | the frame is filtered server-side by mode; only a socket holding `ADMIN_SECRET` gets the generated field, and an unrecognised or missing mode falls back to `public`; `protocol.test.js`, `e2e.test.js` |
| collected items reappear on the open cell | the dug cell is air with no item, so a resync cannot draw loot that is already in an inventory; the client also clears the cell on `blockDug` and on `digComplete`; `world.test.js`, `protocol.test.js`, `client.test.js` |
| dying on spikes happens without ever entering them | the move into the cell succeeds and the tick kills the player `SPIKES_DEATH_DELAY_MS` later, where they stand; actions are refused while dying and the death is paid once; `game.test.js`, `client.test.js` |
| watching does nothing from the login screen | three faults, all needed: the frame handler threw a `TypeError` while clearing the scoreboard (`children.length = 0`, and `length` on an `HTMLCollection` is a getter with no setter), which aborted the handler before it revealed the view; `#spectator` had no positioning of its own, so it sat in the normal flow; and the absolutely positioned `#login`, which lives outside `#game`, stayed on top. The board now uses `replaceChildren()`; `client.test.js` |
| the spectator view is announced nowhere | a centred banner in the top half of the screen, inside `#spectator` so it cannot fall out of step with the view, naming the view and the two ways out; `client.test.js` |
| watching cannot be cancelled without Esc | the on-screen buttons toggle, so the one you pressed to get in takes you back out; `client.test.js` |
| the rules button only opens the dialog | the button is a toggle, like the menu, and shares its close path; `client.test.js` |

Fixed on the way, and not in BUGS.md:

| problem | fixed by |
| --- | --- |
| dynamite left bear traps standing in the rubble | the trap is swept up before the blast's air check, and its owner is told; `game.test.js` |
| a private event gave the client no new revision, so the next action was rejected as stale | the snapshot carries `rev`, and the client adopts it; `game.test.js`, `client.test.js`, `e2e.test.js` |
| the generation ramps counted depth one row further down than the HUD did | generation uses the same `depthOf` the HUD shows; `world.test.js` |
| an admin depth margin of `null` was read as a request for zero | the margin is checked before coercion, since `Number(null)` and `Number('')` are both `0`; `protocol.test.js`, `e2e.test.js` |
| a `spectate` request with no payload could be left unanswered | the handler normalises a missing or non-object payload and always replies; `e2e.test.js` |
| `rulesSeen` sent with no payload got no answer, because socket.io passes the callback as the first argument | the handler accepts the ack in either position; `e2e.test.js` |
| a failed e2e assertion left its sockets open and hung the runner | every client the suite opens is tracked and closed in `after`; `e2e.test.js` |
| the client test stub started every panel visible, so "is it hidden" tested the stub | the stub seeds its initial classes from `index.html`; `client.test.js` |
