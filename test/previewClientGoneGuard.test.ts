import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.4 issue 3 — "the fetch price still doesn't work, it shows no price 0.00".
//
//  ROOT CAUSE: /api/market/preview's client-disconnect guard (H-TRD-022) read the
//  REQUEST for the abort signal:
//      req.on('close', () => clientGone = true)
//      shouldStop: () => clientGone || res.writableEnded || req.destroyed
//  For a POST whose body express.json() has consumed, the request stream is finished
//  and Node AUTO-DESTROYS it as soon as the handler awaits anything. So both signals
//  fire on a perfectly healthy request. preview() awaits priceCtxsFor() before its
//  worker loop ⇒ every worker saw shouldStop()===true on its FIRST check, returned
//  without calling getSellInfo (zero `[price]` log lines — matching the live log), and
//  produced an EMPTY map, which the modal renders as "no price" on every row.
//
//  The response is the honest signal: res 'close' + writableFinished distinguishes
//  "we finished sending" from "the peer went away".
// ─────────────────────────────────────────────────────────────────────────────

/** Boots a one-route express app using the SHIPPED guard shape; returns what shouldStop() saw. */
function bootGuardApp(onRequest: (probe: () => boolean) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.post('/preview', async (req, res) => {
    // The SHIPPED construction (server.ts): response-based, disambiguated by writableFinished.
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    const shouldStop = (): boolean => clientGone;

    // The OLD, broken construction — kept so the test proves WHY it was wrong.
    let oldClientGone = false;
    req.on('close', () => { oldClientGone = true; });
    const oldShouldStop = (): boolean => oldClientGone || res.writableEnded || req.destroyed;

    await onRequest(shouldStop);
    res.json({ fixed: shouldStop(), old: oldShouldStop() });
  });
  return app;
}

function post(port: number, body: unknown, opts: { abortAfterMs?: number } = {}): Promise<{ fixed: boolean; old: boolean } | 'aborted'> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/preview', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); },
    );
    req.on('error', () => resolve('aborted'));
    if (opts.abortAfterMs != null) setTimeout(() => req.destroy(), opts.abortAfterMs);
    req.end(payload);
  });
}

test('a HEALTHY preview request must NOT be treated as disconnected after an await', async () => {
  // Mirrors preview(): an await (priceCtxsFor) happens BEFORE the worker loop's first shouldStop check.
  const app = bootGuardApp(async () => { await new Promise((r) => setTimeout(r, 60)); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await post(port, { names: ['AK-47 | Redline (Field-Tested)'], strategy: 'lowest' });
    assert.notEqual(r, 'aborted');
    const got = r as { fixed: boolean; old: boolean };
    assert.equal(got.fixed, false, 'the shipped guard must stay false — the client is right there waiting');
    // Pin the defect itself: the old guard DID report a healthy request as gone. If this ever flips to
    // false, Node changed its auto-destroy timing and this test no longer guards the regression.
    assert.equal(got.old, true, 'the old req-based guard reported a healthy request as disconnected (the bug)');
  } finally {
    server.close();
  }
});

test('a REAL client abort is still detected (the guard keeps doing its job)', async () => {
  let sawStopDuringWork = false;
  const app = bootGuardApp(async (probe) => {
    // Long enough that the client's abort lands mid-"cascade", as a 120s client timeout would.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (probe()) { sawStopDuringWork = true; return; }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  try {
    await post(port, { names: ['x'], strategy: 'lowest' }, { abortAfterMs: 100 });
    // Give the server loop a moment to observe the abort after the socket dies.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sawStopDuringWork, true, 'a genuine disconnect must still stop the cascade');
  } finally {
    server.close();
  }
});
