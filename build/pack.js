/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/pack.js – protected-build orchestrator
//
//  Pipeline:  tsc (already run) → inject secrets → obfuscate licensing surface
//             → pkg into a single ssim.exe
//
//  pkg ALREADY compiles every bundled .js to V8 bytecode and strips the readable
//  source from the binary – that is pkg's core protection. We deliberately do
//  NOT also run bytenode: stacking bytenode's .jsc inside pkg's patched module
//  loader breaks core-module resolution at runtime (require('path') comes back
//  without its methods). The obfuscation of the licensing files below is the
//  extra hardening layer on top of pkg's bytecode.
//
//  Run:  npm run build:protected
//
//  Required env (baked into the licensing source before bytecode, NEVER committed):
//    LICENSE_PEPPER        – HWID HMAC pepper
//    LICENSE_API_URL       – license backend base URL
//    LICENSE_PUBLIC_KEY    – Ed25519 public key (PEM, \n-escaped)
//
//  Dev deps used here:  javascript-obfuscator  @yao-pkg/pkg
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
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

function assertEnv(name) {
  if (!process.env[name]) {
    console.error(`✗ missing required build env: ${name}`);
    process.exit(1);
  }
}

// 1. Verify the security anchors are present before we bake anything.
['LICENSE_PEPPER', 'LICENSE_API_URL', 'LICENSE_PUBLIC_KEY'].forEach(assertEnv);

// 2. tsc must have produced dist/ already (npm script chains `build` first).
if (!fs.existsSync(DIST)) {
  console.error('✗ dist/ not found – run `npm run build` first.');
  process.exit(1);
}

// 3. Bake the build-time secrets into dist/licensing/config.js so they live in
//    the bytecode, not in process.env at runtime. We replace the `?? 'DEV…'`
//    fallbacks with the real literals.
function bakeSecret(jsFile, marker, value) {
  let src = fs.readFileSync(jsFile, 'utf8');
  // value is JSON-stringified to safely embed newlines / quotes (PEM keys).
  const literal = JSON.stringify(value);
  const re = new RegExp(`process\\.env\\.${marker}\\s*\\?\\?\\s*[^;\\n]+`);
  if (!re.test(src)) {
    console.error(`  ✗ marker ${marker} did not match – bake did not land`);
    return false;
  }
  src = src.replace(re, literal);
  fs.writeFileSync(jsFile, src);
  console.log(`  • baked ${marker}`);
  return true;
}

const configJs = path.join(DIST, 'licensing', 'config.js');
console.log('▸ baking secrets into dist/licensing/config.js');
const bakeResults = [
  bakeSecret(configJs, 'LICENSE_PEPPER', process.env.LICENSE_PEPPER),
  bakeSecret(configJs, 'LICENSE_API_URL', process.env.LICENSE_API_URL),
  bakeSecret(configJs, 'LICENSE_PUBLIC_KEY', process.env.LICENSE_PUBLIC_KEY),
];
// Fail CLOSED: a warn-and-continue on a non-matching marker ships a DEV-placeholder licensing exe
// that still passes the self-test (it never reads these values) → fleet-wide licensing failure found
// only in the field, behind a green build log.
if (bakeResults.some((ok) => !ok)) {
  console.error('✗ a required secret bake did not land — aborting so no DEV-secret binary ships.');
  process.exit(1);
}
// Catch both a non-matching regex AND any future change to config.ts's fallback text: if a DEV
// placeholder sentinel survived the bake, abort before producing an artifact.
const bakedConfig = fs.readFileSync(configJs, 'utf8');
for (const sentinel of ['DEV_PEPPER_replace_at_build_time', 'license.example.com', 'DEV_PLACEHOLDER_PUBLIC_KEY']) {
  if (bakedConfig.includes(sentinel)) {
    console.error(`✗ DEV placeholder "${sentinel}" survived the bake — aborting (no DEV-secret binary ships).`);
    process.exit(1);
  }
}

// 4. Obfuscate the sensitive surface (licensing + entry). Keep it scoped – we do
//    NOT obfuscate the whole tree (slows boot, breaks some vendor reflection).
function obfuscate(file) {
  const JsObf = require('javascript-obfuscator');
  const code = fs.readFileSync(file, 'utf8');
  const out = JsObf.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    deadCodeInjection: false,
    // MUST stay false: selfDefending injects anti-tamper code that detects pkg's
    // later bytecode transformation as "modification" and retaliates with an
    // infinite loop (runaway CPU + multi-GB RAM at boot). pkg's own V8 bytecode
    // already provides source protection + tamper resistance.
    selfDefending: false,
    // CRITICAL: keep require() specifiers OUT of the string array so pkg can
    // still statically trace + bundle them (e.g. node-machine-id is only pulled
    // in by HwidService). Anything matching these stays an inline literal; the
    // baked secrets + all other strings are still moved into the encoded array.
    reservedStrings: [
      '^os$', '^fs$', '^path$', '^crypto$', '^child_process$',
      '^fs-extra$', '^axios$', '^node-machine-id$',
      '^\\.', // every relative require ('./config', '../utils/logger', …)
    ],
  }).getObfuscatedCode();
  fs.writeFileSync(file, out);
  console.log(`  • obfuscated ${path.relative(ROOT, file)}`);
}
console.log('▸ obfuscating licensing surface');
['config.js', 'HwidService.js', 'LicenseClient.js', 'Updater.js']
  .map((f) => path.join(DIST, 'licensing', f))
  .filter(fs.existsSync)
  .forEach(obfuscate);

// 5. Regenerate the icon set: public/favicon.ico (dashboard + license page) AND
//    the multi-resolution build/icon.ico we burn into ssim.exe in step 7.
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
  execFileSync('npx', ['@yao-pkg/pkg', entry, '--config', 'package.json',
    '--options', `max_old_space_size=${heapMb}`, '--output', OUT_NAME], {
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
