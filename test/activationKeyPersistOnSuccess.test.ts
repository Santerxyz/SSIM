import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runActivationPortal } from '../src/licensing/ActivationServer';
import { LicenseClient } from '../src/licensing/LicenseClient';
import { boundUiPort, _resetForTest } from '../src/utils/serverPort';

// ─────────────────────────────────────────────────────────────────────────────
//  H-LIC-012 — the activation portal must persist data/license.key ONLY after the
//  license server ACCEPTS the key, never before activate() runs. A typo'd or
//  transient-failed key that is written pre-verify is re-tried automatically on the
//  next boot (validate() → readKey() → auto-activate) and rides the C4 telemetry.
//
//  Both tests drive the REAL portal on an ephemeral loopback port with saveKey +
//  activate stubbed (so nothing hits disk or the network), plus a source-order guard.
// ─────────────────────────────────────────────────────────────────────────────

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

/** Start the portal on an ephemeral loopback port and resolve once it is listening. */
async function startPortal(): Promise<{ port: number; done: Promise<void> }> {
  _resetForTest();
  const done = runActivationPortal('HWIDX', 0, '127.0.0.1');
  for (let i = 0; i < 200 && boundUiPort() === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const port = boundUiPort();
  assert.notEqual(port, undefined, 'portal bound a port');
  return { port: port as number, done };
}

test('H-LIC-012: a FAILED activation does NOT persist the key', async () => {
  const saved: string[] = [];
  const realActivate = LicenseClient.activate;
  const realSaveKey = LicenseClient.saveKey;
  // First reject the key (server refused), then accept it so the temp server closes.
  let accept = false;
  (LicenseClient as any).activate = async () =>
    accept ? { ok: true, reason: 'activated', payload: { tier: 'test' } }
           : { ok: false, reason: 'Unknown license key.' };
  (LicenseClient as any).saveKey = (k: string) => { saved.push(k); };
  try {
    const { port, done } = await startPortal();
    const r = await post(port, '/api/license/activate', { key: 'BADKEY' });
    assert.equal(r.status, 400, 'a refused key returns 400');
    assert.equal(saved.length, 0, 'saveKey must NOT be called when activation fails');

    // Now succeed once to tear the portal down cleanly.
    accept = true;
    await post(port, '/api/license/activate', { key: 'GOODKEY' });
    await done;
    assert.deepEqual(saved, ['GOODKEY'], 'only the ACCEPTED key is persisted');
  } finally {
    (LicenseClient as any).activate = realActivate;
    (LicenseClient as any).saveKey = realSaveKey;
  }
});

test('H-LIC-012: a SUCCESSFUL activation persists exactly the trimmed key once', async () => {
  const saved: string[] = [];
  const realActivate = LicenseClient.activate;
  const realSaveKey = LicenseClient.saveKey;
  (LicenseClient as any).activate = async () => ({ ok: true, reason: 'activated', payload: { tier: 'test' } });
  (LicenseClient as any).saveKey = (k: string) => { saved.push(k); };
  try {
    const { port, done } = await startPortal();
    const r = await post(port, '/api/license/activate', { key: '  ABC-123  ' });
    assert.equal(r.status, 200, 'an accepted key returns 200');
    await done;
    assert.deepEqual(saved, ['ABC-123'], 'saveKey is called once with the trimmed, accepted key');
  } finally {
    (LicenseClient as any).activate = realActivate;
    (LicenseClient as any).saveKey = realSaveKey;
  }
});

test('H-LIC-012: the source persists the key AFTER activate() succeeds, not before', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'licensing', 'ActivationServer.ts'), 'utf8');
  // activate(key, hwid) must appear before the saveKey(key) call.
  assert.match(
    src,
    /const result = await LicenseClient\.activate\(key, hwid\);[\s\S]*LicenseClient\.saveKey\(key\);/,
    'activate must run before saveKey (persist only an accepted key)',
  );
  assert.doesNotMatch(
    src,
    /LicenseClient\.saveKey\(key\);[\s\S]*const result = await LicenseClient\.activate\(key, hwid\);/,
    'saveKey must not precede activate',
  );
});
