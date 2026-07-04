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
//  so the next call re-attempts the real offset (still bounded).
// ════════════════════════════════════════════════════════════════════════════

type OffsetCb = (err: Error | null, offset: number, latency?: number) => void;
type GetOffset = (cb: OffsetCb) => void;

export interface TotpTimeoutOpts {
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

/** Wrap a getTimeOffset(cb) with a timeout + per-process offset cache. Pure/testable — the caller
 *  supplies the underlying implementation, so a test can drive stall / error / success deterministically. */
export function makeTimeoutGetOffset(original: GetOffset, opts: TotpTimeoutOpts = {}): GetOffset {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const cacheTtlMs = opts.cacheTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  let cachedOffset: number | undefined;
  let cachedAt = 0;

  return (cb: OffsetCb): void => {
    // Fresh cache → answer instantly, no network (the offset is process-stable).
    if (cachedOffset !== undefined && now() - cachedAt < cacheTtlMs) { cb(null, cachedOffset, 0); return; }
    let settled = false;
    // A stall/error uses the best-known offset (last cache, else 0) and is NOT cached, so the next call
    // re-attempts the real value; a real success IS cached. Never surfaces an error (parity with the
    // callers' own `off = err ? 0 : offset`), so the confirmation proceeds bounded instead of hanging.
    const done = (offset: number, cacheable: boolean): void => {
      if (settled) return;
      settled = true;
      if (cacheable) { cachedOffset = offset; cachedAt = now(); }
      cb(null, offset, 0);
    };
    const timer = setTimeout(() => {
      logger.warn(`[steam-totp] QueryTime stalled >${timeoutMs}ms – using offset ${cachedOffset ?? 0} (S6)`);
      done(cachedOffset ?? 0, false);
    }, timeoutMs);
    timer.unref?.();
    try {
      original((err, offset) => { clearTimeout(timer); done(err ? (cachedOffset ?? 0) : offset, !err); });
    } catch {
      clearTimeout(timer);
      done(cachedOffset ?? 0, false);
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
