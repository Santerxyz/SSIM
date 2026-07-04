import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'async_hooks';
import { InventoryService } from '../src/core/InventoryService';
import { SessionState } from '../src/types/session';

// ─────────────────────────────────────────────────────────────────────────────
//  S25 — session-ownership ("did THIS refresh create the session?") was tracked in
//  a service-level Map keyed by ACCOUNT, which two concurrent same-account flows
//  (a fleet refresh + a post-trade refresh) clobbered — one could log the shared
//  session out mid-fetch, or neither release it (leaked to the reaper). Ownership
//  is now scoped per-invocation via AsyncLocalStorage. This drives two interleaved
//  ensureSession() calls for the SAME account and asserts isolated ownership.
// ─────────────────────────────────────────────────────────────────────────────

test('S25: concurrent same-account refresh flows keep ISOLATED ownership (no clobber)', async () => {
  const svc: any = Object.create(InventoryService.prototype);
  svc.ownershipCtx = new AsyncLocalStorage();
  svc.accounts = { get: (u: string) => ({ username: u }) };
  let getCalls = 0;
  svc.sessions = {
    // 1st call (Flow A): no live session → A CREATES it. 2nd (Flow B): a live session exists → B REUSES.
    getSession: () => { getCalls++; return getCalls === 1 ? undefined : { state: SessionState.LOGGED_IN, webSession: {} }; },
    loginAccountOwned: async () => { await new Promise((r) => setImmediate(r)); return { session: {}, createdByCall: true }; },
    markUsed: () => {},
  };

  const storeA: { createdByCall?: boolean } = {};
  const storeB: { createdByCall?: boolean } = {};
  // Start A (yields at loginAccountOwned) then B (reuses synchronously) — the exact interleave the shared
  // map lost. Each ensureSession writes into its OWN run() store.
  const flowA = svc.ownershipCtx.run(storeA, () => svc.ensureSession('bob'));
  const flowB = svc.ownershipCtx.run(storeB, () => svc.ensureSession('bob'));
  await Promise.all([flowA, flowB]);

  assert.equal(storeA.createdByCall, true, 'Flow A owns the session it created (would release it)');
  assert.equal(storeB.createdByCall, false, 'Flow B reused a live session — NOT its to release (no mid-fetch logout)');
});

test('S25: outside a refresh worker (no run context) ensureSession records nothing (single-account API path)', async () => {
  const svc: any = Object.create(InventoryService.prototype);
  svc.ownershipCtx = new AsyncLocalStorage();
  svc.accounts = { get: (u: string) => ({ username: u }) };
  svc.sessions = {
    getSession: () => ({ state: SessionState.LOGGED_IN, webSession: {} }),
    loginAccountOwned: async () => ({ session: {}, createdByCall: true }),
    markUsed: () => {},
  };
  // No ownershipCtx.run → getStore() is undefined → ensureSession must not throw (it just skips recording).
  await assert.doesNotReject(svc.ensureSession('bob'));
  assert.equal(svc.ownershipCtx.getStore(), undefined, 'no ambient store leaks outside a run()');
});
