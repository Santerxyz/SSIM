import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsFloatClient, CsFloatError } from '../src/csfloat/CsFloatClient';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-004 — a 2xx response with a non-JSON (HTML) body used to be coerced into
//  a "success" result on the money-write paths (buy / create-listing / buy-order).
//  req() now rejects a present-but-not-JSON body on the 2xx branch so the caller
//  sees a transient failure instead of a false "Purchase sent". Empty (204) and
//  object/array bodies pass through unchanged.
// ════════════════════════════════════════════════════════════════════════════

type Req = (config: unknown) => Promise<unknown>;

test('H-FLT-004: a 2xx HTML body on a money-write rejects with CsFloatError', async () => {
  const client = new CsFloatClient('flt004-html-key');
  (client as unknown as { http: { request: Req } }).http = {
    request: async () => ({ status: 200, data: '<!doctype html><html><body>maintenance</body></html>' }),
  };
  await assert.rejects(
    () => client.buyListing('listing-1', 1000),
    (err: unknown) => err instanceof CsFloatError,
    'a non-JSON 2xx body must be treated as a failure, not a success payload',
  );
});

test('H-FLT-004: a 2xx JSON object body still resolves', async () => {
  const client = new CsFloatClient('flt004-json-key');
  (client as unknown as { http: { request: Req } }).http = {
    request: async () => ({ status: 200, data: { data: [] } }),
  };
  const res = await client.searchListings({});
  assert.deepEqual(res, { data: [] });
});

test('H-FLT-004: a 204 empty-body DELETE resolves (no throw)', async () => {
  const client = new CsFloatClient('flt004-empty-key');
  (client as unknown as { http: { request: Req } }).http = {
    request: async () => ({ status: 204, data: '' }),
  };
  await assert.doesNotReject(() => client.delistListing('listing-1'));
});
