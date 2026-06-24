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

/**
 * The next meta after an event. The anchors advance ONLY on a server-confirmed contact
 * (`serverConfirmed === true`) — never from the local clock — so a forward clock jump
 * while offline can't poison the rollback anchor. Offline → meta is left unchanged.
 */
export function nextClockMeta(prev: ClockMeta | undefined, nowMs: number, serverConfirmed: boolean): ClockMeta {
  if (serverConfirmed) {
    return { lastOnlineMs: nowMs, maxSeenMs: Math.max(nowMs, prev?.maxSeenMs ?? 0) };
  }
  return prev ?? { lastOnlineMs: 0, maxSeenMs: 0 };
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
