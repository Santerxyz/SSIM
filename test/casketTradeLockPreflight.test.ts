import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  2026-07-31 — owner: "I still can't deposit anything to a storage unit."
//
//  Observed live: `[gc] xblacksanterx deposit: 0 moved, 2 unconfirmed, 0 failed`
//  on an account whose every storable stack was trade-locked until 2026-08-02.
//  The items were accepted by our pre-send guard, sent to the GC, and then silently
//  ignored by Valve — each burning the full 15s verify window.
//
//  Steam's own trade-protection notice (the one InventoryManager parses) reads:
//    "…cannot be consumed, modified, or TRANSFERRED until <date>"
//  A casket deposit is such a transfer, so a trade-held item can never be deposited.
//  Refuse up front and quote the expiry instead of burning the verify window.
//
//  Deliberately conservative: a cache MISS blocks nothing, so a stale cache can never
//  refuse a move Steam would have accepted.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

function svc(items: Any[]): Any {
  const s: Any = Object.create(CasketService.prototype);
  s.job = { running: false, direction: 'deposit', username: '', casketId: '', total: 0, done: 0, moved: 0, unconfirmed: 0, failed: 0, failures: [] };
  s.inventory = { getCached: (_u: string, g: string) => (g === 'cs2' ? { items } : null) };
  s.gc = { moveCasketItems: async () => ({ moved: [], unconfirmed: [], failed: [], stopped: 'completed' }) };
  return s;
}

const stack = (assetIds: string[], over: Record<string, unknown> = {}) =>
  ({ marketHashName: 'Dreams & Nightmares Case', assetIds, tradable: true, tradeLockExpiry: null, ...over });

test('a deposit of ONLY trade-locked items is refused up front, naming the expiry', () => {
  const s = svc([stack(['1', '2'], { tradable: false, tradeLockExpiry: FUTURE })]);
  assert.throws(
    () => s.startMove('bot', 'casket1', ['1', '2'], 'deposit'),
    (e: Error) => {
      assert.match(e.message, /trade-locked/i, 'the reason must name the trade lock');
      assert.match(e.message, /storage unit/i, 'and say it is the storage-unit move that is blocked');
      return true;
    },
    'a fully trade-locked selection must fail fast, not burn the verify window',
  );
  assert.equal(s.moveStatus().running, false, 'no job may be left running');
});

test('a MIXED selection drops the locked items and proceeds with the rest', () => {
  const s = svc([
    stack(['1'], { tradable: false, tradeLockExpiry: FUTURE }),   // blocked
    stack(['2'], { tradable: true }),                             // fine
  ]);
  const job = s.startMove('bot', 'casket1', ['1', '2'], 'deposit');
  assert.equal(job.running, true, 'the move still starts for the depositable remainder');
  assert.equal(job.total, 1, 'only the un-held item is attempted');
});

test('an EXPIRED lock is not treated as held', () => {
  const s = svc([stack(['1'], { tradable: true, tradeLockExpiry: PAST })]);
  const job = s.startMove('bot', 'casket1', ['1'], 'deposit');
  assert.equal(job.total, 1, 'a lock that has already lapsed must not block the deposit');
});

test('an item unknown to the cache is still attempted (a stale cache never over-blocks)', () => {
  const s = svc([stack(['other'])]);
  const job = s.startMove('bot', 'casket1', ['999'], 'deposit');
  assert.equal(job.total, 1, 'unknown asset ⇒ attempt it; only a KNOWN held item is refused');
});

test('WITHDRAW is never blocked by the trade-lock pre-flight', () => {
  // An item already inside a unit is not the trade-held one being transferred out of the account;
  // withdraw must keep working regardless of what the cache says about locks.
  const s = svc([stack(['1'], { tradable: false, tradeLockExpiry: FUTURE })]);
  const job = s.startMove('bot', 'casket1', ['1'], 'withdraw');
  assert.equal(job.running, true, 'withdraw is unaffected');
  assert.equal(job.total, 1);
});
