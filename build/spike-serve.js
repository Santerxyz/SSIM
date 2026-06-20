// ────────────────────────────────────────────────────────────────────────────
// spike-serve.js — TEMPORARY Phase-0 helper for the Tauri migration.
//
// Serves the real public/ frontend statically on http://127.0.0.1:3000 so the
// Tauri spike window has something to render WITHOUT booting the full backend
// (which would need a license + interactive vault unlock). This proves the
// Rust/Tauri toolchain compiles here and WebView2 renders the SSIM dashboard
// shell. It is NOT part of the shipped app and will be removed after Phase 0.
// ────────────────────────────────────────────────────────────────────────────
const express = require('express');
const path = require('path');

const app = express();
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));
// Anything not on disk → fall back to index.html so the SPA shell still renders.
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[spike] static frontend on http://127.0.0.1:${PORT}  (serving ${PUBLIC})`);
});
