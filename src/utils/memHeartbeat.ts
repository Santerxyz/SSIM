import fs from 'fs';
import v8 from 'v8';
import { logsDir, baseDir } from './paths';

// ════════════════════════════════════════════════════════════════════════════
//  memHeartbeat.ts – periodic memory/handle trajectory recorder.
//
//  WHY THIS EXISTS:
//  SSIM's deaths are SILENT — no crash-log.txt (the JS uncaught handlers keep the
//  process alive) and no Node diagnostic report (an OS-level resource reclaim is
//  not a V8 fatal, so reportOnFatalError never fires). That leaves us blind to the
//  ONE thing that matters: was memory/handle count climbing toward a ceiling right
//  before the window vanished?
//
//  This writes a one-line JSON sample every SSIM_HEARTBEAT_MS to a dedicated file
//  using a BLOCKING fs.appendFileSync — so the LAST sample before a hard kill is
//  guaranteed on disk. After a death, the tail of mem-heartbeat.log answers the
//  question directly: a rising rss/heapUsed/handles trend ⇒ the leak (Phenomenon
//  B); a flat trend that just stops ⇒ external termination (Phenomenon A).
//
//  It NEVER throws (a diagnostic that crashes is worse than no diagnostic) and is
//  unref()'d so it can never, by itself, keep the process alive.
// ════════════════════════════════════════════════════════════════════════════

/** mem-heartbeat.log next to the other logs; falls back to the app root if logs/ is unwritable. */
export const HEARTBEAT_FILE: string = (() => {
  try { fs.mkdirSync(logsDir(), { recursive: true }); return logsDir('mem-heartbeat.log'); }
  catch { return baseDir('mem-heartbeat.log'); }
})();

const INTERVAL_MS = Math.max(2_000, Number(process.env.SSIM_HEARTBEAT_MS) || 15_000);
const MAX_BYTES   = 8 * 1024 * 1024; // roll the file once it passes ~8 MB (a sample is ~120 B)

let timer: NodeJS.Timeout | undefined;
/** Wall-clock ms of the previous sample — used to detect an EVENT-LOOP STALL (a gap far larger
 *  than INTERVAL_MS means the loop was blocked, e.g. by sync IO or stdout-pipe backpressure, so the
 *  timer couldn't fire on time). A stall freezes BOTH this heartbeat and ssim.log at once, which
 *  otherwise reads identically to an external kill; recording the gap makes it diagnosable. */
let lastSampleAt = 0;
/** Optional supplier of live fleet counts (sessions/traders), merged into each sample. */
let statsProvider: (() => Record<string, number>) | undefined;

const mb = (n: number): number => Math.round(n / 1048576);

/** Best-effort active-handle / active-request counts (undocumented but ideal for spotting socket leaks). */
function handleCounts(): { handles: number; requests: number } {
  const p = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  let handles = -1, requests = -1;
  try { handles = p._getActiveHandles?.().length ?? -1; } catch { /* ignore */ }
  try { requests = p._getActiveRequests?.().length ?? -1; } catch { /* ignore */ }
  return { handles, requests };
}

/** Roll the file to .1 (overwriting any prior roll) once it grows past MAX_BYTES. */
function rollIfLarge(): void {
  try {
    const st = fs.statSync(HEARTBEAT_FILE);
    if (st.size > MAX_BYTES) fs.renameSync(HEARTBEAT_FILE, HEARTBEAT_FILE + '.1');
  } catch { /* no file yet, or rename raced – ignore */ }
}

function sample(): void {
  try {
    const m = process.memoryUsage();
    const { handles, requests } = handleCounts();
    const nowMs = Date.now();
    // A gap ≫ the sampling interval means the event loop was BLOCKED between ticks (sync IO /
    // stdout backpressure). Flag it so a stall that froze logging is visible after the fact.
    const stalledMs = lastSampleAt && (nowMs - lastSampleAt) > INTERVAL_MS * 2 ? (nowMs - lastSampleAt) : 0;
    lastSampleAt = nowMs;
    const rec: Record<string, number | string> = {
      t:         new Date().toISOString(),
      upMin:     Math.round(process.uptime() / 6) / 10, // minutes, 1 decimal
      rss:       mb(m.rss),
      heapUsed:  mb(m.heapUsed),
      heapTotal: mb(m.heapTotal),
      limit:     mb(v8.getHeapStatistics().heap_size_limit), // V8 ceiling → headroom = limit − heapUsed
      ext:       mb(m.external),
      ab:        mb(m.arrayBuffers ?? 0),
      handles,
      requests,
    };
    if (statsProvider) {
      try { Object.assign(rec, statsProvider()); } catch { /* stats are best-effort */ }
    }
    if (stalledMs) rec.stallMs = stalledMs; // event-loop stall breadcrumb (only when one occurred)
    rollIfLarge();
    fs.appendFileSync(HEARTBEAT_FILE, JSON.stringify(rec) + '\n');
  } catch { /* a heartbeat must never throw */ }
}

/**
 * Starts the heartbeat. `stats` (optional) supplies live fleet counts (e.g. number
 * of sessions / traders) so memory can be correlated with how many accounts are up.
 * Writes one sample immediately so a baseline exists even for a very short-lived run.
 */
export function startMemHeartbeat(stats?: () => Record<string, number>): void {
  if (timer) return; // already running
  statsProvider = stats;
  sample(); // baseline at boot
  timer = setInterval(sample, INTERVAL_MS);
  timer.unref(); // never keep the process alive just for the sampler
}

export function stopMemHeartbeat(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  statsProvider = undefined;
  lastSampleAt = 0; // so a later restart doesn't mis-read the gap as a stall
}
