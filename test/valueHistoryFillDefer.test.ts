import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueHistoryService } from '../src/core/ValueHistoryService';

// ════════════════════════════════════════════════════════════════════════════
//  S67 — a worth-curve snapshot taken mid price-fill permanently captured an
//  UNDERCOUNTED item total (most items still unpriced). snapshotAll now DEFERS
//  while a fill is in progress and records the point once the fill drains.
// ════════════════════════════════════════════════════════════════════════════

type Internals = {
  data: { series: Record<string, unknown[]> };
  pending?: unknown;
  checkFillDrained: () => void;
};

function make(status: () => { running: boolean; queued: number }): ValueHistoryService {
  const inv = { username: 'bot1', wallet: { currency: 1, balance: 100 }, totalValueUsd: 5000, items: [] };
  const accounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  const store = { get: () => inv };
  const tf2Store = { get: () => undefined };
  const pricing = { enrich: () => {}, status: () => ({ ...status(), fetched: 0, processed: 0, cacheSize: 0, source: 'steam' }) };
  const exchange = { getUsdToEur: () => 0.9 };
  return new ValueHistoryService(accounts as never, store as never, tf2Store as never, pricing as never, exchange as never);
}

test('S67: a snapshot during a price fill is DEFERRED — no undercounted point is recorded', () => {
  const fill = { running: true, queued: 3 };
  const svc = make(() => fill);
  svc.snapshotAll('single-refresh', 'cs2');
  const internals = svc as unknown as Internals;
  assert.equal(internals.data.series['e1'], undefined, 'no point recorded while the fill is draining');
  assert.ok(internals.pending, 'the snapshot is remembered as pending');
});

test('S67: once the fill drains, the deferred snapshot is recorded (fully priced)', () => {
  const fill = { running: true, queued: 3 };
  const svc = make(() => fill);
  svc.snapshotAll('single-refresh', 'cs2');
  const internals = svc as unknown as Internals;
  // The background fill completes …
  fill.running = false; fill.queued = 0;
  internals.checkFillDrained(); // the watcher tick
  assert.ok(internals.data.series['e1'], 'the point is recorded after the fill drains');
  assert.equal((internals.data.series['e1'][0] as { items: number }).items, 5000);
  assert.equal(internals.pending, undefined, 'the pending request is cleared');
});

test('S67: not filling → snapshot is immediate (unchanged behaviour)', () => {
  const svc = make(() => ({ running: false, queued: 0 }));
  svc.snapshotAll('manual', 'cs2');
  const internals = svc as unknown as Internals;
  assert.ok(internals.data.series['e1'], 'an idle-fill snapshot records immediately');
  assert.equal(internals.pending, undefined);
});
