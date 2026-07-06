import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessHealth } from '../src/core/ProcessHealth';

// ─── H-BOOT-009: the quarantine reason (served over two unauthenticated status GETs)
//     must never carry live proxy credentials from a failed-request Error.message ──
test('ProcessHealth.recordUncaught redacts proxy creds before they enter blockReason()', () => {
  ProcessHealth.reset(); // fresh breaker — module state is a latched singleton
  const detail = 'proxy https://bob:hunter2@1.2.3.4:8080 failed';
  ProcessHealth.recordUncaught(detail);
  ProcessHealth.recordUncaught(detail);
  ProcessHealth.recordUncaught(detail); // 3rd trips the breaker (BURST_THRESHOLD)

  const shown = ProcessHealth.blockReason();
  assert.ok(ProcessHealth.moneyOpsBlocked(), 'breaker should be tripped after 3 uncaught errors');
  assert.ok(shown.includes('***:***@'), `reason must mask the userinfo; got: ${shown}`);
  assert.ok(!shown.includes('hunter2'), `reason must NOT leak the proxy password; got: ${shown}`);

  ProcessHealth.reset(); // leave the singleton clean for other tests
});
