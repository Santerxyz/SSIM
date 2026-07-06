import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoneyOps, assetKey } from '../src/trading/MoneyOps';
import { TradeUpService } from '../src/trading/TradeUpService';
import { CasketService } from '../src/trading/CasketService';
import { TradeService } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-099 — the shared MoneyOps cross-service guard must cover the three
//  asset-moving surfaces it did NOT before: offer-accept, trade-up craft, and
//  casket move. Each must REFUSE (never move the asset) while that asset is held
//  by another money op, must not release a claim it never made (release-by-loser),
//  and must release its own claim after a successful guarded run.
//
//  assetKey('user1','a1') === 'user1:a1'. The tests claim that key first, then
//  drive each surface with a fake gc/trader and assert the refusal + key hygiene.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const K = assetKey('user1', 'a1'); // 'user1:a1'

/** Flush enough microtasks for a fire-and-forget job's finally to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** An inert inventory stub (post-move reconcile only warns; not under test here). */
function invStub(): Any {
  return { refreshOne: () => Promise.resolve({}) };
}

test('H-TRD-099 (b): trade-up craft is REFUSED while an input asset is held; craftTradeUp is never called', async () => {
  assert.equal(MoneyOps.claim(K), true, 'pre-claim the input asset for another op');
  try {
    let craftCalls = 0;
    const gc: Any = {
      status: () => ({ craftEnabled: true, reason: 'ok' }),
      opInFlight: () => false,
      craftTradeUp: async () => { craftCalls++; return { submitted: true, confirmed: true }; },
    };
    const svc: Any = new TradeUpService({} as never, {} as never, {} as never, gc);
    // The contract's 10 inputs INCLUDE a1 (the held asset).
    const inputAssetIds = ['a1', ...Array.from({ length: 9 }, (_, i) => `b${i}`)];
    svc.startExecute('user1', [{ inputAssetIds, rarityId: 'rarity_common_weapon', stattrak: false }]);
    await flush();

    const job = svc.executeStatus();
    assert.equal(job.failed, 1, 'the contract with a held input is marked failed');
    assert.equal(job.results.length, 1, 'one result row');
    assert.match(job.results[0].error ?? '', /busy in another money operation/, 'row carries the busy message');
    assert.equal(job.results[0].submitted, false, 'nothing was submitted');
    assert.equal(craftCalls, 0, 'craftTradeUp was NEVER called');
    // key hygiene: still held exactly once — the loser did NOT release another op's claim.
    assert.equal(MoneyOps.held(K), true, 'the original claim is untouched (no release-by-loser)');
    MoneyOps.release(K);
    assert.equal(MoneyOps.held(K), false, 'and a single release frees it (it was held exactly once)');
  } finally {
    MoneyOps.release(K); // belt: never leak the key across tests
  }
});

test('H-TRD-099 (c): casket startMove THROWS the busy message while an item is held; nothing is claimed twice', () => {
  assert.equal(MoneyOps.claim(K), true, 'pre-claim the item for another op');
  try {
    let moveCalls = 0;
    const gc: Any = { moveCasketItems: async () => { moveCalls++; return { moved: [], unconfirmed: [], failed: [], stopped: 'completed' }; } };
    const svc = new CasketService(gc, invStub());
    assert.throws(
      () => svc.startMove('user1', 'c1', ['a1'], 'deposit'),
      /busy in another money operation/,
      'startMove refuses a held item with the busy message',
    );
    assert.equal(moveCalls, 0, 'moveCasketItems was never launched');
    assert.equal(MoneyOps.held(K), true, 'the original claim is untouched (no release-by-loser)');
  } finally {
    MoneyOps.release(K);
  }
});

test('H-TRD-099 (a): offer-accept is REFUSED when the offer gives a held asset; accept is never invoked', async () => {
  assert.equal(MoneyOps.claim(K), true, 'pre-claim the given asset for another op');
  try {
    let accepted = false;
    const s: Any = Object.create(TradeService.prototype);
    s.offerActionsInFlight = 0;
    // A fake trader mirroring AccountTrader.acceptTradeOffer: it fetches the offer, runs the
    // caller's beforeAccept with itemsToGive, and only then accepts. Here itemsToGive holds a1.
    s.ensureWebSession = async (_username: string) => ({
      acceptTradeOffer: async (_offerId: string, opts?: Any) => {
        opts?.beforeAccept?.([{ assetid: 'a1' }]); // a throw here aborts before accept
        accepted = true;
        return 'accepted';
      },
    });

    await assert.rejects(
      s.offerAction('user1', 'o1', 'accept'),
      /busy in another money operation/,
      'offerAction rejects a held-asset accept with the busy message',
    );
    assert.equal(accepted, false, 'the underlying accept was NEVER invoked');
    assert.equal(MoneyOps.held(K), true, 'the original claim is untouched (no release-by-loser)');
  } finally {
    MoneyOps.release(K);
  }
});

test('H-TRD-099 (d): a SUCCESSFUL guarded offer-accept claims then releases its own keys', async () => {
  // No pre-existing claim: the accept should succeed, and the key it claims must be released after.
  const other = assetKey('user1', 'z9');
  assert.equal(MoneyOps.held(other), false, 'clean slate for this key');
  const s: Any = Object.create(TradeService.prototype);
  s.offerActionsInFlight = 0;
  let heldDuringAccept = false;
  s.ensureWebSession = async (_username: string) => ({
    acceptTradeOffer: async (_offerId: string, opts?: Any) => {
      opts?.beforeAccept?.([{ assetid: 'z9' }]);
      heldDuringAccept = MoneyOps.held(other); // claimed for the duration of the op
      return 'accepted';
    },
  });

  const status = await s.offerAction('user1', 'o2', 'accept');
  assert.equal(status, 'done', 'a clean accept resolves done');
  assert.equal(heldDuringAccept, true, 'the asset was claimed while the accept ran');
  assert.equal(MoneyOps.held(other), false, 'the claim is released after the op settles');
});
