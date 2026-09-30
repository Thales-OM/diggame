'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('./config');
const { World, BLOCK } = require('./world');
const { Game, ERR, MODEL_COUNT } = require('./game');

function makeGame(env = {}, opts = {}) {
  const { config } = loadConfig({ env, envFile: null });
  const world = new World(config, opts.seed ?? 1234);
  const events = [];
  const bus = {
    toPlayer: (player, event, payload) => events.push({ to: player.id, event, payload }),
    broadcast: (event, payload) => events.push({ to: 'all', event, payload }),
  };
  let clock = 1_000_000;
  const randoms = opts.randoms ? [...opts.randoms] : null;
  const random = opts.random
    || (randoms ? () => (randoms.length ? randoms.shift() : 0.5) : () => 0.5);
  const game = new Game({
    config,
    world,
    bus,
    now: () => clock,
    random,
  });
  return {
    game,
    world,
    bus,
    events,
    config,
    advance: (ms) => { clock += ms; return clock; },
    at: () => clock,
    to: (player, event) => events.filter((e) => e.to === player.id && e.event === event),
    all: (event) => events.filter((e) => e.event === event),
    clear: () => { events.length = 0; },
    join: (over = {}) => game.addPlayer({ code: over.code || 'C1', name: over.name || 'Ann', ...over }),
  };
}

// Put a player at a specific cell, bypassing the movement rules.
function place(game, p, x, y) {
  p.x = x;
  p.y = y;
  game.world.revealAround(p.discovered, x, y);
  return p;
}

test('a new player stands on the surface, above the dirt', () => {
  const g = makeGame();
  const p = g.join();
  assert.strictEqual(p.y, g.world.topY);
  assert.strictEqual(p.y, -1);
  assert.strictEqual(g.world.generatedBlock(p.x, p.y + 1).type, BLOCK.DIRT);
  assert.strictEqual(p.maxDepth, 0);
  assert.ok(p.discovered.has(g.world.key(p.x, 0)), 'must see the ground under their feet');
});

test('two players never share a cell', () => {
  const g = makeGame();
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  assert.notStrictEqual(a.x, b.x);
});

test('moving into an already dug cell is instant and starts no dig', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = g.join();
  g.world.digOut(p.x, 0);      // somebody already tunnelled under us
  const r = g.game.requestMove(p, 'down');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.digging, null, 'BUG: walking a dug tunnel must not start a dig timer');
  assert.strictEqual(p.y, 0);
});

test('pressing the same direction while digging is ignored and keeps the timer', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  const startedAt = p.digging.startedAt;
  g.advance(400);

  const r = g.game.requestMove(p, 'down');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ignored, true);
  assert.ok(p.digging, 'the dig must survive the repeated press');
  assert.strictEqual(p.digging.startedAt, startedAt, 'BUG: the wait time must not restart');
});

test('a different direction cancels the dig and starts the new one', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 1000, SHOVEL_DIG_TIME_MS: 1000 });
  const p = g.join();
  place(g, p, p.x, 0); // stand in a dug cell so sideways is diggable
  g.game.requestMove(p, 'down');
  assert.ok(p.digging);
  g.advance(100);
  g.game.requestMove(p, 'right');
  assert.ok(p.digging, 'the new dig replaced the old one');
  assert.strictEqual(p.digging.dir, 'right');
  assert.strictEqual(p.digging.duration, 1000);
});

test('an impossible direction does not disturb the dig', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  const startedAt = p.digging.startedAt;
  assert.strictEqual(g.game.requestMove(p, 'up').error, ERR.ABOVE_SURFACE);
  assert.ok(p.digging, 'pressing a blocked direction is not a new action');
  assert.strictEqual(p.digging.startedAt, startedAt);
});

test('using an item cancels the dig in progress', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const p = g.join();
  p.inventory.dynamite = 1;
  g.game.requestMove(p, 'down');
  assert.ok(p.digging);
  const r = g.game.useDynamite(p);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.digging, null, 'BUG: dynamite must interrupt the current dig');
});

test('a finished dig moves the player in and tells them exactly where they are', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 500 });
  const p = g.join();
  const fromX = p.x;
  g.game.requestMove(p, 'down');
  assert.strictEqual(p.y, g.world.topY, 'not moved until the dig completes');

  g.advance(600);
  g.game.tick();

  assert.strictEqual(p.y, 0, 'BUG: the dig must move you into the block');
  assert.strictEqual(p.x, fromX);
  assert.strictEqual(p.digging, null);
  const ev = g.to(p, 'digComplete');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].payload.you.x, fromX);
  assert.strictEqual(ev[0].payload.you.y, 0);
  assert.ok(g.world.isDug(fromX, 0));
  // neighbours below are now known
  assert.ok(p.discovered.has(g.world.key(fromX, 1)));
});

