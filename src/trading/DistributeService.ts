// ════════════════════════════════════════════════════════════════════════════
//  W3_33 — DistributeService: give each target account ~`amount` NET value of items
//  pulled from a source pool, one trade offer per source-account→target pair.
//
//  Load-bearing fact: one Steam offer = one source account → one target. Items are
//  scattered across many source accounts, so distribution is a PACKING problem:
//  pick a source account + a subset of its tradable items whose summed NET value
//  (sellerNetFromBuyer — the single fee-truth) ≈ amount.
//
//  plan() is PURE (cache-only, no network) → unit-testable + previewable before any
//  send. Execution is STRICTLY SERIAL through trades.sendTrade (which self-journals via
//  MoneyOpJournal, arms auto-accept, and classifies sent/confirmed/unconfirmed) — the
//  engine adds NO new money path and NO retry/restart (no-band-aid). Locked/listed/
//  unpriced/untradable items are skipped; a source is never sent items to itself.
//
//  1.5.1 — the operator can also narrow the pool BY ITEM NAME (includeNames / excludeNames). A run
//  used to hand out whatever the packer reached for, so a knife or a rare case could leave the fleet
//  simply because it was the line item that fit the ask. The filters are applied while the pool is
//  built, not while it is packed, so an excluded item is ineligible for every offer in the plan.
// ════════════════════════════════════════════════════════════════════════════
import type { CS2Item } from '../types/inventory';
import { sellerNetFromBuyer } from '../pricing/MarketPricing';

interface PoolItem { assetId: string; netCents: number; buyerCents: number }
export interface PlannedTrade { source: string; target: string; assetIds: string[]; appId: number; netCents: number; buyerCents: number; itemCount: number }
export interface DistributeTargetPlan { target: string; netCents: number; buyerCents: number; itemCount: number; sources: string[]; shortfallCents: number }
export interface DistributePlan {
  amountNetCents: number; appId: number;
  targets: DistributeTargetPlan[];
  trades: PlannedTrade[];
  totalNetCents: number; totalBuyerCents: number; tradeCount: number;
  skipped: { unpriced: number; locked: number; listed: number; untradable: number; filtered: number };
  poolExhausted: boolean;
  /** Distinct item names the filters LEFT in the pool, richest unit value first — so the operator
   *  can see exactly what a run is allowed to hand out (and copy an exact name into a filter). */
  poolNames: Array<{ name: string; count: number; netCents: number }>;
}
export interface DistributeJob {
  running: boolean; cancelling: boolean; cancelled: boolean; stopReason?: string;
  total: number; done: number; sent: number; confirmed: number; unconfirmed: number;
  failed: Array<{ source: string; target: string; error: string }>;
  results: Array<{ source: string; target: string; offerId: string; status: string; escrowEndsAt?: string }>;
  startedAt: number | null; finishedAt: number | null;
}
export interface DistributeRequest {
  sources: string[]; targets: string[]; amountNetCents: number; game: 'cs2' | 'tf2';
  minItemNetCents?: number; policy?: 'single' | 'multi' | 'underfill'; message?: string;
  /** Item-name allow-list. EMPTY MEANS EVERYTHING (an empty list is "no restriction", never "nothing"),
   *  so an operator who types no filter gets the pre-1.5.1 behaviour byte for byte. */
  includeNames?: string[];
  /** Item-name deny-list. Beats includeNames on a conflict: a name the operator wrote under "never
   *  send" is never sent, whatever else it also matches. */
  excludeNames?: string[];
}

/** Case-insensitive SUBSTRING matching on marketHashName. Substring, not exact, because that is how
 *  the operator thinks about a fleet: "Karambit" means every Karambit, "Souvenir" means every souvenir
 *  package. Blank lines are dropped so a stray newline in a pasted list can't match everything. */
export function normalizeNameFilter(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const s = typeof r === 'string' ? r.trim().toLowerCase() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out;
}

/** The one filter decision, shared by the plan and its tests. `include` empty ⇒ everything passes. */
export function passesNameFilter(marketHashName: string, include: string[], exclude: string[]): boolean {
  const name = (marketHashName ?? '').toLowerCase();
  for (const e of exclude) if (name.includes(e)) return false;      // deny wins, always
  if (!include.length) return true;
  for (const i of include) if (name.includes(i)) return true;
  return false;
}

/** Duck-typed collaborators — keeps DistributeService decoupled; the real InventoryService /
 *  TradeService satisfy these structurally at the wiring site. */
