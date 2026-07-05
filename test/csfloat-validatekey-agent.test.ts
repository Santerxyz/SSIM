import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountManager } from '../src/core/AccountManager';
import { CsFloatService } from '../src/csfloat/CsFloatService';
import { CsFloatClient } from '../src/csfloat/CsFloatClient';
import { AgentFactory } from '../src/network/AgentFactory';
import type { NetworkConfig } from '../src/types/account';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-007 — validateKey minted a per-call agent (a non-pooled local-IP
//  keepAlive https.Agent for a proxyless account) that was never destroyed, so
//  every setKey/validateKey leaked an idle open socket. validateKey now retires
//  the agent it created in a finally, after the awaited me() has settled.
// ════════════════════════════════════════════════════════════════════════════

function serviceWithNetwork(net: NetworkConfig): CsFloatService {
  const accounts = {
    get: (_u: string) => ({ network: net }),
  } as unknown as AccountManager;
  return new CsFloatService(accounts);
}

test('H-FLT-007: validateKey disposes the agent it created exactly once', async () => {
  const svc = serviceWithNetwork({ type: 'localip', value: '0.0.0.0' });

  // Capture the agent produced for this validateKey call.
  const createdAgents: unknown[] = [];
  const origCreate = AgentFactory.create;
  const origDestroy = AgentFactory.destroyIfDisposable;
  const origMe = CsFloatClient.prototype.me;

  const destroyed: unknown[] = [];
  (AgentFactory as unknown as { create: typeof AgentFactory.create }).create = ((net, opts) => {
    const bundle = origCreate.call(AgentFactory, net, opts);
    createdAgents.push(bundle.httpsAgent);
    return bundle;
  }) as typeof AgentFactory.create;
  (AgentFactory as unknown as { destroyIfDisposable: typeof AgentFactory.destroyIfDisposable }).destroyIfDisposable = ((agent: unknown) => {
    destroyed.push(agent);
    return origDestroy.call(AgentFactory, agent);
  }) as typeof AgentFactory.destroyIfDisposable;
  // Mock the network call so the test does not hit CSFloat.
  (CsFloatClient.prototype as unknown as { me: () => Promise<Record<string, unknown>> }).me = async () => ({ ok: true });

  try {
    const profile = await svc.validateKey('acct', 'key');
    assert.deepEqual(profile, { ok: true }, 'the awaited me() result is still returned');
    assert.equal(createdAgents.length, 1, 'exactly one agent was minted for the call');
    assert.equal(destroyed.length, 1, 'destroyIfDisposable was called exactly once');
    assert.equal(destroyed[0], createdAgents[0], 'the disposed agent is the one validateKey created');
  } finally {
    (AgentFactory as unknown as { create: typeof AgentFactory.create }).create = origCreate;
    (AgentFactory as unknown as { destroyIfDisposable: typeof AgentFactory.destroyIfDisposable }).destroyIfDisposable = origDestroy;
    (CsFloatClient.prototype as unknown as { me: typeof origMe }).me = origMe;
  }
});
