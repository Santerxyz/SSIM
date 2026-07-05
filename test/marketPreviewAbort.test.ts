import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { type SellInfo } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-022 — preview() must not run the full live-price cascade for a client
//  that has already aborted. The route flips `shouldStop` on client 'close';
//  preview checks it before fetching each name, stops, and returns the partial
//  map. A 3-worker pool caps concurrency, so once `shouldStop` trips no further
//  name is looked up (at most the in-flight ones finish).
// ─────────────────────────────────────────────────────────────────────────────

/** A MarketService whose pricing is stubbed and whose getSellInfo calls are counted. */
function svcWith(info: SellInfo) {
  let calls = 0;
  const trades: any = {}; // preview with no username never touches the session layer
  const svc = new MarketService(trades);
  (svc as any).pricing = {
    getSellInfo: async () => { calls++; return info; },
  };
  return { svc, calls: () => calls };
}

const PRICED: SellInfo = { lowestCents: 1000, medianCents: 1000, volume: 1, authoritative: true };

test('H-TRD-022: shouldStop flipping true after 2 names stops the cascade (≤3 entries)', async () => {
  const { svc, calls } = svcWith(PRICED);
  const names = Array.from({ length: 50 }, (_, i) => `Item ${i}`);
  let fetched = 0;
  // Flip true once at least 2 names have been fetched — mirrors a client disconnect
  // mid-cascade. With a 3-worker pool at most the in-flight names finish afterwards.
  const shouldStop = () => fetched >= 2;
  (svc as any).pricing.getSellInfo = async () => { fetched++; return PRICED; };

  const out = await svc.preview(names, 'lowest', { shouldStop });
  const entries = Object.keys(out).length;
  assert.ok(entries <= 3, `expected ≤3 entries after early stop, got ${entries}`);
  assert.ok(entries >= 2, `the 2 pre-stop names must still be priced, got ${entries}`);
  assert.ok(fetched <= 3, `no name is looked up once shouldStop trips, got ${fetched} fetches`);
});

test('H-TRD-022: without shouldStop the full deduped set is priced', async () => {
  const { svc, calls } = svcWith(PRICED);
  const names = ['A', 'B', 'A', 'C']; // dedupes to 3 unique names
  const out = await svc.preview(names, 'lowest');
  assert.deepEqual(Object.keys(out).sort(), ['A', 'B', 'C']);
  assert.equal(calls(), 3, 'exactly one lookup per unique name');
});

test('H-TRD-022: custom strategy needs no lookup and ignores shouldStop', async () => {
  const { svc, calls } = svcWith(PRICED);
  const out = await svc.preview(['A', 'B'], 'custom', { customCents: 500, shouldStop: () => true });
  assert.equal(calls(), 0, 'custom pricing never calls getSellInfo');
  assert.equal(out['A'].netCents, 500);
  assert.equal(out['B'].netCents, 500);
});
