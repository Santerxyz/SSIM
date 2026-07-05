import fs from 'fs';
import http from 'http';
import express from 'express';
import { LicenseClient } from './LicenseClient';
import { logger } from '../utils/logger';
import { publicDir } from '../utils/paths';
import { openUiWindow } from '../appWindow';
import { printLockScreen } from './lockscreen';
import { listenAndAnnounce, SSIM_HEALTH_PATH, SSIM_HEALTH_MARKER } from '../utils/serverPort';

// ════════════════════════════════════════════════════════════════════════════
//  ActivationServer – the friendly front door when SSIM is not yet licensed.
//
//  Instead of exiting with a console lock screen, we briefly run a tiny web
//  server on the SAME port the real app would use. It serves a license-entry
//  page; the user pastes their key, we activate it against the backend, persist
//  key + token, then this portal shuts down so the FULL app can take the port.
//
//  Nothing that touches Steam/credentials is constructed here – the security
//  property (no real app until licensed) is preserved.
// ════════════════════════════════════════════════════════════════════════════

const PAGE = publicDir('license.html');

/**
 * Runs the activation portal until the user enters a valid key.
 * Resolves (after the temp server is fully closed) once licensed → caller then
 * starts the real app on the freed port.
 */
export function runActivationPortal(hwid: string, port: number, host: string, version = ''): Promise<void> {
  return new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    // SECURITY — serve ONLY /assets/* (logo, fonts) here, NEVER the whole public/
    // directory. public/ also contains the DASHBOARD (index.html + app.js), and a
    // blanket `express.static(publicDir())` auto-serves index.html at "/" (its
    // default `index:'index.html'`), which shadows the license-page catch-all and
    // LEAKS the full dashboard before any license check. Scoping the static mount
    // to /assets keeps the activation logo/fonts working while making the
    // dashboard physically unreachable until SSIM is licensed.
    app.use('/assets', express.static(publicDir('assets')));
    app.get('/favicon.ico', (_req, res) => {
      const ico = publicDir('favicon.ico');
      if (fs.existsSync(ico)) return res.sendFile(ico);
      res.status(204).end();
    });

    // SSIM identity marker so the Tauri shell confirms THIS portal is SSIM (not a foreign app on
    // the port) before navigating. Registered before the license.html catch-all. (BUG 2.)
    app.get(SSIM_HEALTH_PATH, (_req, res) => { res.type('text/plain').send(SSIM_HEALTH_MARKER); });

    // Current activation state (the page polls this on load).
    app.get('/api/license/state', (_req, res) => {
      res.json({ activated: false, hwid });
    });

    // Boot-status probe the dashboard's client-guard hits on load. While this
    // portal is running the app is BY DEFINITION not licensed → the dashboard JS
    // sees `licensed:false` and redirects itself to the activation screen
    // (defence-in-depth; the routing above already refuses to serve the dashboard).
    app.get('/api/system/status', (_req, res) => {
      res.json({ licensed: false, activated: false, hwid, version });
    });

    // The actual activation attempt.
    app.post('/api/license/activate', async (req, res) => {
      const key = String((req.body ?? {}).key ?? '').trim();
      if (!key) return res.status(400).json({ ok: false, error: 'Please enter your license key.' });

      logger.info('activation portal: trying key…');
      LicenseClient.saveKey(key);                 // persist for future auto-starts
      const result = await LicenseClient.activate(key, hwid);
      if (!result.ok) {
        logger.warn(`activation failed: ${result.reason}`);
        return res.status(400).json({ ok: false, error: result.reason });
      }

      logger.info(`activation OK (tier=${result.payload?.tier ?? '?'}) – handing over to the app`);
      res.json({ ok: true, tier: result.payload?.tier ?? null });

      // Let the browser receive the response, then free the port + continue boot.
      setTimeout(() => {
        try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* noop */ }
        server.close(() => resolve());
      }, 800);
    });

    // Any OTHER API route is BLOCKED while unlicensed — a hard 403 with a clear
    // error code (never the HTML page) so a stale dashboard tab gets a clean,
    // detectable signal instead of silently parsing license.html as JSON.
    app.all('/api/*', (_req, res) => {
      res.status(403).json({ error: 'SSIM is not licensed on this device.', code: 'LICENSE_MISSING' });
    });

    // Serve the license page for every other (non-API) route, so ANY URL the user
    // opens shows the activation screen — never the dashboard.
    app.get('*', (_req, res) => {
      if (fs.existsSync(PAGE)) return res.sendFile(PAGE);
      res.type('html').send(FALLBACK_HTML);
    });

    // BIND FIRST, then announce the ACTUAL bound port (walking EADDRINUSE). The port is emitted to
    // the shell only after this portal actually binds it, so the shell never adopts a foreign app
    // holding the desired port. (BUG 2.)
    const server = http.createServer(app);
    listenAndAnnounce(server, host, port).then((bound) => {
      // eslint-disable-next-line no-console
      console.log(
        `\n  \x1b[35m\x1b[1m◆ SSIM\x1b[0m\x1b[2m  ·  License required\x1b[0m\n` +
        `  \x1b[2m────────────────────────────────────────────────\x1b[0m\n` +
        `   Open \x1b[1mhttp://localhost:${bound}\x1b[0m and enter your\n` +
        `   license key to activate SSIM.\n` +
        `  \x1b[2m────────────────────────────────────────────────\x1b[0m\n`,
      );
      logger.info(`license activation portal listening on ${host}:${bound}`);
      openUiWindow(`http://localhost:${bound}`);
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        printLockScreen(
          `Port ${port} is already in use.`,
          'Is SSIM already running? Close the other instance, or set PORT=<free> and restart.',
        );
        logger.error(`activation portal cannot bind ${host}:${port} – EADDRINUSE (walk exhausted)`);
      } else {
        printLockScreen('The activation server failed to start.', err.message);
        logger.error(`activation portal listen error: ${err.message}`);
      }
      setTimeout(() => process.exit(1), 250);
    });
  });
}

// Minimal inline fallback if public/license.html is somehow missing.
const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0a0a0f;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center">
<form onsubmit="event.preventDefault();fetch('/api/license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k.value.trim().toUpperCase()})}).then(r=>r.json()).then(d=>{if(d.ok){s.textContent='Activated – starting…';setTimeout(()=>location.reload(),2000)}else{s.textContent=d.error}})">
<div><h2>SSIM – Activate License</h2><input id="k" placeholder="SSIM-XXXX-XXXX-XXXX-XXXX" style="padding:8px;width:280px"><button>Activate</button><p id="s" style="color:#c084fc"></p></div></form>`;
