/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/make-portable.js — assemble the portable SSIM (Tauri) folder.
//
//  Inputs (build these first):
//    • src-tauri/target/release/app.exe   ← `npx tauri build --no-bundle`
//    • ssim-backend.exe (repo root)       ← `SSIM_BUILD_SIDECAR=1 npm run build:protected`
//
//  Output: dist-tauri/SSIM/
//    • SSIM.exe          (the Tauri shell — GUI-subsystem, SSIM icon + identity)
//    • ssim-backend.exe  (the Node backend sidecar, spawned hidden by the shell)
//    • README.txt
//
//  At first run SSIM.exe spawns ssim-backend.exe (adjacent) and the backend writes
//  data/ Vault/ logs/ mafiles/ NEXT TO the exe (SSIM_HOME = the folder SSIM.exe is in),
//  so the whole folder is portable: copy/move it anywhere, back up by copying Vault/.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHELL = path.join(ROOT, 'src-tauri', 'target', 'release', 'app.exe');
const SIDECAR = path.join(ROOT, 'ssim-backend.exe');
const OUT = path.join(ROOT, 'dist-tauri', 'SSIM');

function need(p, hint) {
  if (!fs.existsSync(p)) { console.error(`✗ missing ${path.relative(ROOT, p)} — ${hint}`); process.exit(1); }
}
need(SHELL, 'run: npx tauri build --no-bundle');
need(SIDECAR, 'run: SSIM_BUILD_SIDECAR=1 npm run build:protected');

fs.mkdirSync(OUT, { recursive: true });
// Replace only the binaries — never wipe a data/ or Vault/ a tester created here.
for (const f of ['SSIM.exe', 'ssim-backend.exe']) {
  try { fs.rmSync(path.join(OUT, f), { force: true }); } catch { /* ignore */ }
}
fs.copyFileSync(SHELL, path.join(OUT, 'SSIM.exe'));
fs.copyFileSync(SIDECAR, path.join(OUT, 'ssim-backend.exe'));

const README = [
  'SSIM — Santer Steam Inventory Manager (portable)',
  '',
  'Run SSIM.exe. It opens the SSIM window and starts its backend automatically.',
  'Closing the window quits SSIM completely.',
  '',
  'Your data lives in this folder (data\\, Vault\\, logs\\, mafiles\\). To back up,',
  'copy the Vault\\ folder. To move SSIM to another PC, copy this whole folder.',
  '',
  'Requires the Microsoft Edge WebView2 Runtime (already present on virtually all',
  'up-to-date Windows 10/11 machines). If the window does not open, install it from:',
  '  https://developer.microsoft.com/microsoft-edge/webview2/',
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'README.txt'), README);

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`✓ portable folder → ${path.relative(ROOT, OUT)}`);
console.log(`   SSIM.exe          ${mb(path.join(OUT, 'SSIM.exe'))} MB`);
console.log(`   ssim-backend.exe  ${mb(path.join(OUT, 'ssim-backend.exe'))} MB`);
