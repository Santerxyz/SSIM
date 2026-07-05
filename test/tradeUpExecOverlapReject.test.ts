import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService } from '../src/trading/TradeUpService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-067 — startExecute must reject overlapping asset ids. Contracts CONSUME
//  their inputs, so an asset id may appear at most once across the whole selection
//  and not twice within one contract. Overlapping candidates otherwise craft the
//  first contract then fail every later sharer at the GC presence re-check; a
//  non-unique intra-contract set is a malformed craft the GC refuses — reported
//  today as a false confirmed success (H-TRD-052). A 6-line pre-flight check kills
//  both. Disjoint selections are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

const RARITY = 'rarity_common_weapon';

test('tradeup exec rejects overlapping contracts', () => {
  let crafted = 0;
  const gc: AnyGc = {
    status: () => ({ craftEnabled: true, reason: 'ok' }),
    craftTradeUp: async () => { crafted++; return { submitted: true, confirmed: true }; },
  };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);

  // Two contracts sharing one asset id ('9') → throws with the shared id in the message.
  const a = Array.from({ length: 10 }, (_, i) => String(i));            // 0..9
  const b = Array.from({ length: 10 }, (_, i) => String(i + 9));        // 9..18 (shares '9')
  assert.throws(
    () => svc.startExecute('bot', [
      { inputAssetIds: a, rarityId: RARITY, stattrak: false },
      { inputAssetIds: b, rarityId: RARITY, stattrak: false },
    ]),
    /asset 9 is used by more than one selected contract/,
  );

  // 10× the same id in one contract → throws (intra-contract duplicate).
  const dup = Array.from({ length: 10 }, () => 'X');
  assert.throws(
    () => svc.startExecute('bot', [{ inputAssetIds: dup, rarityId: RARITY, stattrak: false }]),
    /asset X is used by more than one selected contract/,
  );

  assert.equal(crafted, 0, 'no craft was ever launched for a rejected selection');
});

test('tradeup exec allows disjoint contracts', () => {
  const gc: AnyGc = {
    status: () => ({ craftEnabled: false, reason: 'off' }),
    craftTradeUp: async () => ({ submitted: true, confirmed: true }),
  };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);

  // Two fully disjoint 10-id contracts must NOT throw (gated off → safe no-op).
  const a = Array.from({ length: 10 }, (_, i) => String(i));            // 0..9
  const c = Array.from({ length: 10 }, (_, i) => String(i + 10));       // 10..19
  const job = svc.startExecute('bot', [
    { inputAssetIds: a, rarityId: RARITY, stattrak: false },
    { inputAssetIds: c, rarityId: RARITY, stattrak: false },
  ]);
  assert.equal(job.total, 2, 'both disjoint contracts were accepted');
});
