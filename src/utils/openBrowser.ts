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

  // A missing/blocked opener (e.g. no xdg-open on PATH) is NOT thrown synchronously —
  // spawn reports it asynchronously as an 'error' event on the detached child. Without
  // a listener that emit is re-thrown as an uncaughtException, so warn-and-continue here.
  const launch = (cmd: string, args: string[], opts: Parameters<typeof spawn>[2]) => {
    const child = spawn(cmd, args, opts);
    child.on('error', (e) =>
      logger.warn(`could not open browser automatically (${e.message}) – open ${url} manually`));
    child.unref();
  };

  try {
    if (process.platform === 'win32') {
      // `start` is a cmd.exe builtin; the empty "" is the (required) window title.
      launch('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      launch('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      launch('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    logger.info(`launching default browser at ${url}`);
  } catch (err) {
    // Keeps the synchronous-arg failure path (constant args → practically unreachable);
    // real spawn-launch failures arrive via the 'error' event above, not this throw.
    logger.warn(`could not open browser automatically (${(err as Error).message}) – open ${url} manually`);
  }
}
