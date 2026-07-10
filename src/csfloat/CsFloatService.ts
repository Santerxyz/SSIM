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

/**
 * F1: thrown when an account's proxy pool is lost (a rule matched a pool that hydrated empty).
 * AccountManager.withNetwork attaches `network: undefined` in that state so SessionManager refuses the
 * Steam login; CSFloat has no Steam session (pure API-key auth) so it must refuse egress the SAME way —
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

  constructor(private readonly accounts: AccountManager) {}

  // ── key management ──────────────────────────────────────────────────────────
  hasKey(username: string): boolean { return this.keys.has(username); }

  /** True when csfloat_keys.json is present-but-corrupt in plaintext mode → keys are NOT persisting
   *  and are silently absent; surfaced on /api/system/status so the operator restores it (S12). */
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
  myListings(u: string, params: { page?: number; limit?: number }): Promise<Record<string, unknown>> { return this.clientFor(u).myListings(params); }
  delist(u: string, id: string): Promise<unknown> { return this.clientFor(u).delistListing(id); }
  editPrice(u: string, id: string, cents: number): Promise<unknown> { return this.clientFor(u).editListingPrice(id, cents); }
  buy(u: string, id: string, totalCents: number): Promise<unknown> { return this.clientFor(u).buyListing(id, totalCents); }

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

  // ── F3: a client for app-wide pricing, using ANY account that has a key ──────
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
  }

  /** Release the shared per-key RateLimiter for a key no live account holds any more (INV-F4: a key
   *  still configured on ANY account keeps its limiter, so the per-key CSFloat rate cap is never doubled).
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
