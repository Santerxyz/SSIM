/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/pack.js – protected-build orchestrator
//
//  Pipeline:  tsc (already run) → validate the update public key → pkg into a
//             single ssim.exe
//
//  pkg ALREADY compiles every bundled .js to V8 bytecode and strips the readable
//  source from the binary – that is pkg's core protection. We deliberately do
//  NOT also run bytenode: stacking bytenode's .jsc inside pkg's patched module
//  loader breaks core-module resolution at runtime (require('path') comes back
//  without its methods).
//
//  Run:  npm run build:protected
//
//  Required env: NONE. This build takes no secrets and no key material.
//
//  Dev deps used here:  @yao-pkg/pkg
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Sidecar build (the backend spawned by the Tauri desktop shell): output ssim-backend.exe and
// keep it a normal CONSOLE-subsystem exe — Tauri spawns it hidden with piped stdio, so there is
// no console flash and stdout pipes cleanly for the SSIM_PORT handshake. We also skip the base
// icon/version branding (the Tauri shell owns the app's visible identity + Task-Manager name).
// Toggle with SSIM_BUILD_SIDECAR=1; the default output (ssim.exe) is a headless server build.
const SIDECAR = process.env.SSIM_BUILD_SIDECAR === '1';
const OUT_NAME = SIDECAR ? 'ssim-backend.exe' : 'ssim.exe';

// 1. (was: verify the licensing secrets before baking them into the bytecode)
//
// SSIM is free software and the build requires NO secrets: no pepper, no API URL,
// no key material, no secrets.local.bat. The only value the client still needs is
// the Ed25519 update-verification PUBLIC key, which is public by definition and
// lives in src/update/config.ts in the clear.
//
// Do not reintroduce a required build secret. A build a contributor cannot run is
// a build that gets no contributors — see CONTRIBUTING.md.

// 2. tsc must have produced dist/ already (npm script chains `build` first).
if (!fs.existsSync(DIST)) {
  console.error('✗ dist/ not found – run `npm run build` first.');
  process.exit(1);
}

// 3. There is nothing to bake any more — the only build-time constant left is the
//    Ed25519 update-verification PUBLIC key, and it ships in the clear in
//    src/update/config.ts. But we still VALIDATE it here.
//
//    Why keep the check: a mis-typed, truncated, or wrong-curve public key looks
//    fine to every test (nothing verifies a signature at build time) and then at
//    runtime rejects EVERY update manifest — a field brick behind a green build
//    log, with no update channel left to push a fix through. Parse it so the
//    build fails loudly instead.
const configJs = path.join(DIST, 'update', 'config.js');
console.log('▸ validating the update-verification public key');
try {
  const { UPDATE_PUBLIC_KEY } = require(configJs);
  if (!UPDATE_PUBLIC_KEY) throw new Error('UPDATE_PUBLIC_KEY is empty or not exported');
  const pubKey = crypto.createPublicKey(UPDATE_PUBLIC_KEY.replace(/\\n/g, '\n'));
  if (pubKey.asymmetricKeyType !== 'ed25519') {
    console.error(`✗ update public key is not Ed25519 (got ${pubKey.asymmetricKeyType}) — aborting.`);
    process.exit(1);
  }
  console.log('  • Ed25519 update key OK');
} catch (e) {
  console.error(`✗ update public key is not a valid Ed25519 key — aborting: ${e.message}`);
  process.exit(1);
}

// 4. (removed) javascript-obfuscator pass over the licensing surface.
//
// It existed to raise the cost of recovering the baked HWID pepper. There is no
// pepper any more, and obfuscating open-source code protects nothing — the source
// is right there. Removing it also drops a significant antivirus false-positive
// source: control-flow flattening plus base64 string arrays inside a packed exe is
// a classic heuristic trigger, and "my AV flagged it" is fatal for a tool asking
// for Steam credentials. Do not add it back.

// 5. Regenerate the icon set via make-ico.js: it refreshes public/favicon.ico
//    (the dashboard + license-page favicon, which IS consumed) AND build/icon.ico.
//    NOTE: build/icon.ico is currently an unconsumed by-product — pkg can't set an
//    exe icon (step 7 keeps Node's icon, patching only the Task-Manager NAME), so
//    ssim.exe / ssim-backend.exe are NOT branded here; and the Tauri shell reads
//    src-tauri/icons/icon.ico (a separate file no build step syncs from build/) per
//    tauri.conf.json — so nothing burns build/icon.ico into any exe.
console.log('▸ regenerating icon set (public/favicon.ico + build/icon.ico)');
execFileSync('node', [path.join(__dirname, 'make-ico.js')], { cwd: ROOT, stdio: 'inherit' });

