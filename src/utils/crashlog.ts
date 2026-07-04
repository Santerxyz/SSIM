import fs from 'fs';
import { logsDir, baseDir } from './paths';
import { redactSecrets } from './logger';
import { rollIfLarge, SINK_MAX_BYTES } from './rollLog';

// ════════════════════════════════════════════════════════════════════════════
//  crashlog.ts – SYNCHRONOUS last-words crash sink.
//
//  WHY THIS EXISTS (and why winston is not enough):
//  winston's File transport is ASYNC/buffered. When the process is about to die
//  — an uncaught throw followed by an exit, or one of the `setTimeout(…exit, 250)`
//  paths — the final record can still be sitting in winston's buffer and never
//  reach ssim.log, so the operator sees the window vanish with "no error". This
//  sink writes the stack with a BLOCKING fs.appendFileSync (returns only once the
//  bytes are handed to the OS), so the evidence survives an immediate exit.
//
//  It deliberately does the bare minimum and NEVER throws — a crash handler that
//  crashes loses the very stack we are trying to capture.
//
//  NOTE: this catches JS-level deaths. V8 out-of-memory and native (steam-user /
//  steamcommunity) crashes bypass JS entirely — those are captured separately by
//  Node's diagnostic report, enabled in bootflags.ts.
// ════════════════════════════════════════════════════════════════════════════

/** crash-log.txt next to the other logs; falls back to the app root if logs/ is unwritable. */
export const CRASH_FILE: string = (() => {
  try { fs.mkdirSync(logsDir(), { recursive: true }); return logsDir('crash-log.txt'); }
  catch { return baseDir('crash-log.txt'); }
})();

/** Short current-memory tag, so a crash record shows whether RSS/heap was high at death. */
function memTag(): string {
  try {
    const m = process.memoryUsage();
    const mb = (n: number): number => Math.round(n / 1048576);
    return ` rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB`;
  } catch { return ''; }
}

/**
 * Appends a crash/fatal record to crash-log.txt synchronously. Credentials in the
 * stack (proxy URLs carry user:pass) are redacted with the SAME masker the logger
 * uses, so secrets never land at rest here either. Best-effort; swallows all errors.
 */
export function writeCrash(label: string, detail: unknown): void {
  try {
    const body = detail instanceof Error
      ? (detail.stack ?? `${detail.name}: ${detail.message}`)
      : String(detail);
    const record = `\n[${new Date().toISOString()}] ${label} (pid ${process.pid})${memTag()}\n${redactSecrets(body)}\n`;
    rollIfLarge(CRASH_FILE, SINK_MAX_BYTES); // S47: cap the append-only crash sink
    fs.appendFileSync(CRASH_FILE, record);
  } catch { /* a crash sink must never throw */ }
}

/** exit-trace.log – the internal-vs-external death discriminator (see writeExit). */
export const EXIT_FILE: string = (() => {
  try { fs.mkdirSync(logsDir(), { recursive: true }); return logsDir('exit-trace.log'); }
  catch { return baseDir('exit-trace.log'); }
})();

/**
 * Synchronous breadcrumb written from `process.on('exit')` — i.e. on EVERY exit the
 * process initiates itself (a clean shutdown, a license/boot exit, a SIGHUP handler, or
 * even a vendor library calling process.exit()). Node runs 'exit' handlers synchronously
 * before the process leaves, so fs.appendFileSync here is guaranteed on disk.
 *
 * THE DIAGNOSIS HINGES ON THIS LINE'S PRESENCE OR ABSENCE:
 *   • a death that leaves an EXIT line ⇒ the process exited ITSELF — `code` names which path.
 *   • a death with NO EXIT line (heartbeat/ssim.log just stop) ⇒ an UNCATCHABLE external
 *     TerminateProcess / SIGKILL — nothing inside the process chose to die.
 * That single fact has been unknowable for two days because nothing recorded it.
 */
export function writeExit(code: number | string): void {
  try {
    const rec = `[${new Date().toISOString()}] EXIT code=${code} pid=${process.pid} up=${Math.round(process.uptime())}s${memTag()}\n`;
    rollIfLarge(EXIT_FILE, SINK_MAX_BYTES); // S47: cap the append-only exit-trace sink
    fs.appendFileSync(EXIT_FILE, rec);
  } catch { /* a crash sink must never throw */ }
}
