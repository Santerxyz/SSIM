import axios from 'axios';
import fsExtra from 'fs-extra';
import { dataDir } from '../utils/paths';
import { writeJsonAtomic } from '../utils/atomicJson';
import { logger } from '../utils/logger';
import { cs2Schema } from './Cs2SchemaService';
import { wearForFloat, type Wear } from '../trading/tradeupMath';

// ════════════════════════════════════════════════════════════════════════════
//  Cs2ItemResolver — turns a raw Game-Coordinator econ item into a real item name.
//
//  WHY this EXISTS: the GC never sends `market_hash_name`. A storage-unit (casket)
//  read returns only { id, def_index, paint_index, paint_wear, quality, … }, which
//  is why the Storage Units panel could only ever show "Item 44029384756". Steam's
//  WEB inventory — the usual source of names — deliberately omits casket CONTENTS,
//  so there is no web fallback: the name has to be reconstructed from the schema.
//
//  two INDEXES, TRIED IN this ORDER:
//   1. PAINTED items (skins/knives/gloves) — keyed (def_index, paint_index) against the
//      ByMykel skins schema Cs2SchemaService already loads. Wear comes from the real
//      paint_wear float, so the name is the exact market_hash_name incl. its wear suffix.
//   2. EVERYTHING ELSE (cases, capsules, agents, keys, tools, patches, collectibles) —
//      keyed on def_index alone, from the small merged catalog this file owns.
//
//  Order matters: a painted item ALWAYS carries paint_index, so index 1 claims it before
//  def_index alone can mis-hit. music_kits is deliberately not merged into index 2 — its
//  ByMykel `def_index` is the music ID (Valve's kit #1), which would collide head-on with
//  weapon def_index 1 (Desert Eagle) and rename vanilla Deagles to music kits.
// ════════════════════════════════════════════════════════════════════════════

const DEFS_FILE = dataDir('cs2-defs.json');
const BYMYKEL_BASE = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';
/** Merged in def_index order. music_kits is excluded on purpose (see header). */
const DEF_SOURCES = ['crates', 'agents', 'keys', 'tools', 'patches', 'collectibles'] as const;
/** The live catalog indexes ~2000 rows; 200 is an order-of-magnitude floor that rejects
 *  an empty/format-drifted fetch instead of caching it as authoritative forever. */
const MIN_DEFS = 200;
/** Valve ships new cases/agents/capsules continuously — same 14-day policy as the skin schema. */
const DEFS_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/** CS2 item quality values (CSOEconItem.quality). */
const QUALITY_STRANGE = 9;    // StatTrak™
const QUALITY_TOURNAMENT = 12; // Souvenir

/** One catalog row, stored in the stripped shape we actually use (keeps the cache ~100KB
 *  instead of the ~9MB of upstream JSON, which is mostly per-crate `contains` arrays). */
interface DefRow { d: number; n: string; i?: string }

/** The minimum shape of a GC econ item this resolver reads. */
export interface GcEconItem {
  id:            string;
  def_index?:    number;
  paint_index?:  number;
  paint_wear?:   number;
  paint_seed?:   number;
  quality?:      number;
  custom_name?:  string;
  [k: string]: unknown;
}

export interface ResolvedItem {
  /** The exact Steam market_hash_name when resolved, else a best-effort label. */
  marketHashName: string;
  /** Base skin name without wear/StatTrak, e.g. "AK-47 | Redline"; '' for non-skins. */
  baseName:       string;
  wear:           Wear | null;
  /** The real per-item float from the GC (never an estimate); null for non-painted items. */
  float:          number | null;
  paintSeed:      number | null;
  stattrak:       boolean;
  souvenir:       boolean;
  iconUrl:        string;
  customName:     string;
  /** False when neither index could name it — the UI must say "unknown", never invent a name. */
  resolved:       boolean;
}

export class Cs2ItemResolver {
  private byDefIndex = new Map<number, DefRow>();
  private loaded = false;
  private loadingPromise?: Promise<void>;

  isLoaded(): boolean { return this.loaded; }
  defCount(): number { return this.byDefIndex.size; }

