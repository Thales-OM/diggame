- each player can open the page and first time are prompted to enter the name (not necessary to be unique) or enter a code to their player account 
- for each new user a unique code is generated that allows them to login and is placed in cookies so that user can reenter game easily. The code is also shown to them on their profile window (pop up over game when you click a menu button on top right).
- the main gameplay is that users start on the ground with green grass and blue sky and must dig down.
- the game is 2d, the players and spectators view it sideways 
- the game is N blocks wide constant
- the game is multiplayer 
- each user is displayed with their name over their player avatar, and at entry chooses one of the five character classes (Wizard, Knight, Barbarian, Noble, Bandit); a class is held for that run and carries its own skills
- each player takes exactly one block of space and can't encroach on other players
- the way down is theoretically endless and randomly generated 
- when the game starts the players can see the ground blocks and the sky when they dig down or sideways (of course they can dig only down when they start the game ON the ground) and take up a new block they discover which blocks are left/right/down and that is added to the blocks they observed and remember (even if they move from this place they still see on the screen which type of block these were, if some other player digs them then they of course disappear and they now only see the remaining dark blocks next to them that they haven't discovered yet and must be adjacent to (up/dow/left/right) to see which they are.
- i think the game must have a spectator mode when you can view the field with blocks revealed and see players moving on the field)
- I am still unsure whether another player discovering a block info must be passes on to other users, so leave space for this in code, but for now I think the discovered blocks info is not shared.
- the ground contains obstacles like stones which cannot be digged through and spikes, when you dig into them you lose health (armour soaks the strike first) and you die and start from the ground up when your health runs out (because you see adjacent blocks it's not that big of a punishment, it's easy to dodge them).
- simple dirt blocks can contain items, like armour (points that soak a spikes hit or a boss blow before it reaches your health), a potion (mends health on the field or in a fight), golden shovel - dig faster for one minute, dynamite - allows to clear all 8 blocks that surround you right now (regardless of whether they are stone or spikes, also destroys items), bear trap  (plant it, it is invisible to other players, player caught is stuck for 1 minute).
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
- A dynamite blast clears the eight neighbours and the cell you stand on, plain
  **stone** and spikes included; only a **gate mist** row and a boss cell survive
  it, which is why a gate wall stays a wall.
- Health is one pool (`MAX_HP`) per life, drawn as a bar in the corner of the HUD
  with the armour points it would spend first beside it, and refilled on spawn,
  respawn and a new run. It is the same pool a fight draws on, so a wound taken
  on the field is still there when a boss appears. A **potion** mends `ITEM_HEAL`
  of it, on the field with `usePotion` or in a fight.
- Spikes cost **health**, not a life outright. A spike strike deals
  `ARMOUR_POINTS_PER_ITEM` damage against your pool: banked armour points soak it
  first, and only what is left over comes off your health. The spikes block is
  preserved and the player ends up standing in it, so walking out and back in
  costs another strike.
- When the strike leaves any health at all the player simply carries on. When it
  takes the last of your health, walking into spikes is still a move that
  succeeds: the player steps into the cell, and the death lands
  `SPIKES_DEATH_DELAY_MS` later from the tick. Killing on the spot left the model
  standing in the cell it came from, so the player was never impaled by the block
  they walked into - they just vanished next to it. The step-in has to be
  something you can watch. A dying player cannot move, dig, or place anything,
  and the death is paid once however many ticks pass.
- A bear trap moves you *into* the cell it was set on, and only then holds you
  there. Standing next to a trap and then being teleported half a cell to one
  side left the player stuck on a cell they were never really on, and the trap
  under the real cell stayed armed. The cell is revealed to the victim (and
  shared, if `SHARE_DISCOVERIES` is on) so their map agrees with where they are.
- A dynamite blast is the eight neighbours **and the cell the player is standing
  on**. The centre is the case that matters: surviving a spike strike leaves you
  standing on them, and a blast that skipped its own centre could never free you.
  The centre cell is dug like any other, so the player ends up in open air,
  unharmed by their own blast.

## Gates, bosses and battle

