import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalIpThrottle, ThrottleSkippedError } from '../src/network/LocalIpThrottle';

// ─── H-NET-003 ────────────────────────────────────────────────────────────────
// The cooldown `sleep` timer must be unref'd (so a parked no-proxy task cannot, on
// its own, keep the event loop alive during a re-license teardown that does not
// `process.exit`), and `skip` must be re-checked AFTER the cooldown returns (so a
// task parked in the cooldown when cancel/teardown flips aborts instead of
// originating a Steam fetch on a session that is being destroyed).

// (1) Loop-hold: a parked cooldown timer must NOT by itself keep the loop alive.
// We spawn a child that forces `wait > 0`, then parks on a never-resolving task.
// The only outstanding handle is the cooldown timer. Post-fix (unref'd) the loop
// drains and the child exits promptly; pre-fix (ref'd) it blocks for the full
// 10 s cooldown. We measure the child's wall-clock lifetime and assert it is well
// under the cooldown.
test('cooldown timer is unref\'d — a parked no-proxy task does not pin the event loop', () => {
  const throttlePath = path.resolve(__dirname, '../src/network/LocalIpThrottle.ts').replace(/\\/g, '/');
  // Force a fresh cooldown: min=max=10_000 with lastStartAt just set means wait≈10s.
  // The first run() sets lastStartAt=now (wait=0, resolves), the SECOND run() must
  // wait the full 10 s — and parks on a never-resolving task, so the cooldown timer
  // is the sole outstanding handle.
  const code = `
    const { LocalIpThrottle } = require(${JSON.stringify(throttlePath)});
    const t = new LocalIpThrottle(10000, 10000);
    t.run(() => Promise.resolve());               // consumes wait=0, sets lastStartAt
    t.run(() => new Promise(() => {}));            // parks in the ~10s cooldown
    // If the cooldown timer is unref'd, nothing else keeps the loop alive → exit now.
    process.on('beforeExit', () => process.exit(0));
  `;
  const started = Date.now();
  const res = spawnSync(process.execPath, [
    '--require', 'ts-node/register/transpile-only',
    '-e', code,
  ], { cwd: path.resolve(__dirname, '..'), timeout: 9000, encoding: 'utf8' });
  const elapsed = Date.now() - started;
  // Post-fix: child reaches beforeExit and exits far under the 10s cooldown.
  // Pre-fix: the ref'd timer blocks until 10s → spawnSync kills it at 9s (SIGTERM).
  assert.equal(res.signal, null, `child was killed (signal ${res.signal}) — cooldown timer held the loop open: ${res.stderr}`);
  assert.equal(res.status, 0, `child exited non-zero: ${res.stderr}`);
  assert.ok(elapsed < 8000, `child took ${elapsed}ms — cooldown timer kept the loop alive instead of unref'ing`);
});

// (2) Skip re-check: `skip` flips to true DURING the cooldown (AFTER the
// front-of-chain check has already passed), so this exercises the NEW
// post-cooldown re-check, not the pre-existing pre-cooldown one (H-INV-008).
// The task must never run and the promise must reject with the skip sentinel.
test('skip flipping during the cooldown aborts before the fetch and rejects with ThrottleSkippedError', async () => {
  const throttle = new LocalIpThrottle(300, 300); // ~300ms cooldown window
  // Prime lastStartAt so the NEXT run() actually waits (wait > 0).
  await throttle.run(() => Promise.resolve('primed'));

  let cancelled = false;
  let taskRuns = 0;
  const p = throttle.run(
    () => { taskRuns++; return Promise.resolve('fetched'); },
    { skip: () => cancelled },
  );
  // Let the task PASS the front-of-chain skip check and park in the cooldown,
  // THEN flip — so only the post-cooldown re-check can catch it. A ref'd keepalive
  // timer holds the loop open across the unref'd cooldown for this assertion.
  const keepAlive = setTimeout(() => {}, 5000);
  await new Promise(resolve => setTimeout(resolve, 50));
  cancelled = true;

  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ThrottleSkippedError, 'expected the shared skip sentinel');
    assert.equal((err as ThrottleSkippedError).skipped, true);
    return true;
  });
  clearTimeout(keepAlive);
  assert.equal(taskRuns, 0, 'task must NOT run once skip flipped during the cooldown');
});

// (3) Regression guard: a task whose skip stays false runs normally after the cooldown.
test('a task whose skip never flips still runs after the cooldown', async () => {
  const throttle = new LocalIpThrottle(50, 50);
  await throttle.run(() => Promise.resolve('primed'));
  let taskRuns = 0;
  const out = await throttle.run(
    () => { taskRuns++; return Promise.resolve('ok'); },
    { skip: () => false },
  );
  assert.equal(out, 'ok');
  assert.equal(taskRuns, 1);
});
