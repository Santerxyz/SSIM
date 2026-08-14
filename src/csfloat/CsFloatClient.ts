import axios, { type AxiosInstance, type AxiosError, type AxiosRequestConfig } from 'axios';
import type { HttpAgent } from '../network/AgentFactory';
import { RateLimiter } from './RateLimiter';

// ════════════════════════════════════════════════════════════════════════════
//  CsFloatClient — typed client for one CSFloat account's API key (Feature 2).
//
//  Base: https://csfloat.com/api/v1 · Auth: raw key in the Authorization header.
//  Requests route through the account's per-account httpsAgent (proxy/IP isolation)
//  and a conservative RateLimiter; 429s back off and are surfaced (never dropped).
//
//  DOCUMENTED (stable): searchListings, getListing, createListing.
//  UNDOCUMENTED (reverse-engineered from the CSFloat web app + community clients;
//  paths/response shapes may change without notice → verify against a live key):
//  me, myListings, delistListing, editListingPrice, buyListing, buy-orders, trades,
//  inventory. The service layer gates the deepest of these behind a feature flag.
// ════════════════════════════════════════════════════════════════════════════

const BASE_URL = 'https://csfloat.com/api/v1';
const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });

export class CsFloatError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = 'CsFloatError';
  }
}

/** S45: internal sentinel — a 429 whose backoff must happen OUTSIDE the limiter's single-flight slot.
 *  Never surfaced to callers (the .catch in req() consumes it and re-schedules). */
class RateLimitRetry extends Error {}

export interface ListingSearchParams {
  cursor?:           string;
  limit?:            number;   // CSFloat caps at 50
  sort_by?:          string;   // lowest_price | highest_price | most_recent | lowest_float | highest_float | best_deal | expires_soon
  category?:         number;   // 0 any · 1 normal · 2 stattrak · 3 souvenir
  def_index?:        number | number[];
  min_float?:        number;
  max_float?:        number;
  rarity?:           number;
  paint_seed?:       number;
  paint_index?:      number;
  min_price?:        number;   // cents
  max_price?:        number;   // cents
  market_hash_name?: string;
  type?:             'buy_now' | 'auction';
  collection?:       string;
}

export interface CreateListingBody {
  asset_id:            string;
  type?:               'buy_now' | 'auction';
  price?:              number;  // cents (buy_now)
  max_offer_discount?: number;  // basis points
  reserve_price?:      number;  // cents (auction)
  duration_days?:      number;
  description?:        string;
  private?:            boolean;
}

export interface CreateBuyOrderBody {
  market_hash_name?: string;
  expression?:       string;
  max_price:         number;    // cents
  quantity:          number;
}

/** One row of the bulk /listings/price-list catalog. `min_price` is the lowest buy-now ask in cents. */
export interface PriceListRow {
  market_hash_name: string;
  quantity?:        number;
  min_price?:       number;   // cents
}

type Dict = Record<string, unknown>;

export class CsFloatClient {
  // CSFloat rate-limits per API key (and IP), so every client built from the same key shares one
  // limiter — interactive tabs + the background pricing fill can't independently double the rate.
  private static readonly limiters = new Map<string, RateLimiter>();
  private static limiterFor(apiKey: string): RateLimiter {
    let lim = this.limiters.get(apiKey);
    if (!lim) { lim = new RateLimiter(1, 600); this.limiters.set(apiKey, lim); } // single-flight, ~1.5 req/s — conservative
    return lim;
  }
  /** Drop the shared limiter for a key no live account holds any more, so the static cache does not
   *  retain a dead RateLimiter (and the raw key string) for the process lifetime. A key that later
   *  returns just gets a fresh limiter via limiterFor — create-on-miss is unchanged. */
  static releaseLimiter(apiKey: string): void { this.limiters.delete(apiKey); }

  private readonly http: AxiosInstance;
  private readonly limiter: RateLimiter;
  private readonly priority: number;

