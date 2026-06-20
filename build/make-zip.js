/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/make-zip.js — package the TAURI release folder into a clean customer ZIP.
//
//  Run:  node build/make-zip.js            (after `npm run build:tauri`)
//  Out:  release/SSIM-<version>.zip
//
//  Two-artifact (Tauri) model: ships SSIM.exe (window shell) + ssim-backend.exe
//  (the app + the WHOLE UI bundled inside it) + an EMPTY data/ + mafiles/ skeleton
//  + READ ME FIRST.txt + START.txt.
//
//  SAFETY (the whole point): the stage is built from an EXPLICIT ALLOW-LIST — only
//  the two exes and the generated text/skeletons are ever copied, so the dev's real
//  data/, Vault/, mafiles/, secrets, logs, license can NEVER reach the ZIP. After
//  zipping it also SCANS every entry against secret patterns and FAILS LOUDLY on any
//  hit. The dev folder is never zipped in place.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const SRC = path.join(ROOT, 'release-tauri', 'SSIM');           // built by make-tauri.js (already clean)
const RELEASE_DIR = path.join(ROOT, 'release');
const STAGE = path.join(RELEASE_DIR, '_stage_zip');
const APP = path.join(STAGE, 'SSIM');
const ZIP = path.join(RELEASE_DIR, `SSIM-${VERSION}.zip`);

const fail = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

// 1. Preconditions — the Tauri build must have produced both artifacts.
for (const f of ['SSIM.exe', 'ssim-backend.exe']) {
  if (!fs.existsSync(path.join(SRC, f))) fail(`${f} not found in release-tauri/SSIM — run \`npm run build:tauri\` first.`);
}

// 2. Fresh stage (never reuse / never the dev folder).
fs.removeSync(STAGE);
fs.ensureDirSync(APP);

// 3. ALLOW-LIST copy: ONLY the two binaries. Nothing else from SRC is touched.
console.log('▸ staging SSIM.exe + ssim-backend.exe (allow-list only)');
fs.copySync(path.join(SRC, 'SSIM.exe'), path.join(APP, 'SSIM.exe'));
fs.copySync(path.join(SRC, 'ssim-backend.exe'), path.join(APP, 'ssim-backend.exe'));

// 4. Empty data/ + mafiles/ skeletons (the app fills them on first launch).
fs.ensureDirSync(path.join(APP, 'data'));
fs.ensureDirSync(path.join(APP, 'mafiles'));
fs.writeFileSync(path.join(APP, 'data', 'README.txt'),
  'This folder fills itself when you run SSIM (your accounts, vault, prices, logs).\r\nNothing to put here.\r\n');
fs.writeFileSync(path.join(APP, 'mafiles', 'PUT_MAFILES_HERE.txt'),
  'Drop your .maFile files here (optionally an accounts.txt with "user:pass" lines),\r\nthen import them from the SSIM dashboard.\r\n');

// 5. READ ME FIRST.txt (full guide) + START.txt (short, Tauri-accurate).
const readmeSrc = path.join(ROOT, 'build', 'readme-first.txt');
if (fs.existsSync(readmeSrc)) {
  fs.writeFileSync(path.join(APP, 'READ ME FIRST.txt'), fs.readFileSync(readmeSrc, 'utf8').replace(/\r?\n/g, '\r\n'));
} else { console.warn('  • build/readme-first.txt missing'); }
fs.writeFileSync(path.join(APP, 'START.txt'), [
  'SSIM — Santer Steam Inventory Manager', '======================================', '',
  `Version ${VERSION}`, '',
  '1. Keep this whole folder together (SSIM.exe + ssim-backend.exe must stay side by side).',
  '2. Double-click SSIM.exe — the SSIM window opens. No console, no browser needed.',
  '3. On first start, paste your license key to activate, then set a vault Master Password.',
  '4. SSIM updates itself automatically when a new version is released.',
  '', 'Close the SSIM window to quit. For the full guide, open READ ME FIRST.txt.',
].join('\r\n') + '\r\n');

// 6. Zip (PowerShell Compress-Archive — the SSIM folder is the top-level entry).
console.log('▸ compressing → ' + path.relative(ROOT, ZIP));
fs.removeSync(ZIP);
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${APP}' -DestinationPath '${ZIP}' -Force`], { stdio: 'inherit' });

// 7. SECURITY SCAN — enumerate every zip entry; FAIL on any secret/user-data pattern.
const listing = execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
  `$z=[System.IO.Compression.ZipFile]::OpenRead('${ZIP}'); ` +
  `$z.Entries | ForEach-Object { '{0}|{1}' -f $_.FullName, $_.Length }; $z.Dispose()`],
  { encoding: 'utf8' });
const entries = listing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .map((l) => { const i = l.lastIndexOf('|'); return { name: l.slice(0, i), size: Number(l.slice(i + 1)) }; });

const SECRET_RE = /vault\.enc|accounts\.json|refresh_tokens|secrets\.local|license\.(key|token)|\.maFile$|\.mafile$|(^|\/)mafiles\/.+\.(maFile|txt)$|\.log$|protection\.json|value_history|inventories.*\.json|prices\.json|ssim\.lock|ssim\.port/i;
const ALLOW_MAFILE_PLACEHOLDER = /mafiles\/PUT_MAFILES_HERE\.txt$/i;
const offenders = entries.filter((e) => SECRET_RE.test(e.name) && !ALLOW_MAFILE_PLACEHOLDER.test(e.name));

console.log('\n=== ZIP CONTENTS (' + entries.length + ' entries) ===');
for (const e of entries) console.log('  ' + e.name + (e.size ? '  (' + (e.size > 1048576 ? (e.size / 1048576).toFixed(1) + ' MB' : e.size + ' B') + ')' : '  <dir>'));

if (offenders.length) {
  console.error('\n✗ SECRET/USER-DATA DETECTED IN ZIP — aborting:');
  for (const o of offenders) console.error('   !! ' + o.name);
  fs.removeSync(ZIP);
  process.exit(1);
}

fs.removeSync(STAGE);
const mb = (fs.statSync(ZIP).size / 1048576).toFixed(1);
console.log(`\n✓ CLEAN release ZIP → ${path.relative(ROOT, ZIP)}  (${mb} MB)  — no secrets/user-data found`);
