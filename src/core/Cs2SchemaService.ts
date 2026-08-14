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
// The live schema indexes ~thousands of skins from a 4.7MB file; 500 is an
// order-of-magnitude floor (an empty [] or format-drifted array indexes to ~0).
const MIN_SCHEMA_SKINS = 500;
// A usable disk cache older than this is refreshed from ByMykel (Valve ships new
// collections/cases a few times a year; ByMykel corrects float ranges/rarities
// continuously). Without this the cache had an infinite TTL — none of it ever
// reached an installed fleet. A refresh failure serves the dated cache, never empty.
const SCHEMA_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * The WEAPON trade-up ladder: each rarity tier → the tier a contract of it PRODUCES.
 * Terminal tiers are absent (Covert produces nothing tradeable; Contraband is unobtainable).
 * Knife/glove 'rarity_ancient' (note: NO '_weapon' suffix) is deliberately not a ladder member —
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
  /** Steam economy image URL for the skin (ByMykel `image`); '' when absent. */
  image?:      string;
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
  /** `${weapon_id}:${paint_index}` → skin. The ONLY way to name a Game-Coordinator econ item:
   *  the GC never sends market_hash_name, just def_index (= ByMykel weapon.weapon_id) + paint_index.
   *  Used by the storage-unit (casket) reader, which otherwise can only show raw asset ids. */
  private byDefPaint = new Map<string, SkinDef>();
  private loaded = false;
  private loadingPromise?: Promise<void>;

  isLoaded(): boolean { return this.loaded; }
  skinCount(): number { return this.byBaseName.size; }
  collectionCount(): number { return this.byCollectionRarity.size; }
  defPaintCount(): number { return this.byDefPaint.size; }

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
    // A usable-but-stale disk cache we can fall back to if a refresh fails (never empty).
    let staleRaw: unknown[] | undefined;
    let staleMtime = 0;
    if (Array.isArray(raw)) {
      // Disk cache: only trust it if it actually indexes a usable schema. An empty [] or a
      // format-drifted file (upstream shape change) indexes to ~0 skins and would otherwise be
      // authoritative forever — refetch instead of trusting the poisoned cache.
      this.index(raw as unknown[]);
      if (this.byBaseName.size >= MIN_SCHEMA_SKINS) {
        // Freshness policy: a usable cache within the TTL is authoritative; older than the TTL
        // we refresh from ByMykel (a stat failure counts as stale → refresh, same fallback).
        let mtimeMs = 0;
        try { mtimeMs = fsExtra.statSync(SCHEMA_FILE).mtimeMs; } catch { /* stat failed → treat as stale */ }
        if (mtimeMs && Date.now() - mtimeMs <= SCHEMA_MAX_AGE_MS) {
          this.loaded = true;
          logger.info(`[schema] loaded ${this.byBaseName.size} skins across ${this.byCollectionRarity.size} collections`);
          return;
        }
        staleRaw = raw as unknown[];
        staleMtime = mtimeMs;
      } else {
        logger.warn(`[schema] cached cs2-skins.json unusable (${this.byBaseName.size} skins indexed) — refetching`);
      }
    }
    logger.info('[schema] fetching CS2 skin schema from ByMykel…');
    try {
      const r = await axios.get(BYMYKEL_URL, { timeout: 20_000, validateStatus: () => true });
      if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`CS2 schema fetch failed (HTTP ${r.status})`);
      this.index(r.data as unknown[]);
      if (this.byBaseName.size < MIN_SCHEMA_SKINS) throw new Error(`CS2 schema unusable (${this.byBaseName.size} skins parsed)`);
      try { writeJsonAtomic(SCHEMA_FILE, r.data, { spaces: 0 }); }
      catch (e) { logger.warn(`[schema] could not cache cs2-skins.json: ${(e as Error).message} — schema will be re-fetched next run`); }
      this.loaded = true;
      logger.info(`[schema] loaded ${this.byBaseName.size} skins across ${this.byCollectionRarity.size} collections`);
    } catch (e) {
      if (staleRaw) {
        // Refresh failed but we hold a usable dated cache — serve it (stale-but-usable beats empty;
        // keep-current policy, not a retry wrapper). Do not touch the file.
        const dated = staleMtime ? new Date(staleMtime).toISOString() : 'unknown';
        logger.warn(`[schema] refresh failed (${(e as Error).message}) — serving cached schema from ${dated}`);
        this.index(staleRaw);
        this.loaded = true;
        logger.info(`[schema] loaded ${this.byBaseName.size} skins across ${this.byCollectionRarity.size} collections`);
        return;
      }
      // No usable cache at all — a well-formed but empty/drifted 200 must not be persisted (the
      // infinite-TTL poison). Clear the indexes, stay unloaded, and surface a visible, retryable error.
      this.byBaseName.clear();
      this.byCollectionRarity.clear();
      this.loaded = false;
      throw e;
    }
  }

  /** Builds the lookup indexes from a raw ByMykel skins array. Public so tests can feed a fixture. */
  index(skins: unknown[]): void {
    this.byBaseName.clear();
    this.byCollectionRarity.clear();
    this.byDefPaint.clear();
    for (const s of skins as Array<Record<string, unknown>>) {
      const name = typeof s?.name === 'string' ? s.name : '';
      const rarityId = (s?.rarity as { id?: unknown })?.id;
      if (!name || typeof rarityId !== 'string') continue;
      const collections = Array.isArray(s?.collections) ? s.collections as Array<Record<string, unknown> | string> : [];
      const first = collections[0];
      const nm = (first as { name?: unknown })?.name;
      const collection = typeof first === 'string' ? first.trim() : typeof nm === 'string' ? nm.trim() : '';
      const def: SkinDef = {
        name, rarityId, collection,
        minFloat: numOr(s?.min_float, 0),
        maxFloat: numOr(s?.max_float, 1),
        image: typeof s?.image === 'string' ? s.image : '',
      };
      const key = name.toLowerCase();
      if (!this.byBaseName.has(key)) this.byBaseName.set(key, def); // first wins (stable)
      // GC lookup key. ByMykel emits paint_index as a STRING ("387"); the GC decodes it from a
      // float attribute, so normalise both sides through Number to keep "0387"/387/387.0 in one slot.
      const weaponId = (s?.weapon as { weapon_id?: unknown })?.weapon_id;
      const paintIdx = Number(s?.paint_index);
      if (typeof weaponId === 'number' && Number.isFinite(paintIdx)) {
        const dp = `${weaponId}:${paintIdx}`;
        if (!this.byDefPaint.has(dp)) this.byDefPaint.set(dp, def); // first wins (stable)
      }
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

  /** Resolves a Game-Coordinator econ item's (def_index, paint_index) to its skin. This is the
   *  bridge that lets storage-unit contents show real item names — the GC sends no name at all. */
  lookupByDefPaint(defIndex: number | undefined, paintIndex: number | undefined): SkinDef | undefined {
    if (!Number.isFinite(defIndex) || !Number.isFinite(paintIndex)) return undefined;
    return this.byDefPaint.get(`${Number(defIndex)}:${Number(paintIndex)}`);
  }

  /** OutputProvider.outputsFor — next-rarity skins in `collection` above `inputRarityId`, DEDUPED
   *  by market name. Steam treats same-named variants (e.g. a Gamma Doppler's phases) as one
   *  tradeable item, so the trade-up output pool must count each name once — otherwise that
   *  outcome's probability is doubled and the EV skews. (Found in the 2021 Train Collection.) */
  outputsFor(collection: string, inputRarityId: string): Array<{ name: string; minFloat: number; maxFloat: number }> {
    const next = RARITY_LADDER[inputRarityId];
    if (!next) return [];
    const skins = this.byCollectionRarity.get(collection)?.get(next) ?? [];
    const seen = new Set<string>();
    const out: Array<{ name: string; minFloat: number; maxFloat: number }> = [];
    for (const s of skins) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, minFloat: s.minFloat, maxFloat: s.maxFloat });
    }
    return out;
  }

  /** A skin is a valid trade-up INPUT iff it's a weapon tier with a next tier and its collection
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

// Type-honest: a null/'' field must yield the declared default, not Number(null)===0.
// ByMykel emits floats as JSON numbers, so numeric-string tolerance is not needed.
function numOr(v: unknown, d: number): number { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

/** Process-wide singleton (mirrors PricingService / ExchangeRateService). */
export const cs2Schema = new Cs2SchemaService();
