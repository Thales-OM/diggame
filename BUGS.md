# Unreleased

- the top-right windows stacked: opening the Menu and then the Inventory (or the Emotes, or the Tutorial) left two or three panels over the field at once. They are now mutually exclusive - opening one closes the rest - and entering **Spectator mode** closes the panels too, while opening a panel from the spectator view leaves the view first. The **Tutorial** is now modal: while it is up the top-right buttons are locked and its shortcuts are ignored, so nothing can be raised over it until it is finished or skipped. `Esc` still closes the one window that is open
- a blow in the battle screen only moved a bar, with no visual jolt to say damage had landed. A fighter now flashes white for an instant when its HP or its armour drops - so a fully-armoured fighter flashes even when the blow is soaked and its health never moves. The same blow reaches the actor as two renders (the state event, then the action's ack), and the second used to rebuild the sprite and wipe the flash before it was painted; a short flash window now holds the jolt through the redraw and releases it once the blow is over
- the **Spectator mode** button was drawn smaller than the others in the top-right row. The eye glyph had its own smaller font size; the row is now a uniform set of fixed squares
- the spectator **Follow** selector was a bare label hanging over the field. It now sits in its own dark, bordered box and is set bold
- the old mid-game **skin change** (and its lag, which needed a move to show) is gone entirely: a class is now chosen once per run at entry and cannot be switched mid-run, so there is no half-applied skin to fall out of step with what everyone else sees, and no character is spawned at all until a class is confirmed
- a character could enter the pit with no class if the picker was skipped: login is now **gated** on the choice, answered with `needsClass` and the class list and **no player**, and only a valid `chooseClass` spawns one
- a picked-up weapon was auto-equipped, and once you held one there was no way back to bare hands. Now every class starts with a **Bare-handed** weapon that can be switched to from any other, and picking a weapon up (or winning one) only adds it to the bag - the player equips it by hand
- armour was all-or-nothing against spikes and a separate bar inside a fight: one piece was spent and you walked on unharmed, none meant instant death. Armour is now banked as **points** (`ARMOUR_POINTS_PER_ITEM` per pickup) that soak a fixed strike off the field against the same health a boss blow reaches, so a spike hit only kills when it takes the last of your health - a partly-drained player dies where a full one walks on
- health was a battle-only value, refilled for every fight and thrown away between them. It is now **one persistent bar** (`MAX_HP`), kept across the field and a fight and back, refilled on spawn, respawn and a new run, and drawn in the corner of the HUD with the armour points it would spend first beside it
- a potion could only ever be drunk inside a battle. It can now be used on the field from the Items tab (**Use**), mending `ITEM_HEAL` and cancelling any dig - refused with "No potion left." when the bag is empty and "You are already at full health." when nothing is missing
- the movement keys and shortcuts only worked on an **English layout**: the handler read `e.key`, the layout's character, so on a Russian, Greek or AZERTY keyboard `W` arrived as `ц` (and so on) and nothing moved. The handler now reads the physical `e.code` (`KeyW`, `ArrowUp`, ...), with `e.key` as a fallback for a key `code` cannot name, so WASD and `Q`/`E`/`V`/`M`/`P`/`I` work on any layout
- a gate was solid **bedrock** with one pre-cut gap, so the whole pit funnelled through a single column and there was nothing to do at the wall but walk into the gap. Gate bands are now rows of purple **mist**: dug like dirt, and finishing the dig raises a blocking **Are you ready?** prompt to face the gatekeeper behind it - or, if a fight is already running on that tile, a join offer naming the boss and the party, honouring the same cap and window. Winning opens the **whole row** at that depth for the winning party (and only them: everyone else still sees a wall and can earn their own fight), a death takes the opened rows back, a reconnect keeps them, and a new run wipes them

# v0.2.0

- the move to the next digged square is not automatic
- movement along already digged path also triggers load/dig timed animation
- respawn may fail to display the player until next movement or even display incorrect blocks (e.g. something above ground; player model stays in place but seemingly digs above ground while leaving around grey blocks, visible player position does not update until player starts digging into the ground)
- skin change is not instant and required movement/dig to next block
- ~~the dig action can be cancelled~~ that's okay
- game field reset does not update position for player until they make the next move
- the ground layer must be all dirt blocks with green grass sprayed on top
- when digging in one direction, pressing the same direction button restarts the wait time (must be ignored, any other action must stop the digging and start another animation (if diging in another direction or item use was requested))
- WASD buttons are blocked on login screen -> cannot enter names like Alice etc.
- when the block was digged successfully (e.g. the block below), any button press (e.g. right) still moves the player to the digged block location (e.g down)
- after respawn ot at game start, the player is spawned in most upper layer of dirt, not above ground (on dirt)
- wearing armor does not protect from spikes

# v0.3.0 - pre-release

- traps are only visible to spectators, must also be visible to the ones who placed them
- relogin under the same player into an existing game (that you have already played in) conceals all previously revealed blocks
- spectator mode does not allow camera movement over game field, must freely move with WASD

# v0.3.0

- changing player skin still takes an action (digging or item use) to take effect, must be instant
- "Back to game" button overlaps "Follow" button in spectator mode
- When stepping into a trap the player remains in the previous block, MUST still step into the trap block, and only then be trapped there
- Bomb usage must also clear out the cell the player is currently standing on (e.g. the player is on spikes and survived)

# v0.3.1 - pre-release

- Items reappear after picking up, not acquirable but as images. Visible to all players who uncovered the block.
- Death in spikes happens without entering the spikes block after you pressed the direction button. Must be: enter spikes block animation, then death triger + movememnt block and notification, then respawn
- Spectator mode does not work: 1) logged out mode does not do anything after pressing the button on the screen 2) logged in mode just blocks your player action and movement buttons, does not allow moving camera (no help for camera move displayed too), can be cancelled with Esc (but not the on-screen button repeated press) to return to normal game
- pop-up Rules window cannot be closed by pressing on-screen Rules button, only by Esc

