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
  /** Highest `processed` count seen — liveness by ANY terminal resolution, not just a fetch (S19). */
  lastProcessed?: number;
}

export interface PricingStatus {
  fetched?: number;
  processed?: number; // names RESOLVED (success OR error/429-exhaustion) — the true liveness signal (S19)
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
/** Visible state of the "Fetching prices… (N left / X done)" dashboard indicator. */
export interface PriceFillIndicator {
  /** Show the indicator (a fill is running or names are still queued); hide once drained. */
  show: boolean;
  /** Names still to fetch (queued/in-flight). */
  left: number;
  /** Names fetched in the current run. */
  done: number;
  /** Rough remaining time at the single-IP throttle, e.g. "~6 min left" ('' when nothing is left). */
  eta: string;
  /** True for a large cold fill that legitimately takes a while (surfaced as a "large inventory" hint). */
  long: boolean;
}

// Prices fill one name at a time from a SINGLE IP, throttled to PricingService.FETCH_DELAY_MS
// (~17 names/min). Keep this constant in sync with public/app.js (FILL_MS_PER_NAME).
const FILL_MS_PER_NAME = 3500;

/** Rough remaining time for `left` queued names at the single-IP throttle. Empty string when none left.
 *  Mirror of public/app.js formatFillEta. */
export function formatFillEta(left: number): string {
  const secs = Math.round(Math.max(0, Number(left) || 0) * FILL_MS_PER_NAME / 1000);
  if (secs <= 0) return '';
  if (secs < 90) return `~${secs}s left`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `~${mins} min left`;
  return `~${Math.round(secs / 360) / 10} h left`;
}

/**
 * Derives the price-fill indicator state from a `/api/pricing/status` snapshot. Visible while the
 * backend fill is running OR anything is queued; hidden (`show:false`) the moment the queue drains,
 * so the indicator dismisses itself on completion. Carries a rough ETA + a "large inventory" hint so a
 * legitimately-long single-IP fill doesn't read as frozen. Pure — the UI just renders this.
 * MIRROR of public/app.js priceFillIndicator; keep the two in sync.
 */
export function priceFillIndicator(status: PricingStatus | null | undefined): PriceFillIndicator {
  const left = Math.max(0, Number(status?.queued) || 0);
  const done = Math.max(0, Number(status?.fetched) || 0);
  const show = !!(status && (status.running || left > 0));
  return { show, left, done, eta: formatFillEta(left), long: left > 200 };
}

export function repriceDecision(state: RepriceState, status: PricingStatus | null | undefined, now: number): RepriceDecision {
  const fetched = Number(status?.fetched) || 0;
  const processed = Number(status?.processed) || 0;
  const busy = !!(status && (status.running || (Number(status.queued) || 0) > 0));
  let { lastPulled, lastProgressAt } = state;
  let lastProcessed = state.lastProcessed ?? 0;
  let repull = false;
  // PricingService.status().fetched/processed RESET to 0 at the start of each run(), so a new fill
  // generation makes them DROP below what we already saw. Detect that as a fresh generation and
  // re-baseline, so the new generation's prices are re-pulled + its liveness re-anchored.
  if (fetched < lastPulled) { lastPulled = 0; }
  if (processed < lastProcessed) { lastProcessed = 0; }
  let progressed = false;
  if (fetched > lastPulled) { lastPulled = fetched; repull = true; progressed = true; } // NEW PRICES → re-pull
  // S19: a name resolved via the error/429-exhaustion path advances `processed` but NOT `fetched`, so in a
  // 429/error storm `fetched` stalls while the fill IS alive. Count `processed` as progress too, or the
  // no-progress safety would terminally stop the watch (and hide the badge) mid-fill.
  if (processed > lastProcessed) { lastProcessed = processed; progressed = true; }
  if (progressed) lastProgressAt = now;
  let stop = false;
  if (!busy) { repull = true; stop = true; }                                   // drained → final pull, then stop
  else if (now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) { stop = true; }       // wedged → safety stop (no extra pull)
  return { repull, stop, state: { lastPulled, lastProgressAt, lastProcessed } };
}
