import axios from 'axios';
import Request from 'request';
import SteamCommunity from 'steamcommunity';
import TradeOfferManager from 'steam-tradeoffer-manager';
import * as SteamTotp from 'steam-totp';
import type { ManagedSession } from '../types/session';
import { logger } from '../utils/logger';
import {
  parseMyListings, mergeParsed, emptyParsed,
  listedAssetIdsForApp, type MarketListing,
} from '../core/MarketModel';
import { shapeConfirmations, type ConfirmationView } from './confirmations';

// Trade-offer state + filter enums (static members of the manager class).
const ETradeOfferState = TradeOfferManager.ETradeOfferState;
const EOfferFilter     = TradeOfferManager.EOfferFilter;

// CS2 lives on appid 730, inventory context 2.
const CS2_APPID     = 730;
const CS2_CONTEXTID = '2';

// Steam mobile-confirmation type for a market listing (vs. 2 = Trade).
const CONF_TYPE_MARKET_LISTING = 3;

const MARKET_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Per-account trade-manager tuning (memory + background-poll load) ───────────
// Each logged-in account owns a TradeOfferManager that POLLS Steam on this interval
// AND retains up to `assetCacheMaxItems` item descriptions. Across a large fleet both
// multiply: at the old 5s interval that was ~N/5 WebAPI polls/sec fleet-wide, and an
// N×20 000 description cache that was a top resident-memory consumer (the prime leak
// suspect). Both are now env-tunable with far leaner defaults; raise them only if
// faster offer pickup or huge single trades demand it. Auto-accept of an internal
// offer fires on the next poll, so POLL_INTERVAL_MS is the worst-case accept latency.
const POLL_INTERVAL_MS = Math.max(5_000, Number(process.env.SSIM_POLL_INTERVAL_MS) || 20_000);
const ASSET_CACHE_MAX  = Math.max(500,   Number(process.env.SSIM_ASSET_CACHE_MAX)  || 4_000);

export interface SellOnMarketResult {
  /** True when the listing was created but still awaits a mobile 2FA confirmation. */
  needsConfirmation: boolean;
}

/** Billing/address the Steam market buy order requires. The working browser
 *  request sends a REAL name + address (empty fields → Steam's need_confirmation
 *  gate). save=true mirrors the browser's save_my_address=1. */
export interface BuyBilling {
  firstName?:  string;
  lastName?:   string;
  address?:    string;
  addressTwo?: string;
  city?:       string;
  state?:      string;
  country?:    string;
  postalCode?: string;
  save?:       boolean;
}

export interface BuyOrderResult {
  /** Steam accepted the create request (order exists, possibly pending confirm). */
  placed: boolean;
  /** We cleared the mobile 2FA confirmation (or none was required). */
  confirmed: boolean;
  /** True only if Steam STILL reports the order as needing a confirmation we couldn't clear. */
  needsConfirmation: boolean;
  /** Steam buy_orderid (the confirmation 'creator'), when known. */
  buyOrderId?: string;
  /** Raw last response body, for diagnostics / verification logging. */
  raw?: unknown;
}

/** One active market SELL listing (an item the account currently has on sale). */
export interface ActiveSellOrder {
  /** Steam listingid – the handle the cancel (removelisting) call needs. */
  listingId:         string;
  assetId:           string;
  appId:             number;
  marketHashName:    string;
  name:              string;
  iconUrl:           string;
  /** What a BUYER pays (seller-net price + Steam fee), in `currency` minor units. */
  pricePerItemMinor: number;
  currency:          number;   // Steam ECurrencyCode (0 = unknown)
  quantity:          number;   // market listings are always 1, kept for symmetry
}

/** One active market BUY order (a resting request to buy at a set price). */
export interface ActiveBuyOrder {
  /** Steam buy_orderid – the handle the cancel (cancelbuyorder) call needs. */
  buyOrderId:        string;
  appId:             number;
  marketHashName:    string;
  name:              string;
  iconUrl:           string;
  pricePerItemMinor: number;   // per single item, in `currency` minor units
  currency:          number;   // Steam ECurrencyCode (0 = unknown)
  quantity:          number;           // originally requested
  quantityRemaining: number;           // still open (not yet filled)
}

/** The account's full set of open market orders, both sides, all games. */
export interface MarketOrders {
  sellOrders: ActiveSellOrder[];
  buyOrders:  ActiveBuyOrder[];
  /** True when a page ≥ 1 or the buy-order landing fallback failed mid-fetch, so the
   *  returned rows are a partial (not authoritative) snapshot — the UI labels it as such
   *  instead of presenting a truncated list as complete. */
  partial?:   boolean;
}

// ── Trade Offers (sent + received) ────────────────────────────────────────────

/** One item inside a trade offer (given or received). */
export interface TradeOfferItem {
  appId:          number;
  contextId:      string;
  assetId:        string;
  classId?:       string;
  amount:         number;
  name:           string;
  marketHashName: string;
  iconUrl:        string;
}

/** A normalized view of a single Steam trade offer (sent or received). */
export interface TradeOfferView {
  offerId:         string;
  /** SteamID64 of the trade partner (receiver for a sent offer, sender for a received one). */
  partnerSteamId:  string;
  /** Resolved Steam persona name of the partner, when available (best-effort). */
  partnerName?:    string;
  message:         string;
  /** ETradeOfferState numeric code (2 = Active, 3 = Accepted, …). */
  state:           number;
  /** Human-readable state name ('Active', 'Accepted', 'Declined', …). */
  stateName:       string;
  /** True when WE sent the offer (vs. an incoming/received offer). */
  isOurOffer:      boolean;
  /** True while the offer is still pending the partner's / our action. */
  active:          boolean;
  createdAt?:      string;   // ISO
  updatedAt?:      string;   // ISO
  expiresAt?:      string;   // ISO
  escrowEndsAt?:   string;   // ISO (set only when the trade is held in escrow)
  itemsToGive:     TradeOfferItem[];
  itemsToReceive:  TradeOfferItem[];
  /** Total cached Steam value (USD cents) of the items WE give — filled by the API
   *  layer from the price cache (null = no priced items / unknown). */
  valueGiveCents?:    number | null;
  /** Total cached Steam value (USD cents) of the items WE receive — filled by the API. */
  valueReceiveCents?: number | null;
}

/** Both sides of an account's trade offers (each sorted active-first, newest-first). */
export interface TradeOffers {
  sent:     TradeOfferView[];
  received: TradeOfferView[];
}

const IMG_BASE = 'https://community.cloudflare.steamstatic.com/economy/image/';

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export interface TradeItemRef {
  assetId:    string;
  appId?:     number;   // the item's real app (730 CS2 / 440 TF2); default 730 (back-compat)
  contextId?: string;   // the item's real context; default '2'
}

export interface SendTradeParams {
  /** Internal target by SteamID64 (mutually exclusive with tradeUrl). */
  partnerSteamId?: string;
  /** External/internal target by full trade URL (wins over partnerSteamId). */
  tradeUrl?:       string;
  /** Items WE give away. */
  myItems?:        TradeItemRef[];
  /** Items we expect to RECEIVE (optional, for 1:1 swaps). */
  theirItems?:     TradeItemRef[];
  message?:        string;
}

export interface SendTradeResult {
  offerId: string;
  /**
   * 'sent'        = no mobile confirmation was required.
   * 'confirmed'   = we auto-confirmed via 2FA.
   * 'unconfirmed' = the offer EXISTS on Steam but its 2FA confirmation could NOT be
   *                 cleared (even after retries). Callers MUST treat this as
   *                 "placed, needs manual confirmation" and never auto-resend — a
   *                 re-send would create a SECOND real-asset offer.
   */
  status:  'sent' | 'confirmed' | 'unconfirmed';
}

/**
 * Per-account trading wrapper. Owns its OWN SteamCommunity + TradeOfferManager,
 * both bound to the account's isolated httpsAgent — the 100% network-isolation
 * rule is preserved (no shared agents/cookies between accounts).
 */
export class AccountTrader {
  readonly username:  string;
  readonly community: SteamCommunity;
  readonly manager:   TradeOfferManager;

  private cookiesReady = false;
  private tradeUrlCache: string | undefined;

