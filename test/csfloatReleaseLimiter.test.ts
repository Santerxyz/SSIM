import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsFloatClient } from '../src/csfloat/CsFloatClient';
import { RateLimiter } from '../src/csfloat/RateLimiter';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-005 — the static per-key limiter cache was set-only, never evicted, so
//  every rotated/removed API key leaked its RateLimiter (and the raw key string)
//  for the process lifetime. releaseLimiter drops a key's entry; a returning key
//  then rebuilds a FRESH limiter via limiterFor (create-on-miss is unchanged).
// ════════════════════════════════════════════════════════════════════════════

const limiterOf = (c: CsFloatClient): RateLimiter => (c as unknown as { limiter: RateLimiter }).limiter;

test('H-FLT-005: releaseLimiter evicts the shared per-key limiter; a returning key gets a fresh one', () => {
  const KEY = 'H-FLT-005-release-key';

  // Two clients built from the SAME key share ONE cached limiter.
  const a = new CsFloatClient(KEY);
  const b = new CsFloatClient(KEY);
  assert.equal(limiterOf(a), limiterOf(b), 'same key → one shared limiter (cached)');
  const before = limiterOf(a);

  // After release, the next client with that key builds a NEW limiter instance.
  CsFloatClient.releaseLimiter(KEY);
  const c = new CsFloatClient(KEY);
  assert.notEqual(limiterOf(c), before, 'released key → fresh limiter on next use');
});
