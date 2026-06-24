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
//    npm run publish-update -- --verify-download     # also re-download the SERVED artifact and confirm it
//                                                    #   is byte-for-byte identical to the build (recommended
//                                                    #   for a real release; adds a full artifact download)
//    npm run publish-update -- --skip-selftest       # escape hatch: publish WITHOUT re-booting the artifact
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
//
//  SAFETY GATES (so a release can't go out broken or mismatched):
//    1. PRE-PUBLISH SELF-TEST — the on-disk artifact is booted (SSIM_SELFTEST_OK) before upload, the
//       same anti-brick gate make-tauri.js runs at build time. publish can run WITHOUT --build, so a
//       stale/hand-copied artifact is re-proven here. Bypass only with --skip-selftest (loud warning).
//    2. UPLOAD INTEGRITY — the local sha256 of the exact bytes uploaded must equal the sha256 the server
//       stored; a corrupt transfer aborts BEFORE finalize.
//    3. POST-PUBLISH VERIFICATION — GET /version must then advertise this exact build (latest + sha256 +
//       url, and kind:'single-exe' on --migrate). --verify-download additionally re-downloads the served
//       artifact and re-hashes it (true served==built proof).
//    4. ROLLBACK — any post-publish failure rolls /version back to the manifest that was live before this
//       run (POST /admin/api/release/rollback); if the server lacks that route it prints the exact manual
//       restore values instead of leaving a bad version live.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
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
//                            Requires the server to echo `kind` into the GET /version manifest (the
//                            post-publish verification below FAILS LOUDLY if the server doesn't).
//
// ⚠ Publishing the WRONG one to a given fleet looks like "the update silently does nothing" — the
//   client downloads it and then rejects it at the self-test gate, keeping the old version.
const LEGACY = process.argv.includes('--legacy-backend');
const MIGRATE = process.argv.includes('--migrate');
// Re-finalize the SAME (or an older) version — e.g. refresh the manifest to add/repair `kind`
// or re-sign — over the server's not-newer-than-last guard. The artifact sha is unchanged, so
// existing installs see the same version+sha and do NOT re-download; only the manifest fields move.
const ALLOW_DOWNGRADE = process.argv.includes('--allow-downgrade');
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

/**
 * Anti-brick self-test: boot the artifact with SSIM_SELFTEST=1 in a throwaway SSIM_HOME and require the
 * `SSIM_SELFTEST_OK` marker — from stdout (the console ssim-backend.exe) OR the .ssim-selftest.out file
 * (the GUI SSIM.exe has no usable stdout; its shell writes the report to that file). Mirrors the gate in
 * make-tauri.js / Updater.ts.selfTestNewExe so publishing a stale/broken artifact can't ship a brick.
 */
