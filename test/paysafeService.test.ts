import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaysafeService, PAYSAFE_MAX_MINOR, type PaysafeDeps } from '../src/store/PaysafeService';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A scriptable deps double: openCheckout returns a scripted wallet baseline per account; readWalletMinor
// returns a scripted post-completion balance. This lets us prove the money-safety classifier + the sequential
// state machine WITHOUT a real browser or Steam. All amounts are EURO-CENTS (paysafecard is EUR-only).
function makeDeps(over: Partial<PaysafeDeps> & {
  baselines?: Record<string, number | null>;
  afters?: Record<string, number | null>;
  openThrows?: Set<string>;
  released?: string[];
  walletCalls?: Array<{ username: string; allowLogin: boolean }>;
} = {}): PaysafeDeps {
  const baselines = over.baselines ?? {};
  const afters = over.afters ?? {};
  const openThrows = over.openThrows ?? new Set<string>();
  return {
    enabled: over.enabled ?? (() => true),
    openCheckout: over.openCheckout ?? (async (u) => {
      if (openThrows.has(u)) throw new Error('boom');
      return { warnings: [], proxy: 'px:1', walletMinor: baselines[u] ?? 0 };
    }),
    readWalletMinor: over.readWalletMinor ?? (async (u, o) => {
      over.walletCalls?.push({ username: u, allowLogin: o.allowLogin });
      return afters[u] ?? null;
    }),
    releaseAccount: over.releaseAccount ?? (async (u) => { over.released?.push(u); }),
  };
}

test('H-PSC-001: credited ONLY on an observed wallet rise ≥ 90% of the amount', async () => {
  // baseline 0 → after 500 for a 500-cent top-up → exactly the amount → credited.
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0 }, afters: { a: 500 } }));
  await svc.openOne('a', 500);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'credited');
  assert.equal(s.results[0].observedCreditMinor, 500);
});

test('H-PSC-002: a rise BELOW 90% is unconfirmed, never a false credited', async () => {
  // baseline 0 → after 400 for a 500 top-up = 80% < 90% → unconfirmed (money-safety: never claim credited).
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0 }, afters: { a: 400 } }));
  await svc.openOne('a', 500);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'unconfirmed');
});

test('H-PSC-003: an unreadable post-balance is unconfirmed (never credited)', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0 }, afters: { a: null } }));
  await svc.openOne('a', 500);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'unconfirmed');
});

test('H-PSC-004: a pre-existing balance is subtracted — only the RISE counts', async () => {
  // baseline 1000 → after 1490 = rise 490 for a 500 top-up (98%) → credited with credit 490.
  const svc = new PaysafeService(makeDeps({ baselines: { a: 1000 }, afters: { a: 1490 } }));
  await svc.openOne('a', 500);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'credited');
  assert.equal(s.results[0].observedCreditMinor, 490);
});

test('H-PSC-005: sequential batch opens accounts one-by-one, verifying each on advance', async () => {
  const svc = new PaysafeService(makeDeps({
    baselines: { a: 0, b: 0, c: 0 },
    afters: { a: 500, b: 0, c: 500 },   // a credits, b does NOT (no rise), c credits
  }));
  let s = await svc.startBatch(['a', 'b', 'c'], 500);
  assert.equal(s.index, 0);
  assert.equal(s.queue[s.index], 'a');
  assert.equal(s.results[0].status, 'awaiting');

  s = await svc.advance();               // verify a (credited) → open b
  assert.equal(s.results[0].status, 'credited');
  assert.equal(s.index, 1);
  assert.equal(s.results[1].status, 'awaiting');

  s = await svc.advance();               // verify b (no rise → unconfirmed) → open c
  assert.equal(s.results[1].status, 'unconfirmed');
  assert.equal(s.index, 2);

  s = await svc.advance();               // verify c (credited) → finish
  assert.equal(s.results[2].status, 'credited');
  assert.equal(s.running, false);
  assert.ok(s.finishedAt);
});

