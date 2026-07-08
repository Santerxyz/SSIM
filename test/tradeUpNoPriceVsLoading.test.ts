import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService } from '../src/trading/TradeUpService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-073 — the trade-up warning strip must tell "still loading" apart from an
//  AUTHORITATIVE "no market price". PricingService.priceCents is tri-state:
//  undefined = not fetched yet (a re-click can fill it), null = FRESH authoritative
//  miss cached 24h per S2 (a re-click never changes it), number = priced. The old
//  single warning told the user to "click again in a moment" for BOTH — so a
//  contract whose only gap is a real no-price outcome looked perpetually loading.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// One collection with two next-rarity outputs → computeContract produces a valid,
// profitable contract with two distinct outcome names (each 50% of the mass).
const schema: Any = {
  ensureLoaded: async () => {},
  skinCount: () => 1,
  lookup: () => ({
    name: 'AK-47 | Redline',
    rarityId: 'rarity_rare_weapon',
    collection: 'The 2018 Inferno Collection',
    minFloat: 0.0,
    maxFloat: 1.0,
    hasStatTrak: true,
  }),
  isEligibleInput: () => true,
  nextRarity: () => 'rarity_mythical_weapon',
  outputsFor: () => [
    { name: 'M4A4 | Priced', minFloat: 0.0, maxFloat: 1.0 },   // has a price
    { name: 'AWP | NoPriceSkin', minFloat: 0.0, maxFloat: 1.0 }, // seeded gap
  ],
  marketHashName: (name: string, wear: string) => `${name} (${wear})`,
  rarityLabel: (id: string) => id,
};

const gc: Any = { available: () => false }; // no real-float GC read

const inventory: Any = {
  forceRefresh: async () => ({
    items: [{
      marketHashName: 'AK-47 | Redline (Field-Tested)',
      quantity: 10,
      assetIds: Array.from({ length: 10 }, (_, i) => `asset${i}`),
      tradable: true,
    }],
  }),
};

// Everything is priced cheaply EXCEPT the one seeded output name, whose cache state
// is chosen per scenario. The priced output is expensive → the contract is profitable
// (so the candidate surfaces) but not fully priced (the gap keeps fullyPriced false).
const makePricing = (noPriceState: null | undefined): Any => ({
  priceCents: (name: string) => {
    if (name.includes('NoPriceSkin')) return noPriceState; // seeded gap: null or undefined
    if (name.includes('Priced')) return 100_00;            // expensive priced outcome → EV > cost
    return 1;                                              // cheap inputs
  },
  ensureFilled: () => {},
});

const STILL_LOADING = 'still loading';
const NO_PRICE = 'no current market price';

test('tradeup warns no-price separately from loading', async () => {
  // Scenario A — the gap is an AUTHORITATIVE null (fresh no-price): warn "no market price", NOT loading.
  {
    const svc = new TradeUpService(inventory, makePricing(null), schema, gc);
    const result = await svc.getCandidates('bot');
    assert.ok(result.candidates.some((c: Any) => !c.fullyPriced), 'a not-fully-priced candidate surfaces');
    assert.ok(result.warnings.some((w: string) => w.includes(NO_PRICE)), 'the no-current-market-price warning is present');
    assert.ok(!result.warnings.some((w: string) => w.includes(STILL_LOADING)), 'the still-loading warning is absent');
  }

  // Scenario B — the same name is ABSENT from the cache (undefined): warn "still loading".
  {
    const svc = new TradeUpService(inventory, makePricing(undefined), schema, gc);
    const result = await svc.getCandidates('bot');
    assert.ok(result.warnings.some((w: string) => w.includes(STILL_LOADING)), 'the still-loading warning is present');
  }
});
