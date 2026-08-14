import fs from 'fs';
import type { Server } from 'http';
import { dataDir, IS_SIDECAR_MODE } from './paths';
import { getCapabilityToken } from '../api/capability';
import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
//  serverPort — bind the UI port first, announce it ONLY after a successful bind.
//
//  The old flow published the port (SSIM_PORT stdout + data/ssim.port) from a TOCTOU
//  pre-check (findFreePort) before the real server bound, and fell back to PORT on any
//  error — so SSIM could announce a port it never bound. Combined with the shell's
//  bare-TCP readiness probe, SSIM could open onto a DIFFERENT app already holding the
//  port. Here the announce happens strictly inside the successful `listening` callback,
//  with the ACTUAL bound port, walking EADDRINUSE to the next free port instead of dying.
// ════════════════════════════════════════════════════════════════════════════

const PORT_FILE = dataDir('ssim.port');
const MAX_PORT_WALK = 20;

/** An unauthenticated marker route every SSIM server (full app + activation/unlock portals) serves,
 *  so the Tauri shell can confirm the responder on the port is SSIM — not a foreign app that merely
 *  accepts TCP — before it navigates to it. Kept out of the capability/origin guards (a bare GET). */
export const SSIM_HEALTH_PATH = '/__ssim/health';
export const SSIM_HEALTH_MARKER = 'SSIM-DASHBOARD-OK';

let announcedPort: number | undefined;
let capEmitted = false;

/** The UI port this process has actually bound + announced (undefined before any bind). */
export function boundUiPort(): number | undefined { return announcedPort; }

/** Remove a stale data/ssim.port so it can never point the shell at a foreign port. Call ONLY at BOOT
 *  (before we bind), and only as the sole instance — the single-instance lock guarantees any file present
 *  is a prior run's. Do not call this on exit: a refused second instance would delete the live instance's
 * file — use clearOwnPortFile() there instead. */
export function clearStalePortFile(): void {
  try { fs.rmSync(PORT_FILE, { force: true }); } catch { /* best-effort */ }
}

/** S52: remove data/ssim.port ONLY if it still names the port this process announced. On exit that means a
 *  refused second instance (which never announced) leaves the live instance's file untouched, and even the
 *  real instance never deletes a file that has since been rewritten to another live port. */
export function clearOwnPortFile(): void {
  if (announcedPort === undefined) return; // we never announced → not ours to clear
  try {
    const cur = fs.readFileSync(PORT_FILE, 'utf8').trim();
    if (cur === String(announcedPort)) fs.rmSync(PORT_FILE, { force: true });
  } catch { /* no file / unreadable → nothing to clear */ }
}

/**
 * Binds `server` to the UI port and ANNOUNCES it (SSIM_CAP + data/ssim.port + SSIM_PORT) ONLY
 * after the bind SUCCEEDS — never a port this process did not bind. The first bind walks from
 * `desiredPort` over EADDRINUSE to the first free port; a LATER bind (the full app taking over
 * from an activation/unlock portal) reuses the same announced port (released by the previous
 * server) and does not walk. Resolves the ACTUAL bound port; rejects on a non-address error or
 * after exhausting the walk. The caller installs its own runtime error handler after this resolves.
 */
export function listenAndAnnounce(server: Server, host: string, desiredPort: number, tries = MAX_PORT_WALK): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const walkStart = announcedPort ?? desiredPort;
    const canWalk = announcedPort === undefined; // a re-bind must land on the already-announced port
    let port = walkStart;

    const cleanup = (): void => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onListening = (): void => {
      cleanup();
      const a = server.address();
      const actual = (a && typeof a === 'object' && typeof a.port === 'number') ? a.port : port;
      announce(actual);
      resolve(actual);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      // -1 so exactly `tries` ports are attempted (walkStart … walkStart+tries-1), matching MAX_PORT_WALK
      if (err.code === 'EADDRINUSE' && canWalk && port < walkStart + tries - 1) {
        port += 1;
        if (port > 65535) { // TCP ceiling — treat as walk-exhausted so the caller shows the EADDRINUSE lockscreen, not a raw RangeError from server.listen(65536)
          cleanup();
          reject(Object.assign(new Error('port walk exhausted (reached TCP ceiling)'), { code: 'EADDRINUSE' }));
          return;
        }
        setImmediate(() => { try { server.listen(port, host); } catch (e) { cleanup(); reject(e as Error); } });
        return;
      }
      cleanup();
      reject(err);
    };

    server.on('error', onError);
    server.on('listening', onListening);
    try { server.listen(port, host); } catch (e) { cleanup(); reject(e as Error); }
  });
}

function announce(port: number): void {
  announcedPort = port;
  logger.info(`SSIM UI bound on ${port}`);
  if (!IS_SIDECAR_MODE) return; // no shell to hand the port to (browser/Edge build opens the URL itself)
  // Emit the capability token once (before the port) so the shell can inject it as the window opens.
  try { if (!capEmitted) { process.stdout.write(`SSIM_CAP=${getCapabilityToken()}\n`); capEmitted = true; } } catch { /* stdout may be closed */ }
  try { fs.writeFileSync(PORT_FILE, String(port)); } catch { /* best-effort fallback file */ }
  try { process.stdout.write(`SSIM_PORT=${port}\n`); } catch { /* stdout may be closed */ }
}

/** Test-only: reset the module's announced-port state between cases. */
export function _resetForTest(): void { announcedPort = undefined; capEmitted = false; }
