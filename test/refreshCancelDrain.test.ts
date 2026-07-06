import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';
import { LocalIpThrottle, ThrottleSkippedError } from '../src/network/LocalIpThrottle';

// ─────────────────────────────────────────────────────────────────────────────
//  H-INV-008 — "End Task" must skip throttle-queued local-IP accounts instead of
//  draining them serially through the 6–12s cooldown chain. Cancel used to be
//  consulted only before a worker pulled the NEXT account; an account already
//  handed to localIpThrottle.run() was committed and fetched, so a cancelled run
//  kept hammering Steam for minutes (25 workers × cooldown + fetch, incl. 35s
//  rate-limit pauses). The throttle now consults a `skip` predicate at the very
//  front of the chain (before the cooldown wait, without touching lastStartAt):
//  a cancelled backlog collapses immediately with ThrottleSkippedError, which the
//  bulk worker classifies as a skip (NOT job.failed) while still counting done.
// ─────────────────────────────────────────────────────────────────────────────

test('ThrottleSkippedError: a queued task whose skip() is true throws before any cooldown', async () => {
  const throttle = new LocalIpThrottle(5000, 5000); // 5s cooldown — a real drain would take seconds
  const started = new Date();
  await assert.rejects(
    throttle.run(async () => 'unreachable', { skip: () => true }),
    (err: unknown) => (err as { skipped?: boolean }).skipped === true && err instanceof ThrottleSkippedError,
  );
  // Skipped BEFORE the 5s wait — the whole call returns in well under a cooldown period.
  assert.ok(Date.now() - started.getTime() < 1000, 'a skipped task must not wait out its cooldown');
});

test('H-INV-008: cancelling a local-IP bulk refresh drains fast, skips are not failures', async () => {
  const svc = Object.create(InventoryService.prototype) as InventoryService;
  const usernames = ['a', 'b', 'c', 'd', 'e'];

  // A real throttle with a long (5s) cooldown: without the skip fix, draining 5 serial accounts
  // would take multiple cooldown periods; with it, the queued tail collapses immediately.
  (svc as any).localIpThrottle = new LocalIpThrottle(5000, 5000);
  (svc as any).refreshCancel = false;
  (svc as any).job = { running: false };
  // Every account is local-IP so they all route through the throttle.
  (svc as any).accounts = { get: () => ({ network: { type: 'local' } }) };
  // ownershipCtx.run just invokes the callback; getStore() is unused on this path.
  (svc as any).ownershipCtx = { run: (store: unknown, fn: () => unknown) => fn(), getStore: () => undefined };
  // No session release under test — isLive false so the worker's finally never logs out.
  (svc as any).sessions = { isLive: () => false };
  const flushed = { flush: () => {} };
  (svc as any).gcStore = flushed;
  (svc as any).tf2Store = flushed;
  (svc as any).onCompleteCb = undefined;

  // refreshOne resolves instantly; the FIRST call flips cancel on, so accounts 2–5 sit in the
  // throttle queue behind a 5s cooldown and must be SKIPPED (not fetched, not failed).
  let fetches = 0;
  (svc as any).refreshOne = async () => {
    fetches++;
    (svc as any).refreshCancel = true; // simulate "End Task" pressed while the first fetch runs
    return { totalItems: 0 };
  };

  const started = Date.now();
  svc.startRefresh(usernames, 'cs2');

  // Wait for the job to settle (poll the running flag; each skip is synchronous so this is fast).
  while ((svc as any).job.running) await new Promise((r) => setImmediate(r));

  const elapsed = Date.now() - started;
  const job = (svc as any).job;
  assert.equal(job.cancelled, true, 'the run reports cancelled');
  assert.deepEqual(job.failed, [], 'skipped accounts must NOT be counted as failures');
  assert.equal(job.done, usernames.length, 'every account is still counted as done');
  assert.equal(fetches, 1, 'only the first account is actually fetched; the rest are skipped');
  assert.ok(elapsed < 2000, `cancel must drain in well under one 5s cooldown (took ${elapsed}ms)`);
});
