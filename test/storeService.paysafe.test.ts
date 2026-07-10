import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  walletEurMinor, assertOrderAmount, assertStoreHost, assertSteamHttpsUrl,
  isSteamHttpsUrl, parseMinorUnits, StoreShapeError,
} from '../src/store/StoreService';

// ── walletEurMinor: the single conversion on the money path ─────────────────────────────────────
// The whole point is that there ISN'T a conversion: EUR minor units in, EUR minor units out. Anything
// that is not a readable EUR balance must be null (→ 'unconfirmed'), never a guess.

test('H-STO-001: a funded EUR wallet converts MAJOR units → euro-cents', () => {
  assert.equal(walletEurMinor({ hasWallet: true, currency: 3, balance: 12.34 }), 1234);
  assert.equal(walletEurMinor({ hasWallet: true, currency: 3, balance: 5 }), 500);
  assert.equal(walletEurMinor({ hasWallet: true, currency: 3, balance: 0 }), 0);
});

test('H-STO-002: an EMPTY wallet (hasWallet=false, currency 0) is a real zero, not "unknown"', () => {
  // This is what made a FIRST-EVER top-up impossible to confirm: Steam reports currency 0 for an account
  // with no wallet, the old code returned null, so the baseline was null and every result was unconfirmed.
  assert.equal(walletEurMinor({ hasWallet: false, currency: 0, balance: 0 }), 0);
});

test('H-STO-003: a NON-EUR wallet is unreadable (null) — never converted, never guessed', () => {
  assert.equal(walletEurMinor({ hasWallet: true, currency: 1, balance: 10 }), null);   // USD
  assert.equal(walletEurMinor({ hasWallet: true, currency: 2, balance: 10 }), null);   // GBP
  assert.equal(walletEurMinor({ hasWallet: true, currency: 8, balance: 1000 }), null); // JPY
});

test('H-STO-004: absent / malformed balances are unreadable', () => {
  assert.equal(walletEurMinor(undefined), null);
  assert.equal(walletEurMinor({ hasWallet: true, currency: 3, balance: NaN }), null);
  assert.equal(walletEurMinor({ hasWallet: true, currency: 3, balance: -1 }), null);
  assert.equal(walletEurMinor({ hasWallet: true, currency: 3, balance: 'x' as unknown as number }), null);
});

// ── assertOrderAmount: intent vs. what Steam is actually about to charge ────────────────────────

test('H-STO-010: a matching order total passes with no warnings', () => {
  const w: string[] = [];
  assertOrderAmount('u', { base: '500', total: '500' }, 500, w);
  assert.deepEqual(w, []);
});

test('H-STO-011: an ACCUMULATED cart (base = 2× the amount) is a HARD refusal', () => {
  // The money bug: an abandoned earlier top-up left a recharge in the cart, `add_to_cart` added a second,
  // and the operator was charged twice while SSIM reported a clean `credited`.
  const w: string[] = [];
  assert.throws(() => assertOrderAmount('u', { base: '1000', total: '1000' }, 500, w), StoreShapeError);
  assert.throws(() => assertOrderAmount('u', { base: '1000' }, 500, w), /does not match the amount you chose/);
});

test('H-STO-012: a mismatching total with no base is also a hard refusal', () => {
  assert.throws(() => assertOrderAmount('u', { total: '750' }, 500, []), /Nothing was opened/);
});

test('H-STO-013: base matches but total differs (tax/fee) → allowed, but LOUDLY warned', () => {
  const w: string[] = [];
  assertOrderAmount('u', { base: '500', total: '595' }, 500, w);
  assert.equal(w.length, 1);
  assert.match(w[0], /5\.95 €/);
  assert.match(w[0], /before paying/);
});

test('H-STO-014: no verifiable total at all → warn rather than silently trust', () => {
  const w: string[] = [];
  assertOrderAmount('u', { success: 1 }, 500, w);
  assert.equal(w.length, 1);
  assert.match(w[0], /could not be verified/);
});

test('H-STO-015: only well-formed minor-unit values count as a verified amount', () => {
  assert.equal(parseMinorUnits('500'), 500);
  assert.equal(parseMinorUnits(500), 500);
  assert.equal(parseMinorUnits('5.00'), null);      // a formatted string is NOT a minor-unit count
  assert.equal(parseMinorUnits('-500'), null);
  assert.equal(parseMinorUnits(''), null);
  assert.equal(parseMinorUnits(null), null);
  assert.equal(parseMinorUnits(500.5), null);
  // …so a garbage `base` never silently "matches" and never falsely refuses: it just isn't a verification.
  const w: string[] = [];
  assertOrderAmount('u', { base: '5.00' }, 500, w);
  assert.match(w[0], /could not be verified/);
});

// ── Host / URL guards ──────────────────────────────────────────────────────────────────────────

test('H-STO-020: the authenticated cookie may only go to the two allowlisted Steam hosts', () => {
  assert.doesNotThrow(() => assertStoreHost('https://store.steampowered.com/cart/'));
  assert.doesNotThrow(() => assertStoreHost('https://checkout.steampowered.com/checkout/'));
  for (const bad of [
    'https://evil.com/',
    'https://steamcommunity.com/market/',
    'https://store.steampowered.com.evil.com/',
    'https://evil.com/?x=store.steampowered.com',
    'https://store.steampowered.com@evil.com/',
    'not a url',
  ]) assert.throws(() => assertStoreHost(bad), StoreShapeError, `should refuse ${bad}`);
});

test('H-STO-021: only an https Steam checkout URL may be handed to the browser', () => {
  assert.ok(isSteamHttpsUrl('https://checkout.steampowered.com/checkout/externallink/?transid=1'));
  assert.ok(isSteamHttpsUrl('https://store.steampowered.com/steamaccount/addfunds'));
  assert.equal(isSteamHttpsUrl('http://checkout.steampowered.com/'), false);   // no plaintext
  assert.equal(isSteamHttpsUrl('https://www.paysafecard.com/pay'), false);     // Steam redirects us there
  assert.equal(isSteamHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isSteamHttpsUrl(''), false);
  assert.throws(() => assertSteamHttpsUrl('https://evil.com/', 'checkout'), /refusing to open non-Steam URL/);
});
