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
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async refresh(): Promise<void> {
    try {
      const resp = await axios.get('https://api.frankfurter.app/latest?from=USD&to=EUR', { timeout: 8_000 });
      const rate = resp.data?.rates?.EUR;
      if (typeof rate === 'number' && rate > 0) {
        this.usdToEur = rate;
        this.updatedAt = Date.now();
        this.persist(); // survive restarts so a cold start doesn't revert to 0.92 (C20)
        logger.info(`[fx] USD→EUR = ${rate}`);
      }
    } catch (err) {
      logger.warn(`[fx] refresh failed (${(err as Error).message}) – using ${this.usdToEur}`);
    }
  }
}
