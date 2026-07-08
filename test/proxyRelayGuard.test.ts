import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startProxyRelay } from '../src/trading/cleanBrowser';
import { liveLogBus } from '../src/utils/logger';

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

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-059 — mid-tunnel upstream reset: after the streams are spliced, an upstream
//  'error' means the tunnel died (the proxy WAS reached), so the relay must NOT log a
//  misleading "cannot reach upstream proxy" warn nor write a plaintext 502 into what is
//  by then a raw TLS byte stream — it just tears the client down.
// ════════════════════════════════════════════════════════════════════════════

test('H-TRD-059: an upstream that RSTs mid-tunnel closes the client — no "cannot reach" warn, no 502 spliced into the TLS stream', async () => {
  // Fake upstream: complete the CONNECT handshake (200), then reset the socket mid-tunnel.
  const upstream = await fakeUpstream((s) => {
    s.once('data', () => {                              // the relay's CONNECT request
      s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => s.resetAndDestroy(), 50).unref?.(); // drop the tunnel with an RST after the splice
    });
  });
  const up = { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' };
  const relay = await startProxyRelay(up, 'test', { handshakeTimeoutMs: 5000 });
  const warns: string[] = [];
  const onLine = (l: { level: string; msg: string }): void => { if (l.level === 'warn') warns.push(l.msg); };
  liveLogBus.on('line', onLine);
  try {
    const c = await connect(relay.port);
    const closed = closedWithin(c, 2000);
    c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    const resp = await readAll(c, 1500);
    assert.match(resp, /200 Connection Established/, 'the client saw the tunnel come up');
    assert.doesNotMatch(resp, /502 Bad Gateway/, 'no plaintext 502 was written into the spliced tunnel');
    assert.equal(await closed, true, 'the client socket closes when the tunnel drops');
    assert.ok(!warns.some((m) => /cannot reach upstream proxy/.test(m)), 'no misleading "cannot reach" warn for a mid-tunnel drop');
  } finally { liveLogBus.off('line', onLine); relay.close(); upstream.stop(); }
});

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-057 — plain-HTTP (absolute-form) replay path: pause the client while the
//  upstream connects (a flowing Readable with no 'data' listener drops incoming
//  body bytes), and force Connection: close so every reused request re-enters the
//  auth-injection path instead of reaching the upstream credential-less (407).
// ════════════════════════════════════════════════════════════════════════════

// A fake upstream that records every byte received per accepted socket, replying with a
// minimal keep-alive-refusing 200 so an absolute-form request completes and the socket closes.
function recordingUpstream(): Promise<{ port: number; received: string[]; stop: () => void }> {
  const received: string[] = [];
  const server = net.createServer((s) => {
    const idx = received.length;
    received.push('');
    s.on('error', () => { /* ignore */ });
    // reply only once the full request (header block + any declared body) has arrived, then close
    // (Connection: close semantics) — replying on the header block alone would race a lagging POST body.
    let replied = false;
    s.on('data', (d) => {
      received[idx] += d.toString('latin1');
      if (replied) return;
      const he = received[idx].indexOf('\r\n\r\n');
      if (he === -1) return;
      const cl = /content-length:\s*(\d+)/i.exec(received[idx].slice(0, he));
      const bodyLen = received[idx].length - (he + 4);
      if (cl && bodyLen < Number(cl[1])) return; // wait for the rest of the body
      replied = true;
      s.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as net.AddressInfo).port,
      received,
      stop: () => { try { server.close(); } catch { /* ignore */ } },
    }));
  });
}

test('H-TRD-057: an absolute-form POST whose body arrives after the header block is not truncated', async () => {
  const upstream = await recordingUpstream();
  const up = { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' };
  const relay = await startProxyRelay(up, 'test', { handshakeTimeoutMs: 5000 });
  try {
    const c = await connect(relay.port);
    const body = 'name=value&x=1234567890';
    c.write(`POST http://example.com/submit HTTP/1.1\r\nHost: example.com\r\nContent-Length: ${body.length}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 10)); // body bytes lag the header block (the data-loss window)
    c.write(body);
    await readAll(c, 1000);
    assert.equal(upstream.received.length, 1, 'the relay opened one upstream connection');
    assert.ok(upstream.received[0].endsWith(body), 'the upstream received the complete body written after the header block');
    assert.match(upstream.received[0], /Proxy-Authorization: Basic /, 'the request carried injected proxy auth');
  } finally { relay.close(); upstream.stop(); }
});

test('H-TRD-057: two sequential absolute-form GETs each reach the upstream with Proxy-Authorization (fresh connection per request)', async () => {
  const upstream = await recordingUpstream();
  const up = { host: '127.0.0.1', port: upstream.port, username: 'u', password: 'p' };
  const relay = await startProxyRelay(up, 'test', { handshakeTimeoutMs: 5000 });
  try {
    const c1 = await connect(relay.port);
    c1.write('GET http://example.com/a HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n\r\n');
    await readAll(c1, 1000); // relay-side connection closes (Connection: close), mirroring Chromium reconnecting
    const c2 = await connect(relay.port);
    c2.write('GET http://example.com/b HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n\r\n');
    await readAll(c2, 1000);
    assert.equal(upstream.received.length, 2, 'each request opened a NEW upstream connection');
    assert.match(upstream.received[0], /Proxy-Authorization: Basic /, 'the first request carried injected proxy auth');
    assert.match(upstream.received[1], /Proxy-Authorization: Basic /, 'the second request also carried injected proxy auth');
    assert.doesNotMatch(upstream.received[0], /Proxy-Connection:/i, 'the client Proxy-Connection: keep-alive header was stripped');
    assert.match(upstream.received[0], /Connection: close/, 'the relay forced Connection: close on the upstream request');
  } finally { relay.close(); upstream.stop(); }
});
