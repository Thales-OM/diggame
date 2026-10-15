# Unreleased

- **one rules file**: every tunable rule number - the pit, its odds, digging times, gates, boss and battle maths, weapons, species multipliers, class skills - now lives in `config/game.json`, loaded and validated strictly at boot by `server/gameconfig.js`. A missing file, bad JSON, an unknown or missing key, a wrong type, an out-of-range value, or a species list that does not match the client art is a `[fatal]` startup error and `exit(1)` instead of a silent default. `.env` is now infrastructure only (listen address, database path, secrets, tick rates, seed); `GAME_CONFIG` points at the rules file. The rest of the server still reads one merged `config` with the same key names
- **one pooled health bar**: health is now a single bar (`MAX_HP`) that you carry from the field into a fight and back, drawn in the corner with the armour points it would spend first, and refilled on spawn, respawn and a new run. Spikes no longer kill outright - a strike deals fixed damage that **armour soaks first** (`ARMOUR_POINTS_PER_ITEM` points per pickup, banked through a fight instead of being consumed piece by piece), and the leftover comes off health. A **potion** mends health on the field from the Items tab (a **Use** button) as well as in battle, for `ITEM_HEAL`
- five character **classes** - **Wizard**, **Knight**, **Barbarian**, **Noble**, **Bandit** - each with its own 16x16 field sprite and a larger battle pose, replacing the flat coloured blocks. The class is now chosen at **entry**, once per run: a mandatory popup shows every class as a large battle sprite with its name beneath and its description on hover, a click highlights it with a rounded border and unlocks **Confirm**, and only then is the character spawned onto the field. A new run (a world reset) detaches everyone and asks again
- **class skills**, passive and active, listed in each class's description and on the battle screen's **Skill** tab (with their descriptions on hover). Passives are shown dimmed and do not fire; actives can be pressed, and a spent active is dimmed too. **Wizard** - *Magic knowledge* (passive): the Magic Staff is wizard-only, to wield, to pick up and as boss loot. **Knight** - *Weapon expertise* (passive): sword and rapier hit harder. **Barbarian** - *Hardened knuckles* (passive): bare fists hit harder, and *Battle cry* (active, once per battle): roar back 30% health. **Noble** - *Noblesse oblige* (active): spend 10% health to rally every other member, who then hit 25% harder on their next turn. **Bandit** - *Agile footwork* (active): +25% accuracy on the next two attacks. Buffs are applied before criticals, so they stack with a crit
- a **constant offline warning**: when the connection drops, a non-dismissable veil covers the game with a large red **OFFLINE** heading and a line saying why, and only the reconnect clears it (the small status word and toast are still there beneath it)
- a **Bare-handed** weapon every class now starts with, so a player can always put a weapon away and fight with their hands. Picking a weapon up, or winning one, only adds it to the bag - nothing is auto-equipped any more; the player chooses what to hold from the inventory, and Bare-handed is always there to switch back to
- boss **species**: minibosses climb a species per `BOSS_SPECIES_TIER_DEPTH` blocks of depth (Overgrown Maggot, Malicious Fairy, Undead Knight, Ancient Wyvern, Ancient God Cultist), and each gate is guarded in turn by a Fallen Angel, the Traces of an ancient God, the Stalwart Butler, then a Man-made Abomination. A species is a name plus hp/attack multipliers on top of the boss's usual size, and every species has its own battle art. The species is hidden on the field - every boss cell stays the same red tile - and revealed only when the fight opens. Species carry reserved `attacks` / `lines` fields for later.
- **finer battle art**: a sprite is now drawn at a fixed on-screen footprint (`BOSS_FOOT` / `HERO_FOOT` / `CARD_FOOT`) instead of a fixed multiplier, so it can be redrawn on a larger pixel grid and read as more detail at the same size. Every class and every boss species is now redrawn at 48px (up from 20px) in a tragic dark-fantasy style - the **Knight** with a plumed great helm, a kite shield and a sword, the **Fallen Angel** haloed with spread feather wings, and the rest alongside them - while the fallback `warden`/`brute` poses stay coarse at the same footprint.
- the top-bar windows are now **exclusive**: opening the Menu, Inventory, Emotes or Tutorial closes whichever other one was open, and entering **Spectator mode** clears them too. The Tutorial is also **modal** - while it is up the top-bar buttons are locked and its shortcuts are ignored, until it is finished or skipped. `Esc` still closes the one window that is open, topmost first
- a fighter **flashes white** for an instant when a blow lands in battle, so damage is something you see and not only a bar that moved
- a tidier **top bar** and **spectator controls**: the top-right buttons are a uniform row of squares (the eye button is no longer drawn smaller than the rest), and the **Follow** selector sits in its own bold, dark box instead of hanging over the field

# v0.7.0

- a proper **Tutorial**: the first-login hint is now a centred, paged popup rather than a scrolling top-right dropdown. One essential idea per page, and each page carries a small slice of the field with a legend naming only the blocks it introduces. **Back** / **Next** / **Skip**, with the last page hiding Skip and offering **Got it**; Skip, Got it and `Esc` all record it as read, so it opens by itself once per account and reopens from page one on demand. The fights page ends with a bullet list of every weapon - sprite, its damage/hit/crit numbers and its description
- the Tutorial no longer claims that dynamite leaves stone standing: a blast clears plain stone, and only **bedrock** and a boss cell survive it
- the **boss** cell is a red tile with crossed swords instead of a purple tile with a skull - it is the cell you dig into to fight, not a death marker
- the container image is published for **linux/amd64 and linux/arm64** off one tag, so the same release runs on a normal host and on a Raspberry Pi

