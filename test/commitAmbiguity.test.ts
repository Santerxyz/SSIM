import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAmbiguousCommitFailure } from '../src/trading/commitAmbiguity';

// ─── S3: classify a money-commit failure as transport-ambiguous (may have landed) ───

test('S3: verifyBeforeRetry is ambiguous (the order may already exist on Steam)', () => {
  assert.equal(isAmbiguousCommitFailure(Object.assign(new Error('probe failed'), { verifyBeforeRetry: true })), true);
});

test('S3: transport errors (response leg lost) are ambiguous', () => {
  for (const m of ['read ECONNRESET', 'socket hang up', 'timeout of 15000ms exceeded', 'ESOCKETTIMEDOUT', 'request aborted', 'write EPIPE']) {
    assert.equal(isAmbiguousCommitFailure(new Error(m)), true, `"${m}" must be ambiguous`);
  }
  assert.equal(isAmbiguousCommitFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true, 'code ETIMEDOUT');
});

test('S3: a DEFINITE Steam rejection (eresult) is NOT ambiguous (the op did not land)', () => {
  assert.equal(isAmbiguousCommitFailure(Object.assign(new Error('insufficient funds'), { eresult: 15 })), false);
  // even a transport-looking message loses to an explicit eresult (Steam answered)
  assert.equal(isAmbiguousCommitFailure(Object.assign(new Error('econnreset-ish'), { eresult: 8 })), false);
});

test('S3: a plain rejection / non-error is NOT ambiguous', () => {
  assert.equal(isAmbiguousCommitFailure(new Error('Item is not tradable')), false);
  assert.equal(isAmbiguousCommitFailure(new Error('order total exceeds the safety ceiling')), false);
  assert.equal(isAmbiguousCommitFailure(null), false);
  assert.equal(isAmbiguousCommitFailure(undefined), false);
  assert.equal(isAmbiguousCommitFailure('a string'), false);
});