test('a dig completes at the depth record and updates max depth', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = g.join();
  for (let i = 0; i < 3; i++) {
    g.game.requestMove(p, 'down');
    g.advance(20);
    g.game.tick();
  }
  assert.strictEqual(p.y, 2);
  assert.strictEqual(p.maxDepth, 3);
  assert.strictEqual(p.runStats.blocksDug, 3);
});

test('the dig timer is shortened by the golden shovel', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 900, SHOVEL_DIG_TIME_MS: 200 });
  const p = g.join();
  place(g, p, p.x, 0);
  g.game.requestMove(p, 'down');
  assert.strictEqual(p.digging.duration, 900);
  p.inventory.shovelUntil = g.at() + 60_000;
  g.game.requestMove(p, 'right');
  assert.strictEqual(p.digging.duration, 200);
});

test('a dig whose block was blown up is aborted, not silently completed', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 500 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  g.world.digOut(p.x, 0); // e.g. someone else's dynamite
  g.advance(600);
  g.game.tick();
  assert.strictEqual(p.digging, null);
  assert.strictEqual(p.y, g.world.topY, 'must not teleport into a block that is gone');
  assert.strictEqual(g.to(p, 'digComplete').length, 0);
  assert.strictEqual(g.to(p, 'digAborted').length, 1);
});

test('only one of two diggers gets the contested block', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 500, WORLD_WIDTH: 8 });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  const cell = g.world.key(a.x, 0);
  a.digging = { x: a.x, y: 0, dir: 'down', startedAt: g.at(), duration: 500 };
  b.digging = { x: a.x, y: 0, dir: 'down', startedAt: g.at(), duration: 500 };
  g.advance(600);
  g.game.tick();
  const dug = [...g.world.dug].filter((k) => k === cell).length;
  assert.strictEqual(dug, 1);
  assert.strictEqual(g.to(a, 'digComplete').length + g.to(b, 'digComplete').length, 1);
  assert.strictEqual(g.to(a, 'digAborted').length + g.to(b, 'digAborted').length, 1);
});

test('stone cannot be entered', () => {
  const g = makeGame({ STONE_CHANCE_BASE: 1, STONE_CHANCE_MAX: 1, SPIKE_CHANCE_MAX: 0 });
  const p = g.join();
  place(g, p, p.x, 0); // one layer down, past the always-diggable surface
  assert.strictEqual(g.world.generatedBlock(p.x, 1).type, BLOCK.STONE);
  const r = g.game.requestMove(p, 'down');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, ERR.STONE);
  assert.strictEqual(p.digging, null);
});

test('you cannot walk through a wall or above the sky', () => {
  const g = makeGame();
  const p = g.join();
  assert.strictEqual(g.game.requestMove(p, 'up').error, ERR.ABOVE_SURFACE);
  p.x = 0;
  assert.strictEqual(g.game.requestMove(p, 'left').error, ERR.WALL);
  p.x = g.world.width - 1;
  assert.strictEqual(g.game.requestMove(p, 'right').error, ERR.WALL);
});

test('a player blocks the cell they stand in', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, WORLD_WIDTH: 8 });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  g.world.digOut(5, 0);
  place(g, a, 5, 0);
  place(g, b, 6, 0);
  assert.strictEqual(g.game.requestMove(b, 'left').error, ERR.OCCUPIED);
  assert.strictEqual(b.x, 6);
});

test('spikes step you in, and then kill you where you are', () => {
  // BUGS v0.3.1: dying on the spot left the model standing in the cell it came
  // from, so the player was never actually impaled by the block they walked
  // into. The move has to succeed, and the death has to come after it.
  const g = makeGame({
    STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, WORLD_WIDTH: 8,
    RESPAWN_DELAY_MS: 1000, SPIKES_DEATH_DELAY_MS: 350,
  });
  const p = g.join();
  const startY = p.y;
  g.world.dug.delete(g.world.key(p.x, 0));
  g.world.generatedBlock = () => ({ x: p.x, y: 0, type: BLOCK.SPIKES, item: null });

  const r = g.game.requestMove(p, 'down');
  assert.strictEqual(r.ok, true, 'walking into spikes is not a rejected move');
  assert.strictEqual(r.delta.moved, true, 'we are told we moved');
  assert.strictEqual(r.delta.dying, true);
  assert.strictEqual(p.y, startY + 1, 'and we are standing in the spikes block');
  assert.strictEqual(p.alive, true, 'for the moment');
  assert.strictEqual(p.runStats.deaths, 0, 'the death has not happened yet');
  assert.ok(p.dyingAt > 0, 'but it is booked');

  // ...and nothing can be done about it in the meantime
  assert.strictEqual(g.game.action(p, { type: 'move', dir: 'left' }).error, ERR.DYING);
  assert.strictEqual(g.game.action(p, { type: 'useDynamite' }).error, ERR.DYING);
  assert.strictEqual(p.y, startY + 1, 'so we go nowhere');

  g.advance(200);
  g.game.tick();
  assert.strictEqual(p.alive, true, 'still alive just before the delay is up');
  assert.strictEqual(p.digging, null);

  g.advance(200);
  g.game.tick();
  assert.strictEqual(p.alive, false, 'and dead once it is');
  assert.strictEqual(p.dyingAt, 0, 'with the pending death cleared');
  assert.strictEqual(p.y, startY + 1, 'in the spikes, not next to them');
  assert.strictEqual(p.runStats.deaths, 1);
  const ev = g.to(p, 'state');
  assert.strictEqual(ev[ev.length - 1].payload.reason, 'died');
  assert.strictEqual(ev[ev.length - 1].payload.cause, 'spikes');
});

