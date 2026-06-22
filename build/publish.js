/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/publish.js — ONE-COMMAND release publish to the SSIM license server.
//
//    npm run publish-update              # publish the current release-tauri/SSIM build
//    npm run publish-update -- --build   # build:tauri first, then publish
//
//  Reads the version from package.json (no typing). Needs, from secrets.local.bat or env:
//    LICENSE_API_URL       the server base (e.g. https://license.ssim.dev)
//    SSIM_ADMIN_PASSWORD   the admin-panel password (POST /admin/login)
//
//  SSIM ships as ONE binary now (SSIM.exe = shell + embedded backend). We stage that single file and
//  finalize. ONE published manifest serves EVERYONE:
//    • new single-exe clients   → read the top-level {url,sha256,sig} and swap SSIM.exe.
//    • existing TWO-FILE installs → their OLD updater (runManifestUpdate) consumes files[]=[SSIM.exe]
//      and swaps this SSIM.exe in over their old shell (the new exe then cleans the orphan backend).
//  finalize is called with backend:'SSIM.exe' so the server points BOTH manifest forms at SSIM.exe.
//  The server must run the updated /admin/api/release/* code (accepting a single-file release).
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Load secrets.local.bat (`set "K=V"` lines) into env — same loader make-tauri.js uses.
const secretsBat = path.join(ROOT, 'secrets.local.bat');
if (fs.existsSync(secretsBat)) {
  for (const line of fs.readFileSync(secretsBat, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*set\s+"([^=]+)=(.*)"\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API = (process.env.PUBLISH_API_URL || process.env.LICENSE_API_URL || '').replace(/\/+$/, '');
const PW = process.env.SSIM_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const VERSION = require(path.join(ROOT, 'package.json')).version;
const DIR = path.join(ROOT, 'release-tauri', 'SSIM');
// ONE artifact: the consolidated SSIM.exe (shell + embedded backend). It is BOTH the single-file
// download (top-level manifest) AND the lone entry in files[] that old two-file clients migrate onto.
const FILES = [{ name: 'SSIM.exe' }];

function fail(m) { console.error(`\n✗ ${m}\n`); process.exit(1); }
if (!API) fail('LICENSE_API_URL (or PUBLISH_API_URL) not set — add it to secrets.local.bat');
if (!PW) fail('SSIM_ADMIN_PASSWORD not set — add  set "SSIM_ADMIN_PASSWORD=…"  to secrets.local.bat');

if (process.argv.includes('--build')) {
  console.log('▸ building (npm run build:tauri)…');
  execFileSync('npm', ['run', 'build:tauri'], { cwd: ROOT, stdio: 'inherit', shell: true });
}
for (const f of FILES) {
  const p = path.join(DIR, f.name);
  if (!fs.existsSync(p)) fail(`missing ${path.relative(ROOT, p)} — run "npm run build:tauri" (or "npm run publish-update -- --build") first`);
}

/** Minimal cookie-aware HTTP(S) request → { status, headers, body }. */
function request(method, urlStr, { body, raw, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = raw ? body : (body ? Buffer.from(JSON.stringify(body)) : null);
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log(`▸ publishing SSIM v${VERSION}  →  ${API}`);
  const login = await request('POST', `${API}/admin/login`, { body: { password: PW } });
  if (login.status !== 200) fail(`admin login failed (HTTP ${login.status}) — check SSIM_ADMIN_PASSWORD`);
  const cookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];
  console.log('  • logged in');

  const staged = [];
  for (const f of FILES) {
    const bytes = fs.readFileSync(path.join(DIR, f.name));
    const r = await request('POST', `${API}/admin/api/release/stage?version=${VERSION}&name=${encodeURIComponent(f.name)}`, { raw: true, body: bytes, cookie });
    if (r.status !== 201) fail(`stage ${f.name} failed (HTTP ${r.status}) — is the server running the updated code? ${r.body}`);
    const j = JSON.parse(r.body);
    staged.push({ name: f.name, storedAs: j.storedAs });
    console.log(`  • staged ${f.name}  (${(bytes.length / 1048576).toFixed(1)} MB, sha ${j.sha256.slice(0, 12)}…)`);
  }

  // backend:'SSIM.exe' → the server points the single-file {url,sha256,sig} at SSIM.exe (new + legacy
  // single-file clients) AND lists it in files[]+filesSig (old two-file clients migrate onto it).
  const fin = await request('POST', `${API}/admin/api/release/finalize`, { cookie, body: { version: VERSION, backend: 'SSIM.exe', files: staged } });
  if (fin.status !== 201) fail(`finalize failed (HTTP ${fin.status}): ${fin.body}`);
  const info = JSON.parse(fin.body);
  console.log(`\n✓ published v${VERSION} — live for auto-update (single-exe: ${info.files.map((f) => f.name).join(', ')})`);
  if (info.notNewerThanPrevious) {
    console.log(`  ⚠ v${VERSION} is NOT newer than the previous publish (v${info.previousVersion}) — existing clients will NOT pick it up.`);
  }
})().catch((e) => fail(e.message));
