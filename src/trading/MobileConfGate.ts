import { logger } from '../utils/logger';
import { classifyNetworkError } from '../utils/errorClass';

// ════════════════════════════════════════════════════════════════════════════
//  MobileConfGate — per-account discipline for steamcommunity mobileconf/getlist
//  (2026-07-10 root-cause fix for Problem B).
//
//  Steam meters mobileconf PER ACCOUNT (~5 ops/min observed trip point; no parallel
//  ops tolerated) — far tighter than inventory. SSIM has three callers that overlap
//  on one account: the mass-sell confirm, the SDA panel, and the CSFloat auto-accept
//  worker. Un-coordinated, they each spend a getlist (and the old confirm path spent
//  one ajaxop PER LISTING). This gate makes getlist SINGLE-FLIGHT (concurrent callers
//  share one request), lets display/poll callers reuse a short SNAPSHOT, and LATCHES a
//  cooldown after a 429 so a rate-limit window is waited out, not hammered.
//
//  Freshness classes:
//   • 'recent' — a slightly-stale list is fine (SDA view, auto-accept poll): serve an
//                ≤RECENT_TTL snapshot with no network; serve a stale one during a 429
//                cooldown rather than fail the panel.
//   • 'fresh'  — must reflect the live list (a confirm must act on a current getlist):
//                never a snapshot; coalesces onto an in-flight fetch (single-flight);
//                during a 429 cooldown it throws the 429 so the caller backs off.
//
//  Money-safety: 'fresh' is what every ACT-on-confirmations path uses, and all such
//  callers are idempotent (getlist only ever returns still-pending confirmations, and
//  each caller re-fetches on its own retry), so coalescing/snapshots never cause a
//  genuinely-pending listing to go unconfirmed — the next pass re-reads truth.
// ════════════════════════════════════════════════════════════════════════════

export type ConfFreshness = 'recent' | 'fresh';
export interface ConfList { off: number; confs: any[]; } // eslint-disable-line @typescript-eslint/no-explicit-any

const RECENT_TTL_MS  = 8_000;   // a 'recent' caller accepts a snapshot this fresh without a network read
// ESCALATING cooldown after a mobileconf 429 (2026-07-10, revised): a FLAT 60s cooldown resonated with the
// SDA panel's 60s auto-retry — every probe landed right as the window reopened and RE-ARMED Steam's
// per-account limit, so a burned account never got a quiet interval to clear. The cooldown now DOUBLES per
// consecutive 429 (60→120→240→480→900s cap) with jitter, so successive probes land progressively LATER —
// eventually well after Steam's window has cleared instead of on its boundary. A successful getlist resets it.
const RL_BASE_MS   = 60_000;
const RL_CAP_MS    = 900_000;   // 15 min ceiling
const RL_JITTER_MS = 15_000;    // de-sync + break the boundary phase-lock

export class MobileConfGate {
  private snapshot?: { at: number; data: ConfList };
  private inFlight?: Promise<ConfList>;
  private rlUntil = 0;
  // Consecutive network 429s → escalates the cooldown. Reset to 0 on any successful getlist (the clean
  // signal Steam's window cleared). Per-trader + reset on re-login/session destroy, so it never leaks.
  private consecutive429 = 0;

  /** `now` + `rand` are injectable for tests; production passes the real clock + Math.random. */
  constructor(
    private readonly username: string,
    private readonly doFetch: () => Promise<ConfList>,
    private readonly now: () => number = Date.now,
    private readonly rand: () => number = Math.random,
  ) {}

  /** ms remaining in the current 429 cooldown (0 when clear) — the route sends this as Retry-After. */
  cooldownRemainingMs(): number { return Math.max(0, this.rlUntil - this.now()); }

  async get(freshness: ConfFreshness): Promise<ConfList> {
    const now = this.now();
    // 'recent' served straight from a fresh-enough snapshot — zero network.
    if (freshness === 'recent' && this.snapshot && now - this.snapshot.at <= RECENT_TTL_MS) return this.snapshot.data;
    // Single-flight: any concurrent caller (fresh or recent) rides the one in-flight getlist.
    if (this.inFlight) return this.inFlight;
    // 429 cooldown latch: don't spend a getlist inside the window (this cheap throw is what makes a mashed
    // "Retry now" harmless — it never reaches Steam, so it cannot re-arm the limit).
    if (now < this.rlUntil) {
      if (freshness === 'recent' && this.snapshot) return this.snapshot.data; // stale beats failing the panel
      throw this.rateLimitError(Math.ceil((this.rlUntil - now) / 1000));
    }
    this.inFlight = this.fetchOnce();
    return this.inFlight;
  }

  private async fetchOnce(): Promise<ConfList> {
    try {
      const data = await this.doFetch();
      this.consecutive429 = 0;          // a clean getlist means the window cleared — reset the escalation
      this.snapshot = { at: this.now(), data };
      return data;
    } catch (err) {
      if (classifyNetworkError(err).rateLimited) {
        this.consecutive429++;
        const backoff = Math.min(RL_BASE_MS * 2 ** (this.consecutive429 - 1), RL_CAP_MS);
        const wait = backoff + Math.floor(this.rand() * RL_JITTER_MS);
        this.rlUntil = this.now() + wait;
        const secs = Math.ceil(wait / 1000);
        (err as { retryAfterSeconds?: number }).retryAfterSeconds = secs;
        logger.warn(`[mobileconf] ${this.username}: getlist rate-limited (429) — cooling down ${secs}s ` +
          `(attempt ${this.consecutive429}; per-account limit — re-checking too soon keeps it armed, so the wait escalates)`);
      }
      throw err;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** A rate-limit error the classifier recognizes (message carries 429) AND that carries the exact
   *  remaining wait, so the route's Retry-After is honest instead of a hardcoded 60s. */
  private rateLimitError(retryAfterSeconds: number): Error {
    const err = new Error(`HTTP error 429 (mobileconf cooling down for ${this.username}, retry in ~${retryAfterSeconds}s)`);
    (err as { retryAfterSeconds?: number }).retryAfterSeconds = retryAfterSeconds;
    return err;
  }

  /** Drop the cached snapshot so the next 'recent' read re-fetches — call right after acting on
   *  confirmations, so a following SDA view reflects the now-cleared list instead of a stale one. */
  invalidate(): void { this.snapshot = undefined; }
}