test('a zero death delay still steps into the spikes first', () => {
  const g = makeGame({ WORLD_WIDTH: 8, SPIKES_DEATH_DELAY_MS: 0 });
  const p = g.join();
  const startY = p.y;
  g.world.dug.delete(g.world.key(p.x, 0));
  g.world.generatedBlock = () => ({ x: p.x, y: 0, type: BLOCK.SPIKES, item: null });
  assert.strictEqual(g.game.requestMove(p, 'down').ok, true);
  assert.strictEqual(p.y, startY + 1, 'the step-in is not conditional on the delay');
  g.game.tick();
  assert.strictEqual(p.alive, false);
  assert.strictEqual(p.y, startY + 1, 'and the death lands where we stepped in');
});

test('the spikes death is only paid once, however many ticks go by', () => {
  const g = makeGame({ WORLD_WIDTH: 8, SPIKES_DEATH_DELAY_MS: 10, RESPAWN_DELAY_MS: 5000 });
  const p = g.join();
  g.world.dug.delete(g.world.key(p.x, 0));
  g.world.generatedBlock = () => ({ x: p.x, y: 0, type: BLOCK.SPIKES, item: null });
  g.game.requestMove(p, 'down');
  g.advance(50);
  for (let i = 0; i < 5; i++) g.game.tick();
  assert.strictEqual(p.runStats.deaths, 1, 'one death, not one per tick');
});

test('other players are told a player is dying, so the step-in is visible to them', () => {
  const g = makeGame({ WORLD_WIDTH: 8, SPIKES_DEATH_DELAY_MS: 100 });
  const p = g.join();
  const watcher = g.join({ code: 'W' });
  g.world.dug.delete(g.world.key(p.x, 0));
  g.world.generatedBlock = () => ({ x: p.x, y: 0, type: BLOCK.SPIKES, item: null });
  g.game.requestMove(p, 'down');
  const pub = g.game.publicPlayer(p);
  assert.strictEqual(pub.dying, true, 'the public player says so');
  assert.strictEqual(pub.alive, true);
  void watcher;
});

test('a respawn clears the spikes, so the next death starts clean', () => {
  const g = makeGame({ WORLD_WIDTH: 8, SPIKES_DEATH_DELAY_MS: 0, RESPAWN_DELAY_MS: 100 });
  const p = g.join();
  g.world.dug.delete(g.world.key(p.x, 0));
  g.world.generatedBlock = () => ({ x: p.x, y: 0, type: BLOCK.SPIKES, item: null });
  g.game.requestMove(p, 'down');
  g.game.tick();
  assert.strictEqual(p.alive, false);
  g.advance(200);
  g.game.tick();
  assert.strictEqual(p.alive, true, 'back');
  assert.strictEqual(p.dyingAt, 0, 'with no death still pending');
  assert.strictEqual(p.y, g.world.topY, 'and on the surface');
});

test('armour survives a spikes hit, keeps the spikes, and costs one per entry', () => {
  const g = makeGame({ WORLD_WIDTH: 8, RESPAWN_DELAY_MS: 1000, SPIKES_DEATH_DELAY_MS: 0 });
  const p = g.join();
  p.inventory.armor = 2;
  g.world.generatedBlock = (x, y) => (y === 0 ? { x, y, type: BLOCK.SPIKES, item: null } : { x, y, type: BLOCK.DIRT, item: null });

  const r1 = g.game.requestMove(p, 'down');
  assert.strictEqual(r1.ok, true, 'armour should let you through');
  assert.strictEqual(p.alive, true);
  assert.strictEqual(p.inventory.armor, 1);
  assert.strictEqual(p.y, 0, 'you end up standing in the spikes');
  assert.strictEqual(r1.delta.spikesAbsorbed, true);
  assert.ok(!g.world.isDug(p.x, 0), 'the spikes block is preserved');
  assert.strictEqual(g.world.generatedBlock(p.x, 0).type, BLOCK.SPIKES);

  // leave and come back: another hit
  g.world.digOut(p.x + 1, 0);
  g.game.requestMove(p, 'right');
  const r2 = g.game.requestMove(p, 'left');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(p.inventory.armor, 0);
  assert.strictEqual(p.runStats.spikesSurvived, 2);

  // and the third time there is nothing left to spend
  g.world.digOut(p.x + 1, 0);
  g.game.requestMove(p, 'right');
  g.game.requestMove(p, 'left');
  assert.strictEqual(p.dyingAt > 0, true, 'the spikes have us this time');
  g.game.tick();
  assert.strictEqual(p.alive, false);
  assert.strictEqual(p.y, 0, 'and we died in them');
});