  constructor(
    private readonly session: ManagedSession,
    onNewOffer?: (trader: AccountTrader, offer: any) => void,
  ) {
    this.username = session.account.username;

    // ── Network isolation ──────────────────────────────────────────────────
    // Injecting the per-account agent into a `request` instance routes EVERY
    // community + manager HTTP call through this account's IP/proxy only.
    // `timeout` is mandatory: neither steamcommunity nor tradeoffer-manager set
    // one, so a proxy that silently drops api.steampowered.com would hang every
    // WebAPI call (and with it the trade-history sync) forever.
    const request = (Request as any).defaults({ agent: session.httpsAgent, timeout: 30_000 });

    this.community = new SteamCommunity({ request });
    this.manager   = new TradeOfferManager({
      steam:         session.client,
      community:     this.community,
      language:      'en',
      dataDirectory: null,   // never share poll-data on disk across isolated accounts
      pollInterval:  POLL_INTERVAL_MS,
      // The description cache defaults to 500 items. A single mass-consolidation trade
      // can hold 700+ items, and getOffers fetches descriptions for EVERY item across ALL
      // offers in one pass — so too small a ceiling evicts earlier descriptions mid-fetch,
      // leaving items BARE (no name / icon / market_hash_name → no price). ASSET_CACHE_MAX
      // (default 4 000) keeps the documented mass-consolidation pass resident while cutting
      // the old 20 000 ceiling ~5× — the single biggest per-account resident-memory drop.
      assetCacheMaxItems: ASSET_CACHE_MAX,
    });

    this.manager.on('newOffer', (offer) => onNewOffer?.(this, offer));
    // Library internals (cursor pagination, classinfo fetches, poll errors) go
    // to the logfile – essential for diagnosing slow/hanging WebAPI calls live.
    this.manager.on('debug', (msg: unknown) => logger.debug(`[${this.username}] tom: ${String(msg)}`));
    this.manager.on('pollFailure', (err: unknown) => logger.debug(`[${this.username}] tom poll failure: ${(err as Error)?.message ?? err}`));
    // SAFETY NET: both emitters extend EventEmitter, and an 'error' event with NO
    // listener is RE-THROWN by Node — from inside a library timer/callback we cannot
    // try/catch, so one stray emit would abort the whole process. A logging listener
    // on each neutralises that across all (potentially hundreds of) live managers.
    this.manager.on('error', (err: unknown) => logger.warn(`[${this.username}] trade-manager error: ${(err as Error)?.message ?? err}`));
    this.community.on('error', (err: unknown) => logger.warn(`[${this.username}] community error: ${(err as Error)?.message ?? err}`));
  }

  // ── Cookie lifecycle ─────────────────────────────────────────────────────

