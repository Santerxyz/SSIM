import path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';
import { EventEmitter } from 'events';
import fsExtra from 'fs-extra';
import { logsDir, IS_SIDECAR_MODE } from './paths';

const LOG_DIR = logsDir();
fsExtra.ensureDirSync(LOG_DIR);

/** Primary human-readable log file – trades, errors, starts, everything. */
export const LOG_FILE = path.join(LOG_DIR, 'ssim.log');

/**
 * The canonical secret redactor, applied to every record's message + stack (below) and
 * re-exported for the res.json error middleware / crash sink. It covers PROXY CREDENTIALS
 * (URL userinfo + legacy host:port:user:pass forms) — the one class that can reach a sink
 * as part of an Error string. It does NOT scrub non-proxy secret VALUES (identity_secret /
 * shared_secret / tokens / password / license key); those must never be passed to a sink,
 * which is enforced by test/logSecrecyGuard.test.ts, not by scrubbing here. See redact.ts.
 */
export { redactSecrets } from './redact';
import { redactSecrets } from './redact';

// Redacts credentials from EVERY record's string-valued fields before ANY transport
// writes it. message + stack are the common carriers, but format.json() serializes every
// enumerable own property, so any metadata a caller attaches (`logger.warn('x', { proxy })`,
// or a custom Error with an enumerable own field) must be scrubbed too — otherwise those
// keys reach ssim.log/error.log + the Live Logs ring unredacted. (H-BOOT-015.)
const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') info.message = redactSecrets(info.message);
  const withStack = info as { stack?: unknown };
  if (typeof withStack.stack === 'string') withStack.stack = redactSecrets(withStack.stack);
  // Object.keys returns only string keys, so winston's Symbol(level/message/splat) internals
  // are untouched; level/timestamp are credential-free so redacting them is a no-op.
  for (const k of Object.keys(info)) {
    if (typeof (info as Record<string, unknown>)[k] === 'string')
      (info as Record<string, unknown>)[k] = redactSecrets((info as Record<string, unknown>)[k] as string);
  }
  return info;
})();

// ─── Console = clean "server monitor" ─────────────────────────────────────────
// Aligned, minimal, colour-coded by level. Full detail still lands in the file.
const ANSI = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m',
} as const;

const consoleFormat = winston.format.combine(
  redactFormat,
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp }) => {
    const colour = (ANSI as Record<string, string>)[level] ?? '';
    const tag = level.toUpperCase().padEnd(5);
    return `${ANSI.dim}${timestamp}${ANSI.reset}  ${colour}${tag}${ANSI.reset}  ${message}`;
  }),
);

// ─── File = structured JSON (timestamps + error stacks) ───────────────────────
// Exported so the redaction guard (test/loggerRedaction.test.ts) can drive the exact
// format the File transports use.
export const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  redactFormat,                 // after errors() so a populated info.stack is scrubbed too
  winston.format.json(),
);

// ─── Live in-app log stream (the "Live Logs" window) ──────────────────────────
// A custom transport mirrors every (already-redacted) log line into a small in-memory
// ring buffer AND an event bus. The dashboard's "Live Logs" window opens an SSE stream
// that backfills the ring, then receives each new line live. Fully in-process, tiny, and
// it never throws (a log sink that throws would take logging down with it).
export interface LiveLogLine { t: string; level: string; msg: string; }
export const liveLogBus = new EventEmitter();
liveLogBus.setMaxListeners(64); // one 'line' listener per open Live-Logs window
const LIVE_RING_MAX = 600;
const liveRing: LiveLogLine[] = [];
/** The most recent log lines — backfill for a freshly-opened Live Logs window. */
export function recentLogLines(): LiveLogLine[] { return liveRing.slice(); }

class LiveLogTransport extends Transport {
  log(info: { level?: unknown; message?: unknown; timestamp?: unknown }, next: () => void): void {
    try {
      const line: LiveLogLine = {
        t:     typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString(),
        level: String(info.level ?? 'info'),
        msg:   String(info.message ?? ''),
      };
      liveRing.push(line);
      if (liveRing.length > LIVE_RING_MAX) liveRing.shift();
      liveLogBus.emit('line', line);
    } catch { /* a log transport must never throw */ }
    next();
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    // Live in-app log stream (the "Live Logs" window): redacted ring buffer + event bus.
    new LiveLogTransport({ format: winston.format.combine(redactFormat, winston.format.timestamp()) }),
    // The Tauri sidecar reserves stdout for the port handshake, so skip the Console transport
    // there (log spam would corrupt the handshake). Dev / headless keep the live console monitor;
    // the file + live-log transports below capture everything regardless.
    ...(IS_SIDECAR_MODE ? [] : [new winston.transports.Console({ format: consoleFormat })]),
    // Everything important → logs/ssim.log. Rotation caps growth: a 24/7 fleet would
    // otherwise grow ssim.log without bound (memory + disk + slow tail reads).
    new winston.transports.File({
      filename: LOG_FILE,
      format:   fileFormat,
      maxsize:  10 * 1024 * 1024, // 10 MB per file…
      maxFiles: 5,                // …keep ~50 MB of history, then roll oldest out
      tailable: true,            // ssim.log stays the newest; older → ssim1.log, ssim2.log…
    }),
    // Errors also split out for quick scanning (also rotation-capped).
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level:    'error',
      format:   fileFormat,
      maxsize:  10 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    }),
  ],
});
