import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY, type SellInfo } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-023 — a transport-failure null (Steam never answered) must NOT be cached
//  as an authoritative "no price" for the whole run. The in-run S2 class: one 429
//  storm / proxy reset on the first item used to poison netCache and mass-fail
//  every later same-name item without a lookup.
//   (a) authoritative:false → NO cache write; every same-name item gets its own
//       getSellInfo, lands in `deferred`, and never touches `skippedNoPrice`.
//   (b) authoritative:true (a genuine "no listings") → cached; exactly one lookup
//       for N same-name items, all `skippedNoPrice`/`failed` (unchanged behavior).
// ─────────────────────────────────────────────────────────────────────────────

/** A trader stub good enough for the price-miss paths (nothing is ever listed). */
function fakeTrader() {
  return {
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [] as string[],
    getListedAssetIds: async () => new Set<string>(), // pre-flight probe: no existing listings
  };
}

/** Builds a MarketService whose pricing + session collaborators are stubbed, and
 *  counts how many times getSellInfo is called for a given name. */
function svcWith(info: SellInfo) {
  let getSellInfoCalls = 0;
  const trader = fakeTrader();
  const trades: any = {
    ensureWebSession: async () => trader,
    snapshotLive: () => new Set<string>(),
    releaseCreatedSessions: async () => 0,
  };
  const svc = new MarketService(trades /* inventory omitted → isAssetSellable defers to Steam */);
  (svc as any).pricing = {
    getSellInfo: async () => { getSellInfoCalls++; return info; },
  };
  return { svc, calls: () => getSellInfoCalls };
}

async function runToCompletion(
  svc: MarketService,
  items: Array<{ assetId: string; marketHashName: string }>,
  opts: { itemConcurrency?: number } = {},
) {
  // itemDelayMs is floored at 500 but never reached here (every price-miss returns before the
  // dispatch gate), so the run resolves promptly.
  svc.startMassSell([{ username: 'botA', items }], 'lowest', { itemDelayMs: 500, ...opts });
  const deadline = Date.now() + 10_000;
  while (svc.status().running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(svc.status().running, false, 'run must complete');
  return svc.status();
}

test('H-TRD-023 (a): a transport-failure null is NOT cached — each same-name item is looked up and DEFERRED', async () => {
  const { svc, calls } = svcWith({ lowestMinor: null, medianMinor: null, volume: null, authoritative: false });
  // ONE lane, so the second item asks AFTER the first has already failed — the case the invariant
  // is about: a failed lookup must leave nothing behind that short-circuits the next item.
  // (Concurrent lanes share one in-flight lookup instead; that is the test below, and it is not
  // caching — the entry is dropped the moment it settles.)
  const job = await runToCompletion(svc, [
    { assetId: 'x1', marketHashName: 'Dreams & Nightmares Case' },
    { assetId: 'x2', marketHashName: 'Dreams & Nightmares Case' },
  ], { itemConcurrency: 1 });
  assert.equal(calls(), 2, 'no cache short-circuit: both same-name items trigger their own lookup');
  assert.equal(job.skippedNoPrice, 0, 'a transport failure is never counted as "no price"');
  assert.equal(job.failed.length, 0, 'and never pushed into failed[]');
  assert.equal(job.deferred.length, 2, 'both items are deferred (retryable)');
  for (const d of job.deferred) assert.match(d.error, /price lookup failed \(connection\)/);
});

test('H-TRD-023 (b): an authoritative no-price IS cached — one lookup for N same-name items, all skippedNoPrice', async () => {
  const { svc, calls } = svcWith({ lowestMinor: null, medianMinor: null, volume: null, authoritative: true });
  const job = await runToCompletion(svc, [
    { assetId: 'y1', marketHashName: 'Dreams & Nightmares Case' },
    { assetId: 'y2', marketHashName: 'Dreams & Nightmares Case' },
  ]);
  assert.equal(calls(), 1, 'a genuine no-price is cached: the 2nd same-name item short-circuits');
  assert.equal(job.skippedNoPrice, 2, 'both are the unchanged authoritative "no price"');
  assert.equal(job.failed.length, 2, 'and recorded in failed[] (unchanged behavior)');
  assert.equal(job.deferred.length, 0, 'nothing is deferred for a true no-price');
});

test('lanes asking for the SAME name at once share ONE lookup — and still each defer on a transport failure', async () => {
  // v1.4.8: a bot lists over parallel lanes. Without in-flight de-dup, K lanes starting on K
  // copies of one item each fire their own priceoverview — K× the account's scarce price budget
  // for one answer. Sharing the in-flight request is NOT caching: the entry is dropped when it
  // settles (proven by (a) above), and every waiter still gets the transport-failure outcome, so
  // nothing is silently listed off a failed price.
  const { svc, calls } = svcWith({ lowestMinor: null, medianMinor: null, volume: null, authoritative: false });
  const job = await runToCompletion(svc, [
    { assetId: 'z1', marketHashName: 'Dreams & Nightmares Case' },
    { assetId: 'z2', marketHashName: 'Dreams & Nightmares Case' },
  ], { itemConcurrency: 2 });
  assert.equal(calls(), 1, 'both lanes are served by a single in-flight lookup');
  assert.equal(job.deferred.length, 2, 'each item still reaches its own deferred (retryable) outcome');
  assert.equal(job.skippedNoPrice, 0, 'a shared transport failure is still never "no price"');
  assert.equal(job.listed, 0, 'and nothing is listed off a price we never got');
});
