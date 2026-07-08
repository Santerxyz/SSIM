#!/usr/bin/env node
/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/sign-update.js — produce a SIGNED /version manifest for the SSIM
//  auto-updater (the publishing side the license backend serves).
//
//  The client (src/licensing/Updater.ts) fetches GET {LICENSE_API_URL}/version,
//  expecting:  { latest, url, sha256, sig, sigKind }
//  and only runs the new exe if sha256 matches AND `sigKind` is a valid Ed25519
//  signature over the ASCII string  `${latest}:${sha256}:${kind ?? 'backend'}`
//  under the baked LICENSE_PUBLIC_KEY. `sig` (LEGACY, kind-less, over `${latest}:${sha256}`)
//  is still emitted for the pre-C14 deployed fleet. This tool produces BOTH, signing with your
//  PRIVATE key (passed at runtime — NEVER committed; this script never writes/logs it).
//
//  USAGE (sign an update):
//    node build/sign-update.js \
//      --exe release-tauri/SSIM/SSIM.exe \
//      --version 1.1.6 \
//      --url https://your-cdn/ssim-backend-1.1.6.exe \
//      --key path/to/license_private.pem        # or set env LICENSE_PRIVATE_KEY (PEM)
//      [--out version.json]                      # also write the manifest to a file
//      [--kind single-exe]                       # only for a migration cut; default tag 'backend'
//    → prints the /version JSON body to stdout (serve it verbatim).
//    → if env LICENSE_PUBLIC_KEY is set, self-verifies the signature first.
//
//  FIRST-TIME SETUP (generate a keypair — only for a fresh deployment):
//    node build/sign-update.js --genkeys
//    → PUBLIC key  → bake into the build as LICENSE_PUBLIC_KEY (it ships in every exe)
//    → PRIVATE key → keep on the backend ONLY; sign updates with it; never commit it
//    ⚠ New keys invalidate every already-shipped client (their baked public key won't match).
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf('--' + name); return i !== -1 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes('--' + name);
const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };
const normPem = (pem) => (pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem).trim();

// ── First-time keypair generation ──────────────────────────────────────────
if (has('genkeys')) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  console.log('=== PUBLIC KEY — bake into the build as LICENSE_PUBLIC_KEY ===\n' + pub);
  console.log('\nLICENSE_PUBLIC_KEY one-liner (\\n-escaped, for secrets.local.bat):\n' + JSON.stringify(pub).slice(1, -1));
  console.log('\n=== PRIVATE KEY — keep on the license backend ONLY, never commit ===\n' + priv);
  console.error('\n⚠ New keys invalidate every already-shipped client. Use only for a fresh setup.');
  process.exit(0);
}

// ── Sign an update ──────────────────────────────────────────────────────────
const exe = arg('exe');
const version = arg('version');
const url = arg('url');
if (!exe || !version || !url) {
  die('usage: node build/sign-update.js --exe <file> --version <semver> --url <download-url> [--key <private.pem> | env LICENSE_PRIVATE_KEY] [--out version.json]');
}
if (!fs.existsSync(exe)) die('exe not found: ' + exe);
if (!/^\d+\.\d+\.\d+$/.test(version)) die('version must be a 3-part numeric semver (e.g. 1.1.6) — the client compares numerically, so pre-release/build tags are silently treated as "not newer"');

const keyFile = arg('key');
const privPem = keyFile ? fs.readFileSync(keyFile, 'utf8') : (process.env.LICENSE_PRIVATE_KEY || '');
if (!privPem.trim()) die('no private key — pass --key <private.pem> or set LICENSE_PRIVATE_KEY (PEM). NEVER commit it.');
let privateKey;
try { privateKey = crypto.createPrivateKey(normPem(privPem)); } catch (e) { die('bad private key: ' + e.message); }

const buf = fs.readFileSync(exe);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const signedString = `${version}:${sha256}`;
const sig = crypto.sign(null, Buffer.from(signedString), privateKey).toString('base64url');

// Kind-inclusive signature the CURRENT client verifies (Updater.ts); WITHOUT it every kind-aware
// client REFUSES the update. kindTag defaults to 'backend' identically to the server (signing.js
// kindTagOf) and the client (`info.kind ?? 'backend'`), so all three sign/verify the same bytes.
const kindTag = (arg('kind') || '').trim() || 'backend';
const kindSignedString = `${version}:${sha256}:${kindTag}`;
const sigKind = crypto.sign(null, Buffer.from(kindSignedString), privateKey).toString('base64url');

const manifest = { latest: version, url, sha256, sig, sigKind };
// Echo `kind` only when explicitly set (matches publish.js): both sides default the tag, so
// emitting kind:'backend' is redundant and would diverge from what the server's finalize stores.
if (has('kind')) manifest.kind = kindTag;

// Self-check against the public key (if available) so a key mismatch is caught NOW, not by clients.
const pubPem = (process.env.LICENSE_PUBLIC_KEY || '').trim();
if (pubPem) {
  const pub = crypto.createPublicKey(normPem(pubPem));
  let ok = false, okKind = false;
  try { ok = crypto.verify(null, Buffer.from(signedString), pub, Buffer.from(sig, 'base64url')); } catch { ok = false; }
  try { okKind = crypto.verify(null, Buffer.from(kindSignedString), pub, Buffer.from(sigKind, 'base64url')); } catch { okKind = false; }
  if (!ok) die('legacy signature does NOT verify against LICENSE_PUBLIC_KEY — wrong private key for this build?');
  if (!okKind) die('kind-inclusive signature (sigKind) does NOT verify — the current fleet would REFUSE this update.');
  console.error('✓ sig + sigKind verify against LICENSE_PUBLIC_KEY');
} else {
  console.error('• tip: set LICENSE_PUBLIC_KEY to self-verify sig + sigKind before publishing');
}
console.error(`• ${exe}  ${(buf.length / 1048576).toFixed(1)} MB  ·  sha256 ${sha256.slice(0, 16)}…  ·  version ${version}`);

const outFile = arg('out');
const json = JSON.stringify(manifest, null, 2);
if (outFile) { fs.writeFileSync(outFile, json); console.error('✓ wrote ' + outFile); }
console.log(json); // ← the GET /version response body; serve verbatim
