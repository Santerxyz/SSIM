import fs from 'fs';
import { logsDir, baseDir } from './paths';
import { redactSecrets } from './redact';
import { rollIfLarge, SINK_MAX_BYTES } from './rollLog';

// ════════════════════════════════════════════════════════════════════════════
//  crashlog.ts – SYNCHRONOUS last-words crash sink.
//
//  WHY this EXISTS (and why winston is not enough):
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

/**
 * Serialize a NON-Error crash detail with structure preserved, so a steam-user /
 * steamcommunity promise rejection (an EResult object, `{ eresult, message }`, a plain
 * body) does not collapse to the content-free "[object Object]". Prefers a compact
 * key=value join of the diagnostic own-properties (eresult/code/name/message) when the
 * value carries any of them, else JSON.stringify; either can throw (circular refs,
 * BigInt) so the caller degrades to String(detail). NEVER throws on its own.
 */
function safeSerialize(detail: unknown): string {
  if (detail !== null && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    const parts = (['eresult', 'code', 'name', 'message'] as const)
      .filter((k) => d[k] !== undefined)
      .map((k) => `${k}=${String(d[k])}`);
    if (parts.length > 0) return parts.join(' ');
  }
  return JSON.stringify(detail) ?? String(detail);
}

/** Short current-memory tag, so a crash record shows whether RSS/heap was high at death. */
function memTag(): string {
  try {
    const m = process.memoryUsage();
    const mb = (n: number): number => Math.round(n / 1048576);
    return ` rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB`;
  } catch { return ''; }
}

/**
 * Appends a crash/fatal record to crash-log.txt synchronously. PROXY credentials in the
 * stack (proxy URLs carry user:pass) are redacted with the same canonical masker the logger
 * uses (redact.ts) — URL + legacy forms. Non-proxy secret VALUES must never be passed to a
 * crash sink in the first place (enforced by test/logSecrecyGuard.test.ts, not scrubbed
 * here). Best-effort; swallows all errors.
 */
export function writeCrash(label: string, detail: unknown): void {
  try {
    let body: string;
    if (detail instanceof Error) body = detail.stack ?? `${detail.name}: ${detail.message}`;
    else { try { body = safeSerialize(detail); } catch { body = String(detail); } }
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
 * Synchronous breadcrumb written from `process.on('exit')` — i.e. on every exit the
 * process initiates itself (a clean shutdown, a license/boot exit, a SIGHUP handler, or
 * even a vendor library calling process.exit()). Node runs 'exit' handlers synchronously
 * before the process leaves, so fs.appendFileSync here is guaranteed on disk.
 *
 * the DIAGNOSIS HINGES ON this LINE'S PRESENCE OR ABSENCE:
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
