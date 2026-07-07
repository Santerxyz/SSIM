import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-020 — the status UI used to show the single last-touched `currentBot`,
//  so with concurrency >1 it flapped between workers. `processBot` now tracks
//  every bot currently in flight in job.activeBots:
//    • two bots processing at once BOTH appear in activeBots simultaneously;
//    • after a bot's processBot resolves, activeBots no longer contains it.
// ─────────────────────────────────────────────────────────────────────────────

/** A trader stub good enough for pre-flight; nothing is ever listed (price is null). */
function fakeTrader() {
  return {
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [] as string[],
    getListedAssetIds: async () => new Set<string>(), // pre-flight probe: no existing listings
  };
}

test('H-TRD-020: activeBots lists both in-flight bots, then clears each on completion', async () => {
  const trades: any = {
    ensureWebSession: async () => fakeTrader(),
    snapshotLive: () => new Set<string>(),
    releaseCreatedSessions: async () => 0,
  };
  // No inventory → the sellable-guard defers to Steam; markListed is a no-op.
  const svc = new MarketService(trades);
  // net:null (authoritative, non-transport) → each item is skippedNoPrice; no listing machinery runs.
  const resolveNet = async () => ({ net: null as number | null, transport: false });

  const groupA = { username: 'botA', items: [{ assetId: 'a1', marketHashName: 'Case' }] };
  const groupB = { username: 'botB', items: [{ assetId: 'b1', marketHashName: 'Case' }] };

  // processBot marks the bot active synchronously (before its first await), so starting both
  // without awaiting between them puts BOTH in activeBots at once.
  const pA = (svc as any).processBot(groupA, resolveNet, 0);
  const pB = (svc as any).processBot(groupB, resolveNet, 0);
  assert.deepEqual([...(svc.status().activeBots ?? [])].sort(), ['botA', 'botB'],
    'both concurrent bots are listed as in-flight simultaneously');

  await Promise.all([pA, pB]);
  const after = svc.status().activeBots ?? [];
  assert.ok(!after.includes('botA'), 'botA removed from activeBots after its processBot resolves');
  assert.ok(!after.includes('botB'), 'botB removed from activeBots after its processBot resolves');
});

test('H-TRD-020: an early-exit bot (login failure) is still removed from activeBots', async () => {
  const trades: any = {
    ensureWebSession: async () => { throw new Error('login failed'); }, // forces the deferAll early return
    snapshotLive: () => new Set<string>(),
    releaseCreatedSessions: async () => 0,
  };
  const svc = new MarketService(trades);
  const resolveNet = async () => ({ net: null as number | null, transport: false });
  const group = { username: 'botC', items: [{ assetId: 'c1', marketHashName: 'Case' }] };

  await (svc as any).processBot(group, resolveNet, 0);
  assert.ok(!(svc.status().activeBots ?? []).includes('botC'),
    'the login-failure early return still removes the bot from activeBots');
});
