'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MINIBOSS_SPECIES, GATE_SPECIES, minibossSpecies, gateSpecies } = require('./monsters');

test('every species is a name, an id and a pair of multipliers', () => {
  const seen = new Set();
  for (const list of [MINIBOSS_SPECIES, GATE_SPECIES]) {
    assert.ok(list.length > 0);
    for (const s of list) {
      assert.ok(s.id && typeof s.id === 'string', 'has an id');
      assert.ok(s.name && typeof s.name === 'string', 'has a name to show in the fight');
      assert.strictEqual(typeof s.hpMult, 'number');
      assert.strictEqual(typeof s.atkMult, 'number');
      assert.ok(s.hpMult > 0 && s.atkMult >= 0);
      // room is left for species-specific verbs and battle lines
      assert.ok(Array.isArray(s.attacks) && Array.isArray(s.lines));
      assert.ok(!seen.has(s.id), `id ${s.id} is used once`);
      seen.add(s.id);
    }
  }
});

test('a deeper species is never weaker than a shallower one', () => {
  for (let i = 1; i < MINIBOSS_SPECIES.length; i++) {
    assert.ok(MINIBOSS_SPECIES[i].hpMult >= MINIBOSS_SPECIES[i - 1].hpMult, 'hp climbs');
    assert.ok(MINIBOSS_SPECIES[i].atkMult >= MINIBOSS_SPECIES[i - 1].atkMult, 'attack climbs');
  }
  for (let i = 1; i < GATE_SPECIES.length; i++) {
    assert.ok(GATE_SPECIES[i].hpMult >= GATE_SPECIES[i - 1].hpMult, 'hp climbs');
    assert.ok(GATE_SPECIES[i].atkMult >= GATE_SPECIES[i - 1].atkMult, 'attack climbs');
  }
});

test('a miniboss wears one species per tier of depth, capped at the deepest', () => {
  const per = 10;
  assert.strictEqual(minibossSpecies(1, per).id, MINIBOSS_SPECIES[0].id);
  assert.strictEqual(minibossSpecies(per, per).id, MINIBOSS_SPECIES[0].id, 'the last shallow block');
  assert.strictEqual(minibossSpecies(per + 1, per).id, MINIBOSS_SPECIES[1].id, 'one block deeper starts the next');
  const deep = minibossSpecies(9999, per);
  assert.strictEqual(deep.id, MINIBOSS_SPECIES[MINIBOSS_SPECIES.length - 1].id, 'and it never runs out');
});

test('a gate wears one species per band, capped at the last', () => {
  GATE_SPECIES.forEach((s, i) => assert.strictEqual(gateSpecies(i).id, s.id));
  const last = GATE_SPECIES[GATE_SPECIES.length - 1];
  assert.strictEqual(gateSpecies(GATE_SPECIES.length + 5).id, last.id, 'endless gates reuse the last guardian');
});
