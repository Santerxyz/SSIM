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
