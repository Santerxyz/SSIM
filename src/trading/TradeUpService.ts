import type { InventoryService } from '../core/InventoryService';
import type { PricingService } from '../pricing/PricingService';
import type { GcActionLayer } from './GcActionLayer';
import { Cs2SchemaService, parseSkinName, type SkinDef } from '../core/Cs2SchemaService';
import { computeContract, wearMidpoint, type TuContract, type TuInput, type PriceFn } from './tradeupMath';
import { isSellable } from '../core/MarketModel';
import { logger } from '../utils/logger';

const CS2_APPID = 730;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Live status of the (one-at-a-time) trade-up execution job, polled by the UI. */
export interface TradeUpExecJob {
  running:      boolean;
  cancelling?:  boolean;
  cancelled?:   boolean;
  /** False when GC execution is gated off — NOTHING was crafted (safe no-op). */
  enabled:      boolean;
  statusReason: string;
  total:        number;
  done:         number;
  crafted:      number;
  failed:       number;
  current?:     number;
  results:      Array<{ index: number; submitted: boolean; confirmed?: boolean; error?: string }>;
  startedAt?:   string;
  finishedAt?:  string;
}

/** One selected contract for execution: the 10 input asset ids + the input rarity (→ craft recipe). */
export interface TuExecContract {
  inputAssetIds: string[];
  rarityId:      string;
  stattrak:      boolean;
}
/** A contract uses at most 10 of any single skin, so never expand a stack beyond this. */
const MAX_PER_STACK = 10;
/** UI safety cap on surfaced candidates (sorted by profit, best first). */
const MAX_CANDIDATES = 80;

export interface TradeUpCandidate extends TuContract {
  /** Stable id (rarity|stattrak|collection|sorted-asset-ids) for selection + execution mapping. */
  id:                string;
  collectionLabel:   string;
  rarityLabel:       string;
  outputRarityLabel: string;
  /** True when every input + every outcome had a known price (EV fully trustworthy). */
  fullyPriced:       boolean;
}

export interface TradeUpResult {
  username:   string;
  candidates: TradeUpCandidate[];
  warnings:   string[];
  /** True when EV used the REAL per-item GC floats (vs. wear-based estimates). */
  realFloats: boolean;
  /** Diagnostics for the UI footer. */
  eligibleInputs: number;
  schemaSkins:    number;
}

/**
 * Computes positive-profit CS2 trade-up contracts from ONE account's inventory.
 *
 * SEARCH STRATEGY (documented, bounded — NOT a brute force over all C(n,10), which is billions):
 * inputs are grouped by (rarity tier, StatTrak); within each group we evaluate the realistic
 * profitable contracts — the cheapest-10 MIXED contract, plus per single collection the cheapest-10
 * and the lowest-float-10. Each candidate is then scored with the EXACT contract math (computeContract).
 * This finds the trade-ups a human would actually run; the EV/probability/float math is exact.
 *
 * MONEY/ITEM SAFETY: this class only CALCULATES. It never touches the Game Coordinator or destroys
 * items — execution lives behind the gated GC action layer (see GcActionLayer / FEATURES_REPORT).
 */
export class TradeUpService {
  /** Single live execution job (the trade-up money/item path is deliberately serialized). */
  private execJob: TradeUpExecJob = { running: false, enabled: false, statusReason: '', total: 0, done: 0, crafted: 0, failed: 0, results: [] };
  private execCancel = false;

  constructor(
    private readonly inventory: InventoryService,
    private readonly pricing:   PricingService,
    private readonly schema:    Cs2SchemaService,
    private readonly gc:        GcActionLayer,
  ) {}

  private priceFn(): PriceFn {
    return (mhn: string) => this.pricing.priceCents(mhn, CS2_APPID) ?? null;
  }

  // ── Execution (HIGH RISK, GATED — see GcActionLayer) ────────────────────────

  gcStatus(): ReturnType<GcActionLayer['status']> { return this.gc.status(); }

