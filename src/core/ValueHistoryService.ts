import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';
import type { AccountManager } from './AccountManager';
import type { AccountInventory, GameId } from '../types/inventory';

/** Which game series a snapshot should touch. Scoping to the refreshed game stops a
 *  TF2 refresh from rewriting a recent CS2 point (and vice-versa). undefined → both
 *  (manual/post-trade where the caller doesn't know). (C21 / INV-E6.) */
export function snapshotGames(game?: GameId): { cs2: boolean; tf2: boolean } {
  return { cs2: game !== 'tf2', tf2: game !== 'cs2' };
}
import type { PricingService } from '../pricing/PricingService';
import type { ExchangeRateService } from '../pricing/ExchangeRateService';

const HISTORY_PATH = dataDir('value_history.json');

/** Hard cap per series – at one point per refresh this is months of history. */
const MAX_POINTS_PER_SERIES = 2000;
/**
 * Points closer together than this MERGE into the previous one (the latest
 * values win). Protects the curve from bursts – e.g. post-trade refreshes of
 * two accounts within seconds should not produce two near-identical points.
 */
const MIN_INTERVAL_MS = 60_000;

/** Series id of the all-environments aggregate. */
export const GLOBAL_SERIES = 'global';

export interface HistoryPoint {
  /** Snapshot time (unix ms). */
  t: number;
  /** Total items worth in USD cents (same unit as inv.totalValueUsd). */
  items: number;
  /** Total wallet balance in USD cents (converted like the dashboard does). */
  wallet: number;
  /** S66: true when at least one loaded account held a wallet balance in a currency we can't convert to USD
   *  (FX covers only USD↔EUR), so `wallet` UNDERCOUNTS the real total for this point. Lets the UI flag the
   *  wallet series as incomplete instead of silently plotting a too-low value as if it were exact. */
  partial?: boolean;
}

interface HistoryFile {
  version: number;
  /** seriesId (environment id | 'global') → chronological points. */
  series: Record<string, HistoryPoint[]>;
}

/**
 * Records one (items-worth, wallet) point per environment + a global aggregate
 * after every inventory refresh, so the dashboard can draw a value curve over
 * time. Values are computed from the inventory CACHE (no network) and mirror
 * the dashboard's own aggregation: items = Σ totalValueUsd, wallet = Σ balance
 * converted to USD via the live exchange rate (USD=1, EUR=3 wallets).
 */