test('death cancels the dig and respawn puts you on top of the ground', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, RESPAWN_DELAY_MS: 1500 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  g.game.kill(p, 'test');
  assert.strictEqual(p.digging, null, 'a dead player must not keep digging');

  g.advance(1000);
  g.game.tick();
  assert.strictEqual(p.alive, false, 'still dead before the timer');

  g.advance(600);
  g.game.tick();
  assert.strictEqual(p.alive, true);
  assert.strictEqual(p.y, g.world.topY, 'BUG: you must respawn above the dirt, not inside it');
  assert.strictEqual(p.inventory.armor, 0, 'inventory resets on respawn');
});

test('a respawn is cancelled if the player leaves in the meantime', () => {
  const g = makeGame({ RESPAWN_DELAY_MS: 1000 });
  const p = g.join();
  g.game.kill(p, 'test');
  g.game.removePlayer(p);
  g.advance(2000);
  g.game.tick();
  assert.strictEqual(g.to(p, 'respawned').length, 0);
});

test('a trapped player cannot move, and the trap is consumed', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, STUCK_DURATION_MS: 60000, WORLD_WIDTH: 8 });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  place(g, a, 5, 0);
  place(g, b, 6, 0);
  a.inventory.trap = 1;
  assert.strictEqual(g.game.placeTrap(a).ok, true);
  assert.strictEqual(a.inventory.trap, 0);

  const r = g.game.requestMove(b, 'left');
  assert.strictEqual(r.error, ERR.STUCK);
  assert.strictEqual(b.alive, true);
  assert.strictEqual(b.x, 6, 'you are caught where you walked in');
  assert.strictEqual(g.game.traps.size, 0, 'the trap is used up');
  assert.strictEqual(g.game.requestMove(b, 'up').error, ERR.STUCK);

  g.advance(61000);
  assert.strictEqual(g.game.requestMove(b, 'left').ok, true, 'free again after the duration');
});

test('the owner is told when somebody else springs their trap', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, STUCK_DURATION_MS: 60000, WORLD_WIDTH: 8 });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  place(g, a, 5, 0);
  place(g, b, 6, 0);
  a.inventory.trap = 1;
  g.game.placeTrap(a);

  g.clear();
  g.game.requestMove(b, 'left'); // walks into Ann's trap

  // the victim is told they are stuck
  assert.strictEqual(g.to(b, 'state').length, 1, 'the one who walked in is told');
  assert.strictEqual(g.to(b, 'state')[0].payload.reason, 'trapped');

  // and Ann is told her trap is gone, so her view corrects itself without
  // waiting for her to do anything
  const told = g.to(a, 'state');
  assert.strictEqual(told.length, 1, 'the owner is told as well');
  assert.strictEqual(told[0].payload.reason, 'trapRemoved');
  assert.deepStrictEqual(told[0].payload.trap, { x: a.x, y: a.y }, 'which trap, exactly');
  assert.deepStrictEqual(told[0].payload.you.traps, [], 'and her view no longer draws it');
  assert.ok(told[0].payload.you.rev > 0, 'with a usable revision for her next action');

  // nobody else hears about it
  assert.strictEqual(g.to(b, 'state').length, 1, 'no duplicate for the victim');
});

test('a blast tells the trap owner their trap is gone', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, WORLD_WIDTH: 8 });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  place(g, a, 5, 0);
  place(g, b, 6, 0);
  a.inventory.trap = 1;
  g.game.placeTrap(a);
  assert.strictEqual(g.game.traps.size, 1);

  b.inventory.dynamite = 1;
  g.clear();
  g.game.useDynamite(b);

  assert.strictEqual(g.game.traps.size, 0, 'the blast swept the trap up');
  const told = g.to(a, 'state');
  assert.strictEqual(told.length, 1, 'the owner hears about it');
  assert.strictEqual(told[0].payload.reason, 'trapRemoved');
  assert.deepStrictEqual(told[0].payload.you.traps, [], 'and stops drawing it');
});

test('you do not trigger your own trap', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, STUCK_DURATION_MS: 60000, WORLD_WIDTH: 8 });
  const a = g.join({ code: 'A' });
  a.inventory.trap = 1;
  g.game.placeTrap(a);
  assert.strictEqual(g.game.requestMove(a, 'up').error, ERR.ABOVE_SURFACE);
  assert.strictEqual(a.stuckUntil, 0);
});