- A **gate** is one solid row of purple **mist** at every `GATE_EVERY_N_DEPTH`
  below `GATE_MIN_DEPTH`. Mist is dug like dirt, but finishing the dig does not
  clear it: the player stays put, the row stays a wall, and the server asks
  (`gatePrompt`, `mode:'enter'`) whether to face the gatekeeper behind it. Answer
  **no** and nothing changes; answer **yes** (`enterGate`) and the fight opens and
  the player steps onto the wall tile. A gate band has no pre-cut gap - the whole
  row is the wall. **Minibosses** (`MINIBOSS_PER_REGION` per region) are seeded in
  the levels between gates, each with its eight neighbours already dug out so it
  is reachable but walled in by the terrain around it. Minibosses never touch a
  gate or another boss.
- Digging a boss cell starts the fight; the boss cell itself stays standing until
  the fight is *won*, so nobody can walk past it mid-fight. A **miniboss** is a
  solo duel that begins at once. A **gate boss** opens a `BOSS_JOIN_WINDOW_MS`
  window first, advertised to the whole pit, that up to `BATTLE_PARTY_MAX`
  players may enter, first come first served. The party need not sit out the
  whole window: the **initiator** may `startBattle` to begin at once (anyone
  else is refused `no_join`), and the window still accepts latecomers (who join
  the round in progress) until its original
  deadline, after which `battleInviteClosed` goes out once. When the window
  closes the fight begins with whoever joined, even if that is only the
  initiator. A mist dig into a wall that **already** holds a fight is a join
  offer instead (`gatePrompt`, `mode:'join'`), naming the boss and the party so
  far and honouring the same cap and window; a wall that is clear of fights opens
  a fresh one.
- A gate is never dug out globally. **Winning** marks the whole row at that depth
  open for every member of the winning party (`wallsCleared`, keyed by account
  code just like the discovered map), so the row reads as a tunnel only for them
  and the server lets only them walk through it like air. Everyone else still
  sees mist: mist is drawn only for players who have not opened the row, and a
  bystander who digs it is offered a fight of their own. Death clears a player's
  opened rows (`kill`), so every gate is earned again on the way down from the
  surface; a reconnect keeps them; a new run wipes them.
- A boss wears a **species** (`server/content/monsters.js`). A miniboss climbs one
  species per `BOSS_SPECIES_TIER_DEPTH` blocks of depth, from the weakest
  (`Overgrown Maggot`) to the deepest (`Ancient God Cultist`, reused below that).
  Each gate is guarded by a fixed species in order (`Fallen Angel`, then
  `Traces of an ancient God`, then `Stalwart Butler`, then `Man-made
  Abomination`, the last reused for any deeper gate). A species is a display
  `name` and a pair of `hpMult` / `atkMult` multipliers applied on top of the size the boss would have had
  anyway (`BOSS_MINIBOSS_*` for a miniboss, the gate base-plus-per-gate formula
  for a gate), so a deeper species is genuinely tougher rather than a new coat of
  paint. Species carry reserved `attacks` and `lines` arrays, empty for now, for
  the day a monster brings its own verbs and battle dialogue. The species is a
  surprise: the field draws every miniboss cell as the same generic tile and the
  client learns `battleView.boss.species` only when a fight opens; the
  unoccupied gate **ready** prompt deliberately does not name the gatekeeper
  either, though the join prompt (a fight already under way) does.
- While `player.battleId` is set the field is frozen: every field action is
  refused with `in_battle`, and the only verbs the server accepts are attack,
  defend, useBattleItem and skill, plus `joinBattle` and `startBattle` during the
  window. A player
  turn runs on `BATTLE_TURN_MS`; timing out hesitates and swings anyway. When the
  party's round is spent the boss takes a turn of its own on
  `BATTLE_BOSS_TURN_MS`, so the blow is announced (with a wobble) before it lands.
  `battleView` reports the actor (`turn`), the rest of the round (`queue`), each
  member's `model` and `maxArmour`, the `initiator`, the caller's own stock in
  `me` (`dynamite`/`trap`/`potion`), and the `turnDelayMs` the screen should
  wait.
- A player carries **one persistent health pool** (`MAX_HP`), filled on spawn,
  respawn and a new run and spent on the field (spikes) and in fights alike. A
  fight starts each member at the HP they brought in, and the survivor's ending
  HP is written back to the field when the fight is over. Field armour is held in
  **escrow** for the fight: each piece is `ARMOUR_POINTS_PER_ITEM` points,
  absorbed before HP, and the unspent points are returned to the field when the
  fight ends - on a win, a loss, a death or a disconnect alike.
- A potion mends the pool on the field too, through the `usePotion` action: it
  tops up `ITEM_HEAL` up to `MAX_HP`, cancelling any dig in progress, and is
  refused `no_item` with none left or `hp_full` when nothing is missing.
