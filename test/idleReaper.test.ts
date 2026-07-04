import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/core/SessionManager';
import { SessionState } from '../src/types/session';

// ─── B40: idle-session reaper frees resident slots left by single-account ops ───
// A session untouched for the TTL is logged out; a recently-used one is kept; a
// session with an in-flight login or not-yet-LOGGED_IN is never reaped.

function put(sm: SessionManager, username: string, ageMinutes: number, state = SessionState.LOGGED_IN) {
  const client = { logOff() { /* noop */ }, on() { /* noop */ }, removeAllListeners() { /* noop */ } };
  const now = Date.now();
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(username.toLowerCase(), {
    account: { username }, client, httpsAgent: {}, state, loginAttempts: 1,
    lastActivityAt: new Date(now - ageMinutes * 60_000),
  });
}
const IDLE = () => (sm: SessionManager) => (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();

test('B40: an idle LOGGED_IN session is reaped; a recently-used one is kept', async () => {
  const sm = new SessionManager();
  try {
    const destroyed: string[] = [];
    sm.on('sessionDestroyed', (u: string) => destroyed.push(u.toLowerCase()));
    put(sm, 'idlebot', 45);   // 45 min idle → reap (TTL 30)
    put(sm, 'busybot', 2);    // 2 min ago → keep
    await (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();
    assert.deepEqual(destroyed, ['idlebot'], 'only the idle session is reaped');
    assert.ok(sm.getSession('busybot'), 'the recently-used session survives');
  } finally { sm.shutdown(); }
});

test('B40: markUsed rescues a session from the reaper', async () => {
  const sm = new SessionManager();
  try {
    put(sm, 'rescued', 45);
    sm.markUsed('rescued'); // fresh activity now
    await (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();
    assert.ok(sm.getSession('rescued'), 'a just-used session is not reaped');
  } finally { sm.shutdown(); }
});

test('B40: a not-yet-LOGGED_IN session is never reaped', async () => {
  const sm = new SessionManager();
  try {
    put(sm, 'connecting', 45, SessionState.LOGGING_IN);
    await (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();
    assert.ok(sm.getSession('connecting'), 'a mid-login session is left alone');
  } finally { sm.shutdown(); }
});

// ─── S11: settled-DEAD sessions (DISCONNECTED/ERROR) must be reaped too ─────────
// A post-login CM drop left the session resident forever (the reaper skipped non-LOGGED_IN); it held a
// slot against MAX_LIVE_SESSIONS, its proxy agent, and its TradeOfferManager poller. The reaper is now a
// backstop for such zombies (the disconnected/error handlers also deferred-destroy them at the event).

test('S11: an idle DISCONNECTED or ERROR session is reaped (was a permanent zombie)', async () => {
  const sm = new SessionManager();
  try {
    const destroyed: string[] = [];
    sm.on('sessionDestroyed', (u: string) => destroyed.push(u.toLowerCase()));
    put(sm, 'zombiedc', 45, SessionState.DISCONNECTED); // 45 min idle, settled-dead
    put(sm, 'zombieerr', 45, SessionState.ERROR);
    await (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();
    assert.ok(destroyed.includes('zombiedc'), 'a DISCONNECTED zombie is reaped, not kept forever');
    assert.ok(destroyed.includes('zombieerr'), 'an ERROR zombie is reaped');
    assert.equal(sm.getSession('zombiedc'), undefined);
  } finally { sm.shutdown(); }
});

test('S11: a RECENTLY-disconnected session is NOT reaped by the backstop (idle-TTL still applies)', async () => {
  const sm = new SessionManager();
  try {
    put(sm, 'freshdc', 2, SessionState.DISCONNECTED); // 2 min → within the TTL → the event-handler destroy owns it
    await (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();
    assert.ok(sm.getSession('freshdc'), 'the backstop respects the idle-TTL (not over-aggressive)');
  } finally { sm.shutdown(); }
});

test('S11: LOGGING_IN is still never reaped (the DISCONNECTED/ERROR addition did not widen to mid-login)', async () => {
  const sm = new SessionManager();
  try {
    put(sm, 'connecting3', 45, SessionState.LOGGING_IN);
    await (sm as unknown as { reapIdleSessions: (n?: number) => Promise<void> }).reapIdleSessions();
    assert.ok(sm.getSession('connecting3'), 'a mid-login session is left alone');
  } finally { sm.shutdown(); }
});

test('shutdown() stops the reaper timer (no leak on re-license)', () => {
  const sm = new SessionManager();
  assert.doesNotThrow(() => sm.shutdown());
});
