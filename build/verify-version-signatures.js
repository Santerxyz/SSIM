'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  verify-version-signatures.js — the C14 rollout GATE between deploying the
//  dual-signing server and publishing the new client. READ-ONLY: one GET /version,
//  no publish, no write. Verifies the LIVE manifest BOTH ways against the baked
//  public key, so you can confirm an OLD client and the NEW client both validate
//  before you ship the new client.
//
//    node build/verify-version-signatures.js <LICENSE_API_URL> <public-key.pem>
//    e.g. node build/verify-version-signatures.js https://license.ssim.dev keys/public.pem
//
//  Exit 0 = PASS (both valid). Exit 1 = FAIL (do NOT publish the new client yet).
// ════════════════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const api = String(process.argv[2] || '').replace(/\/+$/, '');
const pubPath = process.argv[3];
if (!api || !pubPath) {
  console.error('usage: node build/verify-version-signatures.js <LICENSE_API_URL> <public-key.pem>');
  process.exit(2);
}
const pub = fs.readFileSync(pubPath, 'utf8');
const get = api.startsWith('http://') ? http.get : https.get;

get(`${api}/version`, (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => {
    let info;
    try { info = JSON.parse(body); } catch { console.error('bad /version JSON:', body.slice(0, 200)); process.exit(1); }
    if (!info || !info.latest) { console.error('no manifest at /version:', body.slice(0, 200)); process.exit(1); }

    const kindTag = info.kind && String(info.kind).trim() ? String(info.kind).trim() : 'backend';
    const v = (payload, sig) => {
      try { return !!sig && crypto.verify(null, Buffer.from(payload), pub, Buffer.from(sig, 'base64url')); }
      catch { return false; }
    };
    const oldOk = v(`${info.latest}:${info.sha256}`, info.sig);                    // deployed/old single-exe client
    const newOk = v(`${info.latest}:${info.sha256}:${kindTag}`, info.sigKind);     // the new kind-aware client

    console.log(`/version  latest=${info.latest}  kind=${info.kind || '(none→backend)'}`);
    console.log(`  OLD client  sig      over latest:sha256             -> ${oldOk ? 'VALID' : 'INVALID/MISSING'}`);
    console.log(`  NEW client  sigKind  over latest:sha256:${kindTag}   -> ${newOk ? 'VALID' : 'INVALID/MISSING'}`);
    const ok = oldOk && newOk;
    console.log(ok
      ? 'RESULT: PASS — both an old client and the new client validate this update. Safe to publish the new client.'
      : 'RESULT: FAIL — do NOT publish the new client yet (the server is not dual-signing correctly).');
    process.exit(ok ? 0 : 1);
  });
}).on('error', (e) => { console.error('fetch error:', e.message); process.exit(1); });
