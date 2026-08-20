import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  performWalletPurchase, primeOwnership,
  CS2_APP_ID, CS2_PRIME_APP_ID, CS2_PRIME_SUB_ID,
  type WalletPurchaseEnv,
} from '../src/store/WalletPurchase';
import type { StoreContext, StoreResponse } from '../src/store/StoreService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — the read-only "which of these accounts already has Prime?" report.
//
//  The report and the purchase must never disagree. If the report says an account needs Prime and
//  the purchase then refuses it as already owned, the operator has been told to spend money on
//  something the fleet already holds — and the inverse is worse: a report that says "has Prime"
//  while the purchase happily buys a second copy.
//
//  performWalletPurchase deliberately keeps its own copy of the ownership gate (rewriting a money
//  path to add a read-only feature is not a trade worth making), so the guarantee is enforced HERE:
//  every ownership input is driven through the REAL purchase choreography, and its verdict is
//  compared against primeOwnership's. Change either one without the other and this fails.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const ok = (data: unknown, status = 200): StoreResponse => ({ status, data, location: '' });

/** Only the reads the ownership gate performs are scripted. Anything past it throws loudly: these
 *  cases must never reach a cart, let alone a charge. */
function ctxFor(userdata: unknown): StoreContext {
  return {
    username: 'bot01', steamId: '76561198000000000', sessionid: 'cookiesid',
    webapi: async () => { throw new Error('the ownership gate must not touch the cart'); },
    get: async (path) => {
      if (path.includes('/dynamicstore/userdata')) return userdata === null ? ok('not json at all') : ok(userdata);
      throw new Error(`the ownership gate must not GET ${path}`);
    },
    post: async (path) => { throw new Error(`the ownership gate must not POST ${path}`); },
  };
}

function envFor(licensed: number[] | null): WalletPurchaseEnv {
  return {
    readWallet: async () => ({ hasWallet: true, currency: 3, balance: 50 }),   // 50 EUR: never the reason
    readOwnedPackageIds: () => licensed,
    grantFreeBaseGame: async () => { throw new Error('the ownership gate must not grant licences'); },
    sleep: async () => { /* no timers */ },
  };
}

/** Every distinguishable ownership input, named by what it represents on a real account. */
const CASES: Array<{ name: string; licensed: number[] | null; userdata: unknown }> = [
  { name: 'licences unreadable (CM list absent)', licensed: null, userdata: { rgOwnedApps: [CS2_APP_ID], rgOwnedPackages: [] } },
  { name: 'licences unreadable AND the store is unreadable', licensed: null, userdata: null },
  { name: 'store library holds the Prime APP', licensed: [303386], userdata: { rgOwnedApps: [CS2_APP_ID, CS2_PRIME_APP_ID], rgOwnedPackages: [] } },
  { name: 'CM licence list holds the Prime SUB', licensed: [303386, CS2_PRIME_SUB_ID], userdata: { rgOwnedApps: [CS2_APP_ID], rgOwnedPackages: [] } },
  { name: 'store reports the Prime PACKAGE only', licensed: [303386], userdata: { rgOwnedApps: [CS2_APP_ID], rgOwnedPackages: [CS2_PRIME_SUB_ID] } },
  { name: 'both sources agree it is owned', licensed: [CS2_PRIME_SUB_ID], userdata: { rgOwnedApps: [CS2_APP_ID, CS2_PRIME_APP_ID], rgOwnedPackages: [CS2_PRIME_SUB_ID] } },
  { name: 'nobody has Prime, store readable', licensed: [303386, 469902], userdata: { rgOwnedApps: [CS2_APP_ID], rgOwnedPackages: [303386] } },
  { name: 'nobody has Prime, store UNREADABLE (corroboration absent)', licensed: [303386, 469902], userdata: null },
];

/** How a purchase outcome maps onto an ownership verdict. */
const EXPECTED_PURCHASE_STATUS: Record<string, string> = { owned: 'owned', unreadable: 'refused' };

for (const c of CASES) {
  test(`H-PRM-04x: report and purchase agree — ${c.name}`, async () => {
    // The store payload the report reads is the same one the purchase reads, through the same helper.
    const storeOwned = c.userdata === null ? null : {
      apps: (c.userdata as { rgOwnedApps: number[] }).rgOwnedApps,
      packages: (c.userdata as { rgOwnedPackages: number[] }).rgOwnedPackages,
    };
    const verdict = primeOwnership(c.licensed, c.licensed == null ? null : storeOwned);

    const result = await performWalletPurchase(ctxFor(c.userdata), envFor(c.licensed));

    const expected = EXPECTED_PURCHASE_STATUS[verdict.state];
    if (expected) {
      assert.equal(result.status, expected,
        `report says "${verdict.state}" but the purchase answered "${result.status}" (${result.detail})`);
    } else {
      // verdict 'missing' ⇒ the purchase must have gone PAST the ownership gate. It then fails on the
      // very next step (this scripted context refuses to serve a cart), which is exactly the proof we
      // want: the gate did not stop it.
      assert.equal(verdict.state, 'missing');
      assert.ok(result.status !== 'owned', 'the purchase must not consider this account already owned');
    }
  });
}

test('H-PRM-040: an unreadable licence list is never reported as "no Prime"', () => {
  // The single most costly confusion: Steam answers an unreadable account exactly like one that owns
  // nothing, and "no Prime" is what sends an operator to buy licences the fleet already holds.
  assert.equal(primeOwnership(null, null).state, 'unreadable');
  assert.equal(primeOwnership(null, { apps: [], packages: [] }).state, 'unreadable');
  assert.notEqual(primeOwnership(null, null).state, 'missing');
});

test('H-PRM-041: an EMPTY licence array is unreadable, not "owns nothing"', () => {
  // ownedPackageIdsFrom already collapses [] to null for this reason (every CS2 account holds at
  // least the free licence); this pins that the verdict layer honours it rather than re-deciding.
  assert.equal(primeOwnership(null, { apps: [CS2_APP_ID], packages: [] }).state, 'unreadable');
});

test('H-PRM-042: a readable account with no Prime reports missing — the one state that means "buy"', () => {
  assert.equal(primeOwnership([303386], { apps: [CS2_APP_ID], packages: [303386] }).state, 'missing');
  assert.equal(primeOwnership([303386], null).state, 'missing', 'store corroboration is optional, never required');
});
