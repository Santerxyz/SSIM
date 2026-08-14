// ════════════════════════════════════════════════════════════════════════════
//  W3_30 — StoreService: money-safe HTTP client for store.steampowered.com.
//
//  No code hit the store domain before this. The trick (cleanBrowser.ts:32-42):
//  `steamLoginSecure` is a JWT whose audience is "web" — the same value is accepted
//  by every Steam web domain; we just send it (plus `sessionid`) in the Cookie header
//  of a request whose URL is the store host. No cookie jar, no CDP, no second login.
//
//  Transport only. Every store JSON payload is UNDOCUMENTED and can change, so the
//  whole design is *shape-validate then fail closed*. GET (reads) may retry bounded on
//  transport faults; a money POST is NEVER auto-retried (its outcome is ambiguous — the
//  caller reconciles via its own MoneyOpJournal + a read-back). Dependents: W3_31 (wallet
//  codes / promo licenses), W4_40 (paysafecard), W4_41 (paid-game checkout).
// ════════════════════════════════════════════════════════════════════════════
import axios from 'axios';
import { SessionManager } from '../core/SessionManager';
import { AccountManager } from '../core/AccountManager';
import type { ManagedSession } from '../types/session';
import { MARKET_UA, extractCookie } from '../trading/AccountTrader';
import { logger } from '../utils/logger';
import { STEAM_CURRENCIES } from '../pricing/currencies';
import { parseRedeemResult, type RedeemResult } from './walletCode';   // W3_31

// Steam wallet currency: ISO alpha (what the addfunds form posts, e.g. "EUR") ⇄ numeric ECurrencyCode.
const isoToCurrencyCode = (iso: string): number => {
  const up = String(iso || '').toUpperCase();
  for (const k of Object.keys(STEAM_CURRENCIES)) { const c = STEAM_CURRENCIES[Number(k)]; if (c.iso === up) return c.code; }
  return 0;
};

/** paysafecard top-ups are EUR-ONLY (owner 2026-07-10). Every other wallet currency is REFUSED before a
 *  cart is built — never "best effort". This is what lets the whole money path reconcile in the account's
 *  NATIVE minor units (euro-cents) with no FX conversion anywhere: an FX rate that moves between the
 *  baseline read and the read-back would otherwise manufacture a phantom "credit". EUR has 2 decimals, so
 *  Steam's `data-amount` tile value, the wallet's minor units and our threshold are all the same unit. */
export const PAYSAFE_CURRENCY_CODE = 3;
export const PAYSAFE_CURRENCY_ISO = 'EUR';

const STORE_ORIGIN = 'https://store.steampowered.com';
const STORE_UA = MARKET_UA;                 // the desktop UA the market path already uses
const STORE_TIMEOUT_MS = 20_000;            // matches community call timeouts; well under the agent 120s force-retire
const MAX_GET_REDIRECTS = 3;                // bounded, and every hop is re-checked against the host allowlist

/** A 200-OK body that isn't the JSON object we expected (e.g. an HTML login page from a stale session). */
export class StoreShapeError extends Error { constructor(msg: string) { super(msg); this.name = 'StoreShapeError'; } }
/** A definitive HTTP failure (4xx/5xx after the bounded read retries). */
export class StoreHttpError extends Error { constructor(public status: number, msg: string) { super(msg); this.name = 'StoreHttpError'; } }
/** A transport error on a NON-idempotent POST — the request may have reached Steam. Never retried;
 *  the caller must reconcile the true outcome via a read-back (no-band-aid). */
export class StoreAmbiguousError extends Error { constructor(msg: string) { super(msg); this.name = 'StoreAmbiguousError'; } }

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `string("${v.slice(0, 24)}"…)`;
  return typeof v;
}

/** the most important money-safety guard: a store endpoint returns an HTML login/error page
 *  (as a string, 200 OK) when the session is stale — this fails closed instead of a caller
 *  reading `undefined.success` and treating "unknown" as "success". */
export function requireJsonObject(data: unknown, ctxLabel: string): Record<string, unknown> {
  if (data == null || typeof data !== 'object' || Array.isArray(data))
    throw new StoreShapeError(`${ctxLabel}: expected a JSON object, got ${describe(data)}`);
  return data as Record<string, unknown>;
}
export function requireEResult(obj: Record<string, unknown>, field = 'success'): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new StoreShapeError(`missing/invalid EResult field "${field}"`);
  return v;                                 // caller compares against EResult.OK (1) etc.
}
// The authenticated Cookie (steamLoginSecure = a cross-domain "web" JWT) may go ONLY to these exact Steam
// hosts. `checkout.steampowered.com` is where the wallet-recharge checkout (inittransaction/getfinalprice)
// lives — the same JWT authenticates it; the store cart just hands off to it.
const STEAM_WEB_HOSTS = new Set(['store.steampowered.com', 'checkout.steampowered.com']);
const CHECKOUT_ORIGIN = 'https://checkout.steampowered.com';
/** The token-auth WebAPI host. DELIBERATELY not in STEAM_WEB_HOSTS: nothing that carries the
 *  authenticated Cookie may go here. `webapiPost` sends no cookies at all (see there). */
