import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { TradeUpService } from '../src/trading/TradeUpService';
import { CasketService } from '../src/trading/CasketService';
import { TradeService } from '../src/trading/TradeService';
import { InventoryService } from '../src/core/InventoryService';

// ─────────────────────────────────────────────────────────────────────────────
//  S14 — the update busy-gate must also cover mass-sell / trade-up craft / casket
//  moves. Each service now exposes busy() (index.ts ORs them into isBusy, and
//  runUpdate re-checks isBusy immediately before the swap). Here we prove each
//  service reports its running state — the building block the gate consults.
//  (The methods only read the job's `running` flag, so Object.create + a fake job
//  exercises the exact shipped code without their heavy constructors.)
// ─────────────────────────────────────────────────────────────────────────────

test('S14: MarketService.busy() reflects a running mass-sell', () => {
  const m = Object.create(MarketService.prototype) as MarketService & { job: { running: boolean } };
  m.job = { running: false };
  assert.equal(m.busy(), false, 'idle → not busy');
  m.job.running = true;
  assert.equal(m.busy(), true, 'a running mass-sell must gate a swap');
});

test('S14: TradeUpService.busy() reflects a running craft job', () => {
  const t = Object.create(TradeUpService.prototype) as TradeUpService & { execJob: { running: boolean } };
  t.execJob = { running: false };
  assert.equal(t.busy(), false);
  t.execJob.running = true;
  assert.equal(t.busy(), true, 'an in-flight irreversible craft must gate a swap');
});

test('S14: CasketService.busy() reflects a running storage move', () => {
  const c = Object.create(CasketService.prototype) as CasketService & { job: { running: boolean } };
  c.job = { running: false };
  assert.equal(c.busy(), false);
  c.job.running = true;
  assert.equal(c.busy(), true, 'an in-flight casket move must gate a swap');
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-012 — batch offer actions (accept/decline/cancel) were invisible to
//  busy(): a 100-row batch accept clears mobile 2FA confirmations for minutes,
//  yet busy() reported false the whole time, so a confirmed update swap could
//  hard-exit mid-accept between the Steam write and its 2FA confirmation. The
//  offerActionsInFlight counter (incremented in offerAction, covering the single
//  route AND every batch worker) must make busy() truthful while a batch runs.
// ─────────────────────────────────────────────────────────────────────────────

test('H-TRD-012: TradeService.busy() is true while a batch accept is in flight', async () => {
  const svc = Object.create(TradeService.prototype) as TradeService;
  (svc as any).inFlight = new Set<string>();
  (svc as any).offerActionsInFlight = 0;
  (svc as any).massJob = { running: false };
  // isLive() true ⇒ wasLiveBefore true ⇒ the worker's finally never tries to log out.
  (svc as any).sessions = { isLive: () => true };

  // Controllable promise the stubbed accept hangs on: busy() stays true until we resolve.
  let releaseAccept!: () => void;
  const accepted = new Promise<void>((resolve) => { releaseAccept = resolve; });
  // The write path pre-flights the session via ensureWebSession (H-TRD-010), so stub that.
  (svc as any).ensureWebSession = async () => ({
    acceptTradeOffer: () => accepted, // hangs until releaseAccept()
  });

  assert.equal(svc.busy(), false, 'idle → not busy');

  const batch = svc.batchOfferAction([{ username: 'a', offerId: '1', action: 'accept' }]);
  // Let the worker enter offerAction and reach the hanging acceptTradeOffer await.
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.busy(), true, 'an in-flight batch accept (2FA window) must gate a swap');

  releaseAccept();
  await batch;
  assert.equal(svc.busy(), false, 'once the batch drains, the gate reopens');
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-INV-007 — refreshAfterTrade sets no job flag and its local-IP accounts sit
//  in the LocalIpThrottle queue (serial 6–12s cooldown) with NOTHING in inFlight,
//  so busy() was blind to the whole pass and a confirmed update swap could hard-
//  exit mid post-trade refresh. The bgRefreshPasses counter (bumped before the
//  workers, decremented in the returned promise's finally) must make busy() true
//  for the pass's entire lifetime — including while a fetch is still queued.
// ─────────────────────────────────────────────────────────────────────────────

test('H-INV-007: busy() is true while a refreshAfterTrade pass is queued/in flight', async () => {
  const svc = Object.create(InventoryService.prototype) as InventoryService;
  (svc as any).inFlight = new Map();
  (svc as any).job = { running: false };
  (svc as any).bgRefreshPasses = 0;
  // ownershipCtx.run just invokes the callback (the AsyncLocalStorage isolation isn't under test here).
  (svc as any).ownershipCtx = { run: (_store: unknown, fn: () => unknown) => fn() };

  // Stub the per-account refresh with a controllable promise — this stands in for an account still
  // parked in the throttle queue / mid-fetch: busy() must stay true until we release it.
  let releaseRefresh!: () => void;
  const refreshed = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  (svc as any).refreshMaybeThrottled = () => refreshed;

  assert.equal(svc.busy(), false, 'idle → not busy');

  const pass = svc.refreshAfterTrade(['a']);
  // The counter is bumped synchronously (before any fetch starts), so busy() is already true here.
  assert.equal(svc.busy(), true, 'a queued post-trade refresh must gate a swap before any fetch starts');
  assert.equal((svc as any).bgRefreshPasses, 1);

  releaseRefresh();
  await pass;
  assert.equal(svc.busy(), false, 'once the pass settles, the gate reopens');
  assert.equal((svc as any).bgRefreshPasses, 0);
});
