import fs from 'fs';
import { logsDir, baseDir } from './paths';
import { redactSecrets } from './logger';

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
    fs.appendFileSync(CRASH_FILE, record);
  } catch { /* a crash sink must never throw */ }
}