test('H-PSC-006: skip marks the account skipped and never verifies it', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 }, afters: { a: 500, b: 500 } }));
  await svc.startBatch(['a', 'b'], 500);
  const s = await svc.advance({ skip: true });   // skip a
  assert.equal(s.results[0].status, 'skipped');
  assert.equal(s.results[0].observedCreditMinor, null);
});

test('H-PSC-007: only ONE run at a time (concurrent start is refused 409)', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 } }));
  await svc.startBatch(['a'], 500);
  await assert.rejects(() => svc.startBatch(['b'], 500), /already in progress/);
});

test('H-PSC-008: a checkout that fails to open records an error, not a crash', async () => {
  const svc = new PaysafeService(makeDeps({ openThrows: new Set(['a']) }));
  const s = await svc.startBatch(['a'], 500);
  assert.equal(s.results[0].status, 'error');
  assert.match(s.results[0].detail, /could not open/);
  assert.equal(s.running, false);   // a 1-account run whose open failed must not stay "running" forever
});

test('H-PSC-009: hard-disabled (flag off) refuses to start (501)', async () => {
  const svc = new PaysafeService(makeDeps({ enabled: () => false }));
  await assert.rejects(() => svc.startBatch(['a'], 500), /hard-disabled/);
});

test('H-PSC-010: stop settles the current account (verifies it) and ends the run', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 }, afters: { a: 500 } }));
  await svc.startBatch(['a', 'b'], 500);
  const s = await svc.stop();
  assert.equal(s!.running, false);
  assert.equal(s!.results[0].status, 'credited');   // current account was verified on stop
});

// ── Regressions for the 3 adversarial-review findings (2026-07-09) ──

test('H-PSC-011: a ZERO wallet rise is NEVER credited, even at amount=1 (threshold floored at 1)', async () => {
  // amount=1 → old bug: Math.floor(1*0.9)=0, so rise=0 >= 0 = credited. Fixed: lo=max(1,0)=1.
  const svc = new PaysafeService(makeDeps({ baselines: { a: 1000 }, afters: { a: 1000 } }));
  await svc.openOne('a', 1);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'unconfirmed');   // NOT credited on a zero rise
});

test('H-PSC-012: a real +1 rise at amount=1 IS credited (threshold not over-tightened)', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 1000 }, afters: { a: 1001 } }));
  await svc.openOne('a', 1);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'credited');
});

test('H-PSC-014: checkAndAutoAdvance credits + opens the next account when the wallet rises (no click)', async () => {
  const afters: Record<string, number | null> = { a: 500, b: 0 };   // a credits; b not yet
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 }, afters }));
  const s0 = await svc.startBatch(['a', 'b'], 500);
  assert.equal(s0.index, 0);
  await svc.checkAndAutoAdvance();                 // a's wallet rose → auto-settle credited + open b
  const s = svc.status()!;
  assert.equal(s.results[0].status, 'credited');
  assert.equal(s.index, 1);                        // auto-advanced with no operator action
  assert.equal(s.results[1].status, 'awaiting');
});

test('H-PSC-015: checkAndAutoAdvance does NOT advance while the credit has not landed', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 }, afters: { a: 0 } }));  // a NOT credited
  await svc.startBatch(['a', 'b'], 500);
  await svc.checkAndAutoAdvance();
  const s = svc.status()!;
  assert.equal(s.index, 0);                        // stayed on a
  assert.equal(s.results[0].status, 'awaiting');   // never falsely credited
});

test('H-PSC-013: stop() during an in-flight advance settles the just-completed account exactly once', async () => {
  // Drive a stop() WHILE advance's openCurrent is awaiting, then let the open resolve. The account settled
  // by advance must be correct, the run must end, and no exception may escape.
  let releaseOpen: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseOpen = r; });
  let opens = 0;
  const svc = new PaysafeService(makeDeps({
    afters: { a: 500, b: 0 },
    openCheckout: async () => {
      opens++;
      if (opens === 2) await gate;   // block the SECOND open (account b) so advance stays in-flight
      return { warnings: [], proxy: 'px', walletMinor: 0 };
    },
  }));
  await svc.startBatch(['a', 'b'], 500);       // opens a (opens=1)
  const advancing = svc.advance();             // settles a (credited), opens b (opens=2, blocked on gate)
  await tick(10);                              // let advance reach the blocked open
  const stopRet = await svc.stop();            // busy → sets stopRequested, returns immediately
  assert.equal(stopRet!.running, true);        // not ended yet — the in-flight advance owns the stop
  assert.equal(stopRet!.stopping, true);       // …but the UI is told the stop was ACCEPTED
  releaseOpen();                               // let the open resolve
  const s = await advancing;                   // advance honors stopRequested → ends the run
  assert.equal(s.running, false);
  assert.equal(s.results[0].status, 'credited'); // account a settled correctly, exactly once
  assert.ok(s.finishedAt);
});

