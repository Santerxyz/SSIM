// ════════════════════════════════════════════════════════════════════════════
//  tradeupMath.ts — PURE trade-up contract math (no I/O, fully unit-testable).
//
//  Implements the CS2 trade-up rules exactly as specified:
//   • A contract = 10 inputs of the SAME rarity tier and SAME StatTrak status, each
//     a trade-up-eligible skin from a collection that has a next-rarity tier.
//   • Outcome pool = all next-rarity skins from the COLLECTIONS of the 10 inputs.
//     Each input lends 1/10 weight to its own collection's output pool; each outcome's
//     probability = (inputs from that collection ÷ 10) ÷ (next-rarity skins in that collection).
//   • Output float = avg(inputFloats) · (out.maxFloat − out.minFloat) + out.minFloat,
//     resolved to a wear bucket → market_hash_name → price.
//   • Expected value = Σ (outcome probability × outcome price at its wear).
//     Profit = EV − Σ input prices.
//
//  Money values are integer USD cents (same unit as PricingService) so the math is exact.
// ════════════════════════════════════════════════════════════════════════════

export const WEARS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'] as const;
export type Wear = typeof WEARS[number];

/** Standard CS2 wear float bands. A float in [lo, hi) maps to that wear (top band inclusive of 1.0). */
const WEAR_BANDS: ReadonlyArray<{ wear: Wear; lo: number; hi: number }> = [
  { wear: 'Factory New',    lo: 0.00, hi: 0.07 },
  { wear: 'Minimal Wear',   lo: 0.07, hi: 0.15 },
  { wear: 'Field-Tested',   lo: 0.15, hi: 0.38 },
  { wear: 'Well-Worn',      lo: 0.38, hi: 0.45 },
  { wear: 'Battle-Scarred', lo: 0.45, hi: 1.01 },
];

/** Maps a float (0..1) to its CS2 wear bucket. 0.07 is Minimal Wear (band lower bound inclusive). */
export function wearForFloat(f: number): Wear {
  if (!Number.isFinite(f)) throw new Error('wearForFloat: non-finite float');
  for (const b of WEAR_BANDS) if (f < b.hi) return b.wear;
  return 'Battle-Scarred';
}

/**
 * Wears a skin can actually roll given its float range. A trade-up output float spans
 * [minFloat, maxFloat] (outputFloatValue for avg∈(0,1)), so only wears whose band [lo, hi)
 * intersects that range are achievable — the others name market items that don't exist.
 * Endpoint-inclusive (over-inclusion is harmless; under-warming at boundaries is not).
 */
export function achievableWears(minFloat: number, maxFloat: number): Wear[] {
  return WEAR_BANDS.filter((b) => b.lo < maxFloat && b.hi > minFloat).map((b) => b.wear);
}

/**
 * Estimated input float when the EXACT float is unknown (the pure-web inventory does not expose
 * floats): the midpoint of the item's wear band, clamped to the skin's own [min,max] range. When
 * the band and the [min,max] range don't intersect (schema float-range drift), resolves to the
 * nearest range bound — skinMax if the band sits above the range, skinMin if below. The
 * GC execution path can substitute real floats; previews use this estimate (flagged in the UI).
 */
export function wearMidpoint(wear: Wear, skinMin = 0, skinMax = 1): number {
  const b = WEAR_BANDS.find((x) => x.wear === wear) ?? WEAR_BANDS[2];
  const lo = Math.max(b.lo, skinMin);
  const hi = Math.min(b.hi === 1.01 ? 1 : b.hi, skinMax);
  if (hi >= lo) return (lo + hi) / 2;
  return b.lo > skinMax ? skinMax : skinMin;
}

/** The trade-up output float for a given average input float and output skin float range. */
export function outputFloatValue(avgInputFloat: number, outMin: number, outMax: number): number {
  return avgInputFloat * (outMax - outMin) + outMin;
}

// ── Contract types ────────────────────────────────────────────────────────────

export interface TuInput {
  /** Full market_hash_name of the input item (display + pricing). */
  marketHashName: string;
  baseName:   string;
  collection: string;
  rarityId:   string;
  stattrak:   boolean;
  /** Exact (GC) or estimated (wear-midpoint) input float. */
  float:      number;
  priceCents: number | null;
  /** Owning asset id, when this input maps to a concrete inventory asset (for execution). */
  assetId?:   string;
}

