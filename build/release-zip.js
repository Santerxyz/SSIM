/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/release-zip.js – assemble the CUSTOMER-facing release zip.
//
//  Run:  npm run release-zip        (after `npm run build:protected`)
//   or:  npm run release            (build:protected + this, one shot)
//
//  Produces  release/SSIM-<version>.zip  containing ONLY what a buyer needs:
//
//      SSIM/
//        ssim.exe          ← the protected binary (frontend bundled INSIDE it)
//        mafiles/          ← EMPTY; customer drops .maFile files here
//        data/             ← EMPTY skeleton; customer activates + fills it
//        START.txt         ← short how-to
//
//  It deliberately does NOT copy the developer's own data/ (real accounts,
//  maFiles, license.key/token, inventories) – that must never ship to a buyer.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;

const EXE = path.join(ROOT, 'ssim.exe');
const RELEASE_DIR = path.join(ROOT, 'release');
const STAGE = path.join(RELEASE_DIR, '_stage');
const APP = path.join(STAGE, 'SSIM');
const ZIP = path.join(RELEASE_DIR, `SSIM-${VERSION}.zip`);

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

// 1. Preconditions.
if (!fs.existsSync(EXE)) fail('ssim.exe not found – run `npm run pack` first.');

// 2. Clean staging.
fs.removeSync(STAGE);
fs.ensureDirSync(APP);

// 3. Copy the shippable bits.
console.log('▸ copying ssim.exe');
fs.copySync(EXE, path.join(APP, 'ssim.exe'));
// NB: the dashboard frontend (public/) is bundled INSIDE ssim.exe (pkg assets),
// so it is deliberately NOT copied here – there is no external, drift-prone
// public/ folder at the customer anymore (fixes the front/backend desync).

// 4. Fresh, EMPTY data + mafiles skeleton (READMEs keep the dirs in the zip).
console.log('▸ creating empty data/ + mafiles/ skeleton');
fs.ensureDirSync(path.join(APP, 'data'));
fs.ensureDirSync(path.join(APP, 'mafiles'));
fs.writeFileSync(
  path.join(APP, 'mafiles', 'PUT_MAFILES_HERE.txt'),
  'Drop your .maFile files here (optionally an accounts.txt with "user:pass" lines),\r\n' +
  'then import them from the SSIM dashboard.\r\n',
);
fs.writeFileSync(
  path.join(APP, 'START.txt'),
  [
    'SSIM – Santer Steam Inventory Manager',
    '======================================',
    '',
    `Version ${VERSION}`,
    '',
    '1. Keep this whole folder together (ssim.exe creates its data\\ folder next to it).',
    '2. Double-click ssim.exe. Your browser opens automatically.',
    '3. On first start, paste your license key to activate.',
    '4. The app updates itself automatically when a new version is released.',
    '',
    'For the full guide, open  READ ME FIRST.txt  in this folder.',
    '',
    'Do NOT move ssim.exe out of this folder.',
  ].join('\r\n') + '\r\n',
);

// 4b. Full customer guide (kept as an editable source file in build/).
const readmeSrc = path.join(ROOT, 'build', 'readme-first.txt');
if (fs.existsSync(readmeSrc)) {
  console.log('▸ copying READ ME FIRST.txt');
  fs.writeFileSync(
    path.join(APP, 'READ ME FIRST.txt'),
    fs.readFileSync(readmeSrc, 'utf8').replace(/\r?\n/g, '\r\n'),
  );
} else {
  console.warn('  • build/readme-first.txt missing – README not bundled');
}

// 5. Zip it (PowerShell Compress-Archive – no extra dependency). The SSIM folder
//    becomes the top-level entry in the archive.
console.log('▸ compressing → ' + path.relative(ROOT, ZIP));
fs.removeSync(ZIP);
execFileSync(
  'powershell',
  ['-NoProfile', '-Command',
    `Compress-Archive -Path '${APP}' -DestinationPath '${ZIP}' -Force`],
  { stdio: 'inherit' },
);

// 6. Tidy staging, report.
fs.removeSync(STAGE);
const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ release ready → ${path.relative(ROOT, ZIP)}  (${mb} MB)\n`);
