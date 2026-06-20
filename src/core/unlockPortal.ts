import fs from 'fs';
import express from 'express';
import { AccountVault } from './AccountVault';
import { logger } from '../utils/logger';
import { publicDir } from '../utils/paths';
import { openUiWindow } from '../appWindow';
import { printLockScreen } from '../licensing/lockscreen';

// ════════════════════════════════════════════════════════════════════════════
//  unlockPortal.ts — the APP-WINDOW equivalent of the CLI Master-Password prompt.
//
//  When SSIM runs as a windowed app there is no console to type the password into,
//  so we briefly serve an unlock page on the SAME port the dashboard will use (the
//  exact pattern the license activation portal already uses). The password is taken
//  over LOOPBACK ONLY, used to unlock/create the encrypted vault, and then this
//  portal shuts down so the full dashboard can take the port. The vault key is
//  derived + held server-side exactly as before — only the INPUT method changed.
// ════════════════════════════════════════════════════════════════════════════

const PAGE = publicDir('unlock.html');

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Runs the unlock portal until the vault is unlocked (or created on first run).
 * Resolves once the vault is open and the temp server is closed → the caller then
 * starts the full app on the freed port.
 */
export function runUnlockPortal(port: number, host: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    // Serve ONLY /assets here (logo/fonts) — never the whole public/ dir, so the
    // dashboard (index.html) can't be reached while the vault is still locked.
    app.use('/assets', express.static(publicDir('assets')));
    app.get('/favicon.ico', (_req, res) => {
      const ico = publicDir('favicon.ico');
      if (fs.existsSync(ico)) return res.sendFile(ico);
      res.status(204).end();
    });

    let failed = 0; // brute-force throttle (loopback-only, but defence in depth)

    // Legacy heartbeat endpoint (kept BEFORE the /api/* lock-out so the page ping never 404s);
    // now a harmless no-op — the Tauri shell owns lifecycle.
    app.get('/api/app/ping', (_req, res) => { res.status(204).end(); });

    // The page asks this on load to choose "set a new password" vs "unlock".
    app.get('/api/vault/state', (_req, res) => {
      res.json({ exists: AccountVault.exists() });
    });

    // Defence-in-depth status probe (a stale dashboard tab sees "locked", not data).
    app.get('/api/system/status', (_req, res) => {
      res.json({ licensed: true, activated: true, vaultLocked: true });
    });

    app.post('/api/vault/unlock', async (req, res) => {
      const body = (req.body ?? {}) as { password?: unknown; confirm?: unknown };
      const password = typeof body.password === 'string' ? body.password : '';
      const confirm  = typeof body.confirm === 'string' ? body.confirm : undefined;
      const exists = AccountVault.exists();

      if (!password) return res.status(400).json({ ok: false, error: 'A Master Password is required.' });
      if (!exists && confirm !== undefined && confirm !== password) {
        return res.status(400).json({ ok: false, error: 'The passwords do not match.' });
      }

      // Grow a small delay with each failed attempt (scrypt + loopback already gate).
      if (failed > 0) await sleep(Math.min(2_000, failed * 400));

      try {
        const { created } = AccountVault.unlockOrCreate(password);
        logger.info(`[vault] ${created ? 'created' : 'unlocked'} via app-window unlock portal`);
        res.json({ ok: true, created });
        // Let the page receive the response, then free the port + continue boot.
        setTimeout(() => {
          try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* noop */ }
          server.close(() => resolve());
        }, 800);
      } catch (e) {
        failed++;
        const raw = (e as Error).message;
        const msg = raw === 'WRONG_PASSWORD' ? 'Incorrect Master Password.' : raw;
        logger.warn(`[vault] app-window unlock attempt failed: ${msg}`);
        res.status(400).json({ ok: false, error: msg });
      }
    });

    // Any OTHER API route is locked out until the vault opens.
    app.all('/api/*', (_req, res) => {
      res.status(423).json({ error: 'SSIM vault is locked.', code: 'VAULT_LOCKED' });
    });

    // Every non-API route shows the unlock page (never the dashboard).
    app.get('*', (_req, res) => {
      if (fs.existsSync(PAGE)) return res.sendFile(PAGE);
      res.type('html').send(FALLBACK_HTML);
    });

    const server = app.listen(port, host, () => {
      logger.info(`vault unlock portal listening on ${host}:${port}`);
      openUiWindow(`http://localhost:${port}`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      printLockScreen('The unlock server failed to start.', err.message);
      logger.error(`unlock portal listen error: ${err.message}`);
      setTimeout(() => process.exit(1), 250);
    });
  });
}

// Minimal inline fallback if public/unlock.html is somehow missing from the bundle.
const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0a0a0f;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center">
<form onsubmit="event.preventDefault();fetch('/api/vault/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})}).then(r=>r.json()).then(d=>{if(d.ok){s.textContent='Unlocking - starting SSIM...';setTimeout(()=>location.reload(),2200)}else{s.textContent=d.error}})">
<div><h2>SSIM - Unlock Vault</h2><input id="p" type="password" placeholder="Master Password" style="padding:8px;width:280px"><button>Unlock</button><p id="s" style="color:#c084fc"></p></div></form>`;
