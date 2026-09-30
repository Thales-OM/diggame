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
