import { scaleConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { AppSettings } from '../core/AppSettings';
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
  private running = false;
  private readonly delivered = new Set<string>(); // CSFloat trade ids actioned this process-run (dedup)

  constructor(
    private readonly accounts: AccountManager,
    private readonly trades: TradeService,
    private readonly csfloat: CsFloatService,
  ) {}

  /** Idempotent. The poller is always on; it simply does nothing while no account has
   *  auto-accept enabled, so a restart transparently resumes the persisted toggles. */
  start(): void {
    if (this.timer) return;
    const tick = (): void => { void this.runOnce(); };
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(tick, 5_000).unref?.(); // first pass shortly after boot (non-blocking)
    logger.info('[csfloat-auto-accept] worker started (polls enabled Full accounts every 45s)');
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  private async runOnce(): Promise<void> {
    if (this.running) return; // never overlap passes
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
    if (acc.tier === 'limited') {
      logger.warn(`[csfloat-auto-accept] ${username} is Limited (no maFile) — cannot confirm a Steam delivery; skipping (attach a maFile to enable).`);
      return;
    }
    if (!this.csfloat.hasKey(username)) return;

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
      logger.info(`[csfloat-auto-accept] ${username}: delivering CSFloat trade ${id} (asset ${d.assetId})`);
      const sent = await this.trades.sendTrade(username, {
        tradeUrl: d.tradeUrl,
        partnerSteamId: d.partnerSteamId,
        myItems: [{ assetId: d.assetId }],
      });
      this.delivered.add(id);
      logger.info(`[csfloat-auto-accept] ${username}: trade ${id} → Steam offer ${sent.offerId} (${sent.status})`);
    }
  }
}

// ── defensive parsing of the UNDOCUMENTED CSFloat trades payload ──────────────
type Dict = Record<string, unknown>;

function extractTrades(res: unknown): Dict[] {
  if (Array.isArray(res)) return res as Dict[];
  const r = (res ?? {}) as Dict;
  const arr = r.trades ?? r.data ?? r.results;
  return Array.isArray(arr) ? (arr as Dict[]) : [];
}

function extractDelivery(t: Dict): { tradeUrl?: string; partnerSteamId?: string; assetId?: string } | null {
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
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}
