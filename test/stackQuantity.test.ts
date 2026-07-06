import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryManager } from '../src/core/InventoryManager';
import type { CS2Item } from '../src/types/inventory';

// Minimal CS2Item factory — only the fields stack() reads (name/lock/listing/qty/assetIds)
// matter for identity and merging; the rest are filled with inert placeholders.
function item(name: string, quantity: number, assetIds: string[]): CS2Item {
  return {
    assetId:         assetIds[0],
    classId:         '0',
    instanceId:      '0',
    marketHashName:  name,
    name,
    type:            'Unknown',
    rarity:          'Consumer' as CS2Item['rarity'],
    rarityColor:     '#000000',
    exterior:        null,
    tradable:        true,
    marketable:      true,
    tradeLockExpiry: null,
    marketRestriction: 0,
    quantity,
    assetIds:        [...assetIds],
    iconUrl:         '',
    stickers:        [],
  };
}

test('stack: quantity-aware merge of already-stacked inputs (H-INV-014)', () => {
  const out = InventoryManager.stack([item('AK-47', 2, ['1', '2']), item('AK-47', 1, ['3'])]);
  assert.equal(out.length, 1, 'same name + lock + state → one stack');
  assert.equal(out[0].quantity, 3, 'quantities summed, not incremented by 1');
  assert.deepEqual(out[0].assetIds, ['1', '2', '3'], 'all underlying asset IDs preserved');
});

test('stack: single-item inputs still stack correctly (existing call-site parity)', () => {
  const out = InventoryManager.stack([item('AWP', 1, ['10']), item('AWP', 1, ['11'])]);
  assert.equal(out.length, 1);
  assert.equal(out[0].quantity, 2);
  assert.deepEqual(out[0].assetIds, ['10', '11']);
});