function selfTestArtifact(exePath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-pub-st-'));
  let exitOk = false, stdout = '';
  try {
    stdout = execFileSync(exePath, [], {
      env: { ...process.env, SSIM_SELFTEST: '1', SSIM_HOME: home },
      timeout: 200_000, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }) || '';
    exitOk = true; // exited 0
  } catch (e) { stdout = String((e && e.stdout) || '') + ' ' + String((e && e.message) || e); }
  let marker = '';
  try { marker = fs.readFileSync(path.join(home, '.ssim-selftest.out'), 'utf8'); } catch { /* no report file */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  const ok = exitOk && /SSIM_SELFTEST_OK/.test(`${stdout}\n${marker}`);
  return { ok, report: (marker || stdout).trim() };
}

/** sha256 (hex) of the bytes served at a URL — streams, never buffers the whole exe. No redirect-follow. */
function sha256OfUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(u, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`)); }
      const h = crypto.createHash('sha256');
      res.on('data', (c) => h.update(c));
      res.on('end', () => resolve(h.digest('hex')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Restore /version to the manifest that was live before this run. Graceful if the server lacks the route. */
async function rollback(prev, cookie) {
  if (!prev || !prev.latest) { console.error('  ✗ no previous manifest captured — cannot auto-rollback; restore /version manually.'); return; }
  try {
    const r = await request('POST', `${API}/admin/api/release/rollback`, { cookie, body: { to: prev.latest, manifest: prev } });
    if (r.status === 200 || r.status === 201) { console.error(`  ↩ rolled /version back to the previously-live v${prev.latest}`); return; }
    console.error(`  ✗ rollback route returned HTTP ${r.status}. Manually re-point /version to v${prev.latest} (sha ${String(prev.sha256).slice(0, 12)}…).`);
  } catch (e) { console.error(`  ✗ rollback error: ${e.message}. Manually restore /version to v${prev.latest}.`); }
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
  if (ALLOW_DOWNGRADE) console.log('  ⚠ --allow-downgrade: re-finalizing over the not-newer-than-last guard (manifest refresh; identical sha ⇒ existing installs will NOT re-download)');

  // ── Gate 1: anti-brick self-test BEFORE any upload ───────────────────────────
  if (!process.argv.includes('--skip-selftest')) {
    console.log(`▸ self-testing ${PRIMARY} (extract + boot + deps load) before publish…`);
    const st = selfTestArtifact(path.join(DIR, PRIMARY));
    if (!st.ok) fail(`pre-publish self-test FAILED for ${PRIMARY} — refusing to publish a broken artifact:\n${st.report || '(no report)'}`);
    console.log(`  • self-test OK${st.report ? ` — ${st.report.split(/\r?\n/).filter(Boolean).pop()}` : ''}`);
  } else {
    console.log('  ⚠ --skip-selftest: publishing WITHOUT re-verifying the artifact boots');
  }

  const login = await request('POST', `${API}/admin/login`, { body: { password: PW } });
  if (login.status !== 200) fail(`admin login failed (HTTP ${login.status}) — check SSIM_ADMIN_PASSWORD`);
  const cookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];
  console.log('  • logged in');

  // Capture the CURRENTLY-live manifest first, so a post-publish failure can roll back to it.
  let prev = null;
  try { const pv = await request('GET', `${API}/version`); if (pv.status === 200) prev = JSON.parse(pv.body); } catch { /* no previous manifest */ }

  const staged = [];
  let primarySha = '';
  for (const f of FILES) {
    const bytes = fs.readFileSync(path.join(DIR, f.name));
    const r = await request('POST', `${API}/admin/api/release/stage?version=${VERSION}&name=${encodeURIComponent(f.name)}`, { raw: true, body: bytes, cookie });
    if (r.status !== 201) fail(`stage ${f.name} failed (HTTP ${r.status}) — is the server running the updated code? ${r.body}`);
    const j = JSON.parse(r.body);
    // Gate 2: prove the server stored EXACTLY the bytes we sent (no truncation/corruption in transit).
    const localSha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (j.sha256 !== localSha) fail(`upload integrity FAILED for ${f.name}: server sha ${String(j.sha256).slice(0, 12)}… ≠ local ${localSha.slice(0, 12)}… (corrupt transfer) — aborting before finalize`);
    staged.push({ name: f.name, storedAs: j.storedAs, sha256: localSha });
    if (f.name === PRIMARY) primarySha = localSha;
    console.log(`  • staged ${f.name}  (${(bytes.length / 1048576).toFixed(1)} MB, sha ${localSha.slice(0, 12)}… ✓ matches server)`);
  }

  // backend names the file the server signs (${version}:${sha256}) + points the top-level {url,sha256,sig}
  // at. Legacy two-file clients pull that exact backend exe and swap it over ssim-backend.exe; single-exe
  // clients swap the whole SSIM.exe. Either way the top-level manifest is what the fleet's updater reads.
  const finalizeBody = { version: VERSION, backend: PRIMARY, files: staged };
  if (KIND) finalizeBody.kind = KIND; // server must echo this into GET /version for the dual updater to read it
  if (ALLOW_DOWNGRADE) finalizeBody.allowDowngrade = true; // accept re-finalizing the same/older version (manifest refresh)
  const fin = await request('POST', `${API}/admin/api/release/finalize`, { cookie, body: finalizeBody });
  if (fin.status !== 201) fail(`finalize failed (HTTP ${fin.status}): ${fin.body}`);
  const info = JSON.parse(fin.body);
  console.log(`\n✓ published v${VERSION} — live for auto-update (${LEGACY ? 'legacy two-file' : 'single-exe'}: ${info.files.map((f) => f.name).join(', ')})`);
  if (info.notNewerThanPrevious) {
    console.log(`  ⚠ v${VERSION} is NOT newer than the previous publish (v${info.previousVersion}) — existing clients will NOT pick it up.`);
  }

  // ── Gate 3: post-publish verification (the served manifest == this build) ─────
  const issues = [];
  try {
    const pv = await request('GET', `${API}/version`);
    if (pv.status !== 200) issues.push(`GET /version returned HTTP ${pv.status}`);
    else {
      const live = JSON.parse(pv.body);
      if (live.latest !== VERSION) issues.push(`/version advertises v${live.latest}, not v${VERSION}`);
      if (primarySha && live.sha256 !== primarySha) issues.push(`/version sha256 ≠ the staged ${PRIMARY}`);
      if (!live.url) issues.push('/version has no download url');
      if (MIGRATE && live.kind !== 'single-exe') issues.push("/version is missing kind:'single-exe' — the server is NOT echoing `kind`, so the dual updater will do an in-place backend swap instead of migrating. Fix the server's release/finalize to persist `kind`.");
      if (process.argv.includes('--verify-download') && live.url && !issues.length) {
        console.log('  • re-downloading the SERVED artifact to confirm byte-for-byte identity…');
        const servedSha = await sha256OfUrl(live.url);
        if (servedSha !== primarySha) issues.push(`SERVED bytes sha ${servedSha.slice(0, 12)}… ≠ built ${primarySha.slice(0, 12)}… — the file at ${live.url} is NOT what we built`);
        else console.log('    ✓ served artifact is byte-for-byte identical to the build');
      }
    }
  } catch (e) { issues.push(`could not re-verify /version: ${e.message}`); }

  if (issues.length) {
    console.error(`\n✗ POST-PUBLISH VERIFICATION FAILED:\n   - ${issues.join('\n   - ')}`);
    await rollback(prev, cookie);
    process.exit(1);
  }
  console.log('  • verified: /version advertises this exact build' + (process.argv.includes('--verify-download') ? ' (served bytes re-hashed)' : ''));
})().catch((e) => fail(e.message));
