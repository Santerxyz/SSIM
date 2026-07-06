import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
//  H-ACC-093 — the PATCH /api/accounts/:username edit path must mirror the
//  attach-mafile invariant bundle on its own (second) write path (INV-A1 / C5):
//   (a) a LIMITED account that gains an identity_secret-bearing maFile flips to
//       tier 'full' → the auto-accept gate no longer rejects it as limited;
//   (b) a maFile edit on an account with a live session logs that session out
//       once (a resident session loads its maFile ONCE at login);
//   (c) a typo'd/invalid maFile filename 400s BEFORE any state is persisted.
//
//  We stand up the REAL createApp route with a stubbed ApiDeps (mirroring
//  tradeSendRouteClassify.test.ts). Fixture maFiles are written into the resolved
//  maFilesDir() (test/_setup.cjs already pins SSIM_HOME at a throwaway temp home),
//  so loadMaFileFromDisk reads them from the real drop-zone path.
// ─────────────────────────────────────────────────────────────────────────────

const FULL_MAFILE = 'good.maFile'; // CAN confirm (identity_secret present) → upgrades LIMITED → FULL
const NOID_MAFILE = 'noid.maFile'; // valid, but no identity_secret → must NOT flip the tier

before(async () => {
  const { maFilesDir } = await import('../src/utils/paths');
  const dir = maFilesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FULL_MAFILE), JSON.stringify({ account_name: 'bot', shared_secret: 'c25vdw==', identity_secret: 'aWRlbnQ=' }));
  fs.writeFileSync(path.join(dir, NOID_MAFILE), JSON.stringify({ account_name: 'bot', shared_secret: 'c25vdw==' }));
});

type Account = { username: string; tier?: 'limited' | 'full'; maFilePath?: string; addedAt: string };

/** A createApp deps object stubbed to just what PATCH /api/accounts + the auto-accept gate touch. */
function stubDeps(store: { account: Account; logouts: string[] }) {
  const accounts = {
    get: (u: string) => (u === store.account.username ? { ...store.account, network: undefined } : undefined),
    update: (u: string, changes: Partial<Account>) => {
      if (u !== store.account.username) throw new Error('not found');
      Object.assign(store.account, changes);
      return { ...store.account, network: undefined };
    },
  };
  const sessions = {
    logoutAccount: async (u: string) => { store.logouts.push(u); },
  };
  const csfloat = {
    getAutoAccept: () => false,
    setAutoAccept: () => true, // boolean contract (H-BOOT-013): true = saved OK; a falsy return now 500s
    invalidateClient: () => undefined,
  };
  return { accounts, sessions, csfloat };
}

async function withServer(
  store: { account: Account; logouts: string[] },
  fn: (port: number, cap: string) => Promise<void>,
): Promise<void> {
  const { createApp } = await import('../src/api/server');
  const { getCapabilityToken } = await import('../src/api/capability');
  const app = createApp(stubDeps(store) as unknown as Parameters<typeof createApp>[0]);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn((server.address() as AddressInfo).port, getCapabilityToken());
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function request(
  port: number, cap: string, method: string, urlPath: string, body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: urlPath, method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Host': 'localhost',
          'Origin': 'http://localhost',
          'X-SSIM-Cap': cap,
        },
        timeout: 4000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, json: buf ? JSON.parse(buf) : {} }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

test('H-ACC-093 (a): a limited account gains an identity_secret maFile → tier flips to full, auto-accept no longer 400s', async () => {
  const { AppSettings } = await import('../src/core/AppSettings');
  AppSettings.setCsfloatExperimental(true); // the auto-accept route is gated behind the experimental flag
  const store = { account: { username: 'lim', tier: 'limited' as const, addedAt: 'x' }, logouts: [] as string[] };
  await withServer(store, async (port, cap) => {
    const patch = await request(port, cap, 'PATCH', '/api/accounts/lim', { maFilePath: FULL_MAFILE });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.tier, 'full', 'a confirming maFile upgrades LIMITED → FULL on the edit path');
    assert.equal(store.account.tier, 'full', 'the flip is persisted via accounts.update');

    const put = await request(port, cap, 'PUT', '/api/csfloat/lim/auto-accept', { enabled: true });
    assert.equal(put.status, 200, 'no longer rejected as a limited account (the stale-label exclusion is gone)');
  });
});

test('H-ACC-093 (a2): a maFile with NO identity_secret is accepted but does NOT flip the tier', async () => {
  const store = { account: { username: 'lim2', tier: 'limited' as const, addedAt: 'x' }, logouts: [] as string[] };
  await withServer(store, async (port, cap) => {
    const patch = await request(port, cap, 'PATCH', '/api/accounts/lim2', { maFilePath: NOID_MAFILE });
    assert.equal(patch.status, 200, 'PATCH may replace a shared_secret-only maFile (unlike attach-mafile)');
    assert.equal(patch.json.tier, 'limited', 'no identity_secret → the tier stays limited');
  });
});

test('H-ACC-093 (b): a maFile edit on a resident session logs that session out exactly once', async () => {
  const store = { account: { username: 'res', tier: 'full' as const, maFilePath: 'old.maFile', addedAt: 'x' }, logouts: [] as string[] };
  await withServer(store, async (port, cap) => {
    const patch = await request(port, cap, 'PATCH', '/api/accounts/res', { maFilePath: FULL_MAFILE });
    assert.equal(patch.status, 200);
    assert.deepEqual(store.logouts, ['res'], 'a maFile change drops the stale live session (INV-A1 / C5)');
  });
});

test('H-ACC-093 (b2): a no-op maFile PATCH (same filename) does NOT churn the live session', async () => {
  const store = { account: { username: 'noop', tier: 'full' as const, maFilePath: FULL_MAFILE, addedAt: 'x' }, logouts: [] as string[] };
  await withServer(store, async (port, cap) => {
    const patch = await request(port, cap, 'PATCH', '/api/accounts/noop', { maFilePath: FULL_MAFILE });
    assert.equal(patch.status, 200);
    assert.deepEqual(store.logouts, [], 'resending the unchanged maFilePath must not re-login the account');
  });
});

test('H-ACC-093 (c): a typo\'d maFile filename 400s BEFORE any state is persisted', async () => {
  const store = { account: { username: 'typo', tier: 'limited' as const, maFilePath: 'prev.maFile', addedAt: 'x' }, logouts: [] as string[] };
  await withServer(store, async (port, cap) => {
    const patch = await request(port, cap, 'PATCH', '/api/accounts/typo', { maFilePath: 'nope.maFile' });
    assert.equal(patch.status, 400, 'the invalid filename is rejected at edit time (validate-first)');
    assert.match(String(patch.json.error), /maFile/);
    assert.equal(store.account.maFilePath, 'prev.maFile', 'nothing was persisted — the account is unchanged');
    assert.equal(store.account.tier, 'limited', 'no tier flip on a rejected edit');
    assert.deepEqual(store.logouts, [], 'no session churn on a rejected edit');
  });
});
