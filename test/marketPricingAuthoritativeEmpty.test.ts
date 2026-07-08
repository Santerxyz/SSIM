import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketPricing } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-PRC-004 — an allowMedian try that authoritatively returns NEITHER a lowest
//  ask NOR a median cannot be interpreted more permissively by a later try, so
//  getSellInfo short-circuits the cascade instead of burning try 3 + its backoff.
//  It also tags lowestCents' provenance via `basis` ('lowest' | 'median' | null)
//  so a median-derived figure is no longer indistinguishable from a real ask.
// ─────────────────────────────────────────────────────────────────────────────

/** Replaces axios.get with `responder`, returns a restore fn. */
function installAxiosMock(responder: (url: string, cfg: any) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

const name = 'AK-47 | Redline (Field-Tested)';

test('H-PRC-004: an authoritative empty on an allowMedian try stops the cascade (no try 3)', async () => {
  const mp = new MarketPricing();
  let attempts = 0;
  // Try 1 (Chrome) throttled → throws; try 2 (Firefox, allowMedian) answers
  // authoritatively with NO price fields → cascade must stop before try 3.
  const restore = installAxiosMock(async () => {
    attempts++;
    if (attempts === 1) return { status: 429, data: {} };
    return { status: 200, data: { success: true } };
  });
  try {
    const info = await mp.getSellInfo(name);
    assert.equal(attempts, 2, 'try 3 must not run once try 2 is authoritatively empty');
    assert.equal(info.authoritative, true);
    assert.equal(info.lowestCents, null);
    assert.equal(info.medianCents, null);
    assert.equal(info.basis, null);
  } finally { restore(); }
});

test('H-PRC-004: a median-only body is tagged basis:"median"', async () => {
  const mp = new MarketPricing();
  let attempts = 0;
  // Try 1 throttled; try 2 has only a median_price (no lowest_price) → the median
  // is substituted into lowestCents and `basis` records that provenance.
  const restore = installAxiosMock(async () => {
    attempts++;
    if (attempts === 1) return { status: 429, data: {} };
    return { status: 200, data: { success: true, median_price: '1,50€' } };
  });
  try {
    const info = await mp.getSellInfo(name);
    assert.equal(attempts, 2, 'a priced try 2 ends the cascade');
    assert.equal(info.lowestCents, 150);
    assert.equal(info.medianCents, 150);
    assert.equal(info.basis, 'median');
  } finally { restore(); }
});

test('H-PRC-004: a real lowest ask is tagged basis:"lowest"', async () => {
  const mp = new MarketPricing();
  const restore = installAxiosMock(async () => ({ status: 200, data: { success: true, lowest_price: '2,00€', median_price: '2,50€' } }));
  try {
    const info = await mp.getSellInfo(name);
    assert.equal(info.lowestCents, 200);
    assert.equal(info.basis, 'lowest');
  } finally { restore(); }
});
