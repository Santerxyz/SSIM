import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownCurrencyInfo, currencyInfo, parseSteamMoney, priceTextForeignCurrency } from '../src/pricing/currencies';

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

test('H-PRC-014: the display fallback is an internally consistent EUR record (code 3, not the unknown code)', () => {
  assert.equal(currencyInfo(9999).code, 3, 'code matches the EUR iso, not the unrecognised input 9999');
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

// ════════════════════════════════════════════════════════════════════════════
//  v1.4.5 — Steam emits a FRACTION on 0-decimal currencies too. Verified live
//  2026-08-03 against priceoverview currency=8 (JPY): lowest_price "¥ 6,685" but
//  median_price "¥ 6,709.04". Stripping every separator read that as 670904 —
//  100× the real price, which on the buy path is a 100× overbid of real money.
// ════════════════════════════════════════════════════════════════════════════

test('0-decimal: a fractional tail is ROUNDED away, not absorbed 100× into the integer', () => {
  assert.equal(parseSteamMoney('¥ 6,709.04', 0), 6709, 'the live JPY median — 6709 yen, not 670904');
  assert.equal(parseSteamMoney('¥ 6,685', 0), 6685, 'a 3-digit group is still thousands, not a fraction');
  assert.equal(parseSteamMoney('₩ 1.500,60', 0), 1501, 'a ≥.5 fraction rounds up');
  assert.equal(parseSteamMoney('Rp 12.000', 0), 12000, 'plain grouped form unchanged');
  assert.equal(parseSteamMoney('150', 0), 150, 'no separator at all');
});

// ════════════════════════════════════════════════════════════════════════════
//  v1.4.5 — priceoverview never echoes the currency it answered in, so a response
//  that came back in a DIFFERENT currency than requested is invisible in the number
//  alone. The localized symbol is the one witness; a positive contradiction is
//  refused, and anything unrecognised passes (this may only ever ADD a refusal).
// ════════════════════════════════════════════════════════════════════════════

test('currency witness: a matching symbol clears the string', () => {
  assert.equal(priceTextForeignCurrency('157,03 zł', 'PLN'), null);
  assert.equal(priceTextForeignCurrency('36,40€', 'EUR'), null);
  assert.equal(priceTextForeignCurrency('$41.83 USD', 'USD'), null);
  assert.equal(priceTextForeignCurrency('3334,32 pуб.', 'RUB'), null, 'Steam serves a Latin p + Cyrillic уб');
  assert.equal(priceTextForeignCurrency('¥ 6,685', 'JPY'), null);
});

test('currency witness: a EUR answer to a PLN request is REFUSED (the ~99% underprice shape)', () => {
  assert.equal(priceTextForeignCurrency('36,40€', 'PLN'), 'EUR');
  assert.equal(priceTextForeignCurrency('157,03 zł', 'EUR'), 'PLN');
});

test('currency witness: a shared glyph never accuses a sibling currency', () => {
  assert.equal(priceTextForeignCurrency('$41.83', 'CAD'), null, '$ is legitimate for CAD too');
  assert.equal(priceTextForeignCurrency('¥ 6,685', 'CNY'), null, '¥ is shared by JPY and CNY');
  assert.equal(priceTextForeignCurrency('12,34 kr', 'SEK'), null, 'kr is shared by NOK/SEK/DKK');
});

test('currency witness: an unrecognised marker yields no verdict (never a false refusal)', () => {
  assert.equal(priceTextForeignCurrency('12,34 AED', 'AED'), null);
  assert.equal(priceTextForeignCurrency('', 'EUR'), null);
  assert.equal(priceTextForeignCurrency(undefined, 'EUR'), null);
});
