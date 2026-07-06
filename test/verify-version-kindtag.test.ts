import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { verifyUpdateSignature } from '../src/licensing/Updater';

// ─── H-SHL-022: the release GATE must predict the CLIENT's accept/reject, not the server's ──
// verify-version-signatures.js is an ORACLE for the shipped client's signature decision. The client
// (`Updater.ts verifyUpdateSignature`) derives its kindTag as `info.kind ?? 'backend'` — it coalesces
// ONLY null/undefined and NEVER trims. The server that signs (`signing.js`) TRIMS. So for a manifest
// whose `kind` is present-but-empty (''), whitespace, or padded, the server signs the trimmed tag while
// the client verifies it verbatim → they disagree. The tool used to mirror the SERVER (trim), so it
// PASSed a manifest the fleet would REJECT — the exact false-green the gate exists to prevent. After the
// fix the tool derives kindTag like the client AND fails closed on any non-canonical `kind`.

const V = '1.4.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

const sign = (payload: string): string =>
  crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');

const TOOL = path.join(__dirname, '..', 'build', 'verify-version-signatures.js');

/** Serve one manifest at /version, run the gate against it, and resolve its exit code + stdout/stderr. */
function runGate(manifest: unknown): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/version')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(manifest));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const pubFile = path.join(os.tmpdir(), `ssim-kindtag-pub-${process.pid}-${port}.pem`);
      fs.writeFileSync(pubFile, pubPem);
      const child = spawn(process.execPath, [TOOL, `http://127.0.0.1:${port}`, pubFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', (e) => { server.close(); try { fs.unlinkSync(pubFile); } catch { /* noop */ } reject(e); });
      child.on('close', (code) => {
        server.close();
        try { fs.unlinkSync(pubFile); } catch { /* noop */ }
        resolve({ code, out });
      });
    });
  });
}

// (a) The CLIENT rejects a kind:'' manifest whose sigKind was signed over the server-TRIMMED tag
//     ('' → 'backend'). This is the divergence the gate must now also catch.
test('H-SHL-022: client rejects a kind:"" manifest signed over the trimmed "backend" tag', () => {
  const info = { latest: V, sha256: SHA, kind: '', sigKind: sign(`${V}:${SHA}:backend`) };
  assert.equal(verifyUpdateSignature(info, pubPem), false);
});

// (b) The patched GATE reports FAIL (exit 1) for that same manifest — tool and client now agree.
//     Old `sig` is VALID so only the non-canonical kind drives the failure; the gate must still FAIL.
test('H-SHL-022: gate FAILs (exit 1) on a non-canonical kind:"" manifest', async () => {
  const manifest = {
    latest: V,
    sha256: SHA,
    sig: sign(`${V}:${SHA}`),                 // old client: VALID
    kind: '',
    sigKind: sign(`${V}:${SHA}:backend`),     // server-trimmed tag → client verifies '' verbatim → mismatch
  };
  const { code, out } = await runGate(manifest);
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /RESULT: FAIL/, 'the gate must report FAIL for a non-canonical kind');
  assert.match(out, /WARN: manifest kind is non-canonical/, 'the gate must surface the server/client divergence');
});

// (c) A padded kind (" single-exe ") is likewise un-shippable and must FAIL even though the tool's
//     own trimmed-vs-verbatim payloads could otherwise mask it.
test('H-SHL-022: gate FAILs (exit 1) on a padded kind " single-exe "', async () => {
  const kind = ' single-exe ';
  const manifest = {
    latest: V,
    sha256: SHA,
    sig: sign(`${V}:${SHA}`),
    kind,
    sigKind: sign(`${V}:${SHA}:${kind.trim()}`), // server signs the trimmed tag
  };
  const { code, out } = await runGate(manifest);
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /WARN: manifest kind is non-canonical/, 'a padded kind must be surfaced');
});

// (d) Regression guard: a CANONICAL manifest (kind absent, dual-signed correctly like the production
//     server emits today) still PASSes with exit 0 — the fix only narrows the non-canonical case.
test('H-SHL-022: gate still PASSes (exit 0) on a canonical dual-signed manifest', async () => {
  const manifest = {
    latest: V,
    sha256: SHA,
    sig: sign(`${V}:${SHA}`),
    sigKind: sign(`${V}:${SHA}:backend`),      // kind absent → both sides derive 'backend'
  };
  const { code, out } = await runGate(manifest);
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /RESULT: PASS/, 'a canonical manifest must still pass');
});