  executeStatus(): TradeUpExecJob { return { ...this.execJob, results: this.execJob.results.map((r) => ({ ...r })) }; }

  /** True while a trade-up craft job is running — gates a mid-session update swap (S14): a swap
   *  hard-exit mid-craft leaves an irreversible 10-item craft's outcome unknown. */
  busy(): boolean { return this.execJob.running; }

  /**
   * Starts executing the SELECTED contracts (each its 10 input asset ids) on `username`, one at a
   * time. When GC execution is gated off, the job completes immediately as a SAFE NO-OP (enabled:false,
   * nothing crafted). Cancel stops AFTER the current contract — a submitted craft is never interrupted.
   */
  startExecute(username: string, contracts: TuExecContract[]): TradeUpExecJob {
    if (this.execJob.running) throw new Error('a trade-up execution is already running');
    if (!Array.isArray(contracts) || contracts.length === 0) throw new Error('no contracts selected');
    for (const c of contracts) {
      if (!c || !Array.isArray(c.inputAssetIds) || c.inputAssetIds.length !== 10 || !c.inputAssetIds.every((id) => typeof id === 'string' && id)) {
        throw new Error('each contract must carry exactly 10 input asset ids');
      }
      if (typeof c.rarityId !== 'string' || !c.rarityId) throw new Error('each contract must carry its input rarityId (for the craft recipe)');
    }
    const st = this.gc.status();
    this.execCancel = false;
    this.execJob = {
      running: true, cancelling: false, cancelled: false, enabled: st.craftEnabled, statusReason: st.reason,
      total: contracts.length, done: 0, crafted: 0, failed: 0, results: [], startedAt: new Date().toISOString(),
    };
    void this.runExecute(username, contracts);
    return this.executeStatus();
  }

  cancelExecute(): TradeUpExecJob {
    if (this.execJob.running) { this.execCancel = true; this.execJob.cancelling = true; logger.info('[tradeup] execution cancel requested'); }
    return this.executeStatus();
  }

  private async runExecute(username: string, contracts: TuExecContract[]): Promise<void> {
    for (let i = 0; i < contracts.length; i++) {
      if (this.execCancel) break;
      this.execJob.current = i;
      try {
        const r = await this.gc.craftTradeUp(username, {
          inputAssetIds: contracts[i].inputAssetIds,
          inputRarityId: contracts[i].rarityId,
          stattrak: !!contracts[i].stattrak,
        });
        this.execJob.crafted++;
        this.execJob.results.push({ index: i, submitted: r.submitted, confirmed: r.confirmed, error: r.confirmed ? undefined : 'submitted — not confirmed in-window (verify in-game; NOT retried)' });
      } catch (e) {
        this.execJob.failed++;
        this.execJob.results.push({ index: i, submitted: false, error: (e as Error).message });
      } finally {
        this.execJob.done++;
      }
      if (i < contracts.length - 1 && !this.execCancel) await sleep(1_500);
    }
    this.execJob.running = false;
    this.execJob.cancelling = false;
    this.execJob.cancelled = this.execCancel;
    this.execJob.current = undefined;
    this.execJob.finishedAt = new Date().toISOString();
    this.execCancel = false;
  }

