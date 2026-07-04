import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/core/SessionManager';

// ════════════════════════════════════════════════════════════════════════════
//  S49 — a B46 resident-ceiling insertion refusal was classified 'connection', so
//  attemptLogin retried it MAX_CONNECTION_ATTEMPTS times with exponential backoff
//  (~60s), holding a login slot and rebuilding/tearing down a client each time — a
//  starvation amplifier exactly when the ceiling is saturated. Ceiling refusals
//  now carry `ceilingRefusal` and bubble up on the first attempt.
// ════════════════════════════════════════════════════════════════════════════

test('S49: attemptLogin does NOT retry a resident-ceiling refusal (one call, no backoff amplification)', async () => {
  const sm = new SessionManager();
  let calls = 0;
  (sm as unknown as { performLogin: () => Promise<never> }).performLogin = async () => {
    calls++;
    throw Object.assign(
      new Error('live-session ceiling reached at insertion – bot skipped'),
      { loginErrorKind: 'connection', ceilingRefusal: true },
    );
  };
  await assert.rejects(
    () => (sm as unknown as { attemptLogin: (a: unknown, o: unknown, m: unknown, p: string) => Promise<unknown> })
      .attemptLogin({ username: 'bot' }, {}, undefined, 'token'),
    /ceiling/,
  );
  assert.equal(calls, 1, 'a ceiling refusal bubbles up immediately (not retried MAX_CONNECTION_ATTEMPTS times)');
});