export interface DistributeDeps {
  inventory: { getCached(u: string, game: 'cs2' | 'tf2'): { items: CS2Item[] } | undefined };
  trades: {
    getTradeUrl(u: string): Promise<string>;
    sendTrade(from: string, params: { tradeUrl?: string; myItems?: Array<{ assetId: string; appId?: number; contextId?: string }>; message?: string }): Promise<{ status?: string; offerId?: string; escrowEndsAt?: string | Date }>;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function idleJob(): DistributeJob {
  return { running: false, cancelling: false, cancelled: false, total: 0, done: 0, sent: 0, confirmed: 0, unconfirmed: 0, failed: [], results: [], startedAt: null, finishedAt: null };
}

/** Belt-and-suspenders lock check: trust both the re-derived category and a future tradeLockExpiry. */
function isLocked(it: CS2Item, now: number): boolean {
  if (it.category === 'tradelocked') return true;
  return it.tradeLockExpiry != null && new Date(it.tradeLockExpiry).getTime() > now;
}

/** Greedy-descending subset ≈ amount (deterministic; exact knapsack deliberately avoided).
 *  MONEY SAFETY (owner 2026-07-09): the overshoot tolerance is a small fraction of the ASK —
 *  never scaled by pool-item size. The old `tol = max(smallestItem, 5%)` let a pool whose
 *  smallest item was a big-ticket skin "cross the line" with an unbounded overshoot (a €5 ask
 *  planned a €10,000 knife). Now a pool that can't fit within tolerance UNDERFILLS honestly
 *  (shortfall + poolExhausted) — with policy 'multi' the remainder is sourced elsewhere. */
function pickSubset(items: PoolItem[], amount: number): { picked: PoolItem[]; sum: number } {
  const picked: PoolItem[] = []; const pickedIds = new Set<string>(); let sum = 0;
  const tol = Math.max(Math.ceil(amount * 0.10), 25);   // ≤10% over the ask (25¢ floor for cent-level asks)
  for (const it of items) {                       // items are sorted DESC by netCents
    if (sum >= amount) break;
    if (sum + it.netCents <= amount + tol) { picked.push(it); pickedIds.add(it.assetId); sum += it.netCents; }
  }
  if (sum < amount) {                             // tail top-up: smallest remaining first — still capped
    const rem = items.filter((i) => !pickedIds.has(i.assetId)).sort((a, b) => a.netCents - b.netCents);
    for (const it of rem) {
      if (sum >= amount) break;
      if (sum + it.netCents > amount + tol) break; // even the smallest overshoots the cap → honest shortfall
      picked.push(it); sum += it.netCents;
    }
  }
  return { picked, sum };
}

/** PURE: build the source pool from the cache and pack each target to ≈ amountNetCents. No I/O beyond cache reads. */
export function planDistribute(req: DistributeRequest, deps: DistributeDeps, now = Date.now()): DistributePlan {
  const appId = req.game === 'tf2' ? 440 : 730;
  const minNet = req.minItemNetCents ?? 0;
  // Default MULTI (owner 2026-07-09): a target may be filled from SEVERAL source accounts —
  // one offer per source→target pair — instead of underfilling from a single source.
  const policy = req.policy ?? 'multi';
  const skipped = { unpriced: 0, locked: 0, listed: 0, untradable: 0, filtered: 0 };
  // Item include/exclude (1.5.1, owner): a distribute run hands out whatever the pool holds, which
  // means a knife or a rare case can leave the fleet just because the packer needed a big line item.
  // The filters run at POOL-BUILD time, before any packing decision, so an excluded item is not merely
  // deprioritised — it is not eligible for any offer in this plan, and preview and run share the code.
  const include = normalizeNameFilter(req.includeNames);
  const exclude = normalizeNameFilter(req.excludeNames);
  const names = new Map<string, { name: string; count: number; netCents: number }>();

  const pool = new Map<string, PoolItem[]>();
  for (const u of req.sources) {
    const inv = deps.inventory.getCached(u, req.game);
    if (!inv) continue;                            // never-refreshed source → skip (not "0 items")
    const items: PoolItem[] = [];
    for (const it of inv.items) {
      if (!it.tradable) { skipped.untradable++; continue; }
      if (it.category === 'listed') { skipped.listed++; continue; }
      if (isLocked(it, now)) { skipped.locked++; continue; }
      if (it.price == null) { skipped.unpriced++; continue; }   // unpriced → fail-closed exclude
      // Counted in ITEMS (assetIds), not stacks like the counters above it: "3 filtered" when the
      // operator just excluded 300 cases held in 3 stacks would badly understate what the filter did.
      // The surface that renders it says "item(s)" so the two units are never read as one.
      if (!passesNameFilter(it.marketHashName, include, exclude)) { skipped.filtered += it.assetIds.length; continue; }
      // `it.price` is the cached USD-cent valuation (not a wallet amount), and USD's per-side
      // fee floor IS one minor unit — so the default floor is the right one here. Only the
      // per-wallet listing math (preview / mass-sell) passes a currency-specific floor.
      const netEach = sellerNetFromBuyer(it.price);
      if (netEach < minNet) continue;
      for (const assetId of it.assetIds) items.push({ assetId, netCents: netEach, buyerCents: it.price });
      const seen = names.get(it.marketHashName);
      if (seen) seen.count += it.assetIds.length;
      else names.set(it.marketHashName, { name: it.marketHashName, count: it.assetIds.length, netCents: netEach });
    }
    items.sort((a, b) => b.netCents - a.netCents);
    if (items.length) pool.set(u, items);
  }

  const consumed = new Set<string>();
  const trades: PlannedTrade[] = [];
  const targetPlans: DistributeTargetPlan[] = [];
  let poolExhausted = false;
  const remaining = (u: string) => (pool.get(u) ?? []).filter((i) => !consumed.has(i.assetId));
  const remNet = (u: string) => remaining(u).reduce((s, i) => s + i.netCents, 0);

  for (const target of req.targets) {
    let need = req.amountNetCents;
    const usedSources: string[] = [];
    let tNet = 0, tBuyer = 0, tCount = 0;
    while (need > 0) {
      const cands = [...pool.keys()].filter((s) => s !== target && remNet(s) > 0);   // never self-send
      if (!cands.length) break;
      // Try candidates in order (smallest-sufficient first, else richest) and SKIP a source whose
      // items can't fit the remaining need within tolerance — the next source may hold smaller
      // items that do. Only when NO source can contribute does the target take an honest shortfall.
      const sufficient = cands.filter((s) => remNet(s) >= need).sort((a, b) => remNet(a) - remNet(b));
      const rest = cands.filter((s) => !sufficient.includes(s)).sort((a, b) => remNet(b) - remNet(a));
      let advanced = false;
      for (const src of [...sufficient, ...rest]) {
        const { picked, sum } = pickSubset(remaining(src), need);
        if (!picked.length) continue;              // nothing fits from this source — try the next
        const assetIds = picked.map((p) => p.assetId);
        assetIds.forEach((id) => consumed.add(id));
        const buyer = picked.reduce((s, p) => s + p.buyerCents, 0);
        trades.push({ source: src, target, assetIds, appId, netCents: sum, buyerCents: buyer, itemCount: assetIds.length });
        usedSources.push(src); tNet += sum; tBuyer += buyer; tCount += assetIds.length; need -= sum;
        advanced = true;
        break;
      }
      if (!advanced) break;                        // no source can contribute within tolerance
      if (policy !== 'multi') break;               // one source per target unless policy=multi
    }
    const shortfall = Math.max(0, req.amountNetCents - tNet);
    if (shortfall > 0) poolExhausted = true;
    targetPlans.push({ target, netCents: tNet, buyerCents: tBuyer, itemCount: tCount, sources: [...new Set(usedSources)], shortfallCents: shortfall });
  }

  return {
    amountNetCents: req.amountNetCents, appId, targets: targetPlans, trades,
    totalNetCents: trades.reduce((s, t) => s + t.netCents, 0),
    totalBuyerCents: trades.reduce((s, t) => s + t.buyerCents, 0),
    tradeCount: trades.length, skipped, poolExhausted,
    poolNames: [...names.values()].sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name)),
  };
}