## Assessment - what to improve next

A short read of where the game and the code stand, and what is most worth doing
next. Not a commitment, just the honest list.

- **Balance.** The catch-up loot bonus and `WEAPON_WEIGHTS` are the only knobs
  helping a player who is behind, and neither has been tuned against real play.
  The extended loot-drop analysis (effective useful-drop rate once you own a
  weapon) is a good starting point but is still unacted on.
- **Combat depth.** Every class now carries a passive, an active, or both, and
  the battle **Skill** menu lists them alongside the staff's incantation. The
  numbers are still first guesses and the two attack-boosting actives share one
  shape; a wider, more distinct set of skills (and per-species boss attacks and
  dialogue, already reserved in the monster table) is the natural next step.
- **A run has no end.** The pit is endless and standings are per-world snapshots,
  so "winning" a run is only ever relative. An explicit goal (a final depth, a
  scored cut-off, a leaderboard freeze) would give a run a shape.
- **Client size.** `public/client.js` is a single large file owning field
  rendering, the tutorial, inventory, battle and spectator views. Each is a
  natural module boundary as they keep growing.
- **Layout is untested in a browser.** The client tests read the stylesheet to
  catch an unpositioned panel, but there is no real-browser layout test, so
  visual regressions only surface by eye.
- **Discovery is in memory.** A run's discovered-block memory is per-process and
  lost on restart, and `SHARE_DISCOVERIES` stays off. If runs are meant to resume
  after a restart, this is the piece to persist.

# v0.6.0-pre3

- a join window can be cut short by its **initiator**: **Start** begins a gate fight at once (only for whoever opened it), and allies may still join until the window's original deadline lapses
- a post-boss **loot window**: a win holds the party on a screen listing what each survivor gained, and Confirm returns them to the field (the server keeps the fight in a `result` phase until everyone confirms)
- the battle **Action** button is renamed **Attack**, and a new **Skill** button opens the skills offered by the equipped weapon (character skills later), or says "No skills"
- a healing potion can be aimed at an ally: a keyboard cursor (←/→, Enter, Esc) walks the party and heals whoever is chosen, while a whole-health member refuses it. Skills carry the same `target` through the server for later use
- battle-screen fixes: item counts show instead of **undefined**, the running order keeps every participant and rotates the actor to the back, the Item/Skill tabs swap rather than stacking, and only the initiator can cut the wait short

# v0.6.0-pre2

- a proper full-screen JRPG battle screen: the boss facing the party, names and bars (red health, grey armour, equal width, points shown), the running order down the side, the field concealed, and a slight wobble on whoever is acting

# v0.6.0

- bedrock gates: every so often a solid, undiggable band of bedrock crosses the whole field with a single gap, so the only way on is through the gap (dynamite cannot shift it)
- bosses: a boss sits in each gate's gap, and lesser minibosses are seeded in the levels between gates, each in a small dug-out chamber. Digging into a boss starts a fight. A miniboss is a solo duel that begins at once; a gate boss posts a 15s join window to the pit first, and up to four players may enter, first come first served
- turn-based battle: while you are in a fight the field is frozen and you take turns with the boss - attack, defend (halve the next blow), use an item (dynamite, a trap, or a healing potion), or, with the staff, spend a turn charging an incantation. Your field armour is spent protecting you and whatever is left comes back when the fight ends. Dying or disconnecting leaves the fight; a wiped party leaves the boss at full strength for the next try
- weapons and loot: beating a boss rolls a weapon (sword, rapier, staff with an incantation) and a pool of consumables that is split evenly among the survivors. Weapons are earned only from fights, never dug from the dirt; you carry every weapon you have won and pick which one to wield out of battle
- inventory popup (shortcut I) with an Items tab and a Weapon tab, where you equip a weapon; the battle runs as an overlay on the same screen, with the boss's health, your party's health, your action buttons and a fight log

# v0.5.0

- emotes: short public expressions (wave, smile, shout, oops, thumbs up) drawn as a bubble above the player's head, visible to everyone including logged-out spectators, lasting a couple of seconds and rate-limited by a cooldown
- a single emote button (shortcut P) at the top of the screen opens a small popup of clickable emote buttons, closed with Esc like the other dialogs, instead of a permanent row of buttons over the field

# v0.4.0

- blocks yet undiscovered by player are now not blank space on the screen but greyed out blocks - helps fill the visual void space on the game field
- there are three spectator modes now: 1) non-logged in (available from login page) see players stats (depth, items), positions and the starting ground, no info about the discovered underground blocks and traps (prevent cheating) 2) logged in (in addition to what non-logged in sees, add the blocks you have discovered and your traps (other players traps are hidde, prevents cheating)) 3) admin (protected by the admin secret key) (see everything on the field including yet undiscovered blocks and their fixed items (+ all players traps), has toggle to display only the aggregate of what has been discovered by all players, depth of visible field spans to the dippest digged by any player yet +30 (toggleabe parameter) blocks).
- add a Rules button next to the spectator mode and menu at the top of the screen that displays game rules with small example grids (is scrollable)(pop it up for new players automatically)
- the blocks that have been digged up (e.g. dirt) or cleared up by the explosives also display a texture not a blank field, distinct from the yet undiscovered blocks, e.g. a really darkened dirt color to be visually distinct from usual dirt blocks
- create button shortcuts for player game options (V - spectator mode, M - menu, Esc - exit currently open spectator mode or pop up menu/Rules). Display these shortcuts in brackets next to the popup name of the button (e.g. menu, spectator mode buttons) or next to the Close button of the already open window for close shortcut.
