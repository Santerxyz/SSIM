// ════════════════════════════════════════════════════════════════════════════
//  licenseClock — pure offline-grace / clock-rollback policy (C13 / INV-G2).
//  The bug: maxSeenMs (the rollback high-water mark) was advanced from the LOCAL
//  clock on every valid-token boot (bumpClock), so a single forward clock jump while
//  offline poisoned it to the future; on returning to true time the user was then
//  refused offline grace — a legitimate, paying user locked out. The fix: advance the
//  anchors ONLY on a server-confirmed contact, never from the local clock.
//  Pure (no imports) so the policy is unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

export interface ClockMeta {
  lastOnlineMs: number;
  maxSeenMs:    number;
}

// Tolerance below the stored high-water mark before an authoritative contact is treated as
// evidence the mark was poisoned to the future. Mirrors the rollback guard's skew (5 min).
const HEAL_SKEW_MS = 5 * 60 * 1000;

/**
 * The next meta after an event. The anchors advance ONLY on a server-confirmed contact
 * (`serverConfirmed === true`) — never from the local clock — so a forward clock jump
 * while offline can't poison the rollback anchor. Offline → meta is left unchanged.
 *
 * `maxSeenMs` is NOT a pure monotone high-water mark: an authoritative (server-confirmed)
 * contact whose time falls below the stored mark HEALS the mark down to that time. A single
 * forward-wrong server clock (an NTP step / VM resume) can otherwise ratchet `maxSeenMs` into
 * the future permanently, refusing offline grace to a valid user for the life of the meta file
 * even after the server clock is corrected. A later correct contact is strictly more trustworthy
 * than the stored ratchet, so it recedes the mark. `maxFutureSkewMs` bounds the raise direction
 * at the caller (see `markOnline`): a server time farther ahead than that is not anchored to.
 */
// The `serverConfirmed: true` overload narrows to a concrete `ClockMeta` for the sole production
// caller (`markOnline`, which always passes `true`), so `writeMeta(nextClockMeta(…, true, …))`
// still typechecks. The general signature returns `ClockMeta | undefined`: the offline branch only
// ever leaves the meta unchanged, handing back `prev` verbatim — `undefined` when there is no record
// yet, which `offlineGraceDecision`/`readMeta` already treat as "no meta". No fabricated {0,0}
// default is invented for a branch no production path takes.
export function nextClockMeta(prev: ClockMeta | undefined, nowMs: number, serverConfirmed: true, maxFutureSkewMs?: number): ClockMeta;
export function nextClockMeta(prev: ClockMeta | undefined, nowMs: number, serverConfirmed: boolean, maxFutureSkewMs?: number): ClockMeta | undefined;
export function nextClockMeta(
  prev: ClockMeta | undefined,
  nowMs: number,
  serverConfirmed: boolean,
  maxFutureSkewMs?: number,
): ClockMeta | undefined {
  void maxFutureSkewMs; // threaded for the caller-side future clamp; unused in the pure branch
  if (serverConfirmed) {
    const prevMax = prev?.maxSeenMs;
    // Heal-down: an authoritative time below the stored high-water mark means the mark was
    // poisoned to the future — recede it to the trusted server time. Otherwise ratchet up.
    const maxSeenMs = (prevMax !== undefined && nowMs < prevMax - HEAL_SKEW_MS)
      ? nowMs
      : Math.max(nowMs, prevMax ?? 0);
    return { lastOnlineMs: nowMs, maxSeenMs };
  }
  return prev;
}

export type GraceDecision = 'no-meta' | 'rollback-refused' | 'within-grace' | 'grace-elapsed';

/**
 * Decides offline-grace eligibility for an EXPIRED token:
 *   • no-meta          → no integrity record → refuse grace (force online re-check).
 *   • rollback-refused → clock rolled back below the high-water mark (minus skew).
 *   • within-grace     → still inside the offline window since last server contact.
 *   • grace-elapsed    → window exceeded → re-activate.
 */
export function offlineGraceDecision(
  nowMs: number,
  meta: ClockMeta | undefined,
  graceMs: number,
  skewMs: number,
): GraceDecision {
  if (!meta) return 'no-meta';
  if (nowMs < meta.maxSeenMs - skewMs) return 'rollback-refused';
  if (nowMs - meta.lastOnlineMs < graceMs) return 'within-grace';
  return 'grace-elapsed';
}
