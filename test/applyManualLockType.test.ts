import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';

// ─── H-API-003: applyManualLock must store a real Date, not an ISO string ──────
// InventoryItem.tradeLockExpiry is declared `Date | null` and the canonical producer
// (parseTradeLock) returns a real Date. The manual-protection overlay previously wrote an
// ISO string via `as unknown as Date`, so the field held a Date for organically-locked items
// and a string for manually-protected ones — a runtime type the declaration lies about, and a
// throw for any direct-method reader (e.g. InventoryManager.stack's `.toISOString()`).
// After the fix the field is a Date object as its type promises. GET /api/inventory runs the
// enrich+overlay path in place on the object allCs2() returns, so the test inspects that same
// reference and sees the true JS type (HTTP JSON would coerce both to a string and hide it).

type Item = { tradeLockExpiry: Date | null };
type Inv = { username: string; source: string; items: Item[] };

function stubDeps(all: Record<string, Inv>, protectedUntil: string) {
  const accounts = { get: (u: string) => (all[u] ? { username: u, protectedUntil } : undefined) };
  const pricing = { enrich: (_inv: Inv) => [] as unknown[], ensureFilled: (_m: unknown[]) => {} };
  const inventory = { allCs2: () => all };
  return { accounts, pricing, inventory };
}

async function withServer(
  deps: ReturnType<typeof stubDeps>,
  fn: (port: number, cap: string) => Promise<void>,
): Promise<void> {
  const { createApp } = await import('../src/api/server');
  const { getCapabilityToken } = await import('../src/api/capability');
  const app = createApp(deps as unknown as Parameters<typeof createApp>[0]);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn((server.address() as AddressInfo).port, getCapabilityToken());
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function getInventory(port: number, cap: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/inventory', method: 'GET',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost', 'X-SSIM-Cap': cap }, timeout: 4000,
      },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode || 0)); },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

test('H-API-003: manual protection overlays a real Date object, not an ISO string', async () => {
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const all: Record<string, Inv> = { bot: { username: 'bot', source: 'web', items: [{ tradeLockExpiry: null }] } };
  await withServer(stubDeps(all, future), async (port, cap) => {
    const status = await getInventory(port, cap);
    assert.equal(status, 200);
    const expiry = all.bot.items[0].tradeLockExpiry;
    assert.ok(expiry instanceof Date, 'tradeLockExpiry must be a Date, not the old `as unknown as Date` string');
    assert.equal(expiry.getTime(), Date.parse(future), 'the Date encodes the same instant as protectedUntil');
  });
});
