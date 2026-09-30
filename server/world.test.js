'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('./config');
const { World, BLOCK, neighbors8, pickWeighted } = require('./world');

function cfg(overrides = {}) {
  const { config } = loadConfig({ env: overrides, envFile: null });
  return config;
}

function world(overrides = {}, seed = 12345) {
  return new World(cfg(overrides), seed);
}

test('cells outside the world do not exist', () => {
  const w = world();
  assert.strictEqual(w.generatedBlock(-1, 0), null);
  assert.strictEqual(w.generatedBlock(w.width, 0), null);
  assert.strictEqual(w.currentBlock(-5, -5), null);
});

test('above the surface is sky', () => {
  const w = world();
  for (const y of [-1, -2, -50]) {
    assert.strictEqual(w.generatedBlock(3, y).type, BLOCK.AIR);
  }
});

test('the surface row is solid dirt with grass and never a hazard or a cache', () => {
  const w = world();
  for (let x = 0; x < w.width; x++) {
    const b = w.generatedBlock(x, w.surfaceY);
    assert.strictEqual(b.type, BLOCK.DIRT, `x=${x} must be dirt on the surface`);
    assert.strictEqual(b.item, null, `x=${x} must not hide an item on the surface`);
  }
});

test('players stand on top of the surface, not inside it', () => {
  const w = world();
  assert.strictEqual(w.topY, w.surfaceY - 1);
  assert.strictEqual(w.generatedBlock(10, w.topY).type, BLOCK.AIR);
  assert.strictEqual(w.generatedBlock(10, w.surfaceY).type, BLOCK.DIRT);
});

test('depth counts the blocks dug below the spawn line', () => {
  const w = world();
  assert.strictEqual(w.depthOf(w.topY), 0, 'standing on the surface is depth 0');
  assert.strictEqual(w.depthOf(w.surfaceY), 1, 'the first block you dig is depth 1');
  assert.strictEqual(w.depthOf(w.surfaceY + 1), 2);
  assert.strictEqual(w.depthOf(w.surfaceY + 40), 41);
  assert.strictEqual(w.depthOf(w.topY - 5), 0, 'the sky is not depth');
  // the generation ramp and the player's depth agree, so "depth 3" means the
  // same thing in the config as it does on the HUD
  for (let y = w.topY; y < w.topY + 10; y++) {
    assert.strictEqual(w.depthOf(y), y - w.topY);
  }
});

test('the pit contains dirt, stone and spikes', () => {
  const w = world({ STONE_CHANCE_MAX: 0.3, SPIKE_CHANCE_MAX: 0.3 });
  const seen = new Set();
  for (let x = 0; x < w.width; x++) {
    for (let y = 1; y < 60; y++) seen.add(w.generatedBlock(x, y).type);
  }
  assert.ok(seen.has(BLOCK.DIRT));
  assert.ok(seen.has(BLOCK.STONE));
  assert.ok(seen.has(BLOCK.SPIKES));
  assert.ok(!seen.has(BLOCK.AIR), 'there is no natural air underground');
});

test('generation is deterministic for a given seed and differs across seeds', () => {
  const a = world({}, 999);
  const b = world({}, 999);
  const c = world({}, 1000);
  let sameAB = true;
  let sameAC = true;
  for (let x = 0; x < a.width; x++) {
    for (let y = 1; y < 120; y++) {
      const ja = JSON.stringify(a.generatedBlock(x, y));
      if (ja !== JSON.stringify(b.generatedBlock(x, y))) sameAB = false;
      if (ja !== JSON.stringify(c.generatedBlock(x, y))) sameAC = false;
    }
  }
  assert.ok(sameAB, 'same seed must give the same world');
  assert.ok(!sameAC, 'different seeds should give different worlds');
});

test('items in a block are stable and visible before it is dug', () => {
  const w = world({ ITEM_CHANCE: 0.5, ITEM_WEIGHTS: 'armor:1' });
  // find a dirt block that does hold loot
  let found = null;
  for (let x = 0; x < w.width && !found; x++) {
    for (let y = 1; y < 40 && !found; y++) {
      const b = w.generatedBlock(x, y);
      if (b.type === BLOCK.DIRT && b.item) found = b;
    }
  }
  assert.ok(found, 'expected at least one dirt block with an item at 50% chance');
  assert.strictEqual(found.item, 'armor');
  // reading it again does not consume it
  assert.strictEqual(w.generatedBlock(found.x, found.y).item, 'armor');
  assert.strictEqual(w.currentBlock(found.x, found.y).item, 'armor');
});

