/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/make-tauri.js — ONE-COMMAND Tauri release build.
//
//  Produces the shipping portable folder release-tauri/SSIM/ (clean — NO data/Vault):
//    SSIM.exe          the Tauri shell  (GUI-subsystem, SSIM circular icon + identity)
//    ssim-backend.exe  the Node backend (pkg bytecode; Tauri spawns it hidden)
//    README.txt
//
//  Steps: build sidecar (pkg) → stage into src-tauri/binaries → build shell (cargo) → assemble.
//  Run:   npm run build:tauri   (LICENSE_* secrets are auto-loaded from secrets.local.bat)
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

const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
function run(label, cmd, args, extraEnv) {
  console.log(`▸ ${label}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...extraEnv } });
}

// 2. Build the backend sidecar (tsc + pkg → ssim-backend.exe, console-subsystem, name-patched).
run('[1/4] building backend sidecar (ssim-backend.exe)', 'npm', ['run', 'build:protected'], { SSIM_BUILD_SIDECAR: '1' });

// 3. Stage it where Tauri's externalBin expects it (target-triple suffix).
console.log('▸ [2/4] staging sidecar → src-tauri/binaries');
const binDir = path.join(ROOT, 'src-tauri', 'binaries');
fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'ssim-backend.exe'), path.join(binDir, `ssim-backend-${TRIPLE}.exe`));

// 4. Build the Tauri shell (release, no installer bundle → just SSIM.exe).
run('[3/4] building Tauri shell (SSIM.exe)', 'npx', ['tauri', 'build', '--no-bundle'],
  { PATH: `${cargoBin}${path.delimiter}${process.env.PATH}` });

// 5. Assemble the CLEAN portable folder (never includes data/ or Vault/).
console.log('▸ [4/4] assembling clean portable folder');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'src-tauri', 'target', 'release', 'app.exe'), path.join(OUT, 'SSIM.exe'));
fs.copyFileSync(path.join(ROOT, 'ssim-backend.exe'), path.join(OUT, 'ssim-backend.exe'));
fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'SSIM — Santer Steam Inventory Manager (portable)',
  '',
  'Run SSIM.exe. It opens the SSIM window and starts its backend automatically.',
  'Closing the window quits SSIM completely.',
  '',
  'Your data lives in this folder (data\\, Vault\\, logs\\, mafiles\\). To back up,',
  'copy the Vault\\ folder. To move SSIM to another PC, copy this whole folder.',
  '',
  'Requires the Microsoft Edge WebView2 Runtime (present on virtually all up-to-date',
  'Windows 10/11 machines). If the window does not open, install it from:',
  '  https://developer.microsoft.com/microsoft-edge/webview2/',
].join('\r\n'));

const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
console.log(`\n✓ SSIM (Tauri) portable build → ${path.relative(ROOT, OUT)}`);
console.log(`   SSIM.exe          ${mb(path.join(OUT, 'SSIM.exe'))} MB`);
console.log(`   ssim-backend.exe  ${mb(path.join(OUT, 'ssim-backend.exe'))} MB`);
console.log('   (clean — no data/ or Vault/; ready to zip + distribute)');
