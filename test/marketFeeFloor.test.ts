import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feesForNet, sellerNetFromBuyer } from '../src/pricing/MarketPricing';
import { knownCurrencyInfo, feeMinimumOf, DEFAULT_FEE_MINIMUM } from '../src/pricing/currencies';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.7 — the per-currency Steam fee FLOOR.
//
//  Steam charges max(percent · net, wallet_fee_minimum) on BOTH the Steam cut and the
//  publisher cut. The floor is 1 minor unit in EUR/USD but 4 in PLN, and the model used to
//  assume 1 everywhere. Field evidence (owner, 2026-08-04): a custom net of 0,38 zł was
//  previewed as 0,42 gross and went live as 0,46 zł buyer / 0,38 zł net — Steam took 0,08,
//  i.e. 4 + 4, because 5%·38 = 1,9 and 10%·38 = 3,8 are both under the floor.
//
//  Two consequences, both covered here: the preview mis-states what the buyer pays, and
//  sellerNetFromBuyer (which decides the net we COMMIT) solves for a net whose real buyer
//  price lands ABOVE the target — so an 'undercut' silently fails to undercut.
// ─────────────────────────────────────────────────────────────────────────────

const PLN = knownCurrencyInfo(6)!;
const EUR = knownCurrencyInfo(3)!;

test('PLN: the reported field case — net 38 costs the buyer 46, not 42', () => {
  assert.equal(feeMinimumOf(PLN), 4, 'PLN carries the proven 4-grosz floor');
  assert.equal(feesForNet(38, feeMinimumOf(PLN)), 8, 'both sides sit on the 4-grosz floor');
  assert.equal(38 + feesForNet(38, feeMinimumOf(PLN)), 46, 'this is the gross the listing actually went live at');
  // The pre-1.4.7 model (floor 1) is what produced the wrong 0,42 preview.
  assert.equal(38 + feesForNet(38), 42, 'the old floor-1 assumption reproduces the bug exactly');
});

test('PLN: a buyer target resolves to a net that lands ON the target, not above it', () => {
  // The undercut/lowest path: target a 0,46 buyer price → commit the net Steam turns back into 46.
  const net = sellerNetFromBuyer(46, feeMinimumOf(PLN));
  assert.equal(net, 38);
  assert.equal(net + feesForNet(net, feeMinimumOf(PLN)), 46, 'round-trips exactly onto the target');
  // With the old model the SAME target committed a net of 40, which Steam prices at 48 —
  // four grosz ABOVE the ask it was undercutting, which is why those listings never sold.
  const naive = sellerNetFromBuyer(46);
  assert.equal(naive, 40);
  assert.equal(naive + feesForNet(naive, feeMinimumOf(PLN)), 48, 'the old net overshoots the target price');
});

test('EUR/USD are unchanged — the floor there really is 1 minor unit', () => {
  assert.equal(feeMinimumOf(EUR), DEFAULT_FEE_MINIMUM);
  assert.equal(feesForNet(100, feeMinimumOf(EUR)), 15, '5% + 10% at a normal price');
  assert.equal(feesForNet(1, feeMinimumOf(EUR)), 2, 'the classic 0,01 net → 0,03 buyer minimum');
  assert.equal(sellerNetFromBuyer(3, feeMinimumOf(EUR)), 1);
  assert.equal(sellerNetFromBuyer(115, feeMinimumOf(EUR)), 100);
});

test('an unknown currency keeps the old assumption instead of inventing a floor', () => {
  assert.equal(feeMinimumOf(undefined), 1);
  assert.equal(feeMinimumOf({ code: 999, iso: 'ZZZ', decimals: 2 }), 1);
  // A junk floor must never WIDEN a fee — normalize back to 1.
  assert.equal(feesForNet(100, 0), feesForNet(100, 1));
  assert.equal(feesForNet(100, -5), feesForNet(100, 1));
  assert.equal(feesForNet(100, NaN), feesForNet(100, 1));
});

test('sellerNetFromBuyer never returns a net whose real buyer price exceeds the target', () => {
  // The invariant the money path depends on: what we commit must never cost the buyer MORE
  // than the price the operator aimed at, in any currency floor.
  for (const floor of [1, 2, 4, 10]) {
    for (let buyer = 1; buyer <= 400; buyer++) {
      const net = sellerNetFromBuyer(buyer, floor);
      assert.ok(net >= 1, `net must stay positive (buyer ${buyer}, floor ${floor})`);
      const realBuyer = net + feesForNet(net, floor);
      if (buyer >= 1 + 2 * floor) {
        assert.ok(realBuyer <= buyer,
          `floor ${floor}: net ${net} for target ${buyer} costs the buyer ${realBuyer} — above target`);
        // …and it is the LARGEST such net (no money left on the table).
        const bigger = net + 1;
        assert.ok(bigger + feesForNet(bigger, floor) > buyer,
          `floor ${floor}: net ${net} for target ${buyer} is not maximal`);
      }
    }
  }
});