test('dynamite clears the eight surrounding cells whatever they are', () => {
  const g = makeGame({ WORLD_WIDTH: 10 });
  const p = g.join();
  p.inventory.dynamite = 2;
  const cx = p.x;
  const cy = p.y;
  const before = g.world.dug.size;
  const r = g.game.useDynamite(p);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.inventory.dynamite, 1);
  assert.ok(r.delta.destroyed.length > 0);
  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (x === cx && y === cy) continue;
      if (x < 0 || x >= g.world.width) continue;
      assert.strictEqual(g.world.currentBlock(x, y).type, BLOCK.AIR, `cell ${x},${y} should be blown out`);
    }
  }
  assert.ok(g.world.dug.size > before);
  assert.strictEqual(g.all('boom').length, 1);
});

test('dynamite blows away a bear trap and aborts digs pointed at the rubble', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, WORLD_WIDTH: 10 });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  a.inventory.dynamite = 1;
  a.inventory.trap = 1;
  g.game.placeTrap(a);
  assert.strictEqual(g.game.traps.size, 1);
  // a second player camps the cell below, which is inside the blast radius,
  // and a trap is lying there
  g.game.traps.set(g.world.key(a.x, 0), { ownerId: b.id, x: a.x, y: 0 });
  b.digging = { x: a.x, y: 0, dir: 'left', startedAt: g.at(), duration: 1000 };
  g.game.useDynamite(a);
  assert.strictEqual(g.game.traps.size, 1, "only the trap inside the blast is destroyed");
  assert.ok(g.game.traps.has(g.world.key(a.x, -1)));
  assert.ok(g.world.isDug(a.x, 0), 'the targeted cell is rubble now');
  assert.strictEqual(b.digging, null, 'a dig into blown-up rubble is cancelled');
  assert.strictEqual(g.to(b, 'digAborted').length, 1);
});

test('dynamite with none in the bag does nothing', () => {
  const g = makeGame();
  const p = g.join();
  assert.strictEqual(g.game.useDynamite(p).error, ERR.NO_DYNAMITE);
  assert.strictEqual(g.game.placeTrap(p).error, ERR.NO_TRAP);
});

test('items are granted, and the block they came from is dug', () => {
  const g = makeGame({
    STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10,
    ITEM_CHANCE: 1, ITEM_CHANCE_MAX: 1, ITEM_WEIGHTS: 'dynamite:1',
  });
  const p = g.join();
  place(g, p, p.x, 0); // the surface row never holds loot
  assert.strictEqual(g.world.generatedBlock(p.x, 1).item, 'dynamite');
  g.game.requestMove(p, 'down');
  g.advance(20);
  g.game.tick();
  assert.strictEqual(p.inventory.dynamite, 1);
  assert.strictEqual(p.runStats.itemsCollected, 1);
  assert.strictEqual(g.world.currentBlock(p.x, 1).type, BLOCK.AIR);
});

test('a player behind the leader gets a consolation item from an empty block', () => {
  const g = makeGame(
    { STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10, ITEM_CHANCE: 0, ITEM_WEIGHTS: 'shovel:1' },
    { random: () => 0 } // always roll the dice in the player's favour
  );
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });

  // A digs deep first, one layer below the surface
  place(g, a, a.x, 0);
  for (let i = 0; i < 4; i++) {
    a.digging = { x: a.x, y: a.y + 1, dir: 'down', startedAt: g.at(), duration: 10 };
    g.advance(20);
    g.game.tick();
  }
  assert.strictEqual(a.y, 4);
  assert.strictEqual(a.maxDepth, 5, 'depth counts the blocks dug below the spawn line');
  assert.strictEqual(a.inventory.shovelUntil, 0, 'the leader gets nothing for free');
  assert.strictEqual(g.game.globalMaxDepth, 5);

  // B digs one empty block and gets the bonus
  place(g, b, b.x, 0);
  b.digging = { x: b.x, y: b.y + 1, dir: 'down', startedAt: g.at(), duration: 10 };
  g.advance(20);
  g.game.tick();
  assert.strictEqual(b.y, 1);
  assert.strictEqual(b.inventory.shovelUntil, g.at() + 60000, 'the catch-up roll must pay out');
  const ev = g.to(b, 'digComplete');
  assert.strictEqual(ev[0].payload.bonus, true);
  assert.strictEqual(ev[0].payload.item, 'shovel');
});

test('the leader never gets the catch-up bonus', () => {
  const g = makeGame(
    { STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10, ITEM_CHANCE: 0, ITEM_BONUS_BASE: 1, ITEM_BONUS_MAX: 1 },
    { random: () => 0 }
  );
  const a = g.join({ code: 'A' });
  a.digging = { x: a.x, y: 0, dir: 'down', startedAt: g.at(), duration: 10 };
  g.advance(20);
  g.game.tick();
  assert.strictEqual(a.inventory.shovelUntil, 0);
  assert.strictEqual(g.to(a, 'digComplete')[0].payload.bonus, false);
});

