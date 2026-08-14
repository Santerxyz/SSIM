import fs from 'fs';
import http from 'http';
import express from 'express';
import { AccountVault, VAULT_READ_ERROR_PREFIX, VAULT_NEWER_VERSION_ERROR } from './AccountVault';
import { looksLikeOrphanedVaultInstall, normalizeMasterPassword, unlockExistingVault } from './vaultBoot';
import { logger } from '../utils/logger';
import { publicDir } from '../utils/paths';
import { printLockScreen } from '../utils/startupError';
import { listenAndAnnounce, SSIM_HEALTH_PATH, SSIM_HEALTH_MARKER } from '../utils/serverPort';
import { writeCrash } from '../utils/crashlog';

// ════════════════════════════════════════════════════════════════════════════
//  unlockPortal.ts — the APP-WINDOW equivalent of the CLI Master-Password prompt.
//
//  When SSIM runs as a windowed app there is no console to type the password into,
//  so we briefly serve an unlock page on the SAME port the dashboard will use (the
//  exact pattern the license activation portal already uses). The password is taken
//  over loopback BY DEFAULT (HOST=127.0.0.1); a HOST override (e.g. 0.0.0.0) exposes
//  the Master-Password form to the network and is warned at startup. It is used to
//  unlock/create the encrypted vault, and then this
//  portal shuts down so the full dashboard can take the port. The vault key is
//  derived + held server-side exactly as before — only the INPUT method changed.
// ════════════════════════════════════════════════════════════════════════════

const PAGE = publicDir('unlock.html');

/** S18: should the unlock portal REFUSE to create a fresh vault right now? True when there is no vault.enc,
 *  the operator hasn't explicitly confirmed an empty create, AND accounts.json looks orphaned (registered
 *  accounts but a missing vault.enc — partial restore / AV quarantine / unmounted drive). This hoists the
 *  headless-path B36 guard onto the PRIMARY windowed path. Exported for tests. */
