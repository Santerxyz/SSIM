import axios from 'axios';
import fsExtra from 'fs-extra';
import { dataDir } from '../utils/paths';
import { writeJsonAtomic } from '../utils/atomicJson';
import { logger } from '../utils/logger';
import type { Wear } from '../trading/tradeupMath';

// ════════════════════════════════════════════════════════════════════════════
//  Cs2SchemaService — CS2 skin schema (collections, rarities, float ranges) for
//  the trade-up calculator. Reads the cached ByMykel CSGO-API skins file from
//  data/cs2-skins.json; if absent, fetches it once from ByMykel and caches it.
//  Read-only schema (public game data) — never user secrets.
// ════════════════════════════════════════════════════════════════════════════

const SCHEMA_FILE = dataDir('cs2-skins.json');
const BYMYKEL_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';

/**
 * The WEAPON trade-up ladder: each rarity tier → the tier a contract of it PRODUCES.
 * Terminal tiers are absent (Covert produces nothing tradeable; Contraband is unobtainable).
 * Knife/glove 'rarity_ancient' (note: NO '_weapon' suffix) is deliberately NOT a ladder member —
 * those are not trade-up inputs or outputs.
 */
const RARITY_LADDER: Record<string, string> = {
  rarity_common_weapon:    'rarity_uncommon_weapon',
  rarity_uncommon_weapon:  'rarity_rare_weapon',
  rarity_rare_weapon:      'rarity_mythical_weapon',
  rarity_mythical_weapon:  'rarity_legendary_weapon',
  rarity_legendary_weapon: 'rarity_ancient_weapon',
};
const RARITY_LABEL: Record<string, string> = {
  rarity_common_weapon: 'Consumer Grade', rarity_uncommon_weapon: 'Industrial Grade',
  rarity_rare_weapon: 'Mil-Spec Grade', rarity_mythical_weapon: 'Restricted',
  rarity_legendary_weapon: 'Classified', rarity_ancient_weapon: 'Covert',
};

export interface SkinDef {
  name:        string;   // base name, e.g. "AK-47 | Redline" (no wear / StatTrak)
  rarityId:    string;
  collection:  string;   // canonical (first) collection name; '' if none
  minFloat:    number;
  maxFloat:    number;
  hasStatTrak: boolean;
}

/**
 * Parses a full market_hash_name into its base skin name + wear + StatTrak/Souvenir flags.
 * Returns wear:null for an item with no wear suffix. Pure + exported for unit tests.
 *   "StatTrak™ AK-47 | Redline (Field-Tested)" → { baseName:"AK-47 | Redline", wear:"Field-Tested", stattrak:true }
 */
export function parseSkinName(marketHashName: string):
  { baseName: string; wear: Wear | null; stattrak: boolean; souvenir: boolean } {
  let s = String(marketHashName ?? '').trim();
  const souvenir = /^Souvenir /.test(s);
  if (souvenir) s = s.replace(/^Souvenir /, '');
  const stattrak = /^(★ )?StatTrak™ /.test(s);
  s = s.replace(/^★ StatTrak™ /, '★ ').replace(/^StatTrak™ /, '');
  const m = s.match(/^(.*) \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/);
  if (m) return { baseName: m[1].trim(), wear: m[2] as Wear, stattrak, souvenir };
  return { baseName: s.trim(), wear: null, stattrak, souvenir };
}

export class Cs2SchemaService {
  private byBaseName = new Map<string, SkinDef>();
  private byCollectionRarity = new Map<string, Map<string, SkinDef[]>>(); // collection → rarityId → skins
  private loaded = false;
  private loadingPromise?: Promise<void>;

  isLoaded(): boolean { return this.loaded; }
  skinCount(): number { return this.byBaseName.size; }
  collectionCount(): number { return this.byCollectionRarity.size; }

