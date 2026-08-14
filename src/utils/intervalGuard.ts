// ════════════════════════════════════════════════════════════════════════════
// intervalGuard.ts — one shared "arm a periodic timer" primitive.
//
//  Every long-lived periodic-timer owner hand-rolled the same prologue: clear any
//  prior handle, setInterval, then unref() so the timer can never keep the process
//  alive on its own. Three owners remembered the "clear the prior handle first"
//  guard; two (LicenseClient heartbeat, ExchangeRateService fx) did not — so a
//  second start() would silently orphan the first interval, a timer that outlives
// its owner. Routing every owner through this helper makes
//  the majority pattern the ONLY pattern, so no timer owner can regress this class.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Clears `prev` (if any), arms a fresh interval, and unref()'s it by default so it
 * never keeps the process alive on its own. Store the returned handle back into the
 * owner's existing field: `this.timer = armInterval(this.timer, fn, ms)`.
 */
export function armInterval(
  prev: NodeJS.Timeout | undefined,
  fn: () => void,
  ms: number,
  opts?: { unref?: boolean },
): NodeJS.Timeout {
  if (prev) clearInterval(prev);
  const handle = setInterval(fn, ms);
  if (opts?.unref !== false) handle.unref?.();
  return handle;
}
