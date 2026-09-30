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
  const first = spectatorFrame(h.game, cache);
  assert.strictEqual(first.blocks.length, 100);
  assert.strictEqual(spectatorFrame(h.game, cache).blocks.length, 0, 'nothing changed yet');

  p.digging = { x: p.x, y: 0, dir: 'down', startedAt: h.at(), duration: 10 };
  h.advance(20);
  h.game.tick();
  const after = spectatorFrame(h.game, cache);
  assert.ok(after.blocks.some((b) => b.x === p.x && b.y === 0 && b.type === 'air'), 'the dug cell is resent');
  assert.ok(after.blocks.length <= 2, 'and nothing else is');
  assert.strictEqual(spectatorFrame(h.game, cache).blocks.length, 0);
});

test('spectator frames show the world width and where traps are', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  p.inventory.trap = 1;
  h.game.placeTrap(p);
  const f = spectatorFrame(h.game, new Map());
  assert.strictEqual(f.width, 50);
  assert.strictEqual(f.surfaceY, 0);
  assert.strictEqual(f.traps.length, 1);
  assert.deepStrictEqual(f.traps[0], { x: p.x, y: p.y, ownerId: p.id });
});

test('a spectator frame stops carrying cells nobody has discovered any more', () => {
  const h = harness();
  const p = h.game.addPlayer({ code: 'C1', name: 'Ann' });
  const cache = new Map();
  assert.strictEqual(spectatorFrame(h.game, cache).blocks.length, 100);
  p.discovered.clear();
  assert.strictEqual(spectatorFrame(h.game, cache).blocks.length, 0);
  assert.strictEqual(cache.size, 0);
});
