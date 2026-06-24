// ════════════════════════════════════════════════════════════════════════════
//  sessionHealth — pure web-session freshness policy (C16 / INV-A5).
//  isReady() used to check only that a webSession OBJECT existed, so a session whose
//  cookies silently expired before the 20-min proactive refresh fired still passed as
//  "ready", and a market/inventory call would then run on dead cookies. This adds a
//  cookie-age check. Pure (no imports) so it is unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

/**
 * How long web cookies are considered fresh after they were obtained. Comfortably
 * above the 20-min proactive refresh interval, so a HEALTHY session (refreshed every
 * 20 min) always passes; only a session whose refresh has stalled this long is flagged
 * not-ready, so the next access re-establishes it rather than using stale cookies.
 */
export const WEB_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Does THIS login call own the session it produces (i.e. may a bulk op later release
 * it)? Only when the call ORIGINATED the login — there is no login already in flight to
 * coalesce onto, and no session already exists to reuse/replace. A coalescing caller or
 * a re-login of an existing session never owns it, so it never tears down a session
 * another operation established. Decided synchronously by the caller, race-free with the
 * in-flight dedup. (C17 / INV-A6.)
 */
export function ownsCreatedSession(loginInFlight: boolean, sessionExists: boolean): boolean {
  return !loginInFlight && !sessionExists;
}

/** True iff cookies obtained at `obtainedAt` are still within the freshness window. */
export function webCookiesFresh(
  obtainedAt: Date | string | number | undefined | null,
  nowMs: number = Date.now(),
  maxAgeMs: number = WEB_COOKIE_MAX_AGE_MS,
): boolean {
  if (obtainedAt == null) return false;
  const t = obtainedAt instanceof Date ? obtainedAt.getTime() : new Date(obtainedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return nowMs - t < maxAgeMs;
}
