// ════════════════════════════════════════════════════════════════════════════
//  Lockscreen – the single place that renders a hard license failure.
//  Kept tiny + dependency-free so it works even if the rest fails to wire up.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const R = '\x1b[0m', B = '\x1b[1m', RED = '\x1b[31m', D = '\x1b[2m', Y = '\x1b[33m';

/** Prints a loud, unmissable license-failure banner to the console. */
export function printLockScreen(reason: string, detail?: string): void {
  const line = '─'.repeat(56);
  // eslint-disable-next-line no-console
  console.error(
    `\n  ${RED}${B}■ SSIM – LICENSE DENIED${R}\n` +
    `  ${D}${line}${R}\n` +
    `   ${RED}${reason}${R}\n` +
    (detail ? `   ${D}${detail}${R}\n` : '') +
    `  ${D}${line}${R}\n` +
    `   ${Y}Contact: Discord: Santer.xyz${R}\n`,
  );
  // A double-clicked packaged exe often has no visible console, so the banner above is
  // invisible. Also write a minimal styled page and open it ONCE in the browser (#52).
  showLockPage(reason, detail);
}

let lockPageShown = false;
function showLockPage(reason: string, detail?: string): void {
  if (lockPageShown) return; // avoid spamming a tab per failure
  lockPageShown = true;
  try {
    const esc = (s: string): string =>
      String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const html =
      `<!doctype html><meta charset="utf-8"><title>SSIM — License</title>` +
      `<style>body{background:#0b0f17;color:#e2e8f0;font:15px/1.6 system-ui,Segoe UI,sans-serif;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
      `.card{max-width:520px;padding:32px;border:1px solid #1e293b;border-radius:16px;background:#0f172a}` +
      `h1{color:#f43f5e;font-size:18px;margin:0 0 12px}.d{color:#94a3b8;font-size:13px;margin:8px 0}` +
      `.m{font-family:ui-monospace,monospace}.c{color:#a78bfa;margin-top:16px;font-weight:600}</style>` +
      `<div class="card"><h1>■ SSIM — License Denied</h1><div class="d">${esc(reason)}</div>` +
      (detail ? `<div class="d m">${esc(detail)}</div>` : '') +
      `<div class="c">Contact: Discord — Santer.xyz</div></div>`;
    const file = path.join(os.tmpdir(), 'ssim-license-error.html');
    fs.writeFileSync(file, html, 'utf8');
    // Windows: `start "" <file>` opens the default browser, detached.
    const child = spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true });
    // The 'error' listener is mandatory – Node re-throws an unlistened async 'error'
    // (ENOENT off a stripped PATH, EPERM under AppLocker) as an uncaughtException. The
    // outer try/catch cannot catch that async emission; the console banner is the fallback.
    child.on('error', () => { /* browser open failed – console banner is the fallback */ });
    child.unref();
  } catch { /* best-effort: the console banner is the fallback */ }
}
