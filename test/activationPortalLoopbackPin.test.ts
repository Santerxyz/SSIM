import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runActivationPortal } from '../src/licensing/ActivationServer';
import { LicenseClient } from '../src/licensing/LicenseClient';
import { boundUiPort, _resetForTest } from '../src/utils/serverPort';
import { logger } from '../src/utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  H-LIC-010 / OQ-C1(a) — the PRE-LICENSE activation portal must be HARD-PINNED to
//  loopback regardless of HOST. It serves the license-key entry form (an activation
//  relay to the license server) and the device HWID over cleartext HTTP; its only
//  legitimate consumer is the local Tauri webview, so HOST=0.0.0.0 must NOT expose it
//  to the LAN. The full app still honors HOST after the license gate. A belt-and-
//  suspenders SECURITY warning fires when HOST is non-loopback so the (intended) pin
//  is not silent.
//
//  Two behavioural tests drive the REAL portal on an ephemeral port and close it
//  deterministically with a stubbed successful activation, plus source guards.
// ─────────────────────────────────────────────────────────────────────────────

function get(port: number, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** Start the portal on an ephemeral port with the given HOST and resolve once it is listening.
 *  Returns the bound port + the promise the portal resolves when activation completes and the
 *  temp server closes (finish it with a valid, stubbed activation). */
async function startPortal(host: string): Promise<{ port: number; done: Promise<void> }> {
  _resetForTest(); // clear the module's announced-port so each case walks from 0 (ephemeral)
  const done = runActivationPortal('HWIDX', 0, host);
  for (let i = 0; i < 200 && boundUiPort() === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const port = boundUiPort();
  assert.notEqual(port, undefined, 'portal bound a port');
  return { port: port as number, done };
}

/** Swap LicenseClient.activate/saveKey for stubs so the success path (which closes the temp
 *  server) never hits the network, and restore them afterwards. */
async function withStubbedActivation(fn: (finishOk: (port: number) => Promise<void>) => Promise<void>): Promise<void> {
  const realActivate = LicenseClient.activate;
  const realSaveKey = LicenseClient.saveKey;
  (LicenseClient as any).activate = async () => ({ ok: true, reason: 'activated', payload: { tier: 'test' } });
  (LicenseClient as any).saveKey = () => { /* no-op in test */ };
  try {
    await fn(async (port: number) => { await post(port, '/api/license/activate', { key: 'K' }); });
  } finally {
    (LicenseClient as any).activate = realActivate;
    (LicenseClient as any).saveKey = realSaveKey;
  }
}

test('H-LIC-010: with HOST=0.0.0.0 the portal still binds+serves ONLY on 127.0.0.1 (loopback pin)', async () => {
  await withStubbedActivation(async (finishOk) => {
    const { port, done } = await startPortal('0.0.0.0');
    try {
      // The portal answers on loopback even though HOST=0.0.0.0 was requested.
      const r = await get(port, '/api/license/state');
      assert.equal(r.status, 200, 'loopback client reaches the portal');
      assert.equal(r.json.hwid, 'HWIDX', 'the state route serves the HWID on loopback');
    } finally {
      await finishOk(port); // successful activation closes the temp server
      await done;
    }
  });
});

test('H-LIC-010: HOST=0.0.0.0 emits the SECURITY loopback-pin warning; loopback HOST does not', async () => {
  const warns: string[] = [];
  const realWarn = logger.warn.bind(logger);
  (logger as any).warn = (msg: any, ...rest: any[]) => { warns.push(String(msg)); return realWarn(msg, ...rest); };
  try {
    await withStubbedActivation(async (finishOk) => {
      // Non-loopback HOST → warning fires.
      {
        warns.length = 0;
        const { port, done } = await startPortal('0.0.0.0');
        assert.ok(
          warns.some((w) => /SECURITY/.test(w) && /pinned to 127\.0\.0\.1/.test(w)),
          'a non-loopback HOST must log the SECURITY loopback-pin warning',
        );
        await finishOk(port);
        await done;
      }
      // Loopback HOST → no such warning.
      {
        warns.length = 0;
        const { port, done } = await startPortal('127.0.0.1');
        assert.ok(
          !warns.some((w) => /SECURITY/.test(w) && /pinned to 127\.0\.0\.1/.test(w)),
          'the default loopback HOST must NOT log the SECURITY warning',
        );
        await finishOk(port);
        await done;
      }
    });
  } finally {
    (logger as any).warn = realWarn;
  }
});

test('H-LIC-010: the source hard-pins the bind to 127.0.0.1 (not the caller HOST)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'licensing', 'ActivationServer.ts'), 'utf8');
  assert.match(src, /const bindHost = '127\.0\.0\.1';/,
    'the activation portal must pin the bind host to loopback');
  assert.match(src, /listenAndAnnounce\(server, bindHost, port\)/,
    'the bind must use the pinned loopback host, not the caller-supplied HOST');
  assert.doesNotMatch(src, /listenAndAnnounce\(server, host, port\)/,
    'the caller-supplied HOST must not be used for the pre-license bind');
});
