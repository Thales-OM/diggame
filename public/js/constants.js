// ---------- Constants ----------
// Fixed vocabularies: colours, key maps, block legend, tutorial pages
// and the small integer constants the rest of the client reads.

import { el } from './state.js';
import { showEmotes, hideEmotes, showRules, hideRules, tutorialOpen, showProfile, hideProfile } from './ui.js';
import { showInventory, hideInventory } from './battle.js';

export const TILE = 32;

export const ERRORS = {
  stone: 'Stone — that will not budge.',
  occupied: 'Someone is standing there.',
  stuck: 'You are stuck in a bear trap!',
  wall: 'A wall.',
  above_surface: 'You cannot go higher than the surface.',
  not_diggable: 'Nothing to dig there.',
  no_dynamite: 'No dynamite left.',
  no_trap: 'No bear traps left.',
  no_item: 'No potion left.',
  hp_full: 'You are already at full health.',
  dead: 'You are dead. Waiting to respawn…',
  dying: 'The spikes have you.',
  invalid_emote: 'That emote is not recognised.',
  emote_cooldown: 'You are doing that a little too fast.',
  in_battle: 'You are in a fight — finish it first.',
  not_in_battle: 'You are not in a fight.',
  not_your_turn: 'It is not your turn.',
  invalid_battle_action: 'You cannot do that here.',
  no_skill: 'That weapon has no skill.',
  invalid_weapon: 'You do not own that weapon.',
  no_join: 'That fight is no longer open.',
  battle_full: 'That fight is already full.',
};

// How long a wound keeps its white flash. A single hit can reach the client as
// two renders (the state event that carries the drop, then the action's own
// ack with the very same hp), and both rebuild the sprite. Holding the flash
// open for a moment means the second render keeps flashing instead of wiping a
// fresh animation off the screen before it is ever painted.
export const FLASH_MS = 400;

// The admin secret is a shared server secret, so the server never sends it back.
// Remembering locally what was accepted means returning to the Admin view does
// not ask again; a refusal clears it and asks afresh.
export const ADMIN_SECRET_KEY = 'diggame.adminSecret';

export const SPEC_ERRORS = {
  bad_admin_secret: 'That is not the admin secret.',
  admin_view_disabled: 'The admin view is switched off on this server.',
  not_logged_in: 'Log in first to watch your own discoveries.',
};

// The popup's buttons, and the glyph the bubble above a head draws. Kept in one
// list so the button and the bubble can never disagree about an emote.
export const EMOTE_LIST = [
  { id: 'wave', glyph: '👋', label: 'Wave' },
  { id: 'smile', glyph: '🙂', label: 'Smile' },
  { id: 'shout', glyph: '💢', label: 'Shout' },
  { id: 'oops', glyph: '😳', label: 'Oops' },
  { id: 'thumbsup', glyph: '👍', label: 'Thumbs up' },
];

/**
 * The block alphabet, one legend row per block type. The page grids below use
 * these exact characters, and the swatches use the same colours the canvas
 * does, so a legend and the field cannot drift apart.
 */
export const BLOCKS = {
  sky: { ch: '~', name: 'Sky', cls: 'sky', note: 'above the surface; you cannot dig it' },
  surface: { ch: '=', name: 'Surface', cls: 'surface', note: 'plain dirt with grass on top; never stone or spikes' },
  dirt: { ch: '#', name: 'Dirt', cls: 'dirt', note: 'walk into it to start digging; the dig clears itself and you step down' },
  stone: { ch: 'S', name: 'Stone', cls: 'stone', note: 'cannot be dug, but a dynamite blast clears it' },
  spikes: { ch: '^', name: 'Spikes', cls: 'spikes', note: 'drains your health; armour soaks the strike first' },
  dug: { ch: 'o', name: 'Dug out', cls: 'dug', note: 'cleared by a dig or a blast; walk freely, no timer' },
  loot: { ch: 'd', name: 'Dirt with loot', cls: 'dirt item', note: 'the item is waiting where it is drawn' },
  item: { ch: '*', name: 'Item', cls: 'item', note: 'armour, golden shovel, dynamite or a bear trap' },
  mist: { ch: 'X', name: 'Gate mist', cls: 'mist', note: 'a solid wall of purple mist; dig in to face the gatekeeper and open the way' },
  boss: { ch: '@', name: 'Boss', cls: 'boss', note: 'dig into it to fight; win a weapon' },
  unknown: { ch: '?', name: 'Unknown', cls: 'unknown', note: 'nobody has looked there yet' },
};

