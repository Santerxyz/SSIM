import axios from 'axios';
import fsExtra from 'fs-extra';
import { dataDir } from '../utils/paths';
import { writeJsonAtomic } from '../utils/atomicJson';
import { logger } from '../utils/logger';

const FALLBACK_USD_TO_EUR = 0.92;
const REFRESH_MS = 12 * 60 * 60 * 1000; // every 12h

/** Tracks the live USD→EUR rate (frankfurter.app) so the UI can toggle currency. */
export class ExchangeRateService {
  private usdToEur = FALLBACK_USD_TO_EUR;
  private updatedAt = 0; // ms of last SUCCESSFUL fetch (0 = never → still on the hardcoded fallback)
  private timer?: NodeJS.Timeout;
  // S44: a failed refresh used to wait the full 12h before retrying, so a transient blip stranded the
  // fallback/stale rate for half a day. Retry in MINUTES with bounded exponential backoff; the counter
  // resets each 12h tick (a fresh retry budget per cycle) and on any success.
  private retryTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  // teardown-quiescence: once stop() has run this instance arms no new timers and issues no new I/O; a
  // refresh() in flight at stop() must not re-arm a retry (or persist) on the torn-down instance.
  private stopped = false;
  private static readonly RETRY_BASE_MS = 5 * 60 * 1000; // 5,10,20,40 min — all << the 12h interval
  private static readonly MAX_RETRIES   = 4;
  private readonly path: string;

  /** `filePath` overridable for tests. Loads the last persisted rate so a cold start
   *  does NOT begin on the 0.92 fallback (C20 / INV-E5). */
  constructor(filePath: string = dataDir('exchange_rate.json')) {
    this.path = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fsExtra.existsSync(this.path)) return;
      const p = fsExtra.readJsonSync(this.path) as { usdToEur?: unknown; updatedAt?: unknown } | null;
      const r = Number(p?.usdToEur);
      if (Number.isFinite(r) && r > 0) {
        this.usdToEur = r;
        const t = Number(p?.updatedAt);
        this.updatedAt = Number.isFinite(t) ? t : 0; // keep honest age (fallback stays true if unknown)
      }
    } catch (err) {
      logger.warn(`[fx] ${this.path} unreadable, using fallback: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    try { writeJsonAtomic(this.path, { usdToEur: this.usdToEur, updatedAt: this.updatedAt }, { spaces: 0 }); }
    catch (err) { logger.warn(`[fx] could not persist rate: ${(err as Error).message}`); }
  }

  getUsdToEur(): number { return this.usdToEur; }

  /** Rate provenance for the UI (#70): is this the hardcoded fallback, and how stale? */
  getInfo(): { rate: number; fallback: boolean; ageMs: number | null } {
    return { rate: this.usdToEur, fallback: this.updatedAt === 0, ageMs: this.updatedAt ? Date.now() - this.updatedAt : null };
  }

  start(): void {
    this.stopped = false; // a legitimate stop→start on a reused instance re-arms this instance
    void this.refresh();
    // Each 12h tick resets the short-retry budget so every cycle gets a fresh set of backoff attempts.
    this.timer = setInterval(() => { this.retryAttempt = 0; void this.refresh(); }, REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.clearRetry();
  }

  private async refresh(): Promise<void> {
    try {
      const resp = await axios.get('https://api.frankfurter.app/latest?from=USD&to=EUR', { timeout: 8_000 });
      if (this.stopped) return; // teardown ran mid-flight: a late success must not persist() from a dead instance
      const rate = resp.data?.rates?.EUR;
      if (typeof rate !== 'number' || !(rate > 0)) throw new Error('no usable EUR rate in response');
      this.usdToEur = rate;
      this.updatedAt = Date.now();
      this.persist(); // survive restarts so a cold start doesn't revert to 0.92 (C20)
      logger.info(`[fx] USD→EUR = ${rate}`);
      this.clearRetry(); // S44: a good refresh cancels any pending short-retry and resets the backoff
    } catch (err) {
      if (this.stopped) return; // teardown ran mid-flight: a late failure must not re-arm a retry on a dead instance
      logger.warn(`[fx] refresh failed (${(err as Error).message}) – using ${this.usdToEur}`);
      this.scheduleRetry(); // S44: retry in minutes, not 12h
    }
  }

  /** S44: after a failed refresh, arm ONE short retry with bounded exponential backoff (minutes). Once
   *  MAX_RETRIES is reached we stop until the next 12h tick (which resets the budget) — never a busy loop. */
  private scheduleRetry(): void {
    if (this.stopped) return;                                           // no new timers after teardown
    if (this.retryTimer) return;                                        // one pending retry at a time
    if (this.retryAttempt >= ExchangeRateService.MAX_RETRIES) return;   // budget spent → wait for the 12h tick
    const delay = ExchangeRateService.RETRY_BASE_MS * 2 ** this.retryAttempt;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.refresh(); }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    this.retryAttempt = 0;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  }
}
