import { logger } from '../utils/logger';

/**
 * Thrown when a queued task is skipped BEFORE its cooldown/start because its
 * `skip` predicate said so (e.g. "End Task" cancelled the run). The `skipped`
 * flag lets the caller distinguish this from a real fetch failure so a cancelled
 * backlog is not counted as failed. (H-INV-008.)
 */
export class ThrottleSkippedError extends Error {
  readonly skipped = true;
  constructor() { super('skipped: cancelled before start'); }
}

/**
 * Serial throttle with a randomized cooldown – the rate-limit guard for accounts
 * that run WITHOUT a proxy (local IP).
 *
 * Why this exists: every no-proxy account shares the SAME outbound IP (the host's),
 * so the bulk refresh's concurrent workers would fire many Steam requests from one
 * IP at once and trip Steam's per-IP rate limit (HTTP 429) almost immediately.
 * Proxied accounts each have their own exit IP and are unaffected – they must NOT
 * go through here (that would needlessly serialize them).
 *
 * Behaviour:
 *   • Serialized   – at most ONE throttled task runs at a time (a queue), so the
 *                    shared local IP never has two in-flight Steam fetches.
 *   • Spaced out   – consecutive tasks START at least a randomized `min…max` ms
 *                    apart. The jitter avoids a perfectly regular request cadence,
 *                    and spacing the START (not adding a flat post-delay) naturally
 *                    caps the request RATE, which is what Steam actually limits.
 *
 * A task that throws does NOT break the queue: the next task still runs (the chain
 * swallows the rejection for its own continuation; the original promise still
 * rejects to the caller).
 */
export class LocalIpThrottle {
  /** Tail of the serialization chain – each task awaits the previous one. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Wall-clock ms at which the most recent task was allowed to start. */
  private lastStartAt = 0;

  /**
   * @param minDelayMs minimum gap between consecutive task starts
   * @param maxDelayMs maximum gap (randomized uniformly in [min, max])
   */
  constructor(
    private readonly minDelayMs: number,
    private readonly maxDelayMs: number,
  ) {
    // Defensive: keep max ≥ min so the random range never goes negative.
    if (this.maxDelayMs < this.minDelayMs) this.maxDelayMs = this.minDelayMs;
  }

  /**
   * Runs `task` once it reaches the front of the queue AND the randomized cooldown
   * since the previous task's start has elapsed. Resolves/rejects with `task`'s
   * own result, so callers see no difference beyond the added wait.
   *
   * `opts.skip` is consulted at the very front of the chain — BEFORE the cooldown
   * wait and without touching `lastStartAt` — so a cancelled backlog collapses
   * immediately (each queued task throws ThrottleSkippedError instead of waiting
   * out its cooldown and then fetching). (H-INV-008.)
   */
  run<T>(task: () => Promise<T>, opts?: { skip?: () => boolean }): Promise<T> {
    const scheduled = this.tail.then(async () => {
      if (opts?.skip?.()) throw new ThrottleSkippedError();
      const wait = this.nextWaitMs();
      if (wait > 0) {
        logger.debug(`[localip-throttle] waiting ${Math.round(wait)}ms before next no-proxy fetch`);
        await sleep(wait);
      }
      // H-NET-003: re-check `skip` AFTER the cooldown parked us. `refreshOne` reuses a
      // resident LOGGED_IN session (ensureSession) and so bypasses SessionManager's
      // shutdown latch — if teardown/cancel flipped during the sleep, abort HERE rather
      // than originate a Steam fetch on a session that is being destroyed.
      if (opts?.skip?.()) throw new ThrottleSkippedError();
      this.lastStartAt = Date.now();
      return task();
    });
    // The chain must survive a failing task – continue regardless of outcome.
    this.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  /** ms to wait so this task starts ≥ a randomized gap after the previous one. */
  private nextWaitMs(): number {
    const gap     = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const elapsed = Date.now() - this.lastStartAt;
    return Math.max(0, gap - elapsed);
  }
}

function sleep(ms: number): Promise<void> {
  // H-NET-003: unref the cooldown timer so a parked no-proxy task cannot, on its own,
  // keep the event loop alive during teardown (the re-license `teardownFullApp()` path
  // does not `process.exit`). During a normal refresh the awaiting worker/network I/O
  // keep the loop alive, so timing is unchanged in the common path.
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref(); });
}
