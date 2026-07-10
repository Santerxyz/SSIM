import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { PAYSAFE_MIN_MINOR, PAYSAFE_MAX_MINOR } from '../src/store/PaysafeService';

// ─── The paysafecard HTTP boundary ───────────────────────────────────────────────────────────────
// A hand-rolled request must not be able to do what the UI forbids: no unbounded amount, no fractional
// euro-cents, and NO silently-dropped accounts on a money route. These are the checks that stand between
// `curl` and a €50 000 checkout.

interface Started { usernames: string[]; amountMinor: number }

function stubDeps(started: Started[]) {
  const known = new Set(['bot', 'bot2']);
  const accounts = { get: (u: string) => (known.has(String(u).toLowerCase()) ? { username: String(u).toLowerCase() } : undefined) };
  const paysafe = {
    // Record what actually reached the service; echo a minimal session back.
    startBatch: async (usernames: string[], amountMinor: number) => { started.push({ usernames, amountMinor }); return { running: true, amountMinor, queue: usernames }; },
    openOne: async (username: string, amountMinor: number) => { started.push({ usernames: [username], amountMinor }); return { running: true, amountMinor, queue: [username] }; },
    status: () => null,
    verifyOne: async () => ({ running: false }),
    advance: async () => ({ running: false }),
    stop: async () => ({ running: false }),
  };
  return { accounts, paysafe, sessions: {}, inventory: { getCached: () => undefined } };
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

function post(port: number, cap: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Host': 'localhost', 'Origin': 'http://localhost', 'X-SSIM-Cap': cap, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 4000 },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, json: b ? JSON.parse(b) : {} })); },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('H-PSR-001: the amount ceiling is enforced at the HTTP boundary, not just in the UI', async () => {
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    const r = await post(port, cap, '/api/steam/paysafe/batch/start', { usernames: ['bot'], amountMinor: PAYSAFE_MAX_MINOR + 1 });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /maximum top-up/);
  });
  assert.deepEqual(started, []);   // nothing reached the service
});

test('H-PSR-002: the amount floor is enforced at the HTTP boundary', async () => {
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    const r = await post(port, cap, '/api/steam/paysafe/batch/start', { usernames: ['bot'], amountMinor: PAYSAFE_MIN_MINOR - 1 });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /minimum top-up/);
  });
  assert.deepEqual(started, []);
});

test('H-PSR-003: fractional / NaN / missing / string amounts are refused', async () => {
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    for (const amountMinor of [500.5, 'lots', null, undefined, Infinity, -500]) {
      const r = await post(port, cap, '/api/steam/paysafe/batch/start', { usernames: ['bot'], amountMinor });
      assert.equal(r.status, 400, `amountMinor=${String(amountMinor)} should be refused`);
    }
  });
  assert.deepEqual(started, []);
});

test('H-PSR-004: a money route NEVER silently drops an unknown account — it refuses the whole run', async () => {
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    const r = await post(port, cap, '/api/steam/paysafe/batch/start', { usernames: ['bot', 'ghost'], amountMinor: 500 });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /unknown account\(s\).*ghost/);
  });
  assert.deepEqual(started, []);   // 'bot' was NOT topped up on its own
});

test('H-PSR-005: a valid batch reaches the service with the exact euro-cent amount', async () => {
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    const r = await post(port, cap, '/api/steam/paysafe/batch/start', { usernames: ['bot', 'bot2'], amountMinor: 500 });
    assert.equal(r.status, 200);
  });
  assert.deepEqual(started, [{ usernames: ['bot', 'bot2'], amountMinor: 500 }]);
});

test('H-PSR-006: the single-account open route applies the same bounds', async () => {
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    assert.equal((await post(port, cap, '/api/steam/bot/paysafe/open', { amountMinor: PAYSAFE_MAX_MINOR + 1 })).status, 400);
    assert.equal((await post(port, cap, '/api/steam/bot/paysafe/open', { amountMinor: 50 })).status, 400);
    assert.equal((await post(port, cap, '/api/steam/ghost/paysafe/open', { amountMinor: 500 })).status, 404);
    assert.equal((await post(port, cap, '/api/steam/bot/paysafe/open', { amountMinor: 500 })).status, 200);
  });
  assert.deepEqual(started, [{ usernames: ['bot'], amountMinor: 500 }]);
});

test('H-PSR-007: no `currency` is accepted from the client — the amount is always euro-cents', async () => {
  // A client cannot re-open the FX hole by declaring a currency; the server neither reads nor honours one.
  const started: Started[] = [];
  await withServer(stubDeps(started), async (port, cap) => {
    const r = await post(port, cap, '/api/steam/paysafe/batch/start', { usernames: ['bot'], amountMinor: 500, currency: 8 });
    assert.equal(r.status, 200);
  });
  assert.deepEqual(started, [{ usernames: ['bot'], amountMinor: 500 }]);   // currency ignored entirely
});
