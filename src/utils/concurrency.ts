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
  if (n <= 0) return min;
  return Math.min(max, Math.max(min, Math.ceil(n / per)));
}