  /** Loads the schema (disk cache → ByMykel fetch fallback). Idempotent + concurrency-deduped. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.load().finally(() => { this.loadingPromise = undefined; });
    return this.loadingPromise;
  }

  private async load(): Promise<void> {
    let raw: unknown;
    try { if (fsExtra.existsSync(SCHEMA_FILE)) raw = fsExtra.readJsonSync(SCHEMA_FILE); }
    catch (e) { logger.warn(`[schema] local cs2-skins.json unreadable: ${(e as Error).message}`); }
    if (!Array.isArray(raw)) {
      logger.info('[schema] fetching CS2 skin schema from ByMykel…');
      const r = await axios.get(BYMYKEL_URL, { timeout: 20_000, validateStatus: () => true });
      if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`CS2 schema fetch failed (HTTP ${r.status})`);
      raw = r.data;
      try { writeJsonAtomic(SCHEMA_FILE, raw, { spaces: 0 }); } catch { /* cache is best-effort */ }
    }
    this.index(raw as unknown[]);
    this.loaded = true;
    logger.info(`[schema] loaded ${this.byBaseName.size} skins across ${this.byCollectionRarity.size} collections`);
  }

  /** Builds the lookup indexes from a raw ByMykel skins array. Public so tests can feed a fixture. */
  index(skins: unknown[]): void {
    this.byBaseName.clear();
    this.byCollectionRarity.clear();
    for (const s of skins as Array<Record<string, unknown>>) {
      const name = typeof s?.name === 'string' ? s.name : '';
      const rarityId = (s?.rarity as { id?: unknown })?.id;
      if (!name || typeof rarityId !== 'string') continue;
      const collections = Array.isArray(s?.collections) ? s.collections as Array<Record<string, unknown> | string> : [];
      const first = collections[0];
      const collection = first ? String((first as { name?: unknown })?.name ?? first ?? '') : '';
      const def: SkinDef = {
        name, rarityId, collection,
        minFloat: numOr(s?.min_float, 0),
        maxFloat: numOr(s?.max_float, 1),
        hasStatTrak: !!s?.stattrak,
      };
      const key = name.toLowerCase();
      if (!this.byBaseName.has(key)) this.byBaseName.set(key, def); // first wins (stable)
      // Output pooling index: only weapon-tier skins that belong to a collection.
      if (collection && /_weapon$/.test(rarityId)) {
        let m = this.byCollectionRarity.get(collection);
        if (!m) { m = new Map(); this.byCollectionRarity.set(collection, m); }
        const arr = m.get(rarityId) ?? [];
        arr.push(def);
        m.set(rarityId, arr);
      }
    }
    this.loaded = true; // index() alone makes the service usable (tests don't call load())
  }

  nextRarity(rarityId: string): string | undefined { return RARITY_LADDER[rarityId]; }
  rarityLabel(rarityId: string): string { return RARITY_LABEL[rarityId] ?? rarityId; }
  lookup(baseName: string): SkinDef | undefined { return this.byBaseName.get(baseName.toLowerCase()); }

  /** OutputProvider.outputsFor — next-rarity skins in `collection` above `inputRarityId`. */
  outputsFor(collection: string, inputRarityId: string): Array<{ name: string; minFloat: number; maxFloat: number }> {
    const next = RARITY_LADDER[inputRarityId];
    if (!next) return [];
    const skins = this.byCollectionRarity.get(collection)?.get(next) ?? [];
    return skins.map((s) => ({ name: s.name, minFloat: s.minFloat, maxFloat: s.maxFloat }));
  }

  /** A skin is a valid trade-up INPUT iff it's a weapon tier with a next tier AND its collection
   *  actually has ≥1 next-tier skin to produce. */
  isEligibleInput(def: SkinDef): boolean {
    const next = RARITY_LADDER[def.rarityId];
    if (!next || !def.collection) return false;
    return (this.byCollectionRarity.get(def.collection)?.get(next)?.length ?? 0) > 0;
  }

  /** OutputProvider.marketHashName — the exact string Steam prices the output under. */
  marketHashName(skinName: string, wear: Wear, stattrak: boolean): string {
    return `${stattrak ? 'StatTrak™ ' : ''}${skinName} (${wear})`;
  }
}

function numOr(v: unknown, d: number): number { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Process-wide singleton (mirrors PricingService / ExchangeRateService). */
export const cs2Schema = new Cs2SchemaService();
