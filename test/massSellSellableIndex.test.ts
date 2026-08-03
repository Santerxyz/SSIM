import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY, type SellInfo } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-021 — the pre-list sellable guard must read the cached inventory ONCE
//  per bot (a single getCached → one structuredClone of the whole record), not
//  once per item. A K-item bot used to deep-clone the full account record K times
//  in the hot listing loop. The snapshot is now built at bot-start into an index
//  of trade-locked / non-tradable asset ids.
//   • exactly ONE getCached call for a 5-item group;
//   • a trade-locked stack's asset still lands in `blocked` (guard unchanged).
// ─────────────────────────────────────────────────────────────────────────────

/** A trader stub good enough for the guard/price paths (nothing is ever listed). */
function fakeTrader() {
  return {
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [] as string[],
    getListedAssetIds: async () => new Set<string>(), // pre-flight probe: no existing listings
  };
}

async function runToCompletion(svc: MarketService, items: Array<{ assetId: string; marketHashName: string }>) {
  svc.startMassSell([{ username: 'botA', items }], 'lowest', { itemDelayMs: 500 });
  const deadline = Date.now() + 10_000;
  while (svc.status().running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(svc.status().running, false, 'run must complete');
  return svc.status();
}

test('H-TRD-021: getCached is read once per bot and a trade-locked stack is still blocked', async () => {
  let getCachedCalls = 0;
  const trader = fakeTrader();
  const trades: any = {
    ensureWebSession: async () => trader,
    snapshotLive: () => new Set<string>(),
    releaseCreatedSessions: async () => 0,
  };
  // One trade-locked stack ('lock1') + one freely tradable stack (the rest of the ids).
  const inventory: any = {
    getCached: () => {
      getCachedCalls++;
      return {
        items: [
          { assetId: 'lock1', tradable: true, tradeLockExpiry: new Date(Date.now() + 864e5), assetIds: ['lock1'] },
          { assetId: 'ok', tradable: true, tradeLockExpiry: null, assetIds: ['a1', 'a2', 'a3', 'a4'] },
        ],
      };
    },
  };
  const svc = new MarketService(trades, inventory);
  // Authoritative no-price → the 4 sellable items resolve without ever calling sellOnMarket,
  // so the run completes without the full listing machinery.
  const info: SellInfo = { lowestMinor: null, medianMinor: null, volume: null, authoritative: true, basis: null, currency: 3, decimals: 2 };
  (svc as any).pricing = { getSellInfo: async () => info };

  const job = await runToCompletion(svc, [
    { assetId: 'lock1', marketHashName: 'AWP | Dragon Lore' },
    { assetId: 'a1', marketHashName: 'Dreams & Nightmares Case' },
    { assetId: 'a2', marketHashName: 'Dreams & Nightmares Case' },
    { assetId: 'a3', marketHashName: 'Dreams & Nightmares Case' },
    { assetId: 'a4', marketHashName: 'Dreams & Nightmares Case' },
  ]);

  assert.equal(getCachedCalls, 1, 'the cache is snapshotted exactly once per bot, not once per item');
  assert.equal(job.blocked.length, 1, 'the trade-locked stack asset is still blocked');
  assert.equal(job.blocked[0].assetId, 'lock1');
  assert.match(job.blocked[0].error, /trade-locked or not tradable/);
});
