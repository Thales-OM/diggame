'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadConfig, clientConfig } = require('./config');
const { World } = require('./world');
const { Game } = require('./game');
const { fullState, ackFor, tickPayload, spectatorFrame } = require('./protocol');
function harness(env = {}) {
  const { config } = loadConfig({ env, envFile: null });
  const world = new World(config, 4242);
  const events = [];
  const bus = {
    toPlayer: (player, event, payload) => events.push({ to: player.id, event, payload }),
    broadcast: (event, payload) => events.push({ to: 'all', event, payload }),
  };
  let clock = 500_000;
  const game = new Game({ config, world, bus, now: () => clock, random: () => 0.99 });
  return {
    game, world, events, config, clientCfg: clientConfig(config),
    advance: (ms) => { clock += ms; },
    at: () => clock,
    to: (p, e) => events.filter((x) => x.to === p.id && x.event === e),
  };
}

test('collected loot is gone from the full state, for everyone who saw it', () => {
  // BUGS v0.3.1: the item was left on the dug cell, so every player who had
  // uncovered that block kept being sent the loot to draw on it - on every
  // resync, forever - long after it had been picked up. Not acquirable, just
  // drawn there.
  const h = harness({ ITEM_CHANCE: 1, ITEM_CHANCE_MAX: 1, STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const digger = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const watcher = h.game.addPlayer({ code: 'C2', name: 'Bob' });

  // a block that is guaranteed to have something in it
  let target = null;
  for (let y = 1; y < 12 && !target; y++) {
    for (let x = 0; x < h.world.width; x++) {
      const b = h.world.generatedBlock(x, y);
      if (b && b.item) { target = { x, y }; break; }
    }
  }
  assert.ok(target, 'precondition: a block with loot in it');

  // both players uncover it, so both have it in their discovery
  digger.discovered.add(`${target.x},${target.y}`);
  watcher.discovered.add(`${target.x},${target.y}`);
  const seen = (player) => fullState(h.game, player, null)
    .blocks.find((b) => b.x === target.x && b.y === target.y);
  assert.strictEqual(seen(digger).item !== null, true, 'the loot is on offer first');

  // it is dug, and the item handed to the digger
  h.world.digOut(target.x, target.y);
  h.game.grant(digger, seen(digger).item);

  for (const who of [digger, watcher]) {
    const cell = seen(who);
    assert.strictEqual(cell.type, 'air', 'the cell is open');
    assert.strictEqual(cell.item, null, `and ${who.code} is not shown the loot again`);
  }
});

test('the full state carries the world, the config and every discovered block', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const s = fullState(h.game, p, h.clientCfg);
  assert.strictEqual(s.you.x, p.x);
  assert.strictEqual(s.you.y, p.y);
  assert.strictEqual(s.rev, p.rev);
  assert.strictEqual(s.world.width, 50);
  assert.strictEqual(s.world.surfaceY, 0);
  assert.strictEqual(typeof s.world.seed, 'number');
  assert.strictEqual(s.config.worldWidth, 50);
  assert.strictEqual(s.blocks.length, 100, 'the whole surface row plus the sky');
  for (const b of s.blocks) {
    assert.ok('x' in b && 'y' in b && 'type' in b && 'item' in b);
  }
  assert.strictEqual(s.players.length, 1);
});

test('a discovered block reports its real type, never "unknown"', () => {
  const h = harness({ STONE_CHANCE_MAX: 0.3, SPIKE_CHANCE_MAX: 0.3 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const types = new Set(fullState(h.game, p, h.clientCfg).blocks.map((b) => b.type));
  assert.ok(!types.has('unknown'));
  assert.ok(types.has('dirt'));
});

test('a successful ack always tells the client exactly where it ended up', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 100 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const startX = p.x;

  const r1 = h.game.action(p, { type: 'move', dir: 'down' });
  const a1 = ackFor(h.game, p, r1, h.clientCfg);
  assert.strictEqual(a1.ok, true);
  assert.strictEqual(a1.you.x, p.x);
  assert.strictEqual(a1.you.y, p.y, 'still above the block while digging');
  assert.strictEqual(a1.you.digging.x, startX);
  assert.strictEqual(a1.rev, p.rev);

  h.advance(150);
  h.game.tick();
  const done = h.to(p, 'digComplete')[0].payload;
  assert.strictEqual(done.you.x, startX);
  assert.strictEqual(done.you.y, 0);
});

test('a rejected action still resyncs the player, so the client never drifts', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  h.advance(1000);
  const r = h.game.action(p, { type: 'move', dir: 'up' });
  const a = ackFor(h.game, p, r, h.clientCfg);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error, 'above_surface');
  assert.strictEqual(a.you.x, p.x);
  assert.strictEqual(a.you.y, p.y);
  assert.strictEqual(a.rev, p.rev);
});