  /** Pushes fresh web-session cookies into the manager AND the community. */
  setCookies(cookies: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      // Set the cookies on the SteamCommunity instance EXPLICITLY (its `request`
      // cookie jar). The TradeOfferManager forwards them too, but the market buy
      // flow uses community.httpRequestPost directly, so the community must own a
      // clean, authenticated jar (steamLoginSecure + sessionid) in its own right.
      try { (this.community as unknown as { setCookies(c: string[]): void }).setCookies(cookies); }
      catch (e) { logger.warn(`[${this.username}] community.setCookies failed: ${(e as Error).message}`); }

      this.manager.setCookies(cookies, (err) => {
        if (err) { reject(err); return; }
        this.cookiesReady = true;
        this.tradeUrlCache = undefined; // re-fetch lazily after a cookie refresh
        logger.info(`[${this.username}] trade manager + community cookies set`);
        resolve();
      });
    });
  }

  get ready():   boolean            { return this.cookiesReady; }
  get steamId(): string | undefined { return this.session.steamId; }
  /**
   * True when this trader is bound to EXACTLY this live session instance.
   * A re-login creates a NEW ManagedSession object; a trader still pointing at
   * the old one would use stale cookies and – worse – the OLD httpsAgent (wrong
   * proxy after a network change). TradeService uses this to rebuild traders.
   */
  isBoundTo(session: ManagedSession): boolean { return this.session === session; }
  /** Current SteamUser session state (e.g. 'LOGGED_IN', 'DISCONNECTED'). */
  get sessionState(): string         { return String(this.session.state); }
  /** The account's isolated HTTPS agent (proxy / local-IP bound) – lets callers
   *  route side requests (e.g. market price checks) through this bot's IP. */
  get httpsAgent(): unknown          { return this.session.httpsAgent; }
  /** The account's current web-session cookies (for authenticated market reads
   *  such as the listings/render price fallback, which is HTML-walled anonymously). */
  get cookies(): string[]            { return this.session.webSession?.cookies ?? []; }
  /** The bot's native Steam wallet currency (ECurrencyCode) – buy orders MUST be
   *  priced in this currency. Undefined until the 'wallet' event has fired. */
  get walletCurrency(): number | undefined { return this.session.wallet?.currency; }
  /** The bot's Steam wallet balance (native currency units), as last captured. */
  get walletBalance():  number | undefined { return this.session.wallet?.balance; }

  /**
   * Returns the set of CS2 asset ids currently tied to this account's market
   * listings (active + the items behind pending-confirmation listings). Used by
   * the mass-sell orchestrator (a) as a live connectivity PRE-FLIGHT — it is a
   * real authenticated GET through the bot's proxy, so it throws when the proxy
   * is dead — and (b) to detect "phantom" listings Steam silently created after
   * a timeout. Throws on any network/HTTP failure so callers can react.
   */
  async getListedAssetIds(): Promise<Set<string>> {
    const cookies = this.session.webSession?.cookies ?? [];
    const acc = emptyParsed();
    const PAGE = 100;
    const MAX_PAGES = 30; // up to 3000 listings – plenty for a storage bot
    let truncationWarned = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE;
      const url = `https://steamcommunity.com/market/mylistings/render/?query=&start=${start}&count=${PAGE}&norender=1`;
      const r = await axios.get(url, {
        httpsAgent:     this.session.httpsAgent,
        proxy:          false, // per-account isolation: ignore env-var proxies
        timeout:        20_000,
        validateStatus: () => true,
        headers: {
          Cookie:       cookies.join('; '),
          'User-Agent': MARKET_UA,
          Accept:       'application/json',
          Referer:      'https://steamcommunity.com/market/',
          Connection:   'close', // fresh proxy exit IP per probe
        },
      });
      if (r.status !== 200) throw new Error(`market/mylistings HTTP ${r.status}`);
      const d = r.data;
      if (!d || typeof d !== 'object') throw new Error('market/mylistings: malformed response');

      // ONE canonical parse — same membership rule as the inventory "Listed" bucket
      // (MarketListings.fetchListedItems) and the Active Orders view, so the three
      // can never disagree about which assets are on the market (the field bug).
      mergeParsed(acc, parseMyListings(d));

      // Stop when we've covered all listings (total_count) or hit an empty/partial page.
      const total = Number(d.total_count);
      if (!truncationWarned && Number.isFinite(total) && total > MAX_PAGES * PAGE) {
        logger.warn(`[${this.username}] market/mylistings has ${total} listings – truncated at ${MAX_PAGES * PAGE}; listed-set is INCOMPLETE`);
        truncationWarned = true;
      }
      const fetchedListings = Array.isArray(d.listings) ? d.listings.length : 0;
      if (fetchedListings === 0) break;                                 // empty page → done
      if (Number.isFinite(total) && start + PAGE >= total) break;       // covered all
      if (fetchedListings < PAGE) break;                                // last partial page
    }
    return listedAssetIdsForApp(acc, CS2_APPID);
  }

  // ── New feature: Active Orders (fetch + cancel sell listings & buy orders) ──

  /**
   * Reads the account's FULL set of open market orders — active SELL listings and
   * resting BUY orders — for the "Active Orders" dashboard tab. One authenticated
   * pass through the bot's own cookies + isolated agent (same isolation as every
   * other market call).
   *
   * Sell listings are paginated via market/mylistings/render (the proven endpoint);
   * each listing's item name/icon come from that page's `assets` map. Buy orders are
   * read from the same payload when present, else from one market/mylistings landing
   * fetch (Steam only embeds buy_orders on the landing page). Orders for ALL games
   * are returned, each tagged with its appId so the caller can filter (CS2 vs TF2).
   * Throws on a hard failure of the FIRST page so a dead proxy surfaces as a real error.
   */
  async getMarketOrders(): Promise<MarketOrders> {
    const cookies = this.session.webSession?.cookies ?? [];
    const seenSell = new Map<string, ActiveSellOrder>();
    const seenBuy = new Map<string, ActiveBuyOrder>();
    let partial = false; // a page ≥ 1 or the buy-order fallback failed → snapshot is incomplete
    const PAGE = 100;
    const MAX_PAGES = 30; // up to 3000 listings
    let truncationWarned = false;

    const get = (url: string): Promise<{ status: number; data: any }> =>
      axios.get(url, {
        httpsAgent:     this.session.httpsAgent,
        proxy:          false, // per-account isolation: ignore env-var proxies
        timeout:        20_000,
        validateStatus: () => true,
        headers: {
          Cookie:       cookies.join('; '),
          'User-Agent': MARKET_UA,
          Accept:       'application/json',
          Referer:      'https://steamcommunity.com/market/',
          Connection:   'close',
        },
      }).then((r) => ({ status: r.status, data: r.data }));

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE;
      const { status, data } = await get(
        `https://steamcommunity.com/market/mylistings/render/?query=&start=${start}&count=${PAGE}&norender=1`);
      if (status !== 200)            { if (page === 0) throw new Error(`market/mylistings HTTP ${status}`); partial = true; break; }
      if (!data || typeof data !== 'object') { if (page === 0) throw new Error('market/mylistings: malformed response'); partial = true; break; }

      // Canonical parse → Active Orders sell rows. Same membership rule as the
      // inventory "Listed" bucket, so the two views can never disagree. Deduped by
      // listingId; pending listings appear too (projected with confirmed=false upstream).
      // parseMyListings throws on a non-listings body ({"success":false}/shapeless) so a
      // hiccup is never coerced to "no orders": page 0 surfaces it (mirrors the status/
      // shape handling above); later pages stop (partial-page semantics).
      let parsed;
      try {
        parsed = parseMyListings(data);
      } catch (err) {
        if (page === 0) throw err;
        partial = true;
        break;
      }
      for (const l of parsed.listings) {
        const key = l.listingId || `asset:${l.assetId}`;
        if (!seenSell.has(key)) seenSell.set(key, toSellOrder(l));
      }
      collectBuyOrders(data, seenBuy); // the first render page usually carries buy_orders too

      const total = Number(data.total_count);
      if (!truncationWarned && Number.isFinite(total) && total > MAX_PAGES * PAGE) {
        logger.warn(`[${this.username}] market/mylistings has ${total} listings – truncated at ${MAX_PAGES * PAGE}; listed-set is INCOMPLETE`);
        truncationWarned = true;
      }
      const fetched = Array.isArray(data.listings) ? data.listings.length : 0;
      if (fetched < PAGE) break;                              // last (partial) page
      if (Number.isFinite(total) && start + PAGE >= total) break;
    }

    // Buy orders are NOT paginated and may live only on the landing page. If the
    // render payload carried none, fetch the landing page once and read them there.
    if (seenBuy.size === 0) {
      try {
        const { status, data } = await get('https://steamcommunity.com/market/mylistings/?norender=1');
        if (status === 200 && data && typeof data === 'object') collectBuyOrders(data, seenBuy);
        else partial = true; // fetched but non-200 / malformed → buy orders unknown, not "none"
      } catch { partial = true; /* fallback threw → buy orders unknown; the fetch itself never fails over it */ }
    }

    logger.info(`[${this.username}] market orders: ${seenSell.size} sell / ${seenBuy.size} buy${partial ? ' (partial)' : ''}`);
    return { sellOrders: [...seenSell.values()], buyOrders: [...seenBuy.values()], partial };
  }

  /**
   * Cancels ONE active market SELL listing (market/removelisting/<id>). Routes
   * through the account's own cookies + isolated agent. Steam answers 200 on
   * success; a non-200 is surfaced as an error so the UI keeps the row.
   */
  async cancelMarketListing(listingId: string): Promise<void> {
    const cookies = this.session.webSession?.cookies ?? [];
    const sessionid = extractCookie(cookies, 'sessionid');
    if (!sessionid) throw new Error(`[${this.username}] no sessionid cookie – cannot cancel listing`);
    const id = String(listingId).trim();
    if (!id) throw new Error('listingId required');

    const r = await axios.post(
      `https://steamcommunity.com/market/removelisting/${encodeURIComponent(id)}`,
      new URLSearchParams({ sessionid }).toString(),
      {
        httpsAgent:     this.session.httpsAgent,
        proxy:          false,
        timeout:        20_000,
        validateStatus: () => true,
        headers: {
          Cookie:             cookies.join('; '),
          'User-Agent':       MARKET_UA,
          'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
          Origin:             'https://steamcommunity.com',
          Referer:            'https://steamcommunity.com/market/',
          'X-Requested-With': 'XMLHttpRequest',
          Accept:             '*/*',
        },
      });
    if (r.status !== 200) {
      throw new Error(typeof r.data?.message === 'string' ? r.data.message : `removelisting HTTP ${r.status}`);
    }
    logger.info(`[${this.username}] market listing ${id} cancelled`);
  }

  /**
   * Cancels ONE active market BUY order (market/cancelbuyorder/). Steam answers
   * JSON { success: 1 }. A non-success body is surfaced as an error so the UI keeps
   * the row. Routes through the account's own isolated session.
   */
  async cancelBuyOrder(buyOrderId: string): Promise<void> {
    const cookies = this.session.webSession?.cookies ?? [];
    const sessionid = extractCookie(cookies, 'sessionid');
    if (!sessionid) throw new Error(`[${this.username}] no sessionid cookie – cannot cancel buy order`);
    const id = String(buyOrderId).trim();
    if (!id) throw new Error('buyOrderId required');

    const r = await axios.post(
      'https://steamcommunity.com/market/cancelbuyorder/',
      new URLSearchParams({ sessionid, buy_orderid: id }).toString(),
      {
        httpsAgent:     this.session.httpsAgent,
        proxy:          false,
        timeout:        20_000,
        validateStatus: () => true,
        headers: {
          Cookie:             cookies.join('; '),
          'User-Agent':       MARKET_UA,
          'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
          Origin:             'https://steamcommunity.com',
          Referer:            'https://steamcommunity.com/market/',
          'X-Requested-With': 'XMLHttpRequest',
          Accept:             '*/*',
        },
      });
    const ok = r.status === 200 && (r.data?.success === 1 || r.data?.success === true);
    if (!ok) {
      throw new Error(typeof r.data?.message === 'string' ? r.data.message
        : `cancelbuyorder HTTP ${r.status} success=${r.data?.success}`);
    }
    logger.info(`[${this.username}] buy order ${id} cancelled`);
  }

  // ── New feature: Trade Offers (fetch sent + received, act on them) ──────────

  /**
   * Reads this account's FULL set of trade offers — sent AND received — for the
   * global Trade-Offers manager. One WebAPI pass (manager.getOffers, EOfferFilter.All)
   * routed through the bot's own session, so descriptions (item names/icons) come
   * back populated (the manager is built with language:'en'). Each side is returned
   * active-first then newest-first; non-active history is capped so the payload
   * stays bounded for accounts with years of trades. Throws on a hard API failure
   * (dead proxy / not logged in) so the caller can surface a per-account error.
   */
  async getTradeOffers(opts?: { historyLimit?: number }): Promise<TradeOffers> {
    const historyLimit = Math.max(0, opts?.historyLimit ?? 50);
    // Pass an explicit PAST cutoff so Steam includes historical offers on BOTH sides
    // (the lib's default cutoff is one year in the FUTURE). 2-year lookback is plenty.
    const cutoff = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
    const { sent, received } = await new Promise<{ sent: any[]; received: any[] }>((resolve, reject) => {
      this.manager.getOffers(EOfferFilter.All, cutoff, (err: Error | null, s: any[], r: any[]) => {
        if (err) { reject(err); return; }
        resolve({ sent: s ?? [], received: r ?? [] });
      });
    });

    const shapedSent = shapeOffers(sent, historyLimit);
    const shapedReceived = shapeOffers(received, historyLimit);

    // Resolve partner persona names (best-effort) so the UI can show WHO the trade is
    // with rather than a raw SteamID64. One batched request through this bot's client.
    const all = [...shapedSent, ...shapedReceived];
    const names = await this.resolvePersonaNames(all.map((o) => o.partnerSteamId));
    for (const o of all) {
      const n = names.get(o.partnerSteamId);
      if (n) o.partnerName = n;
    }
    return { sent: shapedSent, received: shapedReceived };
  }

  /**
   * Best-effort batch lookup of partner persona names via this bot's logged-in client.
   * Bounded by its own timeout so a slow/never-arriving persona never stalls the whole
   * offers fetch; on any failure it simply resolves what it has (UI falls back to SteamID).
   */
  private resolvePersonaNames(steamIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(steamIds.filter(Boolean))];
    const client = this.session.client as unknown as {
      getPersonas?: (ids: string[], cb: (err: Error | null, personas: Record<string, { player_name?: string }>) => void) => void;
    };
    if (!ids.length || typeof client?.getPersonas !== 'function') return Promise.resolve(out);

    return new Promise<Map<string, string>>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(out); } };
      const timer = setTimeout(finish, 6_000); // never block the fetch on personas
      try {
        client.getPersonas!(ids, (err, personas) => {
          clearTimeout(timer);
          if (!err && personas) {
            for (const [sid, p] of Object.entries(personas)) {
              if (p?.player_name) out.set(sid, String(p.player_name));
            }
          }
          finish();
        });
      } catch { clearTimeout(timer); finish(); }
    });
  }

  /** Fetches one live offer object by id (needed to act on it). */
  private getOfferById(offerId: string): Promise<any> {
    const id = String(offerId).trim();
    if (!id) return Promise.reject(new Error('offerId required'));
    return new Promise((resolve, reject) => {
      this.manager.getOffer(id, (err: Error | null, offer: any) =>
        err ? reject(err) : (offer ? resolve(offer) : reject(new Error(`offer #${id} not found`))));
    });
  }

  /**
   * Cancels (our sent offer) or declines (an incoming offer) ONE trade offer. The
   * underlying steam-tradeoffer-manager call is the same — it picks cancel vs.
   * decline from the offer's `isOurOffer` flag — so a single method covers both.
   */
  async cancelOrDeclineOffer(offerId: string): Promise<void> {
    const offer = await this.getOfferById(offerId);
    await new Promise<void>((resolve, reject) => {
      offer.cancel((err: Error | null) => (err ? reject(err) : resolve()));
    });
    logger.info(`[${this.username}] offer ${offerId} ${offer.isOurOffer ? 'cancelled' : 'declined'}`);
  }

  /**
   * Accepts ONE incoming trade offer. Reuses acceptOffer(), which also clears the
   * mobile 2FA confirmation when the offer has items WE give away (a two-sided swap).
   */
  async acceptTradeOffer(
    offerId: string,
    opts?: { beforeAccept?: (itemsToGive: Array<{ assetid?: string }>) => void },
  ): Promise<'accepted' | 'unconfirmed'> {
    const offer = await this.getOfferById(offerId);
    if (offer.isOurOffer) throw new Error('cannot accept an offer we sent ourselves');
    // Cross-service asset guard hook (D2 / INV-D2): a throw here aborts BEFORE anything is sent
    // (e.g. an item in this offer is busy in another money op — sell/send/craft).
    opts?.beforeAccept?.(Array.isArray(offer.itemsToGive) ? offer.itemsToGive : []);
    const status = await this.acceptOffer(offer);
    logger.info(`[${this.username}] offer ${offerId} accepted${status === 'unconfirmed' ? ' (UNCONFIRMED)' : ''}`);
    return status;
  }

  getTradeUrl(): Promise<string> {
    const manual = this.session.account.tradeUrl?.trim();
    if (manual) return Promise.resolve(manual);
    if (this.tradeUrlCache) return Promise.resolve(this.tradeUrlCache);

    return new Promise((resolve, reject) => {
      this.community.getTradeURL((err, url) => {
        if (err) { reject(err); return; }
        if (!url) { reject(new Error('Steam returned an empty trade URL (Trade-Link disabled on this account?)')); return; }
        this.tradeUrlCache = url;
        resolve(url);
      });
    });
  }

  // ── Feature 3 / 4: create → send → auto-confirm ──────────────────────────

  async sendTrade(params: SendTradeParams): Promise<SendTradeResult> {
    if (!this.cookiesReady) throw new Error(`[${this.username}] trader not ready (no cookies yet)`);
    if (!params.tradeUrl && !params.partnerSteamId) {
      throw new Error('sendTrade requires either tradeUrl or partnerSteamId');
    }

    const offer = this.manager.createOffer(params.tradeUrl ?? params.partnerSteamId!);

    const mine = (params.myItems ?? []).map(toEconItem);
    if (mine.length) offer.addMyItems(mine);
    const theirs = (params.theirItems ?? []).map(toEconItem);
    if (theirs.length) offer.addTheirItems(theirs);
    if (params.message) offer.setMessage(params.message);

    const status = await new Promise<'pending' | 'sent'>((resolve, reject) => {
      offer.send((err, s) => (err ? reject(err) : resolve(s)));
    });
    logger.info(`[${this.username}] offer ${offer.id} sent (status=${status})`);

    if (status === 'pending') {
      // The offer now EXISTS on Steam. A throw past this point would propagate as a
      // retryable 5xx and invite a DUPLICATE real-asset send, so we never rethrow a
      // confirmation failure here — we report it as 'unconfirmed' for manual review
      // (mirrors the buy path's "never throw after placed" money-safety rule).
      try {
        await this.confirmOffer(offer.id, 'sent');
        return { offerId: offer.id, status: 'confirmed' };
      } catch (err) {
        logger.error(
          `[${this.username}] offer ${offer.id} SENT but 2FA confirmation failed ` +
          `(${(err as Error).message}) – left UNCONFIRMED, NOT retrying`,
        );
        return { offerId: offer.id, status: 'unconfirmed' };
      }
    }
    return { offerId: offer.id, status: 'sent' };
  }

  // ── Feature 5: accept an incoming offer (+confirm if we also give items) ──

  async acceptOffer(offer: any): Promise<'accepted' | 'unconfirmed'> {
    await new Promise<void>((resolve, reject) => {
      offer.accept((err: Error | null) => (err ? reject(err) : resolve()));
    });
    // Receiving items never needs a mobile confirmation; only giving does.
    if (Array.isArray(offer.itemsToGive) && offer.itemsToGive.length > 0) {
      // The accept is now COMMITTED on Steam. A throw past this point would propagate as a
      // retryable 5xx and invite a re-run against an already-accepted offer, so we never
      // rethrow a confirmation failure here — we report it as 'unconfirmed' for manual review
      // (mirrors sendTrade's "never throw after committed" money-safety rule).
      try {
        await this.confirmOffer(offer.id, 'accepted');
      } catch (err) {
        logger.error(
          `[${this.username}] offer ${offer.id} ACCEPTED but 2FA confirmation failed ` +
          `(${(err as Error).message}) – left UNCONFIRMED, NOT retrying`,
        );
        return 'unconfirmed';
      }
    }
    return 'accepted';
  }

  // ── Mobile 2FA confirmation via identity_secret ──────────────────────────

  async confirmOffer(offerId: string, kind: 'sent' | 'accepted'): Promise<void> {
    // Route through the bounded retry+backoff wrapper: Steam's mobile-conf servers
    // return transient 5xx under load, and a single un-retried failure would strand
    // a sent-but-unconfirmed offer (it previously called the lib method exactly once).
    try {
      await this.acceptConfirmationForObject(offerId, `trade ${offerId}`);
    } catch (err) {
      // The retry loop exhausted. But if attempt 1's ajaxop LANDED on Steam and only
      // its response was lost (timeout/RST on the response leg), attempts 2–4 find no
      // confirmation for the object and we throw — even though the offer is already
      // cleared. Disambiguate via the offer's state before propagating a status lie.
      let cleared = false;
      let state: number | undefined;
      try {
        const offer = await this.getOfferById(offerId);
        state = Number(offer?.state);
        // A sent offer whose confirmation cleared leaves CreatedNeedsConfirmation (9)
        // for Active (2)/Accepted (3); an accept-side confirmation still pending leaves
        // the offer Active (2), so the accepted path only trusts Accepted (3).
        cleared = kind === 'sent'
          ? state !== Number(ETradeOfferState.CreatedNeedsConfirmation)
          : state === Number(ETradeOfferState.Accepted);
      } catch {
        // The state probe itself failed — the outcome is unproven, so surface the
        // ORIGINAL confirmation error (never claim success on an unprovable state).
      }
      if (!cleared) throw err;
      logger.info(`[${this.username}] trade ${offerId} verified cleared via offer state (${state}) after a lost-response confirmation`);
      return;
    }
    logger.info(`[${this.username}] trade ${offerId} auto-confirmed via 2FA`);
  }

  // ── v2.3 Feature 4: list an item on the Steam Community Market ─────────────

  /**
   * Creates a market sell listing for one asset. `netCents` is the amount the
   * SELLER receives (Steam's market/sellitem `price` parameter) in the account's
   * wallet currency. Goes through the account's OWN cookies + isolated agent.
   * The listing still needs a mobile confirmation (see confirmMarketListings()).
   */
  async sellOnMarket(assetId: string, netCents: number): Promise<SellOnMarketResult> {
    const cookies = this.session.webSession?.cookies ?? [];
    const sessionid = extractCookie(cookies, 'sessionid');
    if (!sessionid) throw new Error(`[${this.username}] no sessionid cookie – cannot list`);
    if (!Number.isFinite(netCents) || netCents < 1) throw new Error('invalid net price');

    const form = new URLSearchParams({
      sessionid,
      appid:     String(CS2_APPID),
      contextid: CS2_CONTEXTID,
      assetid:   assetId,
      amount:    '1',
      price:     String(Math.round(netCents)),
    });

    const r = await axios.post('https://steamcommunity.com/market/sellitem/', form.toString(), {
      httpsAgent:     this.session.httpsAgent,
      proxy:          false, // per-account isolation: ignore env-var proxies
      timeout:        20_000,
      validateStatus: () => true,
      headers: {
        Cookie:             cookies.join('; '),
        'User-Agent':       MARKET_UA,
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        Origin:             'https://steamcommunity.com',
        Referer:            `https://steamcommunity.com/profiles/${this.session.steamId}/inventory`,
        'X-Requested-With': 'XMLHttpRequest',
        Accept:             '*/*',
      },
    });

    if (r.status !== 200) throw new Error(`market/sellitem HTTP ${r.status}`);
    const d = r.data;
    if (!d || d.success !== true) {
      throw new Error(typeof d?.message === 'string' ? d.message : 'market listing rejected by Steam');
    }
    return { needsConfirmation: !!(d.needs_mobile_confirmation || d.requires_confirmation) };
  }

  // ── v1.0.2 Feature: place a Steam Community Market BUY ORDER ───────────────

  /**
   * Places a market buy order for `quantity` of a market_hash_name at
   * `pricePerItemMinor` (the account's wallet-currency minor units; price_total =
   * perItem × quantity – Steam wants the TOTAL). Critically uses MULTIPART
   * form-data: Steam's /market/createbuyorder/ endpoint rejects urlencoded posts.
   * Routes through the account's isolated agent + community cookies
   * (steamLoginSecure + sessionid). On `need_confirmation` (HTTP 406 / success 22)
   * it accepts the mobile 2FA confirmation via identity_secret and RE-SUBMITS with
   * the confirmation/creator id so the order becomes active. The returned result
   * is advisory — the CALLER verifies the real outcome via the inventory/wallet
   * diff (a "success-ish" body is not proof of a fill).
   */
  async createBuyOrder(p: {
    marketHashName: string; appId: number; currency: number;
    pricePerItemMinor: number; quantity: number; billing?: BuyBilling;
    /** OPT-IN: after accepting the confirmation, re-POST createbuyorder with
     *  confirmation=<creator> (FarmManager flow). Default off — see the branch. */
    retryAfterConfirm?: boolean;
  }): Promise<BuyOrderResult> {
    const cookies = this.session.webSession?.cookies ?? [];
    const sessionid = extractCookie(cookies, 'sessionid');
    if (!sessionid) throw new Error(`[${this.username}] no sessionid cookie – cannot place buy order`);
    if (!extractCookie(cookies, 'steamLoginSecure')) {
      throw new Error(`[${this.username}] no steamLoginSecure cookie – community session not authenticated`);
    }
    const qty = Math.max(1, Math.floor(p.quantity));
    const perItem = Math.round(p.pricePerItemMinor);
    if (!Number.isFinite(perItem) || perItem < 1) throw new Error('invalid buy price (minor units must be ≥ 1)');
    const priceTotal = perItem * qty; // Steam wants the TOTAL order value, not per item
    // Billing: use what the caller passed, else generate a format-valid RANDOM
    // profile per request (anti-fingerprinting; empty fields trip the gate).
    const billing = p.billing ?? generateBilling();

    const post = (confirmation: string): Promise<{ status: number; data: any }> => {
      const { body, contentType } = buildMultipart({
        sessionid,
        currency:            String(p.currency),
        appid:               String(p.appId),
        market_hash_name:    p.marketHashName,
        price_total:         String(priceTotal),
        quantity:            String(qty),
        tradefee_tax:        '0',
        // Steam requires a valid billing address; empty fields trip the
        // need_confirmation gate. Values come from the (per-request random) profile.
        first_name:          billing.firstName  ?? '',
        last_name:           billing.lastName    ?? '',
        billing_address:     billing.address     ?? '',
        billing_address_two: billing.addressTwo  ?? '',
        billing_city:        billing.city        ?? '',
        billing_country:     billing.country     ?? '',
        billing_state:       billing.state       ?? '',
        billing_postal_code: billing.postalCode  ?? '',
        save_my_address:     billing.save ? '1' : '0',
        confirmation,
      });
      return axios.post('https://steamcommunity.com/market/createbuyorder/', body, {
        httpsAgent:     this.session.httpsAgent,
        proxy:          false, // per-account isolation: ignore env-var proxies
        timeout:        20_000,
        validateStatus: () => true,
        headers: {
          Cookie:             cookies.join('; '),
          'User-Agent':       MARKET_UA,
          'Content-Type':     contentType,
          Origin:             'https://steamcommunity.com',
          Referer:            `https://steamcommunity.com/market/listings/${p.appId}/${encodeURIComponent(p.marketHashName)}`,
          'X-Requested-With': 'XMLHttpRequest',
          Accept:             '*/*',
        },
      }).then((r) => ({ status: r.status, data: r.data }));
    };

    // Phantom-order recovery: on a NETWORK error we cannot know whether the create
    // reached Steam. Probe the account's resting buy orders for one matching THIS exact
    // request (game+item+price); a match means the create landed → report it placed so
    // no blind retry ever doubles the order. Best-effort (a failed probe returns none).
    const probeResting = async (): Promise<BuyOrderResult | undefined> => {
      try {
        const orders = await this.getMarketOrders();
        const match = matchRestingBuyOrder(orders.buyOrders, {
          appId: p.appId, marketHashName: p.marketHashName, perItemMinor: perItem,
        });
        if (match) {
          logger.warn(`[${this.username}] createbuyorder network error, but a matching resting buy order ${match.buyOrderId} EXISTS – reporting placed (NOT retryable) to prevent a duplicate order`);
          return { placed: true, confirmed: true, needsConfirmation: false, buyOrderId: match.buyOrderId, raw: { recovered: true } };
        }
      } catch (e) {
        logger.warn(`[${this.username}] phantom buy-order probe failed: ${(e as Error).message}`);
      }
      return undefined;
    };

    // 1) Initial create (confirmation=0). validateStatus:() => true means axios only
    //    throws on a NETWORK/timeout error here — an HTTP rejection returns a status.
    let status: number, data: any;
    try {
      ({ status, data } = await post('0'));
    } catch (err) {
      // Network/timeout before we learned the outcome: the order MIGHT exist. Probe;
      // if found, report placed. Otherwise surface an EXPLICIT verify-before-retry
      // signal (never a bare retryable fault) so the operator confirms before re-buying.
      const recovered = await probeResting();
      if (recovered) return recovered;
      const e = Object.assign(
        new Error(`createbuyorder network error – order state UNKNOWN, verify open orders before retrying (${(err as Error).message})`),
        { verifyBeforeRetry: true },
      );
      throw e;
    }
    logger.info(`[${this.username}] createbuyorder ${p.marketHashName} x${qty} total=${priceTotal} cur=${p.currency} → HTTP ${status} success=${data?.success}`);

    // A returned 5xx is a Steam-EDGE failure (validateStatus:() => true means it did NOT
    // throw): the create MIGHT have executed before the upstream answer was lost — the same
    // response-leg-lost case as the network throw above, just with a status instead of an
    // ECONNRESET. Probe for a matching resting order; if found, report placed. Otherwise
    // surface the EXPLICIT verify-before-retry signal so the operator confirms before re-buying.
    if (status >= 500) {
      const recovered = await probeResting();
      if (recovered) return recovered;
      throw Object.assign(
        new Error(`createbuyorder HTTP ${status} – order state UNKNOWN, verify open orders before retrying`),
        { verifyBeforeRetry: true },
      );
    }

    // Active immediately (no confirmation required).
    if (status === 200 && data && data.success === 1) {
      return {
        placed: true, confirmed: true, needsConfirmation: false,
        buyOrderId: data.buy_orderid != null ? String(data.buy_orderid) : undefined, raw: data,
      };
    }

    // 2) Needs mobile confirmation. CRITICAL: the create POST above ALREADY made
    //    the (pending) order on Steam's side. createbuyorder is a non-idempotent
    //    CREATE endpoint, so we must NEVER POST it again — a second POST = a
    //    SECOND real-money order. We only accept the pending mobile confirmation
    //    ONCE (that activates the order POST #1 created); we do NOT re-create.
    const needsConf = !!(data?.need_confirmation || data?.success === 22);
    const confId = data?.confirmation?.confirmation_id;
    if (needsConf) {
      if (!confId) {
        logger.warn(`[${this.username}] buy order pending but no confirmation_id in response – left pending (NOT re-created)`);
        return { placed: true, confirmed: false, needsConfirmation: true, raw: data };
      }
      logger.info(`[${this.username}] buy order needs mobile confirmation (${confId}) – accepting via 2FA…`);
      let creator: string | undefined;
      let lastConfErr: unknown;
      const MAX_CONF_ATTEMPTS = 12; // a just-created confirmation can take a few s to surface
      for (let attempt = 0; attempt < MAX_CONF_ATTEMPTS; attempt++) {
        await sleep(attempt === 0 ? 2_000 : 2_500);
        try {
          creator = await this.acceptBuyConfirmation(String(confId));
          if (creator !== undefined) break; // matched + accepted
          logger.info(`[${this.username}] confirmation not visible yet (attempt ${attempt + 1}/${MAX_CONF_ATTEMPTS}) – polling…`);
        } catch (e) {
          lastConfErr = e;
          logger.warn(`[${this.username}] buy confirm attempt ${attempt + 1}/${MAX_CONF_ATTEMPTS}: ${(e as Error).message}`);
        }
      }
      if (creator !== undefined) {
        logger.info(`[${this.username}] buy order ${creator} confirmed via 2FA`);
        // The FINALIZE step (default ON via the API): after approving the type-12
        // confirmation, re-POST createbuyorder WITH confirmation=<creator>. This
        // turns success:22 → success:1 and ACTIVATES the order — proven live (1 key
        // bought, 1 charge, NO duplicate: the confirmation param ties it to the
        // order POST #1 created, it does not make a second one). Bounded to exactly
        // ONE extra POST, behind the per-account in-flight lock + inventory/wallet
        // verification as backstops.
        if (p.retryAfterConfirm) {
          logger.info(`[${this.username}] re-POST createbuyorder with confirmation=${creator} (opt-in spec step)…`);
          // The order was CREATED by POST '0' (success:22) and its mobile confirmation
          // was ACCEPTED above, so it is already placed+confirmed. The re-POST is only
          // an activation nudge (success:22 → success:1). A NETWORK failure here must
          // NEVER rethrow: that would escape buy()'s never-throw-after-placed barrier
          // and get the run classified as a retryable 502 → a duplicate-order retry.
          let re: { status: number; data: any };
          try {
            re = await post(creator);
          } catch (err) {
            logger.warn(`[${this.username}] finalize re-POST network error after the order was created+confirmed (${(err as Error).message}) – reporting placed+confirmed, NOT re-created`);
            return { placed: true, confirmed: true, needsConfirmation: false, buyOrderId: creator, raw: { finalizeRepostFailed: true } };
          }
          logger.info(`[${this.username}] createbuyorder re-POST → HTTP ${re.status} success=${re.data?.success}`);
          if (re.status === 200 && re.data?.success === 1) {
            return { placed: true, confirmed: true, needsConfirmation: false,
              buyOrderId: re.data.buy_orderid != null ? String(re.data.buy_orderid) : creator, raw: re.data };
          }
          const stillNeeds = !!(re.data?.need_confirmation || re.data?.success === 22);
          // #44: report consistent flags — if Steam STILL needs a confirmation after the
          // re-POST, we did NOT fully confirm, so confirmed=false (was true → contradictory
          // confirmed+needsConfirmation, making the UI lie). The re-POST itself is unchanged.
          return { placed: true, confirmed: !stillNeeds, needsConfirmation: stillNeeds, buyOrderId: creator, raw: re.data };
        }
        return { placed: true, confirmed: true, needsConfirmation: false, buyOrderId: creator, raw: data };
      }
      // Could not match/clear the confirmation → the order exists but is unconfirmed.
      // Do NOT re-POST (that would duplicate the order). Surface it for manual review.
      logger.warn(`[${this.username}] buy order confirmation NOT cleared (${(lastConfErr as Error | undefined)?.message ?? 'no matching confirmation'}) – left pending, NOT re-created`);
      return { placed: true, confirmed: false, needsConfirmation: true, buyOrderId: String(confId), raw: data };
    }

    // Anything else is a genuine rejection.
    throw new Error(typeof data?.message === 'string' ? data.message
      : `createbuyorder rejected (HTTP ${status}, success=${data?.success})`);
  }

  /**
   * Accepts the pending mobile confirmation for a freshly-created buy order and
   * returns its `creator` (= the Steam buy_orderid). Matches the createbuyorder
   * confirmation_id against BOTH conf.id AND conf.creator (Steam maps it to the
   * creator/buy_orderid, not always the id). Still strict to THAT id — NO "newest"
   * fallback, so an unrelated sell-listing confirmation is never auto-accepted.
   * getConfirmations + respond(allow) sign the getlist/ajaxop calls via
   * identity_secret. Returns undefined when no matching confirmation is found.
   */
  private acceptBuyConfirmation(confirmationId: string): Promise<string | undefined> {
    const identitySecret = this.session.maFile?.identity_secret;
    if (!identitySecret) {
      return Promise.reject(new Error(`[${this.username}] no identity_secret – cannot confirm buy order`));
    }
    const community = this.community as unknown as {
      getConfirmations(time: number, key: { tag: string; key: string }, cb: (err: Error | null, confs: any[]) => void): void;
    };
    return new Promise<string | undefined>((resolve, reject) => {
      SteamTotp.getTimeOffset((offErr, offset) => {
        const off = offErr ? 0 : offset;
        const time = SteamTotp.time(off);
        const listKey = SteamTotp.getConfirmationKey(identitySecret, time, 'list');
        community.getConfirmations(time, { tag: 'list', key: listKey }, (err, confs) => {
          if (err) { reject(err); return; }
          const list = confs ?? [];
          // DIAGNOSTIC: log exactly what Steam returned so we can SEE whether the
          // confirmation is present and which field carries the createbuyorder id.
          logger.info(`[${this.username}] mobileconf getlist → ${list.length} pending: ` +
            (list.map((c) => `{id=${c?.id} creator=${c?.creator} type=${c?.type}}`).join(', ') || '(none)'));
          // Steam maps createbuyorder's confirmation_id to the confirmation's
          // CREATOR (the buy_orderid) — NOT always its id. Match BOTH. Still strict
          // to THIS id (no "newest" fallback), so a sell-listing conf is never grabbed.
          const conf = list.find((c) =>
            String(c?.id) === String(confirmationId) || String(c?.creator) === String(confirmationId));
          if (!conf) { resolve(undefined); return; }
          const creator = conf.creator != null ? String(conf.creator) : undefined;
          logger.info(`[${this.username}] matched buy confirmation id=${conf.id} creator=${creator} – accepting…`);
          const t = SteamTotp.time(off) + 1;
          const acceptKey = SteamTotp.getConfirmationKey(identitySecret, t, 'accept');
          conf.respond(t, { tag: 'accept', key: acceptKey }, true, (rErr: Error | null) =>
            rErr ? reject(rErr) : resolve(creator));
        });
      });
    });
  }

  /**
   * Accepts a pending Steam MOBILE confirmation for a specific object (a buy
   * order / market / trade confirmation id) using the maFile identity_secret.
   * Retries a few times because a just-created confirmation can take a moment to
   * register on Steam's side. This is what auto-confirms market BUYS.
   */
  private acceptConfirmationForObject(objectId: string, label: string): Promise<void> {
    const identitySecret = this.session.maFile?.identity_secret;
    if (!identitySecret) {
      return Promise.reject(new Error(`[${this.username}] no identity_secret in the maFile – ${label} cannot be confirmed`));
    }
    const community = this.community as unknown as {
      acceptConfirmationForObject(identitySecret: string, objectId: string, cb: (err: Error | null) => void): void;
    };
    const tryOnce = (): Promise<void> => new Promise<void>((resolve, reject) => {
      community.acceptConfirmationForObject(identitySecret, objectId, (err) => (err ? reject(err) : resolve()));
    });
    return (async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(attempt === 0 ? 1_500 : 3_000); // give the confirmation time to register
        try { await tryOnce(); return; }
        catch (err) {
          lastErr = err;
          logger.warn(`[${this.username}] ${label} 2FA confirmation attempt ${attempt + 1}/4 failed: ${(err as Error).message}`);
        }
      }
      throw new Error(`${label}: 2FA confirmation failed after retries (${(lastErr as Error)?.message ?? lastErr})`);
    })();
  }

  /**
   * Confirms ALL pending market-listing mobile confirmations for this account in
   * one pass (trade confirmations are deliberately left untouched). Resolves with
   * { confirmed } — the number of listings confirmed. Mirrors steamcommunity's
   * per-object confirm but filters to ConfirmationType.MarketListing so a batch of
   * sells is cleared at once. A mid-pass respond failure resolves { confirmed, error }
   * (the count of listings confirmed BEFORE the failure is preserved, so the caller's
   * retry accumulates honestly); only a getConfirmations failure — where nothing was
   * counted — rejects.
   */
  confirmMarketListings(): Promise<{ confirmed: number; error?: Error }> {
    const identitySecret = this.session.maFile?.identity_secret;
    if (!identitySecret) {
      return Promise.reject(new Error(`[${this.username}] no identity_secret – cannot confirm market listings`));
    }
    const community = this.community as unknown as {
      getConfirmations(time: number, key: { tag: string; key: string }, cb: (err: Error | null, confs: any[]) => void): void;
    };

    return new Promise<{ confirmed: number; error?: Error }>((resolve, reject) => {
      SteamTotp.getTimeOffset((offErr, offset) => {
        const off = offErr ? 0 : offset;
        const time = SteamTotp.time(off);
        const listKey = SteamTotp.getConfirmationKey(identitySecret, time, 'list');
        community.getConfirmations(time, { tag: 'list', key: listKey }, (err, confs) => {
          if (err) { reject(err); return; }
          const listings = (confs ?? []).filter(c => c?.type === CONF_TYPE_MARKET_LISTING);
          if (listings.length === 0) { resolve({ confirmed: 0 }); return; }

          let idx = 0, confirmed = 0;
          let firstErr: Error | null = null;
          let prevT = 0;
          const next = (): void => {
            if (idx >= listings.length) {
              // A mid-pass respond failure still resolves with the count confirmed
              // before it, so confirmWithRetry accumulates across attempts.
              resolve(firstErr ? { confirmed, error: firstErr } : { confirmed });
              return;
            }
            const conf = listings[idx++];
            // Monotonic-fresh time: strictly unique AND increasing per accept, but
            // bounded to ≤1s beyond real server time for any batch size — a fresh
            // base plus a running index would sign the Nth accept N seconds in the
            // future, risking rejection once outside Steam's tolerance at 200-500 listings.
            const t = Math.max(SteamTotp.time(off), prevT + 1); prevT = t;
            const acceptKey = SteamTotp.getConfirmationKey(identitySecret, t, 'accept');
            conf.respond(t, { tag: 'accept', key: acceptKey }, true, (rErr: Error | null) => {
              if (rErr) { if (!firstErr) firstErr = rErr; }
              else confirmed++;
              next();
            });
          };
          next();
        });
      });
    });
  }

  /**
   * SDA panel — list this account's pending mobile confirmations (trade + market).
   * REUSES the canonical primitive confirmMarketListings uses: getConfirmations(time,
   * {tag:'list', key}) keyed off identity_secret + Steam server time, then shapes the
   * result (dedup/order). One source of truth, no new parser. (Phase-6 Feature B.)
   */
  listConfirmations(): Promise<ConfirmationView[]> {
    const identitySecret = this.session.maFile?.identity_secret;
    if (!identitySecret) {
      return Promise.reject(new Error(`[${this.username}] no identity_secret in the maFile – cannot list confirmations`));
    }
    const community = this.community as unknown as {
      getConfirmations(time: number, key: { tag: string; key: string }, cb: (err: Error | null, confs: any[]) => void): void;
    };
    return new Promise<ConfirmationView[]>((resolve, reject) => {
      SteamTotp.getTimeOffset((offErr, offset) => {
        const off = offErr ? 0 : offset;
        const time = SteamTotp.time(off);
        const listKey = SteamTotp.getConfirmationKey(identitySecret, time, 'list');
        community.getConfirmations(time, { tag: 'list', key: listKey }, (err, confs) => {
          if (err) { reject(err); return; }
          resolve(shapeConfirmations(confs));
        });
      });
    });
  }

  /**
   * Approve (accept=true) / deny (accept=false) confirmations. Re-fetches the LIVE list
   * from the canonical source and responds to the matching ones via conf.respond(...) —
   * the SAME accept primitive confirmMarketListings uses. `all=true` actions every pending
   * confirmation. Returns counts so the caller can refresh from truth. (Feature B.)
   */
  respondToConfirmations(ids: string[], accept: boolean, all = false): Promise<{ done: number; failed: string[] }> {
    const identitySecret = this.session.maFile?.identity_secret;
    if (!identitySecret) {
      return Promise.reject(new Error(`[${this.username}] no identity_secret – cannot respond to confirmations`));
    }
    const community = this.community as unknown as {
      getConfirmations(time: number, key: { tag: string; key: string }, cb: (err: Error | null, confs: any[]) => void): void;
    };
    const wanted = new Set(ids.map(String));
    return new Promise((resolve, reject) => {
      SteamTotp.getTimeOffset((offErr, offset) => {
        const off = offErr ? 0 : offset;
        const time = SteamTotp.time(off);
        const listKey = SteamTotp.getConfirmationKey(identitySecret, time, 'list');
        community.getConfirmations(time, { tag: 'list', key: listKey }, (err, confs) => {
          if (err) { reject(err); return; }
          const targets = (confs ?? []).filter((c: any) => all || wanted.has(String(c?.id)));
          if (targets.length === 0) { resolve({ done: 0, failed: [] }); return; }
          const tag = accept ? 'accept' : 'reject';
          let idx = 0, done = 0; const failed: string[] = [];
          let prevT = 0;
          const next = (): void => {
            if (idx >= targets.length) { resolve({ done, failed }); return; }
            const conf = targets[idx++];
            // Monotonic-fresh time: unique + increasing per response, bounded to ≤1s
            // beyond real time (a fresh base + running index would sign the tail of an
            // "action all" batch far in the future and risk key rejection at scale).
            const t = Math.max(SteamTotp.time(off), prevT + 1); prevT = t;   // unique time per response
            const key = SteamTotp.getConfirmationKey(identitySecret, t, tag);
            conf.respond(t, { tag, key }, accept, (rErr: Error | null) => {
              if (rErr) failed.push(String(conf?.id)); else done++;
              next();
            });
          };
          next();
        });
      });
    });
  }

  shutdown(): void {
    try { this.manager.shutdown(); } catch { /* noop */ }
  }
}

