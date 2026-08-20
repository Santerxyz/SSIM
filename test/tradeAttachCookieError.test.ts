import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeService } from '../src/trading/TradeService';
import { SessionState } from '../src/types/session';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-009 — attach() must NOT swallow a setCookies failure. When the cookie set
//  rejects (e.g. a proxy error), the trader stays !ready; getTrader/ensureWebSession
//  (which await attach) must reject with the TRUE cause instead of handing back a
//  non-ready trader that fails later with a misleading "trader not ready" / auth
//  error. The 'webSession' EVENT path keeps today's log-and-continue via its own
//  .catch and must never leak an unhandled rejection.
// ─────────────────────────────────────────────────────────────────────────────

const COOKIE_ERR = 'proxy ECONNRESET during cookie set';

/** A trader already attached to the session whose setCookies rejects (never ready). */
function rejectingTrader(): any {
  return {
    ready: false,
    isBoundTo: () => true,
    setCookies: async () => { throw new Error(COOKIE_ERR); },
    shutdown: () => undefined,
  };
}

/** A session that passes attach()/getTrader's readiness gate so attach reaches setCookies. */
function readySession(): any {
  return { state: SessionState.LOGGED_IN, webSession: { cookies: ['sessionid=abc'] } };
}

test('H-TRD-009: getTrader rejects with the cookie-set error instead of returning a non-ready trader', async () => {
  const svc: any = Object.create(TradeService.prototype);
  const trader = rejectingTrader();
  svc.traders = new Map<string, any>([['bota', trader]]);
  svc.sessions = {
    markUsed: () => undefined,
    isEgressStale: () => false,   // 1.5.1 reuse guard: this stub session logged in over the CURRENT egress
    getSession: () => readySession(),
    loginAccount: async () => readySession(),
  };
  svc.accounts = { get: () => ({ username: 'BotA' }) };

  await assert.rejects(() => svc.getTrader('BotA'), (e: Error) => {
    assert.equal(e.message, COOKIE_ERR, 'getTrader must surface the real cookie-set cause');
    return true;
  });
});

test('H-TRD-009: the webSession event path logs-and-continues without an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const trap = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', trap);
  try {
    const svc: any = Object.create(TradeService.prototype);
    const trader = rejectingTrader();
    svc.traders = new Map<string, any>([['bota', trader]]);
    svc.sessions = { getSession: () => readySession() };

    // Drive the exact statement the constructor's 'webSession' handler runs.
    void svc.attach('BotA').catch(() => { /* handler swallows-and-logs */ });

    // Also assert the raw attach() DOES reject (proving the swallow was removed).
    await assert.rejects(() => svc.attach('BotA'), (e: Error) => e.message === COOKIE_ERR);

    // Let any microtask-queued unhandled-rejection events fire.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], 'the event path must not leak an unhandled rejection');
  } finally {
    process.off('unhandledRejection', trap);
  }
});
