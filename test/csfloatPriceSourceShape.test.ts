import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsFloatPriceSource } from '../src/pricing/sources/CsFloatPriceSource';

// ─────────────────────────────────────────────────────────────────────────────
//  S2 — a malformed/non-JSON 2xx body (HTML interstitial, drifted listing shape)
//  must NOT be cached as an authoritative 24h "no price". CsFloatPriceSource
//  distinguishes an authoritative empty result (null) from an unexpected body /
//  unreadable price (throw → PricingService caches a short-lived soft miss).
// ─────────────────────────────────────────────────────────────────────────────

// Build a source over a stubbed CsFloatService whose pricingClient().searchListings
// returns the supplied body verbatim.
function sourceReturning(body: unknown): CsFloatPriceSource {
  const stub = {
    pricingClient: () => ({ searchListings: async () => body }),
  } as any;
  return new CsFloatPriceSource(stub);
}

test('S2: CsFloatPriceSource returns the listing price for a well-formed body', async () => {
  const src = sourceReturning({ data: [{ price: 4200 }] });
  assert.equal(await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), 4200);
});

test('S2: an authoritative empty array is a real "no price" (null, not a throw)', async () => {
  const src = sourceReturning({ data: [] });
  assert.equal(await src.fetchPriceCents('Some Unpriced Item', 730), null);
});

test('S2: a non-array/HTML-string 2xx body THROWS (transient), not a hard null', async () => {
  const html = sourceReturning('<!doctype html> checking your browser');
  await assert.rejects(() => html.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), /FETCH_FAILED/);

  const noData = sourceReturning({ notdata: 1 });
  await assert.rejects(() => noData.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), /FETCH_FAILED/);
});

test('S2: a listing whose price is unreadable (string/negative) THROWS, not a hard null', async () => {
  const strPrice = sourceReturning({ data: [{ price: '42.00' }] });
  await assert.rejects(() => strPrice.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), /FETCH_FAILED/);

  const negPrice = sourceReturning({ data: [{ price: -5 }] });
  await assert.rejects(() => negPrice.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), /FETCH_FAILED/);
});

test('a non-CS2 appid is authoritatively null without touching the client', async () => {
  const src = sourceReturning({ data: [{ price: 4200 }] });
  assert.equal(await src.fetchPriceCents('Mann Co. Supply Crate Key', 440), null);
});

test('S2/S13: no client at dequeue (key cleared mid-fill) THROWS for a CS2 name, not a hard null', async () => {
  const noClient = new CsFloatPriceSource({ pricingClient: () => null } as any);
  await assert.rejects(() => noClient.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), /FETCH_FAILED/);
  // the appid gate is authoritative and runs before the client check — TF2 still resolves null
  assert.equal(await noClient.fetchPriceCents('Mann Co. Supply Crate Key', 440), null);
});
