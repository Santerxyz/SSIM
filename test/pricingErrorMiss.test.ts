import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamPriceSource } from '../src/pricing/sources/SteamPriceSource';
import { PricingService } from '../src/pricing/PricingService';
import type { PriceEntry } from '../src/pricing/PriceCache';

// ─────────────────────────────────────────────────────────────────────────────
//  S2 — a transient fetch error must NOT be cached as an authoritative 24h "no
//  price" that survives restart. The source distinguishes a real "no price" (null)
//  from a fetch failure (throw); PricingService caches error-misses "soft" with a
//  short TTL so a network blip is retried in minutes.
// ─────────────────────────────────────────────────────────────────────────────

function installAxiosMock(responder: (url: string) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

test('S2: SteamPriceSource THROWS on 5xx / non-success (not a null "no price")', async () => {
  const src = new SteamPriceSource();
  const name = 'AK-47 | Redline (Field-Tested)';

  let restore = installAxiosMock(async () => ({ status: 500, data: {} }));
  await assert.rejects(() => src.fetchPriceCents(name, 730), /FETCH_FAILED/, '5xx must throw, not return null');
  restore();

  restore = installAxiosMock(async () => ({ status: 200, data: { success: false } }));
  await assert.rejects(() => src.fetchPriceCents(name, 730), /FETCH_FAILED/, 'success:false must throw');
  restore();

  restore = installAxiosMock(async () => ({ status: 429, data: {} }));
  await assert.rejects(() => src.fetchPriceCents(name, 730), /RATE_LIMIT/, '429 keeps its RATE_LIMIT contract');
  restore();
});

test('S2: SteamPriceSource returns null ONLY for an authoritative 200+success no-price', async () => {
  const src = new SteamPriceSource();
  const restore = installAxiosMock(async () => ({ status: 200, data: { success: true } })); // no lowest/median
  try {
    assert.equal(await src.fetchPriceCents('Some Unpriced Item', 730), null);
  } finally { restore(); }
});

// Inject a cache entry with a controlled timestamp (white-box; the map is private).
function inject(svc: PricingService, key: string, entry: PriceEntry): void {
  (((svc as any).cache).map as Map<string, PriceEntry>).set(key, entry);
}
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;

test('S2: a soft error-miss expires in minutes; an authoritative no-price lasts 24h', () => {
  const svc = new PricingService(); // default source = steam; CS2 cache key is name-only
  try {
    // Authoritative "no price" (soft absent), 11 min old → still fresh: served as null, not re-fetched.
    inject(svc, 'AuthNoPrice', { cents: null, fetchedAt: isoAgo(11 * MIN) });
    assert.equal(svc.priceCents('AuthNoPrice', 730), null, 'authoritative no-price holds for 24h');

    // Soft error-miss, 11 min old → STALE (undefined → will re-queue). This is the S2 fix: a blip is
    // not a 24h "no price", and an old soft entry loaded after restart reads as stale (re-fetched).
    inject(svc, 'SoftMiss', { cents: null, fetchedAt: isoAgo(11 * MIN), soft: true });
    assert.equal(svc.priceCents('SoftMiss', 730), undefined, 'soft miss expires within minutes');

    // A very recent soft miss is still honored briefly (no hammering between the blip and the retry).
    inject(svc, 'FreshSoft', { cents: null, fetchedAt: isoAgo(2 * MIN), soft: true });
    assert.equal(svc.priceCents('FreshSoft', 730), null);

    // Real prices keep the ~24h TTL, minus a deterministic per-name jitter of 0..4h (breaks a fill
    // cohort's TTL cliff). Assert OUTSIDE the jitter band so it holds for any key: ≤20h always fresh,
    // >24h always stale.
    inject(svc, 'Recent', { cents: 5000, fetchedAt: isoAgo(19 * HOUR) });
    assert.equal(svc.priceCents('Recent', 730), 5000);
    inject(svc, 'Stale', { cents: 5000, fetchedAt: isoAgo(25 * HOUR) });
    assert.equal(svc.priceCents('Stale', 730), undefined);
  } finally { svc.shutdown(); }
});

// A background Steam fill now rides an authenticated identity; a fill with none DEFERS (never anonymous).
// These white-box tests supply one fake identity so the Steam lane actually runs.
const fakeIdentity = () => [{ username: 'pricer', cookieHeader: 'steamLoginSecure=deadbeef', agent: undefined as any }];

test('S19: PricingService.processed counts an ERROR-resolved name (not just successes)', async () => {
  const svc = new PricingService(undefined, fakeIdentity);
  // Inject a source that always throws → the name resolves via the error path (advances `processed`,
  // NOT `fetched`). We check right after it resolves, before the ~3.5s inter-fetch sleep.
  (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => { throw new Error('FETCH_FAILED_500'); } };
  try {
    svc.ensureFilled([{ name: 'ErrItem', appid: 730 }]);
    await new Promise((r) => setTimeout(r, 250));
    const st = svc.status();
    assert.equal(st.processed, 1, 'an error-resolved name counts as processed (liveness signal for S19)');
    assert.equal(st.fetched, 0, 'but it is NOT a successful fetch');
  } finally { svc.shutdown(); }
});

test('S2: the PriceCache soft flag only attaches to a null miss (a real price is authoritative)', () => {
  const svc = new PricingService();
  try {
    const cache = (svc as any).cache;
    cache.set('softnull', null, { soft: true });
    assert.equal(cache.get('softnull').soft, true, 'null + soft → soft entry');
    cache.set('hardprice', 1234, { soft: true });
    assert.notEqual(cache.get('hardprice').soft, true, 'a real price is never soft');
    cache.set('plainnull', null);
    assert.notEqual(cache.get('plainnull').soft, true, 'a plain null (authoritative) is not soft');
  } finally { svc.shutdown(); }
});

test('S13: a processed job de-queues its ENQUEUE key even after the effective source flips mid-fill', async () => {
  const svc = new PricingService(undefined, fakeIdentity);
  try {
    (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => 100 };
    // A Steam job is queued; then the effective source flips to csfloat (a runtime CSFloat-key change).
    (svc as any).queued = new Set(['SteamKey']);
    (svc as any).queue = [{ name: 'AK-47', appid: 730, key: 'SteamKey', sourceId: 'steam' }];
    (svc as any).activeSource = () => ({ id: 'csfloat' }); // the CURRENT source differs from the job's
    void (svc as any).run();
    await new Promise((r) => setTimeout(r, 250)); // let the single item resolve (before the inter-fetch sleep)
    assert.equal((svc as any).queued.has('SteamKey'), false,
      'the ENQUEUE key is removed (old code rebuilt a csfloat key → SteamKey lingered forever, name unfetchable)');
    assert.equal((svc as any).queued.size, 0, 'queued fully drained — no permanent poisoning');
  } finally { svc.shutdown(); }
});