- An attack lands with the equipped weapon's `hit` chance, deals
  `BATTLE_BASE_ATTACK + weapon.damage`, and crits for `critMult ×` on the
  weapon's `crit` chance. Unarmed is the `BARE` profile, which is the same object
  as the "Bare-handed" weapon every class owns. The staff's skill is an
  **incantation**: a turn spent charging, then a strike for `mult ×` base, with a
  small `chargeCrit` chance to fire it the same turn.
- **Defend** halves the next blow (`BATTLE_DEFEND_MULT`). **Items** spend the
  real field stock: dynamite for a flat hit, a trap planted for the boss's next
  turn (one chance to fire, triggered by `BATTLE_TRAP_TRIGGER_CHANCE`), a potion
  to heal `ITEM_HEAL`. A potion may name a party member via `target` and
  heals **them** instead of the wielder; a target that is not at full HP is
  required for it to count (an unknown member is `no_target`, a whole one is
  `hp_full` and costs nothing). Skills take the same optional `target` for later
  use; the staff's incantation stays self-cast.
- The boss strikes one member at random each round. A member at zero HP dies
  (respawns as normal) and leaves the fight. A disconnect also leaves. If the
  party empties the fight is lost and the boss is restored to full for the next
  attempt. A party wipe does not cost the pit anything permanent.
- **Loot**: a win rolls one weapon (`WEAPON_WEIGHTS`) and a pool of consumables
  (`BOSS_ITEM_WEIGHTS`, three for a gate, one for a miniboss). Consumables are
  split equally between the members still in the fight, with the remainder to the
  initiator. The weapon goes, in join order, to the first survivor who does not
  already own it; if everyone owns it, it is left on the ground rather than
  destroyed. A won weapon is **never auto-equipped** - it goes into the bag and
  the player puts it in hand themselves. The boss cell is dug out, the leftovers
  are dropped around it, and stepping onto a drop takes it.
- A win does not release the party at once: the battle enters a **`result`**
  phase that holds every survivor on the loot window, which lists what each one
  gained (`battleView.me.gained`). Each confirms with `confirmResult`, which
  refunds their unspent armour and sends the final `battleResult`; the fight is
  forgotten once the last survivor has confirmed (a disconnect counts as leaving).
- **Weapons are earned only from fights**, never dug from the dirt. Every class
  starts **Bare-handed**: a real, zero-damage weapon (`WEAPONS.bare`) that is
  always in the bag, so a player is never left unable to fight and can always put
  a weapon away and go back to their hands. A player carries every weapon they
  have won and chooses which to equip out of battle (`equipWeapon`, from the
  inventory popup); picking a weapon up, or winning one, only adds it to the bag -
  it is **not** equipped for you. The loadout cannot change mid-fight.

## Classes and skills

- There are five classes, in `MODELS` wire order: **Wizard**, **Knight**,
  **Barbarian**, **Noble**, **Bandit**. A class is chosen once per run, at entry
  (see Protocol), and carries a passive, an active, or both. The full table lives
  in `CLASSES` in `server/content/classes.js`; the numbers behind the actives live in config
  so they can be tuned without touching the prose.
