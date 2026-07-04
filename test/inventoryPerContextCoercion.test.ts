import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryManager } from '../src/core/InventoryManager';
import { SessionState } from '../src/types/session';

// ─────────────────────────────────────────────────────────────────────────────
//  S4 — per-context empty-coercion. fetchRaw must NOT turn an unusable page-0 body
//  (null / HTML error / {success:false} / {success:0} / {}) into a "successful empty
//  inventory". Doing so let a transient bad body on ONE CS2 context (owned vs
//  trade-locked/listed) silently drop that whole context from the merged cache
//  while the other context kept rawCount > 0, so neither the both-empty retry nor
//  the rawCount reconcile guard tripped. It must throw (a fetch failure) so the
//  refresh fails and the cache is preserved — an AUTHORITATIVE empty still returns.
// ─────────────────────────────────────────────────────────────────────────────

function fakeSession(): any {
  return {
    state: SessionState.LOGGED_IN,
    steamId: '76561198000000000',
    account: { username: 'bot1', userAgent: 'UA' },
    webSession: { cookies: ['steamLoginSecure=x'] },
    httpsAgent: undefined,
  };
}

function installAxiosMock(responder: (url: string) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

test('S4: fetchRaw THROWS on an unusable page-0 body (was silently coerced to empty)', async () => {
  const unusable: unknown[] = [null, { success: false }, { success: 0 }, {}, '<html>Access Denied</html>'];
  for (const bad of unusable) {
    const restore = installAxiosMock(async () => ({ status: 200, data: bad }));
    try {
      await assert.rejects(
        () => InventoryManager.fetchRaw(fakeSession(), 'cs2', 16),
        /unusable/i,
        `unusable body ${JSON.stringify(bad)} must throw, not coerce to a successful empty inventory`,
      );
    } finally { restore(); }
  }
});

test('S4: fetchRaw returns an AUTHORITATIVE empty for a 200 + success:1 + zero assets', async () => {
  const restore = installAxiosMock(async () => ({ status: 200, data: { success: 1, total_inventory_count: 0 } }));
  try {
    const raw = await InventoryManager.fetchRaw(fakeSession(), 'cs2', 2);
    assert.deepEqual(raw.assets, [], 'a real empty inventory still yields zero assets (not a throw)');
    assert.equal(raw.success, 1);
  } finally { restore(); }
});

test('S4: fetchRaw still returns assets for a normal populated response', async () => {
  const data = {
    success: 1, total_inventory_count: 1,
    assets: [{ assetid: 'a1', classid: 'c', instanceid: 'i', amount: '1', appid: 730, contextid: '2' }],
    descriptions: [{ classid: 'c', instanceid: 'i', market_hash_name: 'AK-47 | Redline (Field-Tested)' }],
  };
  const restore = installAxiosMock(async () => ({ status: 200, data }));
  try {
    const raw = await InventoryManager.fetchRaw(fakeSession(), 'cs2', 2);
    assert.equal(raw.assets.length, 1);
  } finally { restore(); }
});
