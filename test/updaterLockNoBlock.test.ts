import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfTestFailureCountsTowardBlock } from '../src/update/Updater';

// ════════════════════════════════════════════════════════════════════════════
//  S54 — a transient 'lock' self-test failure (EACCES/EBUSY/MOTW — an AV mid-scan
//  or a Controlled-Folder handle) was folded into the C3 per-sha failure streak,
//  so three cold-AV boots permanently BLOCKED a perfectly good update for a
//  condition the classifier itself calls transient/retryable. 'lock' no longer
//  counts toward the block (runUpdate keeps current + retries fresh next boot).
// ════════════════════════════════════════════════════════════════════════════

test('S54: a transient lock self-test failure does NOT count toward the C3 block', () => {
  assert.equal(selfTestFailureCountsTowardBlock('lock'), false, 'a lock (AV/MOTW) is environmental, not a defect');
  assert.equal(selfTestFailureCountsTowardBlock('crash'), true, 'a real crash still counts');
  assert.equal(selfTestFailureCountsTowardBlock('no-marker'), true, 'a boot that never confirmed OK counts');
  assert.equal(selfTestFailureCountsTowardBlock('timeout'), true, 'a persistent timeout counts');
});
