import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryManager } from '../src/core/InventoryManager';
import type { CS2Item } from '../src/types/inventory';

// Minimal valid CS2Item; callers override only the fields under test.
function item(over: Partial<CS2Item>): CS2Item {
  return {
    assetId:        'a',
    classId:        'c',
    instanceId:     'i',
    marketHashName: 'AK-47 | Redline (Field-Tested)',
    name:           'AK-47 | Redline',
    type:           '',
    rarity:         'Unknown',
    rarityColor:    '#6b7280',
    exterior:       null,
    tradable:       false,
    marketable:     true,
    tradeLockExpiry: null,
    quantity:        1,
    assetIds:        ['a'],
    iconUrl:         '',
    ...over,
  };
}

// H-TRD-124: mixed confirmed + pending-2FA listings of the same item must NOT
// collapse into one stack (else a future consumer reads whichever flag arrived
// first for the whole quantity). Confirmed=ok / pending=false split the key.
test('stack: same name, confirmed vs pending-2FA → two stacks (C9 / INV-D4)', () => {
  const stacks = InventoryManager.stack([
    item({ assetId: '1', assetIds: ['1'], category: 'listed', listingConfirmed: true }),
    item({ assetId: '2', assetIds: ['2'], category: 'listed', listingConfirmed: false }),
  ]);
  assert.equal(stacks.length, 2, 'confirmed and pending listings stay separate');
  const pending = stacks.find(s => s.listingConfirmed === false);
  const confirmed = stacks.find(s => s.listingConfirmed === true);
  assert.ok(pending && confirmed, 'each state survives as its own stack');
  assert.equal(pending!.quantity, 1);
  assert.equal(confirmed!.quantity, 1);
});

test('stack: two confirmed listings of the same item still collapse into one', () => {
  const stacks = InventoryManager.stack([
    item({ assetId: '1', assetIds: ['1'], category: 'listed', listingConfirmed: true }),
    item({ assetId: '2', assetIds: ['2'], category: 'listed', listingConfirmed: true }),
  ]);
  assert.equal(stacks.length, 1, 'identical confirmed listings share one stack');
  assert.equal(stacks[0].quantity, 2);
});

test('stack: non-listed items (listingConfirmed undefined) collapse as before', () => {
  const stacks = InventoryManager.stack([
    item({ assetId: '1', assetIds: ['1'] }),
    item({ assetId: '2', assetIds: ['2'] }),
  ]);
  assert.equal(stacks.length, 1, 'undefined → constant "ok" suffix keeps keys stable');
  assert.equal(stacks[0].quantity, 2);
});
