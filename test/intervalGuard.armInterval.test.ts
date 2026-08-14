import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armInterval } from '../src/utils/intervalGuard';

// ════════════════════════════════════════════════════════════════════════════
//  H-XCT-004 — every long-lived periodic-timer owner must arm through the shared
//  armInterval() helper, which clears any prior handle before re-arming so a
//  second start() can never orphan the first interval (a timer that outlives its
//  owner). Two owners (LicenseClient heartbeat, ExchangeRateService fx) lacked the
//  clear-first guard; routing all five through armInterval makes the guard the
//  only pattern. This locks that behaviour + a source-scan regression guard.
// ════════════════════════════════════════════════════════════════════════════

test('H-XCT-004: armInterval clears the prior handle on re-arm and returns a new one', () => {
  const realClear = global.clearInterval;
  const cleared: NodeJS.Timeout[] = [];
  (global as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((h: NodeJS.Timeout) => {
    cleared.push(h);
    realClear(h);
  }) as typeof clearInterval;
  try {
    const a = armInterval(undefined, () => {}, 1000);
    assert.ok(a, 'first arm returns a handle');
    assert.deepEqual(cleared, [], 'first arm (prev undefined) clears nothing');

    const b = armInterval(a, () => {}, 1000);
    assert.notStrictEqual(b, a, 're-arm returns a NEW handle');
    assert.deepEqual(cleared, [a], 're-arm cleared exactly the prior handle A');

    realClear(b); // tidy up
  } finally {
    (global as unknown as { clearInterval: typeof clearInterval }).clearInterval = realClear;
  }
});

test('H-XCT-004: unref defaults on; opts.unref=false leaves the timer keeping the loop alive', () => {
  const a = armInterval(undefined, () => {}, 1000); // default → unref'd
  assert.equal(typeof a.hasRef, 'function');
  assert.equal(a.hasRef(), false, 'default arm is unref\'d');
  clearInterval(a);

  const b = armInterval(undefined, () => {}, 1000, { unref: false });
  assert.equal(b.hasRef(), true, 'opts.unref=false keeps the ref');
  clearInterval(b);
});

test('H-XCT-004: the refit timer owners route through armInterval (no raw setInterval)', () => {
  // Mirror of the S62 asyncHandler source-scan: a regression guard that fails if any
  // of these owners reintroduces a raw `setInterval(` instead of armInterval().
  const owners = [
    // (LicenseClient.ts was here — deleted with the licence gate.)
    ['pricing', 'ExchangeRateService.ts'],
    ['update', 'updateScheduler.ts'],
    ['utils', 'memHeartbeat.ts'],
    ['csfloat', 'CsFloatAutoAcceptWorker.ts'],
  ];
  const offenders: string[] = [];
  for (const parts of owners) {
    const src = readFileSync(join(__dirname, '..', 'src', ...parts), 'utf8').replace(/\r\n/g, '\n');
    if (/setInterval\s*\(/.test(src)) offenders.push(parts.join('/'));
  }
  assert.deepEqual(offenders, [], `these timer owners must arm via armInterval, not raw setInterval: ${offenders.join(', ')}`);

  // armInterval itself is the single home of the setInterval call.
  const helper = readFileSync(join(__dirname, '..', 'src', 'utils', 'intervalGuard.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(helper, /setInterval\s*\(/, 'intervalGuard.ts must contain the single setInterval call');
});
