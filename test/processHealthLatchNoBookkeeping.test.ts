import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessHealth } from '../src/core/ProcessHealth';

// ─── H-BOOT-010: once the breaker is latched, recordUncaught must do zero further
//     bookkeeping — the reason is final until reset(), and no post-latch call may
//     mutate it or grow the (write-only) recent-timestamps array. ──
test('ProcessHealth.recordUncaught does no bookkeeping once latched (reason frozen at trip)', () => {
  ProcessHealth.reset(); // fresh breaker — module state is a latched singleton
  ProcessHealth.recordUncaught('trip A');
  ProcessHealth.recordUncaught('trip B');
  ProcessHealth.recordUncaught('trip C'); // 3rd trips the breaker (BURST_THRESHOLD)

  assert.ok(ProcessHealth.moneyOpsBlocked(), 'breaker should be tripped after 3 uncaught errors');
  const frozen = ProcessHealth.blockReason();
  assert.ok(frozen.includes('trip C'), `reason should pin the tripping error; got: ${frozen}`);

  // A sustained post-latch error storm must not change the reason by even one byte.
  for (let i = 0; i < 1000; i++) ProcessHealth.recordUncaught(`storm ${i}`);

  assert.equal(ProcessHealth.blockReason(), frozen, 'reason must stay byte-identical after the latch');

  ProcessHealth.reset(); // leave the singleton clean for other tests
});
