import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueHistoryService } from '../src/core/ValueHistoryService';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-025 — a BACKWARD wall-clock step (NTP correction, VM/laptop resume) made
//  append()'s burst-coalesce branch move the last recorded point's timestamp
//  BACKWARD (t - last.t < 0 is always < MIN_INTERVAL), so the persisted series went
//  non-chronological — breaking aggregate()'s ascending-order cursor and the chart's
//  span math. append() now keeps last.t frozen while the clock is behind: values
//  merge into the last point but the timestamp never moves backward. Self-heals once
//  the clock passes last.t + MIN_INTERVAL_MS.
// ════════════════════════════════════════════════════════════════════════════

const notFilling = () => ({ running: false, queued: 0, fetched: 0, processed: 0, cacheSize: 0, source: 'steam' as const });

// items/wallet are read from a mutable holder so consecutive snapshots can carry different values.
function make(hold: { items: number }): ValueHistoryService {
  const inv = { username: 'bot1', wallet: { currency: 1, balance: 100 }, totalValueUsd: 0, items: [] };
  const accounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  const store = { get: () => inv };
  const tf2Store = { get: () => undefined };
  const pricing = { totalsOf: () => ({ totalCents: hold.items, missing: [], softNull: 0 }), status: notFilling };
  const exchange = { getUsdToEur: () => 0.9 };
  return new ValueHistoryService(accounts as never, store as never, tf2Store as never, pricing as never, exchange as never);
}

function series(svc: ValueHistoryService, id = 'e1'): any[] {
  return (svc as unknown as { data: { series: Record<string, any[]> } }).data.series[id];
}

test('H-INV-025: a backward clock step does NOT move a recorded point backward; values still update', () => {
  const real = Date.now;
  try {
    const T = 1_000_000_000_000;
    const hold = { items: 5000 };
    const svc = make(hold);

    Date.now = () => T;
    svc.snapshotAll('test', 'cs2');
    let s = series(svc);
    assert.equal(s.length, 1, 'first snapshot records one point');
    assert.equal(s[0].t, T, 'stamped at T');
    assert.equal(s[0].items, 5000);

    // Clock steps back 10 minutes; the same env snapshots again with a new items total.
    hold.items = 6000;
    Date.now = () => T - 10 * 60_000;
    svc.snapshotAll('test', 'cs2');
    s = series(svc);
    assert.equal(s.length, 1, 'a backward snapshot does NOT append a second, out-of-order point');
    assert.equal(s[0].t, T, 'the recorded timestamp is KEPT — it never moves backward');
    assert.equal(s[0].items, 6000, 'but the values are updated (merged into the frozen point)');
  } finally {
    Date.now = real;
  }
});

test('H-INV-025: once the clock passes last.t + MIN_INTERVAL the series appends again, strictly ascending', () => {
  const real = Date.now;
  try {
    const T = 1_000_000_000_000;
    const hold = { items: 5000 };
    const svc = make(hold);

    Date.now = () => T;
    svc.snapshotAll('test', 'cs2');

    // A backward step in between must not leave an out-of-order point behind.
    Date.now = () => T - 10 * 60_000;
    svc.snapshotAll('test', 'cs2');

    // Clock recovers and advances past the merge window (61s > MIN_INTERVAL 60s).
    hold.items = 7000;
    Date.now = () => T + 61_000;
    svc.snapshotAll('test', 'cs2');

    const s = series(svc);
    assert.equal(s.length, 2, 'a point past the merge window appends');
    assert.equal(s[0].t, T);
    assert.equal(s[1].t, T + 61_000);
    assert.equal(s[1].items, 7000);
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i].t > s[i - 1].t, 'series is strictly ascending after recovery');
    }
  } finally {
    Date.now = real;
  }
});