const STEAM_WEBAPI_HOST = 'api.steampowered.com';
/** SSRF/typo guard: never send the authenticated Cookie to anything but an allowlisted Steam web host.
 *  Called before every request and before every redirect hop — `maxRedirects: 0` on the axios config means
 *  nothing is ever followed behind our back, so this is a real invariant and not just an entry check. */
export function assertStoreHost(url: string): void {
  let host: string;
  try { host = new URL(url).host; } catch { throw new StoreShapeError(`invalid store URL: ${url}`); }
  if (!STEAM_WEB_HOSTS.has(host)) throw new StoreShapeError(`refusing to send store cookies to non-Steam host "${host}"`);
}

/** A URL we are willing to hand to the browser with this account's Steam cookies loaded. The externallink
 *  target (and any `externalurl` Steam hands back) must be an https Steam host — never an arbitrary URL
 *  read out of a JSON field. Cookies are domain-pinned to the Steam tree in cleanBrowser, so this is
 *  defence-in-depth: it stops us opening an attacker-chosen page through the account's proxy. */
export function isSteamHttpsUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && STEAM_WEB_HOSTS.has(u.host); }
  catch { return false; }
}
export function assertSteamHttpsUrl(url: string, label: string): void {
  if (!isSteamHttpsUrl(url)) throw new StoreShapeError(`${label}: refusing to open non-Steam URL`);
}

/** Steam returns money as minor-unit strings ("500") or numbers. Anything else is not a verified amount. */
export function parseMinorUnits(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return null;
}

export interface StoreReqOpts { referer?: string; accept?: string }
/** data is UNVALIDATED — caller MUST shape-check. `location` is the raw Location header (POSTs are never
 *  auto-followed, so the caller reads the redirect target itself). */
export interface StoreResponse { status: number; data: unknown; location: string }
export interface StoreContext {
  username: string;
  steamId: string;
  sessionid: string;                        // also the CSRF form param (same value as the Cookie's sessionid)
  get: (path: string, opts?: StoreReqOpts) => Promise<StoreResponse>;
  post: (path: string, form: Record<string, string>, opts?: StoreReqOpts) => Promise<StoreResponse>;
  /** Token-authenticated Steam WebAPI call (`IAccountCartService/…`), for the operations Steam's own
   *  store JS does that way. `method` is e.g. "IAccountCartService/DeleteCart/v1".
   *
   *  This request carries NO Cookie header AT all — the `access_token` Steam publishes in the store
   *  page's `data-store_user_config` is the whole credential. That is what lets it reach a host outside
   *  STEAM_WEB_HOSTS without weakening the invariant that list exists for: the authenticated
   *  `steamLoginSecure` JWT still never leaves the store/checkout hosts. */
  webapi: (method: string, accessToken: string, form?: Record<string, string>) => Promise<StoreResponse>;
}

const TRANSIENT = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNABORTED']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoff = (attempt: number) => 400 * 2 ** attempt + Math.floor(Math.random() * 200);

export class StoreService {
  constructor(private sessions: SessionManager, private accounts: AccountManager) {}

