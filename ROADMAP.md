# v0.5.0

- emotes: short public expressions (wave, smile, shout, oops, thumbs up) drawn as a bubble above the player's head, visible to everyone including logged-out spectators, lasting a couple of seconds and rate-limited by a cooldown
- a single emote button (shortcut P) at the top of the screen opens a small popup of clickable emote buttons, closed with Esc like the other dialogs, instead of a permanent row of buttons over the field

# v0.4.0

- blocks yet undiscovered by player are now not blank space on the screen but greyed out blocks - helps fill the visual void space on the game field
- there are three spectator modes now: 1) non-logged in (available from login page) see players stats (depth, items), positions and the starting ground, no info about the discovered underground blocks and traps (prevent cheating) 2) logged in (in addition to what non-logged in sees, add the blocks you have discovered and your traps (other players traps are hidde, prevents cheating)) 3) admin (protected by the admin secret key) (see everything on the field including yet undiscovered blocks and their fixed items (+ all players traps), has toggle to display only the aggregate of what has been discovered by all players, depth of visible field spans to the dippest digged by any player yet +30 (toggleabe parameter) blocks).
- add a Rules button next to the spectator mode and menu at the top of the screen that displays game rules with small example grids (is scrollable)(pop it up for new players automatically)
- the blocks that have been digged up (e.g. dirt) or cleared up by the explosives also display a texture not a blank field, distinct from the yet undiscovered blocks, e.g. a really darkened dirt color to be visually distinct from usual dirt blocks
- create button shortcuts for player game options (V - spectator mode, M - menu, Esc - exit currently open spectator mode or pop up menu/Rules). Display these shortcuts in brackets next to the popup name of the button (e.g. menu, spectator mode buttons) or next to the Close button of the already open window for close shortcut.
