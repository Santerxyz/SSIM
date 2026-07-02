import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { SessionManager } from '../src/core/SessionManager';
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

// ─── refreshAfterTrade: bounded + throttle-routed + session-releasing ──────────
// The post-trade refresh is a fleet path; it must obey the SAME rails as the bulk
// refresh: worker-pool bound (≤ MAX_CONCURRENCY), refreshMaybeThrottled routing
// (LocalIpThrottle for no-proxy accounts), and release-only-sessions-it-created.

interface SvcInternals {
  refreshMaybeThrottled: (u: string, g: string) => Promise<unknown>;
  createdSession: Map<string, boolean>;
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

  // Simulate ensureSession's ownership marker: odd accounts were created by this
  // refresh, even accounts reused a session another op owns.
  internals.refreshMaybeThrottled = async (u: string) => {
    const created = Number(u.replace(/\D/g, '')) % 2 === 1;
    internals.createdSession.set(u.toLowerCase(), created);
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
