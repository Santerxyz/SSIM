import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { ValueHistoryService } from '../src/core/ValueHistoryService';
import { dataDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-027 — teardownFullApp only called flush(), which disarms flushTimer but
//  leaves the S67 `fillWatch` setInterval armed. On a runtime license-loss re-gate
//  the app stays in the SAME process, so the OLD instance's zombie fillWatch tick
//  fired ~3s later and clobbered the NEW instance's freshly-loaded history.
//  shutdown() now disarms fillWatch + drops the deferred snapshot before flushing.
//  (SSIM_HOME is a throwaway temp dir per test/_setup.cjs, so HISTORY_PATH resolves
//   to a sandboxed data/value_history.json.)
// ════════════════════════════════════════════════════════════════════════════

const HISTORY = dataDir('value_history.json');
const DIR = dataDir();

function cleanHistory(): void {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
  for (const f of fs.readdirSync(DIR)) {
    if (f.startsWith('value_history.json')) { try { fs.rmSync(dataDir(f), { force: true }); } catch { /* ignore */ } }
  }
}

type Internals = {
  data: { series: Record<string, unknown[]> };
  pending?: unknown;
  fillWatch?: NodeJS.Timeout;
  checkFillDrained: () => void;
};

function make(status: () => { running: boolean; queued: number }): ValueHistoryService {
  const inv = { username: 'bot1', wallet: { currency: 1, balance: 100 }, totalValueUsd: 5000, items: [] };
  const accounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  const store = { get: () => inv };
  const tf2Store = { get: () => undefined };
  const pricing = {
    totalsOf: () => ({ totalCents: 5000, missing: [] as Array<{ name: string; appid: number }>, softNull: 0 }),
    ensureFilled: () => {},
    status: () => ({ ...status(), fetched: 0, processed: 0, cacheSize: 0, source: 'steam' }),
  };
  const exchange = { getUsdToEur: () => 0.9 };
  return new ValueHistoryService(accounts as never, store as never, tf2Store as never, pricing as never, exchange as never);
}

test('H-INV-027: shutdown() disarms the armed fillWatch and drops the deferred snapshot', () => {
  cleanHistory();
  const fill = { running: true, queued: 3 };
  const svc = make(() => fill);
  svc.snapshotAll('single-refresh', 'cs2'); // fill running → deferred, watch armed
  const internals = svc as unknown as Internals;
  assert.ok(internals.fillWatch, 'the fillWatch interval is armed while the fill drains');
  assert.ok(internals.pending, 'the deferred snapshot is remembered');

  svc.shutdown();

  assert.equal(internals.fillWatch, undefined, 'shutdown() clears the fillWatch interval');
  assert.equal(internals.pending, undefined, 'shutdown() drops the deferred snapshot');
  cleanHistory();
});

test('H-INV-027: after shutdown() a drained fill can no longer write a zombie point', () => {
  cleanHistory();
  const fill = { running: true, queued: 3 };
  const svc = make(() => fill);
  svc.snapshotAll('single-refresh', 'cs2');
  svc.shutdown();
  const internals = svc as unknown as Internals;

  // Simulate what the leaked interval would have done: the fill drains and the tick fires.
  fill.running = false; fill.queued = 0;
  internals.checkFillDrained();

  assert.equal(internals.data.series['e1'], undefined, 'the dropped pending records nothing on a post-shutdown tick');
  cleanHistory();
});

test('H-INV-027: a shut-down instance does not clobber a second instance sharing the file', () => {
  cleanHistory();
  // First instance defers a snapshot (fill running) then is torn down.
  const fill = { running: true, queued: 3 };
  const first = make(() => fill);
  first.snapshotAll('single-refresh', 'cs2');
  first.shutdown();

  // Second instance (fresh construct in the SAME process on the SAME path) records a real point.
  const second = make(() => ({ running: false, queued: 0 }));
  second.snapshotAll('single-refresh', 'cs2');
  second.flush();

  // Now the zombie fill "drains" and the first instance's leaked tick would have fired.
  const firstInternals = first as unknown as Internals;
  fill.running = false; fill.queued = 0;
  firstInternals.checkFillDrained(); // no-op after shutdown()

  const onDisk = JSON.parse(fs.readFileSync(HISTORY, 'utf8')) as { series: Record<string, Array<{ items: number }>> };
  assert.ok(onDisk.series['e1'] && onDisk.series['e1'].length === 1, 'the second instance owns the file with one point');
  assert.equal(onDisk.series['e1'][0].items, 5000, 'the second instance data is intact — no stale overwrite');
  cleanHistory();
});
