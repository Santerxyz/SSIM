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

test('B4: the journal never throws on a corrupt file (degrades to today’s behaviour, not a hazard)', () => {
  const p = jpath();
  fs.writeFileSync(p, '{ not valid json');
  const j = new MoneyOpJournal(p);
  assert.doesNotThrow(() => j.begin('op', 'buy'));
  assert.doesNotThrow(() => j.findUnresolved('op'));
  assert.doesNotThrow(() => j.resolve('op'));
});
