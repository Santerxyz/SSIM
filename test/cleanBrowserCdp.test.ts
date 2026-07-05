import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';

import { injectSessionOverCdp } from '../src/trading/cleanBrowser';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-060 — cookie injection over the page debugger WS is response-AWAITED, not
//  fire-and-forget. A CDP error reply to Network.setCookie must REJECT the injection
//  promise (surfacing a real 500 and skipping the false "clean browser opened" log),
//  instead of the old 400ms-flush path that resolved regardless. A well-formed run
//  (empty-ok replies to every command) resolves.
//
//  No `ws` dep is available, so this harness speaks the minimum of RFC 6455 (server
//  side): accept the upgrade, read masked text frames, reply with unmasked text frames.
// ════════════════════════════════════════════════════════════════════════════

/** Minimal WS server: `onMessage(json)` returns the JSON to reply with (or null for no reply). */
function fakeCdpServer(onMessage: (msg: { id: number; method: string }) => object | null): Promise<{ url: string; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    let handshook = false;
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const headers = buf.slice(0, end).toString('latin1');
        const key = /sec-websocket-key:\s*(\S+)/i.exec(headers)?.[1] ?? '';
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        handshook = true;
        buf = buf.slice(end + 4);
      }
      // Parse any complete client text frames (client frames are always masked).
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return; // frame incomplete
        const mask = masked ? buf.slice(off, off + 4) : Buffer.alloc(0);
        const payload = buf.slice(off + maskLen, off + maskLen + len);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.slice(off + maskLen + len);
        if (opcode === 0x8) { sock.end(); return; } // close
        if (opcode !== 0x1) continue;               // only text frames carry CDP
        let reply: object | null = null;
        try { reply = onMessage(JSON.parse(payload.toString('utf8'))); } catch { reply = null; }
        if (reply) sock.write(encodeTextFrame(JSON.stringify(reply)));
      }
    });
    sock.on('error', () => { /* ignore */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Encode an unmasked server text frame (payload < 64 KiB is enough here). */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const head = Buffer.alloc(4);
  head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

const ONE_COOKIE = [{ name: 'steamLoginSecure', value: 'x', domain: 'steamcommunity.com', path: '/', secure: true, httpOnly: true }];

test('H-TRD-060: a CDP error reply to setCookie rejects the injection promise', async () => {
  const srv = await fakeCdpServer((msg) => {
    if (msg.method === 'Network.setCookie') return { id: msg.id, error: { message: 'boom' } };
    return { id: msg.id, result: {} }; // Network.enable / Page.navigate succeed
  });
  try {
    await assert.rejects(
      injectSessionOverCdp(srv.url, ONE_COOKIE as never),
      (e: Error) => /boom/.test(e.message),
      'a refused setCookie must reject with the CDP error message',
    );
  } finally {
    await srv.close();
  }
});

test('H-TRD-060: an all-ok CDP run resolves the injection promise', async () => {
  const srv = await fakeCdpServer((msg) => ({ id: msg.id, result: {} }));
  try {
    await injectSessionOverCdp(srv.url, ONE_COOKIE as never); // resolves without throwing
  } finally {
    await srv.close();
  }
});
