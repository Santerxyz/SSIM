import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  pipeToFile,
  stripMarkOfTheWeb,
  classifySpawnError,
  selfTestNewExe,
  type SelfTestOutcome,
} from '../src/update/Updater';

const isWin = process.platform === 'win32';
const tmp = (name: string): string =>
  path.join(os.tmpdir(), `ssim-eacces-${process.pid}-${name}`);

// ════════════════════════════════════════════════════════════════════════════
//  1. pipeToFile — THE EACCES fix: the staged file must have NO lingering write
//     handle when it resolves. The previous code resolved on 'finish' (fd still
//     open); we now resolve on 'close' (fd released) after an fsync.
// ════════════════════════════════════════════════════════════════════════════

test('pipeToFile: writes all bytes and the file handle is RELEASED on resolve (no lingering writer)', async () => {
  const dest = tmp('release.exe');
  try { fs.rmSync(dest, { force: true }); } catch { /* none */ }
  const payload = Buffer.alloc(256 * 1024, 0x5a); // 256 KiB so it spans multiple chunks
  await pipeToFile(Readable.from([payload]), dest, { append: false, stallMs: 5000 });

  // Bytes are all there…
  assert.equal(fs.statSync(dest).size, payload.length, 'every byte was flushed to disk');
  assert.ok(fs.readFileSync(dest).equals(payload), 'contents match exactly');

  // …and CRUCIALLY the write handle is gone: a rename of a file that still has an open
  // write handle throws EPERM/EBUSY/EACCES on Windows. Resolving on 'finish' (the old bug)
  // would leave that handle open and make this throw. Resolving on 'close' makes it succeed.
  const moved = `${dest}.moved`;
  assert.doesNotThrow(() => fs.renameSync(dest, moved), 'no lingering write handle — file is movable/executable immediately');
  try { fs.rmSync(moved, { force: true }); } catch { /* best-effort */ }
});

test('pipeToFile: append mode resumes from the existing partial (resumable download)', async () => {
  const dest = tmp('append.bin');
  fs.writeFileSync(dest, 'AAA');
  await pipeToFile(Readable.from([Buffer.from('BBB')]), dest, { append: true, stallMs: 5000 });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'AAABBB', 'appended after the resume offset');
  try { fs.rmSync(dest, { force: true }); } catch { /* best-effort */ }
});

test('pipeToFile: on a source error it REJECTS and KEEPS the partial file (so the loop can resume)', async () => {
  const dest = tmp('partial.bin');
  // Seed a prior-attempt partial on disk. This makes the "file is KEPT" assertion DETERMINISTIC: the old
  // version raced the async write-stream open against the nextTick source-destroy, so the file sometimes
  // hadn't been created yet when checked (intermittent flake). A pre-existing partial still verifies the
  // real contract — pipeToFile must NOT delete/unlink it on error (a delete-on-error regression would
  // remove it and fail this assertion).
  fs.writeFileSync(dest, 'existing-partial');
  const src = new Readable({ read() { /* pushed manually below */ } });
  src.push(Buffer.from('partialbytes'));
  process.nextTick(() => src.destroy(new Error('connection reset')));
  await assert.rejects(pipeToFile(src, dest, { append: false, stallMs: 5000 }), /connection reset/);
  assert.ok(fs.existsSync(dest), 'partial file is KEPT for the next resume attempt, not deleted');
  try { fs.rmSync(dest, { force: true }); } catch { /* best-effort */ }
});

test('pipeToFile: an idle/wedged socket aborts via the stall guard', async () => {
  const dest = tmp('stall.bin');
  const src = new Readable({ read() { /* never pushes → idle */ } });
  await assert.rejects(pipeToFile(src, dest, { append: false, stallMs: 60 }), /stalled/);
  try { src.destroy(); } catch { /* noop */ }
  try { fs.rmSync(dest, { force: true }); } catch { /* best-effort */ }
});

// ════════════════════════════════════════════════════════════════════════════
//  2. stripMarkOfTheWeb — remove the NTFS Zone.Identifier so SmartScreen doesn't
//     block CreateProcess (EACCES). Windows-only (ADS is an NTFS feature).
// ════════════════════════════════════════════════════════════════════════════

