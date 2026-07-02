// ════════════════════════════════════════════════════════════════════════════
//  Reprice reconciler (P6 / INV-E1) — decides when the dashboard should re-pull
//  prices after a refresh/source-switch kicks off the background price fill.
//
//  The old client watcher polled /api/pricing/status for a FIXED 90s window, so a
//  large fleet's fill (thousands of unique item names, throttled) that ran longer
//  than 90s left the UI showing stale-as-if-live totals until an app restart. This
//  is a DURABLE, resumable reconciler: it re-pulls whenever the backend's fetched
//  count ADVANCES and keeps going until the fill queue DRAINS (no deadline), with a
//  single no-progress safety stop so a wedged backend can't spin forever. The pure
//  step is here so it is unit-testable; public/app.js mirrors it exactly.
// ════════════════════════════════════════════════════════════════════════════

export interface RepriceState {
  /** Highest `fetched` count we've already re-pulled for. */
  lastPulled: number;
  /** Timestamp (ms) of the last observed progress — drives the no-progress stop. */
  lastProgressAt: number;
}

export interface PricingStatus {
  fetched?: number;
  running?: boolean;
  queued?: number;
}

/** Give up watching if the backend makes NO fill progress for this long while still "busy"
 *  (a wedged pricing loop) — bounds the otherwise-deadline-free watch. */
export const NO_PROGRESS_TIMEOUT_MS = 15 * 60_000;

export interface RepriceDecision {
  /** Re-pull the inventory/totals now (new prices landed, or the fill just drained). */
  repull: boolean;
  /** Stop the watch (queue drained, or the no-progress safety fired). */
  stop: boolean;
  /** The next reconciler state to carry into the following poll. */
  state: RepriceState;
}

/**
 * One reconciler step. Given the current state and a fresh /api/pricing/status snapshot:
 *   • if `fetched` advanced → re-pull and record progress;
 *   • if the queue is drained (not running, nothing queued) → do a final re-pull and stop;
 *   • else if no progress for NO_PROGRESS_TIMEOUT_MS → stop (wedged backend safety).
 * Pure: same inputs → same decision; the caller owns the timing loop.
 */
export function repriceDecision(state: RepriceState, status: PricingStatus | null | undefined, now: number): RepriceDecision {
  const fetched = Number(status?.fetched) || 0;
  const busy = !!(status && (status.running || (Number(status.queued) || 0) > 0));
  let { lastPulled, lastProgressAt } = state;
  let repull = false;
  if (fetched > lastPulled) { lastPulled = fetched; lastProgressAt = now; repull = true; }
  let stop = false;
  if (!busy) { repull = true; stop = true; }                                   // drained → final pull, then stop
  else if (now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) { stop = true; }       // wedged → safety stop (no extra pull)
  return { repull, stop, state: { lastPulled, lastProgressAt } };
}