# v0.5.0 - pre-release

- emote buttons do nothing: clicking one shows no emote from any point of view (own, another player's, or a logged-out spectator). `server.js` rebuilt the action payload field by field and dropped the emote id, so every emote reached the game as an unknown emote and was refused; the client's glyph lookup was also declared inside an unrelated callback, so even an accepted emote could not be drawn
- the emotes were a permanent row of buttons on the field instead of a single emote button that opens a small popup

# v0.6.0 - pre-release

- armour banked into a fight did not come back on a win. `finishBattle` only refunded unspent armour on some outcomes, so a victory swallowed whole pieces that had never absorbed a hit; the refund is now on every ending (win, lose, death, disconnect), turning the leftover escrow points back into `floor(points / BATTLE_ARMOUR_PER_ITEM)` pieces
- `server.js` rebuilt the action payload field by field and dropped the battle item id, the same way it once dropped the emote id; `useBattleItem` would have received a use with no item to use

# v0.6.0-pre1

- The inventory popup window on game field works, but the hover over item/weapon should display description/stats
- Weapons display a description, but statically next to weapon name. Must also be on hover.

# v0.6.0-pre3

- a player in a gate-boss join window was stuck waiting it out, with no way to start early. `startBattle` now begins the fight at once (a **Start** button on the battle screen), and the window still takes latecomers until `BOSS_JOIN_WINDOW_MS` elapses
- only the encounter's **initiator** may cut the wait short. `startBattle` refuses anyone else with `no_join`, the Start button is only drawn when `battleView.initiator` is you, and the others just see the wait countdown
- the join countdown only moved when the 5s fallback sync fired. The battle screen now ticks the countdown every frame from the server's `joinDeadline`
- the Items tab of the battle menu showed **undefined** for every count. `battleView.me` now carries `dynamite`/`trap`/`potion` from the player's real stock
- the turn-order list on the right got shorter as turns were spent. It is now a fixed ring of every participant (the boss included), the spent actor rotating to the back, with the new current actor highlighted
- the battle submenus toggled independently, so clicking Items then Skills left **both** lists open. Opening one now closes the other
- a healing potion could only ever heal its bearer. Items flagged `ally` now open a target cursor (←/→ to walk the party, Enter to throw, Esc to cancel) and heal the chosen member, refused with "HP is full" if they are already whole; skills reuse the same plumbing

# v0.7.0 - pre-release

- the admin secret could never be typed. Choosing **Admin** in the spectator panel did not reveal the secret box, and the only thing that did reveal it was a successful admin spectate - which cannot happen without the secret. `syncSpecPanel` (which shows `#specAdminOpts`) only ran on entering the view and on a successful request, never on the `specMode` change that picks Admin; a `change` listener now shows the field at once
- the spectator camera only ever followed the mean of every living player, with a single "Follow" button. It is now a **Follow** dropdown - Manual, Deepest player, or any named player (clicking a scoreboard row follows that player too) - and drops back to Manual when the watched player leaves the field or the pit empties
- the view mode could not be switched at all. The `change` listener added above re-ran `syncSpecPanel`, which writes the agreed mode back into the select, so the picked option snapped to the old one before the request was read - logged out it stayed on `public`, logged in on `player`. The handler now shows the admin options and requests the picked mode on the spot
- choosing **Admin** now prompts for the secret and remembers the one the server accepts in `localStorage`, so returning to the view does not ask again; a remembered secret that is refused is forgotten, and the box is emptied and focused for a retry
- the Tutorial and the dynamite item hint claimed a blast "would not shift" stone, but `useDynamite` clears plain stone and leaves only bedrock and a boss cell standing. The tutorial page, the block legend and the item tooltip now say so


