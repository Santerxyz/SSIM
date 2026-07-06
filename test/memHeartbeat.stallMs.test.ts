import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { HEARTBEAT_FILE, __sampleForTest, stopMemHeartbeat } from '../src/utils/memHeartbeat';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-017 — the event-loop-stall breadcrumb must come from a MONOTONIC clock,
//  not Date.now(). A host sleep/resume or forward clock jump moves the wall clock
//  but NOT process.hrtime, so it must never fabricate a fake stallMs; a genuine
//  loop stall still advances hrtime and must still be recorded.
// ════════════════════════════════════════════════════════════════════════════

const INTERVAL_MS = Math.max(2_000, Number(process.env.SSIM_HEARTBEAT_MS) || 15_000);

function lastLines(n: number): Record<string, unknown>[] {
  const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim().split('\n');
  return raw.slice(-n).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function withStubbedClocks(monoMs: number, wallMs: number, fn: () => void): void {
  const realHrBig = process.hrtime.bigint;
  const realNow = Date.now;
  const realDate = global.Date;
  try {
    process.hrtime.bigint = (() => BigInt(monoMs) * 1_000_000n) as typeof process.hrtime.bigint;
    Date.now = () => wallMs;
    // toISOString() for the human `t` field reads the wall clock too; keep it stubbed-consistent.
    global.Date = class extends realDate {
      constructor(...args: unknown[]) { super(...(args.length ? (args as []) : [wallMs])); }
      static now(): number { return wallMs; }
    } as unknown as DateConstructor;
    fn();
  } finally {
    process.hrtime.bigint = realHrBig;
    Date.now = realNow;
    global.Date = realDate;
  }
}

test('H-BOOT-017: a 10-minute wall-clock jump with only one interval of monotonic time reports NO stallMs', () => {
  // Start clean so this test's two samples are the last two lines on disk.
  try { fs.rmSync(HEARTBEAT_FILE); } catch { /* no file yet */ }
  stopMemHeartbeat(); // resets lastSampleAt = 0

  // Sample 1: baseline. monotonic = 5_000_000 (non-zero so it counts as a prior sample), wall = t0.
  const mono0 = 5_000_000;
  withStubbedClocks(mono0, 1_000_000, __sampleForTest);
  // Sample 2: monotonic advanced by EXACTLY one interval (host was awake ~INTERVAL_MS),
  // but the wall clock jumped forward 10 minutes (NTP/sleep/resume/manual set).
  withStubbedClocks(mono0 + INTERVAL_MS, 1_000_000 + 10 * 60 * 1000, __sampleForTest);

  const [, second] = lastLines(2);
  assert.ok(!('stallMs' in second), 'a wall-clock jump alone must not fabricate a stallMs');
});

test('H-BOOT-017: a genuine monotonic gap > 2×interval still records stallMs', () => {
  try { fs.rmSync(HEARTBEAT_FILE); } catch { /* no file yet */ }
  stopMemHeartbeat();

  const mono0 = 5_000_000;
  withStubbedClocks(mono0, 2_000_000, __sampleForTest);
  // monotonic advanced by 3× the interval → a real event-loop stall → must be flagged.
  const gap = INTERVAL_MS * 3;
  withStubbedClocks(mono0 + gap, 2_000_000 + gap, __sampleForTest);

  const [, second] = lastLines(2);
  assert.equal(second.stallMs, gap, 'a real monotonic gap > 2×interval is recorded as stallMs');

  stopMemHeartbeat(); // leave the module clean for other tests
});
