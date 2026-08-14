import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../src/types/session';
import { ProcessHealth } from '../src/core/ProcessHealth';
import { SessionManager } from '../src/core/SessionManager';

// Four of the six "construction-only" fixes, exercised through their real seams.
// (G5 and F3 are covered by recorded out-of-process manual smokes — see PHASE4_VERIFICATION.md.)

// A7 / INV-A7 — the unreachable RATE_LIMITED state is gone; every state is reachable.
test('A7: SessionState has no unreachable RATE_LIMITED member', () => {
  assert.ok(!(Object.values(SessionState) as string[]).includes('RATE_LIMITED'));
  assert.deepEqual(
    (Object.values(SessionState) as string[]).sort(),
    ['CONNECTING', 'DISCONNECTED', 'ERROR', 'LOGGED_IN', 'LOGGING_IN'].sort(),
  );
});

// G6 / INV-G6 — a full rebuild (re-license) clears a latched money-ops breaker.
test('G6: ProcessHealth.reset() clears a latched money-ops breaker', () => {
  ProcessHealth.recordUncaught('a'); ProcessHealth.recordUncaught('b'); ProcessHealth.recordUncaught('c');
  assert.equal(ProcessHealth.moneyOpsBlocked(), true, 'a burst of 3 uncaught errors trips the breaker');
  ProcessHealth.reset();
  assert.equal(ProcessHealth.moneyOpsBlocked(), false, 'reset() (app rebuild) clears it');
  assert.equal(ProcessHealth.blockReason(), '');
});

// G1 removed with the licence gate: /api/system/status used to report a live seat-revocation
// flag. There is no revocation any more, so the endpoint reports `licensed: true` as a static
// compatibility shim for the dashboard guard (src/api/server.ts) and there is nothing to assert.

// A4 / INV-A4 — logoutAccount awaits an in-flight login before tearing the session down.
test('A4: logoutAccount waits for an in-flight login before destroying the session', async () => {
  const sm: any = new SessionManager();
  let loginSettled = false;
  let destroyedAfterLogin = false;
  const inFlight = new Promise<void>((resolve) => setTimeout(() => { loginSettled = true; resolve(); }, 30));
  sm.loginsInFlight.set('bot1', inFlight);
  const origDestroy = sm.destroySession.bind(sm);
  sm.destroySession = async (k: string) => { destroyedAfterLogin = loginSettled; return origDestroy(k); };

  await sm.logoutAccount('bot1');

  assert.equal(loginSettled, true, 'the in-flight login settled');
  assert.equal(destroyedAfterLogin, true, 'destroySession ran AFTER the in-flight login settled (no destroy-during-handshake)');
});
