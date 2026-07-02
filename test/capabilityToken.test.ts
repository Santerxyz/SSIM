import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCapabilityToken, verifyCapability, isProtectedRequest,
  capabilityGuard, injectCapabilityIntoHtml,
} from '../src/api/capability';

// ─── B26/P5: capability token authenticates the dashboard to the backend ───────

test('the token is a stable 32-byte hex per run', () => {
  const t = getCapabilityToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(getCapabilityToken(), t, 'stable within a run');
});

test('verifyCapability: constant-time exact match only', () => {
  const t = getCapabilityToken();
  assert.equal(verifyCapability(t), true);
  assert.equal(verifyCapability(t + 'x'), false, 'length mismatch rejected');
  const flipped = t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'); // guaranteed one char off
  assert.equal(verifyCapability(flipped), false, 'one char off rejected');
  assert.equal(verifyCapability(''), false);
  assert.equal(verifyCapability(undefined), false);
  assert.equal(verifyCapability(123 as unknown as string), false);
});

test('isProtectedRequest: every mutation + secret GET is protected; reads are open', () => {
  // Mutations to /api/* → protected
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(isProtectedRequest(m, '/api/market/buy'), `${m} money route protected`);
    assert.ok(isProtectedRequest(m, '/api/accounts/x'), `${m} account route protected`);
  }
  // Secret GETs → protected
  assert.ok(isProtectedRequest('GET', '/api/accounts/alice/proxy'));
  assert.ok(isProtectedRequest('GET', '/api/accounts/alice/otp'));
  assert.ok(isProtectedRequest('GET', '/api/environments/e1/proxy'));
  // Plain reads → open (initial load, SSE, static must work without the token)
  assert.equal(isProtectedRequest('GET', '/api/inventories/alice'), false);
  assert.equal(isProtectedRequest('GET', '/api/logs/stream'), false);
  assert.equal(isProtectedRequest('GET', '/api/system/status'), false);
  assert.equal(isProtectedRequest('GET', '/index.html'), false);
  assert.equal(isProtectedRequest('POST', '/not-api/x'), false, 'non-/api ignored');
});

function runGuard(method: string, urlPath: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  let statusCode = 0; let body: unknown; let nexted = false;
  const req = {
    method, path: urlPath, query,
    get: (h: string) => headers[h.toLowerCase()],
  };
  const res = {
    status(c: number) { statusCode = c; return this; },
    json(b: unknown) { body = b; return this; },
  };
  capabilityGuard(req as never, res as never, () => { nexted = true; });
  return { statusCode, body, nexted };
}

test('capabilityGuard: a protected request WITHOUT the token is 401', () => {
  const r = runGuard('POST', '/api/market/buy');
  assert.equal(r.nexted, false);
  assert.equal(r.statusCode, 401);
  assert.equal((r.body as { capabilityRequired?: boolean }).capabilityRequired, true);
});

test('capabilityGuard: a forged Origin cannot substitute for the token (still 401)', () => {
  const r = runGuard('POST', '/api/trade/send', { origin: 'http://127.0.0.1:1234' });
  assert.equal(r.statusCode, 401, 'the token is required regardless of Origin');
});

test('capabilityGuard: the correct token in the header passes', () => {
  const r = runGuard('POST', '/api/market/buy', { 'x-ssim-cap': getCapabilityToken() });
  assert.equal(r.nexted, true);
  assert.equal(r.statusCode, 0);
});

test('capabilityGuard: the token via ?cap= query works (for EventSource-style callers)', () => {
  const r = runGuard('GET', '/api/accounts/alice/otp', {}, { cap: getCapabilityToken() });
  assert.equal(r.nexted, true);
});

test('capabilityGuard: an open read passes with no token', () => {
  const r = runGuard('GET', '/api/inventories/alice');
  assert.equal(r.nexted, true);
});

test('injectCapabilityIntoHtml: seeds window.__SSIM_CAP__ before </head>', () => {
  const out = injectCapabilityIntoHtml('<html><head><title>x</title></head><body></body></html>');
  assert.match(out, /window\.__SSIM_CAP__=/);
  assert.ok(out.indexOf('window.__SSIM_CAP__') < out.indexOf('</head>'), 'injected inside <head>');
  assert.ok(out.includes(getCapabilityToken()));
});
