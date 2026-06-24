import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyUpdateSignature } from '../src/licensing/Updater';

// Throwaway keypair standing in for the prod server-private / client-baked-public pair.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

const V = '1.4.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';

/** Sign the kind-inclusive payload exactly as the server's signing.js does. */
function signKind(version: string, sha: string, kind?: string): string {
  const kindTag = kind ?? 'backend';
  return crypto.sign(null, Buffer.from(`${version}:${sha}:${kindTag}`), privateKey).toString('base64url');
}

// A well-formed update passes the signature gate → it would install.
test('verifyUpdateSignature: a correctly kind-signed manifest passes (backend default)', () => {
  const info = { latest: V, sha256: SHA, sigKind: signKind(V, SHA) }; // no kind → 'backend'
  assert.equal(verifyUpdateSignature(info, pubPem), true);
});

test('verifyUpdateSignature: a migration cut (kind=single-exe) passes', () => {
  const info = { latest: V, sha256: SHA, kind: 'single-exe', sigKind: signKind(V, SHA, 'single-exe') };
  assert.equal(verifyUpdateSignature(info, pubPem), true);
});

// THE integrity property: a flipped `kind` is rejected.
test('verifyUpdateSignature: a TAMPERED kind is rejected', () => {
  // Server signed kind='backend'; attacker flips the manifest's kind to 'single-exe' (keeps the
  // backend-signed sigKind). The client recomputes the payload from the tampered kind → mismatch.
  const info = { latest: V, sha256: SHA, kind: 'single-exe', sigKind: signKind(V, SHA, 'backend') };
  assert.equal(verifyUpdateSignature(info, pubPem), false);
});

test('verifyUpdateSignature: a missing sigKind is rejected (server must dual-sign first)', () => {
  assert.equal(verifyUpdateSignature({ latest: V, sha256: SHA }, pubPem), false);
});

test('verifyUpdateSignature: a tampered sha256 is rejected', () => {
  const info = { latest: V, sha256: 'f'.repeat(64), sigKind: signKind(V, SHA) };
  assert.equal(verifyUpdateSignature(info, pubPem), false);
});
