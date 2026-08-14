import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  stagedArtifactPath,
  sha256File,
  sweepStaleStaged,
  selfTestNewExe,
  readSelfTestState,
  recordSelfTestFailure,
  clearSelfTestState,
  SELFTEST_BLOCK_THRESHOLD,
  type SelfTestOutcome,
} from '../src/update/Updater';

const mkdir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-upd-'));
const sha256 = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex');

// ════════════════════════════════════════════════════════════════════════════
//  C1 — persist the verified download across boots, keyed by sha256.
// ════════════════════════════════════════════════════════════════════════════

test('C1: stagedArtifactPath is DETERMINISTIC per sha (resume/reuse across boots) and differs per sha', () => {
  const dir = mkdir();
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.equal(stagedArtifactPath(dir, a), stagedArtifactPath(dir, a), 'same sha → same path (so a partial resumes)');
  assert.notEqual(stagedArtifactPath(dir, a), stagedArtifactPath(dir, b), 'different sha → different path');
  assert.ok(stagedArtifactPath(dir, a).endsWith(`ssim_update_${a}.exe`), 'the sha is encoded in the filename');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C1: sha256File matches the manifest sha (the cheap "already complete?" pre-check download() uses)', async () => {
  const dir = mkdir();
  const payload = Buffer.from('MZ fake exe bytes for the reuse check');
  const digest = sha256(payload);
  const staged = stagedArtifactPath(dir, digest);
  fs.writeFileSync(staged, payload);
  assert.equal(await sha256File(staged), digest, 'a byte-intact staged artifact is recognised → download is skipped');
  // A corrupt/partial file at the same path hashes differently → NOT reused (verify would also reject it).
  fs.writeFileSync(staged, Buffer.concat([payload, Buffer.from('tampered')]));
  assert.notEqual(await sha256File(staged), digest);
  assert.equal(await sha256File(path.join(dir, 'nope.exe')), '', 'a missing file hashes to empty, never a false match');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C1: sweepStaleStaged removes OTHER-sha artifacts, keeps the current one AND the selftest-state sidecar', () => {
  const dir = mkdir();
  const keep = 'c'.repeat(64), stale = 'd'.repeat(64);
  const keepExe = stagedArtifactPath(dir, keep);
  const staleExe = stagedArtifactPath(dir, stale);
  const sidecar = path.join(dir, 'selftest-state.json');
  fs.writeFileSync(keepExe, 'keep');
  fs.writeFileSync(staleExe, 'stale');
  fs.writeFileSync(sidecar, '{"sha256":"c...","consecutiveFailures":1}');

  sweepStaleStaged(dir, keep);

  assert.ok(fs.existsSync(keepExe), 'the current offer artifact is kept (no re-download)');
  assert.ok(!fs.existsSync(staleExe), 'a superseded-offer artifact is swept (no ~185MB accumulation)');
  assert.ok(fs.existsSync(sidecar), 'the .json failure-state sidecar is NOT swept (only *.exe are)');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  C2 — a self-test TIMEOUT escalates ONCE to a 2× budget, then keeps current.
//  runOnce is injected (f, timeoutMs) so we can observe the budget it is handed.
// ════════════════════════════════════════════════════════════════════════════

const FAST: readonly number[] = [0, 0]; // instant lock backoff
const timeout = (): SelfTestOutcome => ({ ok: false, kind: 'timeout', detail: 'exceeded budget' });
const ok = (): SelfTestOutcome => ({ ok: true });
const crash = (): SelfTestOutcome => ({ ok: false, kind: 'crash', detail: 'exit 2' });

test('C2: a timeout is retried ONCE at 2× the budget and then passes', async () => {
  const budgets: number[] = [];
  let calls = 0;
  const runner = (_f: string, timeoutMs: number): SelfTestOutcome => {
    budgets.push(timeoutMs);
    return ++calls === 1 ? timeout() : ok(); // time out once, then succeed within the bigger budget
  };
  const result = await selfTestNewExe('C:/nope/fake.exe', runner, FAST, 240_000);
  assert.equal(result.ok, true, 'a slow machine that needed longer passes on the escalated budget');
  assert.deepEqual(budgets, [240_000, 480_000], 'exactly one escalation: base budget, then 2× budget');
});

test('C2: a PERSISTENT timeout escalates ONCE then KEEPS CURRENT (guard intact — never swaps)', async () => {
  const budgets: number[] = [];
  const runner = (_f: string, timeoutMs: number): SelfTestOutcome => { budgets.push(timeoutMs); return timeout(); };
  const result = await selfTestNewExe('C:/nope/fake.exe', runner, FAST, 240_000);
  assert.equal(result.ok, false, 'even the escalated budget being exceeded still keeps the current version');
  assert.equal((result as { kind: string }).kind, 'timeout');
  assert.deepEqual(budgets, [240_000, 480_000], 'the timeout is escalated EXACTLY once — not an unbounded retry loop');
});

test('C2: a timeout does not consume a lock retry, and a lock does not consume the timeout escalation', async () => {
  // Sequence: timeout (escalate) → lock (retry #1) → lock (retry #2) → ok. Both budgets used exactly.
  const seq: SelfTestOutcome[] = [
    timeout(),
    { ok: false, kind: 'lock', errno: 'EACCES', detail: 'x' },
    { ok: false, kind: 'lock', errno: 'EACCES', detail: 'x' },
    ok(),
  ];
  let i = 0;
  const result = await selfTestNewExe('C:/nope/fake.exe', () => seq[i++], FAST, 240_000);
  assert.equal(result.ok, true, 'independent counters: one timeout escalation AND two lock retries can both happen');
  assert.equal(i, 4);
});

test('C2: a crash after a timeout escalation still stops immediately (keep current)', async () => {
  const seq: SelfTestOutcome[] = [timeout(), crash()];
  let i = 0;
  const result = await selfTestNewExe('C:/nope/fake.exe', () => seq[i++], FAST, 240_000);
  assert.equal(result.ok, false, 'a real crash is never retried, even mid-escalation');
  assert.equal(i, 2);
});

// ════════════════════════════════════════════════════════════════════════════
//  C3 — per-sha self-test failure streak: never pin silently. Persisted so it
//  survives a reboot; a new sha resets it; a pass clears it.
// ════════════════════════════════════════════════════════════════════════════

test('C3: consecutive failures of the SAME sha accumulate and cross the block threshold', () => {
  const dir = mkdir();
  const sha = 'e'.repeat(64);
  assert.equal(readSelfTestState(dir), undefined, 'no state before any failure');
  let state = recordSelfTestFailure(sha, '1.4.0', 'no-marker', dir);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.firstFailedAt, state.lastFailedAt, 'first failure anchors the streak start');
  state = recordSelfTestFailure(sha, '1.4.0', 'no-marker', dir);
  state = recordSelfTestFailure(sha, '1.4.0', 'timeout', dir);
  assert.equal(state.consecutiveFailures, 3, 'streak accumulates for the same artifact across boots');
  assert.ok(state.consecutiveFailures >= SELFTEST_BLOCK_THRESHOLD, 'the surface threshold (3) is reached');
  assert.equal(state.lastKind, 'timeout', 'the latest failure kind is recorded for telemetry/surface');

  // Persisted across a fresh read (the "survives a reboot" property).
  const reread = readSelfTestState(dir);
  assert.equal(reread?.consecutiveFailures, 3);
  assert.equal(reread?.firstFailedAt, state.firstFailedAt, 'the streak start is preserved, not reset each boot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C3: a NEW published sha RESETS the streak (a genuine new release is never suppressed)', () => {
  const dir = mkdir();
  recordSelfTestFailure('f'.repeat(64), '1.4.0', 'crash', dir);
  recordSelfTestFailure('f'.repeat(64), '1.4.0', 'crash', dir);
  const fresh = recordSelfTestFailure('0'.repeat(64), '1.5.0', 'crash', dir); // different sha
  assert.equal(fresh.consecutiveFailures, 1, 'a new artifact starts its own streak at 1, not at 3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C3: clearSelfTestState wipes the streak (a self-test that finally passes un-blocks the update)', () => {
  const dir = mkdir();
  recordSelfTestFailure('a'.repeat(64), '1.4.0', 'no-marker', dir);
  assert.ok(readSelfTestState(dir));
  clearSelfTestState(dir);
  assert.equal(readSelfTestState(dir), undefined, 'a pass clears the failure state so the next check is clean');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C3: a corrupt/partial state file reads as undefined (never throws, never a false block)', () => {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'selftest-state.json'), '{ this is not json');
  assert.equal(readSelfTestState(dir), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
