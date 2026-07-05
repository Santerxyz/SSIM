import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { armPortWatch } from '../src/trading/cleanBrowser';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-064 — the debug-port watcher (armPortWatch, shared by the success AND the
//  failure path) must count a probe as ALIVE only when /json/version answers with
//  JSON carrying a `Browser` field. A recycled ephemeral port that answers with
//  anything else must NOT pin the relay+profile open forever: it counts as a miss
//  and after 6 misses (~9s) teardown fires. A real `{"Browser":…}` reply keeps the
//  session alive.
// ════════════════════════════════════════════════════════════════════════════

function serveVersion(body: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('node:net').AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test('H-TRD-064: armPortWatch tears down after 6 misses when the port answers without a Browser field', async () => {
  // A recycled ephemeral port answering with non-browser JSON must be treated as a miss, not "alive".
  const srv = await serveVersion(JSON.stringify({ notBrowser: 1 }));
  try {
    let torn = false;
    armPortWatch(srv.port, () => { torn = true; });
    // 6 misses × ~1.5s ≈ 9s ⇒ teardown fires. Poll up to 14s so a slow CI host still converges.
    const start = Date.now();
    while (!torn && Date.now() - start < 14_000) { await new Promise((r) => setTimeout(r, 250)); }
    assert.ok(torn, 'teardown must fire once the port stops answering as a real browser');
  } finally {
    await srv.close();
  }
});

test('H-TRD-064: armPortWatch keeps the session alive while the port answers with a Browser field', async () => {
  const srv = await serveVersion(JSON.stringify({ Browser: 'HeadlessChrome/1.0', webSocketDebuggerUrl: 'ws://x' }));
  try {
    let torn = false;
    armPortWatch(srv.port, () => { torn = true; });
    // Well past the 6-miss (~9s) window: a live browser must never trip teardown.
    await new Promise((r) => setTimeout(r, 11_000));
    assert.ok(!torn, 'teardown must NOT fire while a real browser is still listening');
  } finally {
    await srv.close();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-065 — a rejected loopback probe is NOT proof the window closed. Under a
//  fleet refresh the connect can fail with transient local resource pressure
//  (EMFILE/ENOBUFS/…) while the browser is alive. Only ECONNREFUSED (nothing
//  listening) means the window is gone: those get the 6-miss (~9s) teardown; any
//  other rejection gets the patient 40-miss (~60s) window so a ~9s local blip
//  never tears the relay from under a live window. fetchImpl + intervalMs are
//  injected so the classification is tested deterministically without sockets.
// ════════════════════════════════════════════════════════════════════════════

/** A fetch stub that always rejects with the given `cause.code`, counting calls. */
function rejectingFetch(code: string): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = ((): Promise<Response> => { n++; const e = new Error('probe failed') as Error & { cause?: { code?: string } }; e.cause = { code }; return Promise.reject(e); }) as unknown as typeof fetch;
  return { impl, calls: () => n };
}

test('H-TRD-065: transient local rejections (EMFILE) do NOT tear down within the 6-miss window', async () => {
  const f = rejectingFetch('EMFILE');
  let torn = false;
  armPortWatch(1, () => { torn = true; }, { fetchImpl: f.impl, intervalMs: 5 });
  // Let ~20 probes reject (5ms interval): well past 6, far below the 40-miss soft ceiling.
  const start = Date.now();
  while (f.calls() < 20 && Date.now() - start < 4_000) { await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(f.calls() >= 20, 'the watcher must keep probing');
  assert.ok(!torn, 'a live browser under transient local socket pressure must NOT be torn down');
});

test('H-TRD-065: ECONNREFUSED rejections tear down after 6 misses', async () => {
  const f = rejectingFetch('ECONNREFUSED');
  let torn = false;
  armPortWatch(1, () => { torn = true; }, { fetchImpl: f.impl, intervalMs: 5 });
  const start = Date.now();
  while (!torn && Date.now() - start < 4_000) { await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(torn, 'ECONNREFUSED means nothing is listening — teardown must fire at 6 misses');
});
