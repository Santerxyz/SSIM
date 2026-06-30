import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PricingService } from '../src/pricing/PricingService';
import type { AccountInventory } from '../src/types/inventory';

// The frontend "prices refresh without a restart" fix relies on a backend contract: after the
// background price fill warms the cache, RE-PULLING the inventory (which re-enriches it) must reflect
// the new per-item prices AND recompute inv.totalValueUsd from those same values — never a stale total.
// These tests pin that contract down, network-free, by seeding the cache directly.

function cs2Inv(items: Array<{ marketHashName: string; quantity: number }>): AccountInventory {
  return {
    username: 'bot', game: 'cs2', items: items.map((i) => ({ ...i })),
    totalItems: items.length, fetchedAt: new Date().toISOString(),
  } as unknown as AccountInventory;
}
// Reach the private cache the way the background fill writes it (PricingService.run → cache.set).
function cacheOf(svc: PricingService): { set(name: string, cents: number | null): void } {
  return (svc as unknown as { cache: { set(name: string, cents: number | null): void } }).cache;
}

test('enrich: re-pull after the cache warms updates item prices AND recomputes the total (no-restart contract)', () => {
  const svc = new PricingService();
  const cache = cacheOf(svc);
  const inv = cs2Inv([
    { marketHashName: 'AK-47 | Redline (Field-Tested)', quantity: 1 },
    { marketHashName: 'AWP | Asiimov (Field-Tested)', quantity: 2 },
  ]);

  // 1) Cold cache (the state right after a refresh): prices unknown, total 0, both names queued.
  const missing1 = svc.enrich(inv);
  assert.equal(inv.items[0].price, undefined);
  assert.equal(inv.items[1].price, undefined);
  assert.equal(inv.totalValueUsd, 0);
  assert.deepEqual(
    missing1.map((m) => m.name).sort(),
    ['AK-47 | Redline (Field-Tested)', 'AWP | Asiimov (Field-Tested)'],
  );

  // 2) The background fill lands ONE price → a re-pull reflects it and recomputes the total.
  cache.set('AK-47 | Redline (Field-Tested)', 5000); // $50.00
  const missing2 = svc.enrich(inv);
  assert.equal(inv.items[0].price, 5000);
  assert.equal(inv.items[1].price, undefined);                 // still unpriced
  assert.equal(inv.totalValueUsd, 5000);                       // 5000*1 + unpriced*0
  assert.deepEqual(missing2.map((m) => m.name), ['AWP | Asiimov (Field-Tested)']); // only the still-missing one

  // 3) The fill drains → a final re-pull prices everything; the total is recomputed from the SAME
  //    updated values (single source of truth), never a stale cached total.
  cache.set('AWP | Asiimov (Field-Tested)', 1000); // $10.00 each
  const missing3 = svc.enrich(inv);
  assert.equal(inv.items[0].price, 5000);
  assert.equal(inv.items[1].price, 1000);
  assert.equal(inv.totalValueUsd, 5000 * 1 + 1000 * 2);        // 7000
  assert.equal(missing3.length, 0);
});

test('enrich: a re-price (new market value on refresh) is reflected on the next pull — the old value never sticks', () => {
  const svc = new PricingService();
  const cache = cacheOf(svc);
  const inv = cs2Inv([{ marketHashName: 'Glock-18 | Fade (Factory New)', quantity: 3 }]);

  cache.set('Glock-18 | Fade (Factory New)', 20000);
  svc.enrich(inv);
  assert.equal(inv.totalValueUsd, 60000);

  // A 24h re-price fetched a higher market price → re-enrich must show the NEW value + total.
  cache.set('Glock-18 | Fade (Factory New)', 25000);
  svc.enrich(inv);
  assert.equal(inv.items[0].price, 25000);
  assert.equal(inv.totalValueUsd, 75000);
});
