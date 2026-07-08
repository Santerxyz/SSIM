/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/make-ico.js – packs the pre-rendered build/icons/logo_<size>.png set
//  into a single multi-resolution Windows icon (build/icon.ico) and mirrors it
//  to public/favicon.ico for the dashboard.
//
//  ICO container with PNG-compressed entries (supported since Windows Vista):
//    ICONDIR (6 bytes) → ICONDIRENTRY[n] (16 bytes each) → raw PNG blobs.
//
//  Run:  node build/make-ico.js     (also invoked by build/pack.js)
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'build', 'icons');
const SIZES = [256, 128, 64, 48, 32, 16];

const OUT_ICO = path.join(ROOT, 'build', 'icon.ico');
const OUT_FAVICON = path.join(ROOT, 'public', 'favicon.ico');

const entries = SIZES.map((size) => {
  const file = path.join(ICON_DIR, `logo_${size}.png`);
  const rel = path.relative(ROOT, file);
  if (!fs.existsSync(file)) {
    console.error(`✗ missing ${rel} – regenerate the icon PNG set first.`);
    process.exit(1);
  }
  const png = fs.readFileSync(file);
  // Validate the bytes match the filename: PNG signature + IHDR dimensions (width@16, height@20, big-endian).
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) {
    console.error(`✗ ${rel} is not a PNG`);
    process.exit(1);
  }
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== size || h !== size) {
    console.error(`✗ ${rel} is ${w}×${h}, expected ${size}×${size} – regenerate the icon PNG set.`);
    process.exit(1);
  }
  return { size, png };
});

const HEADER_LEN = 6;
const ENTRY_LEN = 16;

const header = Buffer.alloc(HEADER_LEN);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(entries.length, 4);

let offset = HEADER_LEN + ENTRY_LEN * entries.length;
const dir = Buffer.alloc(ENTRY_LEN * entries.length);
entries.forEach((e, i) => {
  const base = i * ENTRY_LEN;
  dir.writeUInt8(e.size === 256 ? 0 : e.size, base);     // width  (0 = 256)
  dir.writeUInt8(e.size === 256 ? 0 : e.size, base + 1); // height (0 = 256)
  dir.writeUInt8(0, base + 2);            // palette colours (none)
  dir.writeUInt8(0, base + 3);            // reserved
  dir.writeUInt16LE(1, base + 4);         // colour planes
  dir.writeUInt16LE(32, base + 6);        // bits per pixel
  dir.writeUInt32LE(e.png.length, base + 8);
  dir.writeUInt32LE(offset, base + 12);
  offset += e.png.length;
});

const ico = Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
fs.writeFileSync(OUT_ICO, ico);
fs.writeFileSync(OUT_FAVICON, ico);
console.log(`✓ icon.ico written (${entries.length} sizes, ${(ico.length / 1024).toFixed(0)} KB) → build/icon.ico + public/favicon.ico`);
