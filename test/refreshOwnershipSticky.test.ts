import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'async_hooks';
import { InventoryService } from '../src/core/InventoryService';
import { SessionState } from '../src/types/session';

// ─────────────────────────────────────────────────────────────────────────────
//  Ownership stickiness across the both-games refresh legs.
//
//  The bulk refresh releases ONLY sessions IT created (store.createdByCall). The
//  both-games refresh calls ensureSession twice per account: the CS2 leg CREATES the
//  session (→ true), the TF2 leg REUSES it. A plain `= false` on the reuse path
//  clobbered the CS2 leg's ownership → the finally released NOTHING → the whole fleet
//  piled up to the live-session ceiling ("released 0 refresh session(s)" + mass
//  "ceiling reached" refusals). ensureSession must keep the flag STICKY-true.
// ─────────────────────────────────────────────────────────────────────────────

function makeSvc(): { svc: any; store: { createdByCall?: boolean }; run: (fn: () => Promise<unknown>) => Promise<unknown> } {
  const svc = Object.create(InventoryService.prototype) as any;
  const ctx = new AsyncLocalStorage<{ createdByCall?: boolean }>();
  svc.ownershipCtx = ctx;
  svc.accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
  // Simulate: first ensureSession creates (no existing), later ones reuse (a LOGGED_IN session appears).
  let live: any = null;
  svc.sessions = {
    getSession: () => live,
    markUsed: () => undefined,
    isEgressStale: () => false,   // 1.5.1 reuse guard: this stub session logged in over the CURRENT egress
    loginAccountOwned: async () => {
      live = { state: SessionState.LOGGED_IN, webSession: {} };
      return { session: live, createdByCall: true }; // this login created the session
    },
  };
  const store: { createdByCall?: boolean } = {};
  const run = (fn: () => Promise<unknown>) => ctx.run(store, fn);
  return { svc, store, run };
}

test('CS2 leg creates then TF2 leg reuses → ownership stays TRUE (session is released)', async () => {
  const { svc, store, run } = makeSvc();
  await run(async () => {
    await svc.ensureSession('bot');   // CS2 leg: creates → true
    await svc.ensureSession('bot');   // TF2 leg: reuses → must NOT clobber to false
  });
  assert.equal(store.createdByCall, true, 'the refresh still owns the session it created → will be released');
});

test('reusing a PRE-EXISTING session (another op owns it) stays FALSE', async () => {
  const svc = Object.create(InventoryService.prototype) as any;
  const ctx = new AsyncLocalStorage<{ createdByCall?: boolean }>();
  svc.ownershipCtx = ctx;
  svc.accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
  const preExisting = { state: SessionState.LOGGED_IN, webSession: {} };
  svc.sessions = {
    getSession: () => preExisting,   // always already live (owned elsewhere)
    markUsed: () => undefined,
    isEgressStale: () => false,   // 1.5.1 reuse guard: this stub session logged in over the CURRENT egress
    loginAccountOwned: async () => { throw new Error('should not log in — session already live'); },
  };
  const store: { createdByCall?: boolean } = {};
  await ctx.run(store, async () => {
    await svc.ensureSession('bot');   // CS2 leg reuses
    await svc.ensureSession('bot');   // TF2 leg reuses
  });
  assert.equal(store.createdByCall, false, 'a session another op owns is never claimed for release');
});
