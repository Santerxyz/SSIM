import { scaleConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { AppSettings } from '../core/AppSettings';
import { AccountVault } from '../core/AccountVault';
import { canConfirm } from '../core/accountCapability';
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

export class CsFloatAutoAcceptWorker {
  private timer?: NodeJS.Timeout;
  private bootTimer?: NodeJS.Timeout; // S46: the 5s first-pass tick, tracked so stop() can cancel it
  private running = false;
  private stopped = false;            // S46: set by stop() → an in-flight pass stops launching deliveries
  /** DURABLE dedup of delivered CSFloat trade ids — survives restarts so a sale is
   *  never delivered twice across a process bounce (C6 / INV-F1). */
  private readonly delivered = new CsFloatDeliveredStore();

  constructor(
    private readonly accounts: AccountManager,
    private readonly trades: TradeService,
    private readonly csfloat: CsFloatService,
  ) {}

  /** Idempotent. The poller is always on; it simply does nothing while no account has
   *  auto-accept enabled, so a restart transparently resumes the persisted toggles. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = (): void => { void this.runOnce(); };
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
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

  private async deliverFor(username: string): Promise<void> {
    const acc = this.accounts.get(username);
    if (!acc) return;
    // INV-A1 / C5 (H-ACC-083): gate on the REAL "can confirm" capability (the maFile's
    // identity_secret), not the raw tier label — a full/absent-tier account whose maFile
    // lacks an identity_secret would otherwise send a real Steam offer that can never be
    // 2FA-confirmed and sits stuck unconfirmed. In plaintext mode this reads the tier only
    // (identical to the old gate); in vault mode it reads the vault maFile's identity_secret.
    if (canConfirm({
      vaultEnabled: AccountVault.isEnabled(),
      vaultMaFileHasIdentitySecret: !!AccountVault.getAccount(acc.username)?.maFile?.identity_secret,
      tier: acc.tier,
    }) === false) {
      logger.warn(`[csfloat-auto-accept] ${username} cannot confirm a Steam delivery (its maFile has no identity_secret); skipping (attach a maFile with one to enable).`);
      return;
    }
    if (!this.csfloat.hasKey(username)) return;

    // If the delivered-id memory could not be loaded (corrupt file), auto-delivery MUST NOT run:
    // every currently-pending sale would look undelivered and get a SECOND real Steam offer.
    if (this.delivered.isDegraded()) {
      logger.error(`[csfloat-auto-accept] delivered-id store is unreadable – auto-delivery is DISABLED (would re-deliver already-sent sales). Fix/remove csfloat_delivered.json and restart.`);
      return;
    }

    const res = await this.csfloat.trades(username, { state: 'pending' });
    const trades = extractTrades(res);
    if (trades.length === 0) return;

    for (const t of trades) {
      const id = pickString(t.id, t.trade_id) ?? '';
      if (!id || this.delivered.has(id)) continue;
      const d = extractDelivery(t);
      if (!d || (!d.tradeUrl && !d.partnerSteamId) || !d.assetId) {
        logger.warn(`[csfloat-auto-accept] ${username}: trade ${id || '?'} — could not read delivery details from the CSFloat response (undocumented shape). Skipping; verify the trades payload against a live key.`);
        continue;
      }
      // F-2 / INV-F1: never send to an unverified destination. The CSFloat trades
      // payload is undocumented, so validate the parsed target (steamID64 / Steam trade
      // URL / numeric asset) before creating a real offer — a drifted field must not
      // ship an asset to the wrong place.
      if (!isValidDeliveryTarget(d)) {
        logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} has an invalid delivery target (steamID/tradeURL/asset) – skipping (will not send to an unverified destination)`);
        continue;
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
        // H-FLT-001: the poll cadence (45s) is far longer than TradeService's refuse-once min-age
        // (8s), so the refuse-once gate is only a one-poll speed-bump for this automated caller.
        // Classify the failure: a TRANSPORT-AMBIGUOUS commit (ECONNRESET/timeout on offer.send's
        // response leg) means the offer MAY already exist on Steam — record it in the delivered store
        // exactly like a success so it is NEVER auto-resent, and tell the operator to verify manually.
        // A DEFINITE Steam rejection did not land, so do NOT record it; log and move on.
        if ((err as { commitMayHaveLanded?: boolean }).commitMayHaveLanded === true) {
          this.delivered.add(id);
          logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} — the Steam send was network-AMBIGUOUS (${(err as Error).message}); the offer MAY have been created. It will NOT be auto-resent. Verify this account's Steam trade offers manually and re-deliver only if genuinely absent.`);
        } else {
          logger.error(`[csfloat-auto-accept] ${username}: trade ${id} — Steam rejected the send (${(err as Error).message}); not marked delivered, will retry on a later poll.`);
        }
        continue;
      }
      // Mark delivered regardless of confirm status: the offer EXISTS on Steam now, so a
      // re-attempt would create a SECOND real offer for the same sale. An unconfirmed one needs
      // MANUAL 2FA confirmation (surfaced loudly), never an automatic resend.
      const persisted = this.delivered.add(id);
      if (sent.status === 'unconfirmed') {
        logger.warn(`[csfloat-auto-accept] ${username}: trade ${id} → Steam offer ${sent.offerId} SENT but NOT 2FA-confirmed – confirm it manually in Steam; it will NOT be auto-resent (avoids a duplicate offer).`);
      } else {
        logger.info(`[csfloat-auto-accept] ${username}: trade ${id} → Steam offer ${sent.offerId} (${sent.status})`);
      }
      if (!persisted) {
        // H-FLT-011: the delivered-id for a real, already-sent Steam offer was NOT made durable
        // (disk full / EACCES / AV lock, or the store already latched degraded). Do NOT launch
        // another delivery for this account this pass — a crash before the store recovers would
        // re-send every sale whose dedup was never saved. Stop after the first non-durable record.
        logger.error(`[csfloat-auto-accept] ${username}: trade ${id} was delivered but its delivered-id could NOT be saved – stopping this account's pass to avoid re-delivering sales whose dedup is not durable. Fix the disk/permissions and restart.`);
        return;
      }
    }
  }
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