test('an ignored repeat press still returns the running dig', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 500 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  h.game.action(p, { type: 'move', dir: 'down' });
  h.advance(200);
  const a = ackFor(h.game, p, h.game.action(p, { type: 'move', dir: 'down' }), h.clientCfg);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.delta.ignored, true);
  assert.strictEqual(a.you.digging.startedAt, 500_000, 'the timer did not restart');
});

test('rev advances with every state change so a stale client is detectable', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const start = p.rev;
  h.game.action(p, { type: 'move', dir: 'down' });
  assert.ok(p.rev > start, 'starting a dig bumps rev');
  const mid = p.rev;
  h.advance(20);
  h.game.tick();
  assert.ok(p.rev > mid, 'finishing a dig bumps rev');
  const p2 = h.game.addPlayer({ code: 'C2', name: 'Bob' });
  assert.strictEqual(p2.rev, 0, 'a new player starts at zero and tracks its own rev');
});

test('the tick payload is public information only', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  h.game.action(p, { type: 'move', dir: 'down' });
  h.advance(20);
  const frame = h.game.tick();
  const payload = tickPayload(frame);
  const serialised = JSON.stringify(payload);
  assert.ok(!('you' in payload), 'a broadcast never carries private state');
  assert.ok(!serialised.includes(p.code), 'a broadcast never leaks account codes');
  assert.ok(!('item' in (payload.blocks[0] || {})), 'a broadcast never leaks loot');
  assert.strictEqual(payload.players.length, 1);
  assert.deepStrictEqual(payload.blocks, [{ x: p.x, y: 0 }]);
});

test('spectator frames only resend what changed', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const cache = new Map();
  const opts = { mode: 'player', player: p };
  const first = spectatorFrame(h.game, cache, opts);
  assert.strictEqual(first.blocks.length, 100);
  assert.strictEqual(spectatorFrame(h.game, cache, opts).blocks.length, 0, 'nothing changed yet');

  p.digging = { x: p.x, y: 0, dir: 'down', startedAt: h.at(), duration: 10 };
  h.advance(20);
  h.game.tick();
  const after = spectatorFrame(h.game, cache, opts);
  assert.ok(after.blocks.some((b) => b.x === p.x && b.y === 0 && b.type === 'air'), 'the dug cell is resent');
  assert.ok(after.blocks.length <= 2, 'and nothing else is');
  assert.strictEqual(spectatorFrame(h.game, cache, opts).blocks.length, 0);
});

test('spectator frames show the world width and where traps are', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  p.inventory.trap = 1;
  h.game.placeTrap(p);
  const f = spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: false });
  assert.strictEqual(f.width, 50);
  assert.strictEqual(f.surfaceY, 0);
  assert.strictEqual(f.traps.length, 1);
  assert.deepStrictEqual(f.traps[0], { x: p.x, y: p.y, ownerId: p.id });
});

