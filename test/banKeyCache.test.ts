import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BanService } from '../src/trading/BanService';
import type { SessionManager } from '../src/core/SessionManager';
import type { TradeService } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-029 — the advertised process-lifetime API-key cache must actually cache.
//  The old code declared `apiKey` but never assigned it, so every check re-minted
//  the same keys via fresh logins. `acquireEnvKeys` now seeds from a per-env cache
//  (`envKeys`); a second acquire for an env whose need is already covered mints
//  NOTHING — no login, no getTrader. Eviction only happens on a Steam 401/403.
//
//  Driven through the private `acquireEnvKeys` on a bare instance with stub
//  SessionManager/TradeService (same pattern as banReleaseOwnership.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBan = any;

/** A trader whose community hands back an existing Web API key immediately. */
const traderWithKey = {
  community: { getWebApiKey: (cb: (err: Error | null, key?: string) => void) => cb(null, 'KEY') },
};

test('H-TRD-029: a second acquire for the same env re-uses the cached key and logs in nobody', async () => {
  const svc: AnyBan = Object.create(BanService.prototype);
  svc.envKeys = new Map<string, string[]>();
  const logouts: string[] = [];

  svc.sessions = {
    isReady: () => false,        // → the FIRST acquire must log in to mint
    isLive:  () => false,
    logoutAccount: async (u: string) => { logouts.push(u.toLowerCase()); },
  } as unknown as SessionManager;

  let getTraderCalls = 0;
  svc.trades = {
    getTrader: async (_u: string) => { getTraderCalls++; return traderWithKey; },
  } as unknown as TradeService;

  const first: string[] = await svc.acquireEnvKeys('env-a', ['bot'], 1);
  assert.deepEqual(first, ['KEY'], 'the first acquire mints the key');
  assert.equal(getTraderCalls, 1, 'the first acquire logs in once to mint');

  const second: string[] = await svc.acquireEnvKeys('env-a', ['bot'], 1);
  assert.deepEqual(second, ['KEY'], 'the second acquire returns the cached key');
  assert.equal(getTraderCalls, 1, 'the second acquire re-uses the cache — no further login');
});

test('H-TRD-029: fetchChunk invokes onKeyRejected on a Steam 401/403, and the evicted env then re-mints', async () => {
  const svc: AnyBan = Object.create(BanService.prototype);
  svc.envKeys = new Map<string, string[]>([['env-a', ['STALE']]]);

  svc.sessions = {
    isReady: () => false,
    isLive:  () => false,
    logoutAccount: async () => undefined,
  } as unknown as SessionManager;

  let getTraderCalls = 0;
  svc.trades = {
    getTrader: async (_u: string) => { getTraderCalls++; return traderWithKey; },
  } as unknown as TradeService;

  // Stub the network leg: fetchBansWithRetry throws the keyRejected error fetchBans raises on 401/403.
  svc.fetchBansWithRetry = async () => {
    throw Object.assign(new Error('Steam rejected the Web API key'), { transient: false, keyRejected: true });
  };

  // fetchChunk classifies the rejection and fires onKeyRejected — the same callback checkPerEnvironment wires.
  let evicted = false;
  await svc.fetchChunk('STALE', ['76561190000000000'], new Map(), () => {
    evicted = true;
    const arr = svc.envKeys.get('env-a');
    if (arr) svc.envKeys.set('env-a', arr.filter((k: string) => k !== 'STALE'));
  });
  assert.equal(evicted, true, 'a rejected key triggers eviction');
  assert.deepEqual(svc.envKeys.get('env-a'), [], 'the stale key is gone from the per-env cache');

  const keys: string[] = await svc.acquireEnvKeys('env-a', ['bot'], 1);
  assert.deepEqual(keys, ['KEY'], 'with the stale key evicted, the next acquire re-mints');
  assert.equal(getTraderCalls, 1, 'a login was needed because the cache no longer covers the need');
});
