import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-018 — a two-sided accept COMMITS on Steam (offer.accept resolves), then
//  the bounded confirmOffer retry can still fail. acceptOffer used to RETHROW that
//  confirm failure past the already-committed accept, so offerAction / every
//  batchOfferAction row reported the landed accept as a plain FAILURE (the single
//  route even 502'd). The send path explicitly refuses to do this ("never rethrow
//  a confirmation failure — report it as 'unconfirmed'"); the accept path now
//  mirrors that: acceptOffer resolves 'unconfirmed' (never rejects) and the row
//  carries { ok:true, status:'unconfirmed' }.
//
//  acceptOffer reads only `offer.accept`, `offer.itemsToGive`, `offer.id`,
//  `this.username` and `this.confirmOffer`; batchOfferAction reads this.sessions
//  (isLive/logoutAccount) and this.getTrader → acceptTradeOffer. Object.create +
//  stubbed collaborators exercises the exact shipped logic.
// ─────────────────────────────────────────────────────────────────────────────

test('H-TRD-018: acceptOffer resolves "unconfirmed" (does NOT reject) when confirm fails on a two-sided offer', async () => {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  // The committed accept succeeds; the 2FA confirmation exhausts its bounded retry and throws.
  t.confirmOffer = async () => { throw new Error('HTTP 503 (mobile-conf storm)'); };

  let accepted = false;
  const offer = {
    id: '42',
    itemsToGive: [{ assetid: '1' }],      // two-sided → confirmation required
    accept: (cb: (err: Error | null) => void) => { accepted = true; cb(null); },
  };

  const status = await t.acceptOffer(offer);          // must NOT throw
  assert.equal(accepted, true, 'the accept was committed on Steam');
  assert.equal(status, 'unconfirmed', 'a post-commit confirm failure surfaces as unconfirmed, not a throw');
});

test('H-TRD-018: acceptOffer resolves "accepted" when the confirmation succeeds', async () => {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  let confirmed = false;
  t.confirmOffer = async () => { confirmed = true; };

  const offer = {
    id: '43',
    itemsToGive: [{ assetid: '1' }],
    accept: (cb: (err: Error | null) => void) => cb(null),
  };

  const status = await t.acceptOffer(offer);
  assert.equal(confirmed, true, 'the confirmation ran');
  assert.equal(status, 'accepted', 'a confirmed two-sided accept is "accepted"');
});

test('H-TRD-018: acceptOffer resolves "accepted" for a receive-only offer (no confirmation)', async () => {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  let confirmCalled = false;
  t.confirmOffer = async () => { confirmCalled = true; };

  const offer = {
    id: '44',
    itemsToGive: [],                       // receive-only → no mobile confirmation
    accept: (cb: (err: Error | null) => void) => cb(null),
  };

  const status = await t.acceptOffer(offer);
  assert.equal(confirmCalled, false, 'receive-only never needs a confirmation');
  assert.equal(status, 'accepted', 'the nothing-to-give path is "accepted"');
});

test('H-TRD-018: acceptOffer still REJECTS when the accept itself fails (not committed)', async () => {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  t.confirmOffer = async () => { throw new Error('should not reach here'); };

  const offer = {
    id: '45',
    itemsToGive: [{ assetid: '1' }],
    accept: (cb: (err: Error | null) => void) => cb(new Error('offer not active')),
  };

  await assert.rejects(t.acceptOffer(offer), /offer not active/,
    'a failure BEFORE the commit still throws (nothing landed on Steam)');
});

test('H-TRD-018: batchOfferAction reports an unconfirmed accept as { ok:true, status:"unconfirmed" }', async () => {
  const { TradeService } = require('../src/trading/TradeService');
  const s: any = Object.create(TradeService.prototype);
  s.offerActionsInFlight = 0;
  s.sessions = {
    isLive: () => false,
    logoutAccount: async () => undefined,
  };
  // Mirror the real getTrader side effect (login makes the account live); the trader's
  // acceptTradeOffer forwards acceptOffer's 'unconfirmed' status here.
  s.getTrader = async (_username: string) => ({
    acceptTradeOffer: async (_offerId: string) => 'unconfirmed',
    cancelOrDeclineOffer: async (_offerId: string) => undefined,
  });

  const results = await s.batchOfferAction([
    { username: 'bob', offerId: '42', action: 'accept' },
  ]);

  assert.equal(results.length, 1, 'one row per target');
  const row = results[0];
  assert.equal(row.ok, true, 'a committed-but-unconfirmed accept is NOT a failure');
  assert.equal(row.status, 'unconfirmed', 'the row carries the unconfirmed status');
  assert.equal(row.error, undefined, 'no error is attached to an unconfirmed row');
});

test('H-TRD-018: batchOfferAction reports a clean accept as ok:true with no status field', async () => {
  const { TradeService } = require('../src/trading/TradeService');
  const s: any = Object.create(TradeService.prototype);
  s.offerActionsInFlight = 0;
  s.sessions = { isLive: () => false, logoutAccount: async () => undefined };
  s.getTrader = async (_username: string) => ({
    acceptTradeOffer: async (_offerId: string) => 'accepted',
    cancelOrDeclineOffer: async (_offerId: string) => undefined,
  });

  const results = await s.batchOfferAction([
    { username: 'bob', offerId: '43', action: 'accept' },
  ]);

  assert.equal(results[0].ok, true, 'a clean accept is ok');
  assert.equal(results[0].status, undefined, 'a clean accept carries no unconfirmed status');
});