  /** Live-refresh the account, then compute every positive-profit trade-up from its skins. */
  async getCandidates(username: string, opts?: { minProfitCents?: number }): Promise<TradeUpResult> {
    await this.schema.ensureLoaded();
    const minProfit = Number.isFinite(opts?.minProfitCents) ? Number(opts?.minProfitCents) : 0;
    const warnings: string[] = [];

    const inv = await this.inventory.forceRefresh(username, 'cs2'); // fresh snapshot, like the buy path
    const inputs = this.buildEligibleInputs(inv.items ?? []);
    if (inputs.length < 10) {
      warnings.push('Not enough trade-up-eligible skins (need at least 10 of one rarity + StatTrak status).');
      return { username, candidates: [], warnings, realFloats: false, eligibleInputs: inputs.length, schemaSkins: this.schema.skinCount() };
    }

    // ACCURACY: replace the wear-midpoint float ESTIMATE with the REAL per-item GC float when the
    // library is present. This is a user-initiated trade-up action, so a one-shot GC connect here is
    // in-scope (never the background path); it disconnects immediately. Falls back to the estimate
    // (clearly labelled) if the GC is unavailable / the read fails.
    let realFloats = false;
    if (this.gc.available()) {
      try {
        const floats = await this.gc.readInventoryFloats(username);
        let applied = 0;
        for (const inp of inputs) {
          if (inp.assetId && floats.has(inp.assetId)) { inp.float = floats.get(inp.assetId)!; applied++; }
        }
        realFloats = applied > 0 && applied === inputs.filter((i) => i.assetId).length;
        logger.info(`[tradeup] ${username}: applied ${applied}/${inputs.length} real GC float(s)`);
        if (applied > 0 && !realFloats) warnings.push('Some items had no GC float — those use a wear-based estimate.');
      } catch (e) {
        warnings.push(`Could not read real floats from the GC (${(e as Error).message}) — using wear-based estimates.`);
      }
    }

    // Warm the price cache for every eligible collection's OUTPUT skins (all wears) + the inputs,
    // so a follow-up call has accurate EV. Outputs are NOT in the account inventory, so they would
    // otherwise never be queued.
    this.warmOutputPrices(inputs);

    const price = this.priceFn();
    const candidates: TradeUpCandidate[] = [];
    const seen = new Set<string>();

    // Group by (rarity tier, StatTrak).
    const groups = new Map<string, TuInput[]>();
    for (const inp of inputs) {
      const k = `${inp.rarityId}|${inp.stattrak ? 1 : 0}`;
      const arr = groups.get(k) ?? [];
      arr.push(inp);
      groups.set(k, arr);
    }

    for (const group of groups.values()) {
      if (group.length < 10) continue;
      const outputRarity = this.schema.nextRarity(group[0].rarityId);
      if (!outputRarity) continue;

      // Candidate input-sets: cheapest-10 mixed + per-collection cheapest-10 + per-collection lowest-float-10.
      const sets: TuInput[][] = [];
      sets.push(cheapest(group, 10));
      const byCol = new Map<string, TuInput[]>();
      for (const i of group) { const a = byCol.get(i.collection) ?? []; a.push(i); byCol.set(i.collection, a); }
      for (const colItems of byCol.values()) {
        if (colItems.length < 10) continue;
        sets.push(cheapest(colItems, 10));
        sets.push(lowestFloat(colItems, 10));
      }

      for (const set of sets) {
        if (set.length !== 10) continue;
        const key = set.map((i) => i.assetId ?? i.marketHashName).sort().join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        let contract: TuContract;
        try { contract = computeContract(set, outputRarity, this.schema, price); }
        catch (e) { logger.debug(`[tradeup] skipped a set: ${(e as Error).message}`); continue; }
        if (contract.profitCents <= minProfit) continue;
        candidates.push(this.decorate(contract, key));
      }
    }

    candidates.sort((a, b) => b.profitCents - a.profitCents);
    const top = candidates.slice(0, MAX_CANDIDATES);

    if (top.some((c) => !c.fullyPriced)) {
      warnings.push('Some prices are still loading — EV/profit shown are estimates; click again in a moment for accurate figures.');
    }
    warnings.push(realFloats
      ? 'Input floats are the REAL per-item GC floats — output wears + EV are accurate (subject to live market prices).'
      : 'Input floats are ESTIMATED from each item’s wear (GC float read unavailable) — EV is an approximation.');

    logger.info(`[tradeup] ${username}: ${top.length} profitable candidate(s) from ${inputs.length} eligible input(s)${realFloats ? ' (real floats)' : ' (estimated floats)'}`);
    return { username, candidates: top, warnings, eligibleInputs: inputs.length, schemaSkins: this.schema.skinCount(), realFloats };
  }

