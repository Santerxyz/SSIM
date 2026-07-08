import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';

// ─────────────────────────────────────────────────────────────────────────────
//  Both-games bulk refresh (owner request 2026-07-08): startRefresh fetches CS2
//  AND TF2 for every account in ONE pass (same login/throttle slot), so the
//  Steam wallet lands in both caches with one timestamp and the TF2 tab never
//  needs its own login pass. A TF2-only failure surfaces as a "TF2:"-tagged
//  partial failure WITHOUT voiding the account's committed CS2 leg.
//  (Object.create exercises the shipped startRefresh/runRefresh without the
//  heavy constructor — the established pattern, see inFlightIdentityDelete.)
// ─────────────────────────────────────────────────────────────────────────────

function makeSvc(refreshOneImpl: (u: string, g?: string) => Promise<unknown>): InventoryService & { job: { running: boolean; done: number; total: number; failed: Array<{ username: string; error: string }> } } {
  const svc = Object.create(InventoryService.prototype) as any;
  svc.job = { running: false, total: 0, done: 0, failed: [] };
  svc.refreshCancel = false;
  svc.inFlight = new Map();
  svc.bgRefreshPasses = 0;
  svc.ownershipCtx = { run: (_store: unknown, fn: () => unknown) => fn() };
  svc.sessions = { isLive: () => false, logoutAccount: async () => undefined };
  svc.accounts = { get: () => ({ network: { type: 'proxy' } }) }; // proxied → no local-IP throttle
  svc.gcStore = { flush: () => undefined };
  svc.tf2Store = { flush: () => undefined };
  svc.refreshOne = refreshOneImpl;
  return svc;
}

async function waitForJob(svc: { job: { running: boolean } }): Promise<void> {
  for (let i = 0; i < 400 && svc.job.running; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(svc.job.running, false, 'the refresh job settles');
}

test('bulk refresh fetches BOTH games for every account in one pass', async () => {
  const calls: string[] = [];
  const svc = makeSvc(async (u, g) => { calls.push(`${u}:${g ?? 'cs2'}`); return {}; });

  svc.startRefresh(['alice', 'bob'], 'cs2');
  await waitForJob(svc);

  assert.equal(svc.job.done, 2, 'both accounts counted');
  assert.equal(svc.job.failed.length, 0, 'no failures');
  for (const u of ['alice', 'bob']) {
    assert.ok(calls.includes(`${u}:cs2`), `${u} got the CS2 leg`);
    assert.ok(calls.includes(`${u}:tf2`), `${u} got the TF2 leg`);
    assert.ok(calls.indexOf(`${u}:cs2`) < calls.indexOf(`${u}:tf2`), `${u}: CS2 (primary/full) runs before the TF2 read`);
  }
});

test('a TF2-only failure is a tagged partial failure; the CS2 leg stays committed', async () => {
  const calls: string[] = [];
  const svc = makeSvc(async (u, g) => {
    calls.push(`${u}:${g ?? 'cs2'}`);
    if (u === 'bad' && g === 'tf2') throw new Error('boom');
    return {};
  });

  svc.startRefresh(['bad', 'good'], 'cs2');
  await waitForJob(svc);

  assert.equal(svc.job.done, 2, 'both accounts counted even with the partial failure');
  assert.equal(svc.job.failed.length, 1, 'exactly one failure recorded');
  assert.equal(svc.job.failed[0].username, 'bad');
  assert.ok(svc.job.failed[0].error.startsWith('TF2:'), `failure names the failed leg (got "${svc.job.failed[0].error}")`);
  assert.ok(calls.includes('bad:cs2'), 'the CS2 leg ran (and stays committed) despite the TF2 failure');
  assert.ok(calls.includes('good:cs2') && calls.includes('good:tf2'), 'the other account is unaffected');
});

test('a CS2-leg failure fails the account without attempting the TF2 leg', async () => {
  const calls: string[] = [];
  const svc = makeSvc(async (u, g) => {
    calls.push(`${u}:${g ?? 'cs2'}`);
    if (u === 'down' && g === 'cs2') throw new Error('login dead');
    return {};
  });

  svc.startRefresh(['down'], 'cs2');
  await waitForJob(svc);

  assert.equal(svc.job.failed.length, 1);
  assert.equal(svc.job.failed[0].error, 'login dead', 'the CS2 failure surfaces untagged (primary leg)');
  assert.ok(!calls.includes('down:tf2'), 'no TF2 attempt after the primary leg failed');
});
