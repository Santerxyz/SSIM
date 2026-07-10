import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketPricing } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-PRC-002 — getSellInfo takes an optional wall-clock `budgetMs`. Under a
//  throttle storm the 3-try cascade (12s/15s/20s + backoffs, ~48.5s worst case)
//  cannot respond before the 120s client abort. A budget makes the interactive
//  sell-preview bound the cascade: it stops before a try it can't finish inside
//  the budget, caps each try's axios timeout to the time left, and skips a
//  backoff that would cross the deadline — returning a (partial, non-authoritative)
//  result the modal can render with a per-name retry instead of a dead spinner.
//  Background callers (mass-sell) pass no budget → the cascade is unchanged.
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

test('H-PRC-002: a budget bounds the cascade to ≤2 HTTP attempts and resolves within the budget', async () => {
  const mp = new MarketPricing();
  let attempts = 0;
  // Each try HANGS until its own (budget-capped) axios timeout, then rejects like a
  // real axios timeout would. This is the throttle-storm shape the budget must survive.
  const restore = installAxiosMock((_url, cfg) => {
    attempts++;
    const to = cfg?.timeout ?? 12_000;
    return new Promise((_res, rej) => setTimeout(() => rej(new Error(`timeout of ${to}ms exceeded`)), to));
  });
  const t0 = Date.now();
  try {
    const info = await mp.getSellInfo(name, { budgetMs: 3_000 });
    const elapsed = Date.now() - t0;
    // No try answered → non-authoritative null (must NOT be cached as "no price", S2 class).
    assert.equal(info.lowestCents, null);
    assert.equal(info.authoritative, false);
    assert.ok(attempts <= 2, `expected ≤2 HTTP attempts under a 3s budget, got ${attempts}`);
    assert.ok(attempts >= 1, `expected at least one attempt inside the budget, got ${attempts}`);
    assert.ok(elapsed <= 4_000, `must resolve within ~budget, took ${elapsed}ms`);
  } finally { restore(); }
});

test('H-PRC-002: a budget too small to finish any try stops the cascade with zero attempts', async () => {
  const mp = new MarketPricing();
  let attempts = 0;
  const restore = installAxiosMock((_url, cfg) => {
    attempts++;
    const to = cfg?.timeout ?? 12_000;
    return new Promise((_res, rej) => setTimeout(() => rej(new Error(`timeout of ${to}ms exceeded`)), to));
  });
  const t0 = Date.now();
  try {
    // 2000ms is the headroom the loop requires before starting a try, so 1500 < headroom → never starts.
    const info = await mp.getSellInfo(name, { budgetMs: 1_500 });
    assert.equal(attempts, 0, `no try can finish inside the budget → none started, got ${attempts}`);
    assert.equal(info.authoritative, false);
    assert.ok(Date.now() - t0 < 500, 'returns effectively immediately');
  } finally { restore(); }
});

test('H-PRC-002: no budget → the full cascade runs (2 authenticated tries; UA-rotation cascade removed)', async () => {
  const mp = new MarketPricing();
  let attempts = 0;
  // Every try answers instantly with a throttled body (non-200) so all tries are exercised. The 2026-07-10
  // fix collapsed the old 3× UA-rotation cascade to 2 tries — the lever is the auth cookie, not the UA.
  const restore = installAxiosMock(async () => { attempts++; return { status: 429, data: {} }; });
  try {
    const info = await mp.getSellInfo(name); // no budgetMs
    assert.equal(attempts, 2, 'unbounded cascade issues both tries');
    assert.equal(info.authoritative, false, 'all tries threw → non-authoritative null');
  } finally { restore(); }
});