- **Wizard — Magic knowledge (passive).** The Magic Staff is `wizardOnly`: only a
  Wizard may `equipWeapon` it, pick it up off the ground, or be handed it as boss
  loot. A non-Wizard who tries is refused (`invalid_weapon`) or told ("Only a
  Wizard can carry the Magic Staff") and the staff stays where it is; a boss
  never drops it to a non-Wizard, leaving it on the ground for one to find.
- **Knight — Weapon expertise (passive).** Sword and rapier blows are multiplied
  by `SKILL_KNIGHT_WEAPON_MULT` (default 1.3); other weapons and bare hands are
  unaffected. This is the Knight's alone.
- **Barbarian — Hardened knuckles (passive) and Battle cry (active).** Bare hands
  (the equipped `bare` weapon, or no weapon at all) hit for
  `SKILL_BARBARIAN_BARE_MULT` (default 1.5). Battle cry heals
  `SKILL_BATTLE_CRY_HEAL` of max HP (default 0.3) and is **once per battle**;
  once spent it is still listed on the Skills tab but marked `usable: false`.
- **Noble — Noblesse oblige (active).** Costs `SKILL_NOBLE_HP_COST` of max HP
  (default 0.1), never below 1, and sets `rallied` on every **other** member. A
  rallied member's next attack deals `SKILL_NOBLE_BUFF_MULT` more (default 1.25);
  the rally is cleared when that member's turn ends, whether or not they attacked.
- **Bandit — Agile footwork (active).** Sets `aimBuff` to `SKILL_BANDIT_TURNS`
  (default 2), lifting the hit chance of the Bandit's next attacks by
  `SKILL_BANDIT_HIT_BONUS` (default 0.25); each attack spends one charge, hit or
  miss.
- Passive multipliers and the Noble rally are applied to the blow **before** any
  crit, so they stack with a critical hit: `damage = round(attack × damageMult ×
  (rallied ? rallyMult : 1))`, then the staff skill's `mult`, then the crit's
  `critMult`.
- `memberSkills(member)` is the single source of the Skills tab: the class's
  skills (passives with `usable: false`, actives with `usable` and a `note` when
  spent) followed by any weapon skill. `battleView.me.skills` ships that list, so
  the client only lays it out - a passive (or a spent active) is drawn dimmer and
  never fires, and hovering it shows its description.
- A class change mid-run does not exist: the `setModel` handler is gone, and a
  new run is the only way to change class.

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
- The opened gate rows are remembered the same way, per run and per account
  (`runClearedWalls`, keyed by account code exactly like the discovered map), and
  ship in the private snapshot as `wallsCleared` (a list of depths). They are
  cleared on death and on a new run, and they never travel in a public or
  spectator frame: a row only one account earned is a wall to everybody else.
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
- A character's class is chosen **once per run**, at entry, and is not switched
  mid-run. The class *is* the player's `modelIndex`: the index is the wire
  protocol, and the browser keeps the same order in `MODELS` in
  `public/js/assets.js` so it can draw the matching sprite. The server owns the
  table (`CLASSES` in `server/content/classes.js`); the login reply and
  `worldReset` hand the browser a
  `classes` list (id, name, description, skills) purely to render the picker.
- Login is gated on the choice: an account with no entry in the run's class map
  is answered with `needsClass: true` and the class list, and is **not spawned**.
  Only `chooseClass` spawns the player. An index that is not a whole number in
  `0..MODEL_COUNT` is refused with `ERR.INVALID_MODEL` and nothing spawns, so
  nobody walks the pit classless and a refused pick cannot leave the client
  drawing a class the server did not set. Choosing again on a second socket is
  what a second login is: the newest choice wins and the older session is kicked.
- `worldReset` detaches every present player and re-asks them to choose for the
  new run: the reset event carries `needsClass: true`, the new seed, and the
  class list. This is deliberate - a class is per game, not for life.
- `rulesSeen` is a column on the account, not a browser flag, so "has this
  player been shown the tutorial" survives a new browser, another device, and
  the cookie being cleared. The login reply carries the answer, and closing the
  popup - **Skip**, **Got it**, the toggle, or `Esc` - is what records it, once. A
  localStorage guess was wrong for exactly the players it mattered for: the ones
  who came back on a new machine. The handler accepts a socket that is still
  choosing a class (it has a code but no player yet), so a brand new account can
  read the rules before it ever spawns.

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
- A boss cell is a red tile with two crossed swords, drawn as canvas paths rather
  than a glyph: a `☠` read as a death marker when it is in fact the one cell you
  are meant to dig into, and the red-team colour separates it from the purple
  gate mist at a glance. The tile is one solid fill in `COLORS.boss`, so the
  legend swatch and the field share a colour. It is deliberately the same tile
  for every boss species - the species is the fight's surprise, not the field's.
- A **gate mist** cell is a solid purple tile in `COLORS.mist`, one fill so the
  legend swatch and the field share a colour. The client overlays it: for a
  depth the player has already opened (`wallsCleared`) the same cell is drawn as
  ordinary excavated air instead, so the row reads as a tunnel for exactly the
  people who earned it and as a wall to everyone else.
- Each of the five classes (**Wizard**, **Knight**, **Barbarian**, **Noble**,
  **Bandit**, in `MODELS` wire order) owns a 16x16 `HERO_FIELD` sprite for the
  pit and a 48x64 `HERO_BATTLE` pose for the ring and the class chooser. A player
  in the pit is one pre-rendered, cached `drawImage` blit into the tile; the
  chooser shows each class's battle pose with the name beneath and its
  description on hover. A boss draws `MONSTERS[species]`, also a 48x64 pose,
  falling back to a `warden` (gate) or `brute` (miniboss) 16x16 pose by `kind`
  when a fight predates species, and a class draws its `HERO_BATTLE` pose, so the
  field and the ring never disagree about who is who.
- Battle art is drawn at a whole-number scale picked to fill a fixed on-screen
  footprint (`BOSS_FOOT` 140px, `HERO_FOOT` 100px, a class card `CARD_FOOT`
  96px), rather than a fixed multiplier. Every class and every boss species now
  ships on the same 48px grid, so the boss box rounds to 144px (3x) and a hero to
  96px (2x), but a finer redraw still reads as more detail at the same size, and a
  sprite that ships at a different grid than its neighbours (the fallback poses)
  stands the same size beside them.
- A fighter in the ring **flashes white** for an instant when it takes a blow.
  The client keeps the last HP and armour it drew for each combatant (keyed
  `boss` or a member id, reset whenever the fight ends or a new one begins), and
  a render in which either has fallen adds a `hit` class that plays a one-shot
  `bsHit` animation (a `brightness(0) invert(1)` silhouette back to normal).
  Armour is banked at the start of a fight and only ever falls as it soaks a
  blow, so counting it means a fully-armoured fighter flashes even when none of
  the damage reaches its health. The same blow can arrive as two renders - the
  state event carrying the drop, then the action's own ack with the identical
  numbers - so a drop opens a short flash window and a redundant render inside
  it keeps flashing rather than rebuilding a fresh sprite with no animation.
  Once the window passes the jolt is over, and an unchanged (or healed) fighter
  never flashes.

## Tutorial

- The first-time hint is a paged popup, one essential idea per page (where you
  start, how digging works, stone and spikes, the block alphabet, loot, health
  and potions, dynamite and traps, gates and gatekeepers, fights and weapons,
  spectating/score/code). Each page carries
  a small slice of the field using the same block alphabet the game draws, and a
  legend naming only the blocks that page introduces, so a page reads on its own.
- A page is one screenful, not a scroll: **Back** is disabled on the first page,
  **Next** turns the page, and the last page hides **Skip** and turns **Next**
  into **Got it**. Both **Skip** and **Got it** - and **Esc**, and the top-bar
  toggle - close it through the same path, which is what records `rulesSeen`.
  The page counter ("Page X of N") comes from the array length, not a constant.
- The weapons page ends with a bullet list of every lootable weapon - sprite, its
  `damage`/`hit`/`crit` numbers and its description, plus the staff's skill -
  built from the same display mirror the inventory tooltips use, so the tutorial
  and the pack cannot describe different weapons. Bare-handed is left off this
  page, since it is not won from a fight; it still appears in the inventory.
- The popup is opened from page one every time, whether it is the automatic
  first-login open or a later press of the 📖 button, so a reader always starts
  at the beginning.

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

- The camera starts on the deepest player. A **Follow** dropdown hands it to
  Manual, to the deepest player, or to any named player, and clicking a
  scoreboard row follows that player. WASD or the arrow keys pan it and drop it
  back to Manual. Camera keys are purely local: they never send an action, so
  they cannot move, dig or place anything. Q and E are ignored outright while
  spectating.
- Choosing a **Mode** applies on the spot: `public` and `player` are requested
  at once, while `admin` first needs the secret. The accepted secret is kept in
  browser `localStorage`, so re-entering the admin view does not ask again; a
  secret the server refuses is forgotten, and the box is emptied and focused for
  a retry. The request still carries the secret on every `spectate`, so the
  server remains the only judge of it and clearing browser storage only costs a
  retype. The admin options themselves - the aggregate toggle and the depth
  margin - re-send the frame as they change, so there is no Apply button.
- A follow is a promise the frame can break: the server only sends players still
  on the field, so a named target that leaves drops the camera back to Manual,
  and the deepest follow does the same once the pit has no players left. While
  everyone is dead but still listed, the deepest follow holds on.
- Panning is clamped to the world and to the deepest row anybody has reached,
  so the camera cannot wander into empty space that has nothing to show.
- Diagonals are normalised, so moving two ways at once is not faster than one.
  Held keys are dropped on blur, so alt-tabbing mid-keypress does not leave the
  camera walking on its own.
- `V` toggles spectator mode, `M` toggles the menu, and `Esc` closes exactly
  one thing: the Tutorial if it is open, then the menu, then spectator mode.
  That order is "topmost first", so a dialog opened over a panel is the one the
  reader meant to dismiss. With nothing open, `Esc` is left to the browser so
  full screen still works.
- Every shortcut is checked after the text-field guard and before the movement
  table, so none of them can be typed into a name or a password box. Auto-repeat
  is ignored, so holding `V` cannot flicker between the two views.
- Keys are read by their **physical position** (`event.code`: `KeyW`,
  `ArrowUp`, `Space`) rather than the layout's character, so `WASD` and every
  shortcut work on a Russian, Greek or AZERTY keyboard, where `W` would otherwise
  arrive as `ц`. `event.key` is the fallback for a key `code` cannot name.
- The top controls are a wrapping flex row, which is what stops the back button
  and the follow control from landing on top of each other in a narrow window.
  The top-right buttons are a fixed 40px square each, so the row is uniform; the
  **Follow** selector is a labelled, bordered, bold box of its own rather than
  bare text hanging over the field.

## Windows

- The windows behind the top-right buttons - **profile** (Menu), **Inventory**,
  **Emotes** and the **Tutorial** - are mutually exclusive: opening one closes
  whichever other was open, so the field is never buried under two panels.
  Spectator mode is one more surface in the same set: entering it calls
  `closePopups`, and opening a panel from the spectator view calls
  `stopSpectating` first, so the two never coexist.
- The Tutorial is **modal** on top of that: while it is up `#topControls` carries
  the `locked` class (`pointer-events:none`, dimmed) and the `M`/`I`/`P`/`V`
  shortcuts are ignored, so no other window can be raised over it. Finishing it
  (**Got it**), skipping it, the top-bar toggle or `Esc` all close it through
  `hideRules`, which is what unlocks the row.
- `Esc` closes exactly one thing, topmost first: the Tutorial, then the Emotes
  popup, the Inventory, an aimed item and the battle submenus, then the Menu,
  then spectator mode. With nothing open it is left to the browser, so full
  screen still works.
- Two overlays are deliberately **not** in that set. The **class chooser** is a
  mandatory entry modal (the field is frozen behind its veil until a class is
  confirmed), so `Esc` must not be able to dismiss it and leave a player
  classless. The **offline** veil is shown the instant the socket drops and kept
  up, over everything, until it returns: it is not a toast and not a popup, and
  nothing the player presses clears it but the reconnect. A brand new account
  reads the Tutorial first and is handed the chooser the moment the Tutorial
  closes.

## Storage

- `node:sqlite`, no extra dependency. Node >= 22.21 is required.
- Accounts and lifetime stats are permanent. Worlds (runs) record their seed,
  width and config. Per-run stats are kept per world for the final standings.
- The schema is versioned and migrated forward on open, so a database written by
  an older build keeps working: an account that predates the tutorial simply
  has `rules_seen = 0` and is shown it once, and the account write path
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

- Configuration is split by job. Every **rule number** - the pit, its odds,
  digging times, gates, boss and battle maths, weapons, species multipliers,
  skills - lives in `config/game.json`, owned by `server/gameconfig.js`. Every
  **infrastructure** setting - listen address, database path, secrets, tick
  rates, seed - lives in `server/config.js` and may be overridden by environment
  variables or an optional `.env` file (real environment wins). `loadConfig()`
  merges the two into one frozen object, so the rest of the server reads a single
  `config` with the same key names it always had.
- The rules file is mandatory and strict. A missing file, invalid JSON, a value
  that is not an object, an unknown section or key, a missing key, a wrong type,
  an out-of-range value, or a species list that does not match the client art id
  for id and in order all raise `ConfigError`, which `server.js` reports as
  `[fatal]` and turns into `process.exit(1)`. There are no defaults and no
  warnings for rules: the game either loads its numbers or does not start.
  Objects in the file carry numbers only; ids, names, glyphs and prose stay in
  code (`content/weapons.js`, `content/monsters.js`) and are merged by id and order.
- `GAME_CONFIG` (a path, so infrastructure) points at the rules file; it defaults
  to `config/game.json` and relative paths resolve from the project root.
- `APP_VERSION` is the build identity, shown small in the client's bottom-left
  corner on the login screen and the field (the battle overlay covers it, so it
  is never drawn in a fight). The release image is built from a `v*` tag and the
  workflow passes that tag in as `APP_VERSION`; left empty, `server/version.js`
  falls back to `package.json`'s `version`, which is bumped in the first commit
  of each version so the fallback tracks the version being worked on. A leading
  `v` is stripped so a tag and a package version read alike. Git is not consulted
  at runtime: it is not in the image.
- Test helpers may pass flat-key `gameOverrides` (a weight may be the compact
  `"id:weight,id:weight"` string); overrides are validated like the file's
  values, but unknown keys are ignored so a helper can pass one bag of settings.
- Infrastructure values are optional and an out-of-range value is a startup
  warning and the default, not a crash. Secrets never reach the client:
  `clientConfig()` is an explicit allow-list.
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
- The class-skill numbers are all rules, so they can be tuned in `game.json`
  without touching `CLASSES`: `knightWeaponMult` (1.3), `barbarianBareMult`
  (1.5), `battleCryHeal` (0.3), `nobleBuffMult` (1.25), `nobleHpCost` (0.1),
  `banditHitBonus` (0.25) and `banditTurns` (2) - read as the same flat keys
  (`SKILL_KNIGHT_WEAPON_MULT`, ...) everywhere else.

## Modules

| file | what it owns |
| --- | --- |
| `server.js` | boot, HTTP wiring, process lifecycle, fatal halt |
| `server/context.js` | the mutable singletons one server instance owns (config, io, store, world, game, ...) |
| `server/runtime.js` | the tick, the run lifecycle, the game bus, the spectator options |
| `server/sockets.js` | the socket handlers, wired on every connection |
| `server/admin.js` | the HTTP reset endpoint |
| `server/config.js` | infrastructure config: defaults, `.env` parsing, the client-safe slice |
| `server/gameconfig.js` | the rules file: strict loading, validation, `ConfigError` |
| `server/version.js` | the build identity: `APP_VERSION` (the image's tag) or `package.json` |
| `config/game.json` | every tunable rule number, in one place |
| `server/db.js` | schema, migrations, every SQL statement |
| `server/world.js` | generation, dug state, discovery, depth |
| `server/content/monsters.js` | the boss species: names, ids, depth tiers (multipliers come from the file) |
| `server/content/` | the other fixed vocabularies: `classes.js`, `weapons.js`, `emotes.js`, `constants.js` |
| `server/game/index.js` | the `Game` class and its wiring |
| `server/game/` | the rules as prototype mixins on `Game`: `players.js`, `stats.js`, `field.js`, `items.js`, `battle.js`, `lifecycle.js` |
| `server/protocol.js` | full state, action acks, tick payload, spectator frames |
| `public/index.html` | the page; loads `js/main.js` as a module |
| `public/js/` | the client modules: `main.js` (entry), `net.js`, `state.js`, `field.js`, `battle.js`, `spectator.js`, `ui.js`, `input.js`, `assets.js`, `constants.js` |

The game mixins never call a socket method: `Game` emits through an injected
`bus.toPlayer` / `bus.broadcast`, which is what lets the whole rule set be tested
headless. The browser client is a set of native ES modules under `public/js/`,
loaded by `public/index.html` with a single `<script type="module">`; the tests
glue them into one script (`server/clientmodules.js`) so they can run against a
stub DOM.

## Distribution

- `docker/Dockerfile` is architecture-neutral on purpose: the base image
  (`node:22-bookworm-slim`) is multi-arch and the app has no native build step,
  so a single published manifest can carry both platforms.
- The release workflow publishes `linux/amd64` **and** `linux/arm64` off one
  image build (`docker/setup-qemu-action` supplies the emulation for the arm64
  layer). One tag therefore runs on a normal host and on a Raspberry Pi with no
  separate build.

## Bug status

| BUGS.md | fixed by |
| --- | --- |
| move to the next dug square is not automatic | dig completion moves the player in the same tick and sends the position; `game.test.js`, `protocol.test.js`, `e2e.test.js` |
| moving along a dug path triggers a dig | dug cells read as air and are entered directly; `game.test.js` |
| respawn shows the player in the wrong place | respawn carries an authoritative `you` and the client snaps to it; `game.test.js`, `client.test.js` |
| skin change needs a move to show | superseded: a class is now chosen once per run at entry and never switched mid-run, so there is no skin change to show |
| game reset does not move the player | `worldReset` detaches the player and re-asks for a class; `chooseClass` answers with a full state and the spawn position; `e2e.test.js`, `client.test.js` |
| ground layer must be dirt with grass | the surface row is always dirt and the client draws grass on it; `world.test.js` |
| pressing the same direction restarts the dig | same cell is ignored, timer untouched; `game.test.js` |
| WASD blocked on the login screen | the handler is scoped to the mine and never touches typing; `client.test.js` |
| WASD and the shortcuts only worked on an English keyboard layout | keys are read by their physical `event.code`, so the layout's character does not matter; `client.test.js` |
| a keypress after a dig moves the player anyway | the client adopts `you` from the message and never does position arithmetic; `client.test.js` |
| spawning inside the top dirt layer | players stand on `SURFACE_Y - 1`, above the surface row; `world.test.js`, `e2e.test.js` |
| armour does not protect from spikes | a spike strike is soaked by armour points first; only the leftover comes off health, and the player survives into the cell while any remains; `game.test.js` |
| traps only visible to spectators | the private snapshot carries the owner's own traps, and nothing else does; they are also cleared for the owner the moment one is sprung or blown up; `game.test.js`, `client.test.js`, `e2e.test.js` |
| relogin conceals revealed blocks | discovery is remembered per account for the run and restored on login; `game.test.js`, `e2e.test.js` |
| spectator camera cannot move | WASD and the arrows pan the camera, clamped to the world and deepest row reached, with a follow button to hand it back; `client.test.js` |
| trap leaves the player standing beside it | stepping into a trap moves the player into the trap's cell first, so position and cell agree; `game.test.js` |
| dynamite does not clear the cell you stand on | the blast is the eight neighbours plus its own centre, which is the cell a player survives spikes on; `game.test.js` |
| skin index is trusted from the socket | `Game.setClass` accepts only a whole number in `0..MODEL_COUNT` and refuses the rest with `ERR.INVALID_MODEL`; the login gate means no character spawns until a valid class is chosen, so a refused index cannot leave a body on the field; `game.test.js`, `e2e.test.js` |
| no tutorial is ever shown, or it is shown to the wrong people | `rules_seen` is a migrated account column answered in the login reply, and closing the popup is what records it; `db.test.js`, `client.test.js`, `e2e.test.js` |
| back and follow buttons overlap | the top controls are a wrapping flex row, and the two button groups are laid out as a row; `client.test.js` |
| an undiscovered cell is indistinguishable from a dug one | unknown cells are flat grey underground, excavated air is dark speckled dirt without a grass cap, and the sky above the surface stays sky; `client.test.js` |
| any spectator can be shown the whole field | the frame is filtered server-side by mode; only a socket holding `ADMIN_SECRET` gets the generated field, and an unrecognised or missing mode falls back to `public`; `protocol.test.js`, `e2e.test.js` |
| collected items reappear on the open cell | the dug cell is air with no item, so a resync cannot draw loot that is already in an inventory; the client also clears the cell on `blockDug` and on `digComplete`; `world.test.js`, `protocol.test.js`, `client.test.js` |
| dying on spikes happens without ever entering them | the move into the cell succeeds, and when the strike takes the last of the player's health the tick kills them `SPIKES_DEATH_DELAY_MS` later, where they stand; actions are refused while dying and the death is paid once; `game.test.js`, `client.test.js` |
| watching does nothing from the login screen | three faults, all needed: the frame handler threw a `TypeError` while clearing the scoreboard (`children.length = 0`, and `length` on an `HTMLCollection` is a getter with no setter), which aborted the handler before it revealed the view; `#spectator` had no positioning of its own, so it sat in the normal flow; and the absolutely positioned `#login`, which lives outside `#game`, stayed on top. The board now uses `replaceChildren()`; `client.test.js` |
| the spectator view is announced nowhere | a centred banner in the top half of the screen, inside `#spectator` so it cannot fall out of step with the view, naming the view and the two ways out; `client.test.js` |
| watching cannot be cancelled without Esc | the on-screen buttons toggle, so the one you pressed to get in takes you back out; `client.test.js` |
| the tutorial button only opens the popup | the button is a toggle, like the menu, and shares its close path; `client.test.js` |
| the top-right windows stack on top of each other | the panels are a mutually exclusive set, the tutorial is modal (row locked, shortcuts ignored), and spectator mode closes them and is left when a panel opens; `client.test.js` |
| no flash when a fighter takes damage | the client remembers the last HP it drew and adds a one-shot `hit` class when it drops; `client.test.js` |
| the spectator button is smaller than the rest | the top-right row is a uniform set of fixed square buttons, with the small eye-glyph font size removed; `client.test.js` |
| the spectator Follow selector hangs over the field | it is a bordered, bold, dark box; `client.test.js` |

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