  /** Expands inventory stacks into individual trade-up-eligible input items (≤10 per stack). */
  private buildEligibleInputs(items: Array<{ marketHashName: string; quantity?: number; assetIds?: string[]; price?: number | null; category?: string; tradeLockExpiry?: Date | string | null; tradable?: boolean }>): TuInput[] {
    const out: TuInput[] = [];
    for (const it of items) {
      if (it.category === 'listed') continue;                       // on the market, not in inventory
      // Never feed a trade-locked / non-tradable skin into a craft (INV-D6 / C10). The
      // forceRefresh path doesn't set `category`, so check the lock state directly.
      if (!isSellable(it)) continue;
      const parsed = parseSkinName(it.marketHashName);
      if (!parsed || parsed.souvenir || !parsed.wear) continue;     // souvenirs/no-wear → ineligible
      const def: SkinDef | undefined = this.schema.lookup(parsed.baseName);
      if (!def || !this.schema.isEligibleInput(def)) continue;
      const float = wearMidpoint(parsed.wear, def.minFloat, def.maxFloat); // estimate (exact float unknown on web)
      const priceCents = this.pricing.priceCents(it.marketHashName, CS2_APPID);
      const assetIds = Array.isArray(it.assetIds) && it.assetIds.length ? it.assetIds : [undefined];
      const n = Math.min(assetIds.length, it.quantity ?? assetIds.length, MAX_PER_STACK);
      for (let i = 0; i < n; i++) {
        out.push({
          marketHashName: it.marketHashName,
          baseName: def.name,
          collection: def.collection,
          rarityId: def.rarityId,
          stattrak: parsed.stattrak,
          float,
          priceCents: priceCents ?? null,
          assetId: assetIds[i],
        });
      }
    }
    return out;
  }

  /** Queues background price fills for every eligible collection's output skins (all 5 wears) + the
   *  inputs, so the NEXT calculation has accurate EV (outputs are never in the account inventory). */
  private warmOutputPrices(inputs: TuInput[]): void {
    const missing: Array<{ name: string; appid: number }> = [];
    const seen = new Set<string>();
    const add = (mhn: string): void => {
      if (seen.has(mhn)) return;
      seen.add(mhn);
      if (this.pricing.priceCents(mhn, CS2_APPID) === undefined) missing.push({ name: mhn, appid: CS2_APPID });
    };
    const collections = new Set<string>();
    for (const i of inputs) { add(i.marketHashName); collections.add(`${i.collection}|${i.rarityId}|${i.stattrak ? 1 : 0}`); }
    for (const key of collections) {
      const [collection, rarityId, st] = key.split('|');
      for (const o of this.schema.outputsFor(collection, rarityId)) {
        for (const wear of ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'] as const) {
          add(this.schema.marketHashName(o.name, wear, st === '1'));
        }
      }
    }
    if (missing.length) this.pricing.ensureFilled(missing);
  }

  private decorate(c: TuContract, key: string): TradeUpCandidate {
    const collection = c.inputs.every((i) => i.collection === c.inputs[0].collection) ? c.inputs[0].collection : 'Mixed';
    return {
      ...c,
      id: `${c.rarityId}|${c.stattrak ? 1 : 0}|${collection}|${key}`,
      collectionLabel: collection,
      rarityLabel: this.schema.rarityLabel(c.rarityId),
      outputRarityLabel: this.schema.rarityLabel(c.outputRarityId),
      fullyPriced: c.pricedInputs === 10 && c.pricedOutcomeProb > 0.999,
    };
  }
}

/** The `count` cheapest inputs (unpriced sorted last — we never want to bank on an unknown cost). */
function cheapest(items: TuInput[], count: number): TuInput[] {
  return [...items].sort((a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity)).slice(0, count);
}
/** The `count` lowest-float inputs (better output wear → usually higher output value). */
function lowestFloat(items: TuInput[], count: number): TuInput[] {
  return [...items].sort((a, b) => a.float - b.float).slice(0, count);
}
