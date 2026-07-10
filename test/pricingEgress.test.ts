import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  ARCHITECTURAL INVARIANT (2026-07-10 root-cause fix): the background price fill must ride AUTHENTICATED
//  identities and must NEVER issue an anonymous market/priceoverview call.
//
//  Steam meters ANONYMOUS priceoverview per EXIT IP, and the fleet's shared rotating residential pool
//  arrives PRE-EXHAUSTED for that endpoint (other tenants spent the budget), so a cold anonymous request
//  429s while authenticated traffic on the SAME proxies sails through (2292 inventory reads, 0 429s). The
//  fix: each Steam lane sends a logged-in account's steamLoginSecure cookie over that account's own egress
//  agent, drawing that account's per-session budget; with no session web-ready the fill DEFERS rather than
//  price anonymously.
//
//  (Prior revisions ping-ponged pricing between the host IP and the rotating pool — BOTH anonymous, both
//  wrong. This test guards against a return to any anonymous / proxy-string-provider model.)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const read = (p: string): string => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('H-PRC-030: PricingService is wired to the fleet\'s AUTHENTICATED identities, not proxy strings / host IP', () => {
  const server = read('src/api/server.ts');
  const ctors = server.match(/new PricingService\(/g) ?? [];
  assert.equal(ctors.length, 1, 'exactly one PricingService construction expected');
  const ctor = server.slice(server.indexOf('new PricingService('));
  const stmt = ctor.slice(0, ctor.indexOf(';') + 1);
  assert.match(stmt, /pricerIdentities/,
    'pricing must ride authenticated session identities — an anonymous priceoverview call 429s on the shared pool');
  assert.doesNotMatch(stmt, /distinctEgressProxies/,
    'the disproven proxy-string provider (anonymous rotation) must not return');
});

test('H-PRC-030: the Steam fill DEFERS when no identity is web-ready (never an anonymous call)', () => {
  const svc = read('src/pricing/PricingService.ts');
  assert.match(svc, /fill deferred — no authenticated pricer identity/,
    'with zero identities the fill must defer (kick() restarts it on login), not price anonymously');
  // The old anonymous single-host-IP lane (`proxies … : [null]`) must be gone.
  assert.doesNotMatch(svc, /\[null\]/, 'no anonymous host-IP lane may remain');
});

test('H-PRC-030: the anonymous-era retry/foreground machinery is DELETED (root-cause hygiene)', () => {
  const svc = read('src/pricing/PricingService.ts');
  // The 60-80s per-name lane stall turned a degraded endpoint into a ~day-long grind — removed.
  assert.doesNotMatch(svc, /RATE_LIMIT_PAUSE_MS|MAX_RATE_LIMIT_RETRIES|awaitForeground|setForegroundGate/,
    'the per-name sleep-retry + foreground-yield gate (built on the disproven pool-poisoning model) must be gone');
  // The replacement failure model: retire a lane after consecutive 429s instead of stalling it.
  assert.match(svc, /LANE_RETIRE_AFTER_429/, 'a 429 must retire the lane, not stall-and-retry the same request');
  const idx = read('src/index.ts');
  assert.doesNotMatch(idx, /setForegroundGate/, 'the foreground-gate wiring must be removed from index.ts');
});

test('H-PRC-030: the Steam price source sends the identity cookie when given one', () => {
  const src = read('src/pricing/sources/SteamPriceSource.ts');
  assert.match(src, /route\?\.cookieHeader/, 'an authenticated route must attach its Cookie header');
  assert.match(src, /headers\.Cookie = route\.cookieHeader/, 'the cookie is the whole point — it must reach the request');
});

test('H-PRC-030: a 429 is still routed to the rate-limit branch, never the transport backoff (money path)', () => {
  // The money-path defect that DID cause the mass-sell 429: MarketService retried Steam's 429 on the 18s
  // transport backoff, 4× inside the window. errorClass classifies a 429 as {transient, rateLimited}; the
  // confirm path must read the latter, and BEFORE the transient one (a 429 is transient too).
  const ms = read('src/trading/MarketService.ts');
  assert.match(ms, /const cls = classifyNetworkError\(err\);/);
  assert.match(ms, /if \(cls\.rateLimited\)/);
  assert.ok(ms.indexOf('if (cls.rateLimited)') < ms.indexOf('if (cls.transient'),
    'rateLimited must be tested before transient, or the 429 gets swallowed by the transient branch');
});

test('H-PRC-030: the SDA rate-limit copy does not claim a per-exit-IP cause (mobileconf is per-account)', () => {
  // The wrong model produced UI copy blaming "per exit IP" / "a background price fill". mobileconf is
  // authenticated → the limit follows the ACCOUNT. Guard the wording so the wrong story doesn't creep back.
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function renderSdaRateLimited'), app.indexOf('function renderSdaRateLimited') + 900);
  assert.doesNotMatch(fn, /per exit IP/i, 'do not attribute the mobileconf limit to the exit IP');
  assert.doesNotMatch(fn, /background price fill/i, 'pricing does not cause the per-account confirmation limit');
});
