import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountConfig } from '../src/types/account';
import { pickWarmupAccounts, exitKeyFor, PricerWarmup, DEFAULT_WARMUP_ACCOUNTS } from '../src/pricing/PricerWarmup';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  Owner report 2026-08-27: "it will try a few times to find something logged in so it can start a
//  multi lane price fetching, but it doesn't find anything so returns to the slow option."
//
//  The identity provider can only offer sessions that ALREADY exist, so an idle fleet produced an
//  empty list on every fill and the anonymous fallback fired every time. PricerWarmup brings a few
//  accounts up instead. What these pin is the property that decides whether it actually helps:
//  Steam meters the price endpoint PER EXIT IP, so six accounts behind one proxy are worth one
//  account, and the selection must spend its budget on distinct exits first.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const acc = (username: string, proxy: string | null, enabled = true): AccountConfig => ({
  username, enabled,
  network: proxy ? { type: 'proxy', value: proxy } : { type: 'localip', value: '' },
} as unknown as AccountConfig);

const never = (): boolean => false;
/** Deterministic rand cycling through a fixed sequence — no test depends on a specific permutation,
 *  only on the properties below, but the runs must be reproducible. */
const seeded = (seq: number[]): (() => number) => { let i = 0; return () => seq[i++ % seq.length]; };
const rand = (): (() => number) => seeded([0.1, 0.7, 0.3, 0.9, 0.5]);

test('spends its budget on DISTINCT exits before taking a second from any', () => {
  // 3 proxies, 4 accounts each. Asking for 3 must return 3 different exits, not 3 accounts on one.
  const accounts = ['a', 'b', 'c'].flatMap((px) =>
    [1, 2, 3, 4].map((n) => acc(`${px}${n}`, `http://${px}.example:8080`)));
  const picked = pickWarmupAccounts(accounts, never, 3, rand());
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map(exitKeyFor)).size, 3, 'warm-up stacked one exit instead of spreading');
});

test('only doubles up on an exit once every exit has been used', () => {
  const accounts = ['a', 'b'].flatMap((px) => [1, 2, 3].map((n) => acc(`${px}${n}`, `http://${px}.example:8080`)));
  const picked = pickWarmupAccounts(accounts, never, 4, rand());
  assert.equal(picked.length, 4);
  const perExit = new Map<string, number>();
  for (const a of picked) perExit.set(exitKeyFor(a), (perExit.get(exitKeyFor(a)) ?? 0) + 1);
  assert.deepEqual([...perExit.values()].sort(), [2, 2], 'the 4 picks should be 2 per exit, not 3+1');
});

test('never returns the same account twice', () => {
  const accounts = ['a', 'b'].flatMap((px) => [1, 2].map((n) => acc(`${px}${n}`, `http://${px}.example:8080`)));
  const picked = pickWarmupAccounts(accounts, never, 10, rand());
  assert.equal(new Set(picked.map((a) => a.username)).size, picked.length);
  assert.equal(picked.length, 4, 'asking for more than exist must return everything, not loop');
});

test('skips disabled, network-less and already-live accounts', () => {
  const live = acc('live', 'http://a.example:8080');
  const off = acc('off', 'http://b.example:8080', false);
  const poolLost = { username: 'poolLost', enabled: true } as unknown as AccountConfig; // no network
  const ok = acc('ok', 'http://c.example:8080');
  const picked = pickWarmupAccounts([live, off, poolLost, ok], (u) => u === 'live', 10, rand());
  assert.deepEqual(picked.map((a) => a.username), ['ok']);
});

test('a proxyless fleet is one exit — it still warms, but only up to the accounts it has', () => {
  const accounts = [1, 2, 3].map((n) => acc(`local${n}`, null));
  const picked = pickWarmupAccounts(accounts, never, 6, rand());
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map(exitKeyFor)).size, 1, 'proxyless accounts must all resolve to one exit');
});

test('picks randomly WITHIN an exit — one bot must not carry every fill', () => {
  const accounts = [1, 2, 3, 4, 5, 6].map((n) => acc(`bot${n}`, 'http://one.example:8080'));
  const firstPicks = new Set<string>();
  for (const r of [0.0, 0.25, 0.5, 0.75, 0.99]) {
    firstPicks.add(pickWarmupAccounts(accounts, never, 1, () => r)[0].username);
  }
  assert.ok(firstPicks.size > 1, `always picked ${[...firstPicks]} — selection is not random within the exit`);
});

test('want <= 0 warms nothing', () => {
  const accounts = [acc('a', 'http://a.example:8080')];
  assert.deepEqual(pickWarmupAccounts(accounts, never, 0, rand()), []);
});

// ── The class: cooldown, single-flight, and never throwing into a fill ───────────────────────────

function harness(opts?: { accounts?: AccountConfig[]; login?: (a: AccountConfig) => Promise<unknown> }) {
  const accounts = opts?.accounts ?? [1, 2, 3].map((n) => acc(`bot${n}`, `http://p${n}.example:8080`));
  const attempted: string[] = [];
  let clock = 1_000_000;
  const w = new PricerWarmup({
    accounts: () => accounts,
    isLive:   never,
    login:    async (a) => { attempted.push(a.username); return opts?.login ? opts.login(a) : undefined; },
    now:      () => clock,
    rand:     rand(),
  }, 120_000);
  return { w, attempted, advance: (ms: number): void => { clock += ms; } };
}

test('request() starts the logins and reports how many', async () => {
  const { w, attempted } = harness();
  assert.equal(w.request(3), 3);
  await new Promise((r) => setImmediate(r));
  assert.equal(attempted.length, 3);
});

test('a second request inside the cooldown starts nothing', async () => {
  const { w, attempted, advance } = harness();
  assert.equal(w.request(3), 3);
  await new Promise((r) => setImmediate(r));
  advance(60_000);                       // still inside the 120s cooldown
  assert.equal(w.request(3), 0, 'warm-up re-fired inside its cooldown');
  advance(61_000);                       // past it
  assert.equal(w.request(3), 3);
  await new Promise((r) => setImmediate(r));
  assert.equal(attempted.length, 6);
});

test('a failing login is contained — request() still returns, and warm-up recovers next window', async () => {
  const { w, advance } = harness({ login: async () => { throw new Error('proxy down'); } });
  assert.equal(w.request(3), 3);
  await new Promise((r) => setTimeout(r, 10));
  // The in-flight latch must clear even when every login rejected, or warm-up would be dead for
  // the rest of the process — the fill would silently stay on the anonymous lane forever.
  advance(121_000);
  assert.equal(w.request(3), 3, 'warm-up stayed latched after a failed round');
});

test('an empty fleet warms nothing and does not burn the cooldown', () => {
  const { w } = harness({ accounts: [] });
  assert.equal(w.request(3), 0);
  assert.equal(w.request(3), 0, 'a no-op must not consume the cooldown window');
});

test('the default account budget is a few, not the whole fleet', () => {
  assert.ok(DEFAULT_WARMUP_ACCOUNTS >= 2 && DEFAULT_WARMUP_ACCOUNTS <= 12,
    `DEFAULT_WARMUP_ACCOUNTS=${DEFAULT_WARMUP_ACCOUNTS} is not "a few" — an idle dashboard would log in that many accounts`);
});