test('the snapshot is the authoritative truth the client renders', () => {
  const g = makeGame();
  const p = g.join();
  const s = g.game.snapshot(p);
  assert.strictEqual(s.x, p.x);
  assert.strictEqual(s.y, p.y);
  assert.strictEqual(s.alive, true);
  assert.strictEqual(s.depth, 0);
  // the snapshot carries the revision it was taken at, so a client that only
  // sees private events (digComplete, state) can still send a current rev
  // instead of having its next action rejected as stale
  assert.strictEqual(s.rev, p.rev);
});

test('the snapshot rev follows the player through a change', () => {
  const g = makeGame();
  const p = g.join();
  const before = g.game.snapshot(p).rev;
  g.game.action(p, { type: 'placeTrap' }); // refused, but a real call
  g.game.requestMove(p, 'down'); // a dig starts, which bumps the revision
  assert.ok(g.game.snapshot(p).rev > before, 'a change to the player moves the revision on');
});

test('a skin change shows up in the very next broadcast', () => {
  const g = makeGame();
  const p = g.join();
  assert.strictEqual(g.game.tick().players[0].model, 0);

  p.modelIndex = 3; // what the setModel handler does
  const frame = g.game.tick();
  assert.strictEqual(frame.players[0].model, 3, 'no movement or dig is needed to see it');
  assert.strictEqual(g.game.publicPlayer(p).model, 3);
  assert.strictEqual(g.game.snapshot(p).model, 3, 'and it is in our own state too');
});

test('a new run reseeds the world and puts everyone back on the surface', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  g.advance(20);
  g.game.tick();
  p.inventory.armor = 3;
  const oldSeed = g.world.seed;

  const newSeed = g.game.newRun(777);
  assert.strictEqual(newSeed, 777);
  assert.notStrictEqual(g.world.seed, oldSeed);
  assert.strictEqual(g.world.dug.size, 0);
  assert.strictEqual(p.y, g.world.topY);
  assert.strictEqual(p.maxDepth, 0);
  assert.strictEqual(p.inventory.armor, 0);
  assert.strictEqual(p.discovered.size, g.world.width * 2, 'only the surface is known again');
  assert.strictEqual(p.digging, null);
  assert.strictEqual(g.game.traps.size, 0);
});

test('a finished run hands its numbers over, and the new run starts empty', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  g.advance(20);
  g.game.tick();
  assert.strictEqual(p.runStats.blocksDug, 1);

  const finals = g.game.finishRunTotals();
  assert.strictEqual(finals.length, 1);
  assert.strictEqual(finals[0].code, p.code);
  assert.strictEqual(finals[0].delta.blocksDug, 1);
  assert.strictEqual(finals[0].delta.maxDepth, 1);
  const again = g.game.finishRunTotals();
  assert.strictEqual(again[0].delta.blocksDug, 0, 'taking them twice does not double count');
  assert.strictEqual(again[0].delta.deaths, 0);
  assert.strictEqual(again[0].delta.maxDepth, 1, 'max depth is absolute, so it is sent again');

  g.game.newRun(5);
  assert.strictEqual(p.runStats.blocksDug, 0, 'the new run starts from nothing');
  assert.strictEqual(p.maxDepth, 0);
  assert.strictEqual(p.x >= 0 && p.y === g.world.topY, true);
  assert.strictEqual(p.discovered.size, g.world.width * 2, 'only the fresh surface and sky rows are known');
});

test('a player who leaves mid-run keeps the run they earned', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  g.advance(20);
  g.game.tick();
  const code = p.code;

  g.game.removePlayer(p);
  const finals = g.game.finishRunTotals();
  assert.strictEqual(finals.length, 1, 'a disconnect does not throw the run away');
  assert.strictEqual(finals[0].code, code);
  assert.strictEqual(finals[0].delta.blocksDug, 1);

  // and reconnecting in the same run continues from there
  const back = g.game.addPlayer({ code, name: 'Back' });
  assert.strictEqual(back.runStats.blocksDug, 1);
  assert.strictEqual(back.maxDepth, 1);
});

test('repeated flushes never double count', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 10 });
  const p = g.join();
  let handedOver = 0;
  for (let i = 0; i < 3; i++) {
    g.game.requestMove(p, 'down');
    g.advance(20);
    g.game.tick();
    for (const { delta } of g.game.takeStatDeltas()) handedOver += delta.blocksDug;
  }
  assert.strictEqual(p.runStats.blocksDug, 3);
  const finals = g.game.finishRunTotals();
  assert.strictEqual(finals[0].delta.blocksDug, 0, 'the last flush already took it');
  assert.strictEqual(handedOver, 3, 'each block is handed to storage exactly once');
  assert.strictEqual(p.runStats.blocksDug, 3, 'the run total itself never shrinks');
});