export function shouldRefuseEmptyVaultCreate(vaultExists: boolean, createEmptyAnyway: boolean): boolean {
  return !vaultExists && !createEmptyAnyway && looksLikeOrphanedVaultInstall();
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Runs the unlock portal until the vault is unlocked (or created on first run).
 * Resolves once the vault is open and the temp server is closed → the caller then
 * starts the full app on the freed port.
 */
export function runUnlockPortal(port: number, host: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      logger.warn(
        `SECURITY: the vault unlock portal is binding to ${host} – the Master ` +
        `Password form becomes reachable from the network over cleartext HTTP. ` +
        `Only do this on a fully trusted, firewalled host.`,
      );
    }
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
    // Serialize unlock attempts so the escalating delay is real: each queued attempt reads `failed`
    // only AFTER its predecessor has settled, so N parallel wrong-password POSTs can't all sample the
    // same window and run scrypt back-to-back (attempt k waits min(2000, k*400)ms after attempt k-1).
    let attemptQueue: Promise<unknown> = Promise.resolve();

    // Legacy heartbeat endpoint (kept BEFORE the /api/* lock-out so the page ping never 404s);
    // now a harmless no-op — the Tauri shell owns lifecycle.
    app.get('/api/app/ping', (_req, res) => { res.status(204).end(); });

    // SSIM identity marker so the shell confirms this portal is SSIM before navigating. (BUG 2.)
    app.get(SSIM_HEALTH_PATH, (_req, res) => { res.type('text/plain').send(SSIM_HEALTH_MARKER); });

    // The page asks this on load to choose "set a new password" vs "unlock".
    app.get('/api/vault/state', (_req, res) => {
      res.json({ exists: AccountVault.exists() });
    });

    // Defence-in-depth status probe (a stale dashboard tab sees "locked", not data).
    app.get('/api/system/status', (_req, res) => {
      res.json({ licensed: true, activated: true, vaultLocked: true });
    });

    app.post('/api/vault/unlock', async (req, res) => {
      const body = (req.body ?? {}) as { password?: unknown; confirm?: unknown; createEmptyAnyway?: unknown };
      const password = typeof body.password === 'string' ? body.password : '';
      const confirm  = typeof body.confirm === 'string' ? body.confirm : undefined;
      const exists = AccountVault.exists();

      if (!password) return res.status(400).json({ ok: false, error: 'A Master Password is required.' });
      // S18: the headless CLI path refuses to create a fresh empty vault when accounts.json survives but
      // vault.enc is MISSING (an orphaned farm — partial restore, AV quarantine of vault.enc, unmounted
      // drive). The sidecar unlock portal is the PRIMARY (windowed) path and lacked that guard — it would
      // silently create an empty vault OVER the orphan, leaving every account credential-less with no signal.
      // Surface the orphan and require an EXPLICIT acknowledgement before creating. (plaintext is never
      // destroyed, so restoring vault.enc over the empty one still recovers.)
      if (shouldRefuseEmptyVaultCreate(exists, body.createEmptyAnyway === true)) {
        logger.error('[vault] unlock portal: vault.enc is MISSING but accounts.json holds registered accounts – refusing to silently create an empty vault (orphaned install). Restore vault.enc or confirm creating a new empty vault.');
        return res.status(409).json({
          ok: false, orphaned: true,
          error: 'Registered accounts exist but the vault file (vault.enc) is missing — likely a partial restore, an antivirus quarantine, or an unmounted drive. Creating a new vault now would leave every account credential-less. Restore vault.enc (a local vault.enc.bak with the same Master Password is auto-restored) or fix SSIM_HOME and reopen SSIM, or explicitly confirm creating a new empty vault.',
        });
      }
      // H-ACC-066: a FIRST-RUN create (no vault.enc) must double-check the password server-side.
      // The double-entry rule was previously enforced only when the client volunteered a `confirm`
      // field, so any client state that sent none (single-input FALLBACK_HTML, a probe-failed
      // unlock.html stuck in unlock-mode) could CREATE a vault from one unconfirmed entry — a paste
      // typo would lock the vault behind an unknown password (no recovery). Require confirm on creates.
      if (!exists) {
        if (typeof confirm !== 'string') return res.status(400).json({ ok: false, error: 'First run: confirm the new Master Password (reload the unlock page if no confirm field is shown).' });
        // H-ACC-024: compare the NORMALIZED forms — the vault is created off the normalized password,
        // so a trailing space on only one field must not read as a mismatch (nor create a padded vault).
        if (normalizeMasterPassword(confirm) !== normalizeMasterPassword(password)) return res.status(400).json({ ok: false, error: 'The passwords do not match.' });
      }

      // Grow a small delay with each failed attempt (scrypt + loopback already gate). The delay lives
      // INSIDE the serialized attempt so it reads `failed` after the prior attempt settled, not at entry.
      // H-ACC-024: a CREATE is keyed off the normalized password (the single normalization rule); an
      // UNLOCK goes through unlockExistingVault (normalized first, then a verbatim retry that opens a
      // legacy padded vault this same portal created before normalization was unified).
      const opts = { createEmptyAnyway: body.createEmptyAnyway === true };
      const attempt = async () => {
        if (failed > 0) await sleep(Math.min(2_000, failed * 400));
        return exists
          ? unlockExistingVault(password, opts)
          : AccountVault.unlockOrCreate(normalizeMasterPassword(password), opts);
      };
      const result = attemptQueue.then(attempt, attempt);
      attemptQueue = result.then(() => undefined, () => undefined);

      try {
        const { created } = await result;
        logger.info(`[vault] ${created ? 'created' : 'unlocked'} via app-window unlock portal`);
        res.json({ ok: true, created });
        // Let the page receive the response, then free the port + continue boot. The page does NOT
        // reload on a fixed timer — the Tauri shell will NOT re-navigate (one-shot per spawn), so a
        // blind reload could hit the port before startFullApp rebinds it. The page instead polls
        // /api/system/status and reloads only once the full app answers (no vaultLocked:true) — see
        // unlock.html waitForApp (H-ACC-067). So the close→rebind gap here is readiness-gated, not raced.
        setTimeout(() => {
          try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* noop */ }
          server.close(() => resolve());
        }, 800);
      } catch (e) {
        const raw = (e as Error).message;
        // H-ACC-068 / B30: vault.enc was written by a NEWER SSIM (VAULT_VERSION mismatch) — this is NOT a
        // password attempt, so refuse it WITHOUT incrementing `failed` (never arm the brute-force delay for
        // a condition no retyped password can cure) and tell the operator to update SSIM, not to retype.
        if (raw === VAULT_NEWER_VERSION_ERROR) {
          logger.warn('[vault] unlock refused: vault.enc was written by a NEWER SSIM');
          return res.status(400).json({ ok: false, error: 'This vault was created by a NEWER SSIM version. Update SSIM first — do not recreate the vault.' });
        }
        failed++;
        // A VAULT_READ_ERROR:* is a TRANSIENT fs error (vault.enc locked by antivirus / mid-restore),
        // not a bad password — tell the operator to retry rather than surfacing the raw code (H-ACC-037).
        const msg = raw === 'WRONG_PASSWORD' ? 'Incorrect Master Password.'
          : raw.startsWith(VAULT_READ_ERROR_PREFIX) ? 'The vault file is locked by another program (antivirus?) — retry in a moment.'
          : raw;
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

    // BIND FIRST, then announce the ACTUAL bound port (walking EADDRINUSE) — never a port this
    // portal didn't bind, so the shell can't adopt a foreign app on the desired port. (BUG 2.)
    const server = http.createServer(app);
    listenAndAnnounce(server, host, port).then((bound) => {
      logger.info(`vault unlock portal listening on ${host}:${bound}`);
      // Runtime errors AFTER a successful bind (accept-time EMFILE/ENFILE under fd exhaustion,
      // handle-level failures): honor serverPort.ts's caller contract — the portal installs its
      // own runtime 'error' handler once listening, so a socket-layer event is filed as an
      // UNLOCK PORTAL RUNTIME ERROR, not misclassified as an UNCAUGHT EXCEPTION. Mirrors the
      // full-app counterpart in index.ts. (H-ACC-069.)
      server.on('error', (err: NodeJS.ErrnoException) => {
        writeCrash('UNLOCK PORTAL RUNTIME ERROR', err);
        logger.error(`unlock portal runtime error: ${err.message}`);
      });
      // The Tauri shell opens/points the window itself on the SSIM_PORT announce (health-verified, one-shot — src-tauri/src/lib.rs); the portal never opens anything.
    }).catch((err: NodeJS.ErrnoException) => {
      printLockScreen('The unlock server failed to start.', err.message);
      logger.error(`unlock portal listen error: ${err.message}`);
      setTimeout(() => process.exit(1), 250);
    });
  });
}

// Minimal inline fallback if public/unlock.html is somehow missing from the bundle.
// Read-only by design (bundle-defect emergency page): it only surfaces d.error; the S18
// destructive orphan-vault override (createEmptyAnyway) deliberately requires the real page.
const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0a0a0f;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center">
<form onsubmit="event.preventDefault();fetch('/api/vault/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value,confirm:c.value||undefined})}).then(r=>r.json()).then(d=>{if(d.ok){s.textContent='Unlocking - starting SSIM...';var w=function(){fetch('/api/system/status',{cache:'no-store'}).then(r=>r.json()).then(x=>{if(x&&x.vaultLocked!==true){location.replace('/');return}setTimeout(w,500)}).catch(()=>setTimeout(w,500))};setTimeout(w,900)}else{s.textContent=d.error}})">
<div><h2>SSIM - Unlock Vault</h2><input id="p" type="password" placeholder="Master Password" style="padding:8px;width:280px"><br><input id="c" type="password" placeholder="Confirm (first run only)" style="padding:8px;width:280px;margin-top:8px"><br><button style="margin-top:8px">Unlock</button><p id="s" style="color:#c084fc"></p></div></form>`;
