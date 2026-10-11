# v0.6.0-pre3

- a join window can be cut short: **Start** begins a gate fight at once, and allies may still join until the window's original deadline lapses
- a post-boss **loot window**: a win holds the party on a screen listing what each survivor gained, and Confirm returns them to the field (the server keeps the fight in a `result` phase until everyone confirms)
- the battle **Action** button is renamed **Attack**, and a new **Skill** button opens the skills offered by the equipped weapon (character skills later), or says "No skills"

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
