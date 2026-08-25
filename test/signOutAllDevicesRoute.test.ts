import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  POST /api/steam/:username/signout-all-devices — the route-level contract.
//
//  The claim that matters most is the REFUSAL. Steam's "sign out of all devices" revokes every
//  refresh token on the account. For a token-only (QR/token-imported, maFile-less) account that
//  token is the SOLE credential (INV-A2), so running this would lock SSIM out of the account
//  permanently, with no way back. It is therefore fail-closed on the SERVER, not merely a disabled
//  button — a hand-rolled request must hit the same wall.
//
//  Note the shape of the bug this pins: `loadMaFile` THROWS for a missing maFile rather than
//  returning null, which is exactly the token-only case. A naive `if (!maFile)` check never fires
//  and the refusal escapes as a 500 with no explanation — while the operator's account is fine only
//  because the request happened to blow up before reaching Steam. The guard must return a 409 that
//  says WHY, and must never reach the store call.
//
//  The aftermath matters too: a revoked token must not be left in the store to fail later, and an
//  AMBIGUOUS answer gets the same cleanup as a confirmed one (the token is dead either way).
// ═════════════════════════════════════════════════════════════════════════════════════════════════

interface Recorder {
  deauthorized: string[];
  loggedOut: string[];
  tokensCleared: string[];
}

/** A REAL maFile on disk — loadMaFile resolves vault-then-disk and throws on anything it cannot
 *  parse, so "the account has a maFile" can only be staged by writing one. It must live in the
 *  maFiles dir: resolveMaFilePath deliberately keeps only the BASENAME (path-traversal guard), so an
 *  absolute path elsewhere resolves to a non-existent file. SSIM_HOME is the throwaway temp dir from
 *  test/_setup.cjs, so this writes nowhere real. shared_secret is the field the loader validates. */
const REAL_MAFILE = (() => {
  const { maFilesDir } = require('../src/utils/paths') as { maFilesDir: (f?: string) => string };
  const dir = maFilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = 'signout-test.maFile';
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ shared_secret: 'c2hhcmVk', identity_secret: 'aWRlbnQ=', account_name: 'bot' }));
  return name;
})();

function stubDeps(opts: {
  maFile?: 'present' | 'missing';
  password?: string;
  result?: { status: 'done' | 'ambiguous' | 'failed'; detail: string };
}): { deps: unknown; rec: Recorder } {
  const rec: Recorder = { deauthorized: [], loggedOut: [], tokensCleared: [] };
  const account = {
    username: 'bot',
    password: opts.password ?? 'pw',
    // loadMaFile resolves vault-then-disk; with no vault it reads this path and THROWS when absent —
    // which IS the token-only case the refusal guard is for.
    maFilePath: opts.maFile === 'present' ? REAL_MAFILE : 'definitely-missing.maFile',
  };
  const deps = {
    accounts: { get: (u: string) => (u === 'bot' ? account : undefined) },
    sessions: {
      logoutAccount: async (u: string) => { rec.loggedOut.push(u); },
      clearStoredRefreshToken: (u: string) => { rec.tokensCleared.push(u); },
    },
    store: {
      deauthorizeAllDevices: async (u: string) => {
        rec.deauthorized.push(u);
        return opts.result ?? { status: 'done' as const, detail: 'ok' };
      },
    },
    trades: {}, inventory: { getCached: () => undefined },
  };
  return { deps, rec };
}

async function withServer(deps: unknown, fn: (port: number, cap: string) => Promise<void>): Promise<void> {
  const { createApp } = await import('../src/api/server');
  const { getCapabilityToken } = await import('../src/api/capability');
  const app = createApp(deps as Parameters<typeof createApp>[0]);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try { await fn((server.address() as AddressInfo).port, getCapabilityToken()); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

function post(port: number, cap: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { Host: 'localhost', Origin: 'http://localhost', 'X-SSIM-Cap': cap, 'Content-Type': 'application/json' }, timeout: 4000 },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, json: b ? JSON.parse(b) : {} })); },
    );
    req.on('error', reject);
    req.end();
  });
}

const ROUTE = '/api/steam/bot/signout-all-devices';

test('a TOKEN-ONLY account (no maFile) is refused 409 and never reaches Steam', async () => {
  const { deps, rec } = stubDeps({ maFile: 'missing' });
  await withServer(deps, async (port, cap) => {
    const r = await post(port, cap, ROUTE);
    assert.equal(r.status, 409, 'a missing maFile must be a refusal, NOT a 500 from loadMaFile throwing');
    assert.match(String(r.json.error), /credential fallback/i, 'the reason is stated');
    assert.match(String(r.json.error), /cannot be undone/i, 'and its irreversibility');
  });
  assert.deepEqual(rec.deauthorized, [], 'Steam was never called');
  assert.deepEqual(rec.tokensCleared, [], 'and the sole credential was never touched');
});

test('a PASSWORD-LESS account is refused too (both halves of the fallback are required)', async () => {
  const { deps, rec } = stubDeps({ maFile: 'present', password: '' });
  await withServer(deps, async (port, cap) => {
    assert.equal((await post(port, cap, ROUTE)).status, 409);
  });
  assert.deepEqual(rec.deauthorized, [], 'no maFile-without-password account is signed out either');
});

test('an unknown account is a 404, not a refusal', async () => {
  const { deps } = stubDeps({ maFile: 'present' });
  await withServer(deps, async (port, cap) => {
    assert.equal((await post(port, cap, '/api/steam/nobody/signout-all-devices')).status, 404);
  });
});

test('the route is capability-guarded — no token, no sign-out', async () => {
  const { deps, rec } = stubDeps({ maFile: 'present' });
  await withServer(deps, async (port) => {
    const r = await post(port, 'not-the-real-token', ROUTE);
    assert.equal(r.status, 401, 'a forged capability token is rejected');
  });
  assert.deepEqual(rec.deauthorized, [], 'and Steam was never called');
});

test('a FAILED deauthorize is a 502 and leaves the stored token ALONE', async () => {
  const { deps, rec } = stubDeps({ maFile: 'present', result: { status: 'failed', detail: 'HTTP 403' } });
  await withServer(deps, async (port, cap) => {
    const r = await post(port, cap, ROUTE);
    assert.equal(r.status, 502);
    assert.equal(r.json.status, 'failed');
    assert.match(String(r.json.detail), /403/);
  });
  assert.deepEqual(rec.tokensCleared, [], 'nothing was revoked, so the working token must survive');
  assert.deepEqual(rec.loggedOut, [], 'and the live session is left running');
});

test('an AMBIGUOUS outcome still clears the token — it is dead either way', async () => {
  const { deps, rec } = stubDeps({ maFile: 'present', result: { status: 'ambiguous', detail: 'page instead of confirmation' } });
  await withServer(deps, async (port, cap) => {
    const r = await post(port, cap, ROUTE);
    assert.equal(r.status, 200, 'ambiguous is an outcome to report, not an error to throw');
    assert.equal(r.json.status, 'ambiguous', 'and it is reported honestly, never as done');
  });
  assert.deepEqual(rec.loggedOut, ['bot'], 'the possibly-dead session is dropped');
  assert.deepEqual(rec.tokensCleared, ['bot'], 'and the possibly-revoked token cleared, so the next login is clean');
});
