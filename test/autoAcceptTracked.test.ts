import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeService } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-016 — handleNewOffer auto-accept must be tracked, not fire-and-forget:
//  (a) markUsed on entry (reaper contract — a 30-min-idle receiver can't be
//      reaped mid accept+2FA);
//  (b) a staleness guard — if the traders-map entry was replaced/detached (its
//      session being torn down by the bulk-read release), the accept must NOT
//      fire a write on a dying session;
//  (c) the accept must be counted in offerActionsInFlight so busy() (and the
//      S14 update-swap gate) see it during the accept+confirmation window.
//  handleNewOffer only reads this.autoAcceptInternal, this.sessions,
//  this.traders and this.offerActionsInFlight, so Object.create + stubbed
//  collaborators exercises the exact shipped logic.
// ─────────────────────────────────────────────────────────────────────────────

function svc(): any {
  const s: any = Object.create(TradeService.prototype);
  s.autoAcceptInternal = true;
  s.offerActionsInFlight = 0;
  s.inFlight = new Set();
  s.massJob = { running: false };
  s.traders = new Map<string, any>();
  s.markUsedCalls = [];
  s.sessions = {
    markUsed: (u: string) => { s.markUsedCalls.push(u); },
    getAllSessions: () => [{ steamId: '76561198000000009' }],
  };
  s.accounts = { getAll: () => [] };
  return s;
}

const managedOffer = () => ({
  id: '55',
  isOurOffer: false,
  partner: { getSteamID64: () => '76561198000000009' },
});

test('H-TRD-016: a replaced trader (staleness) skips the write and does not busy()', async () => {
  const s = svc();
  const receiver: any = {
    username: 'Bot',
    accepts: 0,
    acceptOffer: async () => { receiver.accepts++; },
  };
  // The traders map holds a DIFFERENT (freshly re-attached) trader for this account —
  // the offer was dispatched by the old, now-detached poller.
  s.traders.set('bot', { username: 'Bot' });

  await s.handleNewOffer(receiver, managedOffer());

  assert.equal(receiver.accepts, 0, 'a stale trader must not fire a real accept write');
  assert.deepEqual(s.markUsedCalls, ['Bot'], 'markUsed still runs on entry (reaper contract)');
  assert.equal(s.offerActionsInFlight, 0, 'no in-flight accounting for a skipped accept');
  assert.equal((TradeService.prototype.busy as any).call(s), false);
});

test('H-TRD-016: a current trader accepts, is markUsed once, and is busy() mid-accept', async () => {
  const s = svc();
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const receiver: any = {
    username: 'Bot',
    accepts: 0,
    acceptOffer: async () => { receiver.accepts++; await hang; },
  };
  s.traders.set('bot', receiver); // the CURRENT trader — the accept must proceed

  const p = s.handleNewOffer(receiver, managedOffer());
  // Yield so acceptOffer starts and the promise hangs inside the try.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(receiver.accepts, 1, 'the current trader fires exactly one accept');
  assert.deepEqual(s.markUsedCalls, ['Bot'], 'markUsed called exactly once on entry');
  assert.equal((TradeService.prototype.busy as any).call(s), true,
    'the in-flight accept must make busy() true (S14 swap gate + reaper)');

  release();
  await p;
  assert.equal(s.offerActionsInFlight, 0, 'the counter is released after the accept resolves');
  assert.equal((TradeService.prototype.busy as any).call(s), false);
});
