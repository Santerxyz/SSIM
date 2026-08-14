import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  W4_40 — PaysafeService (Track B): SEQUENTIAL, human-in-the-loop paysafecard top-up.
//
//  The whole flow is browser-driven (owner 2026-07-09): SSIM opens each account's store
//  addfunds checkout pre-authenticated through the account's proxy; the OPERATOR enters the
//  PIN + any captcha ON THE PAGE. So SSIM NEVER handles the PIN (it lives only in the
//  browser) — SSIM's job is purely: sequence the accounts, and RECONCILE by reading the wallet.
//
//  Money-safety:
//   • SSIM fires NO money op itself (the operator completes each in the browser, and a paysafecard
//     PIN is single-use), so there is no double-spend to journal — the safety is truthful
//     reconciliation, not dedup.
//   • EUR-ONLY (owner 2026-07-10). Every amount here — the tier, the baseline, the read-back and the
//     threshold — is EURO-CENTS. Nothing is converted. The previous design normalised balances to USD
//     through a live fx rate, so a rate that moved between the baseline read and the read-back
//     manufactured a phantom "credit" on any large wallet. Reconciling in the account's native unit
//     removes that class of bug outright rather than papering over it.
//   • Each account records a wallet BASELINE before its checkout opens; a wallet read-back CLASSIFIES
//     the outcome. `credited` requires an observed rise INSIDE a band around the amount — too small is
//     `unconfirmed` (not yet credited), and too LARGE is also `unconfirmed` (a double-charged cart, or
//     an unrelated credit such as a market sale landing mid-run: a balance delta cannot attribute
//     itself to this transaction, so we refuse to pretend it can).
//   • Steam may hold the credit "pending" up to ~24h; an `unconfirmed` account is surfaced for the
//     operator to re-verify or check on Steam, never silently marked funded.
//
//  Reads are CHEAP: the account's session is left resident and Steam PUSHES wallet updates to it, so
//  the credit poll reads memory. A full re-login is forced only every FORCE_LOGIN_EVERY-th check (and
//  on a deliberate settle) as a staleness backstop — the previous design re-logged in on every 15s
//  tick, i.e. up to 24 destroy+handshake cycles per account, which risks Steam login throttling and is
//  exactly the CM-socket teardown storm implicated in the 0xC0000409 native fast-fail.
//
//  Exactly one run at a time (you can only drive one browser at once). Gated: SSIM_PAYSAFE_EXPERIMENTAL
//  — only =0 hard-disables it.
// ════════════════════════════════════════════════════════════════════════════

/** Auto-advance (owner 2026-07-10): poll the wallet after each open; when the credit lands, settle the
 *  account 'credited' and open the NEXT one with no operator click. ~15s × 24 ≈ 6 min of watching, then
 *  it gives up and the operator verifies manually. Ticks are self-rescheduled (never a setInterval), so
 *  a slow check can't queue a backlog of overlapping polls. */
export const PAYSAFE_AUTO_POLL_MS = 15_000;
const AUTO_POLL_MAX = 24;
/** Every Nth credit check re-logs in rather than reading the resident session, so a session that stopped
 *  receiving Steam's wallet push can't silently freeze the poll. 6 × 15s ⇒ at most 4 logins per account. */
const FORCE_LOGIN_EVERY = 6;

/** Amount guard rails, in EURO-CENTS. The CEILING is money-safety (a fat-fingered "50000" must not become a
 *  €50 000 checkout) and is enforced both here and at the route. The FLOOR is a product rule (Steam's
 *  smallest real top-up) and is enforced at the route only — startBatch deliberately accepts any positive
 *  amount so the classifier's `max(1, …)` lower-bound stays exercisable down to a single cent. */
export const PAYSAFE_MIN_MINOR = 100;        // €1.00
export const PAYSAFE_MAX_MINOR = 100_000;    // €1000.00 — paysafecard's per-transaction ceiling

/** Credit-classification band, as a fraction of the intended amount. */
const CREDIT_LO = 0.9;   // fee/rounding tolerance
const CREDIT_HI = 1.1;   // above this the rise cannot be attributed to this top-up

export type PaysafeAcctStatus = 'awaiting' | 'credited' | 'unconfirmed' | 'skipped' | 'error';