export class ValueHistoryService {
  private data: HistoryFile;
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private readonly accounts: AccountManager,
    /** CS2 inventory reader (the service passes a GC-preferred merged view). */
    private readonly store:    { get(username: string): AccountInventory | undefined },
    /** TF2 inventory reader — enables a PARALLEL TF2 worth/wallet series per environment. */
    private readonly tf2Store: { get(username: string): AccountInventory | undefined },
    private readonly pricing:  PricingService,
    private readonly exchange: ExchangeRateService,
  ) {
    this.data = this.load();
  }

  // ── Persistence (debounced, mirrors InventoryStore) ─────────────────────────

  private load(): HistoryFile {
    try {
      if (fsExtra.existsSync(HISTORY_PATH)) {
        const parsed = fsExtra.readJsonSync(HISTORY_PATH) as HistoryFile;
        if (parsed && typeof parsed.series === 'object') return { version: 1, series: parsed.series ?? {} };
      }
    } catch (err) {
      logger.warn(`value_history.json unreadable, starting fresh: ${(err as Error).message}`);
    }
    return { version: 1, series: {} };
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 2_000);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (!this.dirty) return;
    try {
      writeJsonAtomic(HISTORY_PATH, this.data, { spaces: 0 });
      this.dirty = false;
    } catch (err) {
      logger.warn(`failed to persist value_history.json: ${(err as Error).message}`);
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  /** Chronological points of a series ('global' or an environment id), per game. The TF2
   *  series is stored under a 'tf2:' prefix so CS2 + TF2 curves never overwrite each other. */
  get(seriesId: string, game: 'cs2' | 'tf2' = 'cs2'): HistoryPoint[] {
    return this.data.series[game === 'tf2' ? `tf2:${seriesId}` : seriesId] ?? [];
  }

  /**
   * Aggregates the per-environment series of `seriesIds` into ONE curve for `game`,
   * summing items + wallet across the selected environments (F3b — the global-master chart
   * follows the environment selection). Robust to environments that started recording at
   * different times: at each timestamp present in ANY selected series, every series
   * contributes its latest value AT-OR-BEFORE that timestamp (carry-forward), or 0 before
   * its first point — so toggling a young environment in never makes the total dip. Output
   * is chronological and capped to MAX_POINTS_PER_SERIES (most-recent kept).
   */
  aggregate(seriesIds: string[], game: 'cs2' | 'tf2' = 'cs2'): HistoryPoint[] {
    const prefix = game === 'tf2' ? 'tf2:' : '';
    const series = [...new Set(seriesIds)]
      .map((id) => this.data.series[prefix + id])
      .filter((arr): arr is HistoryPoint[] => Array.isArray(arr) && arr.length > 0);
    if (series.length === 0) return [];
    if (series.length === 1) return series[0].map((p) => ({ ...p })); // one env → its own curve

    const tsSet = new Set<number>();
    for (const arr of series) for (const p of arr) tsSet.add(p.t);
    const timestamps = [...tsSet].sort((a, b) => a - b);

    const cursors = series.map(() => 0); // per-series carry-forward index (timestamps ascending)
    const out: HistoryPoint[] = [];
    for (const t of timestamps) {
      let items = 0, wallet = 0;
      for (let s = 0; s < series.length; s++) {
        const arr = series[s];
        let i = cursors[s];
        while (i + 1 < arr.length && arr[i + 1].t <= t) i++;
        cursors[s] = i;
        const p = arr[i];
        if (p && p.t <= t) { items += p.items; wallet += p.wallet; } // before first point → 0
      }
      out.push({ t, items, wallet });
    }
    return out.length > MAX_POINTS_PER_SERIES ? out.slice(out.length - MAX_POINTS_PER_SERIES) : out;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  /**
   * Takes ONE snapshot pass over the inventory cache: appends a point to every
   * environment series (that has at least one cached inventory) plus the global
   * aggregate. Cheap – memory only – so it is safe to call after every refresh.
   */
  snapshotAll(reason: string, game?: GameId): void {
    const now = Date.now();
    // Snapshot ONLY the game(s) that actually refreshed. Snapshotting BOTH on every call
    // let a TF2 refresh rewrite a recent CS2 point (and vice-versa) via burst-coalescing in
    // append() — last-writer-wins on the curve. `game` undefined → snapshot both (manual/
    // post-trade where the caller doesn't scope it). (C21 / INV-E6.)
    const which = snapshotGames(game);
    if (which.cs2) this.snapshotGame(now, this.store, '');        // CS2 → '<id>' / 'global'
    if (which.tf2) this.snapshotGame(now, this.tf2Store, 'tf2:'); // TF2 → 'tf2:<id>' / 'tf2:global'
    this.scheduleFlush();
    logger.debug(`[history] snapshot taken (${reason}${game ? `, ${game}` : ''})`);
  }

  /** Snapshots ONE game's cache into '<prefix><envId>' + '<prefix>global' series. */
  private snapshotGame(now: number, store: { get(u: string): AccountInventory | undefined }, prefix: string): void {
    let globalItems = 0, globalWallet = 0, globalLoaded = 0, globalPartial = false;
    for (const env of this.accounts.getEnvironments()) {
      let items = 0, wallet = 0, loaded = 0, partial = false;
      for (const acc of this.accounts.getByEnvironment(env.id)) {
        const inv = store.get(acc.username);
        if (!inv) continue;
        loaded++;
        this.pricing.enrich(inv); // cache-only: prices + totalValueUsd refreshed in place
        items  += inv.totalValueUsd ?? 0;
        const w = inv.wallet;
        const cents = this.walletUsdCents(w);
        // S66: a wallet we couldn't convert (non-USD/EUR) but that HAS a real balance means `wallet` is
        // undercounted for this point — flag it partial rather than silently plotting a too-low total.
        if (cents == null && w && typeof w.balance === 'number' && w.balance > 0) partial = true;
        wallet += cents ?? 0;
      }
      if (loaded === 0) continue; // nothing cached → no meaningful point
      this.append(prefix + env.id, now, items, wallet, partial);
      globalItems += items; globalWallet += wallet; globalLoaded += loaded; globalPartial = globalPartial || partial;
    }
    if (globalLoaded > 0) this.append(prefix + GLOBAL_SERIES, now, globalItems, globalWallet, globalPartial);
  }

  /** Steam wallet → USD cents (USD=1 as-is, EUR=3 via live rate, else skip). */
  private walletUsdCents(w?: { currency: number; balance: number }): number | null {
    if (!w || typeof w.balance !== 'number') return null;
    if (w.currency === 1) return Math.round(w.balance * 100);
    if (w.currency === 3) return Math.round((w.balance / this.exchange.getUsdToEur()) * 100);
    return null;
  }

  /** Appends a point; bursts within MIN_INTERVAL_MS update the previous point. */
  private append(seriesId: string, t: number, items: number, wallet: number, partial = false): void {
    const arr = this.data.series[seriesId] ?? (this.data.series[seriesId] = []);
    const last = arr[arr.length - 1];
    if (last && t - last.t < MIN_INTERVAL_MS) {
      last.t = t; last.items = items; last.wallet = wallet;
      if (partial) last.partial = true; else delete last.partial; // S66: keep the flag accurate on coalesce
      return;
    }
    arr.push(partial ? { t, items, wallet, partial: true } : { t, items, wallet });
    if (arr.length > MAX_POINTS_PER_SERIES) arr.splice(0, arr.length - MAX_POINTS_PER_SERIES);
  }
}
