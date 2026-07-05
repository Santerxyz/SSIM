import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TradeService } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-010 — the Steam WRITE paths (offer send + accept/decline/cancel) must go
//  through the ensureWebSession PRE-FLIGHT (stale-sessionid detection + in-place
//  cookie refresh), NOT getTrader's trust-the-cached-ready path. A resident account
//  whose proactive cookie refresh stalled has trader.ready=true yet dead cookies;
//  getTrader would fire the write on them, ensureWebSession heals it first. Reads
//  (getOffersForAccounts / getTradeUrl) keep getTrader.
// ─────────────────────────────────────────────────────────────────────────────

/** A trader whose ready-ness is TRUE (cached) but whose cookies are stale — the C16 class. */
function fakeTrader(): any {
  return {
    ready: true,
    sendTrade: async () => ({ offerId: '1', state: 'sent' }),
    acceptTradeOffer: async () => 'done',
    cancelOrDeclineOffer: async () => undefined,
  };
}

test('H-TRD-010: sendTrade routes the money WRITE through ensureWebSession, never the cached getTrader', async () => {
  const svc: any = Object.create(TradeService.prototype);
  const trader = fakeTrader();
  let ensureCalledWith: string | undefined;
  let getTraderCalled = false;

  svc.inFlight = new Set<string>();
  svc.journal = { consultRefusal: () => null, begin: () => undefined, record: () => undefined, resolve: () => undefined };
  svc.filterSendable = (_u: string, p: any) => p; // pass-through: no cached inventory in this unit
  svc.ensureWebSession = async (u: string) => { ensureCalledWith = u; return trader; };
  svc.getTrader = async () => { getTraderCalled = true; return trader; };

  const result = await svc.sendTrade('BotA', { myItems: [], tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=x' });

  assert.equal(ensureCalledWith, 'BotA', 'sendTrade must pre-flight the sender via ensureWebSession');
  assert.equal(getTraderCalled, false, 'sendTrade must NOT use the trust-the-cached-ready getTrader on the money path');
  assert.deepEqual(result, { offerId: '1', state: 'sent' });
});

test('H-TRD-010: offerAction routes accept/decline/cancel WRITES through ensureWebSession, never getTrader', async () => {
  const svc: any = Object.create(TradeService.prototype);
  const trader = fakeTrader();
  const ensureCalls: string[] = [];
  let getTraderCalled = false;

  svc.offerActionsInFlight = 0;
  svc.ensureWebSession = async (u: string) => { ensureCalls.push(u); return trader; };
  svc.getTrader = async () => { getTraderCalled = true; return trader; };

  assert.equal(await svc.offerAction('BotB', 'off-1', 'accept'), 'done');
  assert.equal(await svc.offerAction('BotB', 'off-2', 'decline'), 'done');

  assert.deepEqual(ensureCalls, ['BotB', 'BotB'], 'each offer action must pre-flight its account via ensureWebSession');
  assert.equal(getTraderCalled, false, 'offerAction must NOT use the cached getTrader on the write path');
});

test('H-TRD-010: the READ paths (getOffersForAccounts / getTradeUrl) keep getTrader; only the WRITEs pre-flight', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'trading', 'TradeService.ts'), 'utf8');
  // The two money WRITES pre-flight.
  assert.ok(/const trader = await this\.ensureWebSession\(username\);/.test(src), 'offerAction uses ensureWebSession');
  assert.ok(/const trader = await this\.ensureWebSession\(fromUsername\);/.test(src), 'sendTrade uses ensureWebSession');
  // The reads still trust the cached trader (a read never moves an asset).
  assert.ok(/const trader = await this\.getTrader\(username\);\n\s+const offers = await trader\.getTradeOffers/.test(src), 'getOffersForAccounts keeps getTrader');
  assert.ok(/const trader = await this\.getTrader\(username\);\n\s+return trader\.getTradeUrl\(\);/.test(src), 'getTradeUrl keeps getTrader');
});