  /** The ONLY entry point dependents use. Ensures a live+fresh session, binds a StoreContext to
   *  that account's cookies+resolved-proxy agent, runs `fn`, and releases the session ONLY if this
   *  call created it (mirrors InventoryService ownership — never logs off an already-live account).
   *
   *  `opts.keepSession` suppresses that release so the CALLER owns the session's lifetime (W4_40: the
   *  paysafecard poll reads the resident session's wallet — which Steam pushes on every balance change —
   *  instead of re-logging in every tick). `fn` receives `createdByCall` so the caller knows whether it
   *  inherited ownership and must release the session itself. */
  async withStoreSession<T>(
    username: string,
    fn: (ctx: StoreContext, session: ManagedSession, createdByCall: boolean) => Promise<T>,
    opts: { keepSession?: boolean } = {},
  ): Promise<T> {
    const account = this.accounts.get(username);
    if (!account) throw new StoreShapeError(`account "${username}" not found`);
    if (account.enabled === false) throw new StoreShapeError(`account "${username}" is disabled`);

    const { session, createdByCall } = await this.sessions.loginAccountOwned(account);
    let handedOff = false;
    try {
      if (!this.sessions.isReady(username)) throw new StoreShapeError(`session for "${username}" is not ready (cookies stale/absent)`);
      const cookies = session.webSession?.cookies ?? [];
      const sessionid = extractCookie(cookies, 'sessionid');
      if (!sessionid || !extractCookie(cookies, 'steamLoginSecure'))
        throw new StoreShapeError(`no authenticated store cookies for "${username}" (missing sessionid/steamLoginSecure)`);

      const agent = session.httpsAgent;      // the account's RESOLVED proxy/local-IP agent (IP-leak safe)
      const ctx: StoreContext = {
        username, steamId: session.steamId ?? '', sessionid,
        get: (path, opts2) => this.retryGet(agent, cookies, path, opts2),
        post: (path, form, opts2) => this.postOnce(agent, cookies, path, form, opts2),
        webapi: (method, token, form2) => this.webapiPost(agent, method, token, form2),
      };
      const out = await fn(ctx, session, createdByCall);
      handedOff = !!opts.keepSession;        // ONLY a successful fn hands the session to the caller
      return out;
    } finally {
      // Release ONLY a session this call created (public path = logoutAccount, gated by isLive —
      // destroySession is private; InventoryService.ts:823 uses exactly this). A keepSession call that
      // THREW never hands off: we release, so a failed init can't strand a resident session.
      if (createdByCall && !handedOff) {
        try { if (this.sessions.isLive(username)) await this.sessions.logoutAccount(username); }
        catch (e) { logger.warn(`[${username}] store session release failed: ${(e as Error).message}`); }
      }
    }
  }

