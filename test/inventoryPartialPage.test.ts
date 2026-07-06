import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryManager } from '../src/core/InventoryManager';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-011 — a mid-pagination failure (page ≥1 unusable body, or a stuck
//  pagination cursor) must return the pages fetched so far FLAGGED as PARTIAL
//  (truncated:true), so the fuller-cache guard fires instead of the half read
//  clobbering the cache as authoritative. Only the HTTP boundary (axios.get) is
//  mocked; fetchRaw runs for real.
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000001';

function bigAssets(prefix: string, n: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ appid: 730, contextid: '2', assetid: `${prefix}${i}`, classid: 'C1', instanceid: '0', amount: '1' });
  }
  return out;
}

/**
 * Installs an axios.get mock whose response depends on whether the URL carries a
 * `start_assetid` (page 0 vs page ≥1). `pageOne` is the body Steam returns for the
 * second page. Returns a restore fn.
 */
function installAxiosMock(pageZero: unknown, pageOne: unknown): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/start_assetid=/.test(url)) return { status: 200, data: pageOne };
    return { status: 200, data: pageZero };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

function fakeSession(): any {
  return {
    account: { username: 'storagebot' },
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-INV-011: page ≥1 unusable body → pages so far kept AND truncated flagged', async () => {
  const pageZero = { success: 1, total_inventory_count: 4000, more_items: 1, last_assetid: 'A', assets: bigAssets('a', 2000), descriptions: [] };
  const pageOne  = { success: 0 }; // 200-status but not an authoritative Steam body
  const restore = installAxiosMock(pageZero, pageOne);
  try {
    const raw = await InventoryManager.fetchRaw(fakeSession(), 'cs2', 2);
    assert.equal(raw.assets!.length, 2000, 'page-0 assets are preserved (not thrown away)');
    assert.equal(raw.truncated, true, 'a mid-pagination failure marks the read PARTIAL');
  } finally {
    restore();
  }
});

test('H-INV-011: stuck pagination cursor (last_assetid unchanged) → truncated flagged', async () => {
  const pageZero = { success: 1, total_inventory_count: 4000, more_items: 1, last_assetid: 'A', assets: bigAssets('a', 2000), descriptions: [] };
  // more_items still set but the cursor did NOT advance (Steam repeats last_assetid='A').
  const pageOne  = { success: 1, total_inventory_count: 4000, more_items: 1, last_assetid: 'A', assets: bigAssets('b', 2000), descriptions: [] };
  const restore = installAxiosMock(pageZero, pageOne);
  try {
    const raw = await InventoryManager.fetchRaw(fakeSession(), 'cs2', 2);
    assert.equal(raw.truncated, true, 'a stalled cursor marks the read PARTIAL');
  } finally {
    restore();
  }
});

test('H-INV-011: clean full pagination is NOT flagged partial', async () => {
  const pageZero = { success: 1, total_inventory_count: 3000, more_items: 1, last_assetid: 'A', assets: bigAssets('a', 2000), descriptions: [] };
  // Second page completes the inventory: no more_items → clean end.
  const pageOne  = { success: 1, total_inventory_count: 3000, more_items: 0, assets: bigAssets('b', 1000), descriptions: [] };
  const restore = installAxiosMock(pageZero, pageOne);
  try {
    const raw = await InventoryManager.fetchRaw(fakeSession(), 'cs2', 2);
    assert.equal(raw.assets!.length, 3000, 'both pages merged');
    assert.equal(raw.truncated, false, 'a complete read is authoritative (not partial)');
  } finally {
    restore();
  }
});
