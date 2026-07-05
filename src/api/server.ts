import path from 'path';
import fs from 'fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';

import { AccountManager } from '../core/AccountManager';
import { SessionManager } from '../core/SessionManager';
import { AccountImportService } from '../core/AccountImportService';
import { CsFloatService } from '../csfloat/CsFloatService';
import { CsFloatAutoAcceptWorker } from '../csfloat/CsFloatAutoAcceptWorker';
import type { ListingSearchParams } from '../csfloat/CsFloatClient';
import { AppSettings } from '../core/AppSettings';
import { InventoryService } from '../core/InventoryService';
import { ValueHistoryService, GLOBAL_SERIES } from '../core/ValueHistoryService';
import { ProcessHealth } from '../core/ProcessHealth';
import { MoneyOpJournal } from '../core/MoneyOpJournal';
import { AccountVault } from '../core/AccountVault';
import { importDropZoneIntoVault, importCsvIntoVault, importExternalVault } from '../core/vaultBoot';
import { loadMaFileFromDisk } from '../core/maFiles';
import { canConfirm } from '../core/accountCapability';
import { loadMaFile, generateTotpCode, msUntilNextTotp } from '../core/LoginFlow';
import { buildIsolatedSession, launchIsolatedBrowser } from '../trading/cleanBrowser';
import { LicenseClient } from '../licensing/LicenseClient';
import { getAvailableUpdate, getBlockedUpdate, getPriorCrash, getUpdateOutcome } from '../licensing/updateStatus';
import { checkOnly, canInstallNow, installNow, isUpdateOpInFlight } from '../licensing/updateScheduler';
import { TradeService, type AccountOffers, type OfferAction, type OfferActionTarget } from '../trading/TradeService';
import { MarketService, type MassSellGroup } from '../trading/MarketService';
import { BuyService } from '../trading/BuyService';
import { BanService } from '../trading/BanService';
import { TradeUpService } from '../trading/TradeUpService';
import { CasketService } from '../trading/CasketService';
import { GcActionLayer } from '../trading/GcActionLayer';
import { cs2Schema } from '../core/Cs2SchemaService';
import type { SellStrategy } from '../pricing/MarketPricing';
import { AgentFactory, normalizeProxy, parseProxy } from '../network/AgentFactory';
import { PricingService } from '../pricing/PricingService';
import { currencyInfo } from '../pricing/currencies';
import { ExchangeRateService } from '../pricing/ExchangeRateService';

import type { AccountConfig, NetworkConfig, Environment } from '../types/account';
import type { AccountInventory } from '../types/inventory';
import { logger, LOG_FILE, redactSecrets, recentLogLines, liveLogBus, type LiveLogLine } from '../utils/logger';
import { maFilesDir, publicDir, IS_SIDECAR_MODE } from '../utils/paths';
import { sameOriginGuard } from './originGuard';
import { capabilityGuard, injectCapabilityIntoHtml } from './capability';
import { SSIM_HEALTH_PATH, SSIM_HEALTH_MARKER } from '../utils/serverPort';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

// Single maFiles home (root ./mafiles): registered + not-yet-imported files
// live together; the import list simply filters out registered accounts.
const MAFILES_DIR = maFilesDir();
const POST_TRADE_REFRESH_MS = 8_000; // wait for Steam to actually move the items before refetching
const LOG_TAIL_BYTES = 512 * 1024;   // per-account logs modal reads only the tail (non-blocking)

// ── Money-operation route matcher (circuit-breaker gate, #16 / B13) ────────────
// Every POST that spends money, moves an asset, or approves a pending confirmation
// must be refused while ProcessHealth has money ops quarantined (possibly-corrupt
// in-memory state). Case-insensitive (Express routing is); the (\/|$) anchor keeps
// read-ish siblings (buy-price / search / *-status / listings/:id edits) OUT. Exported
// so the route-set is unit-testable (a new money route must be added here too).
//   • Steam market/trade: trade send/mass-send/offer-action/offers-batch, market
//     buy/sell/cancel-listing/cancel-buy-order/folder-buy, tradeup/execute, casket/move.
//   • CSFloat REAL-CASH ops: csfloat/<user>/{buy, listings (create), buy-orders (create)}.
//   • Mobile confirmation approval: accounts/<user>/confirmations/respond (finalizes trades).
export const MONEY_OP_ROUTE = /^\/api\/(?:(?:trade\/(?:send|mass-send|offer-action|offers-batch)|market\/(?:buy|sell|cancel-listing|cancel-buy-order|folder-buy)|tradeup\/execute|casket\/move)(?:\/|$)|(?:csfloat\/[^/]+\/(?:buy|listings|buy-orders)|accounts\/[^/]+\/confirmations\/respond)$)/i;

// ════════════════════════════════════════════════════════════════════════════
//  Dependency wiring
// ════════════════════════════════════════════════════════════════════════════

export interface ApiDeps {
  accounts:  AccountManager;
  sessions:  SessionManager;
  trades:    TradeService;
  market:    MarketService;
  buy:       BuyService;
  bans:      BanService;
  inventory: InventoryService;
  pricing:   PricingService;
  exchange:  ExchangeRateService;
  history:   ValueHistoryService;
  gc:        GcActionLayer;
  tradeup:   TradeUpService;
  casket:    CasketService;
  accountImport: AccountImportService;
  csfloat:       CsFloatService;
  csfloatWorker: CsFloatAutoAcceptWorker;
}

/** Creates the core services and wires their lifecycle events into the logger. */
export function createDeps(): ApiDeps {
  const accounts  = new AccountManager();
  const sessions  = new SessionManager();
  const inventory = new InventoryService(sessions, accounts);
  // One shared money-op journal (B4): a crash mid buy/send can't be double-fired by a user retry after
  // restart. Shared so buy and send op-hashes live in one file.
  const moneyJournal = new MoneyOpJournal();
  // Trades gets the inventory cache so the send path can refuse trade-locked / non-tradable
  // assets before an offer is created (INV-D1 / C3).
  const trades    = new TradeService(sessions, accounts, inventory, moneyJournal);
  // Market gets the inventory cache so a completed mass-sell moves the just-listed assets
  // Owned→Listed immediately (optimistic), rather than waiting on a follow-up refresh.
  const market    = new MarketService(trades, inventory);
  const buy       = new BuyService(trades, inventory, moneyJournal);
  const bans      = new BanService(accounts, sessions, trades);
  // Feature 2 "CSFloat": per-account marketplace control. Built BEFORE pricing so the
  // CSFloat price source (Feature 3) can reuse it.
  const csfloat   = new CsFloatService(accounts);
  const pricing   = new PricingService(csfloat);
  const exchange  = new ExchangeRateService();
  // Shared GC action layer (trade-up + casket execution; gated behind SSIM_GC_VERIFIED).
  const gc        = new GcActionLayer(sessions);
  const tradeup   = new TradeUpService(inventory, pricing, cs2Schema, gc);
  const casket    = new CasketService(gc, inventory);
  // GC-preferred reader so the worth curve counts GC records (incl. listed items), not just web.
  const history   = new ValueHistoryService(
    accounts,
    { get: (u) => inventory.getCached(u, 'cs2') }, // CS2 (GC-preferred merged view)
    { get: (u) => inventory.getCached(u, 'tf2') }, // TF2 (parallel worth curve)
    pricing, exchange,
  );
  exchange.start();

  // One value-history point per settled refresh (worth/wallet curve).
  inventory.onRefreshComplete((reason, game) => history.snapshotAll(reason, game));

  // The 'error' listener is mandatory – Node throws on an unhandled 'error' event.
  sessions.on('error',        (u, e) => logger.error(`[${u}] ${e.message}`));
  sessions.on('disconnected', (u, r) => logger.warn(`[${u}] disconnected: ${r}`));
  // Cache each account's permanent SteamID on its first login (write-through to accounts.json),
  // so it's resolvable WITHOUT a login forever after — used by the ban checker and any feature
  // needing a SteamID. getSteamID64() is an exact string (the maFile's numeric value is lossy).
  sessions.on('loggedIn',     (u, steamId) => { if (steamId) accounts.rememberSteamId(u, steamId); });

  // Feature 1 "Account Login": QR / credentials import → token-first Limited accounts.
  const accountImport = new AccountImportService(accounts, sessions);
  // Feature 2 "CSFloat": auto-accept delivery worker (CsFloatService is built above, before pricing).
  const csfloatWorker = new CsFloatAutoAcceptWorker(accounts, trades, csfloat);
  csfloatWorker.start();

  return { accounts, sessions, trades, market, buy, bans, inventory, pricing, exchange, history, gc, tradeup, casket, accountImport, csfloat, csfloatWorker };
}

// ════════════════════════════════════════════════════════════════════════════
//  Express app
// ════════════════════════════════════════════════════════════════════════════

