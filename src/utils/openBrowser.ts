import { spawn } from 'child_process';
import { logger } from './logger';
import { IS_PACKAGED } from './paths';

// ════════════════════════════════════════════════════════════════════════════
//  openBrowser – pop the operator's default browser at the SSIM URL on boot.
//
//  Best-effort and fully detached: if it fails, the server still runs and the
//  console banner shows the URL to open manually.
//
//  Behaviour:
//   • packaged exe → opens automatically (what a customer expects on launch)
//   • dev runs     → does NOT open (avoids a browser tab on every `npm run dev`),
//                    unless SSIM_OPEN_BROWSER=1
//   • SSIM_NO_BROWSER=1 → never opens (headless servers / CI)
// ════════════════════════════════════════════════════════════════════════════

export function openBrowser(url: string): void {
  if (process.env.SSIM_NO_BROWSER === '1') return;
  if (!IS_PACKAGED && process.env.SSIM_OPEN_BROWSER !== '1') return;

  try {
    if (process.platform === 'win32') {
      // `start` is a cmd.exe builtin; the empty "" is the (required) window title.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    logger.info(`opened browser at ${url}`);
  } catch (err) {
    logger.warn(`could not open browser automatically (${(err as Error).message}) – open ${url} manually`);
  }
}
