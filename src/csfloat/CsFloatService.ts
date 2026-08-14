import type { AccountManager } from '../core/AccountManager';
import { AgentFactory, type HttpAgent } from '../network/AgentFactory';
import { AppSettings } from '../core/AppSettings';
import { logger } from '../utils/logger';
import { CsFloatKeyStore } from './CsFloatKeyStore';
import {
  CsFloatClient, CsFloatError,
  type ListingSearchParams, type CreateListingBody, type CreateBuyOrderBody,
} from './CsFloatClient';

// ════════════════════════════════════════════════════════════════════════════
//  CsFloatService — per-account CSFloat marketplace control (Feature 2).
//
//  Owns the per-account key store + a cache of per-account clients (each bound to
//  the account's isolated proxy/IP agent). Documented ops (search/get/create) are
//  first-class; undocumented ops are exposed but the routes gate the deepest ones
//  (buy-orders/trades/inventory) behind the `csfloatExperimental` flag. Secrets
//  never leave the vault/key-store — callers only ever see a masked tail.
//  Wired in createDeps(); immutable after boot.
// ════════════════════════════════════════════════════════════════════════════

interface CachedClient { key: string; client: CsFloatClient; agent: HttpAgent; }

/** How long the shared lowest-ask catalog stays authoritative. Long enough that pricing a
 *  whole stall costs one request, short enough that an undercut is still a real undercut. */
const PRICE_LIST_TTL_MS = 5 * 60 * 1000;

/**
 * F1: thrown when an account's proxy pool is lost (a rule matched a pool that hydrated empty).
 * AccountManager.withNetwork attaches `network: undefined` in that state so SessionManager refuses the
 * Steam login; CSFloat has no Steam session (pure API-key auth) so it must refuse egress the same way —
 * NEVER default to the host IP (a host-IP login on this fleet = ban risk). Callers skip/park the account.
 */
export class PoolLostError extends Error {
  constructor(public readonly username: string, reason = 'proxy pool unavailable') {
    super(`CSFloat egress refused for "${username}" — ${reason} (would leak the host IP)`);
    this.name = 'PoolLostError';
  }
}

export class CsFloatService {
  private readonly keys = new CsFloatKeyStore();
  private readonly clients = new Map<string, CachedClient>();      // lowercase username → client
  private pricing?: { username: string; key: string; client: CsFloatClient; agent: HttpAgent };
  /** Shared lowest-ask catalog for auto-pricing — see priceCatalog(). */
  private priceList?: { at: number; map: Map<string, number> };
  /** lowercase username → the steam_id behind its API key (see steamIdFor). */
  private readonly steamIds = new Map<string, string>();

  constructor(private readonly accounts: AccountManager) {}

  // ── key management ──────────────────────────────────────────────────────────
  hasKey(username: string): boolean { return this.keys.has(username); }

  /** True when csfloat_keys.json is present-but-corrupt in plaintext mode → keys are not persisting
   * and are silently absent; surfaced on /api/system/status so the operator restores it. */
  isKeyStoreDegraded(): boolean { return this.keys.isDegraded(); }

  keyInfo(username: string): { configured: boolean; tail?: string } {
    const k = this.keys.get(username);
    return k ? { configured: true, tail: k.slice(-4) } : { configured: false };
  }

  /** Validates then stores a key. A clear 401/403 rejects; any other failure (e.g. a
   *  wrong undocumented /me path or a transient network error) stores it with a warning
   *  rather than blocking a key that may well be valid. */
  async setKey(username: string, apiKey: string): Promise<{ profile?: Record<string, unknown>; warning?: string }> {
    const trimmed = (apiKey ?? '').trim();
    if (!trimmed) throw new Error('API key is required');
    let profile: Record<string, unknown> | undefined;
    let warning: string | undefined;
    try {
      profile = await this.validateKey(username, trimmed);
    } catch (e) {
      const status = (e as CsFloatError).status;
      if (status === 401 || status === 403) {
        throw new Error('CSFloat rejected this API key (401/403). Check it in your CSFloat Developer settings.');
      }
      warning = `Stored, but could not verify via /me: ${(e as Error).message}`;
    }
    const oldKey = this.keys.get(username);
    this.keys.set(username, trimmed);
    this.invalidate(username);
    if (oldKey && oldKey !== trimmed) this.releaseLimiterIfUnused(oldKey);
    return { profile, warning };
  }

  clearKey(username: string): void {
    const oldKey = this.keys.get(username);
    this.keys.delete(username);
    this.invalidate(username);
    this.releaseLimiterIfUnused(oldKey);
  }

  /** Drops the cached per-account client (and the shared pricing client if it is bound to this
   *  account) so the NEXT request rebuilds on the account's current egress network. Called when an
   *  operator changes an account/environment proxy — the cache is otherwise keyed only by API key,
   *  so a proxy edit would keep egressing over the retired IP until restart (INV-A4: effective proxy
   *  = operator's last set value; the Steam session is already dropped alongside this). */
  invalidateClient(username: string): void {
    this.invalidate(username);
    if (this.pricing && this.pricing.username.toLowerCase() === username.toLowerCase()) this.disposePricing();
  }

