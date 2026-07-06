import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp, type ApiDeps } from '../src/api/server';
import { getCapabilityToken } from '../src/api/capability';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-125 — the trade-send route must NOT blanket-stamp verifyBeforeRetry on a
//  DEFINITE Steam rejection. A structurally-definite rejection (inventoryFull /
//  recognised cause / eresult) means the offer does NOT exist → plain reason, no
//  "verify before retry" warning. Transport-ambiguous (ECONNRESET) and the
//  ambiguous-by-definition eresult 16 keep the safe verifyBeforeRetry default.
//
//  We stand up the REAL createApp route with a stubbed TradeService whose
//  sendTrade throws the scripted error, and read the classified HTTP body.
// ─────────────────────────────────────────────────────────────────────────────

/** A createApp deps object stubbed down to just what /api/trade/send touches. */
function stubDeps(sendTrade: () => Promise<never>): ApiDeps {
  const from = { username: 'sender' };
  const accounts = { get: (u: string) => (u === 'sender' ? from : undefined) };
  const trades = { sendTrade };
  // Only `accounts` + `trades` are exercised by this route (external tradeUrl path);
  // the rest are never called at registration or on this request.
  return { accounts, trades } as unknown as ApiDeps;
}

function post(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/trade/send', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Host': 'localhost',                 // pass the DNS-rebind Host allow-list
          'Origin': 'http://localhost',        // same-origin → pass the anti-CSRF guard
          'X-SSIM-Cap': getCapabilityToken(),  // pass the capability guard
        },
        timeout: 4000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, json: buf ? JSON.parse(buf) : {} }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

async function classify(err: Error): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = createApp(stubDeps(async () => { throw err; }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    return await post((server.address() as AddressInfo).port, {
      from: 'sender', assetIds: ['1'], tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=abc',
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('H-TRD-125 (a): a full-inventory rejection is definite → inventoryFull, NO verifyBeforeRetry', async () => {
  const err = Object.assign(new Error("The recipient's inventory is full — there is no free space for these items."), { inventoryFull: true });
  const { status, json } = await classify(err);
  assert.equal(status, 502);
  assert.equal(json.inventoryFull, true);
  assert.equal(json.verifyBeforeRetry, undefined, 'a definite rejection is not stamped ambiguous');
});

test('H-TRD-125 (b): an ECONNRESET send keeps verifyBeforeRetry (transport-ambiguous)', async () => {
  const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', inventoryFull: false });
  const { status, json } = await classify(err);
  assert.equal(status, 502);
  assert.equal(json.verifyBeforeRetry, true, 'a transport-ambiguous send stays flagged for a manual check');
  assert.equal(json.inventoryFull, undefined);
});

test('H-TRD-125 (c): eresult 16 (Timeout — may have sent) keeps verifyBeforeRetry', async () => {
  const err = Object.assign(new Error('There was an error sending your trade offer. (16)'), { eresult: 16, inventoryFull: false });
  const { status, json } = await classify(err);
  assert.equal(status, 502);
  assert.equal(json.verifyBeforeRetry, true, 'the ambiguous-by-definition timeout code is never treated as definite');
});

test('H-TRD-125: a definite eresult rejection (15 Access Denied) is plain, NO verifyBeforeRetry', async () => {
  const err = Object.assign(new Error('Steam Error 15: Access Denied'), { eresult: 15, inventoryFull: false });
  const { status, json } = await classify(err);
  assert.equal(status, 502);
  assert.equal(json.eresult, 15);
  assert.equal(json.verifyBeforeRetry, undefined);
});