export interface PaysafeAcctResult {
  username: string;
  amountMinor: number;
  baselineMinor: number | null;
  observedCreditMinor: number | null;
  status: PaysafeAcctStatus;
  detail: string;
  proxy: string | null;
}

export interface PaysafeSession {
  running: boolean;
  /** True once a stop has been requested but an in-flight step still owns the run. */
  stopping: boolean;
  amountMinor: number;           // EURO-CENTS — the checkout amount and the credit-threshold basis
  currency: number;              // always 3 (EUR); carried so the UI never has to guess
  index: number;                 // 0-based index of the CURRENT account
  total: number;
  queue: string[];               // usernames, in order
  results: PaysafeAcctResult[];  // grows as accounts open/finish; results[i] pairs with queue[i]
  startedAt: number;
  finishedAt: number | null;
}

/** Duck-typed collaborators — structural so PaysafeService stays decoupled + unit-testable. */
export interface PaysafeDeps {
  /** Headlessly init a paysafecard top-up for `username` at the chosen amount (EURO-CENTS), then open the
   *  clean browser DIRECTLY on the paysafecard page (via Steam's externallink). No Steam DOM is driven.
   *  Returns the wallet balance AT OPEN TIME (euro-cents) as the reconcile baseline. Throws → 'error',
   *  and because it throws before any browser opens, no charge can occur. */
  openCheckout(username: string, checkout: { amountMinor: number }): Promise<{ warnings: string[]; proxy: string | null; walletMinor: number | null }>;
  /** The account's wallet balance in EURO-CENTS, or null when unknown/non-EUR (→ `unconfirmed`, never a
   *  false credit). `allowLogin:false` must not re-login: it reads the resident session Steam pushes
   *  balance updates to. `allowLogin:true` may force a fresh login as a staleness backstop. */
  readWalletMinor(username: string, opts: { allowLogin: boolean }): Promise<number | null>;
  /** Release any Steam session this feature created for `username` (called once we're done with it), so a
   *  long batch cannot walk the fleet into the resident-session ceiling. Never touches a session another
   *  operation owns. */
  releaseAccount(username: string): Promise<void>;
  /** Experimental flag gate (SSIM_PAYSAFE_EXPERIMENTAL !== '0'). */
  enabled(): boolean;
}

export class PaysafeService {
  private session: PaysafeSession | null = null;
  private busy = false;            // guards the MUTATING steps (open/settle/advance) against re-entrancy
  private polling = false;         // guards the read-only credit poll against overlapping itself
  private stopRequested = false;   // set by stop() while a step is in-flight → that step drains it
  private autoTimer?: NodeJS.Timeout;
  private autoChecks = 0;          // completed credit checks for the CURRENT account (reset on each open)
  /** `autoPollMs > 0` enables the background credit poll (production). Tests pass 0 and drive
   *  checkAndAutoAdvance() directly, so no background timer fires during a unit test. */
  constructor(private readonly deps: PaysafeDeps, private readonly now: () => number = () => Date.now(), private readonly autoPollMs = 0) {}

  status(): PaysafeSession | null { return this.session; }

  /** App teardown / license re-gate: stop the auto-poll and drop all in-memory state. Leaving
   *  `stopRequested` set here would poison the next run (it would end after its first account). */
  shutdown(): void {
    this.clearAuto();
    this.session = null;
    this.busy = false;
    this.polling = false;
    this.stopRequested = false;
  }

  private ensureEnabled(): void {
    if (!this.deps.enabled()) throw Object.assign(new Error('paysafecard top-up is hard-disabled (SSIM_PAYSAFE_EXPERIMENTAL=0)'), { status: 501 });
  }

