import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';

// ─── H-API-001: GET /api/accounts/:u/wallet must honour the balance tri-state ──
// A live session that fired a wallet event is authoritative even when EMPTY: a refreshed-empty
// wallet (hasWallet=false, balance=0) must be reported as source:'session' with balance 0, NOT
// discarded in favour of a possibly-stale funded cache. Only a never-refreshed account (no
// session wallet) falls back to cache, then to null. (DIRECTIVES #2.)

type Sess = { wallet?: { hasWallet: boolean; currency: number; balance: number } } | undefined;
type Inv = { wallet?: { currency: number; balance: number } } | undefined;

function stubDeps(opts: { sess: Sess; cs2?: Inv; tf2?: Inv }) {
  const accounts = { get: (u: string) => (u === 'bot' ? { username: 'bot' } : undefined) };
  const sessions = { getSession: (_u: string) => opts.sess };
  const inventory = { getCached: (_u: string, game: string) => (game === 'cs2' ? opts.cs2 : opts.tf2) };
  return { accounts, sessions, inventory };
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

function getWallet(port: number, cap: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/accounts/bot/wallet', method: 'GET',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost', 'X-SSIM-Cap': cap }, timeout: 4000,
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, json: b ? JSON.parse(b) : {} })); },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

test('H-API-001: a live refreshed-EMPTY session beats a stale funded cache (source=session, balance=0)', async () => {
  const deps = stubDeps({ sess: { wallet: { hasWallet: false, currency: 3, balance: 0 } }, cs2: { wallet: { currency: 3, balance: 5000 } } });
  await withServer(deps, async (port, cap) => {
    const { json } = await getWallet(port, cap);
    const wallet = json.wallet as { currency: number; balance: number };
    assert.equal(json.source, 'session', 'a live session is authoritative even when empty');
    assert.equal(wallet.balance, 0, 'refreshed-empty surfaces a real 0, not the stale funded 5000');
    assert.equal(wallet.currency, 3);
  });
});

test('H-API-001: a live FUNDED session reports its own balance (source=session)', async () => {
  const deps = stubDeps({ sess: { wallet: { hasWallet: true, currency: 3, balance: 4200 } }, cs2: { wallet: { currency: 3, balance: 5000 } } });
  await withServer(deps, async (port, cap) => {
    const { json } = await getWallet(port, cap);
    assert.equal(json.source, 'session');
    assert.equal((json.wallet as { balance: number }).balance, 4200);
  });
});

test('H-API-001: no session wallet → falls back to cache (source=cache)', async () => {
  const deps = stubDeps({ sess: { wallet: undefined }, cs2: { wallet: { currency: 3, balance: 5000 } } });
  await withServer(deps, async (port, cap) => {
    const { json } = await getWallet(port, cap);
    assert.equal(json.source, 'cache');
    assert.equal((json.wallet as { balance: number }).balance, 5000);
  });
});

test('H-API-001: never-refreshed, no cache → wallet null, source none', async () => {
  const deps = stubDeps({ sess: undefined });
  await withServer(deps, async (port, cap) => {
    const { json } = await getWallet(port, cap);
    assert.equal(json.wallet, null);
    assert.equal(json.source, 'none');
  });
});
