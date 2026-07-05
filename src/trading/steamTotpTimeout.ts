import SteamTotp from 'steam-totp';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  S6 — bound steam-totp's getTimeOffset with a timeout + per-process cache.
//
//  steam-totp's getTimeOffset issues a raw https.request to Steam's QueryTime
//  with NO timeout. A stalled response (socket open, no bytes — the adversarial
//  case; also AV/captive-portal interception of the DIRECT host egress) never
//  settles its callback, so EVERY confirmation/money path that awaits it hangs
//  until restart: buy-order 2FA, mass-sell listing 2FA, the SDA confirmations
//  panel, and steamcommunity's own trade-send confirm. That pins the in-flight
//  guard + MoneyOps asset claims (assets refuse every op) and latches mass-op
//  running flags — all until a process restart.
//
//  We patch getTimeOffset PROCESS-WIDE (so the steamcommunity vendor call site is
//  covered too, not just our own) to:
//   (a) race it with a ~10s timer that falls back to the last-known offset (or 0
//       — the same fallback every caller already uses on an error, `off = err ? 0
//       : offset`), so a stall can never wedge the money path; and
//   (b) CACHE a real offset per process (it is clock-stable) so only the FIRST
//       call touches the network — removing ~12 extra QueryTime round-trips per
//       buy-confirm loop and shrinking the stall exposure to that one call.
//
//  NOT a band-aid: it bounds an unbounded await and uses the documented fallback;
//  it never retries-to-hide or restarts anything. Timeouts/errors are NOT cached,
//  so the next call re-attempts the real offset (still bounded). A cold fallback
//  (no cached offset) surfaces the failure `err` with offset 0 rather than a
//  silent 0, so a consumer that memoizes on success — steamcommunity confirmations
//  pins _timeOffset for 12h — re-fetches next call instead of pinning our fallback
//  (H-TRD-090); a warm fallback delivers the real cached offset with err=null.
// ════════════════════════════════════════════════════════════════════════════

type OffsetCb = (err: Error | null, offset: number, latency?: number) => void;
type GetOffset = (cb: OffsetCb) => void;

export interface TotpTimeoutOpts {
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

/** Wrap a getTimeOffset(cb) with a timeout + per-process offset cache. Pure/testable — the caller
 *  supplies the underlying implementation, so a test can drive stall / error / success deterministically. */
export function makeTimeoutGetOffset(original: GetOffset, opts: TotpTimeoutOpts = {}): GetOffset {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const cacheTtlMs = opts.cacheTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const monotonicNow = opts.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  let cachedOffset: number | undefined;
  let cachedAt = 0;
  let cachedAtMono = 0;
  // Single-flight: while one QueryTime fetch is in flight, concurrent cache-misses subscribe to it
  // instead of each firing their own raw https request + their own 10s stall (S6/H-TRD-088).
  let inflight: OffsetCb[] | null = null;

  return (cb: OffsetCb): void => {
    // Fresh cache → answer instantly, no network (the offset is process-stable). A wall-clock step
    // (clock fix, W32Time correction, VM RTC resync, resume) diverges wall vs monotonic elapsed → the
    // cached offset is no longer valid, so treat the entry as expired and re-fetch (S6/H-TRD-087).
    if (cachedOffset !== undefined) {
      const wallElapsed = now() - cachedAt;
      const monoElapsed = monotonicNow() - cachedAtMono;
      const stepped = wallElapsed < 0 || Math.abs(wallElapsed - monoElapsed) > 5_000;
      if (!stepped && wallElapsed < cacheTtlMs) { cb(null, cachedOffset, 0); return; }
    }
    // A fetch is already running → subscribe and let its single terminal result fan out to us.
    if (inflight) { inflight.push(cb); return; }
    const subscribers: OffsetCb[] = [cb];
    inflight = subscribers;
    let settled = false;
    // A real success IS cached and surfaces err=null. A stall/error falls back: if we hold a real cached
    // offset we deliver that with err=null (a genuine value — a downstream memo of it is correct); with NO
    // cache we surface the failure `err` + offset 0, so a consumer that memoizes on success (steamcommunity
    // confirmations pins _timeOffset for 12h) re-fetches next call instead of pinning our 0. Our own
    // AccountTrader callers do `off = err ? 0 : offset`, so the no-cache case stays byte-identical (off 0).
    // Fallbacks are NOT cached, so the next call re-attempts the real value (H-TRD-090).
    // Drains every coalesced subscriber with the identical result, then ends the in-flight window.
    const done = (err: Error | null, offset: number, cacheable: boolean): void => {
      if (settled) return;
      settled = true;
      if (cacheable) { cachedOffset = offset; cachedAt = now(); cachedAtMono = monotonicNow(); }
      inflight = null;
      // Warm cache → a real offset with no error; cold fallback → surface the cause so no memo pins our 0.
      const outErr = cacheable || cachedOffset !== undefined ? null : err;
      const outOff = cacheable ? offset : (cachedOffset ?? 0);
      for (const sub of subscribers) sub(outErr, outOff, 0);
    };
    const timer = setTimeout(() => {
      logger.warn(`[steam-totp] QueryTime stalled >${timeoutMs}ms – using offset ${cachedOffset ?? 0} (S6)`);
      done(new Error(`QueryTime timed out after ${timeoutMs}ms`), 0, false);
    }, timeoutMs);
    timer.unref?.();
    try {
      // A non-finite "success" (the vendor's missing-return bug: a 200 whose server_time is truthy-non-numeric
      // fires callback(null, NaN)) is treated exactly like the error path — fallback + NOT cached — so NaN never
      // poisons the cache for an hour and SteamTotp.time(NaN)→BigInt(NaN) never throws (H-TRD-092).
      original((err, offset) => {
        clearTimeout(timer);
        const ok = !err && Number.isFinite(offset);
        done(ok ? null : (err ?? new Error('QueryTime returned a non-finite offset')), ok ? offset : 0, ok);
      });
    } catch (e) {
      clearTimeout(timer);
      done(e instanceof Error ? e : new Error(String(e)), 0, false);
    }
  };
}

let installed = false;

/** Patch the real steam-totp.getTimeOffset process-wide. Idempotent. Call once at boot. */
export function installSteamTotpTimeout(opts?: TotpTimeoutOpts): void {
  if (installed) return;
  installed = true;
  const totp = SteamTotp as unknown as { getTimeOffset: GetOffset };
  const original = totp.getTimeOffset.bind(totp);
  totp.getTimeOffset = makeTimeoutGetOffset(original, opts);
  logger.info('[steam-totp] getTimeOffset wrapped with a 10s timeout + per-process cache (S6)');
}
