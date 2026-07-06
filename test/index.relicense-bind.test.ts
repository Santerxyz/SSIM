import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  H-BOOT-001 — startFullApp()'s only bind-failure path was process.exit(1). On
//  FIRST boot that is correct (nothing to lose), but startFullApp is also called
//  from the runtime re-license flow (onLicenseLost → teardownFullApp → gateAndRun
//  → startFullApp). teardownFullApp does NOT reset serverPort's announcedPort, so
//  the re-bind has canWalk=false and a single transient EADDRINUSE in the sub-
//  second teardown→rebind gap rejected immediately → the whole app hard-exited,
//  tearing down every live Steam session, when the intended behaviour is a brief
//  return to the portal.
//
//  The fix classifies the failure (bind-vs-other) instead of a blind exit: on
//  !firstBoot startFullApp THROWS BindFailedError, and onLicenseLost recovers
//  (tears down the partial construction, waits, retries the bind ONCE) rather
//  than killing the operator's window. First-boot behaviour is kept byte-
//  identical (the everBound===false branch still dead-ends).
//
//  Runtime/process-lifecycle shaped — startFullApp schedules process.exit and
//  index.ts self-bootstraps, so it is untestable in-process (cf. shellDeathShutdown,
//  shutdownQuiesce); this locks the wiring, verified alongside `tsc`.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

test('H-BOOT-001: a re-license re-bind throws BindFailedError instead of exiting', () => {
  // startFullApp takes { firstBoot } and, when NOT first boot, the bind-error handler throws
  // the typed recoverable error rather than scheduling process.exit.
  assert.match(SRC, /class BindFailedError extends Error/, 'a typed bind-failure error exists');
  assert.match(SRC, /if \(!opts\.firstBoot\)\s*\{[\s\S]*?throw new BindFailedError\(/,
    'the !firstBoot bind-failure path throws BindFailedError (recoverable), not process.exit');
});

test('H-BOOT-001: first-boot bind failure still dead-ends (byte-identical exit path)', () => {
  // The everBound===false branch must keep the original printLockScreen + 250ms exit — a first
  // boot has no live sessions to preserve, so the dead-end is correct there.
  const handler = /function handleListenError\([\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
  assert.match(handler, /setTimeout\(\(\) => process\.exit\(1\), 250\)/,
    'first-boot bind failure still schedules exit(1) in 250ms');
  assert.match(handler, /printLockScreen\(`Port \$\{activePort\} is already in use\.`/,
    'first-boot EADDRINUSE still prints the port lockscreen');
});

test('H-BOOT-001: startFullApp is called with firstBoot=!everBound (false on a re-license re-bind)', () => {
  assert.match(SRC, /let everBound = false;/, 'everBound tracks whether the port was ever bound');
  assert.match(SRC, /everBound = true;/, 'everBound flips true after the first successful bind');
  assert.match(SRC, /startFullApp\(\{ firstBoot: !everBound \}\)/,
    'gateAndRun passes firstBoot=!everBound so a re-bind is classified as recoverable');
});

test('H-BOOT-001: onLicenseLost recovers from a BindFailedError instead of dying', () => {
  const body = /async function onLicenseLost\([\s\S]*?\n\}\n/.exec(SRC)?.[0] ?? '';
  assert.match(body, /err instanceof BindFailedError/,
    'onLicenseLost classifies the failure (bind-vs-other) — a non-bind error still propagates');
  assert.match(body, /setTimeout\(r, RELICENSE_REBIND_RETRY_MS\)/,
    'a short delay precedes the single re-bind retry so the OS/AV can release the port');
});

test('H-BOOT-001: the retry tears down the partial construction and is bounded (no blind loop)', () => {
  const body = /async function onLicenseLost\([\s\S]*?\n\}\n/.exec(SRC)?.[0] ?? '';
  // No-band-aid guard: the recovery re-quiesces the failed attempt's workers before retrying, and
  // retries the bind EXACTLY once (two gateAndRun calls total inside onLicenseLost) — a genuine
  // conflict then dead-ends with a truthful lockscreen, never an unbounded retry loop.
  const gateCalls = body.match(/await gateAndRun\(\);/g) ?? [];
  assert.equal(gateCalls.length, 2, 'exactly one re-bind retry (two gateAndRun calls), not a loop');
  const teardowns = body.match(/await teardownFullApp\(\);/g) ?? [];
  assert.equal(teardowns.length, 2, 'the failed partial construction is torn down before the retry');
  assert.match(body, /printLockScreen\('The UI port is still in use\.'/,
    'a still-held port after the retry dead-ends with a truthful cause');
});