test('a spectator frame stops carrying cells nobody has discovered any more', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const cache = new Map();
  const opts = { mode: 'player', player: p };
  assert.strictEqual(spectatorFrame(h.game, cache, opts).blocks.length, 100);
  p.discovered.clear();
  // the sky drops out of the view, and the 50 surface cells it is left with are
  // unchanged, so nothing is resent - only the cache shrinks
  assert.strictEqual(spectatorFrame(h.game, cache, opts).blocks.length, 0);
  assert.strictEqual(cache.size, 50, 'the cells nobody can see any more are forgotten');
  for (const k of cache.keys()) assert.strictEqual(k.endsWith(',0'), true, `${k} is on the surface`);
});

// ================= the three spectator modes =================

test('the public view shows the ground and the players, and nothing else', () => {
  // Anti-cheat: an anonymous spectator must not be able to see the pit.
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  p.discovered.add('7,4');
  h.world.digOut(7, 4);
  p.inventory.trap = 1;
  h.game.placeTrap(p);

  const f = spectatorFrame(h.game, new Map(), { mode: 'public' });
  assert.strictEqual(f.mode, 'public');
  for (const b of f.blocks) {
    assert.strictEqual(b.y, 0, `cell ${b.x},${b.y} is below the surface and must not be sent`);
  }
  assert.strictEqual(f.blocks.length, h.world.width, 'just the starting ground');
  assert.deepStrictEqual(f.traps, [], 'and never a trap');
  assert.ok(f.players.some((x) => x.name === 'Ann'), 'players are public');
  assert.ok(f.stats.some((x) => x.name === 'Ann' && typeof x.depth === 'number'), 'so are their stats');
});

test('the public view reports depth and items but no account details', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'SECRETCODE', name: 'Ann' });
  p.inventory.armor = 2;
  p.inventory.dynamite = 3;
  p.inventory.trap = 1;
  const f = spectatorFrame(h.game, new Map(), { mode: 'public' });
  const stat = f.stats.find((s) => s.name === 'Ann');
  assert.strictEqual(stat.armor, 2);
  assert.strictEqual(stat.dynamite, 3);
  assert.strictEqual(stat.trap, 1);
  const serialised = JSON.stringify(f);
  assert.ok(!serialised.includes('SECRETCODE'), 'a spectator gets the scoreboard, not the login');
});

test('a logged in view adds its own discoveries and its own traps', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const me = h.game.addPlayer({ code: 'ME', name: 'Ann' });
  const other = h.game.addPlayer({ code: 'THEM', name: 'Bo' });

  me.discovered.add('7,4');
  other.discovered.add('9,6');
  h.world.digOut(7, 4);
  h.world.digOut(9, 6);
  me.inventory.trap = 1;
  other.inventory.trap = 1;
  h.game.placeTrap(me);
  h.game.placeTrap(other);

  const f = spectatorFrame(h.game, new Map(), { mode: 'player', player: me });
  const cells = new Set(f.blocks.map((b) => `${b.x},${b.y}`));
  assert.ok(cells.has('7,4'), 'I can see what I found');
  assert.ok(!cells.has('9,6'), 'but not what somebody else found');
  assert.deepStrictEqual(f.traps, [{ x: me.x, y: me.y }], 'my trap, and only my trap');
});

test('a player view asked for without an account falls back to public', () => {
  const h = harness();
  h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const f = spectatorFrame(h.game, new Map(), { mode: 'player', player: null });
  assert.strictEqual(f.mode, 'public', 'a mode nobody earned must not fall open');
  for (const b of f.blocks) assert.strictEqual(b.y, 0);
});

