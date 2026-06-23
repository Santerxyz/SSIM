/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/publish.js — ONE-COMMAND release publish to the SSIM license server.
//
//    npm run publish-update                          # single-exe SSIM.exe (release-tauri/SSIM)
//    npm run publish-update -- --build               # build:tauri first, then publish
//    npm run publish-update -- --legacy-backend      # console ssim-backend.exe for the DEPLOYED
//                                                    #   two-file 1.2.x fleet (swaps over ssim-backend.exe)
//    npm run publish-update -- --legacy-backend --build   # build:protected first, then publish it
//    npm run publish-update -- --migrate             # consolidated SSIM.exe tagged kind=single-exe, to
//                                                    #   migrate a dual-updater two-file fleet to single-exe
//
//  WHICH ONE? If your installed clients are the two-file build (SSIM.exe shell + separate
//  ssim-backend.exe — i.e. 1.2.0/1.2.1/1.2.2), they can ONLY consume --legacy-backend. A consolidated
//  GUI SSIM.exe fails their stdout self-test gate and the update silently does nothing. See the
//  "Publish target" note below and docs/UPDATER_RUNBOOK.md.
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

// ── Publish target ───────────────────────────────────────────────────────────
// Two kinds of client are in the wild, and they consume INCOMPATIBLE artifacts:
//
//   default (single-exe)   → the consolidated SSIM.exe (Tauri shell + embedded backend). For clients
//                            whose updater swaps the whole SSIM.exe.
//
//   --legacy-backend       → the console-subsystem ssim-backend.exe. The DEPLOYED two-file 1.2.x fleet
//                            (1.2.1/1.2.2) runs the Gen-B updater that downloads the artifact, gates it
//                            on `SSIM_SELFTEST_OK` printed to STDOUT (60 s budget), then swaps it over
//                            ssim-backend.exe and relaunches it as a sidecar of the EXISTING shell.
//                            A GUI-subsystem SSIM.exe fails that gate (its stdout doesn't survive the
//                            pipe; the 171 MB self-extract also blows past 60 s), so the two-file fleet
//                            can ONLY be fed the backend exe. See docs/UPDATER_RUNBOOK.md + RELEASE_1.2.1.md.
//
//   --migrate              → the consolidated SSIM.exe, but tagged kind:'single-exe' so a two-file client
//                            running the DUAL updater (≥ the first cut that shipped it) replaces its SHELL
//                            and DELETES ssim-backend.exe — a seamless two-file→single-exe cutover.
//                            ⚠ ORDERING: only publish a --migrate cut once the WHOLE fleet is already on
//                            the dual updater. A client still on the OLD Gen-B updater ignores the flag,
//                            tries to swap a GUI SSIM.exe over ssim-backend.exe, and silently fails.
//                            Requires the server to echo `kind` into the GET /version manifest.
//
// ⚠ Publishing the WRONG one to a given fleet looks like "the update silently does nothing" — the
//   client downloads it and then rejects it at the self-test gate, keeping the old version.
const LEGACY = process.argv.includes('--legacy-backend');
const MIGRATE = process.argv.includes('--migrate');
if (LEGACY && MIGRATE) { console.error('\n✗ --legacy-backend and --migrate are mutually exclusive\n'); process.exit(1); }
const PRIMARY = LEGACY ? 'ssim-backend.exe' : 'SSIM.exe';
const KIND = MIGRATE ? 'single-exe' : undefined; // server-echoed manifest hint; only the dual updater reads it
// build:protected drops ssim-backend.exe at the repo root; build:tauri assembles SSIM.exe in release-tauri/SSIM.
const DIR = LEGACY ? ROOT : path.join(ROOT, 'release-tauri', 'SSIM');
const BUILD_CMD = LEGACY ? 'build:protected' : 'build:tauri';
const FILES = [{ name: PRIMARY }];

function fail(m) { console.error(`\n✗ ${m}\n`); process.exit(1); }
if (!API) fail('LICENSE_API_URL (or PUBLISH_API_URL) not set — add it to secrets.local.bat');
if (!PW) fail('SSIM_ADMIN_PASSWORD not set — add  set "SSIM_ADMIN_PASSWORD=…"  to secrets.local.bat');

if (process.argv.includes('--build')) {
  console.log(`▸ building (npm run ${BUILD_CMD}${LEGACY ? '  [SSIM_BUILD_SIDECAR=1]' : ''})…`);
  // The two-file fleet's shell spawns ssim-backend.exe as a SIDECAR (it emits SSIM_PORT= on stdout).
  // pack.js only outputs ssim-backend.exe under SSIM_BUILD_SIDECAR=1; without it build:protected makes
  // the headless ssim.exe, which the old shell can't drive. So the legacy build MUST set that flag.
  const buildEnv = LEGACY ? { ...process.env, SSIM_BUILD_SIDECAR: '1' } : process.env;
  execFileSync('npm', ['run', BUILD_CMD], { cwd: ROOT, stdio: 'inherit', shell: true, env: buildEnv });
}
for (const f of FILES) {
  const p = path.join(DIR, f.name);
  if (!fs.existsSync(p)) fail(`missing ${path.relative(ROOT, p)} — run "npm run publish-update -- --build${LEGACY ? ' --legacy-backend' : ''}" (legacy needs the SIDECAR backend build, not a bare build:protected)`);
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
  console.log(
    LEGACY  ? `  • mode: LEGACY two-file fleet  (artifact: ${PRIMARY} — console backend, swaps over ssim-backend.exe)`
    : MIGRATE ? `  • mode: MIGRATE two-file→single-exe  (artifact: ${PRIMARY}, kind=single-exe — only the DUAL updater acts on it)`
    : `  • mode: single-exe  (artifact: ${PRIMARY} — consolidated shell + backend)`);
  if (MIGRATE) console.log('  ⚠ ONLY safe once the whole fleet runs the dual updater; older clients ignore kind and fail. Canary first.');
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

  // backend names the file the server signs (${version}:${sha256}) + points the top-level {url,sha256,sig}
  // at. Legacy two-file clients pull that exact backend exe and swap it over ssim-backend.exe; single-exe
  // clients swap the whole SSIM.exe. Either way the top-level manifest is what the fleet's updater reads.
  const finalizeBody = { version: VERSION, backend: PRIMARY, files: staged };
  if (KIND) finalizeBody.kind = KIND; // server must echo this into GET /version for the dual updater to read it
  const fin = await request('POST', `${API}/admin/api/release/finalize`, { cookie, body: finalizeBody });
  if (fin.status !== 201) fail(`finalize failed (HTTP ${fin.status}): ${fin.body}`);
  const info = JSON.parse(fin.body);
  console.log(`\n✓ published v${VERSION} — live for auto-update (${LEGACY ? 'legacy two-file' : 'single-exe'}: ${info.files.map((f) => f.name).join(', ')})`);
  if (info.notNewerThanPrevious) {
    console.log(`  ⚠ v${VERSION} is NOT newer than the previous publish (v${info.previousVersion}) — existing clients will NOT pick it up.`);
  }
})().catch((e) => fail(e.message));