// ── Regressions for the 2026-07-10 hardening pass ──────────────────────────────

test('H-PSC-016: a rise LARGER than the top-up is NOT credited (double-charge / unrelated credit)', async () => {
  // A balance delta cannot attribute itself to THIS transaction. A cart that charged twice (rise 1000 for a
  // 500 top-up) previously cleared the ">= 90%" test and was reported as a clean `credited`.
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0 }, afters: { a: 1000 } }));
  await svc.openOne('a', 500);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'unconfirmed');
  assert.match(s.results[0].detail, /MORE than/);
  assert.equal(s.results[0].observedCreditMinor, 1000);   // the observed figure is still reported, honestly
});

test('H-PSC-016b: a market sale landing mid-run does not get claimed as the paysafecard credit', async () => {
  // baseline 1000 → after 3000 (a €20 sale settled) for a €5 top-up → refuse to call it credited.
  const svc = new PaysafeService(makeDeps({ baselines: { a: 1000 }, afters: { a: 3000 } }));
  await svc.openOne('a', 500);
  const s = await svc.verifyOne();
  assert.equal(s.results[0].status, 'unconfirmed');
});

test('H-PSC-017: stop() while the FIRST checkout is still opening ends the run (never left running)', async () => {
  let releaseOpen: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseOpen = r; });
  let opens = 0;
  const svc = new PaysafeService(makeDeps({
    afters: { a: 0 },
    openCheckout: async () => { if (++opens === 1) await gate; return { warnings: [], proxy: 'px', walletMinor: 0 }; },
  }));
  const starting = svc.startBatch(['a', 'b'], 500);
  await tick(10);
  const stopRet = await svc.stop();              // startBatch is busy → the stop is DEFERRED to it
  assert.equal(stopRet!.stopping, true);
  releaseOpen();
  const s = await starting;
  assert.equal(s.running, false);                // OLD BUG: startBatch ignored stopRequested → ran on forever
  assert.equal(s.index, 0);                      // account b was never opened
  assert.equal(s.results[0].status, 'unconfirmed');  // the just-opened account was settled, not abandoned
});

test('H-PSC-018: a deferred stop() never leaks into the NEXT run', async () => {
  let releaseOpen: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseOpen = r; });
  let opens = 0;
  const svc = new PaysafeService(makeDeps({
    afters: { a: 0, c: 0, d: 0 },
    openCheckout: async () => { if (++opens === 1) await gate; return { warnings: [], proxy: 'px', walletMinor: 0 }; },
  }));
  const starting = svc.startBatch(['a', 'b'], 500);
  await tick(10);
  await svc.stop();                              // deferred → stopRequested set
  releaseOpen();
  await starting;                                // run 1 ends and MUST consume stopRequested

  // OLD BUG: stopRequested survived, so run 2 terminated after its very first account.
  const s2 = await svc.startBatch(['c', 'd'], 500);
  assert.equal(s2.running, true);
  assert.equal(s2.index, 0);
  await svc.advance();                           // settle c → open d
  assert.equal(svc.status()!.index, 1);
  assert.equal(svc.status()!.running, true);
});

