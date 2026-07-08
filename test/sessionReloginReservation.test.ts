// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-005 — the insertion-point ceiling re-check broke the documented re-login
//  exemption ("replaces, never grows"). doLoginAccount destroys a resident session
//  BEFORE the login attempt, so by the insertion re-check the re-logging account is
//  no longer in the map and could be starved by newcomers that took its freed slot
//  during the backoff window. A re-login now RESERVES its slot before the destroy:
//  occupiedCount() counts the reservation (newcomers can't overshoot) and the
//  insertion re-check exempts the reserved key (the re-login re-occupies its own slot).
//
//  Pin the ceiling to its enforced minimum BEFORE the module loads — MAX_LIVE_SESSIONS
//  is captured once at module load; commonjs `import` compiles to an in-order `require`,
//  so this env assignment runs first, and each test file runs in its own subprocess.
// ════════════════════════════════════════════════════════════════════════════
process.env.SSIM_MAX_LIVE_SESSIONS = '25';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/core/SessionManager';
import { SessionState } from '../src/types/session';

const CEILING = 25; // === SSIM_MAX_LIVE_SESSIONS set above (the enforced minimum)

function mockSession(username: string) {
  const client = { logOff() { /* noop */ }, on() { /* noop */ }, removeAllListeners() { /* noop */ } };
  return { account: { username }, client, httpsAgent: {}, state: SessionState.LOGGED_IN, lastActivityAt: new Date() };
}

test('H-ACC-005: a resident re-login re-occupies its own slot; a concurrent newcomer is refused (budget stays exact)', async () => {
  const sm = new SessionManager();
  try {
    const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions;
    // Saturate the manager to the ceiling, with residentbot among the residents.
    for (let i = 0; i < CEILING - 1; i++) sessions.set(`filler${i}`, mockSession(`filler${i}`));
    sessions.set('residentbot', mockSession('residentbot'));
    assert.equal(sessions.size, CEILING, 'manager starts saturated at the ceiling');

    // Force the token path so the mocked performLogin is reached without a maFile on disk.
    (sm as unknown as { tokenStore: unknown }).tokenStore = { get: () => 'tok', set: () => { /* noop */ }, delete: () => { /* noop */ } };

    // Gate performLogin so we can act WHILE the re-login is mid-handshake: its old session already
    // destroyed (slot freed), a fresh one not yet inserted. The mock stands in for the real insertion.
    let midHandshake!: () => void;
    const reached = new Promise<void>((r) => { midHandshake = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (sm as unknown as { performLogin: (a: { username: string }) => Promise<unknown> }).performLogin = async (account) => {
      midHandshake();
      await gate;
      const s = mockSession(account.username);
      sessions.set(account.username.toLowerCase(), s);
      return s;
    };

    // Start the re-login: doLoginAccount reserves residentbot's slot, then destroys the old session.
    const relogin = sm.loginAccount({ username: 'residentbot' } as never);
    await reached;
    assert.equal(sessions.has('residentbot'), false, 'the re-logging account is transiently absent from the map');
    assert.equal(
      (sm as unknown as { reloginReservations: Set<string> }).reloginReservations.has('residentbot'), true,
      'its slot is reserved while mid-handshake',
    );

    // A newcomer must NOT be able to steal the freed slot — the reservation keeps the budget full.
    await assert.rejects(
      () => sm.loginAccount({ username: 'newbot' } as never),
      (e: Error & { ceilingRefusal?: boolean }) => e.ceilingRefusal === true && /ceiling/.test(e.message),
      'a newcomer is refused while a resident re-login holds its reserved slot',
    );

    // Let the re-login finish: it re-occupies its OWN slot (growth 0), and the reservation clears.
    release();
    await relogin;
    assert.ok(sm.getSession('residentbot'), 're-login re-inserted its session');
    assert.equal(sessions.size, CEILING, 'budget is exact — never exceeded');
    assert.equal(
      (sm as unknown as { reloginReservations: Set<string> }).reloginReservations.size, 0,
      'the reservation is cleared in doLoginAccount\'s finally',
    );
  } finally {
    sm.shutdown();
  }
});
