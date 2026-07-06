import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownCurrencyInfo, currencyInfo, parseSteamMoney } from '../src/pricing/currencies';

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

// ════════════════════════════════════════════════════════════════════════════
//  H-PRC-013 — parseSteamMoney mis-scaled any money string whose fractional part
//  was shorter than `decimals`: a trailing-zero-trimmed "1,5" parsed as 1500 minor
//  (10×), not 150. An under-padded fraction is now right-padded; an over-long
//  fraction is refused (null) rather than absorbed 100× into the integer.
// ════════════════════════════════════════════════════════════════════════════

test('H-PRC-013: an under-padded fraction is right-padded, not read 10× too large', () => {
  assert.equal(parseSteamMoney('1,5', 2), 150, '"1,5" is 1.50, not 15.00');
  assert.equal(parseSteamMoney('12,3', 2), 1230, '"12,3" is 12.30, not 123.00');
});

test('H-PRC-013: full-precision and grouped forms still parse correctly', () => {
  assert.equal(parseSteamMoney('1,50', 2), 150);
  assert.equal(parseSteamMoney('1.234,56', 2), 123456);
  assert.equal(parseSteamMoney('$1,234.56', 2), 123456);
  assert.equal(parseSteamMoney('1,234', 2), 123400, 'a 3-digit trailing group stays a thousands group');
});

test('H-PRC-013: an over-long fraction is ambiguous → null (fail closed, S64)', () => {
  assert.equal(parseSteamMoney('1,2345', 2), null);
});

test('H-PRC-013: a 0-decimal currency reads separators as grouping', () => {
  assert.equal(parseSteamMoney('¥ 1,234', 0), 1234);
});