test('H-PSC-019: ordinary credit polls do NOT re-login; a forced login is a bounded backstop', async () => {
  // OLD BUG: every 15s poll performed a full destroySession + Steam re-login (24 per account per run).
  const walletCalls: Array<{ username: string; allowLogin: boolean }> = [];
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 }, afters: { a: 0 }, walletCalls }));
  await svc.startBatch(['a', 'b'], 500);
  for (let i = 0; i < 6; i++) await svc.checkAndAutoAdvance();
  assert.equal(walletCalls.length, 6);
  assert.deepEqual(walletCalls.slice(0, 5).map((c) => c.allowLogin), [false, false, false, false, false]);
  assert.equal(walletCalls[5].allowLogin, true);   // every 6th check (~90s) forces one fresh login
});

test('H-PSC-020: each account is released once the run moves past it (no session accumulation)', async () => {
  const released: string[] = [];
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0, b: 0 }, afters: { a: 500, b: 500 }, released }));
  await svc.startBatch(['a', 'b'], 500);
  await svc.advance();                 // settle a → release a → open b
  assert.deepEqual(released, ['a']);
  await svc.advance();                 // settle b → release b → finish
  assert.deepEqual(released, ['a', 'b']);
});

test('H-PSC-021: an amount above the per-top-up ceiling is refused (fat-finger guard)', async () => {
  const svc = new PaysafeService(makeDeps());
  await assert.rejects(() => svc.startBatch(['a'], PAYSAFE_MAX_MINOR + 1), /ceiling/);
  await assert.rejects(() => svc.startBatch(['a'], 1.5), /whole number/);
  await assert.rejects(() => svc.startBatch(['a'], 0), /whole number/);
});

test('H-PSC-022: an account whose checkout fails to open is stepped over, not stranded', async () => {
  const svc = new PaysafeService(makeDeps({ openThrows: new Set(['a']), baselines: { b: 0 }, afters: { b: 0 } }));
  const s = await svc.startBatch(['a', 'b'], 500);
  assert.equal(s.results[0].status, 'error');
  assert.equal(s.index, 1);                       // moved straight on to b
  assert.equal(s.results[1].status, 'awaiting');
  assert.equal(s.running, true);
});

test('H-PSC-023: verify on a run the auto-poll already finished reports it instead of throwing 409', async () => {
  const svc = new PaysafeService(makeDeps({ baselines: { a: 0 }, afters: { a: 500 } }));
  await svc.openOne('a', 500);
  await svc.checkAndAutoAdvance();                // auto-credits and finishes the 1-account run
  assert.equal(svc.status()!.running, false);
  const s = await svc.verifyOne();                // the UI's "I've paid" button must not 409 here
  assert.equal(s.results[0].status, 'credited');
});

test('H-PSC-024: flipping the kill switch off mid-run settles the open account and releases its session', async () => {
  // Ending the run is not enough: the operator may already have paid on the account whose page is open, and
  // its resident session must not be stranded. (The old assertion only checked running===false — vacuous.)
  let on = true;
  const released: string[] = [];
  const svc = new PaysafeService(makeDeps({ enabled: () => on, baselines: { a: 0, b: 0 }, afters: { a: 500 }, released }));
  await svc.startBatch(['a', 'b'], 500);
  on = false;
  await svc.checkAndAutoAdvance();
  const s = svc.status()!;
  assert.equal(s.running, false);
  assert.equal(s.results[0].status, 'credited');   // settled by read-back, not abandoned as 'awaiting'
  assert.deepEqual(released, ['a']);               // the session it created was handed back
  assert.equal(s.index, 0);                        // account b was never opened
});

test('H-PSC-025: shutdown() clears run state so a later run is not poisoned', async () => {
  let releaseOpen: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseOpen = r; });
  let opens = 0;
  const svc = new PaysafeService(makeDeps({
    afters: { a: 0, b: 0 },
    openCheckout: async () => { if (++opens === 1) await gate; return { warnings: [], proxy: 'px', walletMinor: 0 }; },
  }));
  const starting = svc.startBatch(['a'], 500);
  await tick(10);
  await svc.stop();          // deferred
  svc.shutdown();            // must drop stopRequested/busy too, not just the session
  releaseOpen();
  await starting.catch(() => {});
  assert.equal(svc.status(), null);
  const s2 = await svc.startBatch(['b'], 500);
  assert.equal(s2.running, true);
  assert.equal(s2.index, 0);
});
