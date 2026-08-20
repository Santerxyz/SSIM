import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';
import { fetchListedItems } from '../src/core/MarketListings';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner report: "when i sell TF2 items it still shows in inventory AND in active orders,
//  instead of listed in the marketplace like CS2".
//
//  Two coupled defects produced that, and both are about ONE ASSET = ONE BUCKET:
//
//   1. `fetchListedItems` hardcoded appid 730. Every listed-item read was CS2's, so a TF2 listing
//      could never be recognised at all — even by a caller that wanted it.
//   2. The TF2 refresh (`doRefreshOne`) had NO market leg whatsoever. It read context 2 and wrote
//      the cache. So a TF2 asset on the market — which is still sitting in context 2 while its
//      listing awaits mobile confirmation — was written back as plain Owned on every single pass,
//      while Active Orders (which reads `mylistings` and IS app-aware) correctly showed it as a
//      listing. Hence the same item in two places at once.
//
//  `mylistings` is account-wide: one call already returns every app's listings, so the fix is a
//  filter parameter plus a leg on the TF2 path — not a second endpoint.
//
//  The load-bearing case in here is the FAILURE one. A market read that 429s must never be read as
//  "no listings", because that silently un-lists items and puts them back under Owned, which is the
//  same broken state arriving by a different route.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000009';
const TF2_APPID = 440;
const CS2_APPID = 730;

