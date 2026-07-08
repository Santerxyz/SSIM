// ════════════════════════════════════════════════════════════════════════════
//  RateLimiter — bounded request pacing for ONE CSFloat API key.
//
//  CSFloat publishes no rate-limit numbers (only a 429) and limits PER KEY/IP, so
//  all clients built from the same key MUST share a single limiter (see
//  CsFloatClient.limiterFor) — otherwise the background pricing fill and the
//  interactive tabs would each pace independently and together double the rate.
//
//  Pacing: at most `maxConcurrent` requests in flight, at least `minIntervalMs`
//  between dispatches. schedule(fn, priority) is FIFO within a priority band but
//  drains HIGH (interactive, priority>=0) before LOW (bulk pricing, priority<0), so
//  a fleet-wide pricing pass can never starve a dashboard the user just opened.
// ════════════════════════════════════════════════════════════════════════════

export class RateLimiter {
  private active = 0;
  private last = 0;
  private dispatching = false;
  private readonly hi: Array<() => void> = [];
  private readonly lo: Array<() => void> = [];

  constructor(private readonly maxConcurrent = 1, private readonly minIntervalMs = 600) {}

  /** Queue work. priority < 0 = background/bulk (yields to interactive); default 0 = interactive. */
  schedule<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = (): void => {
        this.active++;
        let p: Promise<T>;
        try { p = fn(); }
        catch (e) { this.active--; reject(e); this.pump(); return; }
        p.then(resolve, reject).finally(() => { this.active--; this.pump(); });
      };
      (priority < 0 ? this.lo : this.hi).push(task);
      this.pump();
    });
  }

  private hasWork(): boolean { return this.hi.length > 0 || this.lo.length > 0; }
  private take(): (() => void) | undefined { return this.hi.shift() ?? this.lo.shift(); }

  private pump(): void {
    if (this.dispatching) return;                              // a dispatch is already scheduled
    if (this.active >= this.maxConcurrent || !this.hasWork()) return;
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.last));
    this.dispatching = true;
    const fire = (): void => {
      this.dispatching = false;
      if (this.active >= this.maxConcurrent || !this.hasWork()) return;
      const next = this.take();
      if (!next) return;      // provably unreachable given the guard above; keeps the type honest
      this.last = Date.now();
      next();
      this.pump();                                             // try to fill another concurrent slot
    };
    if (wait === 0) fire(); else setTimeout(fire, wait).unref?.();
  }
}
