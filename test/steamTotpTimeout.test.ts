import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTimeoutGetOffset } from '../src/trading/steamTotpTimeout';

// ─────────────────────────────────────────────────────────────────────────────
//  S6 — getTimeOffset must be timeout-bounded + cached, so a stalled QueryTime
//  never wedges every confirmation/money path until restart.
// ─────────────────────────────────────────────────────────────────────────────

type Cb = (err: Error | null, off: number, latency?: number) => void;
const call = (fn: (cb: Cb) => void) =>
  new Promise<{ err: Error | null; off: number }>((res) => fn((err, off) => res({ err, off })));

test('S6: a stall with NO cache surfaces a timeout error and off 0', async () => {
  let calls = 0;
  const stall = () => { calls++; /* never calls back — the adversarial stall */ };
  const wrapped = makeTimeoutGetOffset(stall, { timeoutMs: 20 });
  const { err, off } = await call(wrapped);
  // Cold fallback surfaces the cause so a memoizing consumer (steamcommunity pins _timeOffset 12h on
  // success) re-fetches next call instead of pinning our 0. AccountTrader's `off = err ? 0 : offset` → 0.
  assert.ok(err instanceof Error && /timed out/.test(err.message), 'a no-cache stall surfaces the timeout error');
  assert.equal(off, 0, 'falls back to 0 instead of hanging forever');
  assert.equal(calls, 1);
});

test('S6: a stall with a warm cache yields err null + the cached offset', async () => {
  let calls = 0; let mode: 'ok' | 'stall' = 'ok';
  const impl = (cb: Cb) => { calls++; if (mode === 'ok') cb(null, 42); /* else: never calls back */ };
  const wrapped = makeTimeoutGetOffset(impl, { timeoutMs: 20, cacheTtlMs: 0 });
  assert.equal((await call(wrapped)).off, 42, 'first call caches the real offset');
  mode = 'stall';
  const { err, off } = await call(wrapped);   // cacheTtlMs 0 → cache expired, re-fetch stalls
  assert.equal(err, null, 'a warm fallback delivers a real value, so err is null');
  assert.equal(off, 42, 'the cached offset is surfaced on the stall fallback');
});

test('S6: a successful offset is CACHED — a 2nd call does not touch the network', async () => {
  let calls = 0;
  const ok = (cb: Cb) => { calls++; cb(null, 42); };
  const wrapped = makeTimeoutGetOffset(ok, { timeoutMs: 50 });
  assert.equal((await call(wrapped)).off, 42);
  assert.equal((await call(wrapped)).off, 42, 'served from cache');
  assert.equal(calls, 1, 'the underlying getTimeOffset ran exactly once');
});

test('S6: an ERROR with no cache surfaces the err, falls back to 0, and is NOT cached', async () => {
  let calls = 0;
  const boom = (cb: Cb) => { calls++; cb(new Error('QueryTime 500'), 0); };
  const wrapped = makeTimeoutGetOffset(boom, { timeoutMs: 50 });
  const { err, off } = await call(wrapped);
  assert.ok(err instanceof Error && /QueryTime 500/.test(err.message), 'the vendor err is surfaced (no memo pins our 0)');
  assert.equal(off, 0);
  await call(wrapped);
  assert.equal(calls, 2, 'an error/timeout is not cached → re-attempted next time');
});

test('S6: a NaN offset from the vendor falls back and is not cached', async () => {
  let calls = 0;
  // The vendor's missing-return bug: a 200 whose server_time is truthy-non-numeric fires callback(null, NaN).
  const nan = (cb: Cb) => { calls++; cb(null, calls === 1 ? NaN : 9); };
  const wrapped = makeTimeoutGetOffset(nan, { timeoutMs: 50 });
  assert.equal((await call(wrapped)).off, 0, 'a NaN "success" falls back to 0 (not delivered/cached as NaN)');
  assert.equal((await call(wrapped)).off, 9, 'not cached → a subsequent success re-fetches the real value');
  assert.equal(calls, 2, 'the NaN was not cached, so the underlying getTimeOffset ran again');
});

test('S6: concurrent misses share ONE underlying fetch', async () => {
  let calls = 0; let captured: Cb | null = null;
  const defer = (cb: Cb) => { calls++; captured = cb; /* answers later */ };
  const wrapped = makeTimeoutGetOffset(defer, { timeoutMs: 50_000 });
  const a = call(wrapped);
  const b = call(wrapped);              // second miss coalesces onto the first in-flight fetch
  captured!(null, 42);                  // one terminal result fans out to both subscribers
  assert.equal((await a).off, 42);
  assert.equal((await b).off, 42);
  assert.equal(calls, 1, 'concurrent misses fire the underlying getTimeOffset exactly once');
});

test('S6: concurrent misses share ONE timeout stall (both get the fallback)', async () => {
  let calls = 0;
  const stall = () => { calls++; /* never calls back */ };
  const wrapped = makeTimeoutGetOffset(stall, { timeoutMs: 20 });
  const a = call(wrapped);
  const b = call(wrapped);             // coalesces onto the same stalling fetch + its single timer
  assert.equal((await a).off, 0, 'both subscribers get the timeout fallback');
  assert.equal((await b).off, 0);
  assert.equal(calls, 1, 'only one raw request was armed for both callers');
});

test('S6: the cache expires after cacheTtlMs (re-fetch)', async () => {
  let clock = 1000; let calls = 0;
  const ok = (cb: Cb) => { calls++; cb(null, 7); };
  const wrapped = makeTimeoutGetOffset(ok, { timeoutMs: 50, cacheTtlMs: 100, now: () => clock });
  await call(wrapped);                 // caches at clock=1000
  clock += 50; await call(wrapped); assert.equal(calls, 1, 'still fresh within TTL');
  clock += 100; await call(wrapped); assert.equal(calls, 2, 'expired → re-fetched');
});

test('S6: a synchronously-throwing original degrades to 0, never crashes', async () => {
  const wrapped = makeTimeoutGetOffset(() => { throw new Error('boom'); }, { timeoutMs: 50 });
  assert.equal((await call(wrapped)).off, 0);
});

test('S6: a wall-clock step invalidates the cached offset', async () => {
  let wall = 1000; let mono = 1000; let calls = 0;
  const ok = (cb: Cb) => { calls++; cb(null, 7); };
  const wrapped = makeTimeoutGetOffset(ok, {
    timeoutMs: 50, cacheTtlMs: 60 * 60 * 1000,
    now: () => wall, monotonicNow: () => mono,
  });
  await call(wrapped);                          // caches at wall=1000/mono=1000
  wall += 120_000; mono += 1_000;               // clock steps forward 2min, only 1s of real time elapsed
  await call(wrapped);
  assert.equal(calls, 2, 'the wall/mono divergence expired the cache → re-fetched');
});
