import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { SessionManager, neutralizeSteamClient } from '../src/core/SessionManager';
import { InventoryService } from '../src/core/InventoryService';
import { SessionState } from '../src/types/session';
import { MAX_CONCURRENCY } from '../src/utils/concurrency';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ─── destroySession: a live 'error' listener at EVERY instant of teardown ──────
// steam-user can emit async errors after logOff; an unhandled 'error' event throws.
// The old code re-attached the no-op handler in the SAME try as removeAllListeners,
// so a vendor throw from the sweep left the client with ZERO error listeners.

function fakeSession(client: EventEmitter & { logOff: () => void }): Record<string, unknown> {
  return {
    account: { username: 'bot1' },
    client,
    httpsAgent: {},
    state: SessionState.LOGGED_IN,
    loginAttempts: 0,
  };
}

test('destroySession: a late async error after teardown never becomes an unhandled throw', async () => {
  const sm = new SessionManager();
  const client = new EventEmitter() as EventEmitter & { logOff: () => void };
  client.logOff = () => { /* noop */ };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set('bot1', fakeSession(client));

  await (sm as unknown as { destroySession: (k: string) => Promise<void> }).destroySession('bot1');

  assert.ok(client.listenerCount('error') >= 1, 'an error listener must survive teardown');
  // Would throw "Unhandled 'error' event" without a listener:
  client.emit('error', new Error('late CM error after teardown'));
});

test('destroySession: survives a vendor removeAllListeners throw with a live error listener', async () => {
  const sm = new SessionManager();
  const client = new EventEmitter() as EventEmitter & { logOff: () => void };
  client.logOff = () => { /* noop */ };
  let swept = false;
  // Simulate a vendor teardown throw mid-sweep (the failure mode that used to skip
  // the no-op re-attach because both lived in one try block).
  (client as unknown as { removeAllListeners: () => never }).removeAllListeners = () => {
    swept = true;
    throw new Error('vendor teardown throw');
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set('bot1', fakeSession(client));

  await (sm as unknown as { destroySession: (k: string) => Promise<void> }).destroySession('bot1');

  assert.ok(swept, 'the throwing sweep ran');
  assert.ok(client.listenerCount('error') >= 1, 'error listener must exist even when the sweep throws');
  client.emit('error', new Error('late CM error after a failed sweep'));
});

// ─── Zombie resurrection: a destroyed steam-user client can never reconnect ────
// steam-user's logOff() leaves _logonMsgTimeout armed; left alone it fires
// _enqueueLogonAttempt() -> logOn(true) and resurrects a discarded client outside
// every login cap (the leading native-crash / login-storm mechanism).

test('neutralizeSteamClient: clears the armed logon-message timeout (no self-relog)', async () => {
  let resurrected = false;
  const client: Record<string, unknown> = {};
  // Mimic steam-user post-_sendLogOn: a live 5s timer that would relog.
  client._logonMsgTimeout = setTimeout(() => { resurrected = true; (client.logOn as () => void)(); }, 20);
  client.logOn = () => { resurrected = true; };

  neutralizeSteamClient(client);

  await sleep(60);
  assert.equal(resurrected, false, 'the resurrection timer must be cleared');
});

test('neutralizeSteamClient: logOn is inert after teardown even if a backoff promise resolves later', () => {
  let reconnected = false;
  const client: Record<string, unknown> = { logOn: () => { reconnected = true; } };
  neutralizeSteamClient(client);
  // Simulate _enqueueLogonAttempt's already-pending backoff firing post-teardown:
  (client.logOn as (r: boolean) => void)(true);
  assert.equal(reconnected, false, 'a torn-down client must never log on again');
});

test('neutralizeSteamClient: cancels reconnect timers, marks closed, never throws on odd input', () => {
  let cancelled = false;
  const client: Record<string, unknown> = { _cancelReconnectTimers: () => { cancelled = true; } };
  neutralizeSteamClient(client);
  assert.equal(cancelled, true, 'reconnect/backoff timers cancelled');
  assert.equal(client._connectionClosed, true, 'connection marked closed');
  // Must be a safe no-op on non-clients:
  neutralizeSteamClient(undefined);
  neutralizeSteamClient(null);
  neutralizeSteamClient(42);
});

test('destroySession neutralizes the client so its armed logon timer cannot relog', async () => {
  const sm = new SessionManager();
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let relogged = false;
  client.logOff = () => { /* noop */ };
  client.logOn = () => { relogged = true; };
  client._logonMsgTimeout = setTimeout(() => { relogged = true; (client.logOn as () => void)(); }, 20);
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set('bot1', fakeSession(client as never));

  await (sm as unknown as { destroySession: (k: string) => Promise<void> }).destroySession('bot1');
  await sleep(60);
  assert.equal(relogged, false, 'a destroyed session client must not resurrect via its logon timer');
});

// ─── refreshAfterTrade: bounded + throttle-routed + session-releasing ──────────
// The post-trade refresh is a fleet path; it must obey the SAME rails as the bulk
// refresh: worker-pool bound (≤ MAX_CONCURRENCY), refreshMaybeThrottled routing
// (LocalIpThrottle for no-proxy accounts), and release-only-sessions-it-created.

interface SvcInternals {
  refreshMaybeThrottled: (u: string, g: string) => Promise<unknown>;
  // S25: ownership is now a per-invocation AsyncLocalStorage store, not a shared per-account map.
  ownershipCtx: { getStore(): { createdByCall?: boolean } | undefined };
}

function makeSvc(released: string[]): InventoryService {
  const sessions = {
    isLive: (_u: string) => true,
    logoutAccount: async (u: string) => { released.push(u.toLowerCase()); },
  };
  return new InventoryService(sessions as never, {} as never);
}

test('refreshAfterTrade: fan-out is bounded by the fleet concurrency ceiling', async () => {
  const released: string[] = [];
  const svc = makeSvc(released);
  const internals = svc as unknown as SvcInternals;

  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  internals.refreshMaybeThrottled = async () => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight--;
    return {};
  };

  const targets = Array.from({ length: 100 }, (_, i) => `acct${i}`);
  await svc.refreshAfterTrade(targets);

  assert.equal(calls, 100, 'every target refreshed');
  assert.ok(peak <= MAX_CONCURRENCY, `fan-out must stay ≤ ${MAX_CONCURRENCY} (saw ${peak})`);
  assert.ok(peak > 1, 'still parallel (a pool, not fully serial)');
});

