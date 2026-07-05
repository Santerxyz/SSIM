import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountManager } from '../src/core/AccountManager';
import { CsFloatService } from '../src/csfloat/CsFloatService';
import type { NetworkConfig } from '../src/types/account';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-006 — the per-account CsFloatClient cache is keyed only by API key, so
//  an operator changing an account's proxy left every later CSFloat request
//  egressing over the RETIRED IP until restart. invalidateClient() drops the
//  cached client (and the shared pricing client when bound to that account) so
//  the next request rebuilds on the account's current network (INV-A4).
// ════════════════════════════════════════════════════════════════════════════

function serviceWithNetwork(net: () => NetworkConfig): { svc: CsFloatService } {
  const accounts = {
    get: (_u: string) => ({ network: net() }),
  } as unknown as AccountManager;
  const svc = new CsFloatService(accounts);
  // Give clientFor a key without touching the on-disk plaintext store.
  (svc as unknown as { keys: { get: (u: string) => string } }).keys = { get: () => 'test-key' };
  return { svc };
}

test('H-FLT-006: a proxy change alone does NOT rotate the cached client (reproduces the bug)', () => {
  let net: NetworkConfig = { type: 'localip', value: '0.0.0.0' };
  const { svc } = serviceWithNetwork(() => net);
  const clientFor = (u: string) => (svc as unknown as { clientFor: (u: string) => object }).clientFor(u);

  const first = clientFor('acc1');
  net = { type: 'proxy', value: 'http://user:pass@1.2.3.4:8080' }; // operator edits the proxy
  const second = clientFor('acc1');
  assert.equal(first, second, 'the key-only reuse gate returns the SAME (stale-egress) client');
});

test('H-FLT-006: invalidateClient forces a fresh client + agent on the next request', () => {
  let net: NetworkConfig = { type: 'localip', value: '0.0.0.0' };
  const { svc } = serviceWithNetwork(() => net);
  const clientFor = (u: string) => (svc as unknown as { clientFor: (u: string) => object }).clientFor(u);
  const cached = () => (svc as unknown as { clients: Map<string, { agent: object }> }).clients.get('acc1');

  const first = clientFor('acc1');
  const firstAgent = cached()?.agent;
  assert.ok(firstAgent, 'the first build cached an agent');
  net = { type: 'proxy', value: 'http://user:pass@1.2.3.4:8080' };
  svc.invalidateClient('acc1');
  assert.equal(cached(), undefined, 'invalidateClient evicts the cache entry');
  const rebuilt = clientFor('acc1');
  assert.notEqual(rebuilt, first, 'a new client is built after invalidateClient');
  assert.notEqual(cached()?.agent, firstAgent, 'the rebuilt client is bound to a NEW agent (new egress)');
});