  /** Truthful classification — the money-truth. `credited` requires an observed rise INSIDE the band; a
   *  rise that is too small (not yet credited) or too large (a double-charged cart, or an unrelated
   *  credit) is `unconfirmed`. A balance delta cannot prove WHICH transaction moved it, so anything the
   *  band cannot vouch for is handed to the operator rather than guessed at. */
  private classify(baseline: number | null, after: number | null, amountMinor: number): { status: PaysafeAcctStatus; detail: string; credit: number | null } {
    if (baseline == null || after == null) return { status: 'unconfirmed', detail: 'wallet balance not readable — verify the credit on Steam.', credit: null };
    const rise = after - baseline;
    const eur = (m: number): string => `${(m / 100).toFixed(2)} €`;
    // MONEY-SAFETY: floor the lower bound at 1 cent — for a tiny amount (e.g. 1), Math.floor(0.9) = 0
    // would make a ZERO rise "credited". A real credit always moves the balance by ≥1 cent.
    const lo = Math.max(1, Math.floor(amountMinor * CREDIT_LO));
    const hi = Math.max(lo, Math.ceil(amountMinor * CREDIT_HI));
    if (rise >= lo && rise <= hi) return { status: 'credited', detail: `wallet credited (+${eur(rise)} observed).`, credit: rise };
    if (rise > hi) return { status: 'unconfirmed', detail: `balance rose ${eur(rise)} — MORE than the ${eur(amountMinor)} top-up. SSIM will not claim this as credited: check this account's Steam cart and purchase history for a duplicate charge.`, credit: rise };
    if (rise > 0) return { status: 'unconfirmed', detail: `balance rose ${eur(rise)} (below the expected top-up) — Steam may still be crediting; verify on Steam.`, credit: rise };
    return { status: 'unconfirmed', detail: 'no wallet credit observed yet — Steam may hold it up to ~24h; verify on Steam later.', credit: 0 };
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────

  /** End the run. Clearing `stopRequested` here is what stops a deferred stop from leaking into the next
   *  run (which would otherwise terminate after its very first account). */
  private finish(): void {
    const s = this.session;
    this.clearAuto();
    this.stopRequested = false;
    if (!s || !s.running) return;
    s.running = false;
    s.stopping = false;
    s.finishedAt = this.now();
  }

  /** Consume a stop() that arrived while this step was in-flight: settle whatever account is currently
   *  open (so a just-opened checkout is never abandoned un-verified) and end the run. Called at the tail
   *  of every mutating step, while `busy` is still held. */
  private async drainStop(): Promise<void> {
    if (!this.stopRequested) return;
    const s = this.session;
    if (!s || !s.running) { this.stopRequested = false; return; }
    if (s.results[s.index]?.status === 'awaiting') await this.settleCurrent(false);
    await this.releaseCurrent();
    this.finish();
  }

  /** Open the CURRENT account's checkout + record its baseline. Writes results[index]. */
  private async openCurrent(): Promise<void> {
    const s = this.session!;
    const u = s.queue[s.index];
    let baseline: number | null = null, proxy: string | null = null, detail = '', status: PaysafeAcctStatus = 'awaiting';
    try {
      const r = await this.deps.openCheckout(u, { amountMinor: s.amountMinor });
      baseline = r.walletMinor;
      proxy = r.proxy;
      detail = `paysafecard page open${r.proxy ? ` via ${r.proxy}` : ' on LOCAL IP'} — enter the code + captcha in the browser; SSIM confirms the credit automatically.`;
      if (r.warnings.length) detail += ` (${r.warnings.join(' ')})`;
      for (const w of r.warnings) logger.warn(`[paysafe] ${u}: ${w}`);
    } catch (e) {
      status = 'error';
      detail = `could not open the checkout: ${(e as Error).message}`;
    }
    s.results[s.index] = { username: u, amountMinor: s.amountMinor, baselineMinor: baseline, observedCreditMinor: null, status, detail, proxy };
  }

  /** Verify the CURRENT account (read-back) unless skipping, then annotate its result in place. A settle is
   *  a deliberate, one-off verification, so it may force a fresh login. */
  private async settleCurrent(skip: boolean): Promise<void> {
    const s = this.session!;
    const cur = s.results[s.index];
    if (!cur || cur.status !== 'awaiting') return;   // already error/settled → leave as-is
    if (skip) { cur.status = 'skipped'; cur.detail = 'skipped by the operator (no credit verification).'; return; }
    const after = await this.deps.readWalletMinor(cur.username, { allowLogin: true }).catch(() => null);
    const c = this.classify(cur.baselineMinor, after, s.amountMinor);
    cur.status = c.status; cur.detail = c.detail; cur.observedCreditMinor = c.credit;
  }

  /** Hand back the Steam session this feature opened for the current account. */
  private async releaseCurrent(): Promise<void> {
    const s = this.session;
    const u = s?.queue[s.index];
    if (!u) return;
    try { await this.deps.releaseAccount(u); }
    catch (e) { logger.warn(`[paysafe] ${u}: session release failed: ${(e as Error).message}`); }
  }

  /** Open accounts from the current index until one is actually WAITING on the operator, or the queue is
   *  exhausted. An account whose checkout failed to open has no browser to wait for, so the run steps
   *  straight over it instead of stranding on a dead entry. */
  private async openUntilOpenedOrDone(): Promise<void> {
    const s = this.session!;
    for (;;) {
      await this.openCurrent();
      if (s.results[s.index]?.status === 'awaiting') {
        if (!this.stopRequested) { this.autoChecks = 0; this.scheduleAuto(); }
        return;                                   // browser is up — wait for the credit (or drainStop)
      }
      await this.releaseCurrent();                // 'error' — nothing opened for this account
      if (this.stopRequested) return;             // drainStop ends the run
      s.index++;
      if (s.index >= s.total) { this.finish(); return; }
    }
  }

  /** Done with the current account → release it and open the next, or finish the run. */
  private async openNextOrFinish(): Promise<void> {
    const s = this.session!;
    await this.releaseCurrent();
    if (this.stopRequested) return;               // drainStop ends the run — do not open another browser
    s.index++;
    if (s.index >= s.total) { this.finish(); return; }
    await this.openUntilOpenedOrDone();
  }

  // ── Auto-advance (background credit poll) ──────────────────────────────────
  private clearAuto(): void {
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = undefined; }
  }
  /** Self-rescheduling (never setInterval): a check that outlives the interval cannot queue a backlog. */
  private scheduleAuto(): void {
    this.clearAuto();
    if (this.autoPollMs <= 0) return;   // disabled (tests)
    this.autoTimer = setTimeout(() => { void this.autoPollTick(); }, this.autoPollMs);
    this.autoTimer.unref?.();
  }
  private async autoPollTick(): Promise<void> {
    this.autoTimer = undefined;
    const s = this.session;
    if (!s?.running) return;
    if (this.autoChecks >= AUTO_POLL_MAX) {
      const cur = s.results[s.index];
      if (cur?.status === 'awaiting') cur.detail += ' (SSIM stopped watching for the credit — use "I\'ve paid" to verify.)';
      logger.warn(`[paysafe] ${s.queue[s.index]}: gave up auto-watching after ${AUTO_POLL_MAX} checks — the operator verifies manually`);
      return;
    }
    try { await this.checkAndAutoAdvance(); }
    catch (e) { logger.warn(`[paysafe] credit poll failed: ${(e as Error).message}`); }
    if (this.session?.running && this.session.results[this.session.index]?.status === 'awaiting') this.scheduleAuto();
  }

