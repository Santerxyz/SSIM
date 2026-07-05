import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-011 — batchOfferAction was the one fleet-wide login fan-out that never
//  released the sessions it created: a "decline/cancel all" across a big
//  environment logged in one session per account and left them ALL resident
//  until the reaper (above the ceiling it starts REFUSING its own logins).
//  It now mirrors the offers-read fan-out: group by account, snapshot live-ness
//  BEFORE the first action, and release in a `finally` iff WE created the session
//  (same guard as getOffersForAccounts at 323-325). batchOfferAction only reads
//  this.sessions (isLive/logoutAccount), this.offerAction → this.getTrader, so
//  Object.create + stubbed collaborators exercises the exact shipped logic.
// ─────────────────────────────────────────────────────────────────────────────

interface Env {
  live: Set<string>;                 // accounts currently "live"
  loggedOut: string[];               // usernames passed to logoutAccount, in order
  actioned: Array<{ username: string; offerId: string; action: string }>;
}

function svc(TradeService: any, env: Env): any {
  const s: any = Object.create(TradeService.prototype);
  s.sessions = {
    isLive: (u: string) => env.live.has(u.toLowerCase()),
    logoutAccount: async (u: string) => { env.loggedOut.push(u); env.live.delete(u.toLowerCase()); },
  };
  // getTrader stub: a real getTrader LOGS THE ACCOUNT IN (making it live) before returning; the
  // trader then performs the Steam write. Here we mirror that side effect (mark live) and record
  // the call, so the shipped offerAction routing (accept vs cancel/decline) and the post-action
  // release guard (isLive AFTER the actions) run against realistic state.
  s.getTrader = async (username: string) => {
    env.live.add(username.toLowerCase());
    return {
      acceptTradeOffer: async (offerId: string) => { env.actioned.push({ username, offerId, action: 'accept' }); },
      cancelOrDeclineOffer: async (offerId: string) => { env.actioned.push({ username, offerId, action: 'cancel/decline' }); },
    };
  };
  return s;
}

test('H-TRD-011: releases ONLY the sessions the batch created (pre-live account untouched)', async () => {
  const { TradeService } = require('../src/trading/TradeService');
  const env: Env = { live: new Set(['alice']), loggedOut: [], actioned: [] }; // alice pre-live
  const s = svc(TradeService, env);

  const results = await s.batchOfferAction([
    { username: 'alice', offerId: '1', action: 'decline' },  // pre-live → kept
    { username: 'bob',   offerId: '2', action: 'cancel'  },  // batch created → released
    { username: 'carol', offerId: '3', action: 'accept'  },  // batch created → released
  ]);

  assert.equal(results.length, 3, 'one result row per input target');
  assert.ok(results.every((r: any) => r.ok), 'every action succeeded');
  assert.equal(env.actioned.length, 3, 'all three actions were dispatched');

  const releasedSet = new Set(env.loggedOut.map((u) => u.toLowerCase()));
  assert.deepEqual([...releasedSet].sort(), ['bob', 'carol'],
    'exactly the two accounts the batch logged in were released; the pre-live one was not');
  assert.ok(!releasedSet.has('alice'), 'the pre-live session is never torn down');
});

test('H-TRD-011: same-account actions serialize and the session is released exactly once', async () => {
  const { TradeService } = require('../src/trading/TradeService');
  const env: Env = { live: new Set(), loggedOut: [], actioned: [] };
  const s = svc(TradeService, env);

  const results = await s.batchOfferAction([
    { username: 'bob', offerId: '1', action: 'cancel' },
    { username: 'bob', offerId: '2', action: 'cancel' },
    { username: 'bob', offerId: '3', action: 'cancel' },
  ]);

  assert.equal(results.length, 3, 'one row per target even when grouped');
  assert.equal(env.actioned.length, 3, 'all of the account\'s actions ran');
  assert.deepEqual(env.loggedOut.map((u) => u.toLowerCase()), ['bob'],
    'the single created session is released exactly once, after all its actions');
});

test('H-TRD-011: SSIM_RELEASE_READ_SESSIONS=0 disables the release entirely', async () => {
  const prev = process.env.SSIM_RELEASE_READ_SESSIONS;
  process.env.SSIM_RELEASE_READ_SESSIONS = '0';
  // The kill switch is captured at module load, so re-require a fresh module instance under the flag.
  delete require.cache[require.resolve('../src/trading/TradeService')];
  try {
    const { TradeService } = require('../src/trading/TradeService');
    const env: Env = { live: new Set(), loggedOut: [], actioned: [] };
    const s = svc(TradeService, env);

    await s.batchOfferAction([
      { username: 'bob',   offerId: '2', action: 'cancel' },
      { username: 'carol', offerId: '3', action: 'accept' },
    ]);

    assert.equal(env.actioned.length, 2, 'actions still run with the kill switch on');
    assert.equal(env.loggedOut.length, 0, 'no session is released when SSIM_RELEASE_READ_SESSIONS=0');
  } finally {
    // Restore the env + module cache so later tests see the default (release enabled).
    if (prev === undefined) delete process.env.SSIM_RELEASE_READ_SESSIONS;
    else process.env.SSIM_RELEASE_READ_SESSIONS = prev;
    delete require.cache[require.resolve('../src/trading/TradeService')];
  }
});