// 6. Package the Node runtime + app into a single Windows exe. pkg traces the
//    requires from dist/index.js, compiles each to V8 bytecode, and strips the
//    readable source. Target + native steam-user assets live in package.json
//    under "pkg".
const entry = path.join(DIST, 'index.js');
// Bake a V8 heap ceiling into the exe. --max-old-space-size only takes effect when set
// at isolate creation (runtime v8.setFlagsFromString is a no-op), and a double-clicked
// exe has no CLI/NODE_OPTIONS to carry it — so pkg's --options is the one place that
// works for the shipped binary. The cap turns a SILENT OS memory-kill into a CLEAN,
// captured V8 OOM (diagnostic report fires). Tunable at build time via SSIM_HEAP_MB.
const heapMb = Math.max(512, Number(process.env.SSIM_HEAP_MB) || 3072);
// Runs pkg (called from buildExe() AFTER the base binary is branded, so the icon +
// version-info are already in the base when pkg appends its payload — overlay stays valid).
function runPkg() {
  console.log(`▸ packaging single-file exe via @yao-pkg/pkg (native bytecode, heap cap ${heapMb}MB)`);
  // shell:true concatenates args into one cmd.exe command line WITHOUT quoting, so
  // the absolute `entry` (and OUT_NAME, for symmetry) must be quoted or a repo checked
  // out under a path with a space (C:\Users\John Doe\...) truncates the entry token.
  execFileSync('npx', ['@yao-pkg/pkg', '"' + entry + '"', '--config', 'package.json',
    '--options', `max_old_space_size=${heapMb}`, '--output', '"' + OUT_NAME + '"'], {
    cwd: ROOT, stdio: 'inherit', shell: true,
  });
}

// 7. Verify + name. We self-test the exe, then fix its Task-Manager NAME in place
//    (patchVersionStrings) — see buildExe() below. rcedit on a finished pkg exe shifts its
//    appended payload and kills it, and pkg overwrites base branding anyway — so the icon stays
//    Node's; the user-facing Tauri shell SSIM.exe carries the SSIM icon instead.
const EXE = path.join(ROOT, OUT_NAME);

// Verify the freshly-built exe boots + can read its payload + bundled frontend (it is still a
// console-subsystem exe at this point, so stdout is captured). Throws → build fails loudly.
function selfTest(exe) {
  console.log('▸ verifying exe (SSIM_SELFTEST)');
  const out = execFileSync(exe, [], { cwd: ROOT, env: { ...process.env, SSIM_SELFTEST: '1' }, timeout: 60_000, encoding: 'utf8' });
  if (!/SSIM_SELFTEST_OK/.test(out)) throw new Error(`self-test failed: ${out.trim() || '(no output)'}`);
  console.log(`  • ${out.trim()}`);
}

// Overlay-SAFE identity patch for the SIDECAR. rcedit on a finished pkg exe shifts its appended
// payload (breaks it), and pkg overwrites the base's version-info — so to stop Task Manager showing
// "Node.js JavaScript Runtime" for the hidden backend child, we overwrite that exact UTF-16LE string
// IN PLACE with an equal-length SSIM string (NUL-padded). Same byte length ⇒ no section/overlay shift
// ⇒ pkg payload stays valid (same principle as the subsystem byte flip).
function patchVersionStrings(exePath) {
  try {
    const buf = fs.readFileSync(exePath);
    const from = Buffer.from('Node.js JavaScript Runtime', 'utf16le'); // FileDescription = Task Manager name
    const to = Buffer.alloc(from.length, 0);
    Buffer.from('SSIM Inventory Manager', 'utf16le').copy(to); // remainder stays NUL ⇒ displays as "SSIM Inventory Manager"
    let idx = 0, count = 0;
    while ((idx = buf.indexOf(from, idx)) !== -1) { to.copy(buf, idx); idx += from.length; count++; }
    if (count > 0) { fs.writeFileSync(exePath, buf); console.log(`  • sidecar identity → "SSIM Inventory Manager" (${count}x, in-place)`); }
    else console.warn('  • Node identity string not found – sidecar still reads as Node.js');
  } catch (e) { console.warn(`  • version-string patch skipped: ${e.message}`); }
}

// Build the single-file exe: pkg → self-test → fix the Task-Manager NAME in place. Every exe is
// console-subsystem (the Tauri shell spawns the sidecar hidden; a headless server keeps its
// console). pkg overwrites the exe's icon + version-info with Node's; patchVersionStrings restores
// the NAME ("SSIM Inventory Manager"). The icon can't be changed (pkg limitation — yao-pkg has no
// icon option); the user-facing Tauri shell SSIM.exe carries the SSIM icon instead.
async function buildExe() {
  runPkg();
  selfTest(EXE);
  patchVersionStrings(EXE);
}

buildExe()
  .then(() => console.log(`✓ protected build complete → ${OUT_NAME}`))
  .catch((err) => { console.error(`✗ build failed: ${err.stack || err}`); process.exit(1); });
