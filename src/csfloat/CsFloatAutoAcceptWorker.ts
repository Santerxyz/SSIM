import { scaleConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { armInterval } from '../utils/intervalGuard';
import { AppSettings } from '../core/AppSettings';
import { canConfirm } from '../core/accountCapability';
import { identitySecretPresence } from '../core/LoginFlow';
import { CsFloatDeliveredStore } from './CsFloatDeliveredStore';
import type { AccountManager } from '../core/AccountManager';
import type { TradeService } from '../trading/TradeService';
import type { CsFloatService } from './CsFloatService';

// ════════════════════════════════════════════════════════════════════════════
//  CsFloatAutoAcceptWorker — per-account auto-delivery of CSFloat sales (Feature 2,
//  experimental). Polls each ENABLED + FULL-tier account's pending CSFloat sale
//  trades and delivers them by REUSING TradeService.sendTrade() (which sends the
//  Steam offer and confirms it via the account's maFile — no duplicated confirm
//  logic). Limited-tier accounts are skipped (no identity_secret → cannot confirm).
//
//  Bounded (scaleConcurrency), never overlaps a pass, logs every action, survives
//  restarts (the per-account toggle persists in AppSettings → resumed on boot).
//  The CSFloat trades payload is UNDOCUMENTED, so delivery-detail extraction is
//  best-effort: a trade we can't parse is logged + skipped, never mis-delivered.
// ════════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 45_000;

/** What happened to one trade in a delivery pass — the manual job's per-row outcome. */
export interface CsFloatDeliverResult {
  tradeId: string;
  name?:   string;
  /** `sent` = Steam offer created AND 2FA-confirmed · `unconfirmed` = offer exists, needs manual
   *  confirmation (NEVER auto-resent) · `skipped` = nothing was sent · `failed` = Steam refused. */
  status:  'sent' | 'unconfirmed' | 'skipped' | 'failed';
  offerId?: string;
  error?:  string;
}

/**
 * A MANUAL delivery run: the operator picked trades and pressed send.
 *
 * Same shape as the CSFloat bulk jobs so the frontend polls it identically. It exists because the
 * auto-accept toggle was the ONLY way to deliver: a sale that arrived before the toggle was flipped
 * sat there until the next poll, and there was no way to deliver one sale, or a chosen few, on
 * demand (owner report 2026-08-12).
 */
export interface CsFloatDeliverJob {
  running:      boolean;
  cancelling?:  boolean;
  cancelled?:   boolean;
  username:     string;
  total:        number;
  done:         number;
  sent:         number;
  unconfirmed:  number;
  failed:       number;
  skipped:      number;
  current?:     string;
  results:      CsFloatDeliverResult[];
  startedAt?:   string;
  finishedAt?:  string;
  /** Set only when the whole job aborted (a failed pre-flight), never for a per-trade failure. */
  error?:       string;
  cancelRequested?: boolean;
}

const emptyDeliverJob = (): CsFloatDeliverJob => ({
  running: false, username: '', total: 0, done: 0, sent: 0, unconfirmed: 0, failed: 0, skipped: 0, results: [],
});

export class CsFloatAutoAcceptWorker {
  private timer?: NodeJS.Timeout;
  private bootTimer?: NodeJS.Timeout; // S46: the 5s first-pass tick, tracked so stop() can cancel it
  private running = false;
  private stopped = false;            // S46: set by stop() → an in-flight pass stops launching deliveries
  /** DURABLE dedup of delivered CSFloat trade ids — survives restarts so a sale is
   *  never delivered twice across a process bounce (C6 / INV-F1). */
  private readonly delivered = new CsFloatDeliveredStore();
  /** The one manual delivery run (serialized like every other job in the app). */
  private job: CsFloatDeliverJob = emptyDeliverJob();

  constructor(
    private readonly accounts: AccountManager,
    private readonly trades: TradeService,
    private readonly csfloat: CsFloatService,
  ) {}

  // ── manual delivery (operator-driven) ───────────────────────────────────────

  deliverStatus(): CsFloatDeliverJob { return { ...this.job, results: this.job.results.map((r) => ({ ...r })) }; }
  deliverBusy(): boolean { return this.job.running; }

  cancelDeliver(): CsFloatDeliverJob {
    if (this.job.running) {
      this.job.cancelRequested = true;
      this.job.cancelling = true;
      logger.info('[csfloat-auto-accept] manual delivery cancel requested (stops BETWEEN trades; a sent offer is never recalled)');
    }
    return this.deliverStatus();
  }

  /** Which of `ids` this install has already delivered — lets the UI mark them instead of
   *  offering a button that would (correctly) refuse. */
  deliveredAmong(ids: string[]): string[] {
    if (this.delivered.isDegraded()) return [];
    return ids.filter((id) => id && this.delivered.has(id));
  }

  /**
   * Delivers the chosen pending sales NOW — the same send path, guards and dedup the poller uses,
   * just triggered by hand. An empty `tradeIds` means "every pending sale on this account".
   *
   * Throws only on a refusal to START (already running, pre-flight failed); a per-trade failure is
   * recorded and the run continues, because one refused sale must not strand the others.
   */
  startDeliver(username: string, tradeIds: string[]): CsFloatDeliverJob {
    if (this.job.running) throw new Error('a CSFloat delivery is already running');
    if (!username) throw new Error('username is required');
    const wanted = new Set(tradeIds.map((s) => String(s ?? '').trim()).filter(Boolean));
    this.job = { ...emptyDeliverJob(), running: true, username, startedAt: new Date().toISOString(), cancelRequested: false, cancelling: false, cancelled: false };
    const job = this.job; // bind THIS job so a late write can never land in the NEXT one
    void this.runDeliver(job, username, wanted)
      .catch((e) => { job.error = e instanceof Error ? e.message : String(e); })
      .finally(() => {
        job.running = false;
        job.cancelling = false;
        job.cancelled = !!job.cancelRequested;
        job.current = undefined;
        job.finishedAt = new Date().toISOString();
        logger.info(`[csfloat-auto-accept] ${username}: manual delivery finished — ${job.sent} sent, ${job.unconfirmed} unconfirmed, ${job.failed} failed, ${job.skipped} skipped`);
      });
    return this.deliverStatus();
  }

  private async runDeliver(job: CsFloatDeliverJob, username: string, wanted: Set<string>): Promise<void> {
    const block = await this.preflight(username);
    if (block) throw new Error(block);

    // The SAME list the dashboard shows — see fetchTrades. Selecting from a differently-filtered
    // list is what made every hand-picked sale come back "no longer a pending sale" (owner report
    // 2026-08-12: "0 sent … 30 skipped"): the tab listed the account's trades unfiltered, the job
    // asked CSFloat for state=pending only, so not one of the ticked ids was in the set it searched.
    const all = await this.fetchTrades(username, 'manual delivery');
    const idOf = (t: Dict): string => pickString(t.id, t.trade_id) ?? '';
    const picked = wanted.size ? all.filter((t) => wanted.has(idOf(t))) : all.filter((t) => !terminalState(t));
    const missing = wanted.size ? [...wanted].filter((id) => !picked.some((t) => idOf(t) === id)) : [];
    job.total = picked.length + missing.length;
    if (!job.total) throw new Error('no CSFloat sale to deliver');

    for (const t of picked) {
      if (job.cancelRequested) break;
      const id = pickString(t.id, t.trade_id) ?? '';
      const name = tradeItemName(t);
      job.current = name || id;
      const r = await this.deliverOne(username, t);
      job.results.push({ ...r, name });
      if (r.status === 'sent') job.sent++;
      else if (r.status === 'unconfirmed') job.unconfirmed++;
      else if (r.status === 'failed') job.failed++;
      else job.skipped++;
      job.done++;
      // A non-durable dedup record means a crash would re-send everything since — the poller stops
      // the account's pass for exactly this reason, and a manual run must not be more reckless.
      if (r.dedupLost) { job.error = 'stopped: a delivered sale could not be recorded to disk — fix the disk/permissions before delivering more (re-delivering would create duplicate offers)'; break; }
    }
    for (const id of missing) {
      job.results.push({ tradeId: id, status: 'skipped', error: 'CSFloat no longer lists this sale (delivered elsewhere, cancelled, or expired) — refresh the tab' });
      job.skipped++;
      job.done++;
    }
    // The finish line has to carry the WHY. "30 skipped" with the reasons only in a job object the
    // operator never opened is exactly how this bug looked from the log: a run that plainly did
    // nothing, and no way to tell whether that was correct.
    const why = new Map<string, number>();
    for (const r of job.results) { if (r.status !== 'sent') why.set(r.error ?? r.status, (why.get(r.error ?? r.status) ?? 0) + 1); }
    for (const [reason, n] of [...why].sort((a, b) => b[1] - a[1])) {
      logger.info(`[csfloat-auto-accept] ${username}:   ${n}× ${reason}`);
    }
  }

  /**
   * The account's CSFloat trades — ONE fetch shape for every caller (poller, manual run, and the
   * dashboard through the API), so what the operator sees is always what a delivery acts on.
   *
   * Deliberately UNFILTERED. The `state=pending` filter this used to pass is undocumented like the
   * rest of the payload, and a filter that silently returns nothing is indistinguishable from an
   * account with no sales — auto-accept would look healthy while delivering nothing, forever.
   * `terminalState` decides what is deliverable, from the state each trade reports about itself.
   */
  private async fetchTrades(username: string, why: string): Promise<Dict[]> {
    const all = extractTrades(await this.csfloat.trades(username, { limit: 50 }));
    const states = [...new Set(all.map((t) => String(t.state ?? t.status ?? '(none)')))];
    logger.info(`[csfloat-auto-accept] ${username}: ${why} — CSFloat returned ${all.length} trade(s); states: ${states.join(', ') || '(none)'}`);
    return all;
  }

  /** Idempotent. The poller is always on; it simply does nothing while no account has
   *  auto-accept enabled, so a restart transparently resumes the persisted toggles. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = (): void => { void this.runOnce(); };
    this.timer = armInterval(this.timer, tick, POLL_INTERVAL_MS);
    this.bootTimer = setTimeout(tick, 5_000); // first pass shortly after boot (non-blocking)
    this.bootTimer.unref?.();
    logger.info('[csfloat-auto-accept] worker started (polls enabled Full accounts every 45s)');
  }

  stop(): void {
    // S46: signal an in-flight pass to stop launching new deliveries, and cancel BOTH timers — the boot
    // tick used to survive stop() and could fire a pass 5s into teardown (an unwatched send during shutdown).
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = undefined; }
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopped) return; // never overlap passes; never start one after stop() (S46)
    // A hand-pressed delivery owns the account while it runs. The dedup store and TradeService's
    // per-asset claim would both refuse the duplicate anyway, but letting the poller race the
    // operator turns a clean manual run into half "already in another money operation" rows.
    if (this.job.running) return;
    // Experimental kill-switch: turning the flag off must STOP auto-delivery, even for
    // accounts whose per-account toggle is still persisted (C15 / INV-F2).
    if (!AppSettings.isCsfloatExperimental()) return;
    this.running = true;
    try {
      const enabled = AppSettings.autoAcceptUsernames()
        .map((u) => this.accounts.get(u))
        .filter((a): a is NonNullable<typeof a> => !!a && a.enabled);
      if (enabled.length === 0) return;
      const concurrency = scaleConcurrency(enabled.length);
      let i = 0;
      const worker = async (): Promise<void> => {
        while (i < enabled.length) {
          if (this.stopped) return; // S46: teardown began mid-pass → stop launching new deliveries
          const acc = enabled[i++];
          try { await this.deliverFor(acc.username); }
          catch (err) { logger.error(`[csfloat-auto-accept] ${acc.username}: ${(err as Error).message}`); }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally { this.running = false; }
  }

  /**
   * Everything that must hold before ANY sale on this account may be delivered. Returns the reason
   * to refuse, or null to proceed.
   *
   * Shared by the poller and the manual job deliberately: a hand-pressed "send" must clear exactly
   * the same bars as the automated one — same egress rule, same confirm capability, same dedup
   * integrity. A second, laxer copy of these checks is how a manual button ends up shipping an asset
   * the automated path would have refused.
   */
  private async preflight(username: string): Promise<string | null> {
    const acc = this.accounts.get(username);
    // H-FLT-003: re-check enabled on the live re-fetch, not just null. runOnce() filters on
    // a.enabled at pass start, but a 500-account pass at 45s cadence spans many seconds — an
    // operator disabling this account mid-pass must stop its queued delivery this pass, matching
    // the re-validate-on-live-state pattern the tier/hasKey guards below already follow.
    if (!acc) return `${username} is not a known account`;
    if (!acc.enabled) return `${username} is disabled`;
    // F1: pool-lost (rule matched a pool that hydrated empty → withNetwork attached no network).
    // Refuse CSFloat egress rather than fall to the host IP; skip with zero HTTP calls until fixed.
    if (!acc.network) return `${username}: proxy pool unavailable (pool-lost) — refusing CSFloat egress (it would leak the host IP)`;
    // INV-A1 / C5 (H-ACC-083): gate on the REAL "can confirm" capability (the maFile's
    // identity_secret, resolved vault THEN disk like login does), not the raw tier label — a
    // full/absent-tier account whose maFile lacks an identity_secret would otherwise send a real
    // Steam offer that can never be 2FA-confirmed and sits stuck unconfirmed. The tier is consulted
    // only when the maFile is unreadable (identitySecret === 'unknown').
    if (canConfirm({ identitySecret: identitySecretPresence(acc), tier: acc.tier }) === false) {
      return `${username} cannot confirm a Steam delivery (its maFile has no identity_secret) — attach a maFile with one to enable`;
    }
    if (!this.csfloat.hasKey(username)) return `${username} has no CSFloat API key`;
    // If the delivered-id memory could not be loaded (corrupt file), delivery MUST NOT run: every
    // currently-pending sale would look undelivered and get a SECOND real Steam offer.
    if (this.delivered.isDegraded()) {
      return 'the delivered-id store is unreadable — delivery is DISABLED (it would re-deliver already-sent sales). Fix/remove csfloat_delivered.json and restart.';
    }
    return null;
  }

  private async deliverFor(username: string): Promise<void> {
    const block = await this.preflight(username);
    if (block) { logger.warn(`[csfloat-auto-accept] skipping — ${block}`); return; }

    const trades = await this.fetchTrades(username, 'auto-accept pass');
    if (trades.length === 0) return;

    for (const t of trades) {
      // A sale CSFloat already calls finished is not ours to deliver. The dedup store only knows
      // what THIS install sent, so without this an item the operator delivered by hand in Steam
      // would look undelivered forever.
      if (terminalState(t)) continue;
      const r = await this.deliverOne(username, t);
      // H-FLT-011: a delivered-id that was NOT made durable (disk full / EACCES / AV lock) means a
      // crash before the store recovers would re-send every sale whose dedup was never saved. Stop
      // this account's pass after the first non-durable record.
      if (r.dedupLost) return;
    }
  }

  /**
   * Delivers ONE CSFloat sale: validate the destination, create + confirm the Steam offer, record
   * the dedup id. Never throws — the outcome is returned so both callers can report it.
   *
   * `dedupLost` means the offer is real but its "already delivered" record did not reach disk; the
   * caller must stop, never continue.
   */
  private async deliverOne(username: string, t: Dict): Promise<CsFloatDeliverResult & { dedupLost?: boolean }> {
    const id = pickString(t.id, t.trade_id) ?? '';
    if (!id) return { tradeId: '?', status: 'skipped', error: 'the CSFloat payload carried no trade id' };
    if (this.delivered.has(id)) return { tradeId: id, status: 'skipped', error: 'already delivered by SSIM — a re-send would create a SECOND Steam offer for this sale' };
    // Checked here too, not just at selection: this is the last gate before a real offer, and an
    // explicit hand-picked id must not be able to route around it.
    const done = terminalState(t);
    if (done) return { tradeId: id, status: 'skipped', error: `CSFloat calls this sale "${done}" — it is finished, so there is nothing to deliver` };

    const d = extractDelivery(t);
    if (!d || (!d.tradeUrl && !d.partnerSteamId) || !d.assetId) {
      logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} — could not read delivery details from the CSFloat response (undocumented shape). Skipping; verify the trades payload against a live key.`);
      return { tradeId: id, status: 'skipped', error: 'could not read the buyer/asset from the CSFloat response (undocumented payload shape)' };
    }
    // F-2 / INV-F1: never send to an unverified destination. The CSFloat trades payload is
    // undocumented, so validate the parsed target (steamID64 / Steam trade URL / numeric asset)
    // before creating a real offer — a drifted field must not ship an asset to the wrong place.
    if (!isValidDeliveryTarget(d)) {
      logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} has an invalid delivery target (steamID/tradeURL/asset) – skipping (will not send to an unverified destination)`);
      return { tradeId: id, status: 'skipped', error: 'the buyer\'s steamID/trade URL did not validate — refusing to send to an unverified destination' };
    }

    logger.info(`[csfloat-auto-accept] ${username}: delivering CSFloat trade ${id} (asset ${d.assetId})`);
    let sent;
    try {
      sent = await this.trades.sendTrade(username, {
        tradeUrl: d.tradeUrl,
        partnerSteamId: d.partnerSteamId,
        myItems: [{ assetId: d.assetId }],
      });
    } catch (err) {
      // H-FLT-001: classify the failure. A TRANSPORT-AMBIGUOUS commit (ECONNRESET/timeout on
      // offer.send's response leg) means the offer MAY already exist on Steam — record it in the
      // delivered store exactly like a success so it is NEVER auto-resent, and tell the operator to
      // verify manually. A DEFINITE Steam rejection did not land, so do NOT record it.
      if ((err as { commitMayHaveLanded?: boolean }).commitMayHaveLanded === true) {
        this.delivered.add(id);
        logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} — the Steam send was network-AMBIGUOUS (${(err as Error).message}); the offer MAY have been created. It will NOT be auto-resent. Verify this account's Steam trade offers manually and re-deliver only if genuinely absent.`);
        return { tradeId: id, status: 'unconfirmed', error: `the Steam send was network-ambiguous (${(err as Error).message}) — the offer MAY exist. Check this account's sent offers; it will NOT be re-sent automatically.` };
      }
      logger.error(`[csfloat-auto-accept] ${username}: trade ${id} — Steam rejected the send (${(err as Error).message}); not marked delivered, will retry on a later poll.`);
      return { tradeId: id, status: 'failed', error: (err as Error).message };
    }
    // Mark delivered regardless of confirm status: the offer EXISTS on Steam now, so a re-attempt
    // would create a SECOND real offer for the same sale. An unconfirmed one needs MANUAL 2FA
    // confirmation (surfaced loudly), never an automatic resend.
    const persisted = this.delivered.add(id);
    if (!persisted) {
      logger.error(`[csfloat-auto-accept] ${username}: trade ${id} was delivered but its delivered-id could NOT be saved – stopping to avoid re-delivering sales whose dedup is not durable. Fix the disk/permissions and restart.`);
    }
    if (sent.status === 'unconfirmed') {
      logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} → Steam offer ${sent.offerId} SENT but NOT 2FA-confirmed – confirm it manually in Steam; it will NOT be auto-resent (avoids a duplicate offer).`);
      return { tradeId: id, status: 'unconfirmed', offerId: sent.offerId, dedupLost: !persisted, error: 'the offer was sent but not 2FA-confirmed — confirm it manually in Steam (it will NOT be re-sent)' };
    }
    logger.info(`[csfloat-auto-accept] ${username}: trade ${id} → Steam offer ${sent.offerId} (${sent.status})`);
    return { tradeId: id, status: 'sent', offerId: sent.offerId, dedupLost: !persisted };
  }
}

/**
 * States that mean the sale is OVER, matched on the state string itself.
 *
 * The trades payload is undocumented, so this is deliberately asymmetric: it names only the words
 * that unambiguously mean "finished" and treats everything else — including a state we have never
 * seen, or none at all — as still deliverable. Getting it wrong in that direction costs an offer
 * Steam refuses (the item is gone); the other direction is a sale that can never be delivered
 * because a word drifted, which is the failure this whole path exists to prevent.
 *
 * Exported so the exact rule is testable, and mirrored in the dashboard so a finished sale's Send
 * button is disabled rather than merely refused after the click.
 */
export function terminalState(t: { state?: unknown; status?: unknown }): string {
  const s = String(t?.state ?? t?.status ?? '').trim();
  return /complet|verified|delivered|cancel|fail|expire|refund|dispute/i.test(s) ? s : '';
}

/** The item name on a trade, for progress lines and the job's result rows. */
function tradeItemName(t: Dict): string | undefined {
  const contract = (t.contract ?? t.listing ?? {}) as Dict;
  const item = (contract.item ?? t.item ?? {}) as Dict;
  return pickString(item.market_hash_name, item.item_name);
}

// ── delivery-target validation (F-2) ─────────────────────────────────────────
const STEAMID64_RE = /^7656\d{13}$/;
const TRADE_URL_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+/;

/**
 * Is the parsed CSFloat delivery target well-formed enough to send a REAL Steam offer
 * to? Requires a numeric asset id and at least one VALID destination (a steamID64 or a
 * Steam trade URL); a present-but-malformed steamID/URL is rejected outright so a
 * drifted/undocumented payload can never mis-deliver. (F-2 / INV-F1.)
 */
export function isValidDeliveryTarget(d: { tradeUrl?: string; partnerSteamId?: string; assetId?: string }): boolean {
  if (!d.assetId || !/^\d+$/.test(d.assetId)) return false;
  if (d.partnerSteamId && !STEAMID64_RE.test(d.partnerSteamId)) return false;
  if (d.tradeUrl && !TRADE_URL_RE.test(d.tradeUrl)) return false;
  const steamOk = !!d.partnerSteamId && STEAMID64_RE.test(d.partnerSteamId);
  const urlOk   = !!d.tradeUrl && TRADE_URL_RE.test(d.tradeUrl);
  return steamOk || urlOk;
}

// ── defensive parsing of the UNDOCUMENTED CSFloat trades payload ──────────────
type Dict = Record<string, unknown>;

function extractTrades(res: unknown): Dict[] {
  if (Array.isArray(res)) return res as Dict[];
  const r = (res ?? {}) as Dict;
  const arr = r.trades ?? r.data ?? r.results;
  return Array.isArray(arr) ? (arr as Dict[]) : [];
}

export function extractDelivery(t: Dict): { tradeUrl?: string; partnerSteamId?: string; assetId?: string } | null {
  if (!t || typeof t !== 'object') return null;
  const buyer = (t.buyer ?? t.buyer_user ?? {}) as Dict;
  const contract = (t.contract ?? t.listing ?? {}) as Dict;
  const item = (contract.item ?? t.item ?? {}) as Dict;
  const tradeUrl = pickString(t.trade_url, buyer.trade_url, t.buyer_trade_url);
  const partnerSteamId = pickString(t.buyer_id, buyer.steam_id, buyer.steamid);
  const assetId = pickString(item.asset_id, contract.asset_id, t.asset_id, item.assetid);
  if (!assetId) return null;
  return { tradeUrl, partnerSteamId, assetId };
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v;
    // Accept a numeric id ONLY when it survived JSON.parse without precision loss. A steamID64
    // (~7.66e16) is always above Number.MAX_SAFE_INTEGER (9.0e15), so a numerically-sourced
    // buyer_id/steam_id has ALREADY been rounded to a wrong-but-17-digit value before we see it —
    // String(v) would stringify the corruption and slip past STEAMID64_RE, mis-delivering the asset.
    // Discard it (→ undefined → the row is skipped, never sent) rather than trust a lossy id.
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v)) return String(v);
      warnUnsafeNumericId(v);
    }
  }
  return undefined;
}

// One-shot so a drifted payload does not spam the log: an unsafe-magnitude JSON number for an id
// means CSFloat must transport that field as a STRING; operators need to see the shape drifted once.
let warnedUnsafeNumericId = false;
function warnUnsafeNumericId(v: number): void {
  if (warnedUnsafeNumericId) return;
  warnedUnsafeNumericId = true;
  logger.warn(`[csfloat-auto-accept] a CSFloat payload id arrived as an unsafe-magnitude JSON number (${v}) — its low digits were already lost to JSON.parse rounding; the field must be transported as a string. Discarding it and skipping the affected row.`);
}