  /** The load-bearing request wrapper: same isolation shape as every community call
   *  (per-account httpsAgent, proxy:false, Connection:close, hand-set Cookie header).
   *
   *  `maxRedirects: 0` — axios NEVER follows a redirect on our behalf. Whether the authenticated Cookie
   *  survives a cross-host hop would otherwise be decided by follow-redirects' internal header-stripping
   *  rather than by `assertStoreHost`. A GET follows redirects here, re-asserting the host on every hop
   *  and bounded by MAX_GET_REDIRECTS; a POST never follows at all, so a money POST's outcome is exactly
   *  the response Steam gave us (its Location is handed to the caller). */
  private async raw(agent: unknown, cookies: string[], method: 'GET' | 'POST', path: string, form: Record<string, string> | undefined, opts: StoreReqOpts | undefined): Promise<StoreResponse> {
    let url = path.startsWith('http') ? path : STORE_ORIGIN + path;
    for (let hop = 0; ; hop++) {
      assertStoreHost(url);                  // re-checked every hop — the cookie cannot leave the allowlist
      const origin = new URL(url).origin;    // store OR checkout — Origin/Referer must match the target host
      const headers: Record<string, string> = {
        Cookie: cookies.join('; '),          // steamLoginSecure (cross-domain JWT) + sessionid (CSRF)
        'User-Agent': STORE_UA,
        Accept: opts?.accept ?? 'application/json, text/javascript;q=0.9, */*;q=0.1',
        Origin: origin,
        Referer: opts?.referer ?? `${origin}/`,
        Connection: 'close',                 // fresh proxy exit per call (matches AccountTrader)
        ...(method === 'POST' ? { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      };
      const cfg = { httpsAgent: agent, proxy: false as const, timeout: STORE_TIMEOUT_MS, validateStatus: () => true, maxRedirects: 0, headers };
      const r = method === 'GET'
        ? await axios.get(url, cfg)
        : await axios.post(url, new URLSearchParams(form).toString(), cfg);
      const location = String((r.headers as Record<string, unknown> | undefined)?.location ?? '');
      const res: StoreResponse = { status: r.status, data: r.data, location };

      const isRedirect = r.status >= 300 && r.status < 400 && !!location;
      if (method !== 'GET' || !isRedirect) return res;      // POSTs surface their 3xx to the caller, unfollowed
      if (hop >= MAX_GET_REDIRECTS) throw new StoreHttpError(r.status, `store GET ${path}: too many redirects`);
      try { url = new URL(location, url).toString(); }
      catch { throw new StoreShapeError(`store GET ${path}: unparseable redirect target`); }
    }
  }

  /** GET is idempotent → bounded retry (2 retries) on transient transport faults / 502-504 only.
   *  A 200-with-bad-shape or a definitive 4xx is not retried (that's the caller's fail-closed check). */
  private async retryGet(agent: unknown, cookies: string[], path: string, opts?: StoreReqOpts): Promise<StoreResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.raw(agent, cookies, 'GET', path, undefined, opts);
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          if (attempt < 2) { await sleep(backoff(attempt)); continue; }
          throw new StoreHttpError(res.status, `store GET ${path} → ${res.status}`);
        }
        return res;
      } catch (e) {
        if (e instanceof StoreHttpError || e instanceof StoreShapeError) throw e;
        lastErr = e;
        const code = (e as { code?: string })?.code;
        if (attempt < 2 && code && TRANSIENT.has(code)) { await sleep(backoff(attempt)); continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  /** POST is non-idempotent → NEVER auto-retried. A network error is surfaced as StoreAmbiguousError
   *  so the caller reconciles the true outcome via a read-back (no double-submit). */
  /**
   * Token-authenticated Steam WebAPI POST (see StoreContext.webapi). NO Cookie header is sent — the
   * access token is the only credential — so `api.steampowered.com` never sees `steamLoginSecure` and
   * the STEAM_WEB_HOSTS invariant is untouched. The method name is validated against a strict shape
   * rather than interpolated blindly, and the account's own proxy agent is still used so the call
   * egresses from the same IP as everything else this account does.
   *
   * Like every other non-idempotent call here it is NEVER auto-retried; the caller verifies by reading
   * the resulting state back.
   */
  private async webapiPost(agent: unknown, method: string, accessToken: string, form?: Record<string, string>): Promise<StoreResponse> {
    if (!/^[A-Za-z]\w{0,64}\/[A-Za-z]\w{0,64}\/v\d{1,2}$/.test(method)) throw new StoreShapeError(`invalid WebAPI method "${method}"`);
    if (!/^[\w.-]{8,512}$/.test(accessToken)) throw new StoreShapeError('invalid WebAPI access token');
    const url = `https://${STEAM_WEBAPI_HOST}/${method}/?access_token=${encodeURIComponent(accessToken)}`;
    try {
      const r = await axios.post(url, new URLSearchParams(form ?? {}).toString(), {
        httpsAgent: agent, proxy: false as const, timeout: STORE_TIMEOUT_MS, validateStatus: () => true, maxRedirects: 0,
        headers: {
          'User-Agent': STORE_UA,
          Accept: 'application/json',
          Origin: STORE_ORIGIN,
          Referer: `${STORE_ORIGIN}/`,
          Connection: 'close',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
      });
      return { status: r.status, data: r.data, location: String((r.headers as Record<string, unknown> | undefined)?.location ?? '') };
    } catch (e) {
      throw new StoreAmbiguousError(`WebAPI ${method} failed in-flight (outcome unknown — reconcile via a read-back): ${(e as Error).message}`);
    }
  }

  private async postOnce(agent: unknown, cookies: string[], path: string, form: Record<string, string>, opts?: StoreReqOpts): Promise<StoreResponse> {
    try {
      return await this.raw(agent, cookies, 'POST', path, form, opts);
    } catch (e) {
      throw new StoreAmbiguousError(`store POST ${path} failed in-flight (outcome unknown — reconcile via read-back): ${(e as Error).message}`);
    }
  }

  // ── W3_31 store calls (transport + classification only; the money-safety journal lives in the route) ──

  /** Redeem a Steam wallet code. Returns a CLASSIFIED result (success / definite-reject / ambiguous).
   *  NEVER logs or echoes the raw code. sessionid is sent in both the Cookie and the body (CSRF match). */
  async redeemWalletCode(username: string, code: string): Promise<RedeemResult> {
    return this.withStoreSession(username, async (ctx) => {
      let res: StoreResponse;
      try {
        res = await ctx.post('/account/ajaxredeemwalletcode/', { wallet_code: code, sessionid: ctx.sessionid });
      } catch (e) {
        if (e instanceof StoreAmbiguousError) return { success: false, detail: 'transport ambiguous', ambiguous: true };
        throw e;
      }
      // A 3xx is AMBIGUOUS, not a rejection: POSTs are never followed (raw() pins maxRedirects to 0), so a
      // redirect means Steam never handed us an authoritative answer — most likely a stale session bounced
      // us to /login/, but "most likely" is not "certainly" on a money-in code. Reconcile, never conclude.
      const redirected = res.status >= 300 && res.status < 400;
      if (res.status !== 200) return { success: false, detail: `HTTP ${res.status}`, ambiguous: res.status >= 500 || redirected };
      let obj: Record<string, unknown>;
      try { obj = requireJsonObject(res.data, 'redeemWalletCode'); }
      catch { return { success: false, detail: 'undecodable response (stale session?)', ambiguous: true }; }
      return parseRedeemResult(obj);
    });
  }

  /** Activate a promo / limited-time-free license (subId). not money-in, no journal. Best-effort
   *  classification of the store's response. ⚠ Endpoint shape is undocumented — verify live. */
  async addFreeLicense(username: string, subId: number): Promise<{ status: 'added' | 'already-owned' | 'unavailable'; detail: string }> {
    return this.withStoreSession(username, async (ctx) => {
      let res: StoreResponse;
      try {
        res = await ctx.post(`/checkout/addfreelicense/${subId}`, { action: 'add_to_cart', sessionid: ctx.sessionid });
      } catch (e) {
        if (e instanceof StoreAmbiguousError) return { status: 'unavailable' as const, detail: 'transport error' };
        throw e;
      }
      // Steam answers this one with a redirect to the store/cart page on success. POSTs are never followed
      // (maxRedirects 0), so a 3xx here means "accepted" — not "unavailable". Only a 200 carries a body we
      // can sniff for the already-owned case.
      if (res.status >= 300 && res.status < 400) return { status: 'added' as const, detail: 'ok (accepted)' };
      if (res.status !== 200) return { status: 'unavailable' as const, detail: `HTTP ${res.status}` };
      const body = (typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')).toLowerCase();
      if (body.includes('already')) return { status: 'already-owned' as const, detail: 'already owned' };
      return { status: 'added' as const, detail: 'ok' };
    });
  }

  // ── W4_40 headless paysafecard checkout (reverse-engineered from Steam's public checkout.js) ──

  /** The wallet-recharge amount tiers Steam offers this account. The modern addfunds page renders each
   *  amount as `<a data-amount="500" data-currency="EUR" onclick="submitAddFunds(this)">` (its JS copies
   *  those into the form_addfunds hidden inputs and POSTs /steamaccount/addfundssubmit). We parse the
   *  data-amount tiles (minor units) + data-currency (ISO → numeric ECurrencyCode). When none are found
   *  (custom-amount region / page change), returns `tiers: []` so the UI falls back to free-text.
   *  `supported` is the EUR-only gate: a non-EUR wallet cannot be topped up and the UI must say so
   *  (rather than offer an amount box that will be refused at open time). */
  async getAddfundsTiers(username: string): Promise<{ currency: number; iso: string; tiers: number[]; supported: boolean }> {
    return this.withStoreSession(username, async (ctx, session) => {
      const res = await ctx.get('/steamaccount/addfunds', { accept: 'text/html' });
      if (res.status !== 200) throw new StoreHttpError(res.status, `addfunds → ${res.status}`);
      const html = typeof res.data === 'string' ? res.data : '';
      const tierSet = new Set<number>();
      let iso = '';
      let m: RegExpExecArray | null;
      const reTile = /data-amount="(\d+)"[^>]*\bdata-currency="([A-Za-z]{3})"/gi;    // <a data-amount="500" data-currency="EUR">
      while ((m = reTile.exec(html))) { const amt = Number(m[1]); if (amt > 0) { tierSet.add(amt); if (!iso) iso = m[2]; } }
      if (!iso) { const cm = html.match(/id="input_currency"[^>]*value="([A-Za-z]{3})"/i) ?? html.match(/name="currency"[^>]*value="([A-Za-z]{3})"/i); if (cm) iso = cm[1]; }
      iso = iso.toUpperCase();
      const currency = isoToCurrencyCode(iso) || (session.wallet?.currency ?? 0);
      // `supported` must mirror exactly what initPaysafeCheckout will accept — the currency read off the
      // addfunds PAGE. Falling back to the session's wallet currency here would light up an "Open checkout"
      // button that the backend then refuses (it cannot read the page ISO either). An unreadable currency is
      // unsupported, not assumed-EUR; `iso: ''` tells the UI to say so honestly.
      const supported = iso === PAYSAFE_CURRENCY_ISO;
      return { currency, iso, tiers: [...tierSet].sort((a, b) => a - b), supported };
    });
  }

  /**
   * Headless init of a paysafecard wallet top-up: establish the recharge cart, POST inittransaction with
   * PaymentMethod=paysafe (a FORM FIELD — deterministic, no default-method race) + a caller-supplied RANDOM
   * billing, then getfinalprice, and return the Steam externallink the browser opens (it 302s to the
   * paysafecard page). NO money moves here — the charge only completes when the operator finishes on
   * paysafecard's page; this just prepares the transaction.
   *
   * MONEY-SAFETY (fail-closed at every step — a throw means no browser opens, so no charge can occur):
   *  • EUR-only. A non-EUR addfunds page or wallet is refused before a cart is built.
   *  • The cart gid is taken from this submit's redirect, never a pre-existing cart, so an abandoned
   *    earlier top-up cannot silently ride along.
   *  • getfinalprice's EResult must be OK, and the order amount Steam reports back must EQUAL the amount
   *    the operator confirmed. Verifying "what we asked for" and "what arrived" is not enough — this is
   *    the only step that checks what Steam is about to actually CHARGE.
   *  • `externalurl` is validated as an https Steam host before it is ever handed to a browser.
   *
   * On success the account's session is left live (`sessionOwned` tells the caller whether it now owns it):
   * Steam pushes wallet updates to a resident session, so the credit poll never needs to re-login.
   */
  async initPaysafeCheckout(
    username: string,
    opts: { amountMinor: number; billing: PaysafeBilling },
  ): Promise<{ transid: string; externalUrl: string; walletMinor: number | null; cookies: string[]; network?: { type: string; value: string }; warnings: string[]; sessionOwned: boolean }> {
    return this.withStoreSession(username, async (ctx, session, createdByCall) => {
      const out = await performPaysafeCheckout(ctx, opts, () => this.sessions.awaitWallet(username));
      return { ...out, cookies: session.webSession?.cookies ?? [], network: session.account?.network, sessionOwned: createdByCall };
    }, { keepSession: true });
  }
}

export interface PaysafeBilling { firstName?: string; lastName?: string; address?: string; addressTwo?: string; city?: string; state?: string; country?: string; postalCode?: string; email?: string }

/**
 * The paysafecard checkout choreography, expressed against a StoreContext so it is exercisable without a
 * Steam session, a browser or the network. `initPaysafeCheckout` is just this plus session plumbing.
 * Every refusal below throws, and a throw means the caller never opens a browser — so no charge can occur.
 */
export async function performPaysafeCheckout(
  ctx: StoreContext,
  opts: { amountMinor: number; billing: PaysafeBilling },
  readWallet: () => Promise<{ hasWallet: boolean; currency: number; balance: number } | undefined>,
): Promise<{ transid: string; externalUrl: string; walletMinor: number | null; warnings: string[] }> {
  const amountMinor = opts.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new StoreShapeError(`invalid top-up amount (${amountMinor})`);
  const warnings: string[] = [];
  const b = opts.billing;
  const username = ctx.username;

  // 1) GET the addfunds page → the account's currency ISO + the form's sessionID. The page's JS
  //    submitAddFunds() copies each tile's data-amount/data-currency into #input_amount/#input_currency
  //    and POSTs form_addfunds; we replicate that exactly.
  const page = await ctx.get('/steamaccount/addfunds', { accept: 'text/html' });
  if (page.status !== 200) throw new StoreHttpError(page.status, `addfunds → ${page.status}`);
  const pageHtml = typeof page.data === 'string' ? page.data : '';
  const isoM = pageHtml.match(/id="input_currency"[^>]*value="([A-Za-z]{3})"/i) ?? pageHtml.match(/\bdata-currency="([A-Za-z]{3})"/i) ?? pageHtml.match(/name="currency"[^>]*value="([A-Za-z]{3})"/i);
  if (!isoM) throw new StoreShapeError('could not read the wallet currency from the addfunds page (Steam layout changed, or the session is stale)');
  const currencyIso = isoM[1].toUpperCase();
  if (currencyIso !== PAYSAFE_CURRENCY_ISO)
    throw new StoreShapeError(`paysafecard top-ups are EUR-only — this account's Steam wallet is ${currencyIso}`);

  // 1b) The wallet itself must be EUR too (an empty wallet reports currency 0 + hasWallet:false, which
  //     is fine: it is 0 €). Checked before any cart exists, so a mismatch never leaves state behind.
  const wallet = await readWallet();
  if (wallet?.hasWallet && wallet.currency !== PAYSAFE_CURRENCY_CODE)
    throw new StoreShapeError(`paysafecard top-ups are EUR-only — this account's Steam wallet is currency ${wallet.currency}`);
  const walletMinor = walletEurMinor(wallet);
  if (walletMinor == null) warnings.push('the wallet balance could not be read, so the credit cannot be confirmed automatically — check the balance on Steam after paying.');

  const sidM = pageHtml.match(/name="sessionID"\s+value="([A-Za-z0-9]+)"/i);
  const sessionID = sidM ? sidM[1] : ctx.sessionid;      // the form field is sessionID (capital), not sessionid

  // 2) POST /steamaccount/addfundssubmit (action=add_to_cart) → puts the recharge IN the cart. Not
  //    following the redirect (raw() never follows a POST) is deliberate: its Location carries the gid
  //    of the cart this submit created, which is what step 3 must use.
  const submit = await ctx.post('/steamaccount/addfundssubmit', { action: 'add_to_cart', currency: PAYSAFE_CURRENCY_ISO, amount: String(amountMinor), sessionID, mtreturnurl: '' }, { referer: `${STORE_ORIGIN}/steamaccount/addfunds` });
  // A 3xx is the SUCCESS shape here (Steam redirects to the checkout it just built); a 4xx/5xx must not
  // fall through to the /cart/ fallback, which would quietly check out whatever the standing cart holds.
  if (submit.status >= 400) throw new StoreHttpError(submit.status, `addfundssubmit → ${submit.status}`);
  const submitBody = typeof submit.data === 'string' ? submit.data : JSON.stringify(submit.data ?? '');

  // 3) Resolve the cart gid: this submit's redirect first, then its body. Falling back to the standing
  //    /cart/ page is a last resort and is WARNED, because that cart may still hold an abandoned
  //    recharge — the amount assertion in step 6 is what actually catches that.
  let gidShoppingCart = '-1', bUseAccountCart = '1';
  const findGid = (h: string): RegExpMatchArray | null => h.match(/[?&]cart=(\d{5,})/i) ?? h.match(/shopping_cart_gid["'\s:=]+"?(\d{2,})"?/i) ?? h.match(/gidShoppingCart["'\s:=]+"?(\d{2,})"?/i);
  let gm = findGid(submit.location) ?? findGid(submitBody);
  if (!gm) {
    try {
      const cart = await ctx.get('/cart/', { accept: 'text/html' });
      gm = findGid(typeof cart.data === 'string' ? cart.data : '');
      if (gm) warnings.push('Steam did not hand back a fresh cart — falling back to this account’s standing cart.');
    } catch (e) { warnings.push(`cart read failed (${(e as Error).message}) — using the account cart`); }
  }
  if (gm) { gidShoppingCart = gm[1]; bUseAccountCart = '0'; }

  // 4) The checkout (inittransaction/getfinalprice) lives on checkout.steampowered.com, not the store
  //    host. GET the authenticated checkout page first — the same steamLoginSecure JWT authenticates it,
  //    it sets up the transaction context, and it carries the checkout-domain sessionid (g_sessionID).
  const checkoutUrl = `${CHECKOUT_ORIGIN}/checkout/?cart=${gidShoppingCart}&purchasetype=self`;
  const co = await ctx.get(checkoutUrl, { accept: 'text/html', referer: `${STORE_ORIGIN}/cart/` });
  if (co.status !== 200) throw new StoreHttpError(co.status, `checkout page → ${co.status}`);
  const coHtml = typeof co.data === 'string' ? co.data : '';
  const coSidM = coHtml.match(/g_sessionID\s*=\s*"([A-Za-z0-9]+)"/i) ?? coHtml.match(/name="sessionid"\s+value="([A-Za-z0-9]+)"/i);
  const checkoutSid = coSidM ? coSidM[1] : ctx.sessionid;

  // 5) POST inittransaction to the CHECKOUT host with paysafecard forced. NB the token Steam expects is
  //    'paysafe' (verified from the live checkout page's PaymentMethodProperties) — not 'paysafecard';
  //    that mismatch was the last EResult 2 (paymentmethod echoed back 0 = unrecognized).
  const initForm: Record<string, string> = {
    gidShoppingCart, gidReplayOfTransID: '-1', bUseAccountCart, PaymentMethod: 'paysafe', abortPendingTransactions: '1',
    bHasCardInfo: '0', CardNumber: '', CardExpirationYear: '', CardExpirationMonth: '',
    FirstName: b.firstName ?? '', LastName: b.lastName ?? '', Address: b.address ?? '', AddressTwo: b.addressTwo ?? '',
    Country: b.country ?? 'DE', City: b.city ?? '', State: b.state ?? '', PostalCode: b.postalCode ?? '', Phone: '',
    ShippingFirstName: '', ShippingLastName: '', ShippingAddress: '', ShippingAddressTwo: '', ShippingCountry: '', ShippingCity: '', ShippingState: '', ShippingPostalCode: '', ShippingPhone: '',
    bIsGift: '0', GifteeAccountID: '', GifteeEmail: '', GifteeName: '', GiftMessage: '', Sentiment: '', Signature: '', ScheduledSendOnDate: '',
    BankAccount: '', BankCode: '', BankIBAN: '', BankBIC: '', TPBankID: '', BankAccountID: '',
    bSaveBillingAddress: '1', gidPaymentID: '', bUseRemainingSteamAccount: '0', bPreAuthOnly: '0',
    sessionid: checkoutSid,
  };
  const initRes = await ctx.post(`${CHECKOUT_ORIGIN}/checkout/inittransaction/`, initForm, { referer: checkoutUrl });
  if (initRes.status !== 200) throw new StoreHttpError(initRes.status, `inittransaction → ${initRes.status}`);
  const initObj = requireJsonObject(initRes.data, 'inittransaction');
  const success = requireEResult(initObj);
  if (success !== 1) {
    logger.warn(`[paysafe] ${username}: inittransaction failed EResult=${success} detail=${initObj.purchaseresultdetail ?? '?'} (cart=${gidShoppingCart}/${bUseAccountCart} amount=${amountMinor})`);
    throw new StoreShapeError(`inittransaction returned EResult ${success} (detail ${initObj.purchaseresultdetail ?? '?'})`);
  }
  const transid = String(initObj.transid ?? '');
  if (!transid || transid === 'undefined' || transid === 'null') throw new StoreShapeError('inittransaction returned no transid');

  // 6) getfinalprice marks the external transaction and reports the FINAL ORDER AMOUNT. This is the only
  //    place where the operator's intent meets what Steam will actually charge — a stale cart, a tier we
  //    misparsed or a Steam-side change all surface here as a mismatch, and a mismatch is a HARD refusal
  //    (no browser, no charge). Its EResult is checked like every other money response.
  const fp = await ctx.post(`${CHECKOUT_ORIGIN}/checkout/getfinalprice/`, { count: '1', transid, purchasetype: 'self', microtxnid: '-1', cart: gidShoppingCart, gidReplayOfTransID: '-1', bUseAccountCart, sessionid: checkoutSid }, { referer: checkoutUrl });
  if (fp.status !== 200) throw new StoreHttpError(fp.status, `getfinalprice → ${fp.status}`);
  const fo = requireJsonObject(fp.data, 'getfinalprice');
  const fpSuccess = requireEResult(fo);
  if (fpSuccess !== 1) {
    logger.warn(`[paysafe] ${username}: getfinalprice failed EResult=${fpSuccess} (cart=${gidShoppingCart} transid=${transid})`);
    throw new StoreShapeError(`getfinalprice returned EResult ${fpSuccess} — the order was not priced, so nothing was opened`);
  }
  assertOrderAmount(username, fo, amountMinor, warnings);

  // 7) The externallink URL is constructible from transid alone (Steam's PerformExternalFinalizeTransaction
  //    does exactly this) and is our trusted default. Steam's own `externalurl` is used ONLY when it is an
  //    https Steam host — never an arbitrary URL out of a JSON field.
  let externalUrl = `${CHECKOUT_ORIGIN}/checkout/externallink/?transid=${encodeURIComponent(transid)}`;
  const fpUrl = typeof fo.externalurl === 'string' ? fo.externalurl : '';
  if (fpUrl && isSteamHttpsUrl(fpUrl)) externalUrl = fpUrl;
  else if (fpUrl) warnings.push('Steam returned an unexpected payment URL — using its standard checkout link instead.');

  logger.info(`[paysafe] ${username}: checkout ready — amount=${amountMinor} EUR-minor cart=${gidShoppingCart}/${bUseAccountCart} transid=${transid}`);
  return { transid, externalUrl, walletMinor, warnings };
}

/** Steam wallet → EUR minor units (euro-cents), or null when it is not a readable EUR balance.
 *  `hasWallet:false` is a real zero (a wallet with no funds reports currency 0), which is what lets a
 *  first-ever top-up be confirmed. A non-EUR wallet returns null and therefore classifies as
 *  `unconfirmed` — never a guessed credit. steam-user hands `balance` in MAJOR units for 2-dp currencies. */
export function walletEurMinor(w?: { hasWallet: boolean; currency: number; balance: number }): number | null {
  if (!w) return null;
  if (!w.hasWallet) return 0;
  if (w.currency !== PAYSAFE_CURRENCY_CODE) return null;
  if (typeof w.balance !== 'number' || !Number.isFinite(w.balance) || w.balance < 0) return null;
  return Math.round(w.balance * 100);
}

/** Assert the amount Steam is about to charge equals the amount the operator confirmed.
 *  `base` is the order subtotal (what an accumulated cart would inflate); `total` is what is charged.
 *  Either mismatching is a hard refusal. If Steam reports NEITHER, we cannot verify and say so loudly
 *  rather than pretend — the operator still sees the real amount on paysafecard's own page. */
export function assertOrderAmount(username: string, fo: Record<string, unknown>, amountMinor: number, warnings: string[]): void {
  const base = parseMinorUnits(fo.base);
  const total = parseMinorUnits(fo.total);
  const bad = (field: string, got: number): never => {
    logger.warn(`[paysafe] ${username}: REFUSED — Steam's order ${field}=${got} minor units, operator confirmed ${amountMinor}`);
    throw new StoreShapeError(
      `Steam's order total (${(got / 100).toFixed(2)} €) does not match the amount you chose (${(amountMinor / 100).toFixed(2)} €). ` +
      `Nothing was opened and nothing was charged. An earlier, unpaid top-up may still be sitting in this account's Steam cart — empty it, then retry.`,
    );
  };
  if (base != null && base !== amountMinor) bad('base', base);
  if (total != null && total !== amountMinor) {
    if (base == null) bad('total', total);
    warnings.push(`Steam's charge (${(total / 100).toFixed(2)} €) differs from the top-up amount (${(amountMinor / 100).toFixed(2)} €) — check the figure on the paysafecard page before paying.`);
  }
  if (base == null && total == null) warnings.push('Steam did not report an order total, so the amount could not be verified in advance — check the figure on the paysafecard page before paying.');
}
