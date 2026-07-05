import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  S16 — a casket move (~0.9–1.8s/item) must not hit a FIXED 60s cap that both
//  false-"times out" large moves AND abandons a detached loop. The backstop now
//  scales with item count, and the loop has its OWN shorter deadline so it aborts
//  cooperatively (returning a partial result) before the backstop can fire.
//  (withSession is overridden per-instance so we exercise moveCasketItems' budget
//  math + loop without the real GC session/connect machinery.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

test('S16: the withSession backstop scales with item count (no fixed 60s cap)', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  let captured = -1;
  // Capture the scaled timeout WITHOUT running the (slow, real-paced) loop.
  gc.withSession = async (_u: string, _fn: unknown, timeoutMs: number) => {
    captured = timeoutMs;
    return { moved: [], unconfirmed: [], failed: [] };
  };

  await gc.moveCasketItems('bot', 'c1', ['a', 'b', 'c'], 'withdraw');
  assert.equal(captured, 49_000, '3 items → (20000 + 3*3000) + 20000');

  await gc.moveCasketItems('bot', 'c1', Array.from({ length: 100 }, (_, i) => String(i)), 'withdraw');
  assert.equal(captured, 340_000, '100 items → (20000 + 100*3000) + 20000');
  assert.ok(captured > 60_000, 'a 100-item move gets far more than the old fixed 60s (which false-timed-out)');
});

test('S16: the loop aborts COOPERATIVELY at the deadline → partial result, no detached loop', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  let t = 5_000_000;
  const go = {
    haveGCSession: true,
    // withdraw wants NO casket_id → verify true at once; the c1 unit must exist for the pre-flight guard.
    inventory: [{ id: 'c1' }, ...['a', 'b', 'c', 'd'].map((id) => ({ id }))],
    removeFromCasket: () => { t += 10_000_000; },          // each send jumps the clock far past the deadline
    addToCasket: () => { t += 10_000_000; },
    getCasketContents: (_c: string, cb: (e: Error | null, items: unknown[]) => void) => cb(null, []),
  };
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go); // run the loop directly

  const realNow = Date.now;
  Date.now = () => t;
  try {
    const res = await gc.moveCasketItems('bot', 'c1', ['a', 'b', 'c', 'd'], 'withdraw');
    const attempted = res.moved.length + res.unconfirmed.length + res.failed.length;
    assert.ok(attempted >= 1, 'at least the first item was attempted');
    assert.ok(attempted < 4, `the loop self-aborted at the deadline (attempted ${attempted}/4), not a detached full run`);
  } finally {
    Date.now = realNow;
  }
});