  /**
   * Loads the non-painted item catalog (disk cache → ByMykel fetch fallback). Idempotent +
   * concurrency-deduped, and called LAZILY (first storage-unit read) rather than at boot —
   * the upstream files total ~9MB and nothing else in SSIM needs them.
   *
   * NEVER THROWS: a resolver that can't load its second index still names every skin via the
   * schema index, which is the overwhelming bulk of a storage unit. Failing the whole casket
   * read over a missing case catalog would be a strict regression on today's behaviour.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.load()
      .catch((e) => { logger.warn(`[cs2defs] catalog unavailable — cases/agents will show as unknown: ${(e as Error).message}`); })
      .finally(() => { this.loadingPromise = undefined; });
    return this.loadingPromise;
  }

  private async load(): Promise<void> {
    let cached: unknown;
    try { if (fsExtra.existsSync(DEFS_FILE)) cached = fsExtra.readJsonSync(DEFS_FILE); }
    catch (e) { logger.warn(`[cs2defs] cached cs2-defs.json unreadable: ${(e as Error).message}`); }

    let staleRows: DefRow[] | undefined;
    if (Array.isArray(cached)) {
      this.indexRows(cached as DefRow[]);
      if (this.byDefIndex.size >= MIN_DEFS) {
        let mtimeMs = 0;
        try { mtimeMs = fsExtra.statSync(DEFS_FILE).mtimeMs; } catch { /* stat failed → treat as stale */ }
        if (mtimeMs && Date.now() - mtimeMs <= DEFS_MAX_AGE_MS) {
          this.loaded = true;
          logger.info(`[cs2defs] loaded ${this.byDefIndex.size} item definitions (cache)`);
          return;
        }
        staleRows = cached as DefRow[];
      } else {
        logger.warn(`[cs2defs] cached cs2-defs.json unusable (${this.byDefIndex.size} rows) — refetching`);
      }
    }

    logger.info('[cs2defs] fetching CS2 item catalog from ByMykel…');
    try {
      const rows: DefRow[] = [];
      for (const src of DEF_SOURCES) {
        const r = await axios.get(`${BYMYKEL_BASE}/${src}.json`, { timeout: 30_000, validateStatus: () => true });
        if (r.status !== 200 || !Array.isArray(r.data)) {
          // One dead category must not lose the other five — keep what we have and carry on.
          logger.warn(`[cs2defs] ${src}.json unavailable (HTTP ${r.status}) — skipped`);
          continue;
        }
        for (const raw of r.data as Array<Record<string, unknown>>) {
          const d = Number(raw?.def_index);
          const n = typeof raw?.market_hash_name === 'string' && raw.market_hash_name
            ? raw.market_hash_name
            : typeof raw?.name === 'string' ? raw.name : '';
          if (!Number.isFinite(d) || !n) continue;
          rows.push({ d, n, i: typeof raw?.image === 'string' ? raw.image : undefined });
        }
      }
      this.indexRows(rows);
      if (this.byDefIndex.size < MIN_DEFS) throw new Error(`CS2 item catalog unusable (${this.byDefIndex.size} rows parsed)`);
      try { writeJsonAtomic(DEFS_FILE, rows, { spaces: 0 }); }
      catch (e) { logger.warn(`[cs2defs] could not cache cs2-defs.json: ${(e as Error).message} — will refetch next run`); }
      this.loaded = true;
      logger.info(`[cs2defs] loaded ${this.byDefIndex.size} item definitions`);
    } catch (e) {
      if (staleRows) {
        // A dated catalog beats none (same keep-current policy as the skin schema); don't touch the file.
        logger.warn(`[cs2defs] refresh failed (${(e as Error).message}) — serving the cached catalog`);
        this.indexRows(staleRows);
        this.loaded = true;
        return;
      }
      this.byDefIndex.clear();
      this.loaded = false;
      throw e;
    }
  }

  /** Builds the def_index index. Public so tests can feed a fixture without touching the network. */
  indexRows(rows: DefRow[]): void {
    this.byDefIndex.clear();
    for (const row of rows) {
      if (!row || !Number.isFinite(Number(row.d)) || typeof row.n !== 'string' || !row.n) continue;
      const d = Number(row.d);
      if (!this.byDefIndex.has(d)) this.byDefIndex.set(d, { d, n: row.n, i: row.i }); // first wins (stable)
    }
  }

  /**
   * Names one GC econ item. Pure + synchronous — call ensureLoaded() once before a batch.
   * A miss is reported honestly (`resolved:false`) with a def-index label, never a guess.
   */
  resolve(item: GcEconItem): ResolvedItem {
    const stattrak = item.quality === QUALITY_STRANGE;
    const souvenir = item.quality === QUALITY_TOURNAMENT;
    const customName = typeof item.custom_name === 'string' ? item.custom_name : '';
    const float = Number.isFinite(item.paint_wear) ? Number(item.paint_wear) : null;
    const paintSeed = Number.isFinite(item.paint_seed) ? Number(item.paint_seed) : null;

    // 1. Painted item (skin/knife/glove) — the exact market name, wear from the real float.
    const skin = cs2Schema.lookupByDefPaint(item.def_index, item.paint_index);
    if (skin) {
      // A painted item with no readable float can still be named — it just carries no wear suffix
      // (vanilla-style/no-wear entries), so never fabricate a wear band from a missing float.
      const wear = float != null ? wearForFloat(float) : null;
      const prefix = souvenir ? 'Souvenir ' : stattrak ? 'StatTrak™ ' : '';
      // Knives/gloves already carry the ★ in their schema name; StatTrak sits after it on Steam
      // ("★ StatTrak™ Karambit | Doppler (FN)"), so splice rather than prepend blindly.
      const star = skin.name.startsWith('★ ');
      const body = star ? skin.name.slice(2) : skin.name;
      const named = `${star ? '★ ' : ''}${prefix}${body}${wear ? ` (${wear})` : ''}`;
      return {
        marketHashName: named, baseName: skin.name, wear, float, paintSeed,
        stattrak, souvenir, iconUrl: skin.image || '', customName, resolved: true,
      };
    }

    // 2. Non-painted item (case, capsule, agent, key, tool, patch, collectible).
    const def = Number.isFinite(item.def_index) ? this.byDefIndex.get(Number(item.def_index)) : undefined;
    if (def) {
      return {
        marketHashName: def.n, baseName: def.n, wear: null, float, paintSeed,
        stattrak, souvenir, iconUrl: def.i || '', customName, resolved: true,
      };
    }

    return {
      marketHashName: item.def_index != null ? `Unknown item (def ${item.def_index})` : 'Unknown item',
      baseName: '', wear: null, float, paintSeed, stattrak, souvenir,
      iconUrl: '', customName, resolved: false,
    };
  }
}

/** Process-wide singleton (mirrors cs2Schema / PricingService). */
export const cs2Items = new Cs2ItemResolver();