/**
 * The tutorial, one essential idea per page. Each page carries a small slice of
 * the field (drawn with the same block alphabet as the game) and a legend that
 * names only the blocks it introduces, so a page can be read on its own.
 */
export const TUTORIAL_PAGES = [
  {
    title: 'Welcome to the pit',
    html: 'Everybody starts on the surface of one shared pit. Dig down, mind the spikes, and try to finish deepest. Death only sends you back to the top - your best depth is kept.',
    grid: [
      '~~~~~~~~~~',
      '==========',
      '##########',
      '##########',
    ],
    legend: ['sky', 'surface', 'dirt'],
  },
  {
    title: 'Moving and digging',
    html: 'Arrows or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move you one cell. You only ever stand in empty cells, so walking a tunnel is instant and starts no timer. Walking into dirt starts a dig; the block clears itself and you step down into it. Pressing the same direction again while digging does nothing, so you cannot restart your own timer by accident.',
    grid: [
      '##########',
      '#o########',
      '#o########',
      '#o########',
    ],
    legend: ['dirt', 'dug'],
  },
  {
    title: 'Stone and spikes',
    html: 'Stone cannot be dug - go round it, or clear it with <em>dynamite</em>. Spikes cost you health: <em>armour</em> soaks the strike first and only what is left over comes off your bar, but you end up standing on them, so stepping off and back on costs you again. If your health runs out you die. Caught on spikes, dig sideways - the dig will still finish.',
    grid: [
      '#S#^#####',
      '#o#o#####',
      '#S#o#####',
      '#S#^#####',
    ],
    legend: ['stone', 'spikes'],
  },
  {
    title: 'Reading the field',
    html: 'Every cell you discover is remembered, even after you move away. Cells nobody has looked into stay flat grey, and cells that have been dug read as dark tunnels. This is the whole alphabet.',
    grid: [
      '~~~~~~~~~~',
      '==========',
      '#S#^#d#o#S',
      '#d#*#^#o#d',
      '#X#@#S#?#o',
      '##########',
    ],
    legend: ['sky', 'surface', 'dirt', 'stone', 'spikes', 'dug', 'loot', 'item', 'mist', 'boss', 'unknown'],
  },
  {
    title: 'Loot in the dirt',
    html: 'Some dirt blocks hold an item, drawn on the block itself so you can judge a dig before you start it. Once an item is taken it is gone for everyone, and a resync never draws it back. <em>Armour</em> is banked as points that soak spikes and boss blows, a <em>golden shovel</em> digs faster for a minute, a <em>potion</em> mends health, and there is dynamite and the bear trap.',
    grid: [
      '#d#*#d####',
      '#o#o#o####',
      '#d#d#d####',
      '##########',
    ],
    legend: ['loot', 'item'],
  },
  {
    title: 'Health and potions',
    html: 'You have one bar of health, shown in the corner, and it stays with you as you dig and as you fight. A <em>potion</em> mends it: press <kbd>I</kbd> and use one from your pack here on the field, or drink it in a fight. A full bar wastes nothing - the potion is kept for later.',
    grid: [
      '#####',
      '#^#o#',
      '#o#*#',
      '#o#o#',
      '#####',
    ],
    legend: ['spikes', 'dug', 'item'],
  },
  {
    title: 'Dynamite and traps',
    html: '<kbd>Q</kbd> blows dynamite: it clears the eight cells around you <em>and the one you are standing on</em>, so it frees you even from spikes. <kbd>E</kbd> sets a bear trap under your feet - secret to everybody else, and whoever walks into it is stuck for a minute. The on-screen buttons do the same.',
    grid: [
      '#####',
      '#ooo#',
      '#ooo#',
      '#ooo#',
      '#####',
    ],
    legend: ['dug'],
  },
  {
    title: 'Gates and gatekeepers',
    html: 'Every so often the pit is crossed by a wall of solid purple mist. It cannot be blown open: dig into it and you are asked whether to face the gatekeeper behind it. Win the fight and the whole row of mist opens at that depth - for you and everyone who fought with you - so you can carry on down. Smaller minibosses lurk in the levels between the gates, dug into like any block.',
    grid: [
      'XXXXXXXXXX',
      'XXXXXXXXXX',
      '#S###d##S#',
      '##########',
    ],
    legend: ['mist'],
  },
  {
    title: 'Fights and weapons',
    html: 'A fight is turn-based: on your turn you can Attack, Defend, use an Item, or a Skill from your weapon. The field is frozen until it ends, and the health and armour you carried in fight with you - armour is spent first, and whatever health and armour are left come back when the fight is over. Weapons are only won from fights, never dug from the dirt; press <kbd>I</kbd> to pick which one to carry.',
    weapons: true,
    grid: [
      '#####',
      '#ooo#',
      '#o@o#',
      '#ooo#',
      '#####',
    ],
    legend: ['boss', 'dug'],
  },
  {
    title: 'Watching, score and your code',
    html: '<kbd>V</kbd> switches to spectator mode, even before you log in. Depth is how far below the spawn row you are, and your best depth is the number other players are measured by. Your code, shown in the menu, brings back your stats and everything you have dug - enter it next time to keep your place.',
    grid: [
      '??????????',
      '#o#S#^#o##',
      '##########',
    ],
    legend: ['unknown', 'dug'],
  },
];