test('the tick broadcasts positions, digs and dug blocks', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, DIG_TIME_MS: 500 });
  const p = g.join();
  g.game.requestMove(p, 'down');
  const t = g.game.tick();
  assert.strictEqual(t.players.length, 1);
  assert.strictEqual(t.players[0].id, p.id);
  assert.strictEqual(t.digs.length, 1);
  assert.strictEqual(t.digs[0].progress, 0);

  g.advance(500);
  const t2 = g.game.tick();
  assert.strictEqual(t2.digs.length, 0);
  assert.deepStrictEqual(t2.blocks, [{ x: p.x, y: 0 }]);
  const t3 = g.game.tick();
  assert.deepStrictEqual(t3.blocks, [], 'block changes are drained, not resent forever');
});

test('actions are refused while dead or with a bad direction', () => {
  const g = makeGame();
  const p = g.join();
  assert.strictEqual(g.game.action(p, { type: 'move', dir: 'sideways' }).error, 'invalid_dir');
  assert.strictEqual(g.game.action(p, { type: 'teleport' }).error, 'unknown_action');
  g.game.kill(p, 'test');
  assert.strictEqual(g.game.action(p, { type: 'move', dir: 'down' }).error, ERR.DEAD);
});

test('discovery stays private unless SHARE_DISCOVERIES is on', () => {
  const privateGame = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0 });
  const a = privateGame.join({ code: 'A' });
  const b = privateGame.join({ code: 'B' });
  const before = b.discovered.size;
  place(privateGame, a, a.x, 0);
  assert.strictEqual(b.discovered.size, before, 'Ann dug, Bob learned nothing');
  assert.strictEqual(privateGame.all('sharedDiscovery').length, 0);
});

test('SHARE_DISCOVERIES hands one player findings to the rest', () => {
  const g = makeGame({ STONE_CHANCE_MAX: 0, SPIKE_CHANCE_MAX: 0, SHARE_DISCOVERIES: 'true' });
  const a = g.join({ code: 'A' });
  const b = g.join({ code: 'B' });
  const beforeB = b.discovered.size;

  // a real dig, so it goes through the movement rules
  place(g, a, a.x, 0);
  assert.strictEqual(b.discovered.size, beforeB, 'nothing new yet');
  a.digging = { x: a.x, y: a.y + 1, dir: 'down', startedAt: g.at(), duration: 10 };
  g.advance(20);
  g.game.tick();

  assert.ok(b.discovered.size > beforeB, 'Bob now has part of Ann tunnel mapped');
  // revealAround reports the neighbours of a cell, not the cell the player is
  // standing in, so what travels is what Ann could see from down there
  assert.ok(b.discovered.has(g.world.key(a.x, 2)), 'the row below Ann');
  assert.ok(b.discovered.has(g.world.key(a.x - 1, 1)), 'and beside it');

  const shared = g.all('sharedDiscovery');
  assert.ok(shared.length >= 1);
  assert.strictEqual(shared[0].to, 'all');
  for (const blk of shared[0].payload.blocks) {
    assert.ok('x' in blk && 'y' in blk && 'type' in blk, 'shared findings carry real contents');
  }
  // and a full state now includes them
  const { fullState } = require('./protocol');
  const state = fullState(g.game, b, null);
  assert.ok(state.blocks.some((x) => x.x === a.x && x.y === 2), 'and it is in Bob full state');
});

// ================= BUGS v0.3.0 =================

test('you can see your own bear trap, and nobody else can', () => {
  const g = makeGame();
  const a = g.join({ code: 'C1', name: 'Ann' });
  const b = g.join({ code: 'C2', name: 'Bob' });
  a.inventory.trap = 1;

  g.game.placeTrap(a);
  const key = g.world.key(a.x, a.y);
  assert.ok(g.game.traps.has(key), 'the trap is on the field');

  // the owner sees it, at the cell they actually set it on
  const mine = g.game.snapshot(a).traps;
  assert.deepStrictEqual(mine, [{ x: a.x, y: a.y }], 'the placer sees their own trap');

  // ...and it is the only channel: no leak through the public view or the tick
  assert.strictEqual(g.game.publicPlayer(a).traps, undefined, 'not in the public view');
  assert.strictEqual(g.game.publicPlayer(b).traps, undefined, 'nor in anybody else public view');
  const bSees = g.game.snapshot(b).traps;
  assert.deepStrictEqual(bSees, [], 'a bystander sees no traps at all');

  // and the full state a client receives carries them
  const { fullState } = require('./protocol');
  assert.deepStrictEqual(fullState(g.game, a, null).you.traps, [{ x: a.x, y: a.y }],
    'and they arrive on a full sync too');
});

