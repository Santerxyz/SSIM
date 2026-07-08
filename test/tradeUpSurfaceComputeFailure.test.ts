import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService } from '../src/trading/TradeUpService';
import { logger } from '../src/utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-071 — a computeContract throw must NOT read as "no profitable trade-ups".
//  computeContract only throws on a malformed set (reachable via a schema/grouping
//  regression, since grouping guarantees same rarity+StatTrak). Previously every
//  such throw was swallowed at logger.debug (invisible in production): a regression
//  that broke EVERY set surfaced as the ordinary empty state with zero signal that
//  the math never ran. getCandidates now counts the skips, pushes a distinct warning,
//  and logs ONE logger.warn with the first captured cause (failed ≠ empty).
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A schema whose nextRarity claims a next tier exists but whose outputsFor returns
// none for that tier — the exact "schema mismatch" that makes computeContract throw
// for EVERY set (`collection "…" has no next-rarity outputs`).
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
  nextRarity: () => 'rarity_mythical_weapon', // truthy → group is NOT skipped
  outputsFor: () => [],                        // …but no outputs → computeContract throws
  marketHashName: (name: string, wear: string) => `${name} (${wear})`,
  rarityLabel: (id: string) => id,
};

const pricing: Any = {
  priceCents: () => 100,       // defined price → nothing queued for warm-fill
  ensureFilled: () => {},
};

const gc: Any = { available: () => false }; // skip the real-float GC read

// One stack of 10 eligible, tradable inputs (same rarity + StatTrak) → one group of 10.
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

test('tradeup surfaces compute failures', async () => {
  const svc = new TradeUpService(inventory, pricing, schema, gc);

  const origWarn = logger.warn;
  let warnCount = 0;
  (logger as Any).warn = (...args: unknown[]) => { warnCount++; return (origWarn as Any).apply(logger, args); };
  let result;
  try {
    result = await svc.getCandidates('bot');
  } finally {
    (logger as Any).warn = origWarn;
  }

  assert.equal(result.candidates.length, 0, 'no candidate survives — every set failed the exact math');
  assert.ok(
    result.warnings.some((w: string) => w.includes('could not be evaluated (schema mismatch)')),
    'a distinct schema-mismatch warning is surfaced (not the ordinary empty state)',
  );
  assert.equal(warnCount, 1, 'exactly one logger.warn is emitted for the swallowed compute failures');
});