export const POPUP = {
  tutorial: {
    isOpen: tutorialOpen,
    close: hideRules,
    open: showRules,
  },
  emotes: {
    isOpen: () => !el.emotePanel.classList.contains('hidden'),
    close: hideEmotes,
    open: showEmotes,
  },
  inventory: {
    isOpen: () => !el.inventoryPanel.classList.contains('hidden'),
    close: hideInventory,
    open: showInventory,
  },
  profile: {
    isOpen: () => !el.profile.classList.contains('hidden'),
    close: hideProfile,
    open: showProfile,
  },
};

// Scoped to the game view, and it never blocks typing: a keypress while the
// login form or a text field has focus is left alone (BUGS: "the keydown
// handler preventsDefault's on everything, so you cannot type your name").
export const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
  q: 'useDynamite', Q: 'useDynamite',
  e: 'placeTrap', E: 'placeTrap',
};

/** Panel shortcuts, checked before the movement table because none of them are
 *  movement keys and Esc has to work no matter what else it would have meant. */
export const SHORTCUTS = {
  v: 'spectator', V: 'spectator',
  m: 'menu', M: 'menu',
  p: 'emotes', P: 'emotes',
  i: 'inventory', I: 'inventory',
};

// The physical key, not the layout's character: WASD and every shortcut must
// read the same on a Russian, Greek or AZERTY keyboard (BUGS: "WASD movement
// keys work only in English"). `e.code` names the physical position regardless
// of layout; `e.key` is the fallback for any key `code` cannot name, and for
// stubs that set only `key`.
export const CODE_KEYS = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e',
  KeyV: 'v', KeyM: 'm', KeyP: 'p', KeyI: 'i',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Space: ' ', Enter: 'Enter', Escape: 'Escape',
};

export const COLORS = {
  dirt: '#8b5a2b',
  grass: '#4a8a2c',
  stone: '#8a8a8a',
  spikes: '#c8c8c8',
  // the gate wall: a purple mist that hides a gatekeeper behind it
  mist: '#6a1b9a',
  boss: '#c62828',
  // a cell nobody has discovered: flat grey, so the pit reads as solid rock you
  // simply have not looked into yet
  unknown: '#333',
  // a cell that has been dug out or blown clear: the same dirt, taken right
  // down, so an excavated tunnel is obviously not a blank hole
  dug: '#2b1c10',
};

export const SPEC_SPEED = 9;      // blocks per second

export const SPEC_MIN_Y = -6;     // a couple of rows of sky above the surface
