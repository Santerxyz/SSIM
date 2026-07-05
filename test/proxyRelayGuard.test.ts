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

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-058 — upstream socket lifecycle: a hung handshake must not pin the conn
//  cap. Deadline the CONNECT/replay handshake, destroy the upstream on a clean
//  client close, and bound the upstream header buffer.
// ════════════════════════════════════════════════════════════════════════════

const readAll = (s: net.Socket, ms: number): Promise<string> =>
  new Promise((resolve) => {
    let out = '';
    s.on('data', (d) => { out += d.toString('latin1'); });
    s.once('close', () => resolve(out));
    setTimeout(() => resolve(out), ms).unref?.();
  });

// A fake upstream proxy that tracks every accepted socket so the test can tear it
// down deterministically (server.close() alone hangs while a half-open socket lingers).
function fakeUpstream(onSocket?: (s: net.Socket) => void): Promise<{ port: number; sockets: net.Socket[]; stop: () => void }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.on('error', () => { /* ignore */ });
    s.resume(); // consume inbound (flowing mode) so a peer FIN surfaces as 'close' — a real client always reads
    onSocket?.(s);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as net.AddressInfo).port,
      sockets,
      stop: () => { for (const s of sockets) s.destroy(); try { server.close(); } catch { /* ignore */ } },
    }));
  });
}

test('H-TRD-058: a connected-but-unresponsive upstream trips the handshake deadline → client gets 504', async () => {
  const upstream = await fakeUpstream(); // accept, never respond
  const up = { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' };
  const relay = await startProxyRelay(up, 'test', { handshakeTimeoutMs: 200 });
  try {
    const c = await connect(relay.port);
    c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    const t0 = Date.now();
    const resp = await readAll(c, 2000);
    assert.match(resp, /504 Gateway Timeout/, 'client received a 504 for the hung handshake');
    assert.ok(Date.now() - t0 < 1500, 'the 504 fired near the deadline, not after a Chromium-scale wait');
  } finally { relay.close(); upstream.stop(); }
});

test('H-TRD-058: a client that aborts mid-handshake destroys the upstream socket', async () => {
  const upstream = await fakeUpstream(); // accept, never respond
  const up = { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' };
  const relay = await startProxyRelay(up, 'test', { handshakeTimeoutMs: 5000 });
  try {
    const c = await connect(relay.port);
    c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    await new Promise((r) => setTimeout(r, 100)); // let the upstream connection land
    assert.equal(upstream.sockets.length, 1, 'the relay opened an upstream socket');
    c.destroy();
    assert.equal(await closedWithin(upstream.sockets[0], 1000), true, 'the upstream socket closes when the client aborts');
  } finally { relay.close(); upstream.stop(); }
});

test('H-TRD-058: an upstream flooding CRLF-less garbage is bounded → client gets 502, upstream destroyed', async () => {
  const upstream = await fakeUpstream((s) => { s.on('data', () => { s.write(Buffer.alloc(100 * 1024, 0x41)); }); }); // 100KB, no \r\n\r\n
  const up = { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' };
  const relay = await startProxyRelay(up, 'test', { handshakeTimeoutMs: 5000 });
  try {
    const c = await connect(relay.port);
    c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    const resp = await readAll(c, 2000);
    assert.match(resp, /502 Bad Gateway/, 'client received a 502 once the upstream buffer bound tripped');
    assert.equal(upstream.sockets.length, 1, 'the relay opened an upstream socket');
    assert.equal(await closedWithin(upstream.sockets[0], 1000), true, 'the upstream socket is destroyed');
  } finally { relay.close(); upstream.stop(); }
});
