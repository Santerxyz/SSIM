import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  listenAndAnnounce, boundUiPort, _resetForTest,
  SSIM_HEALTH_PATH, SSIM_HEALTH_MARKER,
} from '../src/utils/serverPort';

const addrPort = (s: http.Server): number => (s.address() as AddressInfo).port;
const listen = (s: http.Server): Promise<void> => new Promise((r) => s.listen(0, '127.0.0.1', () => r()));
const close = (s: http.Server): Promise<void> => new Promise((r) => s.close(() => r()));

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

// ─── BUG 2 (backend): announce ONLY a port this process actually bound ─────────

test('listenAndAnnounce: nothing is announced until the bind succeeds; announced == bound', async () => {
  _resetForTest();
  assert.equal(boundUiPort(), undefined, 'no port announced before any bind');
  const server = http.createServer((_q, r) => r.end());
  try {
    const bound = await listenAndAnnounce(server, '127.0.0.1', 0); // 0 → OS assigns a free port
    const actual = addrPort(server);
    assert.equal(bound, actual, 'the resolved port is the ACTUAL bound port');
    assert.equal(boundUiPort(), actual, 'the announced port is the bound port (only set after bind)');
  } finally { await close(server); }
});

test('listenAndAnnounce: walks past an OCCUPIED port and announces the bound one, never the occupied', async () => {
  _resetForTest();
  // A foreign app already holds the "desired" port.
  const foreign = http.createServer((_q, r) => r.end('not ssim'));
  await listen(foreign);
  const occupied = addrPort(foreign);

  const server = http.createServer((_q, r) => r.end());
  try {
    const bound = await listenAndAnnounce(server, '127.0.0.1', occupied); // desired == the occupied port
    assert.notEqual(bound, occupied, 'must NOT announce the occupied (foreign) port');
    assert.equal(bound, addrPort(server), 'announced port == the port this process actually bound');
    assert.equal(boundUiPort(), bound);
  } finally { await close(server); await close(foreign); }
});

test('listenAndAnnounce: a re-bind (portal → full app) reuses the SAME announced port', async () => {
  _resetForTest();
  const first = http.createServer((_q, r) => r.end());
  const bound1 = await listenAndAnnounce(first, '127.0.0.1', 0);
  await close(first);                       // portal releases the port
  const second = http.createServer((_q, r) => r.end());
  try {
    const bound2 = await listenAndAnnounce(second, '127.0.0.1', 65000); // desired differs → but sticky wins
    assert.equal(bound2, bound1, 'the full app re-binds the SAME port the portal announced');
  } finally { await close(second); }
});

// ─── BUG 2 (shell distinguisher): the health marker separates SSIM from a foreign app ──

test('the SSIM health marker (200 + marker body) distinguishes SSIM from a foreign responder', async () => {
  // An SSIM server serves the marker at /__ssim/health (as createApp + the portals now do).
  const ssim = http.createServer((req, res) => {
    if (req.url === SSIM_HEALTH_PATH) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(SSIM_HEALTH_MARKER); }
    else { res.writeHead(404); res.end(); }
  });
  // A foreign app that merely accepts TCP and answers 200 for everything.
  const foreign = http.createServer((_req, res) => { res.writeHead(200); res.end('some other app on this port'); });
  await listen(ssim); await listen(foreign);

  // The shell's check: status 200 AND the marker present in the body.
  const isSsim = (r: { status: number; body: string }): boolean => r.status === 200 && r.body.includes(SSIM_HEALTH_MARKER);
  try {
    assert.equal(isSsim(await httpGet(addrPort(ssim), SSIM_HEALTH_PATH)), true, 'SSIM is recognised');
    assert.equal(isSsim(await httpGet(addrPort(foreign), SSIM_HEALTH_PATH)), false, 'a foreign responder is rejected');
  } finally { await close(ssim); await close(foreign); }
});
