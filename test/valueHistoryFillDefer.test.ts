import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueHistoryService } from '../src/core/ValueHistoryService';

// ════════════════════════════════════════════════════════════════════════════
//  S67 — a worth-curve snapshot taken mid price-fill permanently captured an
//  UNDERCOUNTED item total (most items still unpriced). snapshotAll now DEFERS
//  while a fill is in progress and records the point once the fill drains.
//
//  H-INV-022 — the defer only covered an ALREADY-RUNNING fill. A snapshot that
//  settled while prices were stale/missing (fill idle) or after a fill left names
//  as soft error-misses still recorded a permanent unflagged undercount. The
//  snapshot is now COMPLETE-or-FLAGGED: cache-missing names are queued + deferred
//  ONCE; on the drain pass the row records with `partial: true` if anything is
//  still missing/soft-nulled.
// ════════════════════════════════════════════════════════════════════════════

type Internals = {
  data: { series: Record<string, unknown[]> };
  pending?: unknown;
  checkFillDrained: () => void;
};

type Totals = { totalCents: number; missing: Array<{ name: string; appid: number }>; softNull: number };

function make(
  status: () => { running: boolean; queued: number },
  totalsOf: () => Totals = () => ({ totalCents: 5000, missing: [], softNull: 0 }),
  ensureFilled: (items: Array<{ name: string; appid: number }>) => void = () => {},
): ValueHistoryService {
  const inv = { username: 'bot1', wallet: { currency: 1, balance: 100 }, totalValueUsd: 5000, items: [] };
  const accounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  const store = { get: () => inv };
  const tf2Store = { get: () => undefined };
  const pricing = { totalsOf, ensureFilled, status: () => ({ ...status(), fetched: 0, processed: 0, cacheSize: 0, source: 'steam' }) };
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

// ── H-INV-022 ────────────────────────────────────────────────────────────────

test('H-INV-022: idle fill but a name is cache-missing → queues that name and records NOTHING', () => {
  const filled: Array<{ name: string; appid: number }> = [];
  const fill = { running: false, queued: 0 };
  const svc = make(
    () => fill,
    () => ({ totalCents: 5000, missing: [{ name: 'AK-47 | Redline', appid: 730 }], softNull: 0 }),
    (items) => { filled.push(...items); },
  );
  svc.snapshotAll('single-refresh', 'cs2');
  const internals = svc as unknown as Internals;
  assert.equal(internals.data.series['e1'], undefined, 'no undercounted point recorded while a price is missing');
  assert.deepEqual(filled, [{ name: 'AK-47 | Redline', appid: 730 }], 'ensureFilled queued exactly the missing name');
  assert.ok(internals.pending, 'a retry snapshot is pending');
});

test('H-INV-022: the missing name resolves before the drain → point recorded WITHOUT partial', () => {
  let missing: Array<{ name: string; appid: number }> = [{ name: 'AK-47 | Redline', appid: 730 }];
  const fill = { running: false, queued: 0 };
  const svc = make(() => fill, () => ({ totalCents: 5000, missing, softNull: 0 }));
  svc.snapshotAll('single-refresh', 'cs2');
  // The stubbed fill resolves the name …
  missing = [];
  const internals = svc as unknown as Internals;
  internals.checkFillDrained(); // the retry pass
  const p = internals.data.series['e1']?.[0] as { items: number; partial?: boolean } | undefined;
  assert.ok(p, 'the point is recorded on the retry pass');
  assert.equal(p!.items, 5000);
  assert.equal(p!.partial, undefined, 'fully priced on retry → not flagged');
  assert.equal(internals.pending, undefined);
});

test('H-INV-022: the name drains to a soft error-miss → point recorded WITH partial (no second ensureFilled)', () => {
  let totals: Totals = { totalCents: 5000, missing: [{ name: 'AWP | Asiimov', appid: 730 }], softNull: 0 };
  let fillCalls = 0;
  const fill = { running: false, queued: 0 };
  const svc = make(() => fill, () => totals, () => { fillCalls++; });
  svc.snapshotAll('single-refresh', 'cs2');
  assert.equal(fillCalls, 1, 'the first pass queued the fill once');
  // The fill drained but the name stuck as a soft error-miss (fresh, cents null).
  totals = { totalCents: 5000, missing: [], softNull: 1 };
  const internals = svc as unknown as Internals;
  internals.checkFillDrained(); // the retry pass
  const p = internals.data.series['e1']?.[0] as { items: number; partial?: boolean } | undefined;
  assert.ok(p, 'the point is recorded on the retry pass');
  assert.equal(p!.partial, true, 'a soft-nulled price on retry flags the point partial');
  assert.equal(fillCalls, 1, 'no second ensureFilled on the retry pass');
  assert.equal(internals.pending, undefined);
});
