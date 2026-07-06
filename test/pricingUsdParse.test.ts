import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamPriceSource } from '../src/pricing/sources/SteamPriceSource';

// ─────────────────────────────────────────────────────────────────────────────
//  H-PRC-019 (#32 residue) — the USD fill/valuation path must parse Steam's
//  localized price strings with the shared separator-detecting parser, not the
//  old rigid ','=thousands / '.'=decimal heuristic. A Steam locale-format flip
//  (comma-decimal "1,23", grouped "2.500,00") must scale correctly, not 100×.
// ─────────────────────────────────────────────────────────────────────────────

function installAxiosMock(responder: (url: string) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

const price200 = (data: unknown) => installAxiosMock(async () => ({ status: 200, data }));

test('#32: comma-decimal "1,23" resolves 123 cents (not 12300 — the old 100× mis-scale)', async () => {
  const src = new SteamPriceSource();
  const restore = price200({ success: true, lowest_price: '1,23', median_price: '1,23' });
  try {
    assert.equal(await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730), 123);
  } finally { restore(); }
});

test('#32: canonical US string "$1,234.56" resolves 123456 cents', async () => {
  const src = new SteamPriceSource();
  const restore = price200({ success: true, lowest_price: '$1,234.56' });
  try {
    assert.equal(await src.fetchPriceCents('Some Item', 730), 123456);
  } finally { restore(); }
});

test('#32: European grouped string "2.500,00" resolves 250000 cents', async () => {
  const src = new SteamPriceSource();
  const restore = price200({ success: true, lowest_price: '2.500,00' });
  try {
    assert.equal(await src.fetchPriceCents('Some Item', 730), 250000);
  } finally { restore(); }
});
