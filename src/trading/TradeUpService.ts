import type { InventoryService } from '../core/InventoryService';
import type { PricingService } from '../pricing/PricingService';
import { Cs2SchemaService, parseSkinName, type SkinDef } from '../core/Cs2SchemaService';
import { computeContract, wearMidpoint, type TuContract, type TuInput, type PriceFn } from './tradeupMath';
import { logger } from '../utils/logger';

const CS2_APPID = 730;
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
  constructor(
    private readonly inventory: InventoryService,
    private readonly pricing:   PricingService,
    private readonly schema:    Cs2SchemaService,
  ) {}

  private priceFn(): PriceFn {
    return (mhn: string) => this.pricing.priceCents(mhn, CS2_APPID) ?? null;
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
      return { username, candidates: [], warnings, eligibleInputs: inputs.length, schemaSkins: this.schema.skinCount() };
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
    warnings.push('Input floats are estimated from each item’s wear (exact floats need the in-game inspect); EV is an estimate until execution reads the real floats.');

    logger.info(`[tradeup] ${username}: ${top.length} profitable candidate(s) from ${inputs.length} eligible input(s)`);
    return { username, candidates: top, warnings, eligibleInputs: inputs.length, schemaSkins: this.schema.skinCount() };
  }

  /** Expands inventory stacks into individual trade-up-eligible input items (≤10 per stack). */
  private buildEligibleInputs(items: Array<{ marketHashName: string; quantity?: number; assetIds?: string[]; price?: number | null; category?: string }>): TuInput[] {
    const out: TuInput[] = [];
    for (const it of items) {
      if (it.category === 'listed') continue;                       // on the market, not in inventory
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
