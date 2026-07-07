import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuyService } from '../src/trading/BuyService';

// ─── H-TRD-044: a mass-buy row whose post-buy verification FAILED must NOT report an
// authoritative spentMinor:0. buy() leaves walletAfter == walletBefore on a verifyFailed
// path, so the wallet diff is 0 — but the spend is UNKNOWN, not zero. massBuyOne gates
// spentMinor on !r.verifyFailed (→ undefined) and carries verifyFailed onto the row so any
// future consumer can tell "spent nothing" from "couldn't verify".

interface BuyStub {
  placed: boolean; confirmed: boolean; needsConfirmation: boolean;
  filled: number; ownedBefore: number; ownedAfter: number;
  walletBefore?: number; walletAfter?: number; verifyFailed: boolean; message: string;
}

function makeMassBuyService(buyResult: BuyStub): BuyService {
  const svc = Object.create(BuyService.prototype) as BuyService;
  Object.assign(svc, {
    massJob: { running: false },           // startMassBuy reads .running before replacing it
    massCancel: false,
    trades: {
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: {
      // Phase-1 balance refresh: EUR (code 3, 2-decimal), 100.00 → walletMinor 10000.
      forceRefresh: async () => ({ wallet: { currency: 3, balance: 100 } }),
    },
  });
  (svc as unknown as { buy: () => Promise<BuyStub> }).buy = async () => buyResult;
  return svc;
}

async function runToDone(svc: BuyService): Promise<Record<string, unknown>[]> {
  const job = (svc as unknown as { massJob: { phase: string; results: Record<string, unknown>[] } }).massJob;
  for (let i = 0; i < 400 && job.phase !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(job.phase, 'done', 'mass-buy run finished');
  return job.results;
}

const P = { usernames: ['buybot'], marketHashName: 'AK-47 | Redline', appId: 730, pricePerItemMajor: 1 };

test('H-TRD-044: a verifyFailed buy → spentMinor undefined (not 0) and verifyFailed flagged', async () => {
  const svc = makeMassBuyService({
    placed: true, confirmed: false, needsConfirmation: false,
    filled: 0, ownedBefore: 0, ownedAfter: 0,
    walletBefore: 100, walletAfter: 100, verifyFailed: true,
    message: 'order placed but verification failed – check manually',
  });
  svc.startMassBuy(P);
  const rows = await runToDone(svc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spentMinor, undefined, 'an unverified spend must not be reported as an authoritative 0');
  assert.equal(rows[0].verifyFailed, true, 'the row is self-describing: verification failed');
});

test('H-TRD-044: a verified buy → the real spentMinor is reported', async () => {
  const svc = makeMassBuyService({
    placed: true, confirmed: true, needsConfirmation: false,
    filled: 1, ownedBefore: 0, ownedAfter: 1,
    walletBefore: 100, walletAfter: 90, verifyFailed: false, message: 'bought',
  });
  svc.startMassBuy(P);
  const rows = await runToDone(svc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spentMinor, 1000, '10.00 EUR spent → 1000 minor units (2-decimal currency)');
  assert.equal(rows[0].verifyFailed, false);
});
