import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsFloatPriceSource } from '../src/pricing/sources/CsFloatPriceSource';
import { PricingService } from '../src/pricing/PricingService';

// ─────────────────────────────────────────────────────────────────────────────
//  CSFloat bulk warm (2026-07-10): the WHOLE CS2 catalog's lowest ask in ONE
//  request hydrates the cache off-Steam, so pricing never touches Steam's
//  exhausted anonymous priceoverview budget when a (free) CSFloat key is present.
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG = [
  { market_hash_name: 'AK-47 | Redline (Field-Tested)', quantity: 5, min_price: 3624 },
  { market_hash_name: 'Dreams & Nightmares Case', quantity: 400, min_price: 158 },
  { market_hash_name: 'BadPrice', min_price: 'nope' },   // non-numeric → skipped, not poisoned
  { quantity: 1, min_price: 10 },                         // no name → skipped
];

function fakeCsfloat(client: any) {
  return { hasAnyKey: () => true, pricingClient: () => client } as any;
}

test('bulkPriceList: maps rows to {name, cents}, skips bad/absent prices and nameless rows', async () => {
  const src = new CsFloatPriceSource(fakeCsfloat({ priceList: async () => CATALOG }));
  const rows = await src.bulkPriceList();
  assert.deepEqual(rows, [
    { name: 'AK-47 | Redline (Field-Tested)', cents: 3624 },
    { name: 'Dreams & Nightmares Case', cents: 158 },
  ]);
});

test('bulkPriceList: a 429 surfaces as RATE_LIMIT; a non-array is a transient shape failure', async () => {
  const rl = new CsFloatPriceSource(fakeCsfloat({ priceList: async () => { const e: any = new Error('rl'); e.status = 429; e.name = 'CsFloatError'; throw e; } }));
  await assert.rejects(() => rl.bulkPriceList(), /RATE_LIMIT/);
  const bad = new CsFloatPriceSource(fakeCsfloat({ priceList: async () => ({ not: 'an array' }) }));
  await assert.rejects(() => bad.bulkPriceList(), /FETCH_FAILED_SHAPE/);
});

test('bulkPriceList: no key at call time → empty (no throw)', async () => {
  const src = new CsFloatPriceSource(fakeCsfloat(null)); // pricingClient() → null
  assert.deepEqual(await src.bulkPriceList(), []);
});

test('PricingService: a CSFloat fill warms the catalog in one request, per-name only for stragglers', async () => {
  let priceListCalls = 0;
  let searchCalls = 0;
  const client = {
    priceList: async () => { priceListCalls++; return CATALOG; },
    searchListings: async () => { searchCalls++; return { data: [{ price: 1500 }] }; },
  };
  const svc = new PricingService(fakeCsfloat(client));
  svc.setSource('csfloat');
  try {
    assert.equal(svc.getSource(), 'csfloat', 'effective source is csfloat (key present)');
    svc.ensureFilled([
      { name: 'AK-47 | Redline (Field-Tested)', appid: 730 }, // in catalog → warmed
      { name: 'Straggler Skin', appid: 730 },                 // not in catalog → per-name search
    ]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(priceListCalls, 1, 'the bulk catalog was fetched exactly once');
    assert.equal(svc.priceCents('AK-47 | Redline (Field-Tested)', 730), 3624, 'catalog name priced from the bulk warm');
    assert.equal(searchCalls, 1, 'only the straggler needed a per-name search');
    assert.equal(svc.priceCents('Straggler Skin', 730), 1500, 'straggler priced via per-name lane');
  } finally { svc.shutdown(); svc.setSource('steam'); }
});

test('PricingService: a mixed CSFloat+Steam queue ARMS the anonymous fallback even while csfloat work is pending (review Defect A)', async () => {
  // Regression: the P1 anonymous-fallback timer must be armed even when csfloat jobs coexist with
  // logged-out Steam jobs — otherwise a TF2 (steam-routed) name in a mixed queue is left with no lane
  // AND no fallback timer (stranded). A csfloat STRAGGLER (not in the bulk catalog) keeps csfloatPending
  // true, which is exactly the path that used to skip arming the timer.
  const client = {
    priceList: async () => [{ market_hash_name: 'AK-47 | Redline (Field-Tested)', min_price: 3624 }],
    searchListings: async () => ({ data: [{ price: 1500 }] }),
  };
  const svc = new PricingService(fakeCsfloat(client), () => [], { anonFallbackGraceMs: 10_000 });
  (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => 777 };
  svc.setSource('csfloat');
  try {
    svc.ensureFilled([
      { name: 'AK-47 | Redline (Field-Tested)', appid: 730 }, // CS2, in catalog → warmed (csfloat)
      { name: 'Straggler Skin', appid: 730 },                 // CS2, NOT in catalog → keeps csfloatPending true
      { name: 'Mann Co. Supply Crate Key', appid: 440 },      // TF2 → steam, needs the anonymous fallback
    ]);
    await new Promise((r) => setTimeout(r, 100)); // run() enters, bulk-warms, hits the arm block
    assert.ok((svc as any).fallbackTimer, 'the anonymous-fallback timer is armed despite coexisting csfloat work — the steam name is not stranded');
  } finally { svc.shutdown(); svc.setSource('steam'); }
});

test('PricingService: TF2 (440) always prices via Steam even under a CSFloat selection', async () => {
  const client = { priceList: async () => CATALOG, searchListings: async () => ({ data: [{ price: 1 }] }) };
  const svc = new PricingService(fakeCsfloat(client), () => []); // no steam identity → TF2 job defers
  svc.setSource('csfloat');
  try {
    // A TF2 job must be pinned to 'steam' (CSFloat is CS2-only), so with no identity it DEFERS — never
    // handed to CSFloat (which would return an authoritative null for a TF2 name).
    svc.ensureFilled([{ name: 'Mann Co. Supply Crate Key', appid: 440 }]);
    await new Promise((r) => setTimeout(r, 150));
    const st = svc.status();
    assert.equal(st.queued, 1, 'the TF2 name stays queued (deferred), not mis-priced via CSFloat');
    assert.equal(st.processed, 0, 'CSFloat never authoritative-nulled the TF2 name');
  } finally { svc.shutdown(); svc.setSource('steam'); }
});
