import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFactory } from '../src/network/AgentFactory';

// ─────────────────────────────────────────────────────────────────────────────
//  Owner report 2026-08-11: "CSFloat lädt nicht mit local IP nur mit Proxies."
//
//  The network resolvers emit `{type:'localip', value:'0.0.0.0'}` for a proxyless
//  account — a SENTINEL meaning "no specific source address", not a bindable one.
//  Passing it to Node as `localAddress` throws EINVAL on the first connect
//  (verified live against csfloat.com: with it → EINVAL, without → HTTP 401).
//  Proxied accounts never take this path, which is exactly why only local-IP
//  accounts failed while proxies worked.
// ─────────────────────────────────────────────────────────────────────────────

type AgentWithOpts = { options?: { localAddress?: string } };

const localAddressOf = (agent: unknown): string | undefined =>
  (agent as AgentWithOpts)?.options?.localAddress;

test('the 0.0.0.0 sentinel produces an agent with NO localAddress bound', () => {
  for (const pooled of [true, false]) {
    const bundle = AgentFactory.create({ type: 'localip', value: '0.0.0.0' }, { pooled });
    assert.equal(localAddressOf(bundle.httpsAgent), undefined, `pooled=${pooled} must not bind 0.0.0.0`);
  }
});

test('the sentinel is also stripped from the steam-user options', () => {
  // steam-user hands localAddress straight to net.connect, so the same EINVAL applies there.
  const bundle = AgentFactory.create({ type: 'localip', value: '0.0.0.0' }, { pooled: false });
  assert.equal(bundle.steamUserOptions.localAddress, undefined);
});

test('a REAL local IP is still bound — the fix must not disable local-IP binding', () => {
  const bundle = AgentFactory.create({ type: 'localip', value: '192.168.1.50' }, { pooled: false });
  assert.equal(localAddressOf(bundle.httpsAgent), '192.168.1.50');
  assert.equal(bundle.steamUserOptions.localAddress, '192.168.1.50');
});

test('the IPv6 any-address and blank values are treated as sentinels too', () => {
  for (const v of ['::', '', '   ']) {
    const bundle = AgentFactory.create({ type: 'localip', value: v }, { pooled: false });
    assert.equal(localAddressOf(bundle.httpsAgent), undefined, `"${v}" must not be bound`);
  }
});

test('an https.Agent built from the sentinel can actually open a socket', async () => {
  // The regression in one line: constructing the agent never threw — connecting did.
  const bundle = AgentFactory.create({ type: 'localip', value: '0.0.0.0' }, { pooled: false });
  const net = await import('node:net');
  await new Promise<void>((resolve, reject) => {
    const opts = localAddressOf(bundle.httpsAgent) ? { localAddress: localAddressOf(bundle.httpsAgent) } : {};
    const sock = net.connect({ host: '127.0.0.1', port: 9, ...opts });
    // ECONNREFUSED is a SUCCESSFUL bind (nothing listens on discard/9); EINVAL is the bug.
    sock.on('error', (e: NodeJS.ErrnoException) => {
      sock.destroy();
      e.code === 'EINVAL' ? reject(new Error('EINVAL — the sentinel is still being bound')) : resolve();
    });
    sock.on('connect', () => { sock.destroy(); resolve(); });
  });
});