  /** opts.priority < 0 marks a background client (the app-wide pricing fill) so its requests
   *  yield to interactive tab traffic sharing the same key's limiter. */
  constructor(apiKey: string, httpsAgent?: HttpAgent, opts: { priority?: number } = {}) {
    this.limiter = CsFloatClient.limiterFor(apiKey);
    this.priority = opts.priority ?? 0;
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 20_000,
      httpsAgent,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      validateStatus: () => true, // we inspect status ourselves for clean error messages
    });
  }

  // ── DOCUMENTED endpoints (stable) ───────────────────────────────────────────
  searchListings(params: ListingSearchParams = {}): Promise<{ data: Dict[]; cursor?: string }> {
    return this.req({ method: 'GET', url: '/listings', params });
  }
  /** Bulk lowest buy-now ask for the whole CS2 catalog in one request (min_price in cents).
   *  Undocumented but live-verified 2026-07-10; the pricing fill uses it to warm every CS2 name at
   *  once instead of hundreds of per-name searches. Shares the key's limiter + 429 backoff like any req. */
  priceList(): Promise<PriceListRow[]> {
    return this.req({ method: 'GET', url: '/listings/price-list' });
  }
  getListing(id: string): Promise<Dict> {
    return this.req({ method: 'GET', url: `/listings/${encodeURIComponent(id)}` });
  }
  createListing(body: CreateListingBody): Promise<Dict> {
    return this.req({ method: 'POST', url: '/listings', data: { type: 'buy_now', ...body } });
  }

  // ── UNDOCUMENTED endpoints (verify against a live key) ──────────────────────
  me(): Promise<Dict> { return this.req({ method: 'GET', url: '/me' }); }
  /**
   * A seller's own listings = their STALL. `/me/listings` does not exist (verified live 2026-08-11:
   * CSFloat's Go router answers a plain-text "404 page not found", which surfaced to operators as
   * "CSFloat HTTP 404" on every My-Listings open). Probing under `/me/` is misleading because the
   * auth middleware runs before routing there — every `/me/<anything>` returns 401 unauthenticated,
   * including paths that do not exist — so the 401 was never evidence the route was real.
   * `/users/<steam_id>/stall` is the endpoint that actually resolves (it answers a typed JSON error
   * for a private stall rather than a 404), which is why this takes a steam_id.
   */
  myStall(steamId: string, params: { page?: number; limit?: number } = {}): Promise<Dict> {
    return this.req({ method: 'GET', url: `/users/${encodeURIComponent(steamId)}/stall`, params });
  }
  delistListing(id: string): Promise<unknown> {
    return this.req({ method: 'DELETE', url: `/listings/${encodeURIComponent(id)}` });
  }
  editListingPrice(id: string, priceCents: number): Promise<unknown> {
    return this.req({ method: 'PATCH', url: `/listings/${encodeURIComponent(id)}`, data: { price: priceCents } });
  }
  buyListing(id: string, totalPriceCents: number): Promise<unknown> {
    // total_price guards against a price change between viewing and buying.
    return this.req({ method: 'POST', url: '/listings/buy', data: { total_price: totalPriceCents, contract_ids: [id] } });
  }
  getBuyOrders(params: { page?: number; limit?: number } = {}): Promise<Dict> {
    return this.req({ method: 'GET', url: '/me/buy-orders', params });
  }
  createBuyOrder(body: CreateBuyOrderBody): Promise<unknown> {
    return this.req({ method: 'POST', url: '/buy-orders', data: body });
  }
  deleteBuyOrder(id: string): Promise<unknown> {
    return this.req({ method: 'DELETE', url: `/buy-orders/${encodeURIComponent(id)}` });
  }
  getTrades(params: { page?: number; limit?: number; state?: string } = {}): Promise<Dict> {
    return this.req({ method: 'GET', url: '/me/trades', params });
  }
  getInventory(): Promise<unknown> {
    return this.req({ method: 'GET', url: '/me/inventory' });
  }

  // ── core request: rate-limited, 429 backoff, clean error surfacing ──────────
  private req<T>(config: AxiosRequestConfig, attempt = 0): Promise<T> {
    return this.limiter
      .schedule<T>(async () => {
        /* paced by the per-key limiter (interactive vs. bulk via this.priority) */
        let res;
        try {
          res = await this.http.request<T>(config);
        } catch (e) {
          throw new CsFloatError((e as AxiosError).message || 'CSFloat request failed (transport)');
        }
        // On a 429, DON'T sleep here — the backoff would hold the single-flight slot (maxConcurrent=1)
        // for its whole duration, so interactive requests can't preempt a background pricing storm. Throw a
        // sentinel so this task RESOLVES and frees the slot; the backoff + re-schedule happen in .catch below.
        if (res.status === 429 && attempt < 3) throw new RateLimitRetry();
        if (res.status >= 200 && res.status < 300) {
          const d = res.data as unknown;
          // CSFloat endpoints answer JSON (objects/arrays); DELETEs may answer empty (204/no body).
          // A non-empty STRING body on a 2xx is an HTML interstitial / wrapper page, not a success payload.
          if (typeof d === 'string' && d.trim() !== '') {
            throw new CsFloatError('CSFloat returned a non-JSON body on a 2xx (edge/interstitial page) — treat as a transient failure', res.status, undefined);
          }
          return d as T;
        }
        throw new CsFloatError(extractError(res.status, res.data), res.status, res.data);
      }, this.priority)
      .catch(async (err) => {
        if (err instanceof RateLimitRetry) {
          await delay(1000 * (attempt + 1));         // backoff OUTSIDE the slot (it's already freed)
          return this.req<T>(config, attempt + 1);   // re-enter as a fresh task (a background client lands
        }                                            // at the back of the low-priority queue → yields to interactive)
        throw err;
      });
  }
}

function extractError(status: number, body: unknown): string {
  const b = body as { message?: string; error?: string } | undefined;
  const msg = (b && (b.message || b.error)) || `CSFloat HTTP ${status}`;
  if (status === 401 || status === 403) return `CSFloat auth failed — check the API key (${msg})`;
  if (status === 429) return `CSFloat rate limit hit (${msg})`;
  return msg;
}
