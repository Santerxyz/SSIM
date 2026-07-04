import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/core/SessionManager';

// ════════════════════════════════════════════════════════════════════════════
//  S48 — re-license teardown (logoutAll) didn't await in-flight logins, so a late
//  success could insert a fresh session into a manager already torn down, parking
//  an unmanaged live CM session + agent. logoutAll now latches a `shuttingDown`
//  flag (checked by loginAccount/attemptLogin/performLogin) and drains in-flight
//  logins before destroying; loginAll clears the latch for a new cycle.
// ════════════════════════════════════════════════════════════════════════════

type Internals = { shuttingDown: boolean; loginsInFlight: Map<string, Promise<unknown>> };

test('S48: after logoutAll(), loginAccount refuses a new login (no session built in a torn-down manager)', async () => {
  const sm = new SessionManager();
  await sm.logoutAll(); // latches shuttingDown; no sessions/in-flight to drain
  await assert.rejects(() => sm.loginAccount({ username: 'bot' } as never), /shutting down/);
});

test('S48: loginAll() clears the shutdown latch so a deliberate new cycle is admitted', async () => {
  const sm = new SessionManager();
  await sm.logoutAll();
  assert.equal((sm as unknown as Internals).shuttingDown, true, 'teardown latched shutdown');
  await sm.loginAll([]); // an empty cycle just resets the latch
  assert.equal((sm as unknown as Internals).shuttingDown, false, 'a new login cycle cleared the latch');
});

test('S48: logoutAll() awaits an in-flight login before destroying (no post-teardown insert)', async () => {
  const sm = new SessionManager();
  let settled = false;
  const pending = new Promise<void>((r) => { setTimeout(() => { settled = true; r(); }, 30); });
  (sm as unknown as Internals).loginsInFlight.set('bot', pending);
  await sm.logoutAll();
  assert.equal(settled, true, 'logoutAll waited for the in-flight login to settle before tearing down');
});