test('stripMarkOfTheWeb: removes a Zone.Identifier ADS and leaves the main file intact', { skip: !isWin }, () => {
  const file = tmp('motw.exe');
  fs.writeFileSync(file, 'MZ-real-exe-bytes');
  fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n'); // mark as Internet-zone

  assert.equal(stripMarkOfTheWeb(file), true, 'reported that it removed a tag');
  assert.throws(() => fs.readFileSync(`${file}:Zone.Identifier`), 'the Zone.Identifier stream is gone');
  assert.equal(fs.readFileSync(file, 'utf8'), 'MZ-real-exe-bytes', 'the main file is untouched');

  // Idempotent: stripping again when none is present is a quiet no-op.
  assert.equal(stripMarkOfTheWeb(file), false, 'no tag present → returns false, does not throw');
  try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
});

test('stripMarkOfTheWeb: a file with no MOTW (the fs-written norm) is a no-op', () => {
  const file = tmp('clean.exe');
  fs.writeFileSync(file, 'clean');
  assert.equal(stripMarkOfTheWeb(file), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'clean');
  try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
});

// ════════════════════════════════════════════════════════════════════════════
//  3. classifySpawnError — retry ONLY transient locks; a real non-zero exit is a
//     'crash' that must keep the current version.
// ════════════════════════════════════════════════════════════════════════════

test('classifySpawnError: EACCES/EBUSY/EPERM/ETXTBSY spawn failures are RETRYABLE locks', () => {
  for (const code of ['EACCES', 'EBUSY', 'EPERM', 'ETXTBSY']) {
    const err = Object.assign(new Error(`spawnSync x ${code}`), { code, errno: -13, syscall: 'spawnSync x' });
    const r = classifySpawnError(err);
    assert.equal(r.kind, 'lock', `${code} → lock`);
    assert.equal(r.errno, code);
  }
});

test('classifySpawnError: a non-zero EXIT (self-test FAIL=2) is a crash — NOT retried (keep-current)', () => {
  // execFileSync throws this shape when the child RAN and exited non-zero: numeric .status, no errno.
  const err = Object.assign(new Error('Command failed'), { status: 2, signal: null });
  const r = classifySpawnError(err);
  assert.equal(r.kind, 'crash', 'a real boot failure must not be classified as a retryable lock');
});

test('classifySpawnError: a budget timeout (WE killed it, no status) is its OWN retryable kind [C2]', () => {
  // execFileSync killed the child at `timeout`: killed=true + a kill signal, no numeric status.
  const bySignal = Object.assign(new Error('spawnSync ETIMEDOUT'), { signal: 'SIGTERM', killed: true });
  assert.equal(classifySpawnError(bySignal).kind, 'timeout', 'a timeout is escalated, not hard-crashed');
  // Some Node versions surface it as code ETIMEDOUT instead — also a timeout.
  const byCode = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
  assert.equal(classifySpawnError(byCode).kind, 'timeout');
});

test('classifySpawnError: a SELF-inflicted fatal signal (killed=false) is still a crash, not a timeout', () => {
  // The child died on its OWN signal (segfault/abort) — we did NOT kill it → a real failure, keep current.
  const err = Object.assign(new Error('spawnSync SIGSEGV'), { signal: 'SIGSEGV', killed: false });
  assert.equal(classifySpawnError(err).kind, 'crash');
});

test('classifySpawnError: a bad path (ENOENT) is a crash, not a lock', () => {
  const err = Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT', syscall: 'spawnSync' });
  assert.equal(classifySpawnError(err).kind, 'crash');
});

// ════════════════════════════════════════════════════════════════════════════
//  4. selfTestNewExe — bounded retry on locks; the keep-current guard stays intact.
//     runOnce + backoff are injected so no real exe is spawned and tests are instant.
// ════════════════════════════════════════════════════════════════════════════

const FAST: readonly number[] = [0, 0, 0, 0];
const lock = (): SelfTestOutcome => ({ ok: false, kind: 'lock', errno: 'EACCES', detail: 'spawnSync x EACCES' });
const crash = (): SelfTestOutcome => ({ ok: false, kind: 'crash', detail: 'exit 2' });
const noMarker = (): SelfTestOutcome => ({ ok: false, kind: 'no-marker', detail: '' });
const ok = (): SelfTestOutcome => ({ ok: true });

