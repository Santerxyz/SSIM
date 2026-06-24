import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  ProcessHealth – money-operation circuit breaker (#16)
//
//  The process DELIBERATELY survives a single stray vendor-callback throw
//  (steam-user / steamcommunity / request fire callbacks outside our try/catch
//  reach, and killing 100s of live sessions over one of them is worse than
//  logging it). But a BURST of uncaught errors in a short window signals
//  genuinely inconsistent in-memory state — at which point continuing to accept
//  NEW money operations (buy / sell / trade-send) risks acting on a half-mutated
//  session map or mass-job. So on a burst we QUARANTINE money ops: reads and
//  existing sessions stay up, but new money POSTs are refused with an actionable
//  503 until the operator restarts. A one-off throw never trips it.
// ════════════════════════════════════════════════════════════════════════════

const BURST_WINDOW_MS = 60_000; // rolling window
const BURST_THRESHOLD = 3;      // this many uncaught errors within the window → quarantine

let recent: number[] = [];
let blocked = false;
let reason  = '';

export const ProcessHealth = {
  /**
   * Records an uncaught exception. Trips the breaker once BURST_THRESHOLD errors
   * occur within BURST_WINDOW_MS. Once tripped it stays tripped (a restart is the
   * only safe recovery from corrupt in-memory state).
   */
  recordUncaught(detail: string): void {
    const now = Date.now();
    recent = recent.filter((t) => now - t < BURST_WINDOW_MS);
    recent.push(now);
    if (!blocked && recent.length >= BURST_THRESHOLD) {
      blocked = true;
      reason  = `internal error burst (${recent.length} uncaught errors in ${BURST_WINDOW_MS / 1000}s); last: ${detail}`;
      logger.error(`[safety] MONEY OPS QUARANTINED — ${reason}. Restart SSIM before further trades/buys.`);
    }
  },

  /** True when new money operations must be refused. */
  moneyOpsBlocked(): boolean { return blocked; },

  /** Human-readable reason for the quarantine (empty when healthy). */
  blockReason(): string { return reason; },

  /**
   * Clears the breaker. Call ONLY after a full teardown+rebuild of the app's in-memory
   * state (an in-process re-license: teardownFullApp → startFullApp), where the suspect
   * session map / mass-jobs that tripped it have been discarded and rebuilt fresh. A
   * normal uncaught-burst is NOT cleared by this — it stays latched until a real restart.
   * (INV-G6 / G-5.)
   */
  reset(): void {
    if (blocked) logger.warn('[safety] money-ops breaker reset — app in-memory state was rebuilt (re-license)');
    recent = [];
    blocked = false;
    reason  = '';
  },
};
