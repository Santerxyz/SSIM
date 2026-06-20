import axios from 'axios';
import { logger } from '../utils/logger';

const FALLBACK_USD_TO_EUR = 0.92;
const REFRESH_MS = 12 * 60 * 60 * 1000; // every 12h

/** Tracks the live USD→EUR rate (frankfurter.app) so the UI can toggle currency. */
export class ExchangeRateService {
  private usdToEur = FALLBACK_USD_TO_EUR;
  private updatedAt = 0; // ms of last SUCCESSFUL fetch (0 = never → still on the hardcoded fallback)
  private timer?: NodeJS.Timeout;

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
        logger.info(`[fx] USD→EUR = ${rate}`);
      }
    } catch (err) {
      logger.warn(`[fx] refresh failed (${(err as Error).message}) – using ${this.usdToEur}`);
    }
  }
}