test('selfTestNewExe: a transient EACCES lock is RETRIED and then passes', async () => {
  let calls = 0;
  const runner = (): SelfTestOutcome => (++calls <= 2 ? lock() : ok()); // lock twice, then ok
  const result = await selfTestNewExe('C:/nope/fake.exe', runner, FAST);
  assert.equal(result.ok, true, 'a legit exe behind a transient lock eventually self-tests OK');
  assert.equal(calls, 3, 'it retried past the two locks');
});

test('selfTestNewExe: a genuinely broken exe (exit 2) is REJECTED and NOT retried (guard intact)', async () => {
  let calls = 0;
  const runner = (): SelfTestOutcome => { calls++; return crash(); };
  const result = await selfTestNewExe('C:/nope/fake.exe', runner, FAST);
  assert.equal(result.ok, false, 'a real boot failure keeps the current version');
  assert.equal(calls, 1, 'a crash is NOT retried — fail fast, keep current');
});

test('selfTestNewExe: exit 0 but no OK marker is REJECTED and NOT retried', async () => {
  let calls = 0;
  const runner = (): SelfTestOutcome => { calls++; return noMarker(); };
  assert.equal((await selfTestNewExe('C:/nope/fake.exe', runner, FAST)).ok, false);
  assert.equal(calls, 1, 'a no-marker boot is a real failure, not a lock');
});

test('selfTestNewExe: a PERSISTENT lock still keeps the current version after exhausting retries', async () => {
  let calls = 0;
  const runner = (): SelfTestOutcome => { calls++; return lock(); };
  const result = await selfTestNewExe('C:/nope/fake.exe', runner, FAST);
  assert.equal(result.ok, false, 'never swap if the lock never clears — guard not weakened');
  assert.equal(calls, FAST.length + 1, 'one initial attempt + N bounded retries, then give up');
});

test('selfTestNewExe: a lock that later reveals a real crash stops retrying immediately', async () => {
  let calls = 0;
  const runner = (): SelfTestOutcome => (++calls === 1 ? lock() : crash());
  assert.equal((await selfTestNewExe('C:/nope/fake.exe', runner, FAST)).ok, false);
  assert.equal(calls, 2, 'retried the lock once, hit a crash, then stopped — kept current');
});

// ─── S8: the self-test spawn is now ASYNC execFile (was execFileSync, freezing the
//        event loop 240–480s mid-session and dropping the resident fleet). ─────────
test('S8: classifySpawnError handles the ASYNC execFile error shape (exit code on .code)', () => {
  // async execFile reports a non-zero exit as .code (a NUMBER), not .status → still a crash (keep-current).
  const crash = classifySpawnError({ code: 2, killed: false } as unknown);
  assert.equal(crash.ok, false);
  assert.equal(crash.kind, 'crash', 'a non-zero exit is a real failure regardless of sync/async shape');
  // a budget-timeout kill (killed:true, no numeric exit) → timeout (retryable escalation), same as sync.
  assert.equal(classifySpawnError({ killed: true, signal: 'SIGTERM' } as unknown).kind, 'timeout');
  // a spawn errno STRING on .code → lock (retryable), unchanged.
  assert.equal(classifySpawnError({ code: 'EACCES' } as unknown).kind, 'lock');
  // the SYNC shape still classifies identically (.status numeric → crash).
  assert.equal(classifySpawnError({ status: 2 } as unknown).kind, 'crash');
});

test('S8: selfTestNewExe awaits an ASYNC runOnce (the real self-test is now non-blocking execFile)', async () => {
  let ran = false;
  const asyncOk = async (): Promise<SelfTestOutcome> => { await new Promise((r) => setImmediate(r)); ran = true; return { ok: true }; };
  const r = await selfTestNewExe('x.exe', asyncOk);
  assert.equal(ran, true);
  assert.equal(r.ok, true, 'an async self-test outcome is awaited, not treated as a truthy Promise');
});