export function createApp(deps: ApiDeps): Express {
  const { accounts, sessions, trades, market, buy, bans, inventory, pricing, exchange, history, tradeup, casket, accountImport, csfloat } = deps;
  const app = express();

  const VALID_STRATEGIES: SellStrategy[] = ['lowest', 'undercut', 'custom'];

  /** Reads + validates a custom EUR-cent price (required only for strategy='custom'). */
  const readCustomCents = (raw: unknown): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
  };

  /**
   * Overlays an account's MANUAL trade-protection date onto a (possibly cached)
   * inventory so it shows as locked instantly, without waiting for a live refresh.
   * Account-level protection applies uniformly to every item, so stacks stay valid.
   */
  const applyManualLock = (inv: AccountInventory): AccountInventory => {
    const acc = accounts.get(inv.username);
    const until = acc?.protectedUntil ? new Date(acc.protectedUntil) : null;
    if (until && until.getTime() > Date.now()) {
      const iso = until.toISOString();
      for (const it of inv.items) {
        const cur = it.tradeLockExpiry ? new Date(it.tradeLockExpiry) : null;
        if (!cur || until > cur) it.tradeLockExpiry = iso as unknown as Date;
      }
    }
    return inv;
  };

  /**
   * Re-derives each item's strict dashboard bucket from its FINAL lock state
   * (after the manual-protection overlay), so a manual lock correctly flips an
   * item into 'tradelocked'. 'listed' is sticky (market-sourced, never in-inv).
   * Only meaningful for GC-sourced inventories (the web view doesn't categorise).
   */
  const tagCategories = (inv: AccountInventory): void => {
    const now = Date.now();
    for (const it of inv.items) {
      if (it.category === 'listed') continue;
      const locked = it.tradeLockExpiry ? new Date(it.tradeLockExpiry).getTime() > now : false;
      it.category = locked ? 'tradelocked' : 'tradable';
    }
  };

  /** Enriches an inventory with cached prices + manual protection; queues misses. */
  const enrichInv = (inv: AccountInventory): AccountInventory => {
    const missing = pricing.enrich(inv);
    if (missing.length) pricing.ensureFilled(missing);
    applyManualLock(inv);
    if (inv.source === 'gc') tagCategories(inv);
    return inv;
  };

  // ── Security hardening ─────────────────────────────────────────────────────
  // 1) NO CORS layer: the dashboard is served same-origin from this very server,
  //    so no cross-origin caller is ever legitimate. (An open `cors()` would let
  //    any website the operator visits script against this credential-bearing API.)
  // 2) Host-header allowlist (anti DNS-rebinding): a malicious page can point its
  //    own domain at 127.0.0.1 and bypass the browser's same-origin protection –
  //    the Host header is the reliable tell. Enforced only for the default
  //    loopback deployment; an explicit HOST=<LAN-IP> opt-in skips the check.
  const boundHost = process.env.HOST ?? '127.0.0.1';
  const LOOPBACK_BOUND = boundHost === '127.0.0.1' || boundHost === 'localhost' || boundHost === '::1';
  if (LOOPBACK_BOUND) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const host = hostnameOnly(req.headers.host ?? '');
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return next();
      logger.warn(`blocked request with foreign Host header "${req.headers.host}" (possible DNS rebinding)`);
      res.status(403).json({ error: 'Forbidden' });
    });
  }
  // 2b) Anti-CSRF (#26, defense-in-depth atop the Host allow-list): reject a MUTATING
  //     request whose Origin/Referer is a FOREIGN site, so a malicious page the operator
  //     visits cannot drive this credential-bearing API. Same-origin and tool requests
  //     (no Origin) pass. NOTE: this does NOT authenticate other LOCAL processes — a
  //     boot-token cookie is the recommended next step for that (AUDIT_LEDGER #26).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const src = req.headers.origin ?? req.headers.referer;
    if (typeof src === 'string' && src) {
      try {
        const host = new URL(src).hostname.toLowerCase();
        // Allow the server's OWN origin — including a deliberate LAN HOST=<ip> opt-in, where
        // the dashboard is served from that host so its same-origin POSTs carry that Origin.
        const ok = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === boundHost.toLowerCase();
        if (!ok) {
          logger.warn(`blocked cross-origin ${req.method} ${req.path} from "${src}"`);
          return res.status(403).json({ error: 'Forbidden (cross-origin request)' });
        }
      } catch { return res.status(403).json({ error: 'Forbidden (malformed Origin)' }); }
    }
    next();
  });
  // 3) JSON body limit raised: mass-send/mass-sell payloads with thousands of
  //    asset ids exceed express' 100kb default (→ silent HTTP 413 failures).
  app.use(express.json({ limit: '5mb' }));
  // SECURITY (B25): redact secrets from EVERY JSON error string in one place. Many money/route
  // handlers return `(err as Error).message` verbatim; a proxied axios/steamcommunity failure can
  // embed the account's proxy URL (user:pass@host) in that message. Wrapping res.json here masks
  // it on all ~20 error sites at once (and any future one) without touching each handler.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const orig = res.json.bind(res);
    res.json = (body: unknown) => {
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        (body as { error: string }).error = redactSecrets((body as { error: string }).error);
      }
      return orig(body);
    };
    next();
  });
  // SECURITY: same-origin / anti-CSRF + DNS-rebind guard (see originGuard.ts). Mounted FIRST
  // so it covers the page load and every /api route: a malicious web page the operator visits
  // cannot drive state-changing money calls (trade/buy/sell) against the localhost API.
  app.use(sameOriginGuard);
  // SECURITY (B26/P5): the capability-token guard authenticates the dashboard to the
  // backend so a random LOCAL process cannot drive money/vault ops even by forging Origin.
  // Mounted after the origin guard, before the routes.
  app.use(capabilityGuard);

  // SSIM identity marker (unauthenticated GET): lets the Tauri shell confirm the responder on the
  // UI port is SSIM — not a foreign app that merely accepts TCP — before it navigates. (BUG 2.)
  app.get(SSIM_HEALTH_PATH, (_req: Request, res: Response) => { res.type('text/plain').send(SSIM_HEALTH_MARKER); });

  // Serve index.html with the capability bootstrap injected in dev / Edge (no shell). In
  // sidecar (Tauri) mode the shell injects window.__SSIM_CAP__ out-of-band, so index.html
  // is served CLEAN (a scraping GET / must not reveal the token). Placed BEFORE static.
  const serveIndex = (_req: Request, res: Response): void => {
    try {
      const file = path.join(publicDir(), 'index.html');
      let html = fs.readFileSync(file, 'utf8');
      if (!IS_SIDECAR_MODE) html = injectCapabilityIntoHtml(html);
      res.type('html').send(html);
    } catch { res.status(500).send('index.html not found'); }
  };
  app.get('/', serveIndex);
  app.get('/index.html', serveIndex);

  app.use(express.static(publicDir()));

  // Legacy heartbeat endpoint — the bundled dashboard still pings it; now a harmless no-op
  // (the Tauri shell owns lifecycle). Kept so older pages don't 404. Public + side-effect-free.
  app.get('/api/app/ping', (_req, res) => { res.status(204).end(); });

  // Live Logs launcher for the Tauri shell: the dashboard can't open a window from inside the
  // WebView (Tauri blocks window.open + withholds IPC from http:// content), so it POSTs here and
  // we emit a control line on stdout that the shell reads to open the native logs window. No-op
  // outside sidecar mode (the browser/Edge build opens it directly via window.open). Same-origin
  // guarded like every other mutating route.
  app.post('/api/app/open-logs', (_req, res) => {
    if (IS_SIDECAR_MODE) { try { process.stdout.write('SSIM_OPEN_LOGS\n'); } catch { /* stdout closed */ } }
    res.status(204).end();
  });

  // Frontend error sink (S30): the WebView2 renderer has no visible console, so an uncaught error /
  // unhandled rejection in app.js otherwise vanishes. The dashboard's global handlers POST here so the
  // failure lands in the same (rotated) log the operator reads via Live Logs / shell.log. Loopback-only,
  // side-effect-trivial (a capped log write), and capability-exempt like open-logs so it also works
  // while the session is capless. Every field is length-bounded and the handler never throws.
  app.post('/api/app/client-error', (req, res) => {
    try {
      const b = (req.body || {}) as { message?: unknown; source?: unknown; stack?: unknown };
      const msg = String(b.message ?? '').slice(0, 2000);
      const where = String(b.source ?? '').slice(0, 300).replace(/[\r\n]+/g, ' ');
      const stack = String(b.stack ?? '').slice(0, 2000);
      logger.error(`[ui] ${msg}${where && where !== ':' ? ` @ ${where}` : ''}${stack ? `\n${stack}` : ''}`);
    } catch { /* the error sink must never itself throw */ }
    res.status(204).end();
  });

  // Live log stream (Server-Sent Events) for the in-app "Live Logs" window: backfill the
  // recent ring buffer, then push each new (already-redacted) line as it is logged. Read-only,
  // loopback-only, and self-cleaning — the per-connection listener is removed on disconnect.
  app.get('/api/logs/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      Connection:          'keep-alive',
      'X-Accel-Buffering':  'no',
    });
    res.write('retry: 3000\n\n'); // EventSource auto-reconnects 3s after a drop
    for (const line of recentLogLines()) res.write(`data: ${JSON.stringify(line)}\n\n`);

    // Coalesced delivery (anti-flood): a fleet-wide refresh emits hundreds of lines/sec.
    // Pushing each straight to the socket fires one EventSource 'message' per line in the
    // window's WebView — a burst big enough to choke it. Instead we BUFFER incoming lines
    // and flush on a short timer, and cap how many we forward per flush: a storm beyond the
    // cap is dropped and summarised with one synthetic line, so the live view stays bounded
    // no matter the backend rate. The full log is always intact in the ring buffer + file.
    const FLUSH_MS = 120;
    const MAX_PER_FLUSH = 60;             // ≤ 60 lines / 120ms ≈ 500/s ceiling to the window
    let buf: LiveLogLine[] = [];
    let dead = false;
    const flush = (): void => {
      if (dead || buf.length === 0) return;
      const batch = buf;
      buf = [];
      const overflow = batch.length - MAX_PER_FLUSH;
      const out = overflow > 0 ? batch.slice(0, MAX_PER_FLUSH) : batch;
      try {
        for (const line of out) res.write(`data: ${JSON.stringify(line)}\n\n`);
        if (overflow > 0) {
          const note: LiveLogLine = { t: out[out.length - 1]?.t ?? '', level: 'warn',
            msg: `… ${overflow} more log line(s) suppressed in the live view (high-volume burst — full log is in error.log)` };
          res.write(`data: ${JSON.stringify(note)}\n\n`);
        }
      } catch { dead = true; /* client gone — stop writing */ }
    };
    const onLine = (line: LiveLogLine): void => { buf.push(line); };
    liveLogBus.on('line', onLine);
    const flushTimer = setInterval(flush, FLUSH_MS);
    flushTimer.unref?.();
    const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* noop */ } }, 25_000);
    keepAlive.unref?.();
    req.on('close', () => {
      dead = true;
      liveLogBus.removeListener('line', onLine);
      clearInterval(flushTimer);
      clearInterval(keepAlive);
    });
  });

  // 4) Money-operation circuit breaker (#16): once the process quarantines money ops
  //    after an internal error burst, refuse NEW money POSTs (buy/sell/trade) with an
  //    actionable 503 instead of acting on possibly-corrupt in-memory state. Reads and
  //    existing sessions stay up; the operator restarts to recover.
  // The route-set lives in the exported MONEY_OP_ROUTE (unit-tested); it now also
  // covers the CSFloat real-cash ops and the mobile-confirmation approval that the
  // original regex missed (B13).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' && ProcessHealth.moneyOpsBlocked() && MONEY_OP_ROUTE.test(req.path)) {
      return res.status(503).json({
        error: `Money operations are paused: ${ProcessHealth.blockReason()}. Restart SSIM and verify state before retrying.`,
        quarantined: true,
      });
    }
    next();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Environments (v2.0 top level)
  // ════════════════════════════════════════════════════════════════════════

  app.get('/api/environments', (_req: Request, res: Response) => {
    res.json(accounts.getEnvironments().map(e => ({
      ...sanitizeEnvironment(e),
      accountCount: accounts.countInEnvironment(e.id),
    })));
  });

  app.post('/api/environments', (req: Request, res: Response) => {
    const { name, proxy, color } = req.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name is required' });
    }
    try {
      const env = accounts.createEnvironment(name, typeof proxy === 'string' && proxy.trim() ? normalizeProxy(proxy) : '', color);
      res.status(201).json(sanitizeEnvironment(env));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/environments/:id', (req: Request, res: Response) => {
    if (!accounts.getEnvironment(req.params.id)) {
      return res.status(404).json({ error: `Environment "${req.params.id}" not found` });
    }
    const { name, proxy, color } = req.body ?? {};
    try {
      const env = accounts.updateEnvironment(req.params.id, { name, proxy: typeof proxy === 'string' && proxy.trim() ? normalizeProxy(proxy) : proxy, color });
      res.json(sanitizeEnvironment(env));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/environments/:id', (req: Request, res: Response) => {
    if (!accounts.getEnvironment(req.params.id)) {
      return res.status(404).json({ error: `Environment "${req.params.id}" not found` });
    }
    try {
      accounts.deleteEnvironment(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // ── GET /api/environments/:id/proxy ────────────────────────────────────────
  // Returns the environment's proxy UN-redacted so the edit dialog can pre-fill
  // the field with the exact saved string (the list view stays redacted via
  // sanitizeEnvironment). Clearing that field on save sends proxy:'' → the env
  // (and every account inheriting it) runs on the local IP. Localhost-only; the
  // operator is explicitly editing their own environment.
  app.get('/api/environments/:id/proxy', (req: Request, res: Response) => {
    const env = accounts.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: `Environment "${req.params.id}" not found` });
    // Vault-aware: in vault mode the proxy lives encrypted in the vault, not in accounts.json (B20).
    res.json({ proxy: accounts.envProxyFor(req.params.id) });
  });

  // ── GET /api/environments/:envId/tree ──────────────────────────────────────
  app.get('/api/environments/:envId/tree', (req: Request, res: Response) => {
    if (!accounts.getEnvironment(req.params.envId)) {
      return res.status(404).json({ error: `Environment "${req.params.envId}" not found` });
    }
    res.json(sanitizeTree(accounts.getTree(req.params.envId)));
  });

  // ── GET /api/environments/:id/check-proxy ──────────────────────────────────
  // Pings api.ipify.org through the environment's proxy (or local IP) and
  // returns the egress IP + latency so the UI can show green/red health.
  app.get('/api/environments/:id/check-proxy', asyncHandler(async (req, res) => {
    const env = accounts.getEnvironment(req.params.id);
    if (!env) {
      return res.status(404).json({ error: `Environment "${req.params.id}" not found` });
    }

    const proxy = accounts.envProxyFor(req.params.id); // vault-aware (B20)
    const network: NetworkConfig = proxy
      ? { type: 'proxy', value: proxy }
      : { type: 'localip', value: '0.0.0.0' };
    // pooled:false → a throwaway agent this handler can safely .destroy() in `finally`
    // without tearing down the shared local-IP keepAlive pool that live sessions use.
    const { httpsAgent } = AgentFactory.create(network, { pooled: false });

    const started = Date.now();
    try {
      const resp = await axios.get('https://api.ipify.org?format=json', {
        httpsAgent,
        proxy: false,           // never use env-var proxy – only our per-env agent
        timeout: 10_000,
        validateStatus: () => true,
      });
      const latencyMs = Date.now() - started;
      const ip = resp.data && typeof resp.data.ip === 'string' ? resp.data.ip : null;

      if (resp.status !== 200 || !ip) {
        logger.warn(`[proxy-check] ${env.name}: HTTP ${resp.status} (${latencyMs} ms)`);
        return res.json({ ok: false, mode: network.type, latencyMs, error: `HTTP ${resp.status}` });
      }
      // Geo-locate the egress IP (best-effort, DIRECT – an IP's geo is the same
      // regardless of route, so this need not traverse the proxy). Free, key-less.
      let country: string | null = null, countryCode: string | null = null;
      try {
        const geo = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, {
          proxy: false,
          timeout: 6_000,
          validateStatus: () => true,
        });
        if (geo.status === 200 && geo.data && geo.data.status === 'success') {
          country     = typeof geo.data.country === 'string' ? geo.data.country : null;
          countryCode = typeof geo.data.countryCode === 'string' ? geo.data.countryCode : null;
        }
      } catch { /* geo is optional – never fail the proxy check over it */ }
      logger.info(`[proxy-check] ${env.name}: OK ${ip}${countryCode ? ` (${countryCode})` : ''} (${latencyMs} ms, ${network.type})`);
      return res.json({ ok: true, mode: network.type, ip, country, countryCode, latencyMs });
    } catch (err) {
      const latencyMs = Date.now() - started;
      // Redact: a proxied-request failure embeds the proxy URL incl. user:pass creds.
      const message = redactSecrets((err as Error).message);
      logger.warn(`[proxy-check] ${env.name}: FAILED ${message} (${latencyMs} ms)`);
      return res.json({ ok: false, mode: network.type, latencyMs, error: message });
    } finally {
      // This per-request agent is single-use. The localip branch builds a
      // keepAlive https.Agent whose idle socket would otherwise linger and slowly
      // accumulate across repeated health-check polls. Long-lived per-session
      // agents are created in SessionManager and never pass through here.
      try { (httpsAgent as { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Accounts
  // ════════════════════════════════════════════════════════════════════════

  app.get('/api/accounts', (_req: Request, res: Response) => {
    res.json(accounts.getAll().map(sanitizeAccount));
  });

  // Body: { username, password, maFilePath, environmentId, proxy?, displayName? }
  app.post('/api/accounts', (req: Request, res: Response) => {
    const { username, password, maFilePath, environmentId, proxy, displayName } = req.body ?? {};

    const missing = ['username', 'password', 'maFilePath', 'environmentId']
      .filter(k => typeof req.body?.[k] !== 'string' || req.body[k].trim() === '');
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing/invalid fields: ${missing.join(', ')}` });
    }

    const networkOverride: NetworkConfig | undefined =
      typeof proxy === 'string' && proxy.trim() ? { type: 'proxy', value: normalizeProxy(proxy.trim()) } : undefined;

    try {
      // VAULT MODE: load the maFile from the drop zone now, store the secret in the vault,
      // and keep accounts.json secret-free. Plaintext mode: store on disk as before.
      let vaultMaFile;
      if (AccountVault.isEnabled()) {
        try { vaultMaFile = loadMaFileFromDisk(maFilePath.trim()); }
        catch (e) { return res.status(400).json({ error: `maFile: ${(e as Error).message}` }); }
      }
      const account = accounts.add({
        username:        username.trim(),
        password:        AccountVault.isEnabled() ? '' : password,
        maFilePath:      maFilePath.trim(),
        environmentId:   environmentId.trim(),
        networkOverride: AccountVault.isEnabled() ? undefined : networkOverride,
        displayName:     typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined,
      });
      if (AccountVault.isEnabled() && vaultMaFile) {
        try {
          AccountVault.upsertAccount({
            username: username.trim(), password, maFile: vaultMaFile,
            proxy: networkOverride?.type === 'proxy' ? networkOverride.value : undefined,
          });
        } catch (e) {
          accounts.remove(username.trim()); // roll back the org entry so the two stores never diverge
          throw e;
        }
      }
      res.status(201).json(sanitizeAccount(account));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 1 — Account Login (QR / credentials import → LIMITED tier)
  //  steam-session negotiates a refresh token; the account then logs in
  //  token-first with no maFile. Sell/trade confirmations stay gated until a
  //  maFile is attached (→ Full) via /attach-mafile.
  // ════════════════════════════════════════════════════════════════════════

  app.post('/api/accounts/login/qr/start', asyncHandler(async (req, res) => {
    const environmentId = typeof req.body?.environmentId === 'string' ? req.body.environmentId : '';
    try {
      res.status(201).json(await accountImport.startQr(environmentId));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  app.post('/api/accounts/login/credentials', asyncHandler(async (req, res) => {
    const { username, password, environmentId } = req.body ?? {};
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    try {
      const status = await accountImport.startCredentials({
        accountName: username, password, environmentId: typeof environmentId === 'string' ? environmentId : '',
      });
      res.status(201).json(status);
    } catch (err) {
      const msg = (err as Error).message || 'login failed';
      res.status(/RateLimit/i.test(msg) ? 429 : 400).json({ error: msg });
    }
  }));

  app.get('/api/accounts/login/:sessionId/status', (req: Request, res: Response) => {
    const status = accountImport.getStatus(req.params.sessionId);
    if (!status) return res.status(404).json({ error: 'login session not found or expired' });
    res.json(status);
  });

  app.post('/api/accounts/login/:sessionId/guard', asyncHandler(async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code.trim()) return res.status(400).json({ error: 'a Steam Guard code is required' });
    try {
      res.json(await accountImport.submitGuard(req.params.sessionId, code));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message || 'invalid code' });
    }
  }));

  app.post('/api/accounts/login/:sessionId/cancel', (req: Request, res: Response) => {
    accountImport.cancel(req.params.sessionId);
    res.json({ ok: true });
  });

  // ── POST /api/accounts/:username/attach-mafile  → upgrade LIMITED to FULL ─────
  app.post('/api/accounts/:username/attach-mafile', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const maFilePath = typeof req.body?.maFilePath === 'string' ? req.body.maFilePath.trim() : '';
    if (!maFilePath) {
      return res.status(400).json({ error: 'maFilePath is required (drop the maFile into ./mafiles and pass its filename)' });
    }
    let maFile;
    try { maFile = loadMaFileFromDisk(maFilePath); }
    catch (e) { return res.status(400).json({ error: `maFile: ${(e as Error).message}` }); }
    if (!maFile.identity_secret) {
      return res.status(400).json({ error: 'maFile has no identity_secret — it cannot confirm trades, so it will not upgrade this account to Full' });
    }
    // Vault mode: store the secret in the vault so accounts.json stays secret-free.
    if (AccountVault.isEnabled()) {
      const existing = AccountVault.getAccount(account.username);
      AccountVault.upsertAccount({
        username: account.username,
        password: existing?.password ?? '',
        maFile,
        proxy: existing?.proxy,
      });
    }
    const updated = accounts.update(account.username, { tier: 'full', maFilePath });
    // Reload the live session so it picks up the freshly-attached maFile (identity_secret).
    // Otherwise a still-resident LIMITED session keeps session.maFile === undefined and
    // cannot confirm trades until its next re-login — a "Full" account that can't confirm.
    // (INV-A1 / C5.) Best-effort: never fail the upgrade on a logout hiccup.
    try { await sessions.logoutAccount(account.username); }
    catch (e) { logger.warn(`[${account.username}] post-attach session reload failed: ${(e as Error).message}`); }
    logger.info(`[${account.username}] maFile attached → upgraded to FULL (session reloaded)`);
    res.json(sanitizeAccount(updated));
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Phase-6 — Account Master View tools (per SELECTED account): SDA overview
  //  (Steam Guard OTP + live mobile confirmations) and "Open in clean browser".
  //  All REUSE the canonical primitives — generateTotpCode (OTP), getConfirmations/
  //  conf.respond via AccountTrader (confirmations), the session/login flow (web
  //  cookies) and the per-account resolved proxy. No second source / parser.
  // ════════════════════════════════════════════════════════════════════════

  // Current Steam Guard code for ONE account (OTP is offline — no login needed). The
  // shared_secret NEVER leaves the backend; only the 5-char code is returned.
  app.get('/api/accounts/:username/otp', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    let maFile;
    try { maFile = loadMaFile(account); }
    catch { return res.status(400).json({ error: 'this account has no maFile (no Steam Guard secret) — cannot show a code' }); }
    if (!maFile.shared_secret) return res.status(400).json({ error: 'maFile has no shared_secret — cannot generate a code' });
    res.json({ code: generateTotpCode(maFile.shared_secret), msRemaining: msUntilNextTotp() });
  }));

  // Live pending mobile confirmations for ONE account (reuses AccountTrader.listConfirmations).
  app.get('/api/accounts/:username/confirmations', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    try {
      const trader = await trades.ensureWebSession(account.username);
      res.json({ confirmations: await trader.listConfirmations() });
    } catch (e) {
      res.status(502).json({ error: `could not load confirmations: ${(e as Error).message}` });
    }
  }));

  // Approve / deny confirmations (single, multi, or ALL); the UI re-fetches from truth after.
  app.post('/api/accounts/:username/confirmations/respond', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const body = req.body ?? {};
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const accept = body.accept !== false; // default = approve
    const all = body.all === true;
    if (!all && ids.length === 0) return res.status(400).json({ error: 'ids[] required (or all:true)' });
    try {
      const trader = await trades.ensureWebSession(account.username);
      res.json(await trader.respondToConfirmations(ids, accept, all));
    } catch (e) {
      res.status(502).json({ error: `confirmation action failed: ${(e as Error).message}` });
    }
  }));

  // Open ONE account in an isolated, proxied, ephemeral browser (its own session only).
  app.post('/api/accounts/:username/open-browser', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    let session;
    try { session = await sessions.loginAccount(account); }
    catch (e) { return res.status(502).json({ error: `could not establish this account's web session: ${(e as Error).message}` }); }
    const spec = buildIsolatedSession({
      username: account.username,
      cookieStrings: session.webSession?.cookies ?? [],
      network: account.network,
    });
    // Safety: a configured-but-unresolvable proxy must NOT degrade to the host IP.
    if (account.network?.type === 'proxy' && !spec.proxyServer) {
      return res.status(400).json({ error: 'could not resolve this account\'s proxy — refusing to open (would leak the host IP)', warnings: spec.warnings });
    }
    try {
      const r = await launchIsolatedBrowser(spec);
      res.json({ ok: true, proxy: r.proxyUsed, proxyAuth: r.proxyAuthApplied, warnings: spec.warnings });
    } catch (e) {
      res.status(500).json({ error: `could not open clean browser: ${(e as Error).message}`, warnings: spec.warnings });
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 2 — CSFloat management (per account). Documented core is always on;
  //  buy-orders / trades / inventory / auto-accept are gated behind the global
  //  `csfloatExperimental` flag (undocumented endpoints — opt-in).
  // ════════════════════════════════════════════════════════════════════════

  app.get('/api/csfloat/config', (_req: Request, res: Response) => {
    res.json({ experimental: AppSettings.isCsfloatExperimental() });
  });
  app.put('/api/csfloat/config', (req: Request, res: Response) => {
    if (typeof req.body?.experimental === 'boolean') AppSettings.setCsfloatExperimental(req.body.experimental);
    res.json({ experimental: AppSettings.isCsfloatExperimental() });
  });

  // ── Feature 3: app-wide price source (Steam ⟷ CSFloat). `effective` reflects the
  //    no-key → Steam fallback so the UI can show what's actually pricing. ──
  app.get('/api/pricing/source', (_req: Request, res: Response) => {
    res.json({ preference: AppSettings.getPriceSource(), effective: pricing.getSource() });
  });
  app.put('/api/pricing/source', (req: Request, res: Response) => {
    const s = req.body?.source === 'csfloat' ? 'csfloat' : 'steam';
    pricing.setSource(s);
    res.json({ preference: AppSettings.getPriceSource(), effective: pricing.getSource() });
  });

  // Resolve the account or 404 (returns null after responding). Defined here so it
  // closes over `accounts`; used only by the CSFloat routes below.
  const csAccount = (req: Request, res: Response): AccountConfig | null => {
    const acc = accounts.get(req.params.username);
    if (!acc) { res.status(404).json({ error: `Account "${req.params.username}" not found` }); return null; }
    return acc;
  };
  const requireExperimental = (res: Response): boolean => {
    if (!AppSettings.isCsfloatExperimental()) {
      res.status(403).json({ error: 'CSFloat experimental features are off — enable them in CSFloat → Settings' });
      return false;
    }
    return true;
  };

  // ── key management (masked; never returns the raw key) ──
  app.get('/api/csfloat/:username/key', (req: Request, res: Response) => {
    if (!csAccount(req, res)) return;
    res.json(csfloat.keyInfo(req.params.username));
  });
  app.put('/api/csfloat/:username/key', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    try {
      const r = await csfloat.setKey(req.params.username, apiKey);
      res.json({ ok: true, ...csfloat.keyInfo(req.params.username), warning: r.warning });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  }));
  app.delete('/api/csfloat/:username/key', (req: Request, res: Response) => {
    if (!csAccount(req, res)) return;
    try {
      csfloat.clearKey(req.params.username);
      res.json({ ok: true, configured: false });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  // ── documented core ──
  app.get('/api/csfloat/:username/me', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    try { res.json(await csfloat.me(req.params.username)); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.get('/api/csfloat/:username/listings/search', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    try { res.json(await csfloat.search(req.params.username, parseSearch(req.query as Record<string, unknown>))); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.get('/api/csfloat/:username/listings', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    try { res.json(await csfloat.myListings(req.params.username, { page: numQ(req.query.page), limit: numQ(req.query.limit) })); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.post('/api/csfloat/:username/listings', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    const { asset_id, price, type, description } = req.body ?? {};
    if (typeof asset_id !== 'string' || !asset_id) return res.status(400).json({ error: 'asset_id is required' });
    // Price floor (B13/B17): a create-listing price must be ≥ 1 cent and within a sane
    // ceiling — the same validation the PATCH edit-price route already enforces. Without
    // it a fat-fingered/forged 0 or negative price would be forwarded to CSFloat verbatim.
    const priceCents = Math.round(Number(price));
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 100_000_000) {
      return res.status(400).json({ error: 'price (cents) must be an integer between 1 and 100000000' });
    }
    try {
      res.status(201).json(await csfloat.createListing(req.params.username, {
        asset_id,
        type: type === 'auction' ? 'auction' : 'buy_now',
        price: priceCents,
        description: typeof description === 'string' ? description : undefined,
      }));
    } catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.get('/api/csfloat/:username/listing/:id', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    try { res.json(await csfloat.getListing(req.params.username, req.params.id)); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.delete('/api/csfloat/:username/listings/:id', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    try { res.json({ ok: true, result: await csfloat.delist(req.params.username, req.params.id) }); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.patch('/api/csfloat/:username/listings/:id', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    const price = Number(req.body?.price);
    if (!Number.isFinite(price) || price < 1) return res.status(400).json({ error: 'price (cents) is required' });
    try { res.json({ ok: true, result: await csfloat.editPrice(req.params.username, req.params.id, Math.round(price)) }); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.post('/api/csfloat/:username/buy', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    const listingId = typeof req.body?.listingId === 'string' ? req.body.listingId : '';
    const totalPrice = Number(req.body?.totalPrice);
    if (!listingId || !Number.isFinite(totalPrice) || totalPrice < 1) {
      return res.status(400).json({ error: 'listingId and totalPrice (cents) are required' });
    }
    try { res.json({ ok: true, result: await csfloat.buy(req.params.username, listingId, Math.round(totalPrice)) }); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));

  // ── experimental (flag-gated) ──
  app.get('/api/csfloat/:username/buy-orders', asyncHandler(async (req, res) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    try { res.json(await csfloat.buyOrders(req.params.username, { page: numQ(req.query.page), limit: numQ(req.query.limit) })); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.post('/api/csfloat/:username/buy-orders', asyncHandler(async (req, res) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    const { market_hash_name, expression, max_price, quantity } = req.body ?? {};
    if (!Number.isFinite(Number(max_price)) || !Number.isFinite(Number(quantity))) {
      return res.status(400).json({ error: 'max_price (cents) and quantity are required' });
    }
    try {
      res.status(201).json(await csfloat.createBuyOrder(req.params.username, {
        market_hash_name: typeof market_hash_name === 'string' ? market_hash_name : undefined,
        expression: typeof expression === 'string' ? expression : undefined,
        max_price: Math.round(Number(max_price)),
        quantity: Math.round(Number(quantity)),
      }));
    } catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.delete('/api/csfloat/:username/buy-orders/:id', asyncHandler(async (req, res) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    try { res.json({ ok: true, result: await csfloat.deleteBuyOrder(req.params.username, req.params.id) }); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.get('/api/csfloat/:username/trades', asyncHandler(async (req, res) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    try { res.json(await csfloat.trades(req.params.username, { page: numQ(req.query.page), limit: numQ(req.query.limit), state: typeof req.query.state === 'string' ? req.query.state : undefined })); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.get('/api/csfloat/:username/inventory', asyncHandler(async (req, res) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    try { res.json(await csfloat.inventory(req.params.username)); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.get('/api/csfloat/:username/auto-accept', (req: Request, res: Response) => {
    if (!csAccount(req, res)) return;
    res.json({ enabled: csfloat.getAutoAccept(req.params.username) });
  });
  app.put('/api/csfloat/:username/auto-accept', (req: Request, res: Response) => {
    const acc = csAccount(req, res); if (!acc) return;
    if (!requireExperimental(res)) return;
    const enabled = !!req.body?.enabled;
    if (enabled && acc.tier === 'limited') {
      return res.status(400).json({ error: 'Limited accounts cannot auto-deliver sales (no maFile to confirm). Attach a maFile to upgrade to Full first.' });
    }
    csfloat.setAutoAccept(req.params.username, enabled);
    res.json({ enabled: csfloat.getAutoAccept(req.params.username) });
  });

  // ── PATCH /api/accounts/:username ──────────────────────────────────────────
  // Edits an existing account. Body: { displayName?, proxy?, password?, maFilePath? }.
  //   proxy: a per-account override that WINS over the environment proxy.
  //          - non-empty string → set/replace the account proxy
  //          - empty string ""  → FORCE the account onto its local IP (no proxy),
  //                               even when its environment has a proxy. This is an
  //                               explicit `localip` override, so it sticks: the
  //                               account keeps running locally until a proxy is set
  //                               again. (The dashboard's "clear the field = run
  //                               locally" behaviour relies on this.)
  //          - null             → drop the per-account override entirely so the
  //                               account inherits its environment proxy again.
  //          - key absent       → leave the proxy unchanged
  // Changing the proxy logs the account out so the NEXT refresh re-logs-in through
  // the new network (the live session still holds the old agent).
  app.patch('/api/accounts/:username', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });

    const { displayName, proxy, password, maFilePath } = req.body ?? {};
    const changes: Partial<AccountConfig> = {};

    if (typeof displayName === 'string') changes.displayName = displayName.trim() || undefined;
    if (typeof maFilePath === 'string' && maFilePath.trim()) changes.maFilePath = maFilePath.trim();

    // proxy: absent = unchanged; null = inherit env; '' = force local IP; string = set proxy.
    const proxyChanged = proxy !== undefined;

    if (AccountVault.isEnabled()) {
      // Secrets (password / maFile / proxy) → the vault; accounts.json stays secret-free.
      let v = AccountVault.getAccount(account.username);
      if (!v) {
        // Orphan (in accounts.json but not vaulted, e.g. a failed migration). It still holds
        // its RECOVERABLE plaintext password in accounts.json (enterVaultMode keeps non-vaulted
        // ones), so seed the vault record from that — NEVER from a blank, which would mask the
        // real password and break login. Only heal when we have a password AND a usable maFile.
        const seedPw = (typeof password === 'string' && password.length) ? password : account.password;
        if (seedPw) {
          try {
            const mf = loadMaFileFromDisk((typeof maFilePath === 'string' && maFilePath.trim()) ? maFilePath.trim() : account.maFilePath);
            v = { username: account.username, password: seedPw, maFile: mf };
          } catch { v = undefined; }
        }
      }
      if (v) {
        if (typeof password === 'string' && password.length) v.password = password;
        if (typeof maFilePath === 'string' && maFilePath.trim()) {
          try { v.maFile = loadMaFileFromDisk(maFilePath.trim()); }
          catch (e) { return res.status(400).json({ error: `maFile: ${(e as Error).message}` }); }
        }
        if (proxyChanged) {
          v.proxy = (typeof proxy === 'string' && proxy.trim()) ? normalizeProxy(proxy.trim()) : undefined;
        }
        AccountVault.upsertAccount(v);
      }
      if (proxyChanged) {
        // For a token-only / LIMITED account there is no full VaultAccount to hold the proxy, so
        // a supplied proxy would otherwise be SILENTLY DROPPED → the account logs in over the
        // wrong egress IP (ban risk, B42). Persist it in the vault's per-account proxy map instead.
        if (!v) {
          const val = (typeof proxy === 'string' && proxy.trim()) ? normalizeProxy(proxy.trim()) : undefined;
          AccountVault.setAccountProxy(account.username, val); // undefined (null/'') clears it
        } else {
          AccountVault.setAccountProxy(account.username, undefined); // full record now owns it; drop any stray map entry
        }
        // a proxy string lives in the vault; a forced-local ('') override is a non-secret
        // bind kept in accounts.json; null/string clear the org override.
        const forcedLocal = typeof proxy === 'string' && !proxy.trim();
        changes.networkOverride = forcedLocal ? { type: 'localip', value: '0.0.0.0' } : undefined;
      }
    } else {
      if (typeof password === 'string' && password.length) changes.password = password;       // blank = unchanged
      if (proxyChanged) {
        if (proxy === null) {
          changes.networkOverride = undefined;                                // null → inherit environment proxy
        } else {
          const p = typeof proxy === 'string' ? proxy.trim() : '';
          changes.networkOverride = p
            ? { type: 'proxy',   value: normalizeProxy(p) }                   // set/replace the account proxy
            : { type: 'localip', value: '0.0.0.0' };                          // '' → force local IP (no proxy)
        }
      }
    }

    try {
      const updated = accounts.update(account.username, changes);
      // The new proxy only applies on the next login → drop the current session.
      if (proxyChanged) await sessions.logoutAccount(account.username).catch(() => undefined);
      res.json(sanitizeAccount(updated));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // ── GET /api/accounts/:username/proxy ──────────────────────────────────────
  // Returns the account's OWN proxy override UN-redacted, so the edit dialog can
  // pre-fill the input with the exact saved string (the list/tree views stay
  // redacted via sanitizeAccount). Localhost-only, credential-bearing API – the
  // operator is explicitly opening their own account to edit it.
  //   proxy:  the raw own-override proxy ('' when the account has none)
  //   source: where the account's network currently comes from, for the UI hint
  app.get('/api/accounts/:username/proxy', (req: Request, res: Response) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const envProxy = accounts.getEnvironment(account.environmentId)?.proxy?.trim() ?? '';
    let ownProxy = '';
    let hasOverride = false;
    let source: 'override' | 'environment' | 'local';
    if (AccountVault.isEnabled()) {
      // The per-account proxy override lives in the VAULT; a forced-local bind may remain
      // in accounts.json. (Reading networkOverride here would misreport — it's blanked.)
      // Include a token-only account's per-account map entry (B42) so the edit dialog shows it.
      const vp = (AccountVault.getAccount(account.username)?.proxy?.trim()
        ?? AccountVault.getAccountProxy(account.username)) ?? '';
      const forcedLocal = account.networkOverride?.type === 'localip';
      ownProxy = vp;
      hasOverride = !!vp || forcedLocal;
      source = vp ? 'override' : (forcedLocal ? 'local' : (envProxy ? 'environment' : 'local'));
    } else {
      const ov = account.networkOverride;
      ownProxy = ov && ov.type === 'proxy' ? ov.value : '';
      hasOverride = !!ov;
      // own override (proxy or forced-local) → 'override'/'local'; else inherits env or plain local.
      source = ov ? (ov.type === 'proxy' ? 'override' : 'local') : (envProxy ? 'environment' : 'local');
    }
    res.json({ proxy: ownProxy, source, hasEnvProxy: !!envProxy, hasOverride });
  });

  // ── DELETE /api/accounts/:username ─────────────────────────────────────────
  // Removes the account, logs out its session and drops its cached inventory.
  app.delete('/api/accounts/:username', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    await sessions.logoutAccount(account.username).catch(() => undefined);
    inventory.store.delete(account.username);
    inventory.tf2Store.delete(account.username);
    inventory.gcStore.delete(account.username);
    accounts.remove(account.username);
    AccountVault.removeAccount(account.username); // drop its secrets + refresh token from the vault
    res.json({ ok: true });
  }));

  // ── Soft-hide / unhide (session keeps running) ─────────────────────────────
  app.post('/api/accounts/:username/hide', (req: Request, res: Response) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    accounts.update(account.username, { hidden: true });
    res.json(sanitizeAccount(accounts.get(account.username)!));
  });

  app.post('/api/accounts/:username/unhide', (req: Request, res: Response) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    accounts.update(account.username, { hidden: false });
    res.json(sanitizeAccount(accounts.get(account.username)!));
  });

  // ── POST /api/accounts/:username/move  { folderId, environmentId? } ────────
  app.post('/api/accounts/:username/move', (req: Request, res: Response) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const folderId      = req.body?.folderId ?? null;
    const environmentId = typeof req.body?.environmentId === 'string' ? req.body.environmentId : undefined;
    try {
      const updated = accounts.moveAccount(account.username, folderId, environmentId);
      res.json(sanitizeAccount(updated));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Folders (scoped to environment)
  // ════════════════════════════════════════════════════════════════════════

  // Body: { name, environmentId?, parentId? }  (environmentId derived from parent if absent)
  app.post('/api/folders', (req: Request, res: Response) => {
    const { name, parentId } = req.body ?? {};
    let environmentId: string | undefined = req.body?.environmentId;
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!environmentId && parentId) environmentId = accounts.getFolder(parentId)?.environmentId;
    if (!environmentId) return res.status(400).json({ error: 'environmentId or parentId is required' });
    try {
      const folder = accounts.createFolder(name, environmentId, parentId ?? null);
      res.status(201).json(folder);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/folders/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, parentId } = req.body ?? {};
    try {
      let folder = accounts.getFolder(id);
      if (!folder) return res.status(404).json({ error: `Folder "${id}" not found` });
      if (typeof name === 'string') folder = accounts.renameFolder(id, name);
      if (parentId !== undefined)   folder = accounts.moveFolder(id, parentId);
      res.json(folder);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Reorder a folder one step among its siblings (manual ordering via UI arrows).
  app.post('/api/folders/:id/reorder', (req: Request, res: Response) => {
    const direction = req.body?.direction;
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: "direction must be 'up' or 'down'" });
    }
    try {
      if (!accounts.getFolder(req.params.id)) {
        return res.status(404).json({ error: `Folder "${req.params.id}" not found` });
      }
      const moved = accounts.reorderFolder(req.params.id, direction);
      res.json({ ok: true, moved });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/folders/:id', (req: Request, res: Response) => {
    try {
      if (!accounts.getFolder(req.params.id)) {
        return res.status(404).json({ error: `Folder "${req.params.id}" not found` });
      }
      accounts.deleteFolder(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Inventories (persistent cache + concurrency-limited refresh)
  // ════════════════════════════════════════════════════════════════════════

  // NOTE: specific GET routes MUST be registered before the parameterized
  // /api/inventory/:username, otherwise "/api/inventory/refresh-status" would be
  // swallowed as username="refresh-status".

  // ── GET /api/inventory ─────────────────────────────────────────────────────
  // Returns the WHOLE persisted inventory cache at once (username → inventory),
  // so the dashboard + global-master can build instantly without any live login.
  app.get('/api/inventory', (_req: Request, res: Response) => {
    const all = inventory.allCs2() as Record<string, AccountInventory>;
    const missing: Array<{ name: string; appid: number }> = [];
    for (const key of Object.keys(all)) {
      missing.push(...pricing.enrich(all[key])); // ensureFilled dedups by (name, appid)
      applyManualLock(all[key]);
      if (all[key].source === 'gc') tagCategories(all[key]);
    }
    if (missing.length) pricing.ensureFilled(missing);
    res.json(all);
  });

  app.get('/api/inventory/refresh-status', (_req: Request, res: Response) => {
    res.json(inventory.status());
  });

  // "End Task" for the live bulk refresh: co-operative stop (skips remaining accounts).
  app.post('/api/inventory/refresh-cancel', (_req: Request, res: Response) => {
    res.json(inventory.cancelRefresh());
  });

  // ── Value history (worth/wallet curve, one point per refresh) ──────────────
  // F3b — aggregate the per-environment series of the SELECTED environments into one curve,
  // so the global-master chart follows the environment selection. Registered BEFORE the
  // parameterized GET below; POST (a read with a body list) so it never collides with it.
  // Read-only; unknown ids are dropped (an empty selection yields []).
  app.post('/api/history/aggregate', (req: Request, res: Response) => {
    const raw = req.body?.seriesIds;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'seriesIds must be an array of environment ids' });
    const game: 'cs2' | 'tf2' = req.body?.game === 'tf2' ? 'tf2' : 'cs2';
    // Keep only known environment ids (or the global series) — never aggregate an unknown id.
    const ids = raw.filter((id: unknown): id is string =>
      typeof id === 'string' && (id === GLOBAL_SERIES || !!accounts.getEnvironment(id)));
    res.json(history.aggregate(ids, game));
  });

  // :seriesId is 'global' or an environment id.
  app.get('/api/history/:seriesId', (req: Request, res: Response) => {
    const id = req.params.seriesId;
    if (id !== GLOBAL_SERIES && !accounts.getEnvironment(id)) {
      return res.status(404).json({ error: `Unknown history series "${id}"` });
    }
    const game: 'cs2' | 'tf2' = req.query.game === 'tf2' ? 'tf2' : 'cs2';
    res.json(history.get(id, game));
  });

  // ── Pricing + currency ─────────────────────────────────────────────────────
  app.get('/api/exchange-rate', (_req: Request, res: Response) => {
    // Carry the rate's PROVENANCE so the UI can flag a fallback/stale rate instead of
    // showing it as if live (C20 / INV-E5). `usdToEur` kept for back-compat.
    const info = exchange.getInfo();
    res.json({ usdToEur: info.rate, fallback: info.fallback, ageMs: info.ageMs });
  });

  app.get('/api/pricing/status', (_req: Request, res: Response) => {
    res.json(pricing.status());
  });

  // ── POST /api/inventory/refresh-all  { environmentId? | usernames? | game? } ─
  app.post('/api/inventory/refresh-all', (req: Request, res: Response) => {
    const environmentId = typeof req.body?.environmentId === 'string' ? req.body.environmentId : undefined;
    const game: 'cs2' | 'tf2' = req.body?.game === 'tf2' ? 'tf2' : 'cs2';
    let usernames: string[];
    if (Array.isArray(req.body?.usernames)) {
      // Explicit username list (e.g. a folder's accounts) – validated against known accounts.
      usernames = req.body.usernames.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u));
    } else {
      const list = environmentId ? accounts.getByEnvironment(environmentId) : accounts.getAll();
      usernames = list.filter(a => a.enabled).map(a => a.username);
    }
    try {
      const job = inventory.startRefresh(usernames, game);
      res.json(job);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  TF2 inventories (appid 440) – read-only view, separate cache
  // ════════════════════════════════════════════════════════════════════════

  // Whole TF2 cache at once (mirrors GET /api/inventory). Now PRICED too: TF2
  // items are enriched against the TF2 market (appid 440) so keys/items show value.
  app.get('/api/inventory-tf2', (_req: Request, res: Response) => {
    const all = inventory.tf2Store.all() as Record<string, AccountInventory>;
    const missing: Array<{ name: string; appid: number }> = [];
    for (const key of Object.keys(all)) { missing.push(...pricing.enrich(all[key])); applyManualLock(all[key]); }
    if (missing.length) pricing.ensureFilled(missing);
    res.json(all);
  });

  app.get('/api/inventory-tf2/:username', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!force) {
      const cached = inventory.getCached(account.username, 'tf2');
      if (cached) return res.json(enrichInv(cached));
    }
    res.json(enrichInv(await inventory.refreshOne(account.username, 'tf2')));
  }));

  app.post('/api/inventory-tf2/:username/refresh', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    res.json(enrichInv(await inventory.refreshOne(account.username, 'tf2')));
  }));

  // GET returns the cached inventory INSTANTLY (even if stale). ?refresh=1 forces
  // a live refetch.
  app.get('/api/inventory/:username', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });

    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!force) {
      const cached = inventory.getCached(account.username);
      if (cached) return res.json(enrichInv(cached));
    }
    const inv = await inventory.refreshOne(account.username);
    history.snapshotAll('single-refresh', 'cs2'); // one curve point per refresh (CS2 refresh)
    res.json(enrichInv(inventory.getCached(account.username) ?? inv)); // refreshOne is the full CS2 fetch; getCached returns the freshly-stored complete record
  }));

  app.post('/api/inventory/:username/refresh', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const inv = await inventory.refreshOne(account.username);
    history.snapshotAll('single-refresh', 'cs2'); // one curve point per refresh (CS2 refresh)
    res.json(enrichInv(inventory.getCached(account.username) ?? inv)); // refreshOne is the full CS2 fetch; getCached returns the freshly-stored complete record
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 2 – Trade URL
  // ════════════════════════════════════════════════════════════════════════

  // Freshest wallet for the buy modal (live session balance > cached). No Steam call.
  app.get('/api/accounts/:username/wallet', (req: Request, res: Response) => {
    const u = req.params.username;
    if (!accounts.get(u)) return res.status(404).json({ error: 'account not found' });
    const sess = sessions.getSession(u);
    const live = sess?.wallet?.hasWallet ? { currency: sess.wallet.currency, balance: sess.wallet.balance } : undefined;
    const cached = inventory.getCached(u, 'cs2')?.wallet ?? inventory.getCached(u, 'tf2')?.wallet;
    const wallet = live ?? cached ?? null;
    res.json({ wallet, source: live ? 'session' : cached ? 'cache' : 'none' });
  });

  app.get('/api/accounts/:username/trade-url', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const url = await trades.getTradeUrl(account.username);
    res.json({ username: account.username, tradeUrl: url, manual: !!account.tradeUrl?.trim() });
  }));

  // ── GET /api/accounts/:username/logs ────────────────────────────────────────
  // Recent activity-log lines for ONE account, filtered from logs/ssim.log by the
  // "[username]" tag the logger stamps on every per-account message. Scanned newest-
  // first, capped, returned chronologically. Best-effort: a missing log → [].
  app.get('/api/accounts/:username/logs', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const tag = `[${account.username}]`;
    const entries: Array<{ timestamp: string; level: string; message: string }> = [];
    try {
      // Read only the TAIL of the (rotation-capped) log ASYNCHRONOUSLY: a sync full-file
      // read blocked the event loop for every in-flight request (trade/buy confirmations
      // included). 512 KB holds far more than the 200 recent lines we surface per account.
      const raw = await readFileTail(LOG_FILE, LOG_TAIL_BYTES);
      const lines = raw.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0 && entries.length < 200; i--) {
        if (!lines[i] || !lines[i].includes(tag)) continue;
        try {
          const e = JSON.parse(lines[i]) as { message?: unknown; level?: unknown; timestamp?: unknown };
          if (typeof e.message === 'string' && e.message.includes(tag)) {
            entries.push({
              timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
              level:     typeof e.level === 'string' ? e.level : 'info',
              message:   e.message,
            });
          }
        } catch { /* not a JSON log line – skip */ }
      }
    } catch { /* best-effort: never fail the modal over a log read */ }
    entries.reverse(); // chronological (oldest → newest)
    res.json({ username: account.username, entries });
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 3 / 4 – Send a trade (auto-confirmed via 2FA)
  // ════════════════════════════════════════════════════════════════════════

  app.post('/api/trade/send', asyncHandler(async (req, res) => {
    const { from, assetIds, toUsername, tradeUrl, message, appId, contextId } = req.body ?? {};

    const fromAccount = typeof from === 'string' ? accounts.get(from) : undefined;
    if (!fromAccount) return res.status(404).json({ error: `Sender account "${from}" not found` });

    if (!Array.isArray(assetIds) || assetIds.length === 0 || !assetIds.every(a => typeof a === 'string')) {
      return res.status(400).json({ error: 'assetIds must be a non-empty string array' });
    }
    // App-agnostic send: the offer carries each item's real app/context (CS2 730 or TF2 440,
    // both context 2). The active game tab decides; default to CS2 for older clients.
    const sendAppId = Number(appId) === 440 ? 440 : 730;
    const sendContextId = typeof contextId === 'string' && contextId.trim() ? contextId.trim() : '2';
    if (!toUsername && !tradeUrl) {
      return res.status(400).json({ error: 'Provide either toUsername (internal) or tradeUrl (external)' });
    }

    let targetUrl = '';
    let targetUsername: string | undefined;
    if (typeof toUsername === 'string' && toUsername.trim()) {
      const target = accounts.get(toUsername);
      if (!target) return res.status(404).json({ error: `Target account "${toUsername}" not found` });
      if (target.username.toLowerCase() === fromAccount.username.toLowerCase()) {
        return res.status(400).json({ error: 'Cannot send a trade to the same account' });
      }
      targetUsername = target.username;
    } else {
      targetUrl = String(tradeUrl).trim();
    }

    let result: Awaited<ReturnType<typeof trades.sendTrade>>;
    try {
      // Resolve an internal target's trade URL lazily (also logs it in → arms auto-accept).
      if (targetUsername) targetUrl = await trades.getTradeUrl(targetUsername);
      result = await trades.sendTrade(fromAccount.username, {
        tradeUrl: targetUrl,
        myItems:  assetIds.map((id: string) => ({ assetId: id, appId: sendAppId, contextId: sendContextId })),
        message:  typeof message === 'string' ? message : undefined,
      });
    } catch (err) {
      // Money-safety: a duplicate or precondition must NEVER surface as a retryable
      // 5xx that the UI would blindly re-send (→ a SECOND real-asset offer). Classify
      // like the buy endpoint does. Note: a confirmation failure no longer throws — it
      // returns status:'unconfirmed' below — so a throw here means the offer was NOT
      // confirmed-sent, but a network send can still time out post-dispatch.
      const msg = (err as Error).message;
      // S15 refuse-once: a marked pre-commit refusal is an honest duplicate-precondition, not a
      // retryable gateway fault — answer 409 so a blind retry-on-502 client cannot re-fire it.
      if ((err as { moneyOpRefused?: boolean }).moneyOpRefused) return res.status(409).json({ error: msg, refused: true });
      if (/already in flight|already running/i.test(msg)) return res.status(409).json({ error: msg });
      if (/not found|not ready|no cookies|requires either|trade ?url|trade-link|same account|disabled|empty/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      return res.status(502).json({ error: msg, verifyBeforeRetry: true });
    }

    logger.info(`[${fromAccount.username}] trade ${result.offerId} → ${targetUsername ?? targetUrl} (${result.status})`);

    // Post-trade cache fix: refetch sender (and internal receiver) after Steam settles.
    setTimeout(
      () => inventory.refreshAfterTrade([fromAccount.username, targetUsername]),
      POST_TRADE_REFRESH_MS,
    ).unref();

    res.json({ ...result, from: fromAccount.username, to: targetUsername ?? targetUrl });
  }));

  app.post('/api/trade/auto-accept', (req: Request, res: Response) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    trades.setAutoAccept(enabled);
    res.json({ autoAccept: trades.isAutoAccept() });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  v2.1 – Mass-send (folder → storage), paced via worker pool + 2FA
  // ════════════════════════════════════════════════════════════════════════

  // Body: { items: [{username, assetId}], toUsername?|tradeUrl?, message?, concurrency?, delayMs? }
  app.post('/api/trade/mass-send', asyncHandler(async (req, res) => {
    const { items, toUsername, tradeUrl, message, concurrency, delayMs, appId, contextId } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0
      || !items.every(i => i && typeof i.username === 'string' && typeof i.assetId === 'string')) {
      return res.status(400).json({ error: 'items must be a non-empty array of { username, assetId }' });
    }
    // App-agnostic send: a mass-send is driven by ONE game tab, so the whole batch shares one
    // app/context (CS2 730 / TF2 440, both context 2). Default to CS2 for older clients.
    const sendAppId = Number(appId) === 440 ? 440 : 730;
    const sendContextId = typeof contextId === 'string' && contextId.trim() ? contextId.trim() : '2';
    if (!toUsername && !tradeUrl) {
      return res.status(400).json({ error: 'Provide either toUsername (internal) or tradeUrl (external)' });
    }

    // Resolve the destination trade URL ONCE (also wakes an internal storage → arms auto-accept).
    let targetUrl: string;
    let targetKey: string | undefined;
    if (typeof toUsername === 'string' && toUsername.trim()) {
      const target = accounts.get(toUsername);
      if (!target) return res.status(404).json({ error: `Target account "${toUsername}" not found` });
      targetKey = target.username.toLowerCase();
      targetUrl = await trades.getTradeUrl(target.username);
    } else {
      targetUrl = String(tradeUrl).trim();
    }

    // Group the flat item list by owner bot → one offer per bot. Skip the target itself.
    // Each group carries the batch's app/context so the offer is built for the right game.
    const groupMap = new Map<string, { username: string; assetIds: string[]; appId: number; contextId: string }>();
    const skippedSelf: string[] = [];
    for (const it of items as Array<{ username: string; assetId: string }>) {
      if (targetKey && it.username.toLowerCase() === targetKey) {
        if (!skippedSelf.includes(it.username)) skippedSelf.push(it.username);
        continue;
      }
      const key = it.username.toLowerCase();
      const g = groupMap.get(key) ?? { username: it.username, assetIds: [], appId: sendAppId, contextId: sendContextId };
      g.assetIds.push(it.assetId);
      groupMap.set(key, g);
    }

    const groups = [...groupMap.values()];
    if (groups.length === 0) {
      return res.status(400).json({ error: 'No sendable items (all belonged to the target account)' });
    }

    try {
      const job = trades.startMassSend(groups, targetUrl, {
        message:     typeof message === 'string' ? message : undefined,
        concurrency: Number.isFinite(concurrency) ? Number(concurrency) : undefined,
        delayMs:     Number.isFinite(delayMs) ? Number(delayMs) : undefined,
      });
      logger.info(`[mass] queued ${groups.length} bot(s) → ${toUsername ?? targetUrl}`);
      res.json({ ...job, bots: groups.length, totalItems: items.length, skippedSelf });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  }));

  app.get('/api/trade/mass-status', (_req: Request, res: Response) => {
    res.json(trades.massStatus());
  });

  // "End Task" for the live mass-send: co-operative stop (skips remaining bots).
  app.post('/api/trade/mass-cancel', (_req: Request, res: Response) => {
    res.json(trades.cancelMass());
  });

  // ════════════════════════════════════════════════════════════════════════
  //  New feature – Global Trade-Offers manager (sent + received, batch actions)
  // ════════════════════════════════════════════════════════════════════════

  // Apps we have a price market for; only these item values are summed into an offer's
  // headline value (other-game items contribute nothing rather than spamming Steam).
  const OFFER_PRICED_APPS = new Set([730, 440]);

  /**
   * Attaches `valueGiveCents` / `valueReceiveCents` (USD cents from the price cache)
   * to every offer in place, and queues any missing names for a background fill so a
   * second load shows values. A side's value is null only when NONE of its items have
   * a known price (so "0,00" never masquerades as a real, fully-priced empty side).
   */
  const priceOffers = (perAccount: AccountOffers[]): void => {
    const missing: Array<{ name: string; appid: number }> = [];
    const seen = new Set<string>();
    const valueOf = (items: Array<{ marketHashName: string; appId: number; amount: number }>): number | null => {
      let total = 0; let priced = false;
      for (const it of items) {
        if (!OFFER_PRICED_APPS.has(it.appId) || !it.marketHashName) continue;
        const cents = pricing.priceCents(it.marketHashName, it.appId);
        if (cents === undefined) {
          const key = `${it.appId}:${it.marketHashName}`;
          if (!seen.has(key)) { seen.add(key); missing.push({ name: it.marketHashName, appid: it.appId }); }
        } else if (cents != null) { total += cents * (it.amount || 1); priced = true; }
      }
      return priced ? total : null;
    };
    for (const acc of perAccount) {
      for (const o of [...acc.sent, ...acc.received]) {
        o.valueGiveCents    = valueOf(o.itemsToGive);
        o.valueReceiveCents = valueOf(o.itemsToReceive);
      }
    }
    if (missing.length) pricing.ensureFilled(missing);
  };

  // POST /api/trade/offers  { usernames: string[] }
  // Aggregates sent + received offers across the given accounts (an environment's bots),
  // each priced from the cache. Per-account failures surface as { error } rows, never 5xx.
  app.post('/api/trade/offers', asyncHandler(async (req, res) => {
    const { usernames } = req.body ?? {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    const known = usernames.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u));
    if (known.length === 0) return res.status(400).json({ error: 'no known accounts in usernames' });

    const perAccount = await trades.getOffersForAccounts(known);
    priceOffers(perAccount);
    const sent     = perAccount.reduce((n, a) => n + a.sent.length, 0);
    const received = perAccount.reduce((n, a) => n + a.received.length, 0);
    const errors   = perAccount.filter((a) => a.error).length;
    res.json({ accounts: perAccount, totals: { accounts: perAccount.length, sent, received, errors } });
  }));

  const VALID_OFFER_ACTIONS: OfferAction[] = ['accept', 'decline', 'cancel'];

  // POST /api/trade/offer-action  { username, offerId, action }
  app.post('/api/trade/offer-action', asyncHandler(async (req, res) => {
    const { username, offerId, action } = req.body ?? {};
    if (typeof username !== 'string' || !accounts.get(username)) {
      return res.status(400).json({ error: 'valid username is required' });
    }
    if (typeof offerId !== 'string' || !offerId.trim()) {
      return res.status(400).json({ error: 'offerId is required' });
    }
    if (!VALID_OFFER_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${VALID_OFFER_ACTIONS.join(', ')}` });
    }
    try {
      await trades.offerAction(username, offerId.trim(), action);
      res.json({ ok: true, username, offerId: offerId.trim(), action });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // POST /api/trade/offers-batch  { items: [{ username, offerId, action }] }
  // Runs every action through the service's HARD concurrency-2 pool; results are per-item.
  app.post('/api/trade/offers-batch', asyncHandler(async (req, res) => {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array of { username, offerId, action }' });
    }
    const targets: OfferActionTarget[] = [];
    for (const it of items) {
      if (!it || typeof it.username !== 'string' || !accounts.get(it.username)) continue;
      if (typeof it.offerId !== 'string' || !it.offerId.trim()) continue;
      if (!VALID_OFFER_ACTIONS.includes(it.action)) continue;
      targets.push({ username: it.username, offerId: it.offerId.trim(), action: it.action });
    }
    if (targets.length === 0) return res.status(400).json({ error: 'no valid { username, offerId, action } targets' });

    const results = await trades.batchOfferAction(targets);
    const ok   = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    logger.info(`[offers] batch ${results[0]?.action ?? ''}: ${ok} ok / ${fail} failed (${results.length} total)`);
    res.json({ results, ok, fail, total: results.length });
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  v2.3 Feature 4 – Mass-sell on the Steam Community Market
  // ════════════════════════════════════════════════════════════════════════

  // Price preview for the sell modal.
  // Body: { names: string[], strategy, customCents?, username? }
  app.post('/api/market/preview', asyncHandler(async (req, res) => {
    const { names, strategy, customCents, username } = req.body ?? {};
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) {
      return res.status(400).json({ error: 'names must be a string array' });
    }
    if (!VALID_STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `strategy must be one of ${VALID_STRATEGIES.join(', ')}` });
    }
    const custom = readCustomCents(customCents);
    if (strategy === 'custom' && custom == null) {
      return res.status(400).json({ error: 'customCents (EUR cents ≥ 1) is required for strategy "custom"' });
    }
    res.json(await market.preview(names, strategy, {
      customCents: custom ?? undefined,
      username: typeof username === 'string' ? username : undefined,
    }));
  }));

  // Body: { items: [{username, assetId, marketHashName}], strategy, customCents?, concurrency?, itemDelayMs? }
  app.post('/api/market/sell', (req: Request, res: Response) => {
    const { items, strategy, customCents, concurrency, itemDelayMs } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0
      || !items.every(i => i && typeof i.username === 'string' && typeof i.assetId === 'string' && typeof i.marketHashName === 'string')) {
      return res.status(400).json({ error: 'items must be a non-empty array of { username, assetId, marketHashName }' });
    }
    if (!VALID_STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `strategy must be one of ${VALID_STRATEGIES.join(', ')}` });
    }
    const custom = readCustomCents(customCents);
    if (strategy === 'custom' && custom == null) {
      return res.status(400).json({ error: 'customCents (EUR cents ≥ 1) is required for strategy "custom"' });
    }

    // Group by owner bot → one batch (and one 2FA confirmation pass) per bot.
    const groupMap = new Map<string, MassSellGroup>();
    const unknown: string[] = [];
    for (const it of items as Array<{ username: string; assetId: string; marketHashName: string }>) {
      if (!accounts.get(it.username)) { if (!unknown.includes(it.username)) unknown.push(it.username); continue; }
      const key = it.username.toLowerCase();
      const g = groupMap.get(key) ?? { username: it.username, items: [] };
      g.items.push({ assetId: it.assetId, marketHashName: it.marketHashName });
      groupMap.set(key, g);
    }
    const groups = [...groupMap.values()];
    if (groups.length === 0) return res.status(400).json({ error: 'No sellable items for known accounts' });

    try {
      const job = market.startMassSell(groups, strategy, {
        concurrency: Number.isFinite(concurrency) ? Number(concurrency) : undefined,
        itemDelayMs: Number.isFinite(itemDelayMs) ? Number(itemDelayMs) : undefined,
        customCents: custom ?? undefined,
      });
      const sellers = groups.map(g => g.username);
      logger.info(`[mass-sell] queued ${job.total} item(s) across ${groups.length} bot(s), strategy=${strategy}`);
      res.json({ ...job, bots: groups.length, sellers, unknown });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.get('/api/market/sell-status', (_req: Request, res: Response) => {
    res.json(market.status());
  });

  // "End Task" for the live mass-sell: co-operative stop (defers remaining items).
  app.post('/api/market/sell-cancel', (_req: Request, res: Response) => {
    res.json(market.cancelSell());
  });

  // ── v1.0.2: live lowest ASK for the buy modal's price auto-fill ────────────
  // Query: ?username=&marketHashName=&appId=  → { lowestMinor, currency, currencyIso, decimals }
  app.get('/api/market/buy-price', asyncHandler(async (req, res) => {
    const username = String(req.query.username ?? '');
    const name = String(req.query.marketHashName ?? '').trim();
    const appid = Number(req.query.appId);
    if (!accounts.get(username)) return res.status(400).json({ error: 'valid username required' });
    if (!name) return res.status(400).json({ error: 'marketHashName required' });
    if (appid !== 730 && appid !== 440) return res.status(400).json({ error: 'appId must be 730 or 440' });
    const game = appid === 440 ? 'tf2' : 'cs2';
    const currency = inventory.getCached(username, game)?.wallet?.currency ?? 3;
    const info = currencyInfo(currency);
    const lowestMinor = await market.lowestAsk(name, appid, currency, info.decimals);
    res.json({ lowestMinor, currency, currencyIso: info.iso, decimals: info.decimals });
  }));

  // ── v1.0.2: live Steam Market item search for the buy modal's autocomplete ──
  // Query: ?q=<text>&appId=730|440  → { results: [{ marketHashName, name, iconUrl, priceText }] }
  app.get('/api/market/search', asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const appid = Number(req.query.appId);
    if (q.length < 2) return res.json({ results: [] });
    if (appid !== 730 && appid !== 440) return res.status(400).json({ error: 'appId must be 730 or 440' });
    const url = `https://steamcommunity.com/market/search/render/` +
      `?norender=1&count=20&start=0&appid=${appid}&query=${encodeURIComponent(q)}`;
    try {
      const r = await axios.get(url, {
        timeout: 10_000,
        proxy: false,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://steamcommunity.com/market/',
        },
      });
      if (r.status !== 200 || !r.data || r.data.success !== true || !Array.isArray(r.data.results)) {
        return res.json({ results: [], error: `Steam HTTP ${r.status}` });
      }
      const results = r.data.results.slice(0, 20).map((it: Record<string, any>) => {
        const ad = (it.asset_description ?? {}) as Record<string, any>;
        const icon = ad.icon_url
          ? `https://community.cloudflare.steamstatic.com/economy/image/${ad.icon_url}/64x64`
          : null;
        return {
          marketHashName: ad.market_hash_name ?? it.hash_name ?? it.name,
          name:           it.name ?? ad.market_name ?? ad.market_hash_name,
          iconUrl:        icon,
          priceText:      typeof it.sell_price_text === 'string' ? it.sell_price_text : null,
        };
      }).filter((x: { marketHashName?: string }) => !!x.marketHashName);
      res.json({ results });
    } catch (err) {
      res.json({ results: [], error: (err as Error).message });
    }
  }));

  // ── v1.0.2: place a Steam Community Market BUY ORDER for one account ────────
  // Body: { username, marketHashName, appId (730|440), pricePerItemMinor, quantity }
  // pricePerItemMinor is in the BOT's native wallet-currency minor units.
  app.post('/api/market/buy', asyncHandler(async (req, res) => {
    const { username, marketHashName, appId, pricePerItemMinor, quantity, billing, retryAfterConfirm } = req.body ?? {};
    if (typeof username !== 'string' || !accounts.get(username)) {
      return res.status(400).json({ error: 'valid username is required' });
    }
    const name = typeof marketHashName === 'string' ? marketHashName.trim() : '';
    if (!name) return res.status(400).json({ error: 'marketHashName is required' });
    const appid = Number(appId);
    if (appid !== 730 && appid !== 440) {
      return res.status(400).json({ error: 'appId must be 730 (CS2) or 440 (TF2)' });
    }
    const priceMinor = Number(pricePerItemMinor);
    if (!Number.isInteger(priceMinor) || priceMinor < 1) {
      return res.status(400).json({ error: 'pricePerItemMinor must be an integer ≥ 1 (wallet minor units)' });
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
      return res.status(400).json({ error: 'quantity must be an integer between 1 and 100' });
    }
    try {
      const b = billing && typeof billing === 'object' ? billing : undefined;
      const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      const result = await buy.buy({
        username, marketHashName: name, appId: appid,
        pricePerItemMinor: priceMinor, quantity: qty,
        billing: b ? {
          firstName: s(b.firstName), lastName: s(b.lastName),
          address: s(b.address), addressTwo: s(b.addressTwo),
          city: s(b.city), state: s(b.state), country: s(b.country),
          postalCode: s(b.postalCode), save: b.save !== false,
        } : undefined,
        retryAfterConfirm: retryAfterConfirm !== false, // default ON – the proven finalize step
      });
      logger.info(`[market-buy] ${username} ${name} x${qty} → filled=${result.filled} placed=${result.placed}`);
      res.json(result);
    } catch (err) {
      // Classify: a precondition/duplicate must NOT look like a retryable gateway
      // fault on a money endpoint (a blind retry-on-502 could double-spend).
      const msg = (err as Error).message;
      // S15 refuse-once: a marked pre-commit refusal is an honest duplicate-precondition, not a
      // retryable gateway fault — answer 409 so a blind retry-on-502 client cannot re-fire it.
      if ((err as { moneyOpRefused?: boolean }).moneyOpRefused) return res.status(409).json({ error: msg, refused: true });
      if (/already running/i.test(msg)) return res.status(409).json({ error: msg });
      if (/not found|no sessionid|no steamloginsecure|no identity_secret|wallet currency|exceeds|invalid/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      // A create whose outcome is UNKNOWN (network error before the order state was
      // learned) carries verifyBeforeRetry so the UI tells the operator to check open
      // orders instead of blindly re-buying (a blind retry could double-spend).
      if ((err as { verifyBeforeRetry?: boolean }).verifyBeforeRetry) {
        return res.status(502).json({ error: msg, verifyBeforeRetry: true });
      }
      res.status(502).json({ error: msg });
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  New feature – Active Orders (fetch + cancel) & folder-level Mass Buy
  // ════════════════════════════════════════════════════════════════════════

  // ── GET /api/market/orders/:username?appId=730|440 ─────────────────────────
  // Live-fetches the account's open market orders through its own session and
  // returns them split by side, filtered to the requested game (default CS2).
  app.get('/api/market/orders/:username', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const appId = req.query.appId === '440' ? 440 : 730;
    try {
      const orders = await market.getOrders(account.username);
      res.json({
        username:   account.username,
        appId,
        sellOrders: orders.sellOrders.filter((o) => o.appId === appId),
        buyOrders:  orders.buyOrders.filter((o) => o.appId === appId),
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // ── POST /api/market/cancel-listing  { username, listingId } ───────────────
  app.post('/api/market/cancel-listing', asyncHandler(async (req, res) => {
    const { username, listingId } = req.body ?? {};
    if (typeof username !== 'string' || !accounts.get(username)) {
      return res.status(400).json({ error: 'valid username is required' });
    }
    if (typeof listingId !== 'string' || !listingId.trim()) {
      return res.status(400).json({ error: 'listingId is required' });
    }
    try {
      await market.cancelListing(username, listingId.trim());
      res.json({ ok: true, listingId: listingId.trim() });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // ── POST /api/market/cancel-buy-order  { username, buyOrderId } ────────────
  app.post('/api/market/cancel-buy-order', asyncHandler(async (req, res) => {
    const { username, buyOrderId } = req.body ?? {};
    if (typeof username !== 'string' || !accounts.get(username)) {
      return res.status(400).json({ error: 'valid username is required' });
    }
    if (typeof buyOrderId !== 'string' || !buyOrderId.trim()) {
      return res.status(400).json({ error: 'buyOrderId is required' });
    }
    try {
      await market.cancelBuyOrder(username, buyOrderId.trim());
      res.json({ ok: true, buyOrderId: buyOrderId.trim() });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // ── POST /api/market/folder-buy ─────────────────────────────────────────────
  // Body: { usernames: string[], marketHashName, appId (730|440), pricePerItemMajor }
  // Refreshes EVERY listed account's balance FIRST (enforced in BuyService), then
  // maxes out each account's purchase at the given price (applied in each account's
  // OWN wallet currency). Returns the initial job; poll /api/market/folder-buy-status.
  app.post('/api/market/folder-buy', (req: Request, res: Response) => {
    const { usernames, marketHashName, appId, pricePerItemMajor } = req.body ?? {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    // Validate each against known accounts (mirrors mass-send / refresh-all).
    const known = usernames.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u));
    if (known.length === 0) return res.status(400).json({ error: 'no known accounts in usernames' });
    const name = typeof marketHashName === 'string' ? marketHashName.trim() : '';
    if (!name) return res.status(400).json({ error: 'marketHashName is required' });
    const appid = Number(appId);
    if (appid !== 730 && appid !== 440) return res.status(400).json({ error: 'appId must be 730 (CS2) or 440 (TF2)' });
    const price = Number(pricePerItemMajor);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'pricePerItemMajor must be a number > 0 (item price in each bot\'s own currency)' });
    }
    try {
      const job = buy.startMassBuy({ usernames: known, marketHashName: name, appId: appid, pricePerItemMajor: price });
      logger.info(`[mass-buy] queued ${known.length} account(s) → ${name} @ ${price} (appid ${appid})`);
      res.json({ ...job, accounts: known.length });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.get('/api/market/folder-buy-status', (_req: Request, res: Response) => {
    res.json(buy.massBuyStatus());
  });

  // "End Task" for the live folder mass-buy: co-operative stop (skips remaining accounts).
  app.post('/api/market/folder-buy-cancel', (_req: Request, res: Response) => {
    res.json(buy.cancelMassBuy());
  });

  // ════════════════════════════════════════════════════════════════════════
  //  New feature – Ban Checker (account / folder / multi-select scope)
  // ════════════════════════════════════════════════════════════════════════

  // POST /api/bans/check  { usernames: string[] }
  // Scans every given account for ALL Steam ban types (VAC / game / community / economy)
  // via ISteamUser/GetPlayerBans and returns them categorised. Read-only; per-account
  // failures surface as { error } rows and never abort the others. Scoped to the
  // submitted usernames only (single account, a folder's accounts, or a multi-selection).
  app.post('/api/bans/check', asyncHandler(async (req, res) => {
    const { usernames } = req.body ?? {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    const known = usernames.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u));
    if (known.length === 0) return res.status(400).json({ error: 'no known accounts in usernames' });

    const result = await bans.checkBans(known);
    logger.info(`[bans] checked ${result.totals.total} account(s): ` +
      `clean=${result.totals.clean} vac=${result.totals.vac} game=${result.totals.game} ` +
      `community=${result.totals.community} economy=${result.totals.economy} error=${result.totals.error}`);
    res.json(result);
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 1 – Automated Max-Profit Trade-Ups (single account only)
  //  Calculation + preview are always available; EXECUTION is gated behind the GC
  //  layer's verified flag (SSIM_GC_VERIFIED) and only ever destroys items the owner
  //  explicitly selected + started. See FEATURES_REPORT.md.
  // ════════════════════════════════════════════════════════════════════════

  // GC + schema readiness, for the modal to show whether execution is enabled.
  app.get('/api/tradeup/status', (_req: Request, res: Response) => {
    res.json({ ...tradeup.gcStatus(), schemaLoaded: cs2Schema.isLoaded(), schemaSkins: cs2Schema.skinCount() });
  });

  // POST /api/tradeup/candidates { username } — live-refresh + compute every positive-profit trade-up.
  app.post('/api/tradeup/candidates', asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    if (!accounts.get(username)) return res.status(400).json({ error: 'valid username is required' });
    const minProfitCents = Number.isFinite(req.body?.minProfitCents) ? Number(req.body.minProfitCents) : 0;
    try {
      res.json(await tradeup.getCandidates(username, { minProfitCents }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // POST /api/tradeup/execute { username, contracts:[{ inputAssetIds:string[10] }] } — HIGH RISK + GATED.
  app.post('/api/tradeup/execute', (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    if (!accounts.get(username)) return res.status(400).json({ error: 'valid username is required' });
    const contracts = Array.isArray(req.body?.contracts) ? req.body.contracts : [];
    try {
      res.json(tradeup.startExecute(username, contracts));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });
  app.get('/api/tradeup/execute-status', (_req: Request, res: Response) => res.json(tradeup.executeStatus()));
  app.post('/api/tradeup/execute-cancel', (_req: Request, res: Response) => res.json(tradeup.cancelExecute()));

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 2 – Storage Unit (Casket) Management (single account only)
  //  List/read are read-only (need only the GC library); MOVES are gated like trade-ups.
  // ════════════════════════════════════════════════════════════════════════

  app.get('/api/casket/status', (_req: Request, res: Response) => res.json(casket.status()));

  app.get('/api/casket/:username/list', asyncHandler(async (req, res) => {
    if (!accounts.get(req.params.username)) return res.status(404).json({ error: 'account not found' });
    try { res.json({ caskets: await casket.listCaskets(req.params.username) }); }
    catch (err) { res.status(502).json({ error: (err as Error).message }); }
  }));

  app.get('/api/casket/:username/contents', asyncHandler(async (req, res) => {
    if (!accounts.get(req.params.username)) return res.status(404).json({ error: 'account not found' });
    const casketId = String(req.query.casketId ?? '').trim();
    if (!casketId) return res.status(400).json({ error: 'casketId is required' });
    try { res.json({ items: await casket.contents(req.params.username, casketId) }); }
    catch (err) { res.status(502).json({ error: (err as Error).message }); }
  }));

  // POST /api/casket/move { username, casketId, itemIds:string[], direction:'deposit'|'withdraw' } — GATED.
  app.post('/api/casket/move', (req: Request, res: Response) => {
    const { username, casketId, itemIds, direction } = req.body ?? {};
    if (typeof username !== 'string' || !accounts.get(username)) return res.status(400).json({ error: 'valid username is required' });
    if (direction !== 'deposit' && direction !== 'withdraw') return res.status(400).json({ error: "direction must be 'deposit' or 'withdraw'" });
    if (!Array.isArray(itemIds) || itemIds.length === 0 || !itemIds.every((i: unknown) => typeof i === 'string' && i)) {
      return res.status(400).json({ error: 'itemIds must be a non-empty string array' });
    }
    try {
      res.json(casket.startMove(username, String(casketId ?? '').trim(), itemIds, direction));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });
  app.get('/api/casket/move-status', (_req: Request, res: Response) => res.json(casket.moveStatus()));
  app.post('/api/casket/move-cancel', (_req: Request, res: Response) => res.json(casket.cancelMove()));

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 4 (v2.0) – Bulk import of maFiles + CSV
  // ════════════════════════════════════════════════════════════════════════

  // CSV import: rows of `username,password,shared_secret,identity_secret` merged into the
  // vault (only new usernames; no maFile on disk needed). Requires vault mode.
  app.post('/api/import/csv', (req: Request, res: Response) => {
    const { csv, environmentId, folderId } = req.body ?? {};
    if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'csv text is required' });
    if (typeof environmentId !== 'string' || !accounts.getEnvironment(environmentId)) {
      return res.status(400).json({ error: 'valid environmentId is required' });
    }
    if (!AccountVault.isEnabled()) {
      return res.status(400).json({ error: 'CSV import requires the vault — set a master password at startup' });
    }
    try {
      const { imported, skipped } = importCsvIntoVault(accounts, csv, environmentId, folderId ?? null);
      res.json({ imported, skipped });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Import SSIM Vault: merge ANOTHER device's vault.enc (raw content + its master password)
  // into this vault. Only new usernames are added. Requires this vault to be unlocked.
  app.post('/api/import/vault', (req: Request, res: Response) => {
    const { vault, password, environmentId, accountsJson, folderId } = req.body ?? {};
    if (typeof vault !== 'string' || !vault.trim()) return res.status(400).json({ error: 'vault file content is required' });
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'the source vault password is required' });
    if (typeof environmentId !== 'string' || !accounts.getEnvironment(environmentId)) {
      return res.status(400).json({ error: 'valid environmentId is required' });
    }
    if (!AccountVault.isEnabled()) return res.status(400).json({ error: 'vault not unlocked' });
    // accountsJson (the source's accounts.json) is OPTIONAL — when supplied AND no explicit target
    // folder is chosen, the source's folder organisation is recreated in the target environment.
    // An explicit folderId from the modal takes precedence (all bots land in that one folder).
    const orgJson = typeof accountsJson === 'string' && accountsJson.trim() ? accountsJson : undefined;
    const r = importExternalVault(accounts, vault, password, orgJson, environmentId, folderId ?? null);
    if (r === null) return res.status(401).json({ error: 'wrong password, or this is not an SSIM vault file' });
    res.json(r);
  });

  // Lists *.maFile in ./mafiles/ that are not yet registered to an account.
  app.get('/api/mafiles/unlinked', (_req: Request, res: Response) => {
    res.json(listUnlinkedMaFiles(accounts));
  });

  // Body: { files: string[], environmentId, folderId? }
  // STRICT: an explicit environmentId AND a non-empty selection are REQUIRED. The selected
  // maFiles are imported into EXACTLY the chosen env/folder — nothing else is touched.
  app.post('/api/mafiles/import', (req: Request, res: Response) => {
    const { files, environmentId, folderId } = req.body ?? {};
    if (typeof environmentId !== 'string' || !accounts.getEnvironment(environmentId)) {
      return res.status(400).json({ error: 'valid environmentId is required' });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'select at least one maFile to import' });
    }
    if (AccountVault.isEnabled()) {
      // Vault mode: import ONLY the SELECTED maFiles from the drop zone into the vault + create
      // org entries in the chosen environment + folder. Honours the selection; never imports an
      // un-ticked file or guesses a target. Non-destructive; idempotent.
      const { imported, skipped } = importDropZoneIntoVault(accounts, environmentId, folderId ?? null, files.map(String));
      return res.json({ vault: true, imported, skipped, migrated: 0, added: [] });
    }

    const creds = readCredentialsFile();
    const items: Array<{ username: string; password: string; maFilePath: string; environmentId: string; folderId?: string | null }> = [];
    const skipped: Array<{ username: string; reason: string }> = [];

    for (const file of files) {
      const safe = path.basename(String(file)); // prevent path traversal
      const full = path.join(MAFILES_DIR, safe);
      let accountName = '';
      try {
        accountName = (JSON.parse(fs.readFileSync(full, 'utf-8')).account_name as string) || '';
      } catch {
        skipped.push({ username: safe, reason: 'maFile unreadable' });
        continue;
      }
      if (!accountName) { skipped.push({ username: safe, reason: 'no account_name in maFile' }); continue; }
      const password = creds.get(accountName.toLowerCase());
      if (!password) { skipped.push({ username: accountName, reason: 'no password in accounts.txt' }); continue; }
      // Store the BARE filename: loadMaFile resolves it against ./mafiles/, so
      // the database stays valid when the install moves to another machine.
      items.push({ username: accountName, password, maFilePath: safe, environmentId, folderId: folderId ?? null });
    }

    const result = accounts.addMany(items);
    res.json({
      added:   result.added.map(sanitizeAccount),
      skipped: [...skipped, ...result.skipped],
    });
  });

  // ── License/boot status (the dashboard's client-guard polls this on load) ───
  // The FULL app is constructed ONLY after the license gate passes, so a request reaching
  // here is licensed by construction — but report the LIVE seat state (LicenseClient's
  // last-known revoked flag), not a hardcoded true, so a runtime revocation is visible to
  // the dashboard even in the brief window before the server is torn down. (INV-G1/G-1.)
  app.get('/api/system/status', (_req: Request, res: Response) => {
    const availableUpdate = getAvailableUpdate();
    const blockedUpdate = getBlockedUpdate();
    const priorCrash = getPriorCrash();
    res.json({
      licensed: !LicenseClient.isRevoked(),
      version: pkg.version,
      // Money-ops breaker (B3): mirror /api/health's stable/quarantineReason onto the endpoint the
      // dashboard already polls, so the operator SEES a tripped breaker (latch semantics unchanged).
      moneyOpsStable: !ProcessHealth.moneyOpsBlocked(),
      ...(ProcessHealth.moneyOpsBlocked() ? { quarantineReason: ProcessHealth.blockReason() } : {}),
      // Refresh-token store DEGRADED (B2): the file is present-but-corrupt and NOT persisting → the
      // operator must restore it before a mass refresh re-auths the fleet.
      ...(sessions.isTokenStoreDegraded() ? { tokenStoreDegraded: true } : {}),
      // CSFloat key store DEGRADED (S12): csfloat_keys.json is present-but-corrupt (plaintext mode) →
      // keys are silently absent (pricing falls back to Steam, auto-accept skips accounts). Surface it.
      ...(csfloat.isKeyStoreDegraded() ? { csfloatKeyStoreDegraded: true } : {}),
      // Update availability + per-machine block (C3): "update available", and "ready but blocked on
      // this machine — manual install" when the artifact has failed its self-test ≥N times here.
      update: {
        available: !!availableUpdate,
        latest: availableUpdate?.version,
        notes: availableUpdate?.notes,
        blocked: !!(availableUpdate && blockedUpdate && blockedUpdate.version === availableUpdate.version),
        blockedFailures: blockedUpdate?.failures,
        blockedKind: blockedUpdate?.kind,
        // S34: expose the LAST update outcome + whether an update op is in flight, so the dashboard can
        // stop showing "installing…" forever when a user-confirmed install kept-current (a swap exits the
        // process, so a still-running backend with installing:false means the install ended → badge back).
        currentOutcome: getUpdateOutcome(),
        installing: isUpdateOpInFlight(),
      },
      // Prior-run crash banner (B1): the shell recorded an unexpected backend death last run. Shown
      // once so the operator knows — NOTHING was auto-restarted.
      ...(priorCrash ? { priorCrash: { at: priorCrash.at, code: priorCrash.code ?? null, signal: priorCrash.signal ?? null } } : {}),
    });
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status:       'ok',
      environments: accounts.getEnvironments().length,
      accounts:     accounts.count(),
      sessions:     sessions.getStatus(),
      autoAccept:   trades.isAutoAccept(),
      refresh:      inventory.status(),
      fx:           exchange.getInfo(),
      stable:       !ProcessHealth.moneyOpsBlocked(),
      ...(ProcessHealth.moneyOpsBlocked() ? { quarantineReason: ProcessHealth.blockReason() } : {}),
    });
  });

  // ── Vault status (read-only) ───────────────────────────────────────────────
  // The CLI handles unlock/create at boot. In vault mode every secret (password,
  // maFile, proxy, refresh token) lives in the portable, encrypted vault.enc.
  app.get('/api/vault/status', (_req: Request, res: Response) => {
    res.json({ enabled: AccountVault.isEnabled(), accounts: AccountVault.accountCount() });
  });

  // ── Manual update check / install (C5) ─────────────────────────────────────
  // POST under /api/ → automatically capability- AND CSRF-guarded (no extra wiring). Default = a
  // CHECK-ONLY network probe that refreshes "update available". With { install:true } the user has
  // EXPLICITLY confirmed installing now: refused while any trade/buy/refresh is in flight (a swap exits
  // the process), else fire-and-forget the full update (download → verify → self-test → swap), which
  // restarts SSIM on success. This is the ONLY mid-session swap path — never automatic. (C5.)
  // S62: wrapped in asyncHandler like every other async route — a reject from checkOnly()/installNow (if
  // either ever loses its own self-catch) is routed to the error middleware instead of becoming a hanging
  // request + unhandledRejection.
  app.post('/api/app/check-update', asyncHandler(async (req: Request, res: Response) => {
    const install = (req.body as { install?: unknown } | undefined)?.install === true;
    if (install) {
      const gate = canInstallNow();
      if (!gate.ok) return res.status(409).json({ installing: false, error: gate.reason });
      void installNow(); // swaps + exits on success; if it returns, it kept the current version
      return res.status(202).json({ installing: true, version: getAvailableUpdate()?.version ?? null });
    }
    const view = await checkOnly('manual');
    return res.json(view);
  }));

  // ── 404 + error handler ────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('API error', err);
    // #65: log the internal detail, return a GENERIC message — never leak stack/internal
    // strings to the client. (Routes with an actionable Steam/operational message return
    // their own 4xx/502 + message; this catch-all is for UNEXPECTED internal errors.)
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// ════════════════════════════════════════════════════════════════════════════
//  Bulk-import helpers
// ════════════════════════════════════════════════════════════════════════════

/** Parses mafiles/accounts.txt → Map<lowercaseUsername, password>. */
function readCredentialsFile(): Map<string, string> {
  const map = new Map<string, string>();
  const file = path.join(MAFILES_DIR, 'accounts.txt');
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const user = line.slice(0, idx).trim();
    const pass = line.slice(idx + 1); // passwords may legitimately contain ':'
    if (user) map.set(user.toLowerCase(), pass);
  }
  return map;
}

interface UnlinkedMaFile { file: string; accountName: string; hasPassword: boolean; }

/** Lists unregistered *.maFile in ./mafiles/, flagging password availability. */
function listUnlinkedMaFiles(accounts: AccountManager): UnlinkedMaFile[] {
  if (!fs.existsSync(MAFILES_DIR)) return [];
  const creds = readCredentialsFile();
  const out: UnlinkedMaFile[] = [];
  for (const file of fs.readdirSync(MAFILES_DIR)) {
    if (!file.toLowerCase().endsWith('.mafile')) continue;
    let accountName = '';
    try {
      accountName = (JSON.parse(fs.readFileSync(path.join(MAFILES_DIR, file), 'utf-8')).account_name as string) || '';
    } catch {
      continue;
    }
    if (!accountName) continue;
    // skip already-known: in the vault (vault mode) or registered in accounts.json (plaintext)
    if (AccountVault.isEnabled() ? AccountVault.hasAccount(accountName) : !!accounts.get(accountName)) continue;
    out.push({ file, accountName, hasPassword: creds.has(accountName.toLowerCase()) });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  Sanitizers
// ════════════════════════════════════════════════════════════════════════════

/** Recursively sanitizes every account inside the folder tree. */
function sanitizeTree(tree: import('../types/account').AccountTree): unknown {
  const mapNode = (node: import('../types/account').TreeNode): unknown => ({
    folder:   node.folder,
    children: node.children.map(mapNode),
    accounts: node.accounts.map(sanitizeAccount),
  });
  return {
    folders:  tree.folders.map(mapNode),
    accounts: tree.accounts.map(sanitizeAccount),
  };
}

/** Strips the password and redacts proxy credentials (resolved + override). */
function numQ(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function csErr(err: unknown): number { return (err as { status?: number }).status === 429 ? 429 : 400; }
function parseSearch(q: Record<string, unknown>): ListingSearchParams {
  const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    cursor: str(q.cursor), limit: num(q.limit), sort_by: str(q.sort_by), category: num(q.category),
    min_float: num(q.min_float), max_float: num(q.max_float), min_price: num(q.min_price), max_price: num(q.max_price),
    market_hash_name: str(q.market_hash_name), def_index: num(q.def_index), rarity: num(q.rarity),
    paint_seed: num(q.paint_seed), paint_index: num(q.paint_index), collection: str(q.collection),
    type: q.type === 'auction' ? 'auction' : q.type === 'buy_now' ? 'buy_now' : undefined,
  };
}

function sanitizeAccount(account: AccountConfig): Record<string, unknown> {
  const { password, networkOverride, ...rest } = account;
  void password;
  return {
    ...rest,
    // INV-A1 / C5: the dashboard should show the REAL "can confirm trades" capability
    // (maFile identity_secret), not the raw tier label. tier is now a projection of this.
    canConfirm: canConfirm({
      vaultEnabled: AccountVault.isEnabled(),
      vaultMaFileHasIdentitySecret: !!AccountVault.getAccount(account.username)?.maFile?.identity_secret,
      tier: account.tier,
    }),
    network: account.network
      ? { type: account.network.type, value: redactProxyCredentials(account.network.value) }
      : undefined,
    networkOverride: networkOverride
      ? { type: networkOverride.type, value: redactProxyCredentials(networkOverride.value) }
      : undefined,
  };
}

/** Redacts the proxy credentials of an environment and adds a hasProxy flag. */
function sanitizeEnvironment(env: Environment): Record<string, unknown> {
  return {
    ...env,
    proxy:    redactProxyCredentials(env.proxy),
    hasProxy: !!env.proxy.trim(),
  };
}

/**
 * The hostname portion of a Host header, correctly handling a bracketed IPv6 literal (B47).
 * `[::1]:3000` → `[::1]` (the old `.split(':')[0]` yielded `[`, 403-ing a legit ::1 bind and
 * disagreeing with originGuard). `localhost:3000` → `localhost`; `127.0.0.1:3000` → `127.0.0.1`.
 */
export function hostnameOnly(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end >= 0 ? h.slice(0, end + 1) : h; }
  return h.split(':')[0];
}

/** Redacts proxy credentials for display. Handles the URL form directly AND the legacy
 *  non-URL formats (host:port:user:pass etc.) via parseProxy, so a value stored by a
 *  pre-normalizeProxy version can never surface its user:pass in the env/account list (B24). */
export function redactProxyCredentials(value: string): string {
  const urlMasked = value.replace(/\/\/[^@/]+@/, '//***:***@');
  if (urlMasked !== value) return urlMasked;              // URL form → already masked
  const p = parseProxy(value);                            // legacy form → mask if it carries creds
  if (p && p.username) return `${p.scheme}://***:***@${p.host}:${p.port}`;
  return value;
}

/**
 * Reads at most the last `maxBytes` of a file ASYNCHRONOUSLY. The per-account logs
 * route uses this so a multi-MB log never blocks the event loop on a sync full-file
 * read (the recent lines are all the modal shows). Returns '' on any error/missing file.
 */
async function readFileTail(file: string, maxBytes: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Wraps an async route handler so rejected promises reach the error middleware. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
