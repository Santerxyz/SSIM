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

function makeBuyServiceWithJournal(journal: MoneyOpJournal): BuyService {
  const svc = Object.create(BuyService.prototype) as BuyService;
  const trader = { walletCurrency: 3 } as Record<string, unknown>;
  trader.createBuyOrder = async () => { throw new Error('createBuyOrder must NOT be reached when the op is refused'); };
  Object.assign(svc, {
    inFlight: new Set<string>(),
    journal,
    trades: {
      // If the refuse guard let us through, this would run — the test asserts we DON'T reach it.
      ensureWebSession: async () => { throw new Error('ensureWebSession must NOT be reached when the op is refused'); },
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: { forceRefresh: async () => ({ partial: false, items: [], wallet: { balance: 100, currency: 3 } }) },
  });
  return svc;
}

test('B4 wiring: a buy matching a LINGERING journal entry is REFUSED before committing, then the entry is consumed', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-mojw-')), 'money-op-journal.json');
  const journal = new MoneyOpJournal(p); // enabled
  journal.begin(GUARD_KEY, 'buy'); // simulate a prior run that crashed mid-buy (never resolved)

  const svc = makeBuyServiceWithJournal(journal);
  await assert.rejects(
    svc.buy(P, { releaseSession: false }),
    /interrupted before it finished/,
    'a crash-interrupted buy is not silently re-fired',
  );
  // The finally consumed the lingering entry → a DELIBERATE second attempt is no longer blocked.
  assert.equal(journal.findUnresolved(GUARD_KEY), undefined, 'the entry was consumed so a deliberate retry proceeds');
});
