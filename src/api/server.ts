import path from 'path';
import fs from 'fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';

import { AccountManager } from '../core/AccountManager';
import { SessionManager } from '../core/SessionManager';
import { STEAM_BROWSER_UA, STEAM_XHR_HEADERS } from '../network/steamHeaders';
import { StoreService } from '../store/StoreService';   // W3_30: store.steampowered.com client (W3_31/W4 dependents)
import { WalletRedeemJournal } from '../core/WalletRedeemJournal';   // W3_31: money-in dedup
import { normalizeCode, codeHash, codeMasked } from '../store/walletCode';   // W3_31: bearer-secret helpers
import { BatchJobService, JobRegistry } from '../core/BatchJobService';   // W3_32: batch engine
import { DistributeService } from '../trading/DistributeService';   // W3_33: item distribution
import { PaysafeService, PAYSAFE_AUTO_POLL_MS, PAYSAFE_MIN_MINOR, PAYSAFE_MAX_MINOR } from '../store/PaysafeService';   // W4_40: paysafecard top-up (Track B, flag-gated)
import { walletEurMinor, assertSteamHttpsUrl } from '../store/StoreService';      // W4_40: EUR-native wallet + URL guard
import { performWalletPurchase, ownedPackageIdsFrom, readStoreOwnedPackages, primeOwnership, CS2_APP_ID, type WalletPurchaseResult, type PrimeOwnership } from '../store/WalletPurchase';   // W4_41: wallet-only CS2 Prime purchase (+ 1.5.1 read-only ownership check)
import { GamePurchaseJournal, purchaseOpKey } from '../core/GamePurchaseJournal';   // W4_41: purchase double-spend dedup
import { generateBilling, generateBillingEmail } from '../trading/AccountTrader';  // W4_40: per-account billing (shared with market buy)
import { AccountImportService } from '../core/AccountImportService';
import { CsFloatService } from '../csfloat/CsFloatService';
import { CsFloatAutoAcceptWorker } from '../csfloat/CsFloatAutoAcceptWorker';
import { CsFloatBulkService } from '../csfloat/CsFloatBulkService';
import type { ListingSearchParams } from '../csfloat/CsFloatClient';
import { AppSettings } from '../core/AppSettings';
import { InventoryService } from '../core/InventoryService';
import { ValueHistoryService, GLOBAL_SERIES } from '../core/ValueHistoryService';
import { ProcessHealth } from '../core/ProcessHealth';
import { MoneyOpJournal } from '../core/MoneyOpJournal';
import { AccountVault, VAULT_NEWER_VERSION_ERROR } from '../core/AccountVault';
import { importDropZoneIntoVault, importCsvIntoVault, importExternalVault } from '../core/vaultBoot';
import { loadMaFileFromDisk, readCredentialsFile } from '../core/maFiles';
import { canConfirm } from '../core/accountCapability';
import { loadMaFile, generateTotpCode, msUntilNextTotp, identitySecretPresence, resolvePassword } from '../core/LoginFlow';
import { buildIsolatedSession, launchIsolatedBrowser } from '../trading/cleanBrowser';
import { getAvailableUpdate, getBlockedUpdate, getPriorCrash, getUpdateOutcome } from '../update/updateStatus';
import { checkOnly, canInstallNow, installNow, isUpdateOpInFlight } from '../update/updateScheduler';
import { TradeService, type AccountOffers, type OfferAction, type OfferActionTarget } from '../trading/TradeService';
import { isAmbiguousCommitFailure } from '../trading/commitAmbiguity';
import { MarketService, type MassSellGroup, type CancelOrderTarget } from '../trading/MarketService';
import { BuyService } from '../trading/BuyService';
import { BanService } from '../trading/BanService';
import { TradeUpService } from '../trading/TradeUpService';
import { CasketService } from '../trading/CasketService';
import { GcActionLayer } from '../trading/GcActionLayer';
import { cs2Schema } from '../core/Cs2SchemaService';
import type { SellStrategy } from '../pricing/MarketPricing';
import { sellerNetFromBuyer } from '../pricing/MarketPricing';   // W1_12: per-item net for the Dashboard summary
import { AgentFactory, normalizeProxy, parseProxy, redactProxyCredentials } from '../network/AgentFactory';
export { redactProxyCredentials } from '../network/AgentFactory';
import { proxyHealth, proxyKey } from '../network/ProxyHealth';
import { loadPersisted as loadCmProtocolPersisted } from '../network/CmProtocol';
import { PricingService } from '../pricing/PricingService';
import { currencyInfo, knownCurrencyInfo } from '../pricing/currencies';
import { ExchangeRateService } from '../pricing/ExchangeRateService';

import type { AccountConfig, NetworkConfig, Environment, ProxyRule } from '../types/account';
import type { AccountInventory } from '../types/inventory';
import { logger, LOG_FILE, redactSecrets, recentLogLines, liveLogBus, type LiveLogLine } from '../utils/logger';
import { classifyNetworkError } from '../utils/errorClass';   // 429 vs 5xx on the confirmations routes
import { bucketOf } from '../core/MarketModel';                  // the one item-state classifier
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

// One-time warn de-dupe for malformed protectedUntil values: keyed by
// username+"\0"+value so a new bad hand-edit warns once, not every request. Grows only
// on a first-seen malformed value (a hand-edit event, not a hot path); a restart clears it.
const warnedBadProtectedUntil = new Set<string>();

// ── Money-operation route matcher (circuit-breaker gate, #16 / B13) ────────────
// Every POST that spends money, moves an asset, or approves a pending confirmation
// must be refused while ProcessHealth has money ops quarantined (possibly-corrupt
// in-memory state). Case-insensitive (Express routing is); the (\/|$) anchor keeps
// read-ish siblings (buy-price / search / *-status / listings/:id edits) OUT. Exported
// so the route-set is unit-testable (a new money route must be added here too).
//   • Steam market/trade: trade send/mass-send/offer-action/offers-batch, market
//     buy/sell/cancel-listing/cancel-buy-order/folder-buy, tradeup/{execute,auto}, casket/move.
//   • CSFloat REAL-CASH ops: csfloat/<user>/{buy, listings (create), buy-orders (create),
//     bulk-list, bulk-delist, bulk-reprice}, and csfloat/<user>/deliver — which SENDS the sold
//     asset in a real, 2FA-confirmed Steam offer, so it belongs here for the same reason trade/send does.
//   • Mobile confirmation approval: accounts/<user>/confirmations/respond (finalizes trades).
//   • Steam STORE spend: steam/<user>/buy-prime (W4_41 — wallet-funded package purchase).
export const MONEY_OP_ROUTE = /^\/api\/(?:(?:trade\/(?:send|mass-send|offer-action|offers-batch)|market\/(?:buy|sell|cancel-listing|cancel-buy-order|folder-buy)|tradeup\/(?:execute|auto)|casket\/move)(?:\/|$)|(?:csfloat\/[^/]+\/(?:buy|listings|buy-orders|bulk-list|bulk-delist|bulk-reprice|deliver)|accounts\/[^/]+\/confirmations\/respond|steam\/[^/]+\/buy-prime)$)/i;

// ── W2_20 (Accounts module): owned-games / profile / free-license types + helpers ──
// NOTE: these routes need a live Steam session; their runtime behavior is verified on a
// real account (joint acceptance test), not in CI. steam-user under-types the app/license
// methods, so a local shim keeps the routes type-safe without `any` leaks on the hot path.
interface OwnedGame { appId: number; name: string; playtimeMinutes: number; iconUrl?: string }
interface SteamUserApps {
  steamID?: { toString(): string } | null;
  licenses?: Array<{ package_id: number }>;
  getUserOwnedApps(steamID: unknown, options?: { includeAppInfo?: boolean; includePlayedFreeGames?: boolean }):
    Promise<{ app_count: number; apps: Array<{ appid: number; name?: string; playtime_forever?: number; img_icon_url?: string }> }>;
  getProductInfo(apps: number[], packages: number[], inclTokens?: boolean):
    Promise<{ apps: Record<string, { appinfo?: { common?: { name?: string; type?: string } } }>; packages: Record<string, { packageinfo?: { appids?: number[] } }> }>;
  requestFreeLicense(appIDs: number[]): Promise<{ grantedPackageIds: number[]; grantedAppIds: number[] }>;
}
interface CommunityProfileApi {
  editProfile(settings: Record<string, unknown>, cb: (err: Error | null) => void): void;
  profileSettings(settings: Record<string, unknown>, cb: (err: Error | null) => void): void;
  uploadAvatar(image: string, format: string | undefined, cb: (err: Error | null, url: string) => void): void;
}
interface ProfileEditBody { name?: string; realName?: string; summary?: string; avatar?: string; privacy?: Record<string, unknown> }

/** Map a {profile,inventory,gameDetails,…: 'public'|'friends'|'private'|1|2|3} body to the
 *  steamcommunity profileSettings keys with PrivacyState ints (Private:1, FriendsOnly:2, Public:3). */
function mapPrivacy(input: Record<string, unknown>): Record<string, number> {
  const STATE: Record<string, number> = { private: 1, friendsonly: 2, friends: 2, public: 3 };
  const toState = (v: unknown): number | undefined =>
    (typeof v === 'number' && v >= 1 && v <= 3) ? v
      : (typeof v === 'string' ? STATE[v.toLowerCase()] : undefined);
  const out: Record<string, number> = {};
  for (const k of ['profile', 'comments', 'inventory', 'inventoryGifts', 'gameDetails', 'playtime', 'friendsList']) {
    const s = toState(input[k]); if (s !== undefined) out[k] = s;
  }
  return out;
}

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
  store:     StoreService;
  pricing:   PricingService;
  exchange:  ExchangeRateService;
  history:   ValueHistoryService;
  gc:        GcActionLayer;
  tradeup:   TradeUpService;
  casket:    CasketService;
  accountImport: AccountImportService;
  csfloat:       CsFloatService;
  csfloatBulk:   CsFloatBulkService;
  csfloatWorker: CsFloatAutoAcceptWorker;
  /** W4_40. Owns a background credit-poll timer + in-memory run state, so teardown must shut it down
   *  (like csfloatWorker) — otherwise a re-license discards the server while the poll keeps firing. */
  paysafe:       PaysafeService;
}

/** Shared egress probe for the two proxy-test routes (T4): ipify egress + best-effort ip-api geo
 *  through a throwaway agent, redacted + logged. The single-use agent is destroyed in `finally`. */
