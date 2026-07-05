import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountManager } from '../src/core/AccountManager';
import { CsFloatService } from '../src/csfloat/CsFloatService';
import { AgentFactory } from '../src/network/AgentFactory';
import type { NetworkConfig } from '../src/types/account';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-008 — CsFloatService had no whole-service teardown, so a re-license
//  (teardownFullApp → discard deps) stranded every cached per-account client and
//  the pricing client — each a local-IP keepAlive https.Agent with live sockets —
//  until GC. stop() now deterministically retires them all (INV: teardown
//  quiescence — destroyIfDisposable parks an in-flight request in the reaper).
// ════════════════════════════════════════════════════════════════════════════

function serviceWithKey(net: NetworkConfig): CsFloatService {
  const accounts = {
    get: (_u: string) => ({ network: net }),
  } as unknown as AccountManager;
  const svc = new CsFloatService(accounts);
  // Give the store a key for clientFor + pricingClient without touching disk.
  (svc as unknown as { keys: { get: (u: string) => string; usernamesWithKeys: () => string[] } }).keys = {
    get: () => 'test-key',
    usernamesWithKeys: () => ['pricer'],
  };
  return svc;
}

test('H-FLT-008: stop() disposes every cached agent once and empties the client cache', () => {
  const svc = serviceWithKey({ type: 'localip', value: '0.0.0.0' });
  const clientFor = (u: string) => (svc as unknown as { clientFor: (u: string) => object }).clientFor(u);
  const clients = () => (svc as unknown as { clients: Map<string, { agent: object }> }).clients;

  // Build two per-account clients + the shared pricing client (3 distinct agents).
  clientFor('acc1');
  clientFor('acc2');
  const pricing = svc.pricingClient();
  assert.ok(pricing, 'pricingClient built a client');

  const expectedAgents = new Set<object>();
  for (const c of clients().values()) expectedAgents.add(c.agent);
  expectedAgents.add((svc as unknown as { pricing?: { agent: object } }).pricing!.agent);
  assert.equal(expectedAgents.size, 3, 'two account agents + one pricing agent');

  const origDestroy = AgentFactory.destroyIfDisposable;
  const destroyed: unknown[] = [];
  (AgentFactory as unknown as { destroyIfDisposable: typeof AgentFactory.destroyIfDisposable }).destroyIfDisposable = ((agent: unknown) => {
    destroyed.push(agent);
    return origDestroy.call(AgentFactory, agent);
  }) as typeof AgentFactory.destroyIfDisposable;

  try {
    svc.stop();
  } finally {
    (AgentFactory as unknown as { destroyIfDisposable: typeof AgentFactory.destroyIfDisposable }).destroyIfDisposable = origDestroy;
  }

  assert.equal(destroyed.length, 3, 'destroyIfDisposable called once per distinct agent');
  assert.equal(new Set(destroyed).size, 3, 'each of the three agents was disposed exactly once');
  for (const a of expectedAgents) assert.ok(destroyed.includes(a), 'each owned agent was disposed');
  assert.equal(clients().size, 0, 'the client cache is emptied');
  assert.equal((svc as unknown as { pricing?: object }).pricing, undefined, 'the pricing client is dropped');
});
