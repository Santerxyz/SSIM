import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDistribute, normalizeNameFilter, passesNameFilter, type DistributeDeps } from '../src/trading/DistributeService';
import type { CS2Item } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner: "Batch Jobs distribute Items. exclude / include specific items".
//
//  A distribute run used to hand out whatever the packer reached for, so a knife or a rare case
//  could leave the fleet purely because it was the line item that happened to fit the ask. The
//  filters exist to make that impossible, which means they have to bite at POOL-BUILD time — an
//  excluded item must be ineligible for every offer in the plan, not merely deprioritised.
//
//  The dangerous failure mode is the quiet one: a filter that silently matches nothing (or
//  everything) still produces a plausible-looking plan and then moves real items. Every test below
//  therefore asserts on the assetIds the plan would actually SEND.
// ════════════════════════════════════════════════════════════════════════════════════════════════

function item(assetId: string, marketHashName: string, priceCents: number): CS2Item {
  return {
    assetId, classId: 'c', instanceId: '0', marketHashName, name: marketHashName,
    type: 't', rarity: 'Consumer Grade', rarityColor: '#fff', exterior: null,
    tradable: true, marketable: true, tradeLockExpiry: null, category: 'tradable',
    quantity: 1, assetIds: [assetId], price: priceCents,
  } as unknown as CS2Item;
}

/** A STACK: one record standing for several identical assets — the shape that makes "stacks skipped"
 *  and "items skipped" diverge, and the reason the filtered counter is measured in items. */
function stack(ids: string[], marketHashName: string, priceCents: number): CS2Item {
  return { ...item(ids[0], marketHashName, priceCents), quantity: ids.length, assetIds: ids } as CS2Item;
}

/** One source holding a knife, a case and a sticker; one target asking for a lot (so the packer
 *  would happily take everything it is allowed to). */
function deps(): DistributeDeps {
  const items = [
    item('a1', '★ Karambit | Doppler (Factory New)', 90_000),
    item('a2', 'Fracture Case', 1_000),
    item('a3', 'Sticker | Titan (Holo) | Katowice 2014', 5_000),
  ];
  return {
    inventory: { getCached: (u) => (u === 'src' ? { items } : undefined) },
    trades: { getTradeUrl: async () => '', sendTrade: async () => ({}) },
  };
}

const base = { sources: ['src'], targets: ['dst'], amountNetCents: 200_000, game: 'cs2' as const };
const sentIds = (p: { trades: Array<{ assetIds: string[] }> }): string[] => p.trades.flatMap((t) => t.assetIds).sort();

test('H-DST-030: no filters = the pre-1.5.1 plan, byte for byte — everything is eligible', () => {
  const plan = planDistribute(base, deps());
  assert.deepEqual(sentIds(plan), ['a1', 'a2', 'a3']);
  assert.equal(plan.skipped.filtered, 0);
});

test('H-DST-031: an EMPTY include list means "no restriction", never "nothing"', () => {
  // The whole feature is dead weight if an operator who types no filter suddenly distributes zero
  // items — and worse, a run that silently sends nothing looks identical to an empty pool.
  const plan = planDistribute({ ...base, includeNames: [], excludeNames: [] }, deps());
  assert.deepEqual(sentIds(plan), ['a1', 'a2', 'a3']);
});

test('H-DST-032: exclude keeps the named item out of EVERY offer in the plan', () => {
  const plan = planDistribute({ ...base, excludeNames: ['Karambit'] }, deps());
  assert.deepEqual(sentIds(plan), ['a2', 'a3']);
  assert.equal(plan.skipped.filtered, 1, 'the excluded item is counted (in items, not stacks), not silently vanished');
  assert.ok(!plan.poolNames.some((n) => n.name.includes('Karambit')), 'and it is not offered as eligible');
});

test('H-DST-033: include narrows the pool to the named items only', () => {
  const plan = planDistribute({ ...base, includeNames: ['Case'] }, deps());
  assert.deepEqual(sentIds(plan), ['a2']);
  assert.equal(plan.skipped.filtered, 2);
});

test('H-DST-034: EXCLUDE beats INCLUDE on a conflict — a name written under "never" is never sent', () => {
  const plan = planDistribute({ ...base, includeNames: ['Karambit', 'Case'], excludeNames: ['Karambit'] }, deps());
  assert.deepEqual(sentIds(plan), ['a2']);
});

test('H-DST-035: matching is case-insensitive and substring-based', () => {
  const plan = planDistribute({ ...base, includeNames: ['fracture'] }, deps());
  assert.deepEqual(sentIds(plan), ['a2']);
});

test('H-DST-036: a filter that matches NOTHING produces an empty plan, not a full one', () => {
  // Fail-closed: if the operator's list is a typo, distribute nothing and let the empty plan say so.
  const plan = planDistribute({ ...base, includeNames: ['Butterfly Knife'] }, deps());
  assert.deepEqual(plan.trades, []);
  assert.equal(plan.skipped.filtered, 3);
  assert.equal(plan.poolExhausted, true, 'the target is reported short, not quietly satisfied');
});

test('H-DST-037: blank / whitespace-only lines are dropped — a stray newline never matches everything', () => {
  assert.deepEqual(normalizeNameFilter(['  Case  ', '', '   ', 'Case']), ['case']);
  assert.deepEqual(normalizeNameFilter(undefined), []);
  // The dangerous shape: an exclude list that is nothing but blank lines must exclude NOTHING.
  const plan = planDistribute({ ...base, excludeNames: ['', '  '] }, deps());
  assert.deepEqual(sentIds(plan), ['a1', 'a2', 'a3']);
});

test('H-DST-038: passesNameFilter — the decision in isolation', () => {
  assert.equal(passesNameFilter('Fracture Case', [], []), true);
  assert.equal(passesNameFilter('Fracture Case', ['case'], []), true);
  assert.equal(passesNameFilter('Fracture Case', ['knife'], []), false);
  assert.equal(passesNameFilter('Fracture Case', [], ['case']), false);
  assert.equal(passesNameFilter('Fracture Case', ['case'], ['fracture']), false, 'deny wins');
});

test('H-DST-03a: the filtered counter is in ITEMS, so excluding one big stack is not reported as "1"', () => {
  const items = [stack(['s1', 's2', 's3', 's4'], 'Fracture Case', 1_000), item('k1', '★ Karambit | Doppler (Factory New)', 90_000)];
  const plan = planDistribute({ ...base, excludeNames: ['Case'] }, {
    inventory: { getCached: (u) => (u === 'src' ? { items } : undefined) },
    trades: { getTradeUrl: async () => '', sendTrade: async () => ({}) },
  });
  assert.equal(plan.skipped.filtered, 4, 'four cases were held back, not "one stack"');
  assert.deepEqual(sentIds(plan), ['k1']);
});

test('H-DST-039: poolNames reports what SURVIVED the filters, richest first', () => {
  const plan = planDistribute({ ...base, excludeNames: ['Karambit'] }, deps());
  assert.deepEqual(plan.poolNames.map((n) => n.name), ['Sticker | Titan (Holo) | Katowice 2014', 'Fracture Case']);
  assert.deepEqual(plan.poolNames.map((n) => n.count), [1, 1]);
});