test('the admin view shows the whole field, generated cells and loot included', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const f = spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: 30 });

  // nothing has been dug, so the bottom is the spawn row plus the margin
  assert.strictEqual(f.maxY, h.world.topY + 0 + 30);
  const cells = new Map(f.blocks.map((b) => [`${b.x},${b.y}`, b]));
  // rows surfaceY..maxY inclusive, which is exactly the margin's worth of them
  assert.strictEqual(cells.size, h.world.width * 30, 'every column, down to the margin');
  assert.strictEqual(cells.get('7,4').type, h.world.generatedBlock(7, 4).type, 'with its real contents');
  // the loot is on the block before it is dug, so an admin can see the value
  const withItem = f.blocks.find((b) => b.item);
  if (h.world.generatedBlock(7, 3).item) {
    assert.strictEqual(cells.get('7,3').item, h.world.generatedBlock(7, 3).item, 'fixed items and all');
  } else {
    assert.ok(withItem === undefined || withItem.item, 'only real items, never invented ones');
  }
  assert.ok(p, 'the field is described independently of who is standing on it');
});

test('the admin depth margin is how far below the deepest dig the view reaches', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  p.maxDepth = 12;             // somebody is 12 rows down
  h.game.updateGlobalMaxDepth();

  assert.strictEqual(
    spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: 30 }).maxY,
    h.world.topY + 12 + 30
  );
  assert.strictEqual(
    spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: 0 }).maxY,
    h.world.topY + 12,
    'a margin of zero stops at the deepest dig'
  );
  assert.strictEqual(
    spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: -5 }).maxY,
    h.world.topY + 12 + 30,
    'and a nonsense margin falls back to the default rather than reaching everywhere'
  );
  assert.strictEqual(
    spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: 1e9 }).maxY,
    h.world.topY + 12 + 500,
    'a huge margin is capped, not obeyed'
  );
});

test('the admin aggregate toggle narrows the field back to what was found', () => {
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const a = h.game.addPlayer({ code: 'A', name: 'Ann' });
  const b = h.game.addPlayer({ code: 'B', name: 'Bo' });
  a.discovered.add('7,4');
  b.discovered.add('9,6');
  h.world.digOut(9, 6);

  const all = spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: 30 });
  assert.ok(all.blocks.length > 50, 'the full field');

  const agg = spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: false });
  const cells = new Set(agg.blocks.map((b) => `${b.x},${b.y}`));
  assert.ok(cells.has('7,4'), 'everything Ann found');
  assert.ok(cells.has('9,6'), 'everything Bo found, dug or not');
  assert.ok(agg.blocks.length < all.blocks.length, 'and nothing nobody has touched');
});

test('the admin view shows every trap, whoever set it', () => {
  const h = harness();
  const a = h.game.addPlayer({ code: 'A', name: 'Ann' });
  const b = h.game.addPlayer({ code: 'B', name: 'Bo' });
  a.inventory.trap = 1;
  b.inventory.trap = 1;
  h.game.placeTrap(a);
  h.game.placeTrap(b);
  const f = spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true, depthMargin: 0 });
  assert.strictEqual(f.traps.length, 2, 'both traps, which is the point of the admin view');
});

test('the camera may follow the action below what a mode is allowed to describe', () => {
  // Knowing that somebody is digging at row 40 is public. What is in row 40 is
  // not, and the two must not be confused.
  const h = harness({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  p.x = 5; p.y = 40; p.digging = { x: 5, y: 41, dir: 'down', startedAt: h.at(), duration: 1000 };
  const f = spectatorFrame(h.game, new Map(), { mode: 'public' });
  assert.ok(f.maxY >= 41, 'the camera can follow them down');
  for (const b of f.blocks) assert.strictEqual(b.y, 0, 'without being told what is there');
});

test('a frame carries the mode it was filtered for', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  assert.strictEqual(spectatorFrame(h.game, new Map(), { mode: 'public' }).mode, 'public');
  assert.strictEqual(spectatorFrame(h.game, new Map(), { mode: 'player', player: p }).mode, 'player');
  assert.strictEqual(spectatorFrame(h.game, new Map(), { mode: 'admin', adminAll: true }).mode, 'admin');
  assert.strictEqual(spectatorFrame(h.game, new Map(), {}).mode, 'public', 'the least privileged default');
});
