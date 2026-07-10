import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';

// ─── The SDA confirmations routes must not report a Steam RATE-LIMIT as a 502 ────────────────────
// Steam's mobileconf 429 arrives as a message ("HTTP error 429") / err.code — never as `err.status` —
// so the generic csErr mapper missed it and every rate-limit surfaced as a "gateway" failure, with no
// hint that it clears on its own. The SDA panel then dead-ended on a Refresh button that could not win.

function stubDeps(thrown: Error) {
  const accounts = { get: (u: string) => (u === 'bot' ? { username: 'bot' } : undefined) };
  const trades = { ensureWebSession: async () => { throw thrown; } };
  return { accounts, trades, sessions: {}, inventory: { getCached: () => undefined } };
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

function get(port: number, cap: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: 'localhost', Origin: 'http://localhost', 'X-SSIM-Cap': cap }, timeout: 4000 },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, json: b ? JSON.parse(b) : {} })); },
    );
    req.on('error', reject);
    req.end();
  });
}

test('H-API-010: a Steam 429 on the confirmations route surfaces as 429 + Retry-After, not 502', async () => {
  await withServer(stubDeps(new Error('HTTP error 429')), async (port, cap) => {
    const r = await get(port, cap, '/api/accounts/bot/confirmations');
    assert.equal(r.status, 429, 'a rate-limit is not a gateway failure');
    assert.equal(r.headers['retry-after'], '60');
    assert.equal(r.json.rateLimited, true);
    assert.equal(r.json.retryAfterSeconds, 60);
    assert.match(String(r.json.error), /temporarily limited|rate.?limit/i, 'names it as a Steam rate-limit');
    assert.match(String(r.json.error), /clears|left alone/i, 'tells the operator it self-heals when left alone (not their fault)');
  });
});

test('H-API-010: the prose forms of a rate-limit are recognised too', async () => {
  for (const msg of ['Too Many Requests', 'rate limited by steam', 'rate-limit exceeded']) {
    await withServer(stubDeps(new Error(msg)), async (port, cap) => {
      assert.equal((await get(port, cap, '/api/accounts/bot/confirmations')).status, 429, `"${msg}" must map to 429`);
    });
  }
});

test('H-API-010: a genuine upstream failure is still a 502 (no over-mapping)', async () => {
  await withServer(stubDeps(new Error('HTTP error 500')), async (port, cap) => {
    const r = await get(port, cap, '/api/accounts/bot/confirmations');
    assert.equal(r.status, 502);
    assert.match(String(r.json.error), /could not load confirmations/);
  });
});

test('H-API-010: an unrelated error message containing 1429 is NOT a rate-limit', async () => {
  // errorClass anchors on a bare \b429\b — a listing id or asset id must not trip the mapper.
  await withServer(stubDeps(new Error('listing 1429 not found')), async (port, cap) => {
    assert.equal((await get(port, cap, '/api/accounts/bot/confirmations')).status, 502);
  });
});

test('H-API-010: an unknown account still 404s before any Steam call', async () => {
  await withServer(stubDeps(new Error('HTTP error 429')), async (port, cap) => {
    assert.equal((await get(port, cap, '/api/accounts/ghost/confirmations')).status, 404);
  });
});