test('ITEM_CHANCE=0 means no items anywhere', () => {
  const w = world({ ITEM_CHANCE: 0, ITEM_CHANCE_MAX: 0 });
  for (let x = 0; x < w.width; x++) {
    for (let y = 1; y < 80; y++) assert.strictEqual(w.generatedBlock(x, y).item, null);
  }
});

test('a dug cell reads as air, which is what stops re-digging a tunnel', () => {
  const w = world();
  const before = w.currentBlock(7, 3);
  assert.strictEqual(before.type, BLOCK.DIRT);
  w.digOut(7, 3);
  const after = w.currentBlock(7, 3);
  assert.strictEqual(after.type, BLOCK.AIR, 'a dug cell must never look like dirt again');
  assert.ok(w.isDug(7, 3));
});

test('a dug cell stops offering whatever was inside it', () => {
  // BUGS v0.3.1: the item stayed on the dug cell, so every player who had
  // discovered that block kept seeing the loot drawn on it forever, on every
  // resync, long after it had been picked up.
  const w = world({ ITEM_CHANCE: 1, ITEM_CHANCE_MAX: 1 });
  let cell = null;
  for (let y = 1; y < 12 && !cell; y++) {
    for (let x = 0; x < w.width; x++) {
      const b = w.generatedBlock(x, y);
      if (b && b.item) { cell = b; break; }
    }
  }
  assert.ok(cell, 'precondition: a block with loot in it');
  assert.strictEqual(w.currentBlock(cell.x, cell.y).item, cell.item, 'loot shows before it is dug');

  w.digOut(cell.x, cell.y);
  const dug = w.currentBlock(cell.x, cell.y);
  assert.strictEqual(dug.type, BLOCK.AIR);
  assert.strictEqual(dug.item, null, 'and stops once it has been taken');
});

test('digging a cell twice does nothing the second time', () => {
  const w = world();
  assert.ok(w.digOut(7, 3));
  assert.strictEqual(w.digOut(7, 3), null);
});

test('a dug cell keeps its original shape for the rest of the run', () => {
  const w = world();
  w.digOut(7, 3);
  assert.deepStrictEqual(w.generatedBlock(7, 3), { x: 7, y: 3, type: BLOCK.DIRT, item: null });
});

test('revealAround returns the real contents of a cell, only once', () => {
  const w = world();
  const seen = new Set();
  const fresh = w.revealAround(seen, 10, 2);
  const keys = fresh.map((b) => `${b.x},${b.y}`).sort();
  assert.deepStrictEqual(keys, ['10,1', '10,2', '10,3', '11,2', '9,2']);
  for (const b of fresh) {
    assert.ok([BLOCK.DIRT, BLOCK.STONE, BLOCK.SPIKES, BLOCK.AIR].includes(b.type));
    assert.ok('item' in b);
  }
  assert.deepStrictEqual(w.revealAround(seen, 10, 2), [], 'second look reveals nothing new');
  const step = w.revealAround(seen, 10, 3).map((b) => `${b.x},${b.y}`).sort();
  assert.deepStrictEqual(step, ['10,4', '11,3', '9,3'], 'only the new frontier is sent');
});

test('revealAround ignores cells outside the world', () => {
  const w = world();
  const seen = new Set();
  const fresh = w.revealAround(seen, 0, 3);
  assert.ok(!fresh.some((b) => b.x === -1));
  assert.ok(fresh.some((b) => b.x === 0));
  assert.ok(fresh.some((b) => b.x === 1));
});

test('revealSurface shows the ground and the sky, and only the surface', () => {
  const w = world();
  const seen = new Set();
  const fresh = w.revealSurface(seen);
  assert.strictEqual(fresh.length, w.width * 2);
  assert.ok(fresh.every((b) => b.y === w.surfaceY || b.y === w.topY));
  assert.strictEqual(seen.size, w.width * 2);
  assert.deepStrictEqual(w.revealSurface(seen), []);
});

