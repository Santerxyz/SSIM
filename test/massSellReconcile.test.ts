import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';

// ─────────────────────────────────────────────────────────────────────────────
//  S28 — mass-sell phantom reconcile must remove recovered rows by IDENTITY
//  (username + assetId), not by a positional index into the shared this.job.failed
//  that a concurrent bot's filter reindexes. The positional version could write
//  __recovered__ onto — and then drop — ANOTHER bot's genuine failure.
//  reconcilePhantoms only reads this.job, so Object.create + a fake job exercises
//  the exact shipped logic.
// ─────────────────────────────────────────────────────────────────────────────

function svcWithFailed(failed: Array<{ username: string; assetId: string; error: string }>): any {
  const svc: any = Object.create(MarketService.prototype);
  svc.job = { failed, listed: 0, recovered: 0 };
  return svc;
}

test('S28: recovering one bot\'s phantoms does NOT drop a concurrent bot\'s genuine failure', () => {
  const svc = svcWithFailed([
    { username: 'botA', assetId: 'a1', error: 'transient' },
    { username: 'botA', assetId: 'a2', error: 'transient' },
    { username: 'botB', assetId: 'b1', error: 'REAL FAILURE' }, // another bot's genuine failure
  ]);
  // botA reconciles: a1 + a2 are actually listed (phantoms) → recover both.
  const n = svc.reconcilePhantoms('botA', new Set(['a1', 'a2']), new Set(['a1', 'a2']));
  assert.equal(n, 2);
  assert.deepEqual(svc.job.failed, [{ username: 'botB', assetId: 'b1', error: 'REAL FAILURE' }],
    'botB\'s genuine failure survives (the positional-index version could have dropped it)');
  assert.equal(svc.job.listed, 2);
  assert.equal(svc.job.recovered, 2);
});

test('S28: identity is username+assetId — a same-assetId row of ANOTHER bot is untouched', () => {
  const svc = svcWithFailed([
    { username: 'botA', assetId: 'shared', error: 'transient' },
    { username: 'botB', assetId: 'shared', error: 'B genuine' }, // same assetId, different bot
  ]);
  svc.reconcilePhantoms('botA', new Set(['shared']), new Set(['shared']));
  assert.deepEqual(svc.job.failed, [{ username: 'botB', assetId: 'shared', error: 'B genuine' }],
    'only botA\'s row is removed — identity includes the username');
});

test('S28: nothing actually listed → no recovery, the genuine failure stays failed', () => {
  const svc = svcWithFailed([{ username: 'botA', assetId: 'a1', error: 'real' }]);
  assert.equal(svc.reconcilePhantoms('botA', new Set(['a1']), new Set<string>()), 0);
  assert.equal(svc.job.failed.length, 1);
  assert.equal(svc.job.listed, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-028 — mid-run web-session loss must DEFER, not fail. When a bot's web
//  cookies die mid-run the sellitem POST throws a non-transient HTTP 40x and the
//  phantom probe (getListedAssetIds) throws a non-transient HTTP 40x too. The old
//  probe catch only handled the transient case, so a non-transient probe error
//  fell through and the item was returned as a hard { error } — turning hundreds
//  of retry-safe items into "genuine failures". listWithRetry must now defer on
//  ANY probe error (phantom status unknown, session suspect).
// ─────────────────────────────────────────────────────────────────────────────

test('H-TRD-028: session-loss (sellitem 403 + probe 403) defers the item, calls sellOnMarket once', async () => {
  const svc: any = Object.create(MarketService.prototype);
  svc.job = { retried: 0 };
  let sellCalls = 0;
  let probeCalls = 0;
  const trader = {
    username: 'botA',
    ready: true,
    sessionState: 'LOGGED_IN', // CM session still up — only the WEB session died
    async sellOnMarket(_a: string, _n: number) { sellCalls++; throw new Error('market/sellitem HTTP 403'); },
    async getListedAssetIds() { probeCalls++; throw new Error('market/mylistings HTTP 403'); },
  };
  const listedSet = new Set<string>();
  const outcome = await svc.listWithRetry(trader, 'a1', 1234, listedSet);
  assert.equal(outcome, 'deferred', 'a dead web session must defer (retryable), not fail');
  assert.equal(sellCalls, 1, 'the dead sellitem POST is attempted exactly once — no burned retries');
  assert.equal(probeCalls, 1, 'the phantom probe is attempted exactly once');
  assert.equal(listedSet.has('a1'), false, 'nothing was listed');
});

test('H-TRD-028: a genuine hard error on a HEALTHY session still returns { error }', async () => {
  const svc: any = Object.create(MarketService.prototype);
  svc.job = { retried: 0 };
  const trader = {
    username: 'botA',
    ready: true,
    sessionState: 'LOGGED_IN',
    async sellOnMarket(_a: string, _n: number) { throw new Error('market listing rejected by Steam'); },
    async getListedAssetIds() { return new Set<string>(); }, // probe SUCCEEDS: item is genuinely not listed
  };
  const outcome = await svc.listWithRetry(trader, 'a1', 1234, new Set<string>());
  assert.deepEqual(outcome, { error: 'market listing rejected by Steam' },
    'a hard error whose probe succeeds is still a genuine failure — the defer path only widens for probe FAILURES');
});
