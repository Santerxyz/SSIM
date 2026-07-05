import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuyService } from '../src/trading/BuyService';
import { MoneyOpJournal } from '../src/core/MoneyOpJournal';

// ════════════════════════════════════════════════════════════════════════════
//  B4 wiring — a buy() whose op-hash matches a LINGERING (crash-interrupted)
//  journal entry is REFUSED before it can re-commit, and the entry is CONSUMED
//  (via resolve in the finally) so a deliberate second attempt proceeds. Uses the
//  same hand-built fixture as buyPartialBaseline, but with a LIVE journal.
// ════════════════════════════════════════════════════════════════════════════

const P = { username: 'buybot', marketHashName: 'AK-47 | Redline', appId: 730, pricePerItemMinor: 1000, quantity: 1 };
const GUARD_KEY = `${P.username.toLowerCase()}|${P.appId}|${P.marketHashName}`;

// ensureWebSession throws a SENTINEL so a test can tell "refused (never reached)" from "allowed
// through (reached the commit path)". A refusal rejects with /interrupted/; an allowed retry with it.
function makeBuyServiceWithJournal(journal: MoneyOpJournal): BuyService {
  const svc = Object.create(BuyService.prototype) as BuyService;
  Object.assign(svc, {
    inFlight: new Set<string>(),
    journal,
    trades: {
      ensureWebSession: async () => { throw new Error('REACHED_COMMIT_PATH'); },
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: { forceRefresh: async () => ({ partial: false, items: [], wallet: { balance: 100, currency: 3 } }) },
  });
  return svc;
}

test('B4/S15 wiring: a buy matching a LINGERING entry is REFUSED before committing, and the entry is KEPT', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-mojw-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p); // enabled, real clock
  journal.begin(GUARD_KEY, 'buy'); // simulate a prior run that crashed mid-buy (never resolved)

  const svc = makeBuyServiceWithJournal(journal);
  await assert.rejects(
    svc.buy(P, { releaseSession: false }),
    /interrupted before it finished/,
    'a crash-interrupted buy is not silently re-fired',
  );
  // S15: the entry is KEPT (not consumed) so an immediate double-click is ALSO refused.
  assert.ok(journal.findUnresolved(GUARD_KEY), 'the refusal keeps the entry (double-click safe)');
  await assert.rejects(svc.buy(P, { releaseSession: false }), /interrupted before it finished/, 'the 2nd click is refused too');
});

test('S15 wiring: a DELIBERATE retry after the min-age pause is ALLOWED through to the commit path', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-mojw2-')), 'money-op-journal.json');
  let clock = 2_000_000;
  const journal = new MoneyOpJournal(p, 60 * 60 * 1000, () => clock);
  journal.begin(GUARD_KEY, 'buy');
  const svc = makeBuyServiceWithJournal(journal);

  await assert.rejects(svc.buy(P, { releaseSession: false }), /interrupted before it finished/, 'first click refused');
  clock += 9_000; // > 8s min-age → a deliberate, paused retry
  await assert.rejects(svc.buy(P, { releaseSession: false }), /REACHED_COMMIT_PATH/,
    'after the pause the buy is allowed past the refusal (reaches the commit path)');
});

// ─── S3: a commit that fails must only CONSUME the journal entry when it is safe ───
// A fixture whose pre-flight passes so buy() reaches trader.createBuyOrder, whose failure mode we choose.
function makeBuyServiceReachingCommit(journal: MoneyOpJournal, createBuyOrder: () => Promise<unknown>): BuyService {
  const svc = Object.create(BuyService.prototype) as BuyService;
  const trader = { walletCurrency: 3, createBuyOrder } as Record<string, unknown>;
  Object.assign(svc, {
    inFlight: new Set<string>(),
    journal,
    trades: {
      ensureWebSession: async () => trader,
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: { forceRefresh: async () => ({ partial: false, items: [], wallet: { balance: 100, currency: 3 } }) },
  });
  return svc;
}

test('S3: a TRANSPORT-AMBIGUOUS commit failure KEEPS the journal entry (retry refused, not double-spent)', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-s3a-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p);
  const svc = makeBuyServiceReachingCommit(journal, async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); });
  await assert.rejects(svc.buy(P, { releaseSession: false }), /ECONNRESET/);
  assert.ok(journal.findUnresolved(GUARD_KEY), 'the order may have landed → the entry MUST be kept');
});

test('S3: the verifyBeforeRetry commit signal also keeps the entry', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-s3v-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p);
  const svc = makeBuyServiceReachingCommit(journal, async () => { throw Object.assign(new Error('resting-order probe failed'), { verifyBeforeRetry: true }); });
  await assert.rejects(svc.buy(P, { releaseSession: false }));
  assert.ok(journal.findUnresolved(GUARD_KEY), 'verifyBeforeRetry must keep the entry');
});

test('S3: a DEFINITE commit rejection (eresult) resolves the entry (a corrected retry proceeds)', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-s3d-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p);
  const svc = makeBuyServiceReachingCommit(journal, async () => { throw Object.assign(new Error('insufficient funds'), { eresult: 15 }); });
  await assert.rejects(svc.buy(P, { releaseSession: false }), /insufficient funds/);
  assert.equal(journal.findUnresolved(GUARD_KEY), undefined, 'Steam rejected → order did not land → entry consumed');
});

// ─── H-TRD-042: the finally releases the session BEFORE consuming the journal entry ───
// A crash inside the release await must not have already erased the refuse-once memory of a buy
// whose outcome has not yet reached the operator (the response is serialized AFTER this finally).

/** A fixture whose commit SUCCEEDS so buy() reaches the finally; records the ORDER of the two
 *  finally side-effects (release vs resolve) into `order`. `journal.resolve` is spied in place. */
function makeSuccessfulBuyRecordingOrder(order: string[]): { svc: BuyService; journal: MoneyOpJournal } {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-trd042-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p);
  const realResolve = journal.resolve.bind(journal);
  journal.resolve = (k: string) => { order.push('resolve'); realResolve(k); };
  const trader = { walletCurrency: 3, createBuyOrder: async () => ({ placed: true, confirmed: true, needsConfirmation: false, buyOrderId: 'B1', raw: {} }) };
  const svc = Object.create(BuyService.prototype) as BuyService;
  Object.assign(svc, {
    inFlight: new Set<string>(),
    journal,
    trades: {
      ensureWebSession: async () => trader,
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => { order.push('release'); },
    },
    inventory: { forceRefresh: async () => ({ partial: false, items: [], wallet: { balance: 100, currency: 3 } }) },
  });
  return { svc, journal };
}

test('H-TRD-042: a successful direct buy releases the session BEFORE resolving the journal entry', async () => {
  const order: string[] = [];
  const { svc } = makeSuccessfulBuyRecordingOrder(order);
  const res = await svc.buy(P, { releaseSession: true });
  assert.equal(res.placed, true, 'the buy succeeded');
  assert.deepEqual(order, ['release', 'resolve'], 'release runs first so a crash mid-release keeps the refuse-once entry');
});

test('H-TRD-042: a pre-commit failure still resolves the journal entry (no lingering refusal)', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-trd042pre-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p);
  // ensureWebSession throws BEFORE any commit → a definite pre-commit failure. The finally must still
  // consume the entry (nothing landed on Steam), so a later legitimate retry is not refused.
  const svc = makeBuyServiceWithJournal(journal);
  await assert.rejects(svc.buy(P, { releaseSession: true }), /REACHED_COMMIT_PATH/);
  assert.equal(journal.findUnresolved(GUARD_KEY), undefined, 'a pre-commit failure resolves the entry even with releaseSession:true');
});
