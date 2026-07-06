import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import { runUnlockPortal } from '../src/core/unlockPortal';
import { boundUiPort, _resetForTest } from '../src/utils/serverPort';
import { vaultDir } from '../src/utils/paths';

// ─── H-ACC-066: a FIRST-RUN create must be double-confirmed SERVER-SIDE ──────────
// The double-entry rule used to fire only when the client volunteered a `confirm`
// field, so a single-input client state could CREATE a vault from one unconfirmed
// entry (a paste typo locking the vault behind an unknown password). The portal now
// requires `confirm` on every create and rejects a mismatch, regardless of client.

function cleanVaultDir(): void {
  for (const f of ['vault.enc', 'vault.enc.bak', 'accounts.json', 'accounts.json.bak']) {
    try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ }
  }
}

/** Start the portal on an ephemeral port and resolve once it is listening. Returns the bound port
 *  plus the promise the portal resolves when the vault opens + the temp server closes (so a test can
 *  finish it deterministically with a valid create/unlock). */
async function startPortal(): Promise<{ port: number; done: Promise<void> }> {
  _resetForTest(); // clear the module's announced-port so each case walks from 0 (ephemeral)
  const done = runUnlockPortal(0, '127.0.0.1');
  for (let i = 0; i < 200 && boundUiPort() === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const port = boundUiPort();
  assert.notEqual(port, undefined, 'portal bound a port');
  return { port: port as number, done };
}

function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/vault/unlock', method: 'POST',
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

test('H-ACC-066: first-run create with NO confirm field is refused (400) and writes no vault.enc', async () => {
  cleanVaultDir();
  const { port, done } = await startPortal();
  try {
    const r = await post(port, { password: 'a' });
    assert.equal(r.status, 400, 'no confirm on a first run → 400');
    assert.match(r.json.error, /First run: confirm/, 'first-run confirmation text surfaced');
    assert.equal(fs.existsSync(vaultDir('vault.enc')), false, 'no vault was created from the unconfirmed entry');
  } finally {
    // Close the temp server deterministically with a valid, confirmed create.
    await post(port, { password: 'a', confirm: 'a' });
    await done;
  }
});

test('H-ACC-066: first-run create with a MISMATCHED confirm is refused (400)', async () => {
  cleanVaultDir();
  const { port, done } = await startPortal();
  try {
    const r = await post(port, { password: 'a', confirm: 'b' });
    assert.equal(r.status, 400, 'confirm mismatch → 400');
    assert.match(r.json.error, /do not match/, 'mismatch text surfaced');
    assert.equal(fs.existsSync(vaultDir('vault.enc')), false, 'no vault created on a mismatch');
  } finally {
    await post(port, { password: 'a', confirm: 'a' });
    await done;
  }
});

test('H-ACC-066: first-run create with a MATCHING confirm succeeds (200 created)', async () => {
  cleanVaultDir();
  const { port, done } = await startPortal();
  const r = await post(port, { password: 'a', confirm: 'a' });
  await done; // a successful create closes the temp server
  assert.equal(r.status, 200, 'matching confirm → 200');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.created, true, 'a new vault was created');
  assert.equal(fs.existsSync(vaultDir('vault.enc')), true, 'vault.enc written');
});

test('H-ACC-066: unlocking an EXISTING vault ignores confirm (unchanged unlock behavior)', async () => {
  cleanVaultDir();
  // Seed an existing vault with a known password.
  {
    const { port, done } = await startPortal();
    await post(port, { password: 'secret', confirm: 'secret' });
    await done;
  }
  assert.equal(fs.existsSync(vaultDir('vault.enc')), true, 'seeded vault exists');
  // Now unlock it WITHOUT a confirm field — the create rule must not apply.
  const { port, done } = await startPortal();
  const r = await post(port, { password: 'secret' });
  await done; // a successful unlock closes the temp server
  assert.equal(r.status, 200, 'existing-vault unlock with no confirm → 200');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.created, false, 'unlocked an existing vault, not created');
});
