import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quiesceMoneyOps } from '../src/utils/quiesce';

// ─────────────────────────────────────────────────────────────────────────────
//  H-XCT-005 — S14 gated the mid-session update SWAP on isBusy() so an in-flight
//  buy/sell/trade/craft/move is never hard-exited mid-commit. The far-more-common
//  graceful-shutdown and re-license teardown paths did NOT — they ran logoutAll()
//  (severing every web session) with a createBuyOrder/sellitem/sendTrade still
//  awaiting Steam, turning "close the app" into the same ambiguous-commit state
//  S3/B4 protect against. quiesceMoneyOps() shares the exact busy-set as ONE
//  bounded drain: settle in-flight ops, then tear down — STRICTLY timeout-bounded
//  (a wedged op must never hold exit) and never a retry (owner no-band-aid rule).
//
//  The drain helper is a pure, injectable function → unit-tested directly. The
//  WIRING into shutdown()/teardownFullApp() lives in the self-bootstrapping,
//  process.exit-scheduling index.ts (untestable in-process, cf. shellDeathShutdown)
//  → locked here by source assertion, verified alongside `tsc`.
// ─────────────────────────────────────────────────────────────────────────────

test('quiesceMoneyOps: returns "drained" as soon as busy() clears', async () => {
  let polls = 0;
  const isBusy = () => { polls++; return polls <= 3; }; // busy for 3 checks, then clear
  const slept: number[] = [];
  const res = await quiesceMoneyOps(isBusy, {
    timeoutMs: 6000,
    pollMs: 150,
    now: () => 0, // clock frozen → deadline never reached; only busy() gates the loop
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(res, 'drained', 'clears once no op is busy');
  assert.equal(slept.length, 3, 'slept once per busy poll, not after it cleared');
});

test('quiesceMoneyOps: a permanently-busy op still exits with "timeout" at the budget', async () => {
  let clock = 0;
  const slept: number[] = [];
  const res = await quiesceMoneyOps(() => true, { // never clears
    timeoutMs: 6000,
    pollMs: 150,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; }, // advance the injected clock
  });
  assert.equal(res, 'timeout', 'a wedged op must not prevent exit — it times out');
  // Bounded: total slept never exceeds the budget (never blocks past timeoutMs).
  const total = slept.reduce((a, b) => a + b, 0);
  assert.ok(total <= 6000, `drain is strictly bounded by timeoutMs (slept ${total}ms)`);
});

test('quiesceMoneyOps: an already-idle app drains immediately with no sleep', async () => {
  let slept = false;
  const res = await quiesceMoneyOps(() => false, { sleep: async () => { slept = true; } });
  assert.equal(res, 'drained', 'nothing busy → drains at once');
  assert.equal(slept, false, 'no poll sleep when already idle');
});

// ─── Wiring: both exit paths and the shell watchdog gate on the money-op drain ──
const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
const LIB_RS = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8').replace(/\r\n/g, '\n');

// teardownFullApp() was the second drain site; it existed only for the licence-revocation
// re-activation path and was removed with the licence gate. shutdown() is now the sole exit
// path, and it must still drain before severing sessions.
test('H-XCT-005: the exit path quiesces money ops before teardown', () => {
  const calls = SRC.match(/await quiesceMoneyOps\(isBusy,/g) ?? [];
  assert.ok(calls.length >= 1, 'the exit path must await the bounded drain before severing sessions');
});

test('H-XCT-005: shutdown quiesces BEFORE logoutAll severs the web session', () => {
  const shutdownBody = /async function shutdown\([\s\S]*?\n\}\n\nprocess\.on\('SIGINT'/.exec(SRC)?.[0] ?? '';
  // Match the actual CALL sites (paren-anchored) so a mention in a comment can't skew the order.
  const quiesceAt = shutdownBody.indexOf('quiesceMoneyOps(isBusy');
  const logoutAt = shutdownBody.indexOf('logoutAll()');
  assert.ok(quiesceAt > -1 && logoutAt > -1, 'shutdown drains then logs out');
  assert.ok(quiesceAt < logoutAt, 'the drain must run BEFORE logoutAll severs sessions');
});

test('H-XCT-005: the busy-set is a single source of truth shared with the S14 update-swap gate', () => {
  // One `const isBusy` definition, referenced by the update scheduler AND both drains.
  const defs = SRC.match(/const isBusy = \(\): boolean =>/g) ?? [];
  assert.equal(defs.length, 1, 'exactly one isBusy definition (single source of truth)');
  assert.match(SRC, /isBusy,\s*\n\s*\}\);/, 'the update scheduler reuses the shared isBusy');
});

test('H-XCT-005: the hard-exit fallback strictly exceeds the quiesce budget', () => {
  assert.match(SRC, /setTimeout\(\(\) => process\.exit\(0\), QUIESCE_TIMEOUT_MS \+ 3000\)\.unref\(\)/,
    'the fallback must outlast the drain so the bounded quiesce always has room');
});

test('H-XCT-005: quiesce is strictly timeout-bounded (no unbounded wait) and no money-op retry', () => {
  // No-band-aid guard: the drain never retries the op; it only waits (bounded) for busy() to clear.
  assert.match(SRC, /quiesceMoneyOps\(isBusy, \{ timeoutMs: QUIESCE_TIMEOUT_MS \}\)/,
    'the drain passes a hard timeout budget');
});

test('H-XCT-005: the shell close watchdog is raised to outlast the backend drain', () => {
  assert.match(LIB_RS, /Duration::from_secs\(12\)/, 'the 8s watchdog is raised to 12s > backend drain budget');
  assert.ok(!/Duration::from_secs\(8\)/.test(LIB_RS.split('CloseRequested')[1] ?? LIB_RS),
    'the CloseRequested watchdog no longer force-kills at 8s');
});
