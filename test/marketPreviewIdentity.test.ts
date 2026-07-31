import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { type SellInfo } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.3 issue 2 — the sell-preview priced the WHOLE batch through items[0]'s
//  account; when that bot isn't web-ready, priceCtxFor returned an empty ctx and
//  getSellInfo went ANONYMOUS on the host IP → exhausted per-IP budget → every row
//  "no price". Fix: MarketService borrows live authenticated PRICER IDENTITIES (the
//  background-fill pool) and rotates preview workers across them. Money-safety: the
//  COMMITTED sell price is re-resolved via the selling bot's own cookie in resolveNet,
//  never these borrowed preview contexts — verified separately; here we assert egress.
// ─────────────────────────────────────────────────────────────────────────────

const PRICED: SellInfo = { lowestCents: 1000, medianCents: 1000, volume: 1, authoritative: true, basis: 'lowest' };

/** MarketService with a stubbed session layer + pricing that records the cookie each price read used. */
function makeSvc(o: { getTrader?: () => Promise<any>; identities?: any[] }) {
  const trades: any = { getTrader: o.getTrader ?? (async () => { throw new Error('offline'); }) };
  const svc = new MarketService(trades, undefined, o.identities ? () => o.identities! : undefined);
  const seen: Array<string | undefined> = [];
  (svc as any).pricing = { getSellInfo: async (_n: string, opts: any) => { seen.push(opts?.cookieHeader); return PRICED; } };
  return { svc, seen };
}

test('preview: the LIVE pool is used FIRST — a PARKED login is never even awaited (v1.4.5 stall fix)', async () => {
  // The root cause: priceCtxsFor used to call getTrader(items[0]) first, which parks in the global login
  // queue during a "Refresh all" → the whole preview hangs → client timeout → "no price". With a live
  // pool, getTrader must not be called at all.
  let getTraderCalled = false;
  const { svc } = makeSvc({
    getTrader: () => { getTraderCalled = true; return new Promise<any>(() => {}); }, // HANGS forever (parked login)
    identities: [
      { username: 'p1', cookieHeader: 'steamLoginSecure=P1', agent: {} },
      { username: 'p2', cookieHeader: 'steamLoginSecure=P2', agent: {} },
      { username: 'p3', cookieHeader: 'steamLoginSecure=P3', agent: {} },
    ],
  });
  const out = await svc.preview(Array.from({ length: 12 }, (_, i) => `Item ${i}`), 'lowest', { username: 'wouldHangBot' });
  assert.equal(Object.keys(out).length, 12, 'the preview completed via the pool — it did NOT hang on the login');
  assert.equal(getTraderCalled, false, 'with a full pool, getTrader (which would park in the login queue) is never called');
});

test('preview: pool empty → a BOUNDED getTrader supplies the acting account cookie', async () => {
  const { svc, seen } = makeSvc({
    getTrader: async () => ({ httpsAgent: {}, cookieHeader: 'steamLoginSecure=OWN' }),
    identities: [], // empty pool → fall back to the acting account (bounded)
  });
  await svc.preview(['X'], 'lowest', { username: 'liveBot' });
  assert.deepEqual(seen, ['steamLoginSecure=OWN'], 'with no pool, the acting account (bounded login) prices');
});

test('preview: pool empty + a PARKED login → bounded timeout → anonymous, NOT a hang (v1.4.5)', async () => {
  process.env.SSIM_GETTRADER_BUDGET_MS = '120'; // shrink the bound so the test is fast
  try {
    const { svc, seen } = makeSvc({
      getTrader: () => new Promise<any>(() => {}), // never resolves (parked in the login queue)
      identities: [],                              // empty pool
    });
    const t0 = Date.now();
    const out = await svc.preview(['X', 'Y'], 'lowest', { username: 'parkedBot' });
    const ms = Date.now() - t0;
    assert.equal(Object.keys(out).length, 2, 'the preview completed instead of hanging on the login');
    assert.ok(seen.every((c) => c === undefined), 'it priced ANONYMOUSLY (empty ctx) after abandoning the parked login');
    assert.ok(ms < 3000, `completed quickly (${ms}ms) — the parked login did not stall it`);
  } finally { delete process.env.SSIM_GETTRADER_BUDGET_MS; }
});

