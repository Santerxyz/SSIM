import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownCurrencyInfo, currencyInfo } from '../src/pricing/currencies';

// ════════════════════════════════════════════════════════════════════════════
//  S64 — an unknown wallet-currency code silently fell back to 2 decimals; a 0-decimal
//  currency then mis-scaled a per-item price 100×. Money paths (BuyService) now use
//  knownCurrencyInfo, which returns null for an unrecognised code → FAIL CLOSED
//  (refuse to price / skip the account) rather than guess the scale.
// ════════════════════════════════════════════════════════════════════════════

test('S64: knownCurrencyInfo returns null for an UNRECOGNISED code (money path fails closed)', () => {
  assert.equal(knownCurrencyInfo(9999), null, 'an unknown code is not silently given 2 decimals');
  assert.equal(knownCurrencyInfo(undefined), null);
});

test('S64: knownCurrencyInfo returns the REAL decimals for a known code (incl. a 0-decimal currency)', () => {
  assert.equal(knownCurrencyInfo(46)?.decimals, 0, 'HUF (code 46) is 0-decimal — a 2-decimal guess would 100× it');
  assert.equal(knownCurrencyInfo(3)?.decimals, 2, 'EUR (code 3) is 2-decimal');
});

test('S64: the DISPLAY helper still returns a lenient 2-decimal fallback (unchanged; not a money path)', () => {
  assert.equal(currencyInfo(9999).decimals, 2, 'display fallback is unchanged');
  assert.equal(currencyInfo(9999).iso, 'EUR');
});
