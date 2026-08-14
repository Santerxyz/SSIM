import path from 'path';
import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';
import type { AccountManager } from './AccountManager';
import type { AccountInventory, GameId } from '../types/inventory';
import type { PricingService } from '../pricing/PricingService';
import type { ExchangeRateService } from '../pricing/ExchangeRateService';

/** Which game series a snapshot should touch. Scoping to the refreshed game stops a
 *  TF2 refresh from rewriting a recent CS2 point (and vice-versa). undefined → both
 * (manual/post-trade where the caller doesn't know). */
export function snapshotGames(game?: GameId): { cs2: boolean; tf2: boolean } {
  return { cs2: game !== 'tf2', tf2: game !== 'cs2' };
}

const HISTORY_PATH = dataDir('value_history.json');

/** Hard cap per series – at one point per refresh this is months of history. */
const MAX_POINTS_PER_SERIES = 2000;
/**
 * Points closer together than this MERGE into the previous one (the latest
 * values win). Protects the curve from bursts – e.g. post-trade refreshes of
 * two accounts within seconds should not produce two near-identical points.
 */
const MIN_INTERVAL_MS = 60_000;
/** S67: how often to re-check whether a deferred snapshot's price fill has drained. */
const FILL_WATCH_INTERVAL_MS = 3_000;

/** Series id of the all-environments aggregate. */
export const GLOBAL_SERIES = 'global';