test('refreshAfterTrade: releases ONLY sessions this refresh created', async () => {
  const released: string[] = [];
  const svc = makeSvc(released);
  const internals = svc as unknown as SvcInternals;

  // Simulate ensureSession's ownership marker: odd accounts were created by this refresh, even accounts
  // reused a session another op owns. ensureSession writes into the worker's per-invocation store (S25),
  // and this mock runs inside that same ownershipCtx.run() context — so getStore() is the worker's store.
  internals.refreshMaybeThrottled = async (u: string) => {
    const created = Number(u.replace(/\D/g, '')) % 2 === 1;
    const store = internals.ownershipCtx.getStore();
    if (store) store.createdByCall = created;
    return {};
  };

  const targets = Array.from({ length: 10 }, (_, i) => `acct${i}`);
  await svc.refreshAfterTrade(targets);

  const expected = targets.filter((_, i) => i % 2 === 1).map(u => u.toLowerCase()).sort();
  assert.deepEqual(released.sort(), expected, 'created sessions released; reused sessions untouched');
});

test('refreshAfterTrade: dedups targets case-insensitively and skips blanks', async () => {
  const released: string[] = [];
  const svc = makeSvc(released);
  const internals = svc as unknown as SvcInternals;

  const seen: string[] = [];
  internals.refreshMaybeThrottled = async (u: string) => { seen.push(u); return {}; };

  await svc.refreshAfterTrade(['Alice', 'alice', undefined, 'bob', '', 'ALICE']);
  assert.deepEqual(seen.sort(), ['Alice', 'bob'], 'one refresh per unique account');
});