test('your trap disappears from your view once somebody springs it', () => {
  const g = makeGame();
  const a = g.join({ code: 'C1', name: 'Ann' });
  const b = g.join({ code: 'C2', name: 'Bob' });
  a.inventory.trap = 1;
  g.game.placeTrap(a);
  assert.strictEqual(g.game.snapshot(a).traps.length, 1);

  // Bob walks onto it
  b.x = a.x;
  b.y = a.y - 1;
  g.game.action(b, { type: 'move', dir: 'down' });

  assert.strictEqual(g.game.traps.size, 0, 'the trap is spent');
  assert.deepStrictEqual(g.game.snapshot(a).traps, [],
    'and the owner is no longer shown a trap that is not there');
});

test('a trap is dropped when it is dynamited, for the owner too', () => {
  const g = makeGame();
  const a = g.join({ code: 'C1', name: 'Ann' });
  const b = g.join({ code: 'C2', name: 'Bob' });
  b.inventory.dynamite = 1;

  // Ann sets a trap right next to Bob
  a.x = b.x;
  a.y = b.y + 1;
  g.world.digOut(a.x, a.y);
  a.inventory.trap = 1;
  g.game.placeTrap(a);
  assert.strictEqual(g.game.snapshot(a).traps.length, 1);

  g.game.useDynamite(b);
  assert.deepStrictEqual(g.game.snapshot(a).traps, [],
    'a trap that the blast destroyed is not still drawn on the map');
});

test('logging back in keeps the blocks you had already dug', () => {
  const g = makeGame();
  const a = g.join({ code: 'C1', name: 'Ann' });

  // dig a couple of cells down so there is real history
  g.game.action(a, { type: 'move', dir: 'down' });
  g.advance(5000);
  g.game.tick();
  g.game.action(a, { type: 'move', dir: 'down' });
  g.advance(5000);
  g.game.tick();

  const seenBefore = new Set(a.discovered);
  assert.ok(seenBefore.size > 4, 'Ann has discovered a real area to lose');
  assert.ok(g.world.isDug(a.x, 0), 'and dug something out');

  // the browser tab closes, the socket drops
  g.game.removePlayer(a);

  // ...and she comes back with the same code
  const back = g.join({ code: 'C1', name: 'Ann' });
  assert.strictEqual(back.id !== a.id, true, 'a genuinely new player object');
  for (const k of seenBefore) {
    assert.ok(back.discovered.has(k), `cell ${k} is still on the map after relogging in`);
  }

  // and the full state a client draws from really has those cells in it
  const { fullState } = require('./protocol');
  const state = fullState(g.game, back, null);
  const keys = new Set(state.blocks.map((b) => `${b.x},${b.y}`));
  for (const k of seenBefore) {
    assert.ok(keys.has(k), `cell ${k} is in the full state, not just remembered`);
  }
});

test('discovery does not leak between different players', () => {
  const g = makeGame();
  const a = g.join({ code: 'C1', name: 'Ann' });
  const b = g.join({ code: 'C2', name: 'Bob' });
  g.game.action(a, { type: 'move', dir: 'down' });
  g.advance(5000);
  g.game.tick();
  assert.ok(a.discovered.size > 0);

  g.game.removePlayer(a);
  const bBack = g.join({ code: 'C2', name: 'Bob' });
  assert.strictEqual(bBack.discovered.size, new Set(
    [...bBack.discovered].filter((k) => k.split(',')[1] <= 0)
  ).size, 'Bob only has his own surface row, not Ann tunnel');
  assert.strictEqual(bBack.discovered.has(g.world.key(a.x, 1)), false,
    'Ann dig is not in Bob map');
});

test('a new run wipes the remembered map, because the world changed', () => {
  const g = makeGame();
  const a = g.join({ code: 'C1', name: 'Ann' });
  g.game.action(a, { type: 'move', dir: 'down' });
  g.advance(5000);
  g.game.tick();
  const seenBefore = new Set(a.discovered);
  const deepCells = [...seenBefore].filter((k) => k.split(',')[1] > 0);
  assert.ok(deepCells.length > 0, 'Ann really did map something below the surface');

  g.game.newRun(999);

  // the remembered cells are gone: the world they belonged to is not this one
  for (const k of deepCells) {
    assert.strictEqual(a.discovered.has(k), false, `cell ${k} is not carried into the new world`);
  }
  assert.strictEqual(g.game.runDiscovered.get('C1'), a.discovered,
    'the rebuilt set is the one the run will now carry for Ann');

  // a relogin after the reset must not resurrect the old world knowledge
  g.game.removePlayer(a);
  const back = g.join({ code: 'C1', name: 'Ann' });
  assert.strictEqual(back.discovered.size, g.world.width * 2,
    'exactly the surface, as for any new player');
  for (const k of deepCells) {
    assert.strictEqual(back.discovered.has(k), false, `cell ${k} stayed gone after relogging in`);
  }
});
