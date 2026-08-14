import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionSets, pickDisjoint, type TradeUpCandidate } from '../src/trading/TradeUpService';
import type { TuInput } from '../src/trading/tradeupMath';

// ─────────────────────────────────────────────────────────────────────────────
//  Owner report 2026-08-11: "for some reason RN it only finds 12 trade ups. no
//  matter how many i do and reopen trade ups it shows 12. and if select all […]
//  it will say wont work asset is in 2 trade ups".
//
//  Both symptoms are one cause: the generator only ever emitted the cheapest-10
//  and lowest-float-10 pick PER COLLECTION, which (a) is a fixed small number no
//  matter how large the inventory is, and (b) draws every pick from the same cheap
//  items, so any two of them overlap. partitionSets answers "how many contracts can
//  this account ACTUALLY run" and pickDisjoint makes a multi-select executable.
// ─────────────────────────────────────────────────────────────────────────────

function input(collection: string, assetId: string, float = 0.2, priceCents: number | null = 100): TuInput {
  return {
    marketHashName: `Skin ${assetId} (Field-Tested)`,
    baseName: `Skin ${assetId}`,
    collection,
    rarityId: 'rarity_rare_weapon',
    stattrak: false,
    float,
    priceCents,
    assetId,
  };
}

function group(collection: string, n: number, startId = 0): TuInput[] {
  return Array.from({ length: n }, (_, i) => input(collection, `${collection}-${startId + i}`, (startId + i) / 1000));
}

test('a collection of 35 yields THREE disjoint contracts, not one pick', () => {
  const byCol = new Map([['Alpha', group('Alpha', 35)]]);
  const sets = partitionSets(byCol);
  assert.equal(sets.length, 3);                        // 35 → 3 contracts, 5 stranded
  for (const s of sets) assert.equal(s.length, 10);
  // No asset may appear twice across the whole plan — that is what made Select all fail.
  const ids = sets.flat().map((i) => i.assetId);
  assert.equal(new Set(ids).size, ids.length);
});

test('the plan scales with the inventory (the old generator was flat)', () => {
  for (const [count, expected] of [[10, 1], [100, 10], [253, 25]] as const) {
    const sets = partitionSets(new Map([['Alpha', group('Alpha', count)]]));
    assert.equal(sets.length, expected, `${count} inputs should yield ${expected} contracts`);
  }
});

test('leftovers below 10 per collection are combined into mixed contracts, not stranded', () => {
  // 7 + 8 + 9 = 24 items, no single collection can fill a contract on its own.
  const byCol = new Map([
    ['Alpha', group('Alpha', 7)],
    ['Bravo', group('Bravo', 8)],
    ['Charlie', group('Charlie', 9)],
  ]);
  const sets = partitionSets(byCol);
  assert.equal(sets.length, 2);   // 24 leftovers → 2 mixed contracts (a mixed contract is legal)
  const collections = new Set(sets[0].map((i) => i.collection));
  assert.ok(collections.size > 1, 'the leftover contract should span collections');
});

test('single-collection contracts are cut before mixed ones', () => {
  // Alpha can fill exactly one contract on its own; Bravo cannot.
  const byCol = new Map([['Alpha', group('Alpha', 10)], ['Bravo', group('Bravo', 4)]]);
  const sets = partitionSets(byCol);
  assert.equal(sets.length, 1);
  assert.ok(sets[0].every((i) => i.collection === 'Alpha'), 'the pure-collection set must win');
});

test('within a collection the good floats land together in one contract', () => {
  // Floats 0.000 … 0.019; the first contract should take the 10 lowest, not a smear.
  const byCol = new Map([['Alpha', group('Alpha', 20)]]);
  const [first] = partitionSets(byCol);
  assert.ok(Math.max(...first.map((i) => i.float)) < 0.010, 'the first contract should hold the best floats');
});

function candidate(id: string, assetIds: string[]): TradeUpCandidate {
  return { id, inputs: assetIds.map((a) => input('Alpha', a)) } as unknown as TradeUpCandidate;
}

test('pickDisjoint drops overlapping candidates instead of building an unexecutable batch', () => {
  const a = candidate('A', Array.from({ length: 10 }, (_, i) => `x${i}`));
  const overlapping = candidate('B', ['x9', ...Array.from({ length: 9 }, (_, i) => `y${i}`)]); // shares x9
  const clean = candidate('C', Array.from({ length: 10 }, (_, i) => `z${i}`));
  const picked = pickDisjoint([a, overlapping, clean]);
  assert.deepEqual(picked.map((c) => c.id), ['A', 'C']);
});

test('pickDisjoint keeps the FIRST (best-ranked) member of an overlapping cluster', () => {
  const best = candidate('best', Array.from({ length: 10 }, (_, i) => `x${i}`));
  const nearDuplicate = candidate('dup', ['x0', ...Array.from({ length: 9 }, (_, i) => `w${i}`)]);
  assert.deepEqual(pickDisjoint([best, nearDuplicate]).map((c) => c.id), ['best']);
});

test('pickDisjoint refuses a candidate missing asset ids (it cannot be crafted)', () => {
  const noIds = { id: 'X', inputs: Array.from({ length: 10 }, () => ({ ...input('Alpha', 'q'), assetId: undefined })) } as unknown as TradeUpCandidate;
  assert.deepEqual(pickDisjoint([noIds]), []);
});
