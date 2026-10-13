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


