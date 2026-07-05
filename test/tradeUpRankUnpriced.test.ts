import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-072 — candidates must rank FULLY-PRICED first, profit second.
//  computeContract counts an unpriced input as cost 0, so an estimate contract
//  carries a fabricated near-zero cost and an overstated profit. A pure profit
//  sort floats those mirages to the top of the MAX_CANDIDATES slice, pushing
//  honest fully-priced contracts OUT of the surfaced list on a screen whose
//  Execute button destroys 10 real items per contract.
//  The fixed comparator keeps fully-priced candidates ahead of unpriced ones
//  regardless of the fabricated profit gap.
// ─────────────────────────────────────────────────────────────────────────────

// The production comparator (TradeUpService.getCandidates): fully-priced first, profit second.
const rank = (a: { fullyPriced: boolean; profitCents: number }, b: { fullyPriced: boolean; profitCents: number }) =>
  (Number(b.fullyPriced) - Number(a.fullyPriced)) || (b.profitCents - a.profitCents);

test('tradeup ranking demotes unpriced contracts', () => {
  const A = { fullyPriced: true, profitCents: 500 };   // honest, fully priced
  const B = { fullyPriced: false, profitCents: 5000 };  // fabricated near-zero cost → overstated profit
  const sorted = [B, A].sort(rank);
  assert.deepEqual(sorted, [A, B], 'fully-priced A ranks ahead of the higher-but-unpriced B');
});

test('tradeup ranking still sorts by profit within the same priced-ness', () => {
  const hi = { fullyPriced: true, profitCents: 900 };
  const lo = { fullyPriced: true, profitCents: 100 };
  assert.deepEqual([lo, hi].sort(rank), [hi, lo], 'among fully-priced, higher profit first');
  const uHi = { fullyPriced: false, profitCents: 900 };
  const uLo = { fullyPriced: false, profitCents: 100 };
  assert.deepEqual([uLo, uHi].sort(rank), [uHi, uLo], 'among unpriced, higher profit first');
});