export class DistributeService {
  private job: DistributeJob = idleJob();
  constructor(private deps: DistributeDeps) {}

  preview(req: DistributeRequest): DistributePlan { return planDistribute(req, this.deps); }
  status(): DistributeJob { return this.job; }
  cancel(): DistributeJob { if (this.job.running) this.job.cancelling = true; return this.job; }

  start(req: DistributeRequest): DistributeJob {
    if (this.job.running) throw Object.assign(new Error('A distribute job is already running'), { status: 409 });
    const plan = planDistribute(req, this.deps);
    if (!plan.trades.length) throw Object.assign(new Error('Nothing to distribute (pool empty, or every item skipped)'), { status: 400 });
    this.job = { ...idleJob(), running: true, total: plan.trades.length, startedAt: Date.now() };
    void this.run(plan, req.message);              // fire-and-forget; polled via status()
    return this.job;
  }

  /** Strictly serial, paced (~1–2s/offer, Error-15 guard). Reuses trades.sendTrade (self-journaled).
   *  A failed trade is recorded and the loop continues (no-band-aid — never retried/restarted). */
  private async run(plan: DistributePlan, message?: string): Promise<void> {
    for (const t of plan.trades) {
      if (this.job.cancelling) { this.job.cancelled = true; this.job.stopReason = 'cancelled'; break; }
      try {
        const url = await this.deps.trades.getTradeUrl(t.target);          // internal → arms auto-accept
        const res = await this.deps.trades.sendTrade(t.source, { tradeUrl: url, myItems: t.assetIds.map((id) => ({ assetId: id, appId: t.appId, contextId: '2' })), message });
        const status = res.status ?? 'sent';
        if (status === 'confirmed') this.job.confirmed++;
        else if (status === 'unconfirmed') this.job.unconfirmed++;   // offer EXISTS, awaiting 2FA — not a failure, not retried
        else this.job.sent++;
        this.job.results.push({ source: t.source, target: t.target, offerId: String(res.offerId ?? ''), status, escrowEndsAt: res.escrowEndsAt ? new Date(res.escrowEndsAt).toISOString() : undefined });
      } catch (e) {
        this.job.failed.push({ source: t.source, target: t.target, error: (e as Error).message });
      }
      this.job.done++;
      await sleep(1000 + Math.floor(Math.random() * 1000));
    }
    this.job.running = false;
    this.job.finishedAt = Date.now();
  }
}
