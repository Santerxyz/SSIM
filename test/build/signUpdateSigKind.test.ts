import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'os';
import path from 'path';

// ─── H-SHL-019: the manual signer must emit a kind-inclusive sigKind ───────────
// The current client verifies `sigKind` (over `${latest}:${sha256}:${kind ?? 'backend'}`), not the
// legacy `sig`. The manual-fallback signer emitted only `sig`, so every manifest it produced was
// REFUSED by the fleet — and its self-check printed a false ✓. This runs the real CLI and asserts
// the emitted sigKind verifies over the exact string the client checks.

test('H-SHL-019: sign-update emits sig + sigKind, and sigKind verifies over the client string', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-signupd-${process.pid}-`));
  try {
    const privPem = path.join(dir, 'priv.pem');
    fs.writeFileSync(privPem, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const exe = path.join(dir, 'fixture.bin');
    fs.writeFileSync(exe, Buffer.from('hello-ssim-update'));

    const out = execFileSync(
      'node',
      ['build/sign-update.js', '--exe', exe, '--version', '1.3.6', '--url', 'http://cdn/x.exe', '--key', privPem],
      { encoding: 'utf8', env: { ...process.env, LICENSE_PUBLIC_KEY: pubPem } },
    );
    const manifest = JSON.parse(out);

    assert.ok(manifest.sigKind && manifest.sigKind.length > 0, 'manifest must carry a kind-inclusive sigKind');
    assert.ok(manifest.sig && manifest.sig.length > 0, 'the legacy sig is still emitted for the pre-C14 fleet');
    assert.equal(manifest.kind, undefined, 'kind is omitted when --kind is not passed (both sides default to backend)');

    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
    const okKind = crypto.verify(
      null, Buffer.from(`1.3.6:${sha256}:backend`), crypto.createPublicKey(pubPem), Buffer.from(manifest.sigKind, 'base64url'),
    );
    assert.equal(okKind, true, 'sigKind must verify over `${version}:${sha256}:backend` — the exact string the client checks');
    assert.equal(manifest.sha256, sha256, 'manifest sha256 matches the signed exe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