  /** Read the current account's wallet; if the credit LANDED, settle it 'credited' and open the next
   *  account with no operator click. `polling` stops two reads overlapping; `busy` stops it racing a
   *  manual step; and the post-await identity re-check catches a manual step that ran meanwhile.
   *  Exposed so unit tests drive it directly. */
  async checkAndAutoAdvance(): Promise<void> {
    const s = this.session;
    if (!s?.running || this.busy || this.polling) return;
    if (!this.deps.enabled()) {
      // Kill switch flipped mid-run. Ending the run is not enough: the account whose checkout is open must
      // still be settled (the operator may already have paid) and its session released. Same tail as stop().
      this.busy = true;
      try { await this.settleCurrent(false); await this.releaseCurrent(); } finally { this.busy = false; }
      this.finish();
      return;
    }
    const cur = s.results[s.index];
    if (!cur || cur.status !== 'awaiting') return;

    this.autoChecks++;
    const allowLogin = this.autoChecks % FORCE_LOGIN_EVERY === 0;   // periodic staleness backstop
    this.polling = true;
    let after: number | null = null;
    try { after = await this.deps.readWalletMinor(cur.username, { allowLogin }); }
    catch { after = null; }
    finally { this.polling = false; }

    // State may have changed across the await (a manual advance/stop settled or moved on).
    if (!s.running || this.busy || s.results[s.index] !== cur || cur.status !== 'awaiting') return;
    const c = this.classify(cur.baselineMinor, after, s.amountMinor);
    if (c.status !== 'credited') return;   // not credited yet → keep polling

    this.busy = true;
    try {
      cur.status = 'credited'; cur.detail = c.detail; cur.observedCreditMinor = c.credit;
      await this.openNextOrFinish();
      await this.drainStop();
    } finally { this.busy = false; }
  }

