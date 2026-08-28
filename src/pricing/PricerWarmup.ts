import type { AccountConfig } from '../types/account';
import { proxyKey } from '../network/ProxyHealth';
import { LOCAL_EGRESS } from './PricerIdentityPool';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  PricerWarmup — brings a few accounts up so the price fill can run its FAST
//  multi-lane path instead of falling back to one anonymous lane.
//
//  THE GAP (owner report 2026-08-27): the fill prefers authenticated identity lanes,
//  each riding a logged-in account's cookie over that account's own proxy. It asks
//  SessionManager for those identities — but SessionManager only ever offers sessions
//  that are ALREADY live. On a fleet sitting idle (boot, or after the 30-min reaper) the
//  answer is always an empty list, so the fill deferred for its grace, found nothing had
//  changed, and dropped to the single anonymous lane. Every time. The multi-lane path
//  existed but could only engage by luck — if the operator happened to have accounts
//  logged in for some other reason.
//
//  WHY SPREAD ACROSS EXITS. Steam meters the price endpoint per EXIT IP, so throughput is
//  set by how many distinct IPs the fill has, not how many accounts. Six accounts on six
//  proxies each get their own budget (~1.17s per request); six accounts behind ONE proxy
//  share a single budget and are paced back to exactly the old speed. So selection takes
//  ONE account per exit before it takes a second from any — the difference between an
//  18x fill and no change at all.
//
//  RANDOM WITHIN AN EXIT, on purpose (owner). Always warming the same account would make
//  one bot carry the entire fleet's price traffic; picking randomly spreads that load and
//  keeps any single account's request pattern unremarkable.
//
//  FAIL-SAFE BY CONSTRUCTION. This never blocks a fill and never throws into one: the
//  anonymous fallback is armed BEFORE warm-up is asked for, so if every login fails the
//  fill still happens on the slow path exactly as it does today. A successful login fires
//  SessionManager's 'webSession' -> PricingService.kick(), which cancels that fallback and
//  starts the authenticated fill — the existing machinery, unchanged.
// ════════════════════════════════════════════════════════════════════════════

/** Accounts to bring up when the fill has no identity. Enough exits to be worth the logins,
 *  few enough that an idle dashboard does not log half the fleet in. */
export const DEFAULT_WARMUP_ACCOUNTS = 6;

/** Do not re-attempt within this window. A fleet whose proxies are all down would otherwise
 *  retry a full warm-up on every deferred fill, forever. */
export const WARMUP_COOLDOWN_MS = 120_000;

/** The exit an account would leave through — the same derivation SessionManager.pricerIdentities
 *  uses for a LIVE session, so a warmed account lands in the exit bucket it was picked for. */
export function exitKeyFor(account: AccountConfig): string {
  const net = account.network;
  if (net?.type !== 'proxy') return LOCAL_EGRESS;
  return `proxy:${proxyKey(net.value) ?? net.value}`;
}

/**
 * Picks up to `want` accounts, ONE PER EXIT before any exit gets a second, choosing randomly
 * within each exit. Pure and rand-injectable so the spread is testable without a fleet.
 *
 * Skips: disabled accounts, accounts with no resolved network (the pool-lost case — logging one
 * in would leak the host IP, and SessionManager refuses it anyway), and accounts already live
 * (they are already candidates; re-logging one would destroy and recreate a working session).
 */
export function pickWarmupAccounts(
  accounts: AccountConfig[],
  isLive:   (username: string) => boolean,
  want:     number,
  rand:     () => number = Math.random,
): AccountConfig[] {
  if (want <= 0) return [];
  const byExit = new Map<string, AccountConfig[]>();
  for (const a of accounts) {
    if (!a.enabled || !a.network || isLive(a.username)) continue;
    const key = exitKeyFor(a);
    const list = byExit.get(key);
    if (list) list.push(a); else byExit.set(key, [a]);
  }
  if (byExit.size === 0) return [];

  // Shuffle each exit's members, and the exit order itself, so neither the account list's order
  // nor the proxy list's decides who carries the price traffic.
  const shuffle = <T>(xs: T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const queues = shuffle([...byExit.values()].map(shuffle));

  // Round-robin: take one account from every exit before returning to the first.
  const picked: AccountConfig[] = [];
  for (let round = 0; picked.length < want; round++) {
    let tookAny = false;
    for (const q of queues) {
      if (picked.length >= want) break;
      if (round < q.length) { picked.push(q[round]); tookAny = true; }
    }
    if (!tookAny) break; // every exit exhausted
  }
  return picked;
}

export interface PricerWarmupDeps {
  /** Enabled accounts with their network resolved (AccountManager.getAll). */
  accounts: () => AccountConfig[];
  isLive:   (username: string) => boolean;
  login:    (account: AccountConfig) => Promise<unknown>;
  now?:     () => number;
  rand?:    () => number;
}

/**
 * Owns the cooldown and runs the logins in the BACKGROUND. `request()` returns immediately with
 * the number of logins it started, so the caller (a deferring fill) is never slowed by it.
 */
export class PricerWarmup {
  private lastAttemptAt = 0;
  private inFlight = false;
  private readonly now: () => number;
  private readonly rand: () => number;

  constructor(private readonly deps: PricerWarmupDeps, private readonly cooldownMs = WARMUP_COOLDOWN_MS) {
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? Math.random;
  }

  /** Starts a warm-up if one is not running and the cooldown has passed. Returns how many logins
   *  were started (0 = nothing to do, cooling down, or already warming). Never throws. */
  request(want = DEFAULT_WARMUP_ACCOUNTS): number {
    if (this.inFlight) return 0;
    const t = this.now();
    if (this.lastAttemptAt !== 0 && t - this.lastAttemptAt < this.cooldownMs) return 0;

    let picked: AccountConfig[];
    try {
      picked = pickWarmupAccounts(this.deps.accounts(), this.deps.isLive, want, this.rand);
    } catch (err) {
      logger.warn(`[pricing] warm-up could not choose accounts: ${(err as Error).message}`);
      return 0;
    }
    if (picked.length === 0) return 0;

    this.lastAttemptAt = t;
    this.inFlight = true;
    const exits = new Set(picked.map(exitKeyFor)).size;
    logger.info(`[pricing] warming up ${picked.length} account(s) across ${exits} exit(s) to open authenticated price lanes: ` +
      picked.map((a) => a.username).join(', '));

    void this.runLogins(picked);
    return picked.length;
  }

  private async runLogins(picked: AccountConfig[]): Promise<void> {
    try {
      const results = await Promise.allSettled(picked.map((a) => this.deps.login(a)));
      let ok = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') { ok++; return; }
        // A warm-up login failing is NOT a fill failure — the anonymous fallback is already armed.
        // Warn (not error) so a flaky proxy is visible without looking like the fill broke.
        logger.warn(`[pricing] warm-up login failed for ${picked[i].username}: ${(r.reason as Error)?.message ?? r.reason}`);
      });
      logger.info(`[pricing] warm-up finished: ${ok}/${picked.length} account(s) logged in` +
        (ok > 0 ? ' — the authenticated fill starts on their web session' : ' — the fill stays on the anonymous fallback'));
    } finally {
      this.inFlight = false;
    }
  }
}
