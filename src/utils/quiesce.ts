// ════════════════════════════════════════════════════════════════════════════
//  quiesce.ts – bounded "let in-flight money ops settle before teardown" drain.
//
//  WHY THIS EXISTS (H-XCT-005):
//  S14 already gates the mid-session update SWAP on isBusy() so a buy/sell/trade/
//  craft/move in flight is never hard-exited mid-commit. The far-more-common exit
//  paths — graceful shutdown() and the re-license teardownFullApp() — did NOT: they
//  ran sessions.logoutAll() (severing every web session) with a createBuyOrder /
//  sellitem / sendTrade still awaiting Steam's response, turning a routine "close
//  the app" into the same ambiguous-commit state S3/B4 exist to protect against.
//
//  This shares S14's exact busy-set as ONE bounded drain: poll until no op is busy
//  OR the deadline passes, then let teardown proceed. It is STRICTLY timeout-bounded
//  — a wedged op must NEVER prevent exit — and it never retries the op itself (owner
//  no-band-aid rule): the op is left to settle exactly once and the existing journal/
//  ambiguity machinery (S3/B4/S15) handles whatever state results.
// ════════════════════════════════════════════════════════════════════════════

export interface QuiesceOptions {
  /** Hard ceiling on the drain; a wedged op must never hold exit past this. */
  timeoutMs?: number;
  /** Poll interval between busy() checks. */
  pollMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of a quiesce drain — 'drained' when nothing was busy by the deadline. */
export type QuiesceResult = 'drained' | 'timeout';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Poll `isBusy` until it clears or `timeoutMs` elapses. Returns 'drained' if the
 * in-flight ops settled within the budget, 'timeout' if the deadline was hit while
 * still busy. NEVER blocks past `timeoutMs`.
 */
export async function quiesceMoneyOps(
  isBusy: () => boolean,
  opts: QuiesceOptions = {},
): Promise<QuiesceResult> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const pollMs = opts.pollMs ?? 150;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  while (isBusy()) {
    if (now() >= deadline) return 'timeout';
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  return 'drained';
}