function session(): any {
  return {
    account: { username: 'tfbot', network: { type: 'localip' } },
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

/** One `mylistings` page holding listings for BOTH games — which is what Steam actually returns. */
function mixedListingsPage() {
  return {
    success: 1,
    total_count: 2,
    listings: [
      { listingid: 'L-TF2', price: 100, fee: 15, currencyid: 2003, asset: { id: 'TF2_ASSET', appid: TF2_APPID, contextid: '2', amount: '1' } },
      { listingid: 'L-CS2', price: 900, fee: 90, currencyid: 2003, asset: { id: 'CS2_ASSET', appid: CS2_APPID, contextid: '2', amount: '1' } },
    ],
    assets: {},
  };
}

/** Runs `fn` with axios.get stubbed. Always restores, even when the assertion throws. */
async function withAxios(handler: (url: string) => Promise<{ status: number; data: unknown }>, fn: () => Promise<void>): Promise<void> {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = handler;
  try { await fn(); } finally { ax.get = orig; }
}

// ── 1) the app filter ────────────────────────────────────────────────────────────────────────────

test('H-TF2-070: fetchListedItems returns the requested app, not always CS2', async () => {
  await withAxios(async () => ({ status: 200, data: mixedListingsPage() }), async () => {
    const tf2 = await fetchListedItems(session(), TF2_APPID);
    assert.deepEqual([...tf2.assetIds], ['TF2_ASSET'], 'a TF2 read must not pick up the CS2 listing');
    assert.equal(tf2.items.length, 1);

    const cs2 = await fetchListedItems(session(), CS2_APPID);
    assert.deepEqual([...cs2.assetIds], ['CS2_ASSET'], 'and the CS2 read is unchanged by the new parameter');
  });
});

test('H-TF2-071: the default is still CS2 — every pre-existing caller is untouched', async () => {
  await withAxios(async () => ({ status: 200, data: mixedListingsPage() }), async () => {
    const def = await fetchListedItems(session());
    assert.deepEqual([...def.assetIds], ['CS2_ASSET']);
  });
});

// ── 2) the TF2 refresh actually folds the market in ──────────────────────────────────────────────

/** A real InventoryService (the preload points SSIM_HOME at a throwaway temp dir, so its stores are
 *  safe), with only the session and the context-2 fetch stubbed — the market leg stays live. */
function serviceWith(ctx2Items: Array<{ assetId: string; marketHashName: string }>) {
  const sessions: any = {
    getSession: () => session(),
    loginAccount: async () => session(),
    loginAccountOwned: async () => ({ session: session(), createdByCall: false }),
    logoutAccount: async () => undefined,
    isLive: () => true,
    markUsed: () => undefined,
    isEgressStale: () => false,
  };
  const accounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };
  const svc = new InventoryService(sessions, accounts);
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => undefined;

  InventoryManager.fetchInventoryOnly = async () => ({
    username: 'tfbot', steamId: STEAMID, game: 'tf2', source: 'web',
    items: ctx2Items.map((i) => ({
      assetId: i.assetId, classId: 'c', instanceId: '0', marketHashName: i.marketHashName, name: i.marketHashName,
      type: '', rarity: 'Unknown', rarityColor: '#fff', exterior: null, tradable: true, marketable: true,
      tradeLockExpiry: null, quantity: 1, assetIds: [i.assetId],
    })),
    totalItems: ctx2Items.length, fetchedAt: new Date(),
  });
  return svc as any;
}

test('H-TF2-072: a listed TF2 asset leaves the Owned bucket and appears as Listed — never both', async () => {
  // THE reported symptom: the asset is still in context 2 (its listing awaits confirmation) while
  // Active Orders already shows it. Before the fix it was written back as Owned every pass.
  const svc = serviceWith([
    { assetId: 'TF2_ASSET', marketHashName: 'Mann Co. Supply Crate Key' },
    { assetId: 'KEEP_ME', marketHashName: 'Refined Metal' },
  ]);
  await withAxios(async () => ({ status: 200, data: mixedListingsPage() }), async () => {
    const inv = await svc.refreshOne('tfbot', 'tf2');
    const owned = inv.items.filter((i: any) => i.category !== 'listed');
    const listed = inv.items.filter((i: any) => i.category === 'listed');

    assert.deepEqual(owned.flatMap((i: any) => i.assetIds), ['KEEP_ME'], 'the listed asset is gone from Owned');
    assert.deepEqual(listed.flatMap((i: any) => i.assetIds), ['TF2_ASSET'], 'and is present exactly once as Listed');

    const everywhere = inv.items.flatMap((i: any) => i.assetIds);
    assert.equal(new Set(everywhere).size, everywhere.length, 'no asset may appear in two buckets');
    assert.equal(inv.totalItems, 2, 'totalItems counts owned + listed, each once');
  });
});

test('H-TF2-073: a CS2 listing never steals an asset out of the TF2 inventory', async () => {
  // The mirror of the appid bug: reading the wrong app would subtract a CS2 asset id from TF2.
  const svc = serviceWith([{ assetId: 'CS2_ASSET', marketHashName: 'Refined Metal' }]);
  await withAxios(async () => ({ status: 200, data: mixedListingsPage() }), async () => {
    const inv = await svc.refreshOne('tfbot', 'tf2');
    const owned = inv.items.filter((i: any) => i.category !== 'listed');
    assert.deepEqual(owned.flatMap((i: any) => i.assetIds), ['CS2_ASSET'], 'a same-named CS2 asset id is not a TF2 listing');
  });
});

// ── 3) the failure mode that matters ─────────────────────────────────────────────────────────────

test('H-TF2-074: a FAILED market read never un-lists anything — the cached bucket is carried forward', async () => {
  // A 429 must not read as "no listings". Wiping the bucket would put sold items straight back under
  // Owned, which is the very bug this fixes, arriving from the other direction.
  const svc = serviceWith([{ assetId: 'KEEP_ME', marketHashName: 'Refined Metal' }]);
  svc.tf2Store.set('tfbot', {
    username: 'tfbot', steamId: STEAMID, game: 'tf2', source: 'web', fetchedAt: new Date(), totalItems: 1,
    items: [{
      assetId: 'TF2_ASSET', classId: 'c', instanceId: '0', marketHashName: 'Mann Co. Supply Crate Key',
      name: 'Mann Co. Supply Crate Key', type: '', rarity: 'Unknown', rarityColor: '#fff', exterior: null,
      tradable: false, marketable: true, tradeLockExpiry: null, category: 'listed', quantity: 1, assetIds: ['TF2_ASSET'],
    }],
  } as any);

  await withAxios(async () => ({ status: 500, data: 'nope' }), async () => {
    const inv = await svc.refreshOne('tfbot', 'tf2');
    const listed = inv.items.filter((i: any) => i.category === 'listed');
    assert.deepEqual(listed.flatMap((i: any) => i.assetIds), ['TF2_ASSET'], 'the previously-known listing survives an unread pass');
    const owned = inv.items.filter((i: any) => i.category !== 'listed');
    assert.deepEqual(owned.flatMap((i: any) => i.assetIds), ['KEEP_ME'], 'and the owned side is left exactly as fetched');
  });
});

// ── 4) the buy-verification path stays lean ──────────────────────────────────────────────────────

test('H-TF2-075: forceRefresh does NOT read the market — mass-buy verification keeps its cost', async () => {
  // forceRefresh is the before/after diff behind buy verification. A market round-trip per account
  // would cost real time at fleet scale and cannot change the answer: a just-bought item is not listed.
  const svc = serviceWith([{ assetId: 'KEEP_ME', marketHashName: 'Refined Metal' }]);
  let marketCalls = 0;
  await withAxios(async () => { marketCalls++; return { status: 200, data: mixedListingsPage() }; }, async () => {
    await svc.forceRefresh('tfbot', 'tf2');
    assert.equal(marketCalls, 0, 'no mylistings request may be issued on the verification path');
  });
});
