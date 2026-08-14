// ════════════════════════════════════════════════════════════════════════════
//  Dynamic concurrency scaler for fleet operations (inventory refresh, mass buy,
//  mass sell, mass send). The thread count scales WITH the batch size — one worker
//  per `per` accounts — inside a [min, max] band, so small batches stay snappy, big
//  batches parallelise hard, and we never exhaust local sockets / RAM with a fixed
//  massive pool.
//
//    10 → 5    50 → 10    100 → 20    500 → 25 (capped)
// ════════════════════════════════════════════════════════════════════════════

export const MIN_CONCURRENCY = 5;   // floor: even a tiny batch gets a few workers
export const MAX_CONCURRENCY = 25;  // ceiling: protects local memory / network sockets / proxy stability
export const ACCOUNTS_PER_THREAD = 5;

/**
 * Threads for a batch of `count` accounts: clamp(ceil(count / per), min, max).
 * Defaults match the fleet band (1 thread / 5 accounts, floor 5, ceiling 25).
 */
export function scaleConcurrency(
  count: number,
  opts?: { min?: number; max?: number; per?: number },
): number {
  const min = opts?.min ?? MIN_CONCURRENCY;
  const max = opts?.max ?? MAX_CONCURRENCY;
  const per = Math.max(1, opts?.per ?? ACCOUNTS_PER_THREAD);
  const n = Math.max(0, Math.floor(count || 0));
  if (n <= 0) return Math.min(min, max);
  return Math.min(max, Math.max(min, Math.ceil(n / per)));
}

/**
 * Clamps an EXPLICIT concurrency override into the safe band [1, max]. The dynamic
 * scaler (scaleConcurrency) already returns ≤ MAX_CONCURRENCY, but a caller-supplied
 * override (ultimately reachable from the loopback API body, e.g. /api/market/sell's
 * `concurrency`) bypasses it — an out-of-band value like 1000 would otherwise spawn one
 * worker per bot and blow past the intentional 25 ceiling that protects proxy/socket
 * stability. This is the single enforcement point so the ceiling holds for every caller.
 * A non-finite/≤0 value falls back to `fallback` (the scaled default). No-op for any value
 * already within [1, max], so the normal path is unchanged.
 */
export function clampConcurrency(
  value: number | undefined,
  fallback: number,
  max: number = MAX_CONCURRENCY,
): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return Math.min(max, Math.max(1, Math.floor(fallback)));
  return Math.min(max, Math.floor(n));
}
