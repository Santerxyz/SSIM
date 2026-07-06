import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedRequest } from '../src/api/capability';

// ─── H-API-004: Express non-strict routing serves `…/proxy/` on the `…/proxy` route, so a
// trailing slash must NOT let a secret GET escape the capability-token classification. The
// `$`-anchored regexes reject the trailing-slash form; isProtectedRequest normalizes the path
// (strip a single trailing slash, collapse duplicate slashes) before classifying. ──────────────

test('trailing-slash secret GETs are still protected (token bypass closed)', () => {
  assert.equal(isProtectedRequest('GET', '/api/accounts/foo/proxy/'), true);
  assert.equal(isProtectedRequest('GET', '/api/accounts/foo/otp/'), true);
  assert.equal(isProtectedRequest('GET', '/api/environments/e/proxy/'), true);
});

test('existing-behavior cases unchanged', () => {
  // Canonical no-trailing-slash secret GET stays protected.
  assert.equal(isProtectedRequest('GET', '/api/accounts/foo/proxy'), true);
  // A plain read stays open.
  assert.equal(isProtectedRequest('GET', '/api/inventory'), false);
  // The capless diagnostic exemption survives normalization (trailing slash → still exempt).
  assert.equal(isProtectedRequest('POST', '/api/app/open-logs/'), false);
  assert.equal(isProtectedRequest('POST', '/api/app/open-logs'), false);
});
