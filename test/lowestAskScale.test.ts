import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketPricing } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-PRC-005 — getLowestAsk derives the minor-unit scale INSIDE the module from
//  `currency` (fail closed), instead of trusting a caller-supplied `decimals` that
//  the only call chain sourced from the DISPLAY-grade currencyInfo fallback (which
//  guesses 2 decimals for an unknown code). An unknown code now returns null with
//  no HTTP call; a known 0-decimal currency (JPY) scales correctly. (S64/B18.)
// ─────────────────────────────────────────────────────────────────────────────

function installAxiosMock(responder: (url: string) => Promise<{ status: number; data: unknown }>): { restore: () => void; calls: () => number } {
  const ax = require('axios');
  const orig = ax.get;
  let count = 0;
  const wrapped = (url: string) => { count++; return responder(url); };
  ax.get = wrapped;
  if (ax.default) ax.default.get = wrapped;
  return {
    restore: () => { ax.get = orig; if (ax.default) ax.default.get = orig; },
    calls: () => count,
  };
}

const name = 'AK-47 | Redline (Field-Tested)';

test('H-PRC-005: an unknown currency resolves null with ZERO HTTP calls (fail closed)', async () => {
  const mp = new MarketPricing();
  const mock = installAxiosMock(async () => ({ status: 200, data: { success: true, lowest_price: '1,50€' } }));
  try {
    assert.equal(await mp.getLowestAsk(name, 730, 99), null);
    assert.equal(mock.calls(), 0, 'unknown code must short-circuit before any fetch');
  } finally { mock.restore(); }
});

test('H-PRC-005: a known 0-decimal currency (JPY) scales the ask correctly', async () => {
  const mp = new MarketPricing();
  const mock = installAxiosMock(async () => ({ status: 200, data: { success: true, lowest_price: '¥ 1,234' } }));
  try {
    assert.equal(await mp.getLowestAsk(name, 730, 8), 1234);
    assert.equal(mock.calls(), 1);
  } finally { mock.restore(); }
});
