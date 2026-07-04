import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueHistoryService } from '../src/core/ValueHistoryService';

// ════════════════════════════════════════════════════════════════════════════
//  S66 — a wallet in a currency FX can't convert (anything but USD/EUR) silently
//  contributed 0 to the worth curve, so the plotted wallet total looked exact but
//  was undercounted. The point is now FLAGGED `partial` when that happens.
// ════════════════════════════════════════════════════════════════════════════

const notFilling = () => ({ running: false, queued: 0, fetched: 0, processed: 0, cacheSize: 0, source: 'steam' as const });

function make(walletCurrency: number, balance = 100): ValueHistoryService {
  const inv = { username: 'bot1', wallet: { currency: walletCurrency, balance }, totalValueUsd: 5000, items: [] };
  const accounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  const store = { get: () => inv };
  const tf2Store = { get: () => undefined };
  const pricing = { enrich: () => { /* cache-only no-op */ }, status: notFilling };
  const exchange = { getUsdToEur: () => 0.9 };
  return new ValueHistoryService(accounts as never, store as never, tf2Store as never, pricing as never, exchange as never);
}

function lastPoint(svc: ValueHistoryService, series = 'e1'): any {
  const s = (svc as unknown as { data: { series: Record<string, any[]> } }).data.series[series];
  return s[s.length - 1];
}

test('S66: a non-USD/EUR wallet FLAGS the point partial (undercounted, not silently exact)', () => {
  const svc = make(20); // a currency code FX can't convert (only USD=1, EUR=3 are handled)
  svc.snapshotAll('test', 'cs2');
  const p = lastPoint(svc);
  assert.equal(p.partial, true, 'a wallet we cannot convert marks the point partial');
  assert.equal(p.wallet, 0, 'the unconvertible balance still contributes 0 — but the point is now flagged');
  assert.equal(p.items, 5000, 'items are unaffected');
});

test('S66: a USD wallet is fully counted and NOT partial', () => {
  const svc = make(1); // USD
  svc.snapshotAll('test', 'cs2');
  const p = lastPoint(svc);
  assert.equal(p.partial, undefined, 'a convertible wallet is exact — no partial flag');
  assert.equal(p.wallet, 10000, 'USD balance 100 → 10000 cents');
});

test('S66: an EUR wallet converts via the live rate and is NOT partial', () => {
  const svc = make(3, 90); // EUR 90 @ rate 0.9 → 100 USD → 10000 cents
  svc.snapshotAll('test', 'cs2');
  const p = lastPoint(svc);
  assert.equal(p.partial, undefined);
  assert.equal(p.wallet, 10000);
});