export interface TuOutcome {
  name:           string;
  collection:     string;
  wear:           Wear;
  marketHashName: string;
  outFloat:       number;
  probability:    number;       // 0..1
  priceCents:     number | null;
  evCents:        number;       // probability × (priceCents ?? 0)
}

export interface TuContract {
  rarityId:       string;
  outputRarityId: string;
  stattrak:       boolean;
  inputs:         TuInput[];
  avgFloat:       number;
  outcomes:       TuOutcome[];
  costCents:      number;       // Σ input prices (unpriced inputs counted as 0)
  evCents:        number;       // Σ outcome EV
  profitCents:    number;       // EV − cost
  /** How many of the 10 inputs had a known price (confidence). */
  pricedInputs:   number;
  /** Total probability mass whose outcome had a known price (EV confidence, 0..1). */
  pricedOutcomeProb: number;
}

/** Output-pool + naming provider (backed by Cs2SchemaService in production, a fixture in tests). */
export interface OutputProvider {
  /** Next-rarity skins in `collection` above `inputRarityId` (empty when none). */
  outputsFor(collection: string, inputRarityId: string): Array<{ name: string; minFloat: number; maxFloat: number }>;
  /** Builds the market_hash_name Steam prices under (StatTrak™ prefix + wear suffix). */
  marketHashName(skinName: string, wear: Wear, stattrak: boolean): string;
}

export type PriceFn = (marketHashName: string) => number | null;

/**
 * Computes a full trade-up contract for an exact set of 10 inputs. Throws ONLY on a malformed
 * input set (not 10, mixed rarity, mixed StatTrak) — a pure validation error the caller guards
 * against before ever touching real items. Pricing gaps are tolerated (unpriced → 0 + flagged).
 */
export function computeContract(
  inputs: TuInput[],
  outputRarityId: string,
  schema: OutputProvider,
  price: PriceFn,
): TuContract {
  if (inputs.length !== 10) throw new Error(`a trade-up needs exactly 10 inputs (got ${inputs.length})`);
  const rarityId = inputs[0].rarityId;
  const stattrak = inputs[0].stattrak;
  if (!inputs.every((i) => i.rarityId === rarityId)) throw new Error('all 10 inputs must share the same rarity');
  if (!inputs.every((i) => i.stattrak === stattrak)) throw new Error('all 10 inputs must share the same StatTrak status');
  if (!inputs.every((i) => Number.isFinite(i.float))) throw new Error('every input needs a finite float');

  const avgFloat = inputs.reduce((s, i) => s + i.float, 0) / 10;

  // Inputs per collection → that collection's share of the 10/10 probability mass.
  const perCollection = new Map<string, number>();
  for (const i of inputs) perCollection.set(i.collection, (perCollection.get(i.collection) ?? 0) + 1);

  // Build outcomes, merging by market_hash_name (defensive — a skin shared across two input
  // collections would otherwise appear twice; summing probabilities keeps the total at 1).
  const merged = new Map<string, TuOutcome>();
  for (const [collection, count] of perCollection) {
    const outs = schema.outputsFor(collection, rarityId);
    if (outs.length === 0) continue; // eligible inputs guarantee ≥1; defensive skip
    const per = (count / 10) / outs.length;
    for (const o of outs) {
      const outFloat = outputFloatValue(avgFloat, o.minFloat, o.maxFloat);
      const wear = wearForFloat(outFloat);
      const mhn = schema.marketHashName(o.name, wear, stattrak);
      const priceCents = price(mhn);
      const ex = merged.get(mhn);
      if (ex) {
        ex.probability += per;
        ex.evCents = ex.probability * (ex.priceCents ?? 0);
      } else {
        merged.set(mhn, {
          name: o.name, collection, wear, marketHashName: mhn, outFloat,
          probability: per, priceCents, evCents: per * (priceCents ?? 0),
        });
      }
    }
  }

  const outcomes = [...merged.values()].sort((a, b) => b.probability - a.probability);
  const costCents = inputs.reduce((s, i) => s + (i.priceCents ?? 0), 0);
  const evCents = outcomes.reduce((s, o) => s + o.evCents, 0);
  const pricedInputs = inputs.filter((i) => i.priceCents != null).length;
  const pricedOutcomeProb = outcomes.filter((o) => o.priceCents != null).reduce((s, o) => s + o.probability, 0);

  return {
    rarityId, outputRarityId, stattrak, inputs, avgFloat, outcomes,
    costCents: Math.round(costCents),
    evCents: Math.round(evCents),
    profitCents: Math.round(evCents - costCents),
    pricedInputs,
    pricedOutcomeProb,
  };
}
