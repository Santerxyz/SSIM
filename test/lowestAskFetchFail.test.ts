import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketPricing } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-PRC-006 — getLowestAsk must not fold a throttle/transport failure (429/5xx/
//  success:false / login-wall) into the same `null` as an authoritative "no price".
//  It THROWS `FETCH_FAILED_<status>` on any non-200 or bad body (route asyncHandler
//  → 500 → FE error toast), and reserves `null` ONLY for an authoritative 200 +
//  success:true with no parseable lowest/median. (S2 parity with SteamPriceSource.)
// ─────────────────────────────────────────────────────────────────────────────

function installAxiosMock(responder: (url: string) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

const name = 'AK-47 | Redline (Field-Tested)';

test('H-PRC-006: getLowestAsk THROWS FETCH_FAILED on 429 (throttle), not a silent null', async () => {
  const mp = new MarketPricing();
  const restore = installAxiosMock(async () => ({ status: 429, data: {} }));
  try {
    await assert.rejects(() => mp.getLowestAsk(name, 730, 3, 2), /FETCH_FAILED_429/);
  } finally { restore(); }
});

test('H-PRC-006: getLowestAsk THROWS on 5xx and on success:false', async () => {
  const mp = new MarketPricing();

  let restore = installAxiosMock(async () => ({ status: 500, data: {} }));
  try {
    await assert.rejects(() => mp.getLowestAsk(name, 730, 3, 2), /FETCH_FAILED_500/, '5xx must throw');
  } finally { restore(); }

  restore = installAxiosMock(async () => ({ status: 200, data: { success: false } }));
  try {
    await assert.rejects(() => mp.getLowestAsk(name, 730, 3, 2), /FETCH_FAILED_200/, 'success:false must throw');
  } finally { restore(); }
});

test('H-PRC-006: getLowestAsk resolves null ONLY for an authoritative 200+success no-price', async () => {
  const mp = new MarketPricing();
  const restore = installAxiosMock(async () => ({ status: 200, data: { success: true } })); // no lowest/median
  try {
    assert.equal(await mp.getLowestAsk('Some Unpriced Item', 730, 3, 2), null);
  } finally { restore(); }
});

test('H-PRC-006: getLowestAsk returns the parsed price on an authoritative hit', async () => {
  const mp = new MarketPricing();
  const restore = installAxiosMock(async () => ({ status: 200, data: { success: true, lowest_price: '1,50€' } }));
  try {
    assert.equal(await mp.getLowestAsk(name, 730, 3, 2), 150);
  } finally { restore(); }
});
