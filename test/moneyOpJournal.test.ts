import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MoneyOpJournal } from '../src/core/MoneyOpJournal';

// ════════════════════════════════════════════════════════════════════════════
//  B4 — the cross-restart money-op journal. A CLEANLY completed op (begin→resolve)
//  leaves NO trace, so legitimate sequential repeats are never blocked. Only a
//  crash-interrupted op (begin with NO resolve) lingers and is caught on the next
//  run's retry, then consumed so a deliberate second attempt proceeds. TTL-bounded.
// ════════════════════════════════════════════════════════════════════════════

const jpath = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-moj-')), 'money-op-journal.json');

test('B4: a CLEANLY completed op (begin → resolve) leaves NO lingering entry (repeats unaffected)', () => {
  const j = new MoneyOpJournal(jpath());
  const op = 'user|730|AK-47';
  j.begin(op, 'buy');
  assert.ok(j.findUnresolved(op), 'in-flight while running');
  j.resolve(op);
  assert.equal(j.findUnresolved(op), undefined, 'a clean completion is not remembered → a legit repeat is allowed');
});

test('B4: a CRASH-interrupted op (begin, NO resolve) is CAUGHT on the retry, then consumed', () => {
  const p = jpath();
  // Run 1: begin but never resolve (process "crashed").
  new MoneyOpJournal(p).begin('user|dest|a1,a2', 'send');
  // Run 2 (fresh instance, same file): the retry sees the lingering entry.
  const j2 = new MoneyOpJournal(p);
  const stale = j2.findUnresolved('user|dest|a1,a2');
  assert.ok(stale, 'the interrupted op is detected across the "restart"');
  assert.equal(stale?.op, 'send');
  // The service consumes it (via resolve in the finally) so a DELIBERATE second attempt proceeds.
  j2.resolve('user|dest|a1,a2');
  assert.equal(j2.findUnresolved('user|dest|a1,a2'), undefined, 'consumed → the deliberate retry is allowed');
});

test('B4: record() advances the phase but the entry still lingers until resolve (post-commit crash)', () => {
  const p = jpath();
  const j = new MoneyOpJournal(p);
  j.begin('op', 'buy');
  j.record('op', 'placed');
  const e = j.findUnresolved('op');
  assert.equal(e?.phase, 'placed', 'a post-commit crash records it was actually placed');
});

test('B4: a lingering entry OLDER than the TTL is swept (a long-past crash cannot block forever)', () => {
  let clock = 1_000_000;
  const now = () => clock;
  const p = jpath();
  const j = new MoneyOpJournal(p, 1000, now); // 1s TTL
  j.begin('op', 'buy');
  clock += 5000; // 5s later — well past the TTL
  assert.equal(j.findUnresolved('op'), undefined, 'an expired entry is swept, not surfaced');
});

test('B4: distinct op-hashes (a buy and a send) never collide', () => {
  const j = new MoneyOpJournal(jpath());
  j.begin('buyer|730|AWP', 'buy');
  j.begin('sender|url|x', 'send');
  assert.equal(j.findUnresolved('buyer|730|AWP')?.op, 'buy');
  assert.equal(j.findUnresolved('sender|url|x')?.op, 'send');
  j.resolve('buyer|730|AWP');
  assert.equal(j.findUnresolved('buyer|730|AWP'), undefined);
  assert.ok(j.findUnresolved('sender|url|x'), 'resolving one leaves the other intact');
});

// ─── S15: consultRefusal enforces a pause so a double-click can't defeat refuse-once ───
test('S15: the FIRST refusal KEEPS the entry (a rapid re-fire is refused too, not consumed)', () => {
  let clock = 1_000_000;
  const j = new MoneyOpJournal(jpath(), 60_000, () => clock);
  j.begin('op', 'buy');
  // Click 1 (a crash-restart double-click): refused, entry kept + stamped.
  assert.ok(j.consultRefusal('op'), 'first click is refused');
  assert.ok(j.findUnresolved('op'), 'the entry is KEPT (not consumed) so click 2 is also refused');
  // Click 2, 200ms later (the second half of a double-click): still refused, still kept.
  clock += 200;
  assert.ok(j.consultRefusal('op'), 'a rapid re-fire is refused again');
  assert.ok(j.findUnresolved('op'), 'still kept');
});

test('S15: a DELIBERATE retry after the min-age pause is ALLOWED and consumes the entry', () => {
  let clock = 1_000_000;
  const j = new MoneyOpJournal(jpath(), 60_000, () => clock);
  j.begin('op', 'buy');
  assert.ok(j.consultRefusal('op'), 'refused first (stamps refusedAt)');
  clock += 9_000; // > the 8s min-age → the operator has had time to check Steam
  assert.equal(j.consultRefusal('op'), undefined, 'a paused, deliberate retry is allowed');
  assert.equal(j.findUnresolved('op'), undefined, 'and the entry is now consumed so the retry proceeds');
});

test('S15: force=true allows immediately (consumes the entry without waiting)', () => {
  let clock = 1_000_000;
  const j = new MoneyOpJournal(jpath(), 60_000, () => clock);
  j.begin('op', 'buy');
  assert.equal(j.consultRefusal('op', { force: true }), undefined, 'force bypasses the pause');
  assert.equal(j.findUnresolved('op'), undefined, 'consumed');
});

test('S15: consultRefusal with NO lingering entry allows (undefined) — legit ops are unaffected', () => {
  const j = new MoneyOpJournal(jpath());
  assert.equal(j.consultRefusal('fresh-op'), undefined);
});

test('B4: the journal never throws on a corrupt file (degrades to today’s behaviour, not a hazard)', () => {
  const p = jpath();
  fs.writeFileSync(p, '{ not valid json');
  const j = new MoneyOpJournal(p);
  assert.doesNotThrow(() => j.begin('op', 'buy'));
  assert.doesNotThrow(() => j.findUnresolved('op'));
  assert.doesNotThrow(() => j.resolve('op'));
});