  async validateKey(username: string, apiKey: string): Promise<Record<string, unknown>> {
    const agent = this.agentFor(username);
    try { return await new CsFloatClient(apiKey, agent).me(); }
    finally { AgentFactory.destroyIfDisposable(agent); }
  }

  /** Deterministically retire every owned agent (cached per-account clients + the shared pricing
   *  client) at teardown so a re-license → re-activate cycle does not strand a generation of
   *  local-IP keepAlive sockets until GC. destroyIfDisposable is quiescence-safe (an in-flight
   *  request is parked in the reaper), so this never severs a live socket. */
  stop(): void {
    for (const c of this.clients.values()) AgentFactory.destroyIfDisposable(c.agent);
    this.clients.clear();
    this.disposePricing();
  }

  // ── operations: documented core ──────────────────────────────────────────────
  me(u: string): Promise<Record<string, unknown>> { return this.clientFor(u).me(); }
  search(u: string, params: ListingSearchParams): Promise<{ data: Record<string, unknown>[]; cursor?: string }> { return this.clientFor(u).searchListings(params); }
  getListing(u: string, id: string): Promise<Record<string, unknown>> { return this.clientFor(u).getListing(id); }
  createListing(u: string, body: CreateListingBody): Promise<Record<string, unknown>> { return this.clientFor(u).createListing(body); }
  /**
   * This account's own CSFloat listings (its stall).
   *
   * Needs the steam_id of whoever OWNS the API KEY — which is not necessarily the SSIM account's
   * own steamId (an operator can paste any key onto any account), so it is read from CSFloat's
   * /me rather than assumed from AccountConfig. Cached per username because it never changes for a
   * given key, and dropped by invalidate() when the key does.
   */
  async myListings(u: string, params: { page?: number; limit?: number }): Promise<Record<string, unknown>> {
    return this.clientFor(u).myStall(await this.steamIdFor(u), params) as Promise<Record<string, unknown>>;
  }

  /** The steam_id behind this account's API key, from /me (cached). */
  private async steamIdFor(username: string): Promise<string> {
    const key = username.toLowerCase();
    const hit = this.steamIds.get(key);
    if (hit) return hit;
    const me = await this.clientFor(username).me();
    // CSFloat has moved this field between the root and a `user` envelope across versions; accept both
    // rather than break the whole tab on a reshuffle.
    const u = me?.user as { steam_id?: unknown } | undefined;
    const id = String((me?.steam_id ?? u?.steam_id ?? '') || '').trim();
    if (!id) throw new Error('CSFloat did not return a steam_id for this API key — cannot load its stall');
    this.steamIds.set(key, id);
    return id;
  }
  delist(u: string, id: string): Promise<unknown> { return this.clientFor(u).delistListing(id); }
  editPrice(u: string, id: string, cents: number): Promise<unknown> { return this.clientFor(u).editListingPrice(id, cents); }
  buy(u: string, id: string, totalCents: number): Promise<unknown> { return this.clientFor(u).buyListing(id, totalCents); }