export interface HistoryPoint {
  /** Snapshot time (unix ms). */
  t: number;
  /** Total items worth in USD cents (same unit as inv.totalValueUsd). */
  items: number;
  /** Total wallet balance in USD cents (converted like the dashboard does). */
  wallet: number;
  /** True when this point UNDERCOUNTS: either a loaded account held a wallet balance in a currency we
   *  can't convert to USD (FX covers only USD↔EUR — S66), or one or more items had prices that were
   * missing/transiently unfetchable at record time. Lets the UI flag the series as
   *  incomplete instead of silently plotting a too-low value as if it were exact. */
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
  // A snapshot requested WHILE a price fill is draining is deferred (the item totals would be
  // undercounted). `pending` remembers the request; `fillWatch` polls until the fill drains, then records it.
  // `retry` marks a pending that already fired ITS own ensureFilled for cache-missing names: on
  // the drain pass it records flagged rather than deferring again — exactly one bounded retry, no starvation.
  private pending?: { reason: string; game?: GameId; retry?: boolean };
  private fillWatch?: NodeJS.Timeout;

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
        if (parsed && typeof parsed.series === 'object') return { version: 1, series: this.sanitizeSeries(parsed.series ?? {}) };
        // File exists but the shape is wrong (`{}`, `null`, an array, a missing `series`). Unlike
        // InventoryStore, value history is not refetchable — the only record of the past — so preserve
        // the current bytes before starting fresh (S12/S5 clobber class).
        this.preserveHistory('unexpected shape');
      }
    } catch (err) {
      // any read/parse throw (incl. a transient Windows EBUSY/EPERM from an AV scanner at boot):
      // preserve the current bytes before overwriting the only copy on the next flush.
      this.preserveHistory((err as Error).message);
    }
    return { version: 1, series: {} };
  }

  /** H-INV-020: the top-level `series` check passing does not prove each series is an array of
   *  valid points — a hand-edited file or partial disk corruption that still parses can leave a
   *  string/number/object where an array belongs, which later throws inside `append()` (`arr.push`
   *  is not a function) on the very next refresh, 500ing single-refresh routes and feeding the
   *  money breaker via the bare-setInterval fill-watch. Keep only array series, and within each
   *  only well-formed points (finite `t`, numeric `items`/`wallet`); carry the `partial` honesty
   *  flag through, drop any other extras. Warn once with the dropped counts if anything was cut. */
  private sanitizeSeries(series: Record<string, HistoryPoint[]>): Record<string, HistoryPoint[]> {
    const clean: Record<string, HistoryPoint[]> = {};
    let droppedSeries = 0, droppedPoints = 0;
    for (const [id, arr] of Object.entries(series)) {
      if (!Array.isArray(arr)) { droppedSeries++; continue; }
      const points: HistoryPoint[] = [];
      for (const p of arr) {
        if (p && typeof p.t === 'number' && Number.isFinite(p.t)
            && typeof p.items === 'number' && typeof p.wallet === 'number') {
          points.push(p.partial === true
            ? { t: p.t, items: p.items, wallet: p.wallet, partial: true }
            : { t: p.t, items: p.items, wallet: p.wallet });
        } else {
          droppedPoints++;
        }
      }
      clean[id] = points;
    }
    if (droppedSeries > 0 || droppedPoints > 0) {
      logger.warn(`value_history.json sanitized on load: dropped ${droppedSeries} non-array series and ${droppedPoints} malformed point(s)`);
    }
    return clean;
  }

  /** Best-effort: copy the current (unreadable/malformed) value_history.json to a
   *  `.corrupt-<ts>` sibling before load() starts fresh, so a transient boot-time lock
   *  or a corruption event can't silently destroy the only record of the past. Keeps the
   *  newest 2 preserved copies (older ones are pruned). Failures are swallowed — a failed
   *  preserve (e.g. the file is still locked) must never block boot. */
  private preserveHistory(why: string): void {
    try {
      const preserved = `${HISTORY_PATH}.corrupt-${Date.now()}`;
      fsExtra.copySync(HISTORY_PATH, preserved);
      logger.warn(`value_history.json unusable (${why}) – preserved to ${preserved}, starting fresh`);
      // Bound growth: keep only the newest 2 `.corrupt-*` siblings.
      const dir = path.dirname(HISTORY_PATH);
      const base = path.basename(HISTORY_PATH);
      const olds = fsExtra.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.corrupt-`))
        .sort(); // ascending by the timestamp suffix (fixed-width, lexicographic = chronological)
      for (const f of olds.slice(0, Math.max(0, olds.length - 2))) {
        try { fsExtra.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
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

  /** Real teardown: disarm the S67 `fillWatch` interval and drop any deferred snapshot
   *  before the final flush. `flush()` alone leaves `fillWatch` armed, so on a runtime license-loss
   *  re-gate (teardownFullApp → new ValueHistoryService in the same process) the OLD instance's zombie
   *  tick would fire and clobber the new instance's freshly-loaded history. A pending point dropped at
   *  teardown is recreated on the next refresh — cheaper than letting it fire on a dead `deps`. */
  shutdown(): void {
    if (this.fillWatch) { clearInterval(this.fillWatch); this.fillWatch = undefined; }
    this.pending = undefined;
    this.flush();
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  /** Chronological points of a series ('global' or an environment id), per game. The TF2
   *  series is stored under a 'tf2:' prefix so CS2 + TF2 curves never overwrite each other. */
  get(seriesId: string, game: 'cs2' | 'tf2' = 'cs2'): HistoryPoint[] {
    return this.data.series[game === 'tf2' ? `tf2:${seriesId}` : seriesId] ?? [];
  }

  /**
   * Aggregates the per-environment series of `seriesIds` into one curve for `game`,
   * summing items + wallet across the selected environments (F3b — the global-master chart
   * follows the environment selection). Robust to environments that started recording at
   * different times: at each timestamp present in any selected series, every series
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
      let items = 0, wallet = 0, partial = false;
      for (let s = 0; s < series.length; s++) {
        const arr = series[s];
        let i = cursors[s];
        while (i + 1 < arr.length && arr[i + 1].t <= t) i++;
        cursors[s] = i;
        const p = arr[i];
        if (p && p.t <= t) { items += p.items; wallet += p.wallet; if (p.partial) partial = true; } // before first point → 0
      }
      out.push(partial ? { t, items, wallet, partial: true } : { t, items, wallet });
    }
    return out.length > MAX_POINTS_PER_SERIES ? out.slice(out.length - MAX_POINTS_PER_SERIES) : out;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  /**
   * Takes one snapshot pass over the inventory cache: appends a point to every
   * environment series (that has at least one cached inventory) plus the global
   * aggregate. Cheap – memory only – so it is safe to call after every refresh.
   */
  snapshotAll(reason: string, game?: GameId): void {
    // A snapshot taken mid price-fill permanently captures UNDERCOUNTED item totals — enrich() sums the
    // cache, and most items have no price yet until the throttled background fill drains. DEFER while a fill
    // is in progress: remember the request and re-snapshot once it drains, so the point reflects the fully-
    // priced inventory. Coalesced — one pending request + one watcher regardless of how many refreshes fire;
    // if two different games defer, we snapshot both on drain (game=undefined) so neither is lost.
    const st = this.pricing.status();
    if (st.running || st.queued > 0) {
      this.pending = (this.pending && this.pending.game !== game)
        ? { reason: 'fill-drain', game: undefined, retry: this.pending.retry } // merge games → OR the retry flag
        : { reason, game };
      this.armFillWatch();
      logger.debug(`[history] snapshot deferred until the price fill drains (${reason}${game ? `, ${game}` : ''})`);
      return;
    }
    this.doSnapshot(reason, game);
  }

  /**
   * S67 hole-closer: the snapshot is COMPLETE-or-honestly-FLAGGED. `computeGame` derives every
   * row without appending and reports the names it couldn't price. If `!isRetry` and any name is cache-missing,
   * we queue exactly those names (ensureFilled), remember a retry-pending, arm the watch and record NOTHING —
   * so a snapshot that settled while prices were stale no longer captures a permanent undercount. On the drain
   * pass (`isRetry`) any names still missing/soft-nulled no longer defer: the row records with `partial: true`
   * (matching the S66 "honest, no fabricated data" pattern). Exactly one retry — no loop, no starvation.
   */
  private doSnapshot(reason: string, game?: GameId, isRetry = false): void {
    const now = Date.now();
    // Snapshot ONLY the game(s) that actually refreshed. Snapshotting both on every call
    // let a TF2 refresh rewrite a recent CS2 point (and vice-versa) via burst-coalescing in
    // append() — last-writer-wins on the curve. `game` undefined → snapshot both (manual/
    // post-trade where the caller doesn't scope it).
    const which = snapshotGames(game);
    const rows: Array<{ seriesId: string; items: number; wallet: number; partial: boolean }> = [];
    const missing: Array<{ name: string; appid: number }> = [];
    if (which.cs2) { const g = this.computeGame(now, this.store, '');        rows.push(...g.rows); missing.push(...g.missing); }
    if (which.tf2) { const g = this.computeGame(now, this.tf2Store, 'tf2:'); rows.push(...g.rows); missing.push(...g.missing); }

    if (!isRetry && missing.length > 0) {
      // Prices are stale/missing → don't record an undercounted point. Queue the fill, defer once.
      this.pricing.ensureFilled(missing);
      this.pending = { reason, game, retry: true };
      this.armFillWatch();
      logger.debug(`[history] snapshot deferred — ${missing.length} price(s) missing, filling (${reason}${game ? `, ${game}` : ''})`);
      return;
    }
    for (const r of rows) this.append(r.seriesId, now, r.items, r.wallet, r.partial);
    this.scheduleFlush();
    logger.debug(`[history] snapshot taken (${reason}${game ? `, ${game}` : ''}${isRetry ? ', retry' : ''})`);
  }

  /** S67: while a fill is draining, poll on an interval; take the deferred snapshot once it drains. */
  private armFillWatch(): void {
    if (this.fillWatch) return; // one watcher at a time
    this.fillWatch = setInterval(() => this.checkFillDrained(), FILL_WATCH_INTERVAL_MS);
    this.fillWatch.unref?.();
  }

  private checkFillDrained(): void {
    const st = this.pricing.status();
    if (st.running || st.queued > 0) return; // still filling → wait
    if (this.fillWatch) { clearInterval(this.fillWatch); this.fillWatch = undefined; }
    const pend = this.pending; this.pending = undefined;
    // Pass the pending's retry flag: a pending we ourselves deferred for missing prices (retry) records
    // flagged on this pass rather than deferring again — exactly one bounded retry.
    if (pend) this.doSnapshot(pend.reason, pend.game, pend.retry === true);
  }

  /**
   * Pure computation of one game's rows ('<prefix><envId>' + '<prefix>global') from the cache — NO append.
   * Returns the rows to record plus the unique-per-account cache-missing names so the caller can defer+fill.
   * A row is `partial` when the S66 wallet condition holds OR the env had any missing/soft-nulled price
   * (the items total silently undercounts those). Keeps the `loaded === 0 → no point` rule (empty-coercion guard).
   */
  private computeGame(_now: number, store: { get(u: string): AccountInventory | undefined }, prefix: string):
    { rows: Array<{ seriesId: string; items: number; wallet: number; partial: boolean }>; missing: Array<{ name: string; appid: number }> } {
    // `_now` is unused here — rows carry no timestamp; doSnapshot's append() stamps them. Kept for signature parity.
    const rows: Array<{ seriesId: string; items: number; wallet: number; partial: boolean }> = [];
    const missing: Array<{ name: string; appid: number }> = [];
    let globalItems = 0, globalWallet = 0, globalLoaded = 0, globalPartial = false;
    for (const env of this.accounts.getEnvironments()) {
      let items = 0, wallet = 0, loaded = 0, partial = false;
      for (const acc of this.accounts.getByEnvironment(env.id)) {
        const inv = store.get(acc.username);
        if (!inv) continue;
        loaded++;
        const t = this.pricing.totalsOf(inv); // READ-ONLY: never mutates the cached record
        items += t.totalCents;
        // An item whose price was missing (queued this pass) or a fresh transient soft error-miss
        // means the items total undercounts for this point — flag it, and collect missing names for the fill.
        if (t.missing.length > 0 || t.softNull > 0) partial = true;
        missing.push(...t.missing);
        const w = inv.wallet;
        const cents = this.walletUsdCents(w);
        // A wallet we couldn't convert (non-USD/EUR) but that HAS a real balance means `wallet` is
        // undercounted for this point — flag it partial rather than silently plotting a too-low total.
        // An ABSENT/malformed wallet (never wallet-refreshed, tri-state "—") is unknown, not 0 —
        // flag it too so unknown never coerces to a silent 0. The hasWallet=false → balance 0 case has a
        // real numeric balance and converts to an exact 0, so it stays unflagged (Directive 2 tri-state).
        if (!w || typeof w.balance !== 'number') partial = true;
        else if (cents == null && w.balance > 0) partial = true;
        wallet += cents ?? 0;
      }
      if (loaded === 0) continue; // nothing cached → no meaningful point
      rows.push({ seriesId: prefix + env.id, items, wallet, partial });
      globalItems += items; globalWallet += wallet; globalLoaded += loaded; globalPartial = globalPartial || partial;
    }
    if (globalLoaded > 0) rows.push({ seriesId: prefix + GLOBAL_SERIES, items: globalItems, wallet: globalWallet, partial: globalPartial });
    return { rows, missing };
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
    const dt = last ? t - last.t : Infinity;
    if (last && dt >= 0 && dt < MIN_INTERVAL_MS) {
      last.t = t; last.items = items; last.wallet = wallet;
      if (partial) last.partial = true; else delete last.partial; // S66: keep the flag accurate on coalesce
      return;
    }
    if (last && dt < 0) {
      // Wall-clock stepped BACKWARD (NTP correction, VM/laptop resume). A recorded timestamp
      // never moves backward — merge values into the last point but KEEP last.t, or the series would go
      // non-chronological (breaking aggregate()'s cursor and the chart's span math). Self-heals once the
      // clock passes last.t + MIN_INTERVAL_MS: normal appends resume, no data dropped.
      last.items = items; last.wallet = wallet;
      if (partial) last.partial = true; else delete last.partial; // S66: keep the flag accurate on coalesce
      return;
    }
    arr.push(partial ? { t, items, wallet, partial: true } : { t, items, wallet });
    if (arr.length > MAX_POINTS_PER_SERIES) arr.splice(0, arr.length - MAX_POINTS_PER_SERIES);
  }
}