/** Random capitalized letter string of length min..max. */
function randLetters(min: number, max: number): string {
  const n = min + Math.floor(Math.random() * (max - min + 1));
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format-valid RANDOM billing for a market buy order. Steam only needs non-empty,
 *  format-correct fields (a digital order – the address isn't validated against
 *  reality); randomizing per request avoids fingerprinting many bots with one
 *  static address. Postal code = exactly 5 digits. */
function generateBilling(country = 'DE'): BuyBilling {
  let zip = '';
  for (let i = 0; i < 5; i++) zip += Math.floor(Math.random() * 10);
  return {
    firstName:  randLetters(5, 8),
    lastName:   randLetters(5, 8),
    address:    `${randLetters(5, 8)} ${1 + Math.floor(Math.random() * 98)}`,
    addressTwo: '',
    city:       randLetters(6, 10),
    state:      '',
    country,
    postalCode: zip,
    save:       true,
  };
}

/** Builds a browser-style multipart/form-data body for a flat field map. Steam's
 *  /market/createbuyorder/ endpoint requires multipart (urlencoded is rejected). */
function buildMultipart(fields: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = '----SSIMFormBoundary' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  let s = '';
  for (const [k, v] of Object.entries(fields)) {
    s += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  s += `--${boundary}--\r\n`;
  return { body: Buffer.from(s, 'utf8'), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Reads a single cookie value out of a ["name=value", …] cookie array. */
function extractCookie(cookies: string[], name: string): string | undefined {
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq !== -1 && c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  return undefined;
}

/** Maps a TradeItemRef to the econ-item shape steam-tradeoffer-manager expects, carrying the
 *  item's REAL app/context so an offer can mix any Steam game (TF2 440, CS2 730, …). The
 *  appId/contextId default to CS2 only when the caller omits them (older single-app callers).
 *  Exported for unit tests (the app-agnostic-send guarantee). */
export function toEconItem(ref: TradeItemRef): { assetid: string; appid: number; contextid: string; amount: number } {
  return {
    assetid:   ref.assetId,
    appid:     ref.appId ?? CS2_APPID,
    contextid: ref.contextId ?? CS2_CONTEXTID,
    amount:    1,
  };
}

// ── Trade-offer normalization helpers ─────────────────────────────────────────

/** A trade offer is "active" while it still awaits action (or is held in escrow). */
function isActiveOfferState(state: number): boolean {
  return state === ETradeOfferState.Active
      || state === ETradeOfferState.CreatedNeedsConfirmation
      || state === ETradeOfferState.InEscrow;
}

/** Maps a raw econ item from a trade offer into our flat TradeOfferItem. */
function toOfferItem(it: any): TradeOfferItem {
  const icon = it?.icon_url_large ?? it?.icon_url ?? '';
  return {
    appId:          Number(it?.appid) || 0,
    contextId:      String(it?.contextid ?? ''),
    assetId:        String(it?.assetid ?? it?.id ?? ''),
    classId:        it?.classid != null ? String(it.classid) : undefined,
    amount:         Number(it?.amount) || 1,
    name:           it?.name ?? it?.market_hash_name ?? 'Unknown',
    marketHashName: it?.market_hash_name ?? it?.market_name ?? it?.name ?? '',
    iconUrl:        icon ? IMG_BASE + icon : '',
  };
}

/** Maps a raw steam-tradeoffer-manager TradeOffer into our normalized view. */
function toOfferView(o: any): TradeOfferView {
  const state = Number(o?.state) || 0;
  const iso = (d: unknown): string | undefined => (d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : undefined);
  return {
    offerId:        String(o?.id ?? ''),
    partnerSteamId: o?.partner?.getSteamID64?.() ?? String(o?.partner ?? ''),
    message:        typeof o?.message === 'string' ? o.message : '',
    state,
    stateName:      String(ETradeOfferState[state] ?? state),
    isOurOffer:     !!o?.isOurOffer,
    active:         isActiveOfferState(state),
    createdAt:      iso(o?.created),
    updatedAt:      iso(o?.updated),
    expiresAt:      iso(o?.expires),
    escrowEndsAt:   iso(o?.escrowEnds),
    itemsToGive:    Array.isArray(o?.itemsToGive)    ? o.itemsToGive.map(toOfferItem)    : [],
    itemsToReceive: Array.isArray(o?.itemsToReceive) ? o.itemsToReceive.map(toOfferItem) : [],
  };
}

/**
 * Normalizes one side's raw offers: active offers come first (newest-first),
 * followed by up to `historyLimit` of the most-recent non-active (history) offers.
 */
function shapeOffers(offers: any[], historyLimit: number): TradeOfferView[] {
  const active: TradeOfferView[] = [];
  const history: TradeOfferView[] = [];
  for (const raw of offers) {
    const v = toOfferView(raw);
    if (!v.offerId) continue;
    (v.active ? active : history).push(v);
  }
  const recency = (v: TradeOfferView): number =>
    Date.parse(v.updatedAt ?? v.createdAt ?? '') || 0;
  const byNewest = (a: TradeOfferView, b: TradeOfferView): number => recency(b) - recency(a);
  active.sort(byNewest);
  history.sort(byNewest);
  return [...active, ...history.slice(0, historyLimit)];
}

/** Projects one canonical MarketListing into an Active-Orders sell row. The parse
 *  itself now lives in MarketModel.parseMyListings (one parser, shared with the
 *  inventory "Listed" bucket and the mass-sell pre-flight). */
function toSellOrder(l: MarketListing): ActiveSellOrder {
  return {
    listingId:         l.listingId,
    assetId:           l.assetId,
    appId:             l.appId,
    marketHashName:    l.marketHashName,
    name:              l.name,
    iconUrl:           l.iconUrl,
    pricePerItemMinor: l.pricePerItemMinor,
    currency:          l.currency,
    quantity:          l.quantity,
  };
}

/**
 * Finds a resting buy order that matches a createbuyorder request EXACTLY (same game,
 * item, and per-item price in minor units). Used to recover from a network error on
 * the create POST: if a matching order already rests, the create landed and must NOT
 * be retried (that would double-order). Price match is what makes a stale pre-existing
 * order at a DIFFERENT price not count as "this create landed".
 */
export function matchRestingBuyOrder(
  buyOrders: ActiveBuyOrder[],
  req: { appId: number; marketHashName: string; perItemMinor: number },
): ActiveBuyOrder | undefined {
  return buyOrders.find(o =>
    o.appId === req.appId &&
    o.marketHashName === req.marketHashName &&
    o.pricePerItemMinor === req.perItemMinor);
}

/** Parses resting BUY orders out of a market/mylistings payload into `out` (deduped by id). */
function collectBuyOrders(d: any, out: Map<string, ActiveBuyOrder>): void {
  const orders: any[] = Array.isArray(d?.buy_orders) ? d.buy_orders : [];
  for (const b of orders) {
    const buyOrderId = b?.buy_orderid != null ? String(b.buy_orderid) : '';
    if (!buyOrderId || out.has(buyOrderId)) continue;
    const desc = b?.description ?? {};
    const appId = Number(b?.appid ?? desc.appid) || 0;
    const icon = desc.icon_url_large ?? desc.icon_url ?? '';
    out.set(buyOrderId, {
      buyOrderId, appId,
      marketHashName:    b?.hash_name ?? desc.market_hash_name ?? desc.name ?? 'Unknown',
      name:              desc.name ?? b?.hash_name ?? 'Unknown',
      iconUrl:           icon ? IMG_BASE + icon : '',
      pricePerItemMinor: Number(b?.price) || 0, // per single item, minor units
      currency:          Number(b?.wallet_currency) || 0,
      quantity:          Number(b?.quantity) || 0,
      quantityRemaining: Number(b?.quantity_remaining ?? b?.quantity) || 0,
    });
  }
}
