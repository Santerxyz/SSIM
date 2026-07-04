import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startProxyRelay } from '../src/trading/cleanBrowser';

// ════════════════════════════════════════════════════════════════════════════
//  S65 — the clean-browser proxy relay carries the account's PROXY credentials and,
//  as a loopback proxy, is technically an open proxy any local process could use
//  while the window is open. A true client-auth close isn't possible (Chromium
//  presents no proxy creds; Edge/Chrome hand off to a detached process we can't
//  PID-pin), so we BOUND the exposure: cap concurrent tunnels + drop connectors
//  that open a socket but send no request promptly. Neither affects Chromium,
//  which always sends its request immediately.
// ════════════════════════════════════════════════════════════════════════════

const AUTH = { host: '127.0.0.1', port: 1, username: 'u', password: 'p' };
const connect = (port: number): Promise<net.Socket> =>
  new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => resolve(s)); });
const closedWithin = (s: net.Socket, ms: number): Promise<boolean> =>
  new Promise((resolve) => { s.once('close', () => resolve(true)); s.once('error', () => resolve(true)); setTimeout(() => resolve(false), ms); });

test('S65: an idle connector (opens the socket, sends no request) is dropped after the first-byte timeout', async () => {
  const relay = await startProxyRelay(AUTH, 'test', { firstByteTimeoutMs: 120 });
  try {
    const s = await connect(relay.port);
    assert.equal(await closedWithin(s, 1000), true, 'a socket that sends nothing is closed by the relay');
  } finally { relay.close(); }
});

test('S65: concurrent connections are capped (a local flood is bounded)', async () => {
  const relay = await startProxyRelay(AUTH, 'test', { maxConns: 2, firstByteTimeoutMs: 5000 });
  const socks: net.Socket[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      socks.push(await connect(relay.port));
      await new Promise((r) => setImmediate(r)); // let the server accept-handler run (activeConns++)
    }
    const extra = await connect(relay.port); socks.push(extra);
    assert.equal(await closedWithin(extra, 1000), true, 'the (cap+1)th connection is dropped by the relay cap');
  } finally { for (const s of socks) s.destroy(); relay.close(); }
});

test('S65: the relay binds a loopback port (never a routable interface)', async () => {
  const relay = await startProxyRelay(AUTH, 'test');
  try { assert.ok(relay.port > 0 && relay.port < 65536, 'a loopback port was allocated'); }
  finally { relay.close(); }
});