test('a newly dug cell reveals itself and its neighbours', () => {
  const w = world();
  const seen = new Set();
  w.revealSurface(seen);
  const fresh = w.revealAround(seen, 5, w.surfaceY + 1);
  assert.ok(fresh.some((b) => b.y === w.surfaceY + 2), 'must see further down');
  assert.ok(fresh.some((b) => b.y === w.surfaceY + 1), 'must know the cell it now occupies');
  assert.ok(seen.has(w.key(5, w.surfaceY)), 'the layer above stays known');
  assert.ok(fresh.every((b) => b.type !== BLOCK.AIR || b.y <= w.surfaceY), 'no surprise holes underground');
});

test('clearRun wipes dug state but keeps the seed', () => {
  const w = world();
  w.digOut(1, 1);
  w.digOut(2, 2);
  w.clearRun();
  assert.strictEqual(w.dug.size, 0);
  assert.strictEqual(w.currentBlock(1, 1).type, w.generatedBlock(1, 1).type);
  assert.strictEqual(w.currentBlock(1, 1).item, w.generatedBlock(1, 1).item,
    'and the dirt is whole again, loot and all');
});

test('a pinned WORLD_SEED is honoured, an empty one is random', () => {
  assert.strictEqual(World.randomSeed(cfg({ WORLD_SEED: '4242' })), 4242);
  const seeds = new Set();
  for (let i = 0; i < 20; i++) {
    const s = World.randomSeed(cfg({ WORLD_SEED: '' }));
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `bad seed ${s}`);
    seeds.add(s);
  }
  assert.ok(seeds.size > 1, 'an unpinned seed should vary between runs');
});

test('harder the deeper you go, up to the configured caps', () => {
  const w = world({ STONE_CHANCE_MAX: 0.4, STONE_CHANCE_PER_DEPTH: 0.01 });
  const density = (from, to) => {
    let stone = 0;
    let total = 0;
    for (let x = 0; x < w.width; x++) {
      for (let y = from; y < to; y++) {
        if (w.generatedBlock(x, y).type === BLOCK.STONE) stone++;
        total++;
      }
    }
    return stone / total;
  };
  assert.ok(density(1, 10) < density(40, 60), 'deeper stone must be denser than shallow stone');
});

test('neighbours8 is the dynamite blast shape', () => {
  const n = neighbors8(5, 5);
  assert.strictEqual(n.length, 8);
  assert.ok(!n.some(([x, y]) => x === 5 && y === 5));
  assert.ok(n.some(([x, y]) => x === 6 && y === 6));
});

test('pickWeighted respects zero weights', () => {
  const weights = { armor: 0, shovel: 0, dynamite: 1, trap: 0 };
  for (let i = 0; i < 50; i++) assert.strictEqual(pickWeighted(weights, i / 50), 'dynamite');
});

test('the generation ramps and the HUD agree on what depth means', () => {
  // SPEC: depth is max(0, y - (SURFACE_Y - 1)), and it is "the same measure
  // the generation ramps use". They used to differ by one, which quietly put
  // the difficulty curve a row ahead of the number on the HUD.
  const { config } = loadConfig({ env: {}, envFile: null });
  const plain = new World(config, 99);
  assert.strictEqual(config.SURFACE_Y, 0);
  assert.strictEqual(plain.topY, -1, 'the walkable row just above the surface');
  assert.strictEqual(plain.depthOf(plain.topY), 0, 'and that is depth 0, where we start');

  // stoneChance = min(MAX, BASE + depth * PER_DEPTH). Tuned so that the row the
  // HUD calls depth 2 is certain stone (0 + 2 * 0.5 clamped to MAX 1) while the
  // row above it is a coin toss. Read a row that is all-or-nothing: under the
  // old off-by-one the depth used here was 1, so this row came out random and
  // the assertion below would fail about half the cells.
  const ramped = new World(
    { ...config, STONE_CHANCE_BASE: 0, STONE_CHANCE_PER_DEPTH: 0.5, STONE_CHANCE_MAX: 1 },
    7
  );
  assert.strictEqual(ramped.depthOf(1), 2, 'y=1 is the row the HUD calls depth 2');
  for (let x = 0; x < 50; x++) {
    assert.strictEqual(
      ramped.generatedBlock(x, 1).type,
      BLOCK.STONE,
      `x=${x} at depth 2 is past the ramp, so it is stone`
    );
  }
  // the row the HUD calls depth 0 is the surface, which is always plain dirt
  assert.strictEqual(ramped.generatedBlock(3, 0).type, BLOCK.DIRT, 'the surface is a fair floor');
});