  /**
   * The CSFloat lowest-buy-now-ask catalog, as name → cents.
   *
   * Backs auto-pricing ("undercut the lowest ask by 2%") for bulk listing and repricing. It is
   * one request for the whole CS2 catalog (the live-verified /listings/price-list), so pricing a
   * 200-item stall costs a single call instead of 200 searches.
   *
   * The catalog is GLOBAL market data, not per-account, so the cache is shared across accounts and
   * only the fetching client differs (whichever account asked, on its own key + proxy). A fetch
   * failure re-serves the last good catalog with its true age attached rather than failing the
   * caller — the UI shows the age so a stale suggestion is never mistaken for a live one.
   */
  async priceCatalog(username: string): Promise<{ prices: Map<string, number>; fetchedAt: number; stale: boolean }> {
    const fresh = this.priceList && Date.now() - this.priceList.at <= PRICE_LIST_TTL_MS;
    if (fresh) return { prices: this.priceList!.map, fetchedAt: this.priceList!.at, stale: false };
    try {
      const rows = await this.clientFor(username).priceList();
      if (!Array.isArray(rows)) throw new Error('CSFloat returned an unexpected price-list shape');
      const map = new Map<string, number>();
      for (const r of rows) {
        const name = r?.market_hash_name;
        const cents = r?.min_price;
        // Skip a bad/absent price rather than poisoning the catalog with a 0 that would then be
        // undercut to 1 cent. An absent row simply means "no suggestion for this name".
        if (typeof name !== 'string' || !name) continue;
        if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) continue;
        map.set(name, Math.round(cents));
      }
      if (!map.size) throw new Error('CSFloat price list came back empty');
      this.priceList = { at: Date.now(), map };
      return { prices: map, fetchedAt: this.priceList.at, stale: false };
    } catch (e) {
      if (this.priceList) {
        logger.warn(`[csfloat] price-list refresh failed (${(e as Error).message}) — serving the cached catalog`);
        return { prices: this.priceList.map, fetchedAt: this.priceList.at, stale: true };
      }
      throw e;
    }
  }

  // ── operations: experimental (flag-gated at the route layer) ─────────────────
  buyOrders(u: string, params: { page?: number; limit?: number }): Promise<Record<string, unknown>> { return this.clientFor(u).getBuyOrders(params); }
  createBuyOrder(u: string, body: CreateBuyOrderBody): Promise<unknown> { return this.clientFor(u).createBuyOrder(body); }
  deleteBuyOrder(u: string, id: string): Promise<unknown> { return this.clientFor(u).deleteBuyOrder(id); }
  trades(u: string, params: { page?: number; limit?: number; state?: string }): Promise<Record<string, unknown>> { return this.clientFor(u).getTrades(params); }
  inventory(u: string): Promise<unknown> { return this.clientFor(u).getInventory(); }

  // ── auto-accept toggle (the worker enacts it) ────────────────────────────────
  getAutoAccept(u: string): boolean { return AppSettings.getAutoAccept(u); }
  /** Returns false when the toggle changed in memory but could not be persisted (the caller surfaces
   *  a truthful "not saved" error instead of echoing the optimistic value). */
  setAutoAccept(u: string, on: boolean): boolean { return AppSettings.setAutoAccept(u, on); }

  // ── F3: a client for app-wide pricing, using any account that has a key ──────
  /** Side-effect-free probe: true when at least one account has a CSFloat key, so the
   *  pricing source can serve. Unlike pricingClient() this neither builds/caches nor
   *  disposes an agent — usernamesWithKeys() is a pure vault/file read (CsFloatKeyStore). */
  hasAnyKey(): boolean { return this.keys.usernamesWithKeys().length > 0; }

  pricingClient(): CsFloatClient | null {
    // Stable order: prefer the lexically-first account with a key, but SKIP a pool-lost one (F1) and
    // try the next rather than silently egressing the host IP or killing all pricing.
    for (const username of this.keys.usernamesWithKeys().sort()) {
      const key = this.keys.get(username);
      if (!key) continue;
      if (this.pricing && this.pricing.username === username && this.pricing.key === key) return this.pricing.client;
      let agent: HttpAgent;
      try { agent = this.agentFor(username); }
      catch (e) { logger.warn(`[csfloat] pricing: skipping ${username} — ${(e as Error).message}`); continue; }
      this.disposePricing();
      // priority < 0 → the bulk pricing fill yields to interactive CSFloat tabs sharing this key's limiter.
      this.pricing = { username, key, client: new CsFloatClient(key, agent, { priority: -1 }), agent };
      return this.pricing.client;
    }
    this.disposePricing();
    return null;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private requireKey(username: string): string {
    const k = this.keys.get(username);
    if (!k) throw new Error(`No CSFloat API key for "${username}" — add one in CSFloat → Settings`);
    return k;
  }

  private clientFor(username: string): CsFloatClient {
    const key = this.requireKey(username);
    const cached = this.clients.get(username.toLowerCase());
    if (cached && cached.key === key) return cached.client;
    if (cached) AgentFactory.destroyIfDisposable(cached.agent);
    const agent = this.agentFor(username);
    const client = new CsFloatClient(key, agent);
    this.clients.set(username.toLowerCase(), { key, client, agent });
    return client;
  }

  private agentFor(username: string): HttpAgent {
    const acc = this.accounts.get(username);
    // F1: an account that legitimately resolves to local IP gets `{type:'localip'}` attached by
    // withNetwork; `undefined` ONLY ever means pool-lost. Refuse rather than fall to the host IP.
    if (!acc) throw new PoolLostError(username, 'account not found');
    if (!acc.network) throw new PoolLostError(username);
    return AgentFactory.create(acc.network, { pooled: false }).httpsAgent;
  }

  private invalidate(username: string): void {
    const c = this.clients.get(username.toLowerCase());
    if (c) { AgentFactory.destroyIfDisposable(c.agent); this.clients.delete(username.toLowerCase()); }
    // A different key can belong to a different CSFloat user, so the cached steam_id (and with it
    // WHOSE stall My Listings shows) must not survive a key change.
    this.steamIds.delete(username.toLowerCase());
  }

  /** Release the shared per-key RateLimiter for a key no live account holds any more (INV-F4: a key
   *  still configured on any account keeps its limiter, so the per-key CSFloat rate cap is never doubled).
   *  A shared-key account keeps the limiter alive; a returning key just rebuilds one via limiterFor. */
  private releaseLimiterIfUnused(key: string | undefined): void {
    if (key && !this.keys.usernamesWithKeys().some((u) => this.keys.get(u) === key)) {
      CsFloatClient.releaseLimiter(key);
    }
  }

  private disposePricing(): void {
    if (this.pricing) { AgentFactory.destroyIfDisposable(this.pricing.agent); this.pricing = undefined; }
  }
}
