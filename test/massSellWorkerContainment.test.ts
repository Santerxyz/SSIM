import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-024 — one bot throwing an UNEXPECTED exception mid-run (here: a malformed
//  disk-cached inventory stack making isAssetSellable's `inv.items.find(...)` throw
//  a TypeError) must NOT abort the whole fleet. Before the fix, that throw escaped
//  processBot → worker() → Promise.all, which rejected on the first failure: the
//  other workers were never awaited/cancelled and kept listing REAL items into a
//  job the UI reported as over, releaseCreatedSessions + the finalizer were skipped,
//  and a subsequent run inherited zombie workers mutating its counters.
//
//  Containment now guarantees: bad bot B costs its items exactly one `failed` row
//  each, bots A/C are fully processed, the run finalizes (running=false, phase=done),
//  releaseCreatedSessions is called exactly once, and a second startMassSell begins
//  with clean counters.
// ─────────────────────────────────────────────────────────────────────────────

interface Spies {
  released: number;
  sold: string[]; // assetIds that reached sellOnMarket
}

function makeTrader(username: string, spies: Spies) {
  const listed = new Set<string>();
  return {
    walletCurrency: 3, // EUR → not blocked
    httpsAgent: {},
    cookies: ['sessionid=x', 'steamLoginSecure=y'],
    ready: true,
    sessionState: 'LOGGED_IN',
    username,
    sellOnMarket: async (assetId: string) => { spies.sold.push(`${username}:${assetId}`); listed.add(assetId); return { listingId: 'L' }; },
    getListedAssetIds: async () => new Set<string>(listed),
    confirmMarketListings: async () => ({ confirmed: listed.size }),
  };
}

function makeService(spies: Spies): MarketService {
  const svc = Object.create(MarketService.prototype) as MarketService;
  const traders: Record<string, ReturnType<typeof makeTrader>> = {};
  Object.assign(svc, {
    job: { running: false, strategy: 'custom', total: 0, done: 0, listed: 0, confirmed: 0, recovered: 0, retried: 0, skippedNoPrice: 0, failed: [], deferred: [], gone: [], blocked: [] },
    cancelRequested: false,
    trades: {
      ensureWebSession: async (u: string) => (traders[u] ??= makeTrader(u, spies)),
      snapshotLive: (_users: string[]) => new Set<string>(),
      releaseCreatedSessions: async (_users: string[], _was: Set<string>) => { spies.released++; return 0; },
    },
    // Real isAssetSellable runs: botB's cached record has a non-array `items` → `.find` throws.
    inventory: {
      getCached: (u: string) => (u === 'botB' ? ({ items: 'garbage' } as unknown) : undefined),
      markListed: () => {},
    },
  });
  return svc;
}

const GROUPS = () => [
  { username: 'botA', items: [{ assetId: 'a1', marketHashName: 'AK-47 | Redline' }] },
  { username: 'botB', items: [{ assetId: 'b1', marketHashName: 'AWP | Asiimov' }] },
  { username: 'botC', items: [{ assetId: 'c1', marketHashName: 'Glock-18 | Fade' }] },
];

async function waitDone(svc: MarketService): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!svc.status().running) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('mass-sell did not finish in time');
}

test('H-TRD-024: a bot throwing mid-run does not abort the fleet; run finalizes and sessions are released', async () => {
  const spies: Spies = { released: 0, sold: [] };
  const svc = makeService(spies);

  // customCents keeps pricing out of the picture (resolveNet short-circuits on 'custom').
  svc.startMassSell(GROUPS(), 'custom', { customCents: 1000, itemDelayMs: 0, confirmBackoffMs: 0, preflightBackoffMs: 0, retryBackoffMs: 0 });
  await waitDone(svc);

  const job = svc.status();
  // Bots A and C were fully processed (listed) despite B throwing.
  assert.deepEqual(spies.sold.sort(), ['botA:a1', 'botC:c1'], 'A and C reached sellOnMarket; B never did');
  assert.equal(job.listed, 2, 'A + C listed');
  assert.equal(job.confirmed, 2, 'A + C confirmed');
  // Bot B: exactly one contained `failed` row, not a fleet abort.
  assert.equal(job.failed.length, 1, 'B contributes exactly one failed row');
  assert.equal(job.failed[0].username, 'botB');
  assert.ok(job.failed[0].error.startsWith('internal error:'), 'contained as an internal error row');
  // The finalizer ran: session release exactly once, job released & marked done.
  assert.equal(spies.released, 1, 'releaseCreatedSessions called exactly once (finalizer not skipped)');
  assert.equal(job.running, false, 'job released');
  assert.equal(job.phase, 'done', 'finalizer reached');
  assert.equal(job.done, job.total, 'every item reached a terminal state');
});

test('H-TRD-024: a second run after the throwing run starts with clean counters (no zombie carry-over)', async () => {
  const spies: Spies = { released: 0, sold: [] };
  const svc = makeService(spies);

  svc.startMassSell(GROUPS(), 'custom', { customCents: 1000, itemDelayMs: 0, confirmBackoffMs: 0, preflightBackoffMs: 0, retryBackoffMs: 0 });
  await waitDone(svc);

  // Second run must be ALLOWED (running latched false) and begin fresh.
  const second = svc.startMassSell(GROUPS(), 'custom', { customCents: 1000, itemDelayMs: 0, confirmBackoffMs: 0, preflightBackoffMs: 0, retryBackoffMs: 0 });
  assert.equal(second.total, 3, 'total reflects the new run only');
  assert.equal(second.listed, 0, 'no carry-over listings');
  assert.equal(second.failed.length, 0, 'no carry-over failed rows');
  assert.equal(second.confirmed, 0, 'no carry-over confirmations');
  await waitDone(svc);
});
