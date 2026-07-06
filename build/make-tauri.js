/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/make-tauri.js — ONE-COMMAND Tauri release build.
//
//  Produces the shipping portable folder release-tauri/SSIM/ (clean — NO data/Vault):
//    SSIM.exe   ONE self-contained binary = the Tauri shell (GUI-subsystem, SSIM icon + identity)
//               with the Node backend EMBEDDED inside it (self-extracts to runtime\ on first launch)
//    README.txt
//
//  Steps: build backend (pkg) → stage into src-tauri/binaries → build shell (cargo embeds it) →
//         assemble → self-test the consolidated exe. Run: npm run build:tauri
//         (LICENSE_* secrets are auto-loaded from secrets.local.bat)
//
//  A new user runs SSIM.exe; the backend creates data/ + Vault/ NEXT TO it on first launch, so
//  the folder stays portable. (For your own testing install, dist-tauri/SSIM/ is kept separate.)
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TRIPLE = 'x86_64-pc-windows-msvc';
const OUT = path.join(ROOT, 'release-tauri', 'SSIM');

// 1. Load the build-time licensing secrets from secrets.local.bat (gitignored) into env — same
//    values start.bat sets. They get baked into the bytecode by build/pack.js.
const secretsBat = path.join(ROOT, 'secrets.local.bat');
if (fs.existsSync(secretsBat)) {
  for (const line of fs.readFileSync(secretsBat, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*set\s+"([^=]+)=(.*)"\s*$/i);
    if (m) process.env[m[1]] = m[2];
  }
}
for (const k of ['LICENSE_PEPPER', 'LICENSE_API_URL', 'LICENSE_PUBLIC_KEY']) {
  if (!process.env[k]) { console.error(`✗ missing required secret ${k} (add it to secrets.local.bat)`); process.exit(1); }
}

// 1b. ONE version source of truth. package.json is canonical (the backend reads it as pkg.version;
//     the dashboard footer fills from it via the API). Stamp it into tauri.conf.json so the shell
//     exe's file-version metadata can NEVER drift from the backend (the old footer-version bug).
const pkgVersion = require(path.join(ROOT, 'package.json')).version;
const confPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
if (conf.version !== pkgVersion) {
  console.log(`▸ syncing tauri.conf.json version ${conf.version} → ${pkgVersion} (canonical: package.json)`);
  conf.version = pkgVersion;
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
} else {
  console.log(`▸ version ${pkgVersion} (package.json = tauri.conf.json)`);
}

const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
function run(label, cmd, args, extraEnv) {
  console.log(`▸ ${label}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...extraEnv } });
}

// 2. Build the backend (tsc + pkg → ssim-backend.exe, console-subsystem, name-patched). It is no
//    longer shipped beside the shell — it gets EMBEDDED into SSIM.exe below.
run('[1/5] building backend (ssim-backend.exe)', 'npm', ['run', 'build:protected'], { SSIM_BUILD_SIDECAR: '1' });

// 3. Stage it where build.rs / include_bytes!() reads it (target-triple suffix), so the shell embeds it.
console.log('▸ [2/5] staging backend → src-tauri/binaries (embedded into the shell)');
const binDir = path.join(ROOT, 'src-tauri', 'binaries');
fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'ssim-backend.exe'), path.join(binDir, `ssim-backend-${TRIPLE}.exe`));

// 4. Build the Tauri shell (release, no installer bundle). build.rs embeds the staged backend, so the
//    resulting app.exe is the SINGLE self-contained binary (shell + backend inside it).
run('[3/5] building single-exe shell (embeds the backend)', 'npx', ['tauri', 'build', '--no-bundle'],
  { PATH: `${cargoBin}${path.delimiter}${process.env.PATH}` });

// 5. Assemble the CLEAN portable folder — now just ONE exe + README (never data/ or Vault/).
console.log('▸ [4/5] assembling clean portable folder (single SSIM.exe)');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'src-tauri', 'target', 'release', 'app.exe'), path.join(OUT, 'SSIM.exe'));
fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'SSIM — Santer Steam Inventory Manager (portable, single executable)',
  '',
  'Run SSIM.exe. It opens the SSIM window and starts its backend automatically.',
  'The backend ships INSIDE SSIM.exe and self-extracts to runtime\\ on first launch.',
  'Closing the window quits SSIM completely.',
  '',
  'Your data lives in this folder (data\\, Vault\\, logs\\, mafiles\\, runtime\\). To back up,',
  'copy the Vault\\ folder. To move SSIM to another PC, copy SSIM.exe (data regenerates).',
  '',
  'Requires the Microsoft Edge WebView2 Runtime (present on virtually all up-to-date',
  'Windows 10/11 machines). If the window does not open, install it from:',
  '  https://developer.microsoft.com/microsoft-edge/webview2/',
].join('\r\n'));

// 6. ANTI-BRICK: prove the consolidated SSIM.exe extracts + boots its embedded backend and that ALL
//    deps load (incl. the globaloffensive + steam stack), via the shell's SSIM_SELFTEST passthrough.
//    SSIM_HOME → a temp dir so the extraction + logs never pollute the clean OUT folder.
console.log('▸ [5/5] self-testing the consolidated SSIM.exe (extract + boot + deps load)');
const selftestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-selftest-'));
let selftestOk = false, report = '';
try {
  execFileSync(path.join(OUT, 'SSIM.exe'), [], {
    env: { ...process.env, SSIM_SELFTEST: '1', SSIM_HOME: selftestHome },
    timeout: 180_000, stdio: 'ignore',
  });
  selftestOk = true; // backend self-test exited 0
} catch (e) { report = e.message || String(e); }
try { report = fs.readFileSync(path.join(selftestHome, '.ssim-selftest.out'), 'utf8').trim() || report; } catch { /* no report file */ }
try { fs.rmSync(selftestHome, { recursive: true, force: true }); } catch { /* best-effort */ }
if (!selftestOk || !/SSIM_SELFTEST_OK/.test(report)) {
  // Discard this run's unverified output so no downstream consumer (make-zip.js's bare
  // existence check) can package a build that FAILED its own anti-brick self-test. OUT was
  // freshly (re)created this run at [4/5], so removing it drops only this run's SSIM.exe.
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.error(`✗ consolidated SSIM.exe self-test FAILED — NOT shipping this build:\n${report || '(no report)'}`);
  process.exit(1);
}
console.log(`  • ${report.split(/\r?\n/).filter(Boolean).pop() || 'ok'}`);

const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
console.log(`\n✓ SSIM single-exe build → ${path.relative(ROOT, OUT)}`);
console.log(`   SSIM.exe   ${mb(path.join(OUT, 'SSIM.exe'))} MB  (shell + embedded backend)`);
console.log('   (clean — no data/ or Vault/; ONE file to ship, zip + distribute)');
