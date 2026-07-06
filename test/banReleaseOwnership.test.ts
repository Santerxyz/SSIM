import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BanService } from '../src/trading/BanService';
import type { SessionManager } from '../src/core/SessionManager';
import type { TradeService } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-034 — a key-mint's session release must be CHAINED to our own mint
//  promise, not a blind +20s wall-clock timer. The old `releaseSoon` fired an
//  unconditional drop 20s after the mint started; that drop (a) missed a login
//  that landed past the 20s horizon (a resident-session leak) and (b) could tear
//  down a session another flow had just created inside the 20s window. The new
//  `releaseWhenSettled` drops the session exactly when OUR mint settles — never
//  earlier, never at an arbitrary later instant, and never twice.
//
//  Driven through the private `acquireEnvKeys` on a bare instance with stub
//  SessionManager/TradeService (same pattern as the GC keep-alive tests).
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBan = any;

/** A trader whose community hands back an existing Web API key immediately. */
const traderWithKey = {
  community: { getWebApiKey: (cb: (err: Error | null, key?: string) => void) => cb(null, 'KEY') },
};

test('H-TRD-034: a mint that lands PAST the 20s budget still releases — once, at settle time', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const svc: AnyBan = Object.create(BanService.prototype);
    svc.envKeys = new Map<string, string[]>();
    const logouts: string[] = [];
    let live = false; // becomes live once the (late) login lands

    svc.sessions = {
      isReady: () => false,        // → we will "log in" to mint
      isLive:  () => live,         // not live before; live after the late login lands
      logoutAccount: async (u: string) => { logouts.push(u.toLowerCase()); live = false; },
    } as unknown as SessionManager;

    // getTrader resolves 30s in — PAST the 20s KEY_MINT_TIMEOUT_MS budget. When it lands the
    // account is live (a real login would have set LOGGED_IN), so the chained drop can act.
    svc.trades = {
      getTrader: (_u: string) => new Promise((resolve) => {
        setTimeout(() => { live = true; resolve(traderWithKey); }, 30_000);
      }),
    } as unknown as TradeService;

    const acquire: Promise<string[]> = svc.acquireEnvKeys('env-a', ['bot'], 1);

    // At 20s the withTimeout budget fires → acquireEnvKeys resolves with NO key, and the release is
    // chained to the still-pending mint (no blind timer).
    mock.timers.tick(20_000);
    await Promise.resolve(); await Promise.resolve();
    const keys = await acquire;
    assert.deepEqual(keys, [], 'the timed-out mint provides no key');
    assert.deepEqual(logouts, [], 'nothing released yet — our mint has not settled');

    // At 30s the login finally lands (mint settles) → the chained drop fires exactly once.
    mock.timers.tick(10_000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(logouts, ['bot'], 'the session is released the moment OUR mint settles');
  } finally {
    mock.timers.reset();
  }
});

test('H-TRD-034: after our release, a NEW foreign live session is NOT killed by a stale timer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const svc: AnyBan = Object.create(BanService.prototype);
    svc.envKeys = new Map<string, string[]>();
    const logouts: string[] = [];
    let live = false;

    svc.sessions = {
      isReady: () => false,
      isLive:  () => live,
      logoutAccount: async (u: string) => { logouts.push(u.toLowerCase()); live = false; },
    } as unknown as SessionManager;
    svc.trades = {
      getTrader: (_u: string) => new Promise((resolve) => {
        setTimeout(() => { live = true; resolve(traderWithKey); }, 5_000);
      }),
    } as unknown as TradeService;

    const acquire: Promise<string[]> = svc.acquireEnvKeys('env-a', ['bot'], 1);
    // Let the whole mint settle (login at 5s, well within the 20s budget) and its release run.
    mock.timers.tick(5_000);
    await Promise.resolve(); await Promise.resolve();
    await acquire;
    assert.deepEqual(logouts, ['bot'], 'our own session released once');

    // Simulate ANOTHER flow logging the same account in right after (foreign session, live again).
    logouts.length = 0;
    live = true;

    // The OLD design left a +20s timer that would fire here and kill this foreign session. The new
    // design has no such timer — advancing the clock 60s must not touch it.
    mock.timers.tick(60_000);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(logouts, [], 'no stale timer — a session another flow created survives');
  } finally {
    mock.timers.reset();
  }
});

test('H-TRD-034: happy path (mint lands in-budget) releases the session exactly once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const svc: AnyBan = Object.create(BanService.prototype);
    svc.envKeys = new Map<string, string[]>();
    const logouts: string[] = [];
    let live = false;

    svc.sessions = {
      isReady: () => false,
      isLive:  () => live,
      logoutAccount: async (u: string) => { logouts.push(u.toLowerCase()); live = false; },
    } as unknown as SessionManager;
    svc.trades = {
      getTrader: (_u: string) => new Promise((resolve) => {
        setTimeout(() => { live = true; resolve(traderWithKey); }, 1_000);
      }),
    } as unknown as TradeService;

    const acquire: Promise<string[]> = svc.acquireEnvKeys('env-a', ['bot'], 1);
    mock.timers.tick(1_000);
    await Promise.resolve(); await Promise.resolve();
    const keys = await acquire;
    assert.deepEqual(keys, ['KEY'], 'in-budget mint yields the key');

    // Let the chained release run and advance well past the old 20s horizon.
    await Promise.resolve(); await Promise.resolve();
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.deepEqual(logouts, ['bot'], 'released exactly once — no second blind drop');
  } finally {
    mock.timers.reset();
  }
});