test('preview: workers ROTATE across identities so a large batch spreads over accounts', async () => {
  const ids = [
    { username: 'p1', cookieHeader: 'steamLoginSecure=P1', agent: {} },
    { username: 'p2', cookieHeader: 'steamLoginSecure=P2', agent: {} },
    { username: 'p3', cookieHeader: 'steamLoginSecure=P3', agent: {} },
  ];
  const { svc, seen } = makeSvc({ getTrader: async () => { throw new Error('offline'); }, identities: ids });
  const names = Array.from({ length: 30 }, (_, i) => `Item ${i}`);
  await svc.preview(names, 'lowest', { username: 'offlineBot' });
  const used = new Set(seen.filter(Boolean));
  assert.deepEqual([...used].sort(), ['steamLoginSecure=P1', 'steamLoginSecure=P2', 'steamLoginSecure=P3'],
    'all three identities carried part of the batch');
});

test('preview: acting bot online is de-duped from the pool (no double-use of one cookie)', async () => {
  const ids = [
    { username: 'live', cookieHeader: 'steamLoginSecure=OWN', agent: {} }, // same cookie as the acting account
    { username: 'p2', cookieHeader: 'steamLoginSecure=P2', agent: {} },
  ];
  const { svc, seen } = makeSvc({ getTrader: async () => ({ httpsAgent: {}, cookieHeader: 'steamLoginSecure=OWN' }), identities: ids });
  await svc.preview(Array.from({ length: 10 }, (_, i) => `Item ${i}`), 'lowest', { username: 'live' });
  const used = new Set(seen.filter(Boolean));
  assert.ok(used.has('steamLoginSecure=OWN') && used.has('steamLoginSecure=P2'), 'acting account + a distinct pool identity');
  assert.equal(used.size, 2, 'the duplicate OWN pool entry is de-duped by cookie');
});

test('preview: no identity available + offline bot → anonymous last resort still returns rows', async () => {
  const { svc, seen } = makeSvc({ getTrader: async () => { throw new Error('offline'); }, identities: [] });
  const out = await svc.preview(['X'], 'lowest', { username: 'offlineBot' });
  assert.deepEqual(seen, [undefined], 'no identity → a single anonymous ctx (empty cookie), not a crash');
  assert.ok('X' in out, 'a row is still produced (the retry affordance covers a 429)');
});

test('preview: a SINGLE identity still prices the whole batch (3 workers share it — v1.4.4 no-regression)', async () => {
  // Regression guard: v1.4.3 ran one worker per context, so a thin pool (1 identity) dropped preview
  // throughput to 1/3 and starved the 90s budget → "no price". Now up to 3 workers always run, sharing
  // the single identity when that is all there is.
  const { svc, seen } = makeSvc({
    getTrader: async () => ({ httpsAgent: {}, cookieHeader: 'steamLoginSecure=ONLY' }),
    identities: [], // pool empty → the acting account is the only identity
  });
  const names = Array.from({ length: 20 }, (_, i) => `Item ${i}`);
  const out = await svc.preview(names, 'lowest', { username: 'onlyBot' });
  assert.equal(Object.keys(out).length, 20, 'all 20 names priced through the single identity');
  assert.ok(seen.length === 20 && seen.every((c) => c === 'steamLoginSecure=ONLY'), 'every read used the one available cookie');
});

test('preview: custom strategy still needs no price read (money path unchanged)', async () => {
  const { svc, seen } = makeSvc({ identities: [{ username: 'p1', cookieHeader: 'c', agent: {} }] });
  const out = await svc.preview(['A', 'B'], 'custom', { customCents: 500 });
  assert.equal(seen.length, 0, 'custom pricing never calls getSellInfo');
  assert.equal(out['A'].netCents, 500);
});
