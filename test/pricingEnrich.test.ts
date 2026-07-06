import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PricingService } from '../src/pricing/PricingService';
import type { PriceEntry } from '../src/pricing/PriceCache';
import type { AccountInventory, CS2Item } from '../src/types/inventory';

// ─────────────────────────────────────────────────────────────────────────────
//  H-PRC-007 — enrich must project the price cache onto item.price as a TRUE
//  tri-state (INV-E1, price analogue of the balance tri-state, DIRECTIVES #2):
//    authoritative no-price (fresh, cents=null, !soft) → null      ("—")
//    transient error-miss   (fresh, cents=null,  soft) → undefined ("…", pending)
//    a real price                                       → the number.
//  Before the fix a fresh hard null collapsed to undefined and rendered as a
//  spinner ("…") that never resolved for the whole 24h TTL.
// ─────────────────────────────────────────────────────────────────────────────

// Inject a cache entry with a controlled timestamp (white-box; the map is private).
function inject(svc: PricingService, key: string, entry: PriceEntry): void {
  (((svc as any).cache).map as Map<string, PriceEntry>).set(key, entry);
}
const nowIso = () => new Date().toISOString();

function item(marketHashName: string, quantity = 1): CS2Item {
  return { marketHashName, quantity } as unknown as CS2Item;
}
function inv(items: CS2Item[]): AccountInventory {
  return { items } as unknown as AccountInventory;
}

test('H-PRC-007: a fresh authoritative no-price (cents null, hard) → item.price null, not queued', () => {
  const svc = new PricingService(); // default source = steam; CS2 cache key is name-only
  try {
    inject(svc, 'NoPrice', { cents: null, fetchedAt: nowIso() });
    const inventory = inv([item('NoPrice')]);
    const missing = svc.enrich(inventory);
    assert.equal(inventory.items[0].price, null, 'authoritative no-price → null ("—")');
    assert.equal(missing.some((m) => m.name === 'NoPrice'), false, 'a fresh entry is not re-queued');
  } finally { svc.shutdown(); }
});

test('H-PRC-007: a fresh SOFT error-miss (cents null, soft) → item.price undefined ("…")', () => {
  const svc = new PricingService();
  try {
    inject(svc, 'SoftMiss', { cents: null, fetchedAt: nowIso(), soft: true });
    const inventory = inv([item('SoftMiss')]);
    svc.enrich(inventory);
    assert.equal(inventory.items[0].price, undefined, 'soft miss stays pending → undefined ("…")');
  } finally { svc.shutdown(); }
});

test('H-PRC-007: a real price → item.price is the number and contributes to totalValueUsd', () => {
  const svc = new PricingService();
  try {
    inject(svc, 'Priced', { cents: 5000, fetchedAt: nowIso() });
    const inventory = inv([item('Priced', 3)]);
    svc.enrich(inventory);
    assert.equal(inventory.items[0].price, 5000, 'a real price → the number');
    assert.equal(inventory.totalValueUsd, 5000 * 3, 'totalValueUsd includes cents * quantity');
  } finally { svc.shutdown(); }
});