  // ── Batch (sequential) ─────────────────────────────────────────────────────
  async startBatch(usernames: string[], amountMinor: number): Promise<PaysafeSession> {
    this.ensureEnabled();
    if (this.busy || this.session?.running) throw Object.assign(new Error('a paysafecard run is already in progress — finish or stop it first'), { status: 409 });
    const queue = [...new Set(usernames.map((u) => u.toLowerCase()).filter(Boolean))];
    if (!queue.length) throw Object.assign(new Error('no accounts selected'), { status: 400 });
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw Object.assign(new Error('amount must be a whole number of euro-cents > 0'), { status: 400 });
    if (amountMinor > PAYSAFE_MAX_MINOR) throw Object.assign(new Error(`amount exceeds the ${(PAYSAFE_MAX_MINOR / 100).toFixed(2)} € per-top-up ceiling`), { status: 400 });

    this.stopRequested = false;   // a fresh run never inherits a previous run's deferred stop
    this.session = { running: true, stopping: false, amountMinor, currency: 3, index: 0, total: queue.length, queue, results: [], startedAt: this.now(), finishedAt: null };
    this.busy = true;
    try {
      await this.openUntilOpenedOrDone();
      await this.drainStop();     // a stop() that landed while account[0]'s checkout was opening
    } finally { this.busy = false; }
    return this.session!;
  }

  /** Settle the current account (verify unless `skip`), then open the next — or finish the run. A manual
   *  advance SUPERSEDES the background poll (clearAuto), and openUntilOpenedOrDone re-arms it for the next
   *  account. Honors a stop() that arrives WHILE this is in-flight (drainStop). */
  async advance(opts: { skip?: boolean } = {}): Promise<PaysafeSession> {
    this.ensureEnabled();
    const s = this.session;
    if (!s) throw Object.assign(new Error('no paysafecard run in progress'), { status: 409 });
    if (!s.running) return s;   // the auto-poll already credited + finished it — report, don't 409
    if (this.busy) throw Object.assign(new Error('busy — the previous step is still running'), { status: 409 });
    this.busy = true;
    this.clearAuto();
    try {
      await this.settleCurrent(!!opts.skip);   // the just-completed account is always verified/skipped
      await this.openNextOrFinish();
      await this.drainStop();
      return s;
    } finally { this.busy = false; }
  }

  /** Stop the run — settles the current account (verify) so its outcome isn't lost. If a step is IN-FLIGHT
   *  (busy/polling), defer to it via stopRequested; that step's drainStop settles the current account
   *  exactly once and ends the run. `stopping` tells the UI the stop was accepted even though the session
   *  it gets back still reads `running: true`. */
  async stop(): Promise<PaysafeSession | null> {
    const s = this.session;
    if (!s?.running) return this.session;
    this.clearAuto();
    // Defer ONLY on `busy` — i.e. on a step that MUTATES the run, every one of which drains stopRequested
    // at its tail. A read-only poll (`polling`) is not deferred to: it never settles anything before it
    // takes `busy`, and it would simply return on a no-credit read, leaving the stop request undrained
    // and the run alive forever.
    if (this.busy) { this.stopRequested = true; s.stopping = true; return this.session; }
    this.busy = true;
    try {
      await this.settleCurrent(false);
      await this.releaseCurrent();
    } finally { this.busy = false; }
    this.finish();
    return this.session;
  }

  // ── Single account (wallet card) = a 1-account run through the same machinery ──
  async openOne(username: string, amountMinor: number): Promise<PaysafeSession> {
    return this.startBatch([username], amountMinor);
  }
  /** Verify + finish a single-account run (total=1 → advance settles and finishes). */
  async verifyOne(): Promise<PaysafeSession> {
    return this.advance({ skip: false });
  }
}
