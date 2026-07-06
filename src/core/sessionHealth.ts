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

/**
 * True iff cookies obtained at `obtainedAt` are still within the freshness window.
 *
 * Fail-closed on every unmeasurable age: missing/corrupt input (null, non-finite) and
 * ALSO a FUTURE `obtainedAt` — a backward wall-clock step (NTP correction, manual fix,
 * dual-boot RTC skew) or a corrupt value makes the age negative, which is unmeasurable,
 * so the consumer re-establishes/refreshes (an in-place `refreshWebSession` webLogOn on
 * the same connection/IP — cheap) rather than trusting possibly-dead cookies. We stay on
 * wall clock deliberately: cookie expiry is real time on Steam's side and monotonic
 * sources may exclude sleep time, which must count toward cookie age — wall clock +
 * future-rejection is the trade-off. Accepted residue: a backward step still understates
 * strictly-positive ages by up to ΔT; on healthy sessions the 20-min proactive refresh
 * rewrites `obtainedAt` on its own setTimeout cadence (unaffected by wall-clock steps),
 * bounding the distortion to one refresh interval.
 */
export function webCookiesFresh(
  obtainedAt: Date | string | number | undefined | null,
  nowMs: number = Date.now(),
  maxAgeMs: number = WEB_COOKIE_MAX_AGE_MS,
): boolean {
  if (obtainedAt == null) return false;
  const t = obtainedAt instanceof Date ? obtainedAt.getTime() : new Date(obtainedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = nowMs - t;
  return age >= 0 && age < maxAgeMs;
}
