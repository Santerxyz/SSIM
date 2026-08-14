import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';

// ─────────────────────────────────────────────────────────────────────────────
//  Active Orders across MANY accounts (folder / multi-select scope).
//
//  The multi-account scan is the read behind the folder + multi-select "Active Orders"
//  tab. Its contract:
//    • one dead bot is a ROW with `error`, never an aborted scan (the other bots' orders
//      must still reach the operator);
//    • rows are filtered to the requested game, so a CS2 scan never shows TF2 orders;
//    • it is single-flight (a second start is refused, not silently queued);
//    • every session the scan creates is released again, per account — a 500-bot folder
//      scan must not leave the whole fleet resident;
//    • the bulk cancel spans accounts, routes each order through ITS OWN account, and
//      reports per-item results instead of throwing on the first failure.
// ─────────────────────────────────────────────────────────────────────────────

const sell = (listingId: string, appId: number) => ({
  listingId, assetId: `a${listingId}`, appId, marketHashName: 'Case', name: 'Case',
  iconUrl: '', pricePerItemMinor: 100, currency: 3, quantity: 1,
});
const buy = (buyOrderId: string, appId: number) => ({
  buyOrderId, appId, marketHashName: 'Case', name: 'Case', iconUrl: '',
  pricePerItemMinor: 90, currency: 3, quantity: 2, quantityRemaining: 1,
});

/** A TradeService stub: per-account order sets (or a thrown error), plus the two session
 *  helpers the scan uses. `released` records every releaseCreatedSessions call. */
function fakeTrades(orders: Record<string, unknown>, released: string[], cancels: string[] = []) {
  return {
    getTrader: async (username: string) => {
      const entry = orders[username];
      if (entry instanceof Error) throw entry;
      return {
        getMarketOrders: async () => entry,
        cancelMarketListing: async (id: string) => {
          if (id === 'boom') throw new Error('Steam said no');
          cancels.push(`${username}:sell:${id}`);
        },
        cancelBuyOrder: async (id: string) => { cancels.push(`${username}:buy:${id}`); },
      };
    },
    snapshotLive: () => new Set<string>(),
    releaseCreatedSessions: async (usernames: string[]) => { released.push(...usernames); return usernames.length; },
  } as any;
}

/** Waits for the detached scan to finish (bounded, so a broken run fails the test loudly). */
async function settle(svc: MarketService): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!svc.ordersScanStatus().running) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('the orders scan never finished');
}

test('orders scan: a failing account is a row, not an aborted scan (the healthy bots still report)', async () => {
  const released: string[] = [];
  const svc = new MarketService(fakeTrades({
    good1: { sellOrders: [sell('L1', 730)], buyOrders: [buy('B1', 730)] },
    dead:  new Error('proxy is down'),
    good2: { sellOrders: [], buyOrders: [buy('B2', 730)], partial: true },
  }, released));

  svc.startOrdersScan(['good1', 'dead', 'good2'], 730);
  await settle(svc);

  const job = svc.ordersScanStatus();
  assert.equal(job.progress.total, 3);
  assert.equal(job.progress.done, 3, 'every account reaches a terminal state');
  assert.equal(job.progress.errors, 1);
  assert.equal(job.progress.sell, 1);
  assert.equal(job.progress.buy, 2, 'the healthy accounts\' buy orders survive the dead one');

  const dead = job.accounts.find((a) => a.username === 'dead');
  assert.match(dead?.error ?? '', /proxy is down/, 'the failure is named on its own row');
  assert.deepEqual(dead?.sellOrders, [], 'a failed read reports NO orders — never fabricated ones');
  assert.equal(job.accounts.find((a) => a.username === 'good2')?.partial, true,
    'a truncated per-account snapshot stays labelled partial');
  assert.deepEqual([...released].sort(), ['dead', 'good1', 'good2'],
    'every account the scan touched is released again — including the one that failed');
});

test('orders scan: rows are filtered to the requested game (a CS2 scan never shows TF2 orders)', async () => {
  const svc = new MarketService(fakeTrades({
    bot: { sellOrders: [sell('cs', 730), sell('tf', 440)], buyOrders: [buy('tfbuy', 440)] },
  }, []));

  svc.startOrdersScan(['bot'], 730);
  await settle(svc);

  const acc = svc.ordersScanStatus().accounts[0];
  assert.deepEqual(acc.sellOrders.map((o) => o.listingId), ['cs']);
  assert.deepEqual(acc.buyOrders, [], 'the TF2 buy order is not in a CS2 scan');
});

test('orders scan: single-flight — a second start is refused while one runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const svc = new MarketService({
    getTrader: async () => ({ getMarketOrders: async () => { await gate; return { sellOrders: [], buyOrders: [] }; } }),
    snapshotLive: () => new Set<string>(),
    releaseCreatedSessions: async () => 0,
  } as any);

  svc.startOrdersScan(['bot'], 730);
  assert.throws(() => svc.startOrdersScan(['other'], 730), /already running/,
    'a second scan must be refused, not piled on top of the first');
  release();
  await settle(svc);
  // The finished job stays readable, so a poll landing after completion still gets its rows.
  assert.equal(svc.ordersScanStatus().running, false);
  assert.equal(svc.ordersScanStatus().progress.done, 1);
});

test('orders scan: a cancelled scan keeps what it already read and stops taking new accounts', async () => {
  const svc = new MarketService(fakeTrades({
    a: { sellOrders: [sell('L1', 730)], buyOrders: [] },
    b: { sellOrders: [sell('L2', 730)], buyOrders: [] },
  }, []));

  svc.startOrdersScan(['a', 'b'], 730);
  svc.cancelOrdersScan();
  await settle(svc);

  const job = svc.ordersScanStatus();
  assert.ok(job.cancelled || job.progress.done === 2, 'the run either finished or stopped early — never wedged');
  assert.equal(job.running, false);
  assert.equal(job.accounts.length, job.progress.done, 'every finished account still has its row');
});

test('bulk cancel: spans accounts, routes each order through its OWN account, reports per-item results', async () => {
  const released: string[] = [];
  const cancels: string[] = [];
  const svc = new MarketService(fakeTrades({ botA: {}, botB: {} }, released, cancels));

  const results = await svc.cancelOrdersBatch([
    { username: 'botA', kind: 'sell', id: 'L1' },
    { username: 'botA', kind: 'sell', id: 'boom' },   // this one fails on Steam
    { username: 'botB', kind: 'buy',  id: 'B9' },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.ok).length, 2, 'one failure does not strand the other cancels');
  const failed = results.find((r) => !r.ok);
  assert.equal(failed?.id, 'boom');
  assert.match(failed?.error ?? '', /Steam said no/);
  assert.deepEqual(cancels.sort(), ['botA:sell:L1', 'botB:buy:B9'],
    'each order is cancelled through the account that owns it');
  assert.deepEqual([...new Set(released)].sort(), ['botA', 'botB'],
    'sessions the bulk cancel created are released again');
});