async function checkEgress(network: NetworkConfig, label: string): Promise<Record<string, unknown>> {
  const { httpsAgent } = AgentFactory.create(network, { pooled: false });
  const started = Date.now();
  try {
    const resp = await axios.get('https://api.ipify.org?format=json', { httpsAgent, proxy: false, timeout: 10_000, validateStatus: () => true });
    const latencyMs = Date.now() - started;
    const ip = resp.data && typeof resp.data.ip === 'string' ? resp.data.ip : null;
    if (resp.status !== 200 || !ip) {
      logger.warn(`[proxy-check] ${label}: HTTP ${resp.status} (${latencyMs} ms)`);
      return { ok: false, mode: network.type, latencyMs, error: `HTTP ${resp.status}` };
    }
    let country: string | null = null, countryCode: string | null = null;
    try {
      const geo = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, { proxy: false, timeout: 6_000, validateStatus: () => true });
      if (geo.status === 200 && geo.data && geo.data.status === 'success') {
        country     = typeof geo.data.country === 'string' ? geo.data.country : null;
        countryCode = typeof geo.data.countryCode === 'string' ? geo.data.countryCode : null;
      }
    } catch { /* geo is optional – never fail the check over it */ }
    logger.info(`[proxy-check] ${label}: OK ${ip}${countryCode ? ` (${countryCode})` : ''} (${latencyMs} ms, ${network.type})`);
    return { ok: true, mode: network.type, ip, country, countryCode, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = redactSecrets((err as Error).message); // a proxied failure embeds user:pass creds
    logger.warn(`[proxy-check] ${label}: FAILED ${message} (${latencyMs} ms)`);
    return { ok: false, mode: network.type, latencyMs, error: message };
  } finally {
    try { (httpsAgent as { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
  }
}

/** Creates the core services and wires their lifecycle events into the logger. */
export function createDeps(): ApiDeps {
  // Seed the CM-protocol learning from disk before any login, so a known-CONNECT-blocked provider is
  // not re-demoted (two failed logins) every run; stale entries (>24h) re-probe TCP. (owner 2026-07-10.)
  loadCmProtocolPersisted();
  const accounts  = new AccountManager();
  const sessions  = new SessionManager();
  // Per-login proxy resolution: SessionManager re-resolves each account's egress AT login (advancing
  // the rotation cursor) and fail-closes if the winning rule's pool is lost. When proxy rules aren't
  // authoritative this returns the same legacy value as before — fully backward compatible.
  sessions.setLoginNetworkResolver((a) => accounts.networkForLogin(a));
  // …and the PEEK twin (no cursor advance) so every session-reuse site can tell whether a resident
  // session's egress is still the one the rules resolve today. Without it a proxy⇄local switch only
  // took effect after a restart, because the running jobs kept reusing the pre-change sessions.
  sessions.setEgressPeekResolver((u) => accounts.get(u)?.network);
  const inventory = new InventoryService(sessions, accounts);
  const store     = new StoreService(sessions, accounts);   // W3_30: store-domain client (no routes here; W3_31 adds them)
  // One shared money-op journal: a crash mid buy/send can't be double-fired by a user retry after
  // restart. Shared so buy and send op-hashes live in one file.
  const moneyJournal = new MoneyOpJournal();
  // Trades gets the inventory cache so the send path can refuse trade-locked / non-tradable
  // assets before an offer is created.
  const trades    = new TradeService(sessions, accounts, inventory, moneyJournal);
  // How many authenticated pricer identities the background fill borrows, and — the load-bearing
  // half — how many of them may sit on ONE exit IP.
  //
  // Raised from 3 (2026-08-25): at 3 lanes × one request per 3.5s the fill was capped near 51
  // names/min no matter how much egress existed, which is why it crawled next to the sell preview
  // (3 workers, NO inter-request delay). But the cap that keeps this SAFE is the per-exit one, not
  // the total: Steam meters per exit IP, so a single-exit setup (proxyless, one static proxy, or one
  // ROTATING proxy — all one egressKey) must never be driven harder than the 3-lane pace that
  // already shipped. PRICE_LANES_PER_EXIT pins that; PRICE_IDENTITY_LANES only decides how many
  // EXITS the fill may spread over (36 ≈ 12 exits × 3).
  const PRICE_IDENTITY_LANES  = 36;
  const PRICE_LANES_PER_EXIT  = 3;
  // The sell-preview / buy-autofill borrow far fewer: those are INTERACTIVE reads of a handful of names
  // behind a 90s budget, and they must not evict the background fill's spread or fan a modal across the
  // whole proxy pool. MarketService caps itself at 3 workers anyway, and spreads them one per exit.
  const PREVIEW_IDENTITY_LANES = 3;
  // Market gets the inventory cache so a completed mass-sell moves the just-listed assets
  // Owned→Listed immediately (optimistic), rather than waiting on a follow-up refresh. It also gets the
  // pricer-identity pool so a sell-preview whose acting bot isn't web-ready still prices through a live
  // authenticated identity instead of an anonymous host-IP read that 429s → "no price" (2026-07-10 fix).
  // maxPerExit = the full lane count here, deliberately: the preview must still be able to borrow 3
  // DISTINCT accounts when they all share one exit (that is what it did before, and MarketService
  // otherwise collapses to one borrowed cookie driven at 3× concurrency). Spreading across exits is
  // preferred when they exist; it just isn't a cap on this path.
  const market    = new MarketService(trades, inventory, () => sessions.pricerIdentities(PREVIEW_IDENTITY_LANES, PREVIEW_IDENTITY_LANES));
  // The ask reader is passed as a callback, not as a service handle: MarketService already depends
  // on TradeService, so handing BuyService the whole object would close a dependency cycle.
  const buy       = new BuyService(trades, inventory, moneyJournal,
    (name, appId, currency, username) => market.lowestAskDetailed(name, appId, currency, username));
  const bans      = new BanService(accounts, sessions, trades);
  // Feature 2 "CSFloat": per-account marketplace control. Built before pricing so the
  // CSFloat price source (Feature 3) can reuse it.
  const csfloat   = new CsFloatService(accounts);
  // IDENTITY-BUDGETED PRICING (2026-07-10 root-cause fix). Steam meters ANONYMOUS market/priceoverview
  // per EXIT IP, and the fleet's shared rotating residential pool arrives PRE-EXHAUSTED for that endpoint
  // (other tenants spent it), so a cold anonymous request 429s while authenticated traffic on the same
  // proxies sails through. The fix: the fill rides real LOGGED-IN identities — each Steam lane sends an
  // account's steamLoginSecure cookie over that account's own egress agent, drawing that account's
  // per-session budget. With no session web-ready yet it DEFERS (never anonymous) and `kick()` restarts it
  // once a session logs in. (The old proxy-string provider, its 60-80s per-name retry and the
  // foreground gate are gone — they were treating the symptom.)
  const pricing   = new PricingService(csfloat, () => sessions.pricerIdentities(PRICE_IDENTITY_LANES, PRICE_LANES_PER_EXIT));
  // Restart a deferred Steam fill the moment an authenticated session becomes web-ready.
  sessions.on('webSession', () => pricing.kick());
  const exchange  = new ExchangeRateService();
  // Shared GC action layer (trade-up + casket execution; gated behind SSIM_GC_VERIFIED).
  const gc        = new GcActionLayer(sessions);
  const tradeup   = new TradeUpService(inventory, pricing, cs2Schema, gc);
  const casket    = new CasketService(gc, inventory, pricing);
  // GC-preferred reader so the worth curve counts GC records (incl. listed items), not just web.
  // peekCached: clone-free read — the snapshot only sums two numbers per account and
  // treats the record read-only (totalsOf never mutates it), so cloning the fleet per snapshot is
  // pure event-loop stall.
  const history   = new ValueHistoryService(
    accounts,
    { get: (u) => inventory.peekCached(u, 'cs2') }, // CS2 (GC-preferred merged view)
    { get: (u) => inventory.peekCached(u, 'tf2') }, // TF2 (parallel worth curve)
    pricing, exchange,
  );
  exchange.start();

  // One value-history point per settled refresh (worth/wallet curve).
  inventory.onRefreshComplete((reason, game) => history.snapshotAll(reason, game));

  // The 'error' listener is mandatory – Node throws on an unhandled 'error' event.
  sessions.on('error',        (u, e) => logger.error(`[${u}] ${e.message}`));
  sessions.on('disconnected', (u, r) => logger.warn(`[${u}] disconnected: ${r}`));
  // Cache each account's permanent SteamID on its first login (write-through to accounts.json),
  // so it's resolvable without a login forever after — used by the ban checker and any feature
  // needing a SteamID. getSteamID64() is an exact string (the maFile's numeric value is lossy).
  sessions.on('loggedIn',     (u, steamId) => { if (steamId) accounts.rememberSteamId(u, steamId); });

  // Feature 1 "Account Login": QR / credentials import → token-first Limited accounts.
  const accountImport = new AccountImportService(accounts, sessions);
  // Feature 2 "CSFloat": auto-accept delivery worker (CsFloatService is built above, before pricing).
  const csfloatBulk   = new CsFloatBulkService(csfloat);
  const csfloatWorker = new CsFloatAutoAcceptWorker(accounts, trades, csfloat);
  csfloatWorker.start();

  // ── W4_40 — paysafecard top-up (Track B): SEQUENTIAL, human-in-the-loop, browser-driven.
  //    SSIM opens each account's addfunds checkout pre-authenticated + reconciles by wallet READ-BACK.
  //    The PIN is entered ON THE PAGE (never in SSIM); SSIM only sequences accounts + verifies credits.
  //    EUR-ONLY (owner 2026-07-10). ON by default; only SSIM_PAYSAFE_EXPERIMENTAL=0 hard-disables it.
  //    Built here (not in createApp) because it owns a background timer + run state that teardown must stop.
  const paysafeEnabled = (): boolean => process.env.SSIM_PAYSAFE_EXPERIMENTAL !== '0';
  // Steam sessions this feature logged in. Released once the run moves past the account, so a long batch
  // cannot walk the fleet into the resident-session ceiling. A session another operation already owned is
  // never added here, and therefore never torn down under it.
  const paysafeOwned = new Set<string>();

  /** The account's wallet in EURO-CENTS. NO FX anywhere on this path: baseline and read-back are the same
   *  native unit, so a moving exchange rate cannot manufacture a phantom credit. A non-EUR wallet reads as
   *  null → classify() says 'unconfirmed', never a guessed credit.
   *  `allowLogin:false` reads the RESIDENT session — Steam pushes ClientWalletInfoUpdate to it on every
   *  balance change, so the credit lands here with no login at all. `allowLogin:true` forces one fresh
   *  login as a periodic staleness backstop, and awaits the wallet event rather than racing it (the login
   *  promise resolves on 'webSession', which can beat 'wallet'). */
  const paysafeWalletMinor = async (username: string, allowLogin: boolean): Promise<number | null> => {
    const account = accounts.get(username);
    if (!account) return null;
    if (!allowLogin) {
      if (!sessions.isLive(username)) return null;
      // This poll IS a genuine use of the session — mark it, or the idle reaper may retire the very session
      // the cheap read depends on. (The forced-login backstop would recover, but the design shouldn't rely
      // on luck.)
      sessions.markUsed(username);
      return walletEurMinor(sessions.getSession(username)?.wallet) ?? null;
    }
    try {
      // Ownership MUST come from loginAccountOwned, not from an isLive() probe: loginAccount dedups an
      // in-flight login, and a login another operation started is not yet in `sessions`, so isLive() would
      // read false, we'd join THEIR login, claim the session as ours, and releaseAccount would later log it
      // out from under them. loginAccountOwned decides `createdByCall` synchronously, before any await.
      const { createdByCall } = await sessions.loginAccountOwned(account);
      if (createdByCall) paysafeOwned.add(username.toLowerCase());
      return walletEurMinor(await sessions.awaitWallet(username)) ?? null;
    } catch { return null; }
  };

  const paysafe = new PaysafeService({
    enabled: paysafeEnabled,
    // HEADLESS-INIT (owner 2026-07-10): SSIM does the Steam side over HTTP (amount + paysafecard + the per-account
    // synthetic billing → the externallink URL), then opens the clean browser DIRECTLY on the paysafecard page. No
    // Steam window, no DOM driving. The init NEVER moves money (the charge happens only when the operator
    // finishes on paysafecard) and fails closed — a throw means 'error', no browser, and so no charge.
    openCheckout: async (username, checkout) => {
      const account = accounts.get(username);
      if (!account) throw Object.assign(new Error(`Account "${username}" not found`), { status: 404 });
      const init = await store.initPaysafeCheckout(username, {
        amountMinor: checkout.amountMinor,
        billing: { ...generateBilling(username), email: generateBillingEmail(username) },
      });
      // initPaysafeCheckout keeps the session alive for the credit poll; note the ownership so we release it.
      if (init.sessionOwned) paysafeOwned.add(username.toLowerCase());
      // Defence in depth: never drive the browser to a URL read out of a JSON field. (cleanBrowser pins the
      // cookies to the Steam domains, so this cannot leak them — but it can still open an arbitrary page
      // through the account's proxy.)
      assertSteamHttpsUrl(init.externalUrl, 'paysafecard checkout');
      // Open the paysafecard page (Steam's externallink 302s to it) with the account's captured cookies
      // + resolved proxy — so the return→finalize happens in an authenticated, correctly-egressing window.
      const spec = buildIsolatedSession({ username: account.username, cookieStrings: init.cookies, network: init.network ?? account.network, landingUrl: init.externalUrl });
      if (account.network?.type === 'proxy' && !spec.proxyServer) {
        throw Object.assign(new Error("could not resolve this account's proxy — refusing to open (would leak the host IP)"), { status: 400 });
      }
      const r = await launchIsolatedBrowser(spec);
      return { warnings: [...spec.warnings, ...init.warnings], proxy: r.proxyUsed, walletMinor: init.walletMinor };
    },
    readWalletMinor: (username, opts) => paysafeWalletMinor(username, opts.allowLogin),
    releaseAccount: async (username) => {
      const key = username.toLowerCase();
      if (!paysafeOwned.delete(key)) return;   // not ours → never tear down another operation's session
      try { if (sessions.isLive(key)) await sessions.logoutAccount(key); }
      catch (e) { logger.warn(`[paysafe] ${username}: session release failed: ${(e as Error).message}`); }
    },
  }, () => Date.now(), PAYSAFE_AUTO_POLL_MS);   // enable the background credit poll (auto-advance)

  return { accounts, sessions, trades, market, buy, bans, inventory, store, pricing, exchange, history, gc, tradeup, casket, accountImport, csfloat, csfloatBulk, csfloatWorker, paysafe };
}

// ════════════════════════════════════════════════════════════════════════════
//  Express app
// ════════════════════════════════════════════════════════════════════════════

export function createApp(deps: ApiDeps): Express {
  const { accounts, sessions, trades, market, buy, bans, inventory, store, pricing, exchange, history, tradeup, casket, accountImport, csfloat, csfloatBulk, csfloatWorker, paysafe } = deps;
  const app = express();

  const VALID_STRATEGIES: SellStrategy[] = ['lowest', 'undercut', 'custom'];

  /**
   * Reads + validates a custom sell price (required only for strategy='custom'). MAJOR units
   * (2.05, not 205) because it is applied in each selling bot's own wallet currency, whose
   * minor-unit scale differs per bot (2.05 → 205 on a 2-decimal wallet, 2 on a 0-decimal one).
   * Same contract as a folder mass-buy's pricePerItemMajor.
   */
  const readCustomMajor = (raw: unknown): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  /** A client-supplied Steam currency code, or undefined. Only ever selects the DENOMINATION of
   *  a price READ (the preview); the committed sell price is re-resolved from the bot's own wallet. */
  const readCurrency = (raw: unknown): number | undefined => {
    const n = Number(raw);
    return Number.isFinite(n) && knownCurrencyInfo(n) ? n : undefined;
  };

  /**
   * Overlays an account's MANUAL trade-protection date onto a (possibly cached)
   * inventory so it shows as locked instantly, without waiting for a live refresh.
   * Account-level protection applies uniformly to every item, so stacks stay valid.
   */
  const applyManualLock = (inv: AccountInventory): AccountInventory => {
    const acc = accounts.get(inv.username);
    const raw = acc?.protectedUntil;
    if (!raw) return inv;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) {
      // Malformed hand-edit (e.g. German-locale "31.12.2026"): the protection the
      // operator meant to set is not active. Fail open (indefinite fail-closed would
      // silently freeze legitimate operations), but say so once so it's not silent.
      const key = `${inv.username}\0${raw}`;
      if (!warnedBadProtectedUntil.has(key)) {
        warnedBadProtectedUntil.add(key);
        logger.warn(`[${inv.username}] protectedUntil "${raw}" is not a parseable date — manual protection is NOT active (use ISO 8601, e.g. 2026-12-31)`);
      }
      return inv;
    }
    if (t > Date.now()) {
      const until = new Date(t);
      for (const it of inv.items) {
        const cur = it.tradeLockExpiry ? new Date(it.tradeLockExpiry) : null;
        if (!cur || t > cur.getTime()) it.tradeLockExpiry = until;
      }
    }
    return inv;
  };

  /**
   * Re-derives each item's strict dashboard bucket from its FINAL lock state
   * (after the manual-protection overlay), so a manual lock correctly flips an
   * item into 'tradelocked'. 'listed' is sticky (market-sourced, never in-inv).
   * Only meaningful for GC-sourced inventories (the web view doesn't categorise).
   *
   * Delegates to `bucketOf` — the one classifier (it short-circuits 'listed' itself). This used to
   * hand-roll the split as `locked ? 'tradelocked' : 'tradable'`, which tagged every PERMANENTLY
   * untradable item (Storage Unit, Veteran Coin, badge, music kit) as 'tradable' — the exact opposite
   * of what bucketOf decided at refresh time. Two disagreeing classifiers is how a Storage Unit came to
   * sit under the "Owned Items" chip while its status cell read "Locked". (2026-07-10)
   */
  const tagCategories = (inv: AccountInventory): void => {
    const now = Date.now();
    for (const it of inv.items) it.category = bucketOf(it, now);
  };

  /** Enriches an inventory with cached prices + manual protection; queues misses. */
  const enrichInv = (inv: AccountInventory): AccountInventory => {
    const missing = pricing.enrich(inv);
    if (missing.length) pricing.ensureFilled(missing);
    applyManualLock(inv);
    if (inv.source === 'gc') tagCategories(inv);
    return inv;
  };

  // W3_33 distribute is constructed here (not in createDeps) so its cache reads flow through the
  // same enrichInv the GET /api/inventory route uses — price, manual-lock, and category tagging.
  // Bug (2026-07-09): built in createDeps against the raw InventoryService, whose getCached returns
  // UN-enriched clones (price is a read-time enrichment, never persisted), so planDistribute's
  // `it.price == null` guard skipped every item → empty pool → "nothing to distribute" (button greyed
  // out as "not possible"). getCached already returns a fresh clone, so enrichInv mutates a throwaway.
  const distribute = new DistributeService({
    inventory: { getCached: (u, g) => { const inv = inventory.getCached(u, g); return inv ? enrichInv(inv) : undefined; } },
    trades,
  });

  // ── Security hardening ─────────────────────────────────────────────────────
  // NO CORS layer: the dashboard is served same-origin from this very server, so no
  // cross-origin caller is ever legitimate. (An open `cors()` would let any website the
  // operator visits script against this credential-bearing API.)
  // The DNS-rebind (Host allowlist) + anti-CSRF (Origin/Referer) checks live in one place —
  // `sameOriginGuard` (mounted below). It was previously duplicated by two inline layers here,
  // whose fixed boundHost allowlist wrong-blocked the sanctioned LAN opt-in (HOST=<LAN-IP>) that
  // the guard already handles via same-origin match; the inline layers were removed.
  // JSON body limit raised: mass-send/mass-sell payloads with thousands of
  //    asset ids exceed express' 100kb default (→ silent HTTP 413 failures).
  app.use(express.json({ limit: '5mb' }));
  // SECURITY: redact secrets from every JSON error string in one place. Many money/route
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
  // SECURITY: same-origin / anti-CSRF + DNS-rebind guard (see originGuard.ts). Mounted before all
  // routes (after the body-parse and error-redaction middleware) so it covers the page load and
  // every /api route: a malicious web page the operator visits cannot drive state-changing money
  // calls (trade/buy/sell) against the localhost API.
  app.use(sameOriginGuard);
  // SECURITY (B26/P5): the capability-token guard authenticates the dashboard to the
  // backend so a random LOCAL process cannot drive money/vault ops even by forging Origin.
  // Mounted after the origin guard, before the routes.
  app.use(capabilityGuard);

  // SSIM identity marker (unauthenticated GET): lets the Tauri shell confirm the responder on the
  // UI port is SSIM — not a foreign app that merely accepts TCP — before it navigates.
  app.get(SSIM_HEALTH_PATH, (_req: Request, res: Response) => { res.type('text/plain').send(SSIM_HEALTH_MARKER); });

  // Serve index.html with the capability bootstrap injected in dev / Edge (no shell). In
  // sidecar (Tauri) mode the shell injects window.__SSIM_CAP__ out-of-band, so index.html
  // is served CLEAN (a scraping GET / must not reveal the token). Placed before static.
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

  // Frontend error sink: the WebView2 renderer has no visible console, so an uncaught error /
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
  //    after an internal error burst, refuse new money POSTs (buy/sell/trade) with an
  //    actionable 503 instead of acting on possibly-corrupt in-memory state. Reads and
  //    existing sessions stay up; the operator restarts to recover.
  // The route-set lives in the exported MONEY_OP_ROUTE (unit-tested); it now also
  // covers the CSFloat real-cash ops and the mobile-confirmation approval that the
  // original regex missed.
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
    // `egress` is the RESOLVED truth for the environment (see environmentEgress). Post-cutover the legacy
    // `env.proxy` field is retired and always empty (see the POST guard below), so a UI that renders only
    // `hasProxy`/`proxy` reported "Local IP (no proxy)" for every environment even while a proxy RULE was
    // live and working. The rule engine is fleet-wide, so resolve once here and group by environment
    // rather than re-sweeping per env. (v1.4.4 — owner issue 1.)
    const egressByEnv = environmentEgress(accounts);
    res.json(accounts.getEnvironments().map(e => ({
      ...sanitizeEnvironment(e),
      accountCount: accounts.countInEnvironment(e.id),
      egress: egressByEnv.get(e.id) ?? emptyEgress(),
    })));
  });

  app.post('/api/environments', (req: Request, res: Response) => {
    const { name, proxy, color } = req.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name is required' });
    }
    // F8: post-cutover, the env proxy field is retired — a supplied proxy is a legacy write the engine
    // ignores. Reject loudly rather than 201 a false success. (Pre-cutover: unchanged.)
    if (typeof proxy === 'string' && proxy.trim() && accounts.isProxyRulesAuthoritative()) {
      return res.status(400).json({ error: 'proxies are managed in the Proxies module — add an environment-scoped rule there' });
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
    // F8: post-cutover the env proxy is managed as an env-scope rule — reject any proxy edit (set OR
    // clear) rather than persist a legacy write the resolver ignores. Name/colour edits still work.
    if (proxy !== undefined && accounts.isProxyRulesAuthoritative()) {
      return res.status(400).json({ error: 'proxies are managed in the Proxies module — add/edit an environment-scoped rule there' });
    }
    try {
      const env = accounts.updateEnvironment(req.params.id, { name, proxy: typeof proxy === 'string' && proxy.trim() ? normalizeProxy(proxy) : proxy, color });
      // A changed environment proxy changes every inheriting account's egress → drop their CSFloat
      // clients so the next request rebuilds on the new IP (mirrors the per-account PATCH above).
      if (proxy !== undefined) {
        for (const a of accounts.getAll().filter(a => a.environmentId === req.params.id)) csfloat.invalidateClient(a.username);
      }
      res.json(sanitizeEnvironment(env));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── DELETE /api/environments/:id[?cascade=1] ───────────────────────────────
  // Without `cascade` this is unchanged: an environment that still holds accounts is refused (409),
  // and the operator moves them out first.
  //
  // With `cascade=1` the environment is deleted TOGETHER WITH every account in it. That is
  // irreversible, so the UI gates it behind a typed "DELETE"; this route does not trust that gate
  // and re-reads the membership itself. Each account is torn down through EXACTLY the steps
  // DELETE /api/accounts/:username performs — session logout, all three inventory caches, the
  // accounts DB row, the vault secrets — so the two paths can never drift apart. The difference is
  // batching: removals and vault purges collapse into one write each instead of one per account.
  //
  // Ordering is deliberate. Sessions go FIRST, while the account rows still exist (logoutAccount
  // resolves the account), and the environment row goes LAST, so a crash mid-cascade leaves
  // already-purged accounts gone and the environment still present — recoverable by re-running the
  // delete — rather than an environment-less set of orphan accounts.
  app.delete('/api/environments/:id', asyncHandler(async (req, res) => {
    const env = accounts.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: `Environment "${req.params.id}" not found` });
    const cascade = req.query.cascade === '1' || req.query.cascade === 'true';
    const held = accounts.getByEnvironment(req.params.id).map(a => a.username);

    if (held.length > 0 && !cascade) {
      return res.status(409).json({ error: `Environment still holds ${held.length} account(s) – move them out first` });
    }

    if (cascade && held.length > 0) {
      logger.warn(`[env-delete] CASCADE "${env.name}" (${env.id}) – deleting ${held.length} account(s): ${held.join(', ')}`);
      // Sessions first (best-effort per account: one stuck logout must not strand the whole delete).
      for (const username of held) {
        await sessions.logoutAccount(username).catch((e) => {
          logger.warn(`[env-delete] ${username}: session logout failed (${(e as Error).message}) – continuing`);
        });
        inventory.store.delete(username);
        inventory.tf2Store.delete(username);
        inventory.gcStore.delete(username);
        csfloat.invalidateClient(username);   // drop the cached client still holding this account's raw API key
      }
      accounts.removeMany(held);
      AccountVault.removeAccounts(held); // password + refresh token + CSFloat key + per-account proxy
    }

    try {
      // `held` is passed through so the rule-target prune can drop the account-scoped proxy rules of
      // the accounts removed just above — by now they are off the books, so it cannot rediscover them.
      accounts.deleteEnvironment(req.params.id, { cascade, removedUsernames: cascade ? held : [] });
      res.json({ ok: true, deletedAccounts: cascade ? held.length : 0, usernames: cascade ? held : [] });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  }));

  // ── GET /api/environments/:id/proxy ────────────────────────────────────────
  // Returns the environment's proxy UN-redacted so the edit dialog can pre-fill
  // the field with the exact saved string (the list view stays redacted via
  // sanitizeEnvironment). Clearing that field on save sends proxy:'' → the env
  // (and every account inheriting it) runs on the local IP. Localhost-only; the
  // operator is explicitly editing their own environment.
  app.get('/api/environments/:id/proxy', (req: Request, res: Response) => {
    const env = accounts.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: `Environment "${req.params.id}" not found` });
    // Vault-aware: in vault mode the proxy lives encrypted in the vault, not in accounts.json.
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
    return res.json(await checkEgress(network, env.name)); // T4: shared probe (logged + redacted)
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  Proxy rules (v5) — declarative proxy assignment (most-specific match wins)
  // ════════════════════════════════════════════════════════════════════════
  // Every proxy VALUE that leaves the server is credential-redacted (redactProxyCredentials keeps the
  // non-secret host:port, so the UI can still dedupe / warn). Raw values are exposed ONLY by the
  // narrow per-rule /reveal pre-fill. Mutations eagerly rebuild the CSFloat client for any account
  // whose egress changed. Auto capability+CSRF-guarded like every /api/* mutation.
  //
  // Steam SESSIONS are deliberately NOT torn down here. A resident session pins its egress at login,
  // so it must not be reused after a rule change — but destroying it from under a trade or a refresh
  // that is mid-flight would break that operation to fix a config edit. Instead every session-reuse
  // site (InventoryService.ensureSession, TradeService.getTrader / ensureWebSession) asks
  // SessionManager.isEgressStale first and re-logs-in when the answer is yes, so the change is live
  // on the NEXT operation with nothing interrupted — and the idle reaper retires whatever is left.
  // This is what removed the "switching between proxy and local needs a restart" behaviour (1.5.1).

  const sanitizeProxyRule = (rule: ProxyRule): Record<string, unknown> => ({
    ...rule,
    proxies:    rule.proxies.map(p => redactProxyCredentials(p)),
    proxyCount: rule.proxies.length,
  });

  app.get('/api/proxies/rules', (_req: Request, res: Response) => {
    res.json({ rules: accounts.getProxyRules().map(sanitizeProxyRule), authoritative: accounts.isProxyRulesAuthoritative() });
  });

  // Un-redacted pool for the edit dialog pre-fill (owner-only, capability-guarded — same trust model
  // as GET /api/environments/:id/proxy). Narrow: a single rule, never the fleet-wide list.
  app.get('/api/proxies/rules/:id/reveal', (req: Request, res: Response) => {
    const rule = accounts.getProxyRules().find(r => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'Proxy rule not found' });
    res.json({ id: rule.id, proxies: rule.proxies });
  });

  // Parse/normalize/dedupe a pasted proxy list without storing anything — drives the add/edit modal's
  // valid / invalid / duplicate hints. Returns redacted (never raw) normalized values + host:port key.
  app.post('/api/proxies/validate', (req: Request, res: Response) => {
    const list: unknown[] = Array.isArray(req.body?.proxies) ? req.body.proxies : [];
    const seen = new Set<string>();
    const results = list.map((raw) => {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (!s) return { input: String(raw ?? ''), valid: false, reason: 'empty' };
      const parsed = parseProxy(s);
      if (!parsed) return { input: s, valid: false, reason: 'unparseable' };
      const norm = normalizeProxy(s);
      const key = norm.toLowerCase();
      const dup = seen.has(key);
      seen.add(key);
      return { input: s, valid: true, dup, key: `${parsed.host}:${parsed.port}`, redacted: redactProxyCredentials(norm) };
    });
    res.json({ results });
  });

  app.post('/api/proxies/rules', (req: Request, res: Response) => {
    try {
      const { name, scope, targets, kind, proxies, pinPerAccount, enabled } = req.body ?? {};
      const { rule, affected } = accounts.addProxyRule({ name, scope, targets: targets ?? [], kind: kind ?? 'pool', proxies, pinPerAccount, enabled });
      for (const u of affected) csfloat.invalidateClient(u);
      res.status(201).json(sanitizeProxyRule(rule));
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.patch('/api/proxies/rules/:id', (req: Request, res: Response) => {
    try {
      const { rule, affected } = accounts.updateProxyRule(req.params.id, req.body ?? {});
      for (const u of affected) csfloat.invalidateClient(u);
      res.json(sanitizeProxyRule(rule));
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.delete('/api/proxies/rules/:id', (req: Request, res: Response) => {
    try {
      const { affected } = accounts.deleteProxyRule(req.params.id);
      for (const u of affected) csfloat.invalidateClient(u);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.post('/api/proxies/rules/reorder', (req: Request, res: Response) => {
    try {
      const order: string[] = Array.isArray(req.body?.order) ? req.body.order : [];
      const { affected } = accounts.reorderProxyRules(order);
      for (const u of affected) csfloat.invalidateClient(u);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  // Make the current rules live (operator activates after reviewing the preview, when the automatic
  // equivalence proof did not cut over). Lazy: accounts pick it up on their next login/refresh.
  app.post('/api/proxies/activate', (_req: Request, res: Response) => {
    // F5: the flag flip is the one mutation GUARANTEED to change egress (legacy→rules). Invalidate the
    // CSFloat client for exactly the accounts whose effective proxy changed, like every other mutation.
    const affected = accounts.activateProxyRules();
    for (const u of affected) csfloat.invalidateClient(u);
    res.json({ ok: true, authoritative: true, invalidated: affected.length });
  });

  // Everything the rule editor's scope/target pickers (and the resolution preview) need, in one call.
  app.get('/api/proxies/targets', (_req: Request, res: Response) => {
    res.json({
      environments: accounts.getEnvironments().map(e => ({ id: e.id, name: e.name })),
      folders:      accounts.getAllFolders().map(f => ({ id: f.id, name: f.name, environmentId: f.environmentId, parentId: f.parentId })),
      accounts:     accounts.getAll().map(a => ({ username: a.username, environmentId: a.environmentId, folderId: a.folderId ?? null })),
    });
  });

  // "Who gets what" — the effective resolution for every account under the current rules (credential-
  // redacted). Evaluated regardless of the authoritative flag so it can be reviewed before activation.
  app.get('/api/proxies/resolution', (_req: Request, res: Response) => {
    const rows = accounts.resolutionPreview().map(r => ({
      username: r.username, environmentId: r.environmentId, folderId: r.folderId,
      ruleId: r.ruleId, ruleName: r.ruleName, scope: r.scope, conflicts: r.conflicts, poolLost: r.poolLost,
      network: r.network ? { type: r.network.type, value: redactProxyCredentials(r.network.value) } : null,
    }));
    res.json({ rows, authoritative: accounts.isProxyRulesAuthoritative() });
  });

  // Coverage: accounts on local IP (no proxy rule), per-proxy account counts + tank health
  // (host:port only — never a credential), and any pool-lost accounts (refused-login corruption state).
  app.get('/api/proxies/coverage', (_req: Request, res: Response) => {
    const preview = accounts.resolutionPreview();
    const health = new Map(proxyHealth.snapshot().map(s => [s.key, s]));
    const localIp: string[] = [];
    const poolLost: string[] = [];
    const perProxy = new Map<string, { key: string; count: number; usernames: string[] }>();
    for (const r of preview) {
      if (r.poolLost) { poolLost.push(r.username); continue; }
      if (!r.network || r.network.type === 'localip') { localIp.push(r.username); continue; }
      const key = proxyKey(r.network.value);
      if (!key) { localIp.push(r.username); continue; }
      const e = perProxy.get(key) ?? { key, count: 0, usernames: [] };
      e.count++; e.usernames.push(r.username); perProxy.set(key, e);
    }
    const proxies = [...perProxy.values()].map(e => {
      const h = health.get(e.key);
      return { key: e.key, count: e.count, usernames: e.usernames, state: h ? h.state : 'closed', consecutiveResets: h ? h.consecutiveResets : 0, tracked: !!h };
    });
    res.json({ localIp, poolLost, proxies, authoritative: accounts.isProxyRulesAuthoritative() });
  });

  // Test a single proxy string end-to-end (reuses the env check-proxy path: ipify egress + ip-api geo).
  app.post('/api/proxies/check', asyncHandler(async (req: Request, res: Response) => {
    const raw = typeof req.body?.proxy === 'string' ? req.body.proxy.trim() : '';
    const network: NetworkConfig = raw ? { type: 'proxy', value: normalizeProxy(raw) } : { type: 'localip', value: '0.0.0.0' };
    return res.json(await checkEgress(network, 'rule-test')); // T4: shared probe (logged + redacted)
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
      // F3: post-cutover, a per-account proxy at create time must become an account-scope RULE, else
      // the resolver ignores the networkOverride/vault proxy and the new bot rides a broader rule or the
      // host IP. No-op pre-cutover (legacy fields still resolve); legacy fields are also written above.
      if (typeof proxy === 'string' && proxy.trim()) {
        accounts.ensureAccountProxyRules([{ username: username.trim(), proxy: proxy.trim() }]);
      }
      res.status(201).json(sanitizeAccount(accounts.get(username.trim()) ?? account));
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

  // ── POST /api/accounts/:username/attach-mafile  → upgrade LIMITED to full ─────
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
    // Best-effort: never fail the upgrade on a logout hiccup.
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

  // Current Steam Guard code for one account (OTP is offline — no login needed). The
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

  // Live pending mobile confirmations for one account (reuses AccountTrader.listConfirmations).
  // Steam's mobileconf 429 surfaces as a MESSAGE ("HTTP error 429") / err.code — never as `err.status` —
  // so the generic csErr mapper misses it and every rate-limit was reported as a 502 "gateway" failure.
  // A rate-limit is neither our fault nor permanent: say 429, say how long, and let the UI wait it out.
  const CONF_RETRY_AFTER_S = 60;
  const confErr = (res: Response, e: unknown, what: string): void => {
    if (classifyNetworkError(e).rateLimited) {
      // The MobileConfGate attaches the EXACT escalated remaining wait (it doubles per consecutive 429),
      // so the panel counts down the real window instead of a hardcoded 60s that re-probed on the boundary.
      const secs = Math.max(5, Math.round(Number((e as { retryAfterSeconds?: number }).retryAfterSeconds) || CONF_RETRY_AFTER_S));
      res.setHeader('Retry-After', String(secs));
      res.status(429).json({
        error: `Steam has temporarily limited how often this account's confirmations can be checked. It clears once the account is left alone — checking too often keeps it active.`,
        retryAfterSeconds: secs,
        rateLimited: true,
      });
      return;
    }
    res.status(502).json({ error: `${what}: ${(e as Error).message}` });
  };

  app.get('/api/accounts/:username/confirmations', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    try {
      const trader = await trades.ensureWebSession(account.username);
      res.json({ confirmations: await trader.listConfirmations() });
    } catch (e) {
      confErr(res, e, 'could not load confirmations');
    }
  }));

  // Approve / deny confirmations (single, multi, or all); the UI re-fetches from truth after.
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
      confErr(res, e, 'confirmation action failed');
    }
  }));

  // Open one account in an isolated, proxied, ephemeral browser (its own session only).
  // ════════════════════════════════════════════════════════════════════════
  //  W2_20 — Accounts module: owned games, profile, free-on-demand licenses.
  //  not money ops (excluded from MONEY_OP_ROUTE). games/free-license need a
  //  LOGGED-IN CM session (login slot, cap 25 — loginAccount is reuse-first via
  //  its in-flight dedup + existing-session ceiling exemption). profile uses the
  //  web (community) session. ⚠ Live Steam behavior = joint acceptance test.
  // ════════════════════════════════════════════════════════════════════════
  const gamesCache = new Map<string, { username: string; count: number; games: OwnedGame[]; scannedAt: string }>();
  const ensureCmSession = (account: AccountConfig) => sessions.loginAccount(account);

  // Fallback owned-games source: licenses → package appids → product-info names (games only).
  const ownedGamesViaLicenses = async (client: SteamUserApps): Promise<OwnedGame[]> => {
    const packageIds = (client.licenses ?? []).map((l) => l.package_id).filter(Number.isInteger);
    if (packageIds.length === 0) return [];
    const pkgInfo = await client.getProductInfo([], packageIds, true);
    const appIds = new Set<number>();
    for (const pid of Object.keys(pkgInfo.packages ?? {})) {
      for (const a of pkgInfo.packages[pid]?.packageinfo?.appids ?? []) appIds.add(Number(a));
    }
    if (appIds.size === 0) return [];
    const appInfo = await client.getProductInfo([...appIds], [], true);
    const games: OwnedGame[] = [];
    for (const id of Object.keys(appInfo.apps ?? {})) {
      const common = appInfo.apps[id]?.appinfo?.common;
      if (common && (common.type === undefined || String(common.type).toLowerCase() === 'game')) {
        games.push({ appId: Number(id), name: common.name ?? String(id), playtimeMinutes: 0 });
      }
    }
    return games;
  };

  // Owned games — SHARED helper (the route and the batch scan-games job call this). Primary
  // getUserOwnedApps (names + playtime), licenses fallback. Cached per account.
  const scanGamesOne = async (username: string, refresh: boolean) => {
    const account = accounts.get(username);
    if (!account) throw Object.assign(new Error(`Account "${username}" not found`), { status: 404 });
    if (!refresh && gamesCache.has(account.username)) return gamesCache.get(account.username)!;
    const session = await ensureCmSession(account);
    sessions.markUsed(account.username);
    const client = session.client as unknown as SteamUserApps;
    const sid = client.steamID;
    if (!sid) throw new Error('session is not fully logged in (no steamID) — try again shortly');
    let games: OwnedGame[] = [];
    try {
      const owned = await client.getUserOwnedApps(sid, { includeAppInfo: true, includePlayedFreeGames: true });
      games = (owned.apps ?? []).map((a) => ({ appId: a.appid, name: a.name ?? String(a.appid), playtimeMinutes: a.playtime_forever ?? 0, iconUrl: a.img_icon_url }));
    } catch (e) {
      games = await ownedGamesViaLicenses(client);      // no-band-aid: only if the primary threw
      if (games.length === 0) throw new Error(`owned-games scan failed: ${(e as Error).message}`);
    }
    games.sort((a, b) => a.name.localeCompare(b.name));
    const payload = { username: account.username, count: games.length, games, scannedAt: new Date().toISOString() };
    gamesCache.set(account.username, payload);
    return payload;
  };
  app.get('/api/steam/:username/games', asyncHandler(async (req, res) => {
    try { res.json(await scanGamesOne(req.params.username, req.query.refresh === '1' || req.query.refresh === 'true')); }
    catch (e) { res.status((e as { status?: number }).status ?? 502).json({ error: (e as Error).message }); }
  }));

  // Add free-on-demand licenses (CM) — SHARED helper (route + batch add-free-game job).
  const freeLicenseOne = async (username: string, appIds: number[]) => {
    const account = accounts.get(username);
    if (!account) throw Object.assign(new Error(`Account "${username}" not found`), { status: 404 });
    if (!appIds.length) throw Object.assign(new Error('appIds[] required (integers)'), { status: 400 });
    const session = await ensureCmSession(account);
    sessions.markUsed(account.username);
    const client = session.client as unknown as SteamUserApps;
    const { grantedPackageIds, grantedAppIds } = await client.requestFreeLicense(appIds);
    gamesCache.delete(account.username);
    return { requested: appIds, grantedAppIds, grantedPackageIds };
  };
  app.post('/api/steam/:username/free-license', asyncHandler(async (req, res) => {
    const appIds: number[] = Array.isArray(req.body?.appIds) ? req.body.appIds.map(Number).filter(Number.isInteger) : [];
    try { res.json(await freeLicenseOne(req.params.username, appIds)); }
    catch (e) { res.status((e as { status?: number }).status ?? 502).json({ error: `free-license request failed: ${(e as Error).message}`, requested: appIds }); }
  }));

  // Read profile (best-effort). Steam exposes no public "get profile" API; a full current-profile
  // read means scraping the authenticated edit page (fragile, live-only — deferred). For now pre-fill
  // the editor with the known persona; the POST below does the authoritative write.
  app.get('/api/steam/:username/profile', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    res.json({ name: account.displayName ?? account.username, realName: null, summary: null, avatarUrl: null, privacy: null, partial: true });
  }));

  // Edit profile (web/community session) — SHARED helper (route + batch edit-profile job).
  const editProfileOne = async (username: string, b: ProfileEditBody) => {
    const account = accounts.get(username);
    if (!account) throw Object.assign(new Error(`Account "${username}" not found`), { status: 404 });
    const trader = await trades.ensureWebSession(account.username);
    const community = trader.community as unknown as CommunityProfileApi;
    const updated: Record<string, string> = {};
    const edit: Record<string, unknown> = {};
    if (typeof b.name === 'string') edit.name = b.name.slice(0, 64);
    if (typeof b.realName === 'string') edit.realName = b.realName.slice(0, 64);
    if (typeof b.summary === 'string') edit.summary = b.summary.slice(0, 1000);
    if (Object.keys(edit).length) { await new Promise<void>((resolve, reject) => community.editProfile(edit, (err) => (err ? reject(err) : resolve()))); updated.info = 'ok'; }
    if (b.privacy && typeof b.privacy === 'object') { await new Promise<void>((resolve, reject) => community.profileSettings(mapPrivacy(b.privacy!), (err) => (err ? reject(err) : resolve()))); updated.privacy = 'ok'; }
    if (typeof b.avatar === 'string' && b.avatar) { updated.avatar = await new Promise<string>((resolve, reject) => community.uploadAvatar(b.avatar!, undefined, (err, url) => (err ? reject(err) : resolve(url)))); }
    return { username: account.username, updated };
  };
  app.post('/api/steam/:username/profile', asyncHandler(async (req, res) => {
    try { res.json(await editProfileOne(req.params.username, (req.body ?? {}) as ProfileEditBody)); }
    catch (e) { res.status((e as { status?: number }).status ?? 502).json({ error: `profile update failed: ${(e as Error).message}` }); }
  }));

  // ── POST /api/steam/:username/signout-all-devices ──────────────────────────
  // Steam's own "sign out of all devices": revokes every refresh token on the account, ending every
  // session everywhere — the Steam client, the mobile app, browsers, and SSIM.
  //
  // REFUSED for token-only accounts (INV-A2). A LIMITED account imported by QR/token has its refresh
  // token as its SOLE credential; deauthorizing revokes it and there would be no way back into the
  // account from SSIM at all. That is unrecoverable, so it is fail-closed here rather than warned
  // about in the UI. A full account (maFile + password) can simply log in again with TOTP.
  //
  // AFTERMATH is part of the operation, not a follow-up the operator has to remember: on a confirmed
  // success SSIM drops the account's live session and its now-revoked stored token, so the next use
  // does a clean credential login instead of failing on a dead token. On an AMBIGUOUS outcome the same
  // cleanup runs — if the deauthorize did land, the token is dead either way, and re-deriving it via
  // credentials is safe; keeping a possibly-revoked token is what would break silently later.
  app.post('/api/steam/:username/signout-all-devices', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });

    // Resolve the credential fallback the way the LOGIN path does (vault then disk), and note that
    // loadMaFile THROWS for a missing/unreadable maFile rather than returning null — which is the
    // token-only case this guard exists for. Catching it is the check, not an error path: an
    // unreadable maFile is treated as absent, i.e. no fallback, i.e. refuse. Fail-closed either way.
    let maFile: unknown;
    try { maFile = loadMaFile(account); }
    catch { maFile = null; }
    const hasPassword = !!resolvePassword(account);
    if (!maFile || !hasPassword) {
      return res.status(409).json({
        error: 'No maFile or password saved for this account, so its refresh token is the only way SSIM can log in. '
             + 'Signing out would kill it and lock SSIM out for good. Add them first.',
      });
    }

    const result = await store.deauthorizeAllDevices(account.username);
    if (result.status === 'failed') {
      // `error` is what the frontend's api() wrapper reads for its toast; without it the operator
      // just gets "HTTP 502" and no reason.
      return res.status(502).json({ status: 'failed', detail: result.detail, error: `Steam refused the sign out (${result.detail})` });
    }

    // done OR ambiguous → treat our own credentials as revoked (see above).
    await sessions.logoutAccount(account.username).catch((e) => {
      logger.warn(`[${account.username}] post-deauthorize logout failed (${(e as Error).message}) – token still cleared`);
    });
    sessions.clearStoredRefreshToken(account.username);
    logger.info(`[${account.username}] signed out of all devices (${result.status}) – local session dropped, stored refresh token cleared`);
    res.json({ status: result.status, detail: result.detail });
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  W3_31 — Add funds (Steam wallet codes, money-safe) + promo free-licenses.
  //  Wallet-code redeem is a money-in commit with a BEARER secret: a crash mid-redeem
  //  must never double-submit, and the raw code must never be logged/returned. The
  //  WalletRedeemJournal (own file, keyed by sha256(code)) closes the double-submit gap;
  //  the code is hashed/masked everywhere and scrubbed by redactSecrets. ⚠ Live test needed.
  // ════════════════════════════════════════════════════════════════════════
  const walletJournal = new WalletRedeemJournal();

  // SHARED helper (route + batch redeem-codes job) — the full money-safety journal spine lives here so
  // both callers get identical double-submit protection. Classified result; never throws.
  const redeemOne = async (username: string, code: string, force: boolean): Promise<{ httpStatus: number; status: string; codeMasked: string; detail: string }> => {
    const key = codeHash(code);
    const masked = codeMasked(code);
    const lingering = walletJournal.consultRefusal(key, { force });   // S15: crash-interrupted → refuse until verified
    if (lingering) return { httpStatus: 409, status: 'needs-verify', codeMasked: masked, detail: 'A prior redeem of this code was interrupted — verify the balance on Steam, then retry with force.' };
    walletJournal.begin(key, 'wallet-redeem');
    try {
      const result = await store.redeemWalletCode(username, code);      // never logs the raw code
      if (result.ambiguous) { walletJournal.record(key, 'wallet-redeem', 'placed', 'ambiguous transport'); return { httpStatus: 502, status: 'ambiguous', codeMasked: masked, detail: 'Outcome unknown — verify the balance on Steam. No auto-retry.' }; }
      walletJournal.resolve(key);
      return { httpStatus: 200, status: result.success ? 'redeemed' : 'rejected', codeMasked: masked, detail: result.detail };
    } catch (e) {
      if ((e as Error).name === 'StoreAmbiguousError') { walletJournal.record(key, 'wallet-redeem', 'placed', 'commit ambiguous'); return { httpStatus: 502, status: 'ambiguous', codeMasked: masked, detail: 'Outcome unknown — verify the balance on Steam. No auto-retry.' }; }
      walletJournal.resolve(key);
      return { httpStatus: 502, status: 'rejected', codeMasked: masked, detail: (e as Error).message };
    }
  };
  app.post('/api/steam/:username/redeem', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!normalizeCode(code)) return res.status(400).json({ error: 'code required' });
    const r = await redeemOne(account.username, code, req.body?.force === true);
    res.status(r.httpStatus).json({ status: r.status, codeMasked: r.codeMasked, newBalance: null, detail: r.detail });
  }));

  // ── W4_40 — paysafecard top-up (Track B): SEQUENTIAL, human-in-the-loop, browser-driven.
  //    SSIM opens each account's addfunds checkout pre-authenticated + reconciles by wallet READ-BACK.
  //    The PIN is entered ON THE PAGE (never in SSIM); SSIM only sequences accounts + verifies credits.
  //    ON by default (owner 2026-07-09) — the visible "TEST" badge IS the flag; only =0 hard-disables. ──
  const paysafeErr = (res: Response, e: unknown) => res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
  /** paysafecard is EUR-only, so `amountMinor` IS euro-cents end-to-end — the tier value Steam printed, the
   *  amount we post to the cart, and the credit threshold. Bounded here (the boundary) as well as in
   *  PaysafeService, so a hand-rolled request cannot open a €50 000 checkout. */
  const paysafeAmountOf = (body: Record<string, unknown> | undefined): number => {
    const amountMinor = Number(body?.amountMinor);
    if (!Number.isSafeInteger(amountMinor)) throw Object.assign(new Error('pick an amount'), { status: 400 });
    if (amountMinor < PAYSAFE_MIN_MINOR) throw Object.assign(new Error(`the minimum top-up is ${(PAYSAFE_MIN_MINOR / 100).toFixed(2)} €`), { status: 400 });
    if (amountMinor > PAYSAFE_MAX_MINOR) throw Object.assign(new Error(`the maximum top-up is ${(PAYSAFE_MAX_MINOR / 100).toFixed(2)} €`), { status: 400 });
    return amountMinor;
  };
  // The amount tiers Steam offers this account (for the UI dropdown) — real values, no free-text guessing.
  // Also reports `supported`: a non-EUR wallet cannot be topped up, and the UI must say so up front.
  app.get('/api/steam/:username/paysafe/tiers', asyncHandler(async (req, res) => {
    if (!accounts.get(req.params.username)) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    try { res.json(await store.getAddfundsTiers(req.params.username)); } catch (e) { paysafeErr(res, e); }
  }));
  // Single account (wallet card): open its checkout, then verify.
  app.post('/api/steam/:username/paysafe/open', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    try { res.json(await paysafe.openOne(account.username, paysafeAmountOf(req.body))); } catch (e) { paysafeErr(res, e); }
  }));
  app.post('/api/steam/paysafe/verify', asyncHandler(async (_req, res) => {
    try { res.json(await paysafe.verifyOne()); } catch (e) { paysafeErr(res, e); }
  }));
  // Batch (sequential): start over a scope, advance (verify current → open next), stop, poll.
  app.post('/api/steam/paysafe/batch/start', asyncHandler(async (req, res) => {
    const raw: unknown[] = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
    // A money op NEVER silently drops accounts the operator selected — refuse the whole run instead.
    const unknown = raw.filter((u) => typeof u !== 'string' || !accounts.get(u));
    if (unknown.length) return res.status(400).json({ error: `unknown account(s): ${unknown.slice(0, 5).map(String).join(', ')}` });
    try { res.json(await paysafe.startBatch(raw as string[], paysafeAmountOf(req.body))); } catch (e) { paysafeErr(res, e); }
  }));
  app.post('/api/steam/paysafe/batch/advance', asyncHandler(async (req, res) => {
    try { res.json(await paysafe.advance({ skip: req.body?.skip === true })); } catch (e) { paysafeErr(res, e); }
  }));
  app.post('/api/steam/paysafe/batch/stop', asyncHandler(async (_req, res) => {
    try { res.json(await paysafe.stop() ?? { running: false }); } catch (e) { paysafeErr(res, e); }
  }));
  app.get('/api/steam/paysafe/status', (_req: Request, res: Response) => res.json(paysafe.status() ?? { running: false }));
  // Frontend capability probe: the paysafecard actions show ONLY when enabled.
  app.get('/api/steam/paysafe/config', (_req: Request, res: Response) => res.json({ enabled: process.env.SSIM_PAYSAFE_EXPERIMENTAL !== '0' }));

  app.post('/api/steam/:username/promo-license', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    const subId = Number(req.body?.subId);
    if (!Number.isInteger(subId) || subId <= 0) return res.status(400).json({ error: 'subId (integer) required' });
    try {
      const r = await store.addFreeLicense(account.username, subId);
      res.json({ subId, status: r.status, detail: r.detail });
    } catch (e) {
      res.status(502).json({ error: `promo-license failed: ${(e as Error).message}`, subId });
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  W4_41 — Buy CS2 Prime with STEAM WALLET BALANCE ONLY.
  //
  //  No parameters, by owner decision (2026-08-05): the package id is the same worldwide, and the
  //  price is whatever Steam quotes for that account's currency — so there is nothing to configure
  //  and no preview mode. Pick a scope, run, and each account either gets Prime or is told why not.
  //
  //  The safety comes from the shape rather than from operator input:
  //   • Serial. It rides BatchJobService.runInternal (concurrency 1) — one account, one charge, at
  //     a time. No new fan-out, no new login pressure, and cancel takes effect between accounts.
  //   • The free CS2 licence is added first (Steam will not sell the Prime UPGRADE without it).
  //   • Journalled. begin() lands immediately before finalizetransaction; a lingering entry from a
  //     crash HARD-refuses that account (findUnresolved, not consultRefusal: the 8-second
  //     "deliberate retry" pause that makes sense for a human clicking Buy means nothing to an
  //     unattended fleet run). In practice it self-clears — a re-run finds the account already
  //     has Prime and returns 'owned' long before it reaches the commit.
  //   • Quarantine-aware, on both entry points (the route via MONEY_OP_ROUTE, and the batch job —
  //     which does not pass through that middleware — via this helper).
  //  Every actual money-safety decision lives in performWalletPurchase (unit-tested end to end).
  // ════════════════════════════════════════════════════════════════════════
  const purchaseJournal = new GamePurchaseJournal();

  // SHARED helper (route + batch job) so both entry points get identical gates and journalling.
  const buyPrimeOne = async (username: string, o: { force?: boolean } = {}): Promise<WalletPurchaseResult> => {
    const account = accounts.get(username);
    if (!account) throw Object.assign(new Error(`Account "${username}" not found`), { status: 404 });
    if (ProcessHealth.moneyOpsBlocked())
      throw Object.assign(new Error(`Money operations are paused: ${ProcessHealth.blockReason()}. Restart SSIM and verify state before buying.`), { status: 503 });

    let opKey = '';
    const result = await store.withStoreSession(account.username, (ctx, session) =>
      performWalletPurchase(
        ctx,
        {
          readWallet: () => sessions.awaitWallet(account.username),
          // Ownership comes from the LOGGED-IN CM connection, never a cookie-authenticated page: a
          // stale cookie reads as "owns nothing", which is precisely the mistake that buys a 2nd copy.
          readOwnedPackageIds: () => ownedPackageIdsFrom((session.client as unknown as { licenses?: unknown }).licenses),
          // Free CS2 into the LIBRARY (never the cart) before the cart exists. Reuses this store
          // session's CM client — no second login — and is idempotent. The grant result is handed back
          // so the choreography can tell "granted just now" from "nothing happened" while it waits for
          // Steam's store to catch up.
          grantFreeBaseGame: async () => {
            const r = await (session.client as unknown as SteamUserApps).requestFreeLicense([CS2_APP_ID]);
            gamesCache.delete(account.username);
            return { grantedPackageIds: r?.grantedPackageIds ?? [], grantedAppIds: r?.grantedAppIds ?? [] };
          },
        },
        ({ subId, totalMinor, currencyIso }) => {
          const key = purchaseOpKey(account.username, subId);
          const lingering = o.force === true ? undefined : purchaseJournal.findUnresolved(key);
          if (lingering) {
            const mins = Math.max(1, Math.round((Date.now() - lingering.at) / 60_000));
            return `an earlier purchase attempt for this account died mid-commit ${mins} minute(s) ago and its outcome was never confirmed. SSIM will not fire a second charge until someone has checked this account's Steam purchase history.`;
          }
          opKey = key;
          purchaseJournal.begin(key, 'game-purchase');
          logger.info(`[prime] ${account.username}: committing ${totalMinor} ${currencyIso} minor units for package ${subId}`);
          return null;
        },
      ));

    // Resolve ONLY when this call actually opened an entry (opKey is set inside beginCommit), and only
    // on a DEFINITE outcome. A skip or a pre-commit refusal must never clear a lingering entry that
    // belongs to an earlier crash. And note what is DELIBERATELY missing: there is no try/finally here,
    // so an exception thrown after the commit leaves the entry behind — an op whose outcome nobody
    // knows must keep refusing its own re-fire, which is the entire point of the journal.
    if (opKey) {
      if (result.status === 'unconfirmed') purchaseJournal.record(opKey, 'game-purchase', 'placed', 'outcome unconfirmed');
      else purchaseJournal.resolve(opKey);
    }
    if (result.status === 'unconfirmed') logger.error(`[prime] ${account.username}: UNCONFIRMED purchase — ${result.detail}`);
    else logger.info(`[prime] ${account.username}: ${result.status} — ${result.detail}`);
    return result;
  };

  app.post('/api/steam/:username/buy-prime', asyncHandler(async (req, res) => {
    try {
      const result = await buyPrimeOne(req.params.username, { force: req.body?.force === true });
      notePrimeFromPurchase(result);
      res.json(result);
    } catch (e) {
      res.status((e as { status?: number }).status ?? 502).json({ error: `Prime purchase failed: ${(e as Error).message}` });
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  1.5.1 — CS2 Prime ownership, READ ONLY.
  //
  //  Owner: "would be great to see which accs already has prime in batch jobs". The purchase has
  //  always refused to buy a second copy — performWalletPurchase reads the licences and returns
  //  'owned' — but that answer only existed AFTER firing a money job at 500 accounts. This is the
  //  same question asked without the purchase attached: log in, read the licences, report.
  //
  //  It spends nothing and changes nothing, but it is NOT free: each account costs one CM login, so
  //  it runs serially through the batch engine exactly like the purchase does, and the answers are
  //  cached so the buy-prime panel can show fleet coverage without re-checking anything.
  //
  //  Three states, never two: 'unreadable' is not 'missing'. Steam answers an account whose licences
  //  we could not read exactly the way it answers one that owns nothing — reporting that as "needs
  //  Prime" is how an operator ends up buying licences the fleet already holds.
  // ════════════════════════════════════════════════════════════════════════
  interface PrimeRow { username: string; status: PrimeOwnership; detail: string; checkedAt: string }
  const primeCache = new Map<string, PrimeRow>();

  /** A purchase outcome is a FRESH ownership reading — record it so the coverage view reflects a run
   *  the moment it finishes, instead of showing pre-purchase state until someone re-checks. Only the
   *  two outcomes that PROVE ownership update the cache; 'refused'/'skipped'/'unconfirmed' say nothing
   *  about whether the account has Prime, so they leave the previous (or absent) answer alone. */
  const notePrimeFromPurchase = (r: WalletPurchaseResult): void => {
    if (r.status !== 'owned' && r.status !== 'purchased') return;
    primeCache.set(r.username.toLowerCase(), {
      username: r.username, status: 'owned', checkedAt: new Date().toISOString(),
      detail: r.status === 'purchased' ? 'Prime bought by SSIM just now' : 'already has CS2 Prime',
    });
  };

  /** SHARED helper (route + batch job). Reuses the store session so BOTH ownership sources the
   *  purchase gate consults are read here too — the CM licence list and the store's userdata. */
  const primeStatusOne = async (username: string, o: { refresh?: boolean } = {}): Promise<PrimeRow> => {
    const account = accounts.get(username);
    if (!account) throw Object.assign(new Error(`Account "${username}" not found`), { status: 404 });
    const key = account.username.toLowerCase();
    if (!o.refresh) {
      const hit = primeCache.get(key);
      // A cached 'unreadable' is not an answer, it is a failed read — never serve it as one.
      if (hit && hit.status !== 'unreadable') return hit;
    }
    const row = await store.withStoreSession(account.username, async (ctx, session) => {
      const licensed = ownedPackageIdsFrom((session.client as unknown as { licenses?: unknown }).licenses);
      const storeOwned = licensed == null ? null : await readStoreOwnedPackages(ctx);
      const { state, detail } = primeOwnership(licensed, storeOwned);
      return { username: account.username, status: state, detail, checkedAt: new Date().toISOString() };
    });
    primeCache.set(key, row);
    logger.info(`[prime-check] ${account.username}: ${row.status}`);
    return row;
  };

  // Cached snapshot for the whole fleet — NO network, NO login. Drives the coverage strip in the
  // Batch panel, which must be free to render on every repaint.
  app.get('/api/steam/prime-status', (_req: Request, res: Response) => {
    res.json({ rows: [...primeCache.values()] });
  });

  app.get('/api/steam/:username/prime-status', asyncHandler(async (req, res) => {
    try { res.json(await primeStatusOne(req.params.username, { refresh: req.query.refresh === '1' || req.query.refresh === 'true' })); }
    catch (e) { res.status((e as { status?: number }).status ?? 502).json({ error: `Prime check failed: ${(e as Error).message}` }); }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  W3_32 — Batch Jobs engine: scope → job → run w/ progress + history. The engine
  //  is a router — each adapter calls an EXISTING fan-out service, inheriting caps +
  //  money-safety. Refresh + bans ship enabled; money/per-account jobs greyed until wired.
  // ════════════════════════════════════════════════════════════════════════
  // Batch registry — pruned to LEAN 2026-07-09 (owner). Batch = redeem-codes (bulk wallet codes),
  // buy-prime (W4_41, wallet-funded CS2 Prime), check-prime (1.5.1, its read-only twin) + the
  // dedicated Distribute button (in the scope panel, not a registry tile). REMOVED: refresh-inventory,
  // check-bans, scan-games, add-free-game, edit-profile, promo-license, mass-buy (covered by Inventories →
  // Mass Buy), and the disabled distribute/mass-sell/offers-batch placeholder tiles. Shared backend helpers
  // are intentionally KEPT — their single-account routes and other UIs still call them.
  const batchRegistry = new JobRegistry()
    .add({ jobType: 'redeem-codes', label: 'Redeem Steam wallet codes', group: 'money', moneySafe: true, enabled: true, experimental: true, paramSchema: [{ key: 'codes', label: 'Codes (one per line)', type: 'multiline', required: true, help: 'Matched 1:1 to the selected accounts, in order' }],
      adapter: async ({ params, runInternal }) => { const codes = String(params.codes || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); runInternal(async (u, i) => { const code = codes[i]; if (!code) throw new Error('no code for this account (need one code per line, in order)'); const r = await redeemOne(u, code, false); if (r.status !== 'redeemed') throw new Error(`${r.status}: ${r.detail}`); }); return { source: { kind: 'internal' } }; } })
    // W4_41 — Buy CS2 Prime from Steam wallet balance. NO parameters (owner 2026-08-05): the package
    // id is the same worldwide and the price is whatever Steam quotes in the account's own currency,
    // so the scope IS the whole input. Serial by construction (runInternal).
    .add({ jobType: 'buy-prime', label: 'Buy CS2 Prime (Steam balance)', group: 'money', moneySafe: true, enabled: true, experimental: true,
      paramSchema: [],
      adapter: async ({ runInternal }) => {
        runInternal(async (u) => {
          const r = await buyPrimeOne(u);
          notePrimeFromPurchase(r);   // a purchase outcome IS a fresh ownership reading — keep the coverage view honest
          return r;
        });
        return { source: { kind: 'internal' } };
      } })
    // 1.5.1 — the read-only twin of buy-prime (owner: "see which accs already has prime"). Same scope,
    // same serial shape, no cart and no charge: log in, read the licences, report per account. Run it
    // before a purchase and the buy-prime panel shows exactly who still needs Prime.
    // moneySafe:false is the literal truth here — the job has no money path at all, so it must not
    // wear the '$' badge or trigger the spend-toned confirm. It stays `experimental` because a
    // fleet-wide check is still a fleet-wide LOGIN, and that deserves a deliberate click.
    .add({ jobType: 'check-prime', label: 'Check CS2 Prime ownership', group: 'read', moneySafe: false, enabled: true, experimental: true,
      paramSchema: [],
      adapter: async ({ runInternal }) => {
        runInternal(async (u) => primeStatusOne(u, { refresh: true }));   // an explicit check always re-reads
        return { source: { kind: 'internal' } };
      } });
  // NOTE: paysafecard is not a BatchJobService fan-out job — it is human-in-the-loop (a browser handoff
  // per account). It ships as a CLIENT-ROUTED sequential job (like Distribute) via /api/steam/paysafe/*.
  const batch = new BatchJobService(accounts, batchRegistry);
  app.get('/api/batch/registry', (_req: Request, res: Response) => res.json(batch.registryView()));
  // Scope tree for the Batch micro-selection picker: environments + folders + accounts, so the
  // operator can select any granularity (whole env / a folder / single or multi accounts). Batch-owned
  // (mirrors /api/proxies/targets) so the two modules stay decoupled. No secrets — ids/names only.
  app.get('/api/batch/targets', (_req: Request, res: Response) => {
    res.json({
      environments: accounts.getEnvironments().map((e) => ({ id: e.id, name: e.name })),
      folders:      accounts.getAllFolders().map((f) => ({ id: f.id, name: f.name, environmentId: f.environmentId, parentId: f.parentId })),
      accounts:     accounts.getAll().map((a) => ({ username: a.username, environmentId: a.environmentId, folderId: a.folderId ?? null })),
    });
  });
  app.get('/api/batch/status', (_req: Request, res: Response) => res.json(batch.status()));
  app.get('/api/batch/history', (_req: Request, res: Response) => res.json(batch.history()));
  app.post('/api/batch/cancel', (_req: Request, res: Response) => res.json(batch.cancel()));
  app.post('/api/batch/run', asyncHandler(async (req, res) => {
    try {
      res.json(await batch.run({ jobType: req.body?.jobType, scope: req.body?.scope, params: req.body?.params, game: req.body?.game }));
    } catch (e) {
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  }));

  // ════════════════════════════════════════════════════════════════════════
  //  W3_33 — Distribute Items: pack a source pool (cache-only) → serial trade-send a
  //  NET amount to each target. preview() is pure (no network); start() runs serially
  //  through trades.sendTrade (self-journaled). ⚠ Live trade behavior = joint test.
  // ════════════════════════════════════════════════════════════════════════
  const distReq = (body: Record<string, unknown>) => {
    const pick = (v: unknown) => Array.isArray(v) ? v.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u)) : [];
    const sources = pick(body?.sources), targets = pick(body?.targets);
    const amountNetCents = Number(body?.amountNetCents);
    if (!sources.length) throw Object.assign(new Error('no known source accounts'), { status: 400 });
    if (!targets.length) throw Object.assign(new Error('no known target accounts'), { status: 400 });
    if (!Number.isFinite(amountNetCents) || amountNetCents <= 0) throw Object.assign(new Error('amountNetCents must be > 0'), { status: 400 });
    // Item name filters (1.5.1). Capped so a pasted list can't turn one preview into a quadratic scan
    // of the whole fleet cache; each entry is capped too (a marketHashName is never this long).
    const nameList = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.filter((s: unknown): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 200)).filter(Boolean).slice(0, 500);
      return out.length ? out : undefined;
    };
    // Default MULTI (owner 2026-07-09): targets fill from several sources; 'underfill' is the opt-out.
    return { sources, targets, amountNetCents, game: (body?.game === 'tf2' ? 'tf2' : 'cs2') as 'cs2' | 'tf2', minItemNetCents: Number(body?.minItemNetCents) || 0, policy: (body?.policy === 'underfill' ? 'underfill' : 'multi') as 'multi' | 'underfill', message: typeof body?.message === 'string' ? body.message : undefined, includeNames: nameList(body?.includeNames), excludeNames: nameList(body?.excludeNames) };
  };
  const distErr = (res: Response, e: unknown) => res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
  app.post('/api/inventory/distribute/preview', (req: Request, res: Response) => { try { res.json(distribute.preview(distReq(req.body ?? {}))); } catch (e) { distErr(res, e); } });
  app.post('/api/inventory/distribute', (req: Request, res: Response) => { try { res.json(distribute.start(distReq(req.body ?? {}))); } catch (e) { distErr(res, e); } });
  app.get('/api/inventory/distribute/status', (_req: Request, res: Response) => res.json(distribute.status()));
  app.post('/api/inventory/distribute/cancel', (_req: Request, res: Response) => res.json(distribute.cancel()));

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
    // Safety: a configured-but-unresolvable proxy must not degrade to the host IP.
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
    // CSFloat caps a page at 50 (documented); a larger ask is rejected upstream, so clamp here
    // rather than let a stale/hand-built client turn it into an opaque CSFloat error.
    const limit = Math.min(numQ(req.query.limit) ?? 50, 50);
    try { res.json(await csfloat.myListings(req.params.username, { page: numQ(req.query.page), limit })); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  app.post('/api/csfloat/:username/listings', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    const { asset_id, price, type, description } = req.body ?? {};
    if (typeof asset_id !== 'string' || !asset_id) return res.status(400).json({ error: 'asset_id is required' });
    // Price floor: a create-listing price must be ≥ 1 cent and within a sane
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
    try {
      const raw = await csfloat.trades(req.params.username, { page: numQ(req.query.page), limit: numQ(req.query.limit), state: typeof req.query.state === 'string' ? req.query.state : undefined });
      // The dashboard has to distinguish "not delivered yet" from "SSIM already sent this" — only the
      // worker's durable dedup store knows, and without it the UI would offer a Send button that can
      // only ever refuse. Merged into the same response so the tab needs one round-trip.
      const rows = Array.isArray(raw) ? raw : (Array.isArray((raw as Record<string, unknown>).trades) ? (raw as { trades: unknown[] }).trades : []);
      const ids = rows.map((t) => String((t as Record<string, unknown>)?.id ?? '')).filter(Boolean);
      const ssim = { delivered: csfloatWorker.deliveredAmong(ids) };
      res.json(Array.isArray(raw) ? { trades: raw, ssim } : { ...(raw as Record<string, unknown>), ssim });
    } catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  // ── manual delivery of CSFloat sales (real Steam offers — a money op) ──
  // The auto-accept toggle used to be the only trigger, so a sale that landed before it was flipped
  // sat undelivered until the next 45s poll and could not be sent by hand at all.
  app.post('/api/csfloat/:username/deliver', (req: Request, res: Response) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    const tradeIds = Array.isArray(req.body?.tradeIds) ? req.body.tradeIds.map((v: unknown) => String(v ?? '')) : [];
    try { res.json(csfloatWorker.startDeliver(req.params.username, tradeIds)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  app.get('/api/csfloat/deliver-status', (_req: Request, res: Response) => res.json(csfloatWorker.deliverStatus()));
  app.post('/api/csfloat/deliver-cancel', (_req: Request, res: Response) => res.json(csfloatWorker.cancelDeliver()));
  app.get('/api/csfloat/:username/inventory', asyncHandler(async (req, res) => {
    if (!csAccount(req, res) || !requireExperimental(res)) return;
    try { res.json(await csfloat.inventory(req.params.username)); }
    catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));
  // ── bulk operations + auto-pricing (many items per click) ──
  // POST /api/csfloat/:username/price-list { names?: string[] } — CSFloat's lowest buy-now ask
  // per name, for undercut pricing. One upstream request covers the whole catalog (cached, shared);
  // `names` narrows the RESPONSE so the browser isn't handed tens of thousands of rows it won't use.
  app.post('/api/csfloat/:username/price-list', asyncHandler(async (req, res) => {
    if (!csAccount(req, res)) return;
    try {
      const { prices, fetchedAt, stale } = await csfloat.priceCatalog(req.params.username);
      const names = Array.isArray(req.body?.names) ? req.body.names.filter((n: unknown) => typeof n === 'string') as string[] : null;
      const out: Record<string, number> = {};
      if (names) { for (const n of names) { const c = prices.get(n); if (c != null) out[n] = c; } }
      else { for (const [n, c] of prices) out[n] = c; }
      res.json({ prices: out, fetchedAt, stale, catalogSize: prices.size });
    } catch (err) { res.status(csErr(err)).json({ error: (err as Error).message }); }
  }));

  app.post('/api/csfloat/:username/bulk-list', (req: Request, res: Response) => {
    if (!csAccount(req, res)) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    try { res.json(csfloatBulk.startList(req.params.username, items)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  app.post('/api/csfloat/:username/bulk-delist', (req: Request, res: Response) => {
    if (!csAccount(req, res)) return;
    const ids = Array.isArray(req.body?.listingIds) ? req.body.listingIds : [];
    const names = (req.body?.names && typeof req.body.names === 'object') ? req.body.names as Record<string, string> : {};
    try { res.json(csfloatBulk.startDelist(req.params.username, ids, names)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  app.post('/api/csfloat/:username/bulk-reprice', (req: Request, res: Response) => {
    if (!csAccount(req, res)) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    try { res.json(csfloatBulk.startReprice(req.params.username, items)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  app.get('/api/csfloat/bulk-status', (_req: Request, res: Response) => res.json(csfloatBulk.status()));
  app.post('/api/csfloat/bulk-cancel', (_req: Request, res: Response) => res.json(csfloatBulk.cancel()));

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
    if (!csfloat.setAutoAccept(req.params.username, enabled)) {
      return res.status(500).json({ error: 'Setting changed in memory but could not be saved to disk; it will not survive a restart. Check disk space / file permissions on data/app_settings.json.' });
    }
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

    // F8: post-cutover, per-account proxy is managed as an account-scope rule. Reject a proxy edit
    // before touching any state or dropping the session (a forced re-login on a non-pinned pool rule
    // would otherwise ROTATE the exit IP — a false "it worked"). Non-proxy edits still work when proxy
    // is absent. Pre-cutover: unchanged. (Constraint 4: the legacy fields on disk are left untouched.)
    if (proxy !== undefined && accounts.isProxyRulesAuthoritative()) {
      return res.status(400).json({ error: 'proxies are managed in the Proxies module — add/edit an account-scoped rule there' });
    }

    const changes: Partial<AccountConfig> = {};

    if (typeof displayName === 'string') changes.displayName = displayName.trim() || undefined;

    // maFile: VALIDATE first, on every mode, before any state is touched (INV-A1 / C5, second
    // write path). A typo'd/invalid filename 400s here instead of persisting silently. Mirror the
    // attach route's tier semantics — flip a LIMITED account to full when the new maFile can confirm
    // — but, unlike attach-mafile, do not 400 on a missing identity_secret: PATCH may legitimately
    // replace a shared_secret-only maFile (the "can confirm" surface is governed by canConfirm).
    let newMaFile;
    if (typeof maFilePath === 'string' && maFilePath.trim()) {
      try { newMaFile = loadMaFileFromDisk(maFilePath.trim()); }
      catch (e) { return res.status(400).json({ error: `maFile: ${(e as Error).message}` }); }
      changes.maFilePath = maFilePath.trim();
      if (newMaFile.identity_secret && account.tier === 'limited') changes.tier = 'full';
    }
    const maFileChanged = !!newMaFile && maFilePath.trim() !== account.maFilePath;

    // proxy: absent = unchanged; null = inherit env; '' = force local IP; string = set proxy.
    const proxyChanged = proxy !== undefined;

    if (AccountVault.isEnabled()) {
      // Secrets (password / maFile / proxy) → the vault; accounts.json stays secret-free.
      let v = AccountVault.getAccount(account.username);
      if (!v) {
        // Orphan (in accounts.json but not vaulted, e.g. a failed migration). It still holds
        // its RECOVERABLE plaintext password in accounts.json (enterVaultMode keeps non-vaulted
        // ones), so seed the vault record from that — NEVER from a blank, which would mask the
        // real password and break login. Only heal when we have a password and a usable maFile.
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
        if (newMaFile) v.maFile = newMaFile; // already validated (400'd) above

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
      // A new proxy (next login re-logs-in through it) OR a new maFile (a resident session loads
      // its maFile once at login → keeps the stale object, so a still-live session can't confirm
      // with the freshly-attached identity_secret; INV-A1 / C5) only applies on the next login →
      // drop the current session. Best-effort: a logout hiccup never fails the edit.
      if (proxyChanged || maFileChanged) {
        await sessions.logoutAccount(account.username).catch(() => undefined);
      }
      if (proxyChanged) {
        csfloat.invalidateClient(account.username); // rebuild the CSFloat client on the new egress IP too
      }
      res.json(sanitizeAccount(updated));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // ── GET /api/accounts/:username/proxy ──────────────────────────────────────
  // Returns the account's own proxy override UN-redacted, so the edit dialog can
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
      // Include a token-only account's per-account map entry so the edit dialog shows it.
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
    csfloat.invalidateClient(account.username); // the cached client still holds this account's raw API key
    accounts.remove(account.username);
    AccountVault.removeAccount(account.username); // drop its secrets + refresh token from the vault
    res.json({ ok: true });
  }));

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
  // Returns the whole persisted inventory cache at once (username → inventory),
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

  // ── Dashboard (W1_12): fleet summary + combined value graph — read-only, no login ──
  // Aggregates the CACHED per-account values SERVER-side (scales to 500+; the frontend never
  // loops accounts). Mirrors the GET /api/inventory enrich→lock→tag pipeline so prices/categories
  // are current, then sums gross/net/count/locked per game. Wallet is counted once per account
  // across the cs2∪tf2 union (wallet is game-independent). Tri-state honest: never-refreshed
  // accounts + absent/unconvertible wallets are EXCLUDED from sums and counted separately.
  app.get('/api/dashboard/summary', (_req: Request, res: Response) => {
    const usdToEur = exchange.getUsdToEur();
    const walletUsdCents = (w?: { currency: number; balance: number }): number | null => {
      if (!w || typeof w.balance !== 'number') return null;         // absent → unknown (excluded)
      if (w.currency === 1) return Math.round(w.balance * 100);     // USD
      if (w.currency === 3) return Math.round((w.balance / usdToEur) * 100); // EUR via live rate
      return null;                                                  // other → unconvertible (excluded)
    };

    // Prep a whole-cache map exactly like GET /api/inventory: enrich sets item.price + queues fills,
    // manual-lock overlay, then re-derive tradelocked/tradable for gc records.
    const prep = (all: Record<string, AccountInventory>): Record<string, AccountInventory> => {
      const missing: Array<{ name: string; appid: number }> = [];
      for (const key of Object.keys(all)) {
        missing.push(...pricing.enrich(all[key]));
        applyManualLock(all[key]);
        if (all[key].source === 'gc') tagCategories(all[key]);
      }
      if (missing.length) pricing.ensureFilled(missing);
      return all;
    };

    const cs2 = prep(inventory.allCs2() as Record<string, AccountInventory>);
    const tf2 = prep(inventory.tf2Store.all() as Record<string, AccountInventory>);

    let newest: number | null = null, oldest: number | null = null;
    const stampFreshness = (inv: AccountInventory): void => {
      const t = new Date(inv.fetchedAt).getTime();
      if (!Number.isFinite(t)) return;
      newest = newest === null ? t : Math.max(newest, t);
      oldest = oldest === null ? t : Math.min(oldest, t);
    };

    const perGame = (all: Record<string, AccountInventory>) => {
      let grossCents = 0, netCents = 0, count = 0;
      let lockedCount = 0, lockedGross = 0, lockedNet = 0;
      let missing = 0, softNull = 0;
      for (const inv of Object.values(all)) {
        stampFreshness(inv);
        const t = pricing.totalsOf(inv);              // read-only gross + honesty flags (never mutates)
        grossCents += t.totalCents;
        missing += t.missing.length;
        softNull += t.softNull;
        for (const it of inv.items) {
          const qty = it.quantity || 0;
          count += qty;
          const g = (typeof it.price === 'number' ? it.price : 0) * qty;   // gross USD cents
          const n = g > 0 ? sellerNetFromBuyer(g) : 0;                     // net per item (fee floors) — never gross/1.15
          netCents += n;
          // `category` is a GC-record tag (tagCategories runs only for source==='gc') — web-fetched
          // records carry the lock as `tradeLockExpiry` instead. Count EITHER signal, once per item,
          // or the dashboard shows "0 items frozen" for a fleet full of web-parsed trade-holds.
          if (it.category === 'tradelocked' || it.tradeLockExpiry) { lockedCount += qty; lockedGross += g; lockedNet += n; }
        }
      }
      return { grossCents, netCents, count, lockedCount, lockedGross, lockedNet, missing, softNull };
    };

    const gCs2 = perGame(cs2);
    const gTf2 = perGame(tf2);

    // Wallet once per account over the cs2∪tf2 union (wallet is game-independent — never double it).
    // The two caches can key the same account with different casing (e.g. GC-merged CS2 view vs the
    // lowercase TF2 store) — a raw key union then counts every account twice ("1.076 with inventory"
    // on a 538-account fleet) and sums its wallet twice. Normalize to lowercase before the union.
    const lcOf = (all: Record<string, AccountInventory>): Record<string, AccountInventory> => {
      const m: Record<string, AccountInventory> = {};
      for (const k of Object.keys(all)) m[k.toLowerCase()] = all[k];
      return m;
    };
    const cs2Lc = lcOf(cs2), tf2Lc = lcOf(tf2);
    const usernames = new Set<string>([...Object.keys(cs2Lc), ...Object.keys(tf2Lc)]);
    let balanceCents = 0, walletKnown = 0, walletUnknown = 0, unconvertible = 0;
    for (const u of usernames) {
      const w = cs2Lc[u]?.wallet ?? tf2Lc[u]?.wallet;
      const cents = walletUsdCents(w);
      if (cents === null) {
        walletUnknown++;
        if (w && typeof w.balance === 'number' && w.balance > 0) unconvertible++; // real non-USD/EUR balance, excluded
      } else { balanceCents += cents; walletKnown++; }
    }

    const totalAccounts = accounts.getAll().length;
    const totalGross = gCs2.grossCents + gTf2.grossCents;
    const totalNet = gCs2.netCents + gTf2.netCents;
    const partial = (gCs2.missing + gCs2.softNull + gTf2.missing + gTf2.softNull) > 0;

    // Widgets: TF2-key tile + the two fleet Top-10 lists. One pass over both prepped caches,
    // keyed per game so a same-named item can never merge across games. Owner decision
    // (2026-07-09): "most valuable" ranks by highest UNIT price; "most owned" by total quantity.
    const TF2_KEY_NAME = 'Mann Co. Supply Crate Key';
    let tf2KeyCount = 0, tf2KeyGross = 0;
    interface TopItem { name: string; game: 'cs2' | 'tf2'; qty: number; unitCents: number | null; totalCents: number }
    const itemAgg = new Map<string, TopItem>();
    const collectTop = (all: Record<string, AccountInventory>, game: 'cs2' | 'tf2') => {
      for (const inv of Object.values(all)) {
        for (const it of inv.items) {
          const qty = it.quantity || 0;
          if (qty <= 0) continue;
          const unit = typeof it.price === 'number' ? it.price : null;
          if (game === 'tf2' && it.marketHashName === TF2_KEY_NAME) {
            tf2KeyCount += qty;
            tf2KeyGross += (unit ?? 0) * qty;
          }
          const key = `${game}:${it.marketHashName}`;
          let e = itemAgg.get(key);
          if (!e) { e = { name: it.marketHashName, game, qty: 0, unitCents: unit, totalCents: 0 }; itemAgg.set(key, e); }
          e.qty += qty;
          if (unit !== null) { e.unitCents = unit; e.totalCents += unit * qty; }
        }
      }
    };
    collectTop(cs2, 'cs2');
    collectTop(tf2, 'tf2');
    const aggList = [...itemAgg.values()];
    const topValuable = aggList
      .filter((e) => e.unitCents !== null && e.unitCents > 0)
      .sort((a, b) => (b.unitCents! - a.unitCents!) || (b.totalCents - a.totalCents))
      .slice(0, 10);
    const topOwned = aggList
      .sort((a, b) => (b.qty - a.qty) || (b.totalCents - a.totalCents))
      .slice(0, 10);

    res.json({
      asOf: newest,
      oldestAsOf: oldest,
      currency: 'USD',
      counts: {
        environments: accounts.getEnvironments().length,
        accounts: totalAccounts,
        accountsWithInventory: usernames.size,
        accountsNeverRefreshed: Math.max(0, totalAccounts - usernames.size),
        walletKnown,
        walletUnknown,
      },
      items: {
        cs2: { grossCents: gCs2.grossCents, netCents: gCs2.netCents, count: gCs2.count, missingPrices: gCs2.missing, softNull: gCs2.softNull },
        tf2: { grossCents: gTf2.grossCents, netCents: gTf2.netCents, count: gTf2.count, missingPrices: gTf2.missing, softNull: gTf2.softNull },
        totalGrossCents: totalGross,
        totalNetCents: totalNet,
        totalCount: gCs2.count + gTf2.count,
        partial,
      },
      balance: { usdCents: balanceCents, unconvertible },
      tradelocked: {
        count: gCs2.lockedCount + gTf2.lockedCount,
        grossCents: gCs2.lockedGross + gTf2.lockedGross,
        netCents: gCs2.lockedNet + gTf2.lockedNet,
      },
      grandTotal: {
        grossCents: totalGross + balanceCents,
        netCents: totalNet + balanceCents,
      },
      tf2Keys: { count: tf2KeyCount, grossCents: tf2KeyGross },
      topValuable,
      topOwned,
    });
  });

  // Combined value-over-time series for the Dashboard graph. cs2+tf2 items are joined with the
  // same carry-forward union ValueHistoryService.aggregate() uses: game-scoped snapshots almost
  // never share an exact timestamp (a TF2 refresh stamps its own `t`), so an exact-`t` join left
  // every merged point single-game — the legend's "last point" read as TF2-only. At each timestamp
  // present in EITHER series, each game contributes its latest value at-or-before it (0 before its
  // first point). Wallet is taken once (recorded identically in both game series — summing would
  // double-count it). Shaped as HistoryPoint[] for renderHistoryChart.
  app.get('/api/dashboard/history', (_req: Request, res: Response) => {
    const series = [history.get(GLOBAL_SERIES, 'cs2'), history.get(GLOBAL_SERIES, 'tf2')]
      .filter((arr) => arr.length > 0);
    if (series.length === 0) return res.json([]);
    if (series.length === 1) {
      return res.json(series[0].map((p) => ({ t: p.t, items: p.items, wallet: p.wallet, partial: !!p.partial })));
    }
    const tsSet = new Set<number>();
    for (const arr of series) for (const p of arr) tsSet.add(p.t);
    const timestamps = [...tsSet].sort((a, b) => a - b);
    const cursors = series.map(() => 0);
    const out: Array<{ t: number; items: number; wallet: number; partial: boolean }> = [];
    for (const t of timestamps) {
      let items = 0, wallet: number | null = null, partial = false;
      for (let s = 0; s < series.length; s++) {
        const arr = series[s];
        let i = cursors[s];
        while (i + 1 < arr.length && arr[i + 1].t <= t) i++;
        cursors[s] = i;
        const p = arr[i];
        if (p && p.t <= t) {
          items += p.items;
          if (wallet === null) wallet = p.wallet;   // wallet once — first contributing series wins
          if (p.partial) partial = true;
        }
      }
      out.push({ t, items, wallet: wallet ?? 0, partial });
    }
    res.json(out);
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
  // so the global-master chart follows the environment selection. Registered before the
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
    // showing it as if live. `usdToEur` kept for back-compat.
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
    const inv = await inventory.refreshOne(account.username, 'tf2');
    // A refresh refreshes the ACCOUNT, not one game (owner request): ride the same live session for the
    // CS2 leg too, so both caches carry the same wallet/timestamp and the CS2 tab never lags a TF2
    // refresh. Best-effort — a CS2-leg failure keeps the TF2 result. (Single-account path: no breaker.)
    try { await inventory.refreshOne(account.username, 'cs2'); }
    catch (err) { logger.warn(`[${account.username}] CS2 leg of the TF2 single-refresh failed: ${(err as Error).message}`); }
    history.snapshotAll('single-refresh', 'tf2'); // one curve point per refresh (both caches fresh)
    res.json(enrichInv(inv));
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
    // A refresh refreshes the ACCOUNT, not one game (owner request): the TF2 leg rides the same live
    // session (one extra web read; empty answer when the account has no TF2). Best-effort — a TF2-leg
    // failure never voids the committed CS2 result. (Single-account path: no breaker.)
    try { await inventory.refreshOne(account.username, 'tf2'); }
    catch (err) { logger.warn(`[${account.username}] TF2 leg of the CS2 single-refresh failed: ${(err as Error).message}`); }
    history.snapshotAll('single-refresh', 'cs2'); // one curve point per refresh (both caches fresh)
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
    // Tri-state (DIRECTIVES #2): a live session that fired a wallet event is authoritative even when
    // empty — normalise the refreshed-empty case to a real 0 (matching InventoryService's attach rule)
    // instead of dropping it and falling back to a possibly-stale funded cache.
    const sw = sess?.wallet;
    const live = sw ? { currency: sw.currency, balance: sw.hasWallet ? sw.balance : 0 } : undefined;
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
  // Recent activity-log lines for one account, filtered from logs/ssim.log by the
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
      // 5xx that the UI would blindly re-send (→ a second real-asset offer). Classify
      // like the buy endpoint does. Note: a confirmation failure no longer throws — it
      // returns status:'unconfirmed' below — so a throw here means the offer was not
      // confirmed-sent, but a network send can still time out post-dispatch.
      const msg = (err as Error).message;
      // S15 refuse-once: a marked pre-commit refusal is an honest duplicate-precondition, not a
      // retryable gateway fault — answer 409 so a blind retry-on-502 client cannot re-fire it.
      if ((err as { moneyOpRefused?: boolean }).moneyOpRefused) return res.status(409).json({ error: msg, refused: true });
      if (/already in flight|already running/i.test(msg)) return res.status(409).json({ error: msg });
      if (/not found|not ready|no cookies|requires either|trade ?url|trade-link|same account|disabled|empty/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      // A DEFINITE Steam rejection (eresult / recognised cause / full inventory) means the
      // offer does not exist — surface the plain reason, not the ambiguous "verify before retry" warning.
      // Transport-ambiguous / structure-less faults keep today's safe verifyBeforeRetry default.
      const f = err as { eresult?: number; cause?: string; inventoryFull?: boolean };
      const definite = !isAmbiguousCommitFailure(err)
        && f.eresult !== 16 // belt: Steam's may-have-sent code
        && (f.eresult != null || !!f.cause || f.inventoryFull === true);
      if (definite) return res.status(502).json({ error: msg, eresult: f.eresult, cause: f.cause, inventoryFull: f.inventoryFull === true });
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
    // App-agnostic send: a mass-send is driven by one game tab, so the whole batch shares one
    // app/context (CS2 730 / TF2 440, both context 2). Default to CS2 for older clients.
    const sendAppId = Number(appId) === 440 ? 440 : 730;
    const sendContextId = typeof contextId === 'string' && contextId.trim() ? contextId.trim() : '2';
    if (!toUsername && !tradeUrl) {
      return res.status(400).json({ error: 'Provide either toUsername (internal) or tradeUrl (external)' });
    }

    // Resolve the destination trade URL once (also wakes an internal storage → arms auto-accept).
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
      // 'unconfirmed' = a two-sided accept that COMMITTED on Steam but whose 2FA confirmation
      // failed; it is not a failure (no 502) — the offer awaits a manual mobile confirmation.
      const status = await trades.offerAction(username, offerId.trim(), action);
      res.json({ ok: true, username, offerId: offerId.trim(), action, ...(status === 'unconfirmed' ? { status } : {}) });
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
  // Body: { names: string[], strategy, customPriceMajor?, username?, appId?, currency? }
  // → { currency, currencyIso, decimals, resolved, prices: { name → { netMinor, buyerMinor } } }
  app.post('/api/market/preview', asyncHandler(async (req, res) => {
    const { names, strategy, customPriceMajor, username, appId, currency } = req.body ?? {};
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) {
      return res.status(400).json({ error: 'names must be a string array' });
    }
    // appId selects the market for pricing (730 CS2 default / 440 TF2). Whitelist it — an out-of-band
    // value must never reach the price cascade. Default 730 keeps a pre-TF2 client on CS2.
    const previewAppId = appId == null ? 730 : Number(appId);
    if (previewAppId !== 730 && previewAppId !== 440) {
      return res.status(400).json({ error: 'appId must be 730 (CS2) or 440 (TF2)' });
    }
    // Sanity bound — a real selection is far below 500; refuse an absurd list
    // rather than launch a tens-of-minutes cascade for one interactive request.
    if (names.length > 500) {
      return res.status(400).json({ error: 'too many names' });
    }
    if (!VALID_STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `strategy must be one of ${VALID_STRATEGIES.join(', ')}` });
    }
    const custom = readCustomMajor(customPriceMajor);
    if (strategy === 'custom' && custom == null) {
      return res.status(400).json({ error: 'customPriceMajor (> 0, in the account\'s own wallet currency) is required for strategy "custom"' });
    }
    // When the client disconnects (its 120s abort, or a manual close), stop the
    // backend cascade instead of running it to completion for an already-dead request.
    //
    // ⚠ The signal MUST come from the RESPONSE, not the request (v1.4.4 root-cause fix — owner:
    // "the fetch price still doesn't work, it shows no price 0.00"). For a POST whose body has been
    // consumed by express.json(), the request stream is finished and Node AUTO-DESTROYS it as soon as
    // the handler awaits anything — so `req.on('close')` fires and `req.destroyed` turns true on a
    // perfectly HEALTHY request. Measured: immediately {destroyed:false}, after one await
    // {destroyed:true, req_on_close_fired:true}. preview() awaits priceCtxsFor() before its worker
    // loop, so every worker saw shouldStop()===true on its first check, returned without ever calling
    // getSellInfo (hence zero `[price]` log lines), and returned an EMPTY map — which the modal renders
    // as "no price" on every row. It could never have worked through this route; the earlier
    // "live-proven" run called market.preview() directly, with no shouldStop.
    //
    // `res.on('close')` fires in both cases, so `writableFinished` disambiguates: true ⇒ we finished
    // sending (not an abort), false ⇒ the peer really went away. (A bodyless GET/SSE is not affected —
    // its request stream is never consumed — so the live-log stream's own req.on('close') stays valid.)
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    res.json(await market.preview(names, strategy, {
      customPriceMajor: custom ?? undefined,
      username: typeof username === 'string' ? username : undefined,
      shouldStop: () => clientGone,
      appId: previewAppId,
      // The client knows the selection's wallets, so it names the denomination to quote in;
      // an unrecognised code is dropped (readCurrency) and the service falls back on its own.
      currency: readCurrency(currency),
    }));
  }));

  // Body: { items: [{username, assetId, marketHashName}], strategy, customPriceMajor?, concurrency?, itemDelayMs? }
  app.post('/api/market/sell', (req: Request, res: Response) => {
    const { items, strategy, customPriceMajor, concurrency, itemDelayMs, itemConcurrency, appId } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0
      || !items.every(i => i && typeof i.username === 'string' && typeof i.assetId === 'string' && typeof i.marketHashName === 'string')) {
      return res.status(400).json({ error: 'items must be a non-empty array of { username, assetId, marketHashName }' });
    }
    if (!VALID_STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `strategy must be one of ${VALID_STRATEGIES.join(', ')}` });
    }
    // appId is the load-bearing guard feeding the real-money market/sellitem POST — whitelist it to
    // 730 (CS2) / 440 (TF2); default 730 when absent (a pre-TF2 client only ever sold CS2). One request
    // = one game (the frontend sends the active tab); the endpoint stamps this appId on every group.
    const sellAppId = appId == null ? 730 : Number(appId);
    if (sellAppId !== 730 && sellAppId !== 440) {
      return res.status(400).json({ error: 'appId must be 730 (CS2) or 440 (TF2)' });
    }
    const custom = readCustomMajor(customPriceMajor);
    if (strategy === 'custom' && custom == null) {
      return res.status(400).json({ error: 'customPriceMajor (> 0, applied in each bot\'s own wallet currency) is required for strategy "custom"' });
    }

    // Group by owner bot → one batch (and one 2FA confirmation pass) per bot.
    const groupMap = new Map<string, MassSellGroup>();
    const unknown: string[] = [];
    for (const it of items as Array<{ username: string; assetId: string; marketHashName: string }>) {
      if (!accounts.get(it.username)) { if (!unknown.includes(it.username)) unknown.push(it.username); continue; }
      const key = it.username.toLowerCase();
      const g = groupMap.get(key) ?? { username: it.username, appId: sellAppId, items: [] };
      g.items.push({ assetId: it.assetId, marketHashName: it.marketHashName });
      groupMap.set(key, g);
    }
    const groups = [...groupMap.values()];
    if (groups.length === 0) return res.status(400).json({ error: 'No sellable items for known accounts' });

    try {
      const job = market.startMassSell(groups, strategy, {
        concurrency: Number.isFinite(concurrency) ? Number(concurrency) : undefined,
        itemDelayMs: Number.isFinite(itemDelayMs) ? Number(itemDelayMs) : undefined,
        // Listing lanes per bot (hides Steam's round-trip; the per-bot request cadence is still
        // itemDelayMs). Clamped in MarketService, like every other client-supplied concurrency.
        itemConcurrency: Number.isFinite(itemConcurrency) ? Number(itemConcurrency) : undefined,
        customPriceMajor: custom ?? undefined,
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
    // `source` travels with the number: 'median' means Steam reported no live ask, so this is a
    // historical average and an order placed at it will REST, not fill. The modal says so.
    const detail = await market.lowestAskDetailed(name, appid, currency, username);
    res.json({ lowestMinor: detail ? detail.minor : null, source: detail ? detail.source : null, currency, currencyIso: info.iso, decimals: info.decimals });
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
          ...STEAM_XHR_HEADERS, // Chromium fingerprint so Steam's bot-check doesn't 429 the autocomplete
          'User-Agent': STEAM_BROWSER_UA,
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
      // Classify: a precondition/duplicate must not look like a retryable gateway
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
        // Both flags were computed and then dropped here, so the view could not tell an empty
        // section from a failed read. An empty list that might be wrong must say which it is.
        partial:       !!orders.partial,
        buyOrdersRead: orders.buyOrdersRead !== false,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // ── GET /api/market/access/:username — Steam's OWN verdict on market access ──
  // Read-only, one request through the account's session. Exists because an accepted, above-ask buy
  // order that never matches cannot be explained from SSIM's side; this asks Steam directly.
  app.get('/api/market/access/:username', asyncHandler(async (req, res) => {
    const account = accounts.get(req.params.username);
    if (!account) return res.status(404).json({ error: `Account "${req.params.username}" not found` });
    try {
      const trader = await trades.ensureWebSession(account.username);
      res.json({ username: account.username, ...(await trader.probeMarketAccess()) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // ── POST /api/market/orders-scan  { usernames: string[], appId } ───────────
  // Multi-account Active Orders (a folder / a multi-selection). DETACHED like the ban check
  //: a few hundred login-bound account reads run far past the client's 120s budget,
  // so we start the job and return 202; the view polls /api/market/orders-scan-status with a row
  // cursor and paints accounts as they land. Single-flight — a second start gets 409.
  app.post('/api/market/orders-scan', (req: Request, res: Response) => {
    const { usernames, appId } = req.body ?? {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    const known = usernames.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u));
    if (known.length === 0) return res.status(400).json({ error: 'no known accounts in usernames' });
    const appid = appId == null ? 730 : Number(appId);
    if (appid !== 730 && appid !== 440) return res.status(400).json({ error: 'appId must be 730 (CS2) or 440 (TF2)' });
    try {
      const job = market.startOrdersScan(known, appid);
      logger.info(`[orders] scan started for ${job.total} account(s) (appid ${appid})`);
      res.status(202).json({ started: true, total: job.total });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // ── GET /api/market/orders-scan-status?since=N ─────────────────────────────
  // Cursor read: returns only the account rows at index ≥ `since` (the job's `accounts` array is
  // append-only), so a 1.5s poll over a 500-bot scan never re-sends what the client already has.
  app.get('/api/market/orders-scan-status', (req: Request, res: Response) => {
    const job = market.ordersScanStatus();
    const raw = Number(req.query.since);
    const since = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), job.accounts.length) : 0;
    res.json({
      running: job.running, startedAt: job.startedAt, appId: job.appId,
      progress: job.progress, cancelling: job.cancelling, cancelled: job.cancelled, error: job.error,
      accounts: job.accounts.slice(since),
      nextIndex: job.accounts.length,
    });
  });

  // "End Task" for the orders scan: co-operative stop (rows already collected are kept).
  app.post('/api/market/orders-scan-cancel', (_req: Request, res: Response) => {
    res.json(market.cancelOrdersScan());
  });

  // ── POST /api/market/cancel-orders  { items: [{ username, kind, id }] } ────
  // Bulk cancel that may span many accounts (the multi-scope "Cancel selected/all"). Grouped per
  // account and paced inside each one; per-item failures come back as results, never a 5xx.
  app.post('/api/market/cancel-orders', asyncHandler(async (req, res) => {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array of { username, kind, id }' });
    }
    const targets: CancelOrderTarget[] = [];
    for (const it of items) {
      if (!it || typeof it.username !== 'string' || !accounts.get(it.username)) continue;
      if (it.kind !== 'sell' && it.kind !== 'buy') continue;
      if (typeof it.id !== 'string' || !it.id.trim()) continue;
      targets.push({ username: it.username, kind: it.kind, id: it.id.trim() });
    }
    if (targets.length === 0) return res.status(400).json({ error: 'no valid { username, kind, id } targets' });

    const results = await market.cancelOrdersBatch(targets);
    const ok   = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    logger.info(`[orders] bulk cancel: ${ok} ok / ${fail} failed (${results.length} total)`);
    res.json({ results, ok, fail, total: results.length });
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
  // Refreshes every listed account's balance first (enforced in BuyService), then
  // maxes out each account's purchase at the given price (applied in each account's
  // own wallet currency). Returns the initial job; poll /api/market/folder-buy-status.
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
  // Scans every given account for all Steam ban types (VAC / game / community / economy)
  // via ISteamUser/GetPlayerBans and returns them categorised. Read-only; per-account
  // failures surface as { error } rows and never abort the others. Scoped to the
  // submitted usernames only (single account, a folder's accounts, or a multi-selection).
  //
  // A cold whole-fleet check (sequential per-env key mints) can far exceed the client's
  // 120s request budget, so we START a detached job and return 202 immediately; the UI polls
  // /api/bans/status. Single-flight — a second request while one runs gets 409, no pile-up.
  app.post('/api/bans/check', (req: Request, res: Response) => {
    const { usernames } = req.body ?? {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    const known = usernames.filter((u: unknown): u is string => typeof u === 'string' && !!accounts.get(u));
    if (known.length === 0) return res.status(400).json({ error: 'no known accounts in usernames' });

    try {
      bans.startCheck(known);
      logger.info(`[bans] started check for ${known.length} account(s)`);
      res.status(202).json({ started: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // GET /api/bans/status — live snapshot of the running/last ban-check job (read-only). The result
  // is retained until the next check, so a poll landing after completion still receives it.
  app.get('/api/bans/status', (_req: Request, res: Response) => {
    res.json(bans.status());
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Feature 1 – Automated Max-Profit Trade-Ups (single account only)
  //  Calculation + preview are always available; EXECUTION is gated behind the GC
  //  layer's verified flag (SSIM_GC_VERIFIED) and only ever destroys items the owner
  //  explicitly selected + started. See FEATURES.md.
  // ════════════════════════════════════════════════════════════════════════

  // POST /api/tradeup/candidates { username, all? } — live-refresh + compute trade-ups. `all:true`
  // returns every computable contract (profitable + not) for the "All trade-ups" tab; default = profitable only.
  app.post('/api/tradeup/candidates', asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    if (!accounts.get(username)) return res.status(400).json({ error: 'valid username is required' });
    const minProfitCents = Number.isFinite(req.body?.minProfitCents) ? Number(req.body.minProfitCents) : 0;
    try {
      res.json(await tradeup.getCandidates(username, { minProfitCents, includeUnprofitable: req.body?.all === true }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // POST /api/tradeup/execute { username, contracts:[{ inputAssetIds:string[10] }] } — HIGH RISK + GATED.
  app.post('/api/tradeup/execute', (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    if (!accounts.get(username)) return res.status(400).json({ error: 'valid username is required' });
    // costCents/unpricedInputs ride along purely for the run summary; startExecute validates the
    // craft-critical fields (10 unique asset ids + rarity) itself and ignores anything else.
    const contracts = Array.isArray(req.body?.contracts) ? req.body.contracts : [];
    try {
      res.json(tradeup.startExecute(username, contracts));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });
  // POST /api/tradeup/auto { username, profitableOnly? } — HIGH RISK + GATED. One click settles the
  // whole account: plan a disjoint batch → craft it → let the inventory settle → re-plan, until
  // nothing is left. Shares the single execution job, so /execute-status + /execute-cancel drive it.
  app.post('/api/tradeup/auto', (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    if (!accounts.get(username)) return res.status(400).json({ error: 'valid username is required' });
    // Default TRUE: crafting every computable contract also crafts the value-destroying ones, so
    // the caller has to ask for that explicitly rather than get it from an omitted field.
    const profitableOnly = req.body?.profitableOnly !== false;
    try {
      res.json(tradeup.startAuto(username, { profitableOnly }));
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
      const { imported, skipped, rejected } = importCsvIntoVault(accounts, csv, environmentId, folderId ?? null);
      res.json({ imported, skipped, rejected });
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
    // accountsJson (the source's accounts.json) is OPTIONAL — when supplied and no explicit target
    // folder is chosen, the source's folder organisation is recreated in the target environment.
    // An explicit folderId from the modal takes precedence (all bots land in that one folder).
    const orgJson = typeof accountsJson === 'string' && accountsJson.trim() ? accountsJson : undefined;
    try {
      const r = importExternalVault(accounts, vault, password, orgJson, environmentId, folderId ?? null);
      if (r === null) return res.status(401).json({ error: 'wrong password, or this is not an SSIM vault file' });
      res.json(r);
    } catch (e) {
      // A source vault from a NEWER SSIM is a distinct, actionable outcome — not a password error
      //: tell the operator to update SSIM on this machine before importing again.
      if ((e as Error).message === VAULT_NEWER_VERSION_ERROR) {
        return res.status(409).json({ error: 'This vault file was exported by a NEWER SSIM version. Update SSIM on this machine, then import again.' });
      }
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Lists *.maFile in ./mafiles/ that are not yet registered to an account.
  app.get('/api/mafiles/unlinked', (_req: Request, res: Response) => {
    res.json(listUnlinkedMaFiles(accounts));
  });

  // Body: { files: string[], environmentId, folderId? }
  // STRICT: an explicit environmentId and a non-empty selection are REQUIRED. The selected
  // maFiles are imported into exactly the chosen env/folder — nothing else is touched.
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
      try {
        const { imported, skipped, reasons } = importDropZoneIntoVault(accounts, environmentId, folderId ?? null, files.map(String));
        return res.json({ vault: true, imported, skipped, reasons, migrated: 0, added: [] });
      } catch (e) {
        // A transiently-locked accounts.txt (EBUSY/EPERM) is named, not a generic 500 — the whole
        // import aborts before any mutation, so the operator can close the file and retry.
        if ((e as { code?: string }).code === 'ACCOUNTS_TXT_LOCKED') return res.status(409).json({ error: (e as Error).message });
        // Any other import failure (e.g. a locked vault / missing env from a guard-bypassing caller)
        // is 400 JSON, never an Express default 500 HTML page the frontend api() can't render.
        return res.status(400).json({ error: (e as Error).message });
      }
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

  // ════════════════════════════════════════════════════════════════════════
  //  GET /api/jobs — every long-running job in one answer.
  //
  //  SSIM has always run these concurrently: a fleet refresh, a mass-sell and a storage move can
  //  all be in flight at once. Nothing said so. Each job's progress lived only inside the modal
  //  that started it, so closing that modal made a running job invisible and the operator waited
  //  for a machine that was already free (owner report 2026-08-12). This is the one place that
  //  knows what is actually running; the rail's Activity view is its only consumer.
  //
  //  Read-only and cheap — every status() below is an in-memory snapshot, no I/O. Jobs that are
  //  neither running nor recently finished are simply absent, so an idle install answers `[]`.
  // ════════════════════════════════════════════════════════════════════════

  /** How long a FINISHED job stays in the list, so a run that ended while you were elsewhere is
   *  still visible when you look. Long enough to notice, short enough not to become a history log
   *  (Batch Jobs already keeps one). */
  const JOB_LINGER_MS = 90_000;

  interface JobRow {
    id: string; label: string; detail?: string; running: boolean; cancelling?: boolean;
    total: number; done: number; failed?: number; phase?: string;
    startedAt?: number; finishedAt?: number; cancelPath?: string; nav?: string;
  }

  /** ISO string | epoch ms | null → epoch ms | undefined. Job services disagree on the encoding. */
  const jobTime = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; }
    return undefined;
  };

  const collectJobs = (): JobRow[] => {
    const out: JobRow[] = [];
    /** Adds a job when it is running, or finished recently enough to still be worth showing. */
    const add = (
      id: string, label: string, cancelPath: string | undefined, nav: string | undefined,
      s: Record<string, unknown> | null | undefined,
      map: (s: Record<string, unknown>) => { detail?: string; total: number; done: number; failed?: number; phase?: string },
    ): void => {
      if (!s) return;
      const running = s.running === true;
      const finishedAt = jobTime(s.finishedAt);
      // `finishedAt` is the only honest "it ended" signal. A service that never sets one (a scan, a
      // ban check) simply drops off the list the moment it stops, rather than lingering forever on
      // a stale snapshot that would read as "still working".
      if (!running && !(finishedAt && Date.now() - finishedAt < JOB_LINGER_MS)) return;
      let m;
      try { m = map(s); } catch { return; }  // a drifted status shape must never 500 the whole list
      out.push({
        id, label, running, cancelling: s.cancelling === true,
        startedAt: jobTime(s.startedAt), finishedAt,
        cancelPath: running ? cancelPath : undefined, nav, ...m,
      });
    };
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const arr = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

    add('inventory-refresh', 'Inventory refresh', '/api/inventory/refresh-cancel', 'inventories', inventory.status() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: arr(s.failed), detail: s.game ? String(s.game).toUpperCase() : undefined }));
    add('mass-send', 'Mass send', '/api/trade/mass-cancel', 'inventories', trades.massStatus() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: arr(s.failed) }));
    add('mass-sell', 'Mass sell', '/api/market/sell-cancel', 'inventories', market.status() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: arr(s.failed), detail: s.strategy ? `${String(s.strategy)} · ${n(s.listed)} listed` : undefined }));
    add('folder-buy', 'Folder buy', '/api/market/folder-buy-cancel', 'inventories', buy.massBuyStatus() as never,
      // Two phases over the same account list — count whichever one is actually in progress, or the
      // bar would sit at 0% through the whole balance-refresh half of the run.
      (s) => ({ total: n(s.total), done: s.phase === 'refreshing' ? n(s.refreshed) : n(s.processed), failed: arr(s.failed), phase: s.phase ? String(s.phase) : undefined, detail: s.marketHashName ? String(s.marketHashName) : undefined }));
    add('orders-scan', 'Active orders scan', '/api/market/orders-scan-cancel', 'inventories', market.ordersScanStatus() as never,
      (s) => { const p = (s.progress ?? {}) as Record<string, unknown>; return { total: n(p.total), done: n(p.done), failed: n(p.errors) }; });
    add('tradeup', 'Trade-up', '/api/tradeup/execute-cancel', 'inventories', tradeup.executeStatus() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: n(s.failed), phase: s.phase ? String(s.phase) : undefined, detail: s.auto ? `auto · round ${n(s.round)}` : undefined }));
    add('casket-move', 'Storage move', '/api/casket/move-cancel', 'inventories', casket.moveStatus() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: n(s.failed), detail: [s.username, s.direction].filter(Boolean).join(' · ') || undefined }));
    add('batch', 'Batch job', '/api/batch/cancel', 'batch', batch.status() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: arr(s.failed), detail: s.label ? String(s.label) : undefined }));
    add('distribute', 'Distribute items', '/api/inventory/distribute/cancel', 'inventories', distribute.status() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: arr(s.failed) }));
    add('csfloat-bulk', 'CSFloat bulk', '/api/csfloat/bulk-cancel', undefined, csfloatBulk.status() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: n(s.failed), detail: [s.username, s.kind].filter(Boolean).join(' · ') || undefined }));
    add('csfloat-deliver', 'CSFloat delivery', '/api/csfloat/deliver-cancel', undefined, csfloatWorker.deliverStatus() as never,
      (s) => ({ total: n(s.total), done: n(s.done), failed: n(s.failed), detail: s.username ? String(s.username) : undefined }));
    // A ban check reports no finishedAt, so it shows only while genuinely live.
    add('ban-check', 'Ban check', undefined, 'accounts', bans.status() as never,
      (s) => { const p = (s.progress ?? {}) as Record<string, unknown>; return { total: n(p.total), done: n(p.checked) }; });
    // The top-up run is human-in-the-loop (the operator finishes each checkout in a browser), so it
    // counts the CURRENT account rather than completed work, and offers no cancel — the run is
    // stopped from its own screen, where the half-finished checkout is visible.
    add('paysafe', 'Wallet top-up', undefined, 'batch', paysafe.status() as never,
      (s) => ({ total: n(s.total), done: n(s.index), detail: `account ${n(s.index) + 1} of ${n(s.total)}` }));

    // Longest-running first: the one you are most likely waiting on leads the list.
    return out.sort((a, b) => Number(b.running) - Number(a.running) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  };

  app.get('/api/jobs', (_req: Request, res: Response) => {
    const jobs = collectJobs();
    res.json({ jobs, running: jobs.filter((j) => j.running).length });
  });

  app.get('/api/system/status', (_req: Request, res: Response) => {
    const availableUpdate = getAvailableUpdate();
    const blockedUpdate = getBlockedUpdate();
    const priorCrash = getPriorCrash();
    res.json({
      // Always true: SSIM is free software with no licence gate. Kept as a compatibility
      // shim because the dashboard's client-guard in public/app.js still reads this field —
      // removing it here would lock the UI out. TODO(oss): drop both together.
      licensed: true,
      version: pkg.version,
      // Money-ops breaker: mirror /api/health's stable/quarantineReason onto the endpoint the
      // dashboard already polls, so the operator SEES a tripped breaker (latch semantics unchanged).
      moneyOpsStable: !ProcessHealth.moneyOpsBlocked(),
      ...(ProcessHealth.moneyOpsBlocked() ? { quarantineReason: ProcessHealth.blockReason() } : {}),
      // Refresh-token store DEGRADED: the file is present-but-corrupt and not persisting → the
      // operator must restore it before a mass refresh re-auths the fleet.
      ...(sessions.isTokenStoreDegraded() ? { tokenStoreDegraded: true } : {}),
      // CSFloat key store DEGRADED: csfloat_keys.json is present-but-corrupt (plaintext mode) →
      // keys are silently absent (pricing falls back to Steam, auto-accept skips accounts). Surface it.
      ...(csfloat.isKeyStoreDegraded() ? { csfloatKeyStoreDegraded: true } : {}),
      // Update availability + per-machine block: "update available", and "ready but blocked on
      // this machine — manual install" when the artifact has failed its self-test ≥N times here.
      update: {
        available: !!availableUpdate,
        latest: availableUpdate?.version,
        notes: availableUpdate?.notes,
        blocked: !!(availableUpdate && blockedUpdate && blockedUpdate.version === availableUpdate.version),
        blockedFailures: blockedUpdate?.failures,
        blockedKind: blockedUpdate?.kind,
        // Expose the LAST update outcome + whether an update op is in flight, so the dashboard can
        // stop showing "installing…" forever when a user-confirmed install kept-current (a swap exits the
        // process, so a still-running backend with installing:false means the install ended → badge back).
        currentOutcome: getUpdateOutcome(),
        installing: isUpdateOpInFlight(),
      },
      // Prior-run crash banner: the shell recorded an unexpected backend death last run. Shown
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

  // ── Manual update check / install ─────────────────────────────────────
  // POST under /api/ → automatically capability- and CSRF-guarded (no extra wiring). Default = a
  // CHECK-ONLY network probe that refreshes "update available". With { install:true } the user has
  // EXPLICITLY confirmed installing now: refused while any trade/buy/refresh is in flight (a swap exits
  // the process), else fire-and-forget the full update (download → verify → self-test → swap), which
  // restarts SSIM on success. This is the ONLY mid-session swap path — never automatic.
  // Wrapped in asyncHandler like every other async route — a reject from checkOnly()/installNow (if
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
// Classify CSFloat failures so transient upstream/network faults are retryable, not a
// permanent-looking 400. Preserve rate-limit (429) and genuine client errors (4xx, e.g. 401/403 auth);
// map upstream 5xx and status-less transport failures (timeout/ECONN*) to a retryable 502 gateway error.
export function csErr(err: unknown): number {
  const st = (err as { status?: number }).status;
  if (st === 429) return 429;
  if (typeof st === 'number' && st >= 500) return 502;
  if (typeof st === 'number' && st >= 400) return st;
  return 502;
}
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
    // The dashboard should show the real "can confirm trades" capability
    // (maFile identity_secret, resolved vault then disk like login does), not the raw tier
    // label. tier is a projection of this — consulted only when the maFile is unreadable.
    canConfirm: canConfirm({
      identitySecret: identitySecretPresence(account),
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

/** The resolved egress summary shown for an environment that has no accounts to resolve. */
export function emptyEgress(): EnvEgress {
  return { kind: 'none', label: 'No accounts', ruleNames: [], proxies: [], localCount: 0, proxyCount: 0 };
}

export interface EnvEgress {
  /** 'proxy' = every account leaves via one proxy · 'mixed' = more than one distinct outcome ·
   *  'local' = every account is on the host IP · 'none' = the environment has no accounts. */
  kind: 'proxy' | 'mixed' | 'local' | 'none';
  /** Ready-to-render summary, credentials already redacted. */
  label: string;
  /** Distinct proxy-rule names covering this environment (empty when nothing matched). */
  ruleNames: string[];
  /** Distinct redacted proxy egress values in this environment. */
  proxies: string[];
  localCount: number;
  proxyCount: number;
}

/**
 * Per-environment EFFECTIVE egress, grouped from one fleet-wide resolution sweep.
 *
 * Why this exists (v1.4.4, owner issue 1: "after changing an environment proxy from no proxy to a rule it
 * doesn't show in the environment tab, even though the logs say it applied"): egress is resolved PER ACCOUNT
 * by the proxy-rule engine, while the environment object still carries only the legacy `proxy` string. Once
 * proxy rules are authoritative that string is permanently empty, so any UI keyed on it reports "Local IP"
 * forever. This reports what the accounts actually use, so the tab agrees with the logs.
 */
export function environmentEgress(accounts: AccountManager): Map<string, EnvEgress> {
  const byEnv = new Map<string, EnvEgress>();
  for (const r of accounts.resolutionPreview()) {
    const e = byEnv.get(r.environmentId) ?? emptyEgress();
    // A pool-lost account has no usable egress; count it as local so it can never be shown as "proxied"
    // (that state is the host-IP-leak guard, and over-reporting a proxy here would hide it).
    const isProxy = !r.poolLost && r.network?.type === 'proxy' && !!r.network.value?.trim();
    if (isProxy) {
      e.proxyCount++;
      const red = redactProxyCredentials(r.network!.value);
      if (red && !e.proxies.includes(red)) e.proxies.push(red);
      if (r.ruleName && !e.ruleNames.includes(r.ruleName)) e.ruleNames.push(r.ruleName);
    } else {
      e.localCount++;
    }
    byEnv.set(r.environmentId, e);
  }
  for (const e of byEnv.values()) {
    if (e.proxyCount > 0 && e.localCount === 0 && e.proxies.length === 1) {
      e.kind = 'proxy';
      e.label = e.proxies[0];
    } else if (e.proxyCount > 0) {
      e.kind = 'mixed';
      // Name the rules when we can — that is what the operator just configured and wants confirmed.
      e.label = e.ruleNames.length
        ? `${e.ruleNames.join(', ')} (${e.proxyCount} proxied${e.localCount ? `, ${e.localCount} local` : ''})`
        : `${e.proxies.length} proxies${e.localCount ? ` (+${e.localCount} local)` : ''}`;
    } else {
      e.kind = 'local';
      e.label = 'Local IP (no proxy)';
    }
  }
  return byEnv;
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
 * The hostname portion of a Host header, correctly handling a bracketed IPv6 literal.
 * `[::1]:3000` → `[::1]` (the old `.split(':')[0]` yielded `[`, 403-ing a legit ::1 bind and
 * disagreeing with originGuard). `localhost:3000` → `localhost`; `127.0.0.1:3000` → `127.0.0.1`.
 */
export function hostnameOnly(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end >= 0 ? h.slice(0, end + 1) : h; }
  return h.split(':')[0];
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
