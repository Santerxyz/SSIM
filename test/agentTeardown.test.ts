import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { AgentFactory, RETIRE_FORCE_AFTER_MS } from '../src/network/AgentFactory';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ─── The teardown-quiescence invariant (native-crash class 0xC0000409) ─────────
// An agent must NEVER be destroy()ed while it still owns in-use sockets or queued
// requests: destroying live sockets yanks native TLS/TCP handles out from under
// in-flight writes. destroyIfDisposable therefore RETIRES the agent and destroys
// it only once quiescent.

test('retire: an idle agent is destroyed immediately', () => {
  const before = AgentFactory.teardownStats();
  let destroyed = 0;
  const idle = { destroy: () => { destroyed++; }, sockets: {}, requests: {} };
  AgentFactory.destroyIfDisposable(idle);
  const after = AgentFactory.teardownStats();
  assert.equal(destroyed, 1, 'idle agent must be destroyed at once');
  assert.equal(after.destroyedIdle - before.destroyedIdle, 1);
  assert.equal(after.pendingRetire, before.pendingRetire, 'nothing parked for an idle agent');
});

test('retire: a BUSY agent is never destroyed until its work drains', () => {
  let destroyed = 0;
  const busy = {
    destroy: () => { destroyed++; },
    sockets: { 'steam:443': [{}] } as Record<string, unknown[]>,
    requests: {} as Record<string, unknown[]>,
  };
  AgentFactory.destroyIfDisposable(busy);
  assert.equal(destroyed, 0, 'MUST NOT destroy an agent with an in-use socket');

  // Several reaper passes while still busy → still alive.
  AgentFactory.sweepRetiring();
  AgentFactory.sweepRetiring();
  assert.equal(destroyed, 0, 'reaper must not destroy a still-busy agent');

  // Work drains → the next pass destroys it.
  busy.sockets['steam:443'] = [];
  AgentFactory.sweepRetiring();
  assert.equal(destroyed, 1, 'agent destroyed once quiescent');
});

test('retire: a leaked-socket agent is force-destroyed only after the hard deadline', () => {
  let destroyed = 0;
  const stuck = {
    destroy: () => { destroyed++; },
    sockets: { 'steam:443': [{}] } as Record<string, unknown[]>,
    requests: {} as Record<string, unknown[]>,
  };
  AgentFactory.destroyIfDisposable(stuck);
  assert.equal(destroyed, 0);
  // Before the deadline: kept alive.
  AgentFactory.sweepRetiring(Date.now() + RETIRE_FORCE_AFTER_MS - 1_000);
  assert.equal(destroyed, 0, 'not forced before the deadline');
  // Past the deadline: the unbounded-leak backstop fires.
  AgentFactory.sweepRetiring(Date.now() + RETIRE_FORCE_AFTER_MS + 1_000);
  assert.equal(destroyed, 1, 'forced destroy after the hard deadline');
  const stats = AgentFactory.teardownStats();
  assert.ok(stats.destroyedForced >= 1);
});

// Real-world proof against a REAL native Agent: a request in flight on the agent
// at teardown time must COMPLETE (the old immediate destroy() killed its socket
// mid-response → 'socket hang up').
test('retire: an in-flight request on a real Agent survives session teardown', async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.end('ok'), 150); // response lands AFTER the teardown below
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const agent = new http.Agent({ keepAlive: true });
  try {
    const result = new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });

    await sleep(40); // let the request acquire its socket
    AgentFactory.destroyIfDisposable(agent); // ← the session-teardown call under test

    assert.equal(await result, 'ok', 'in-flight request must complete despite teardown');

    // Once idle, the reaper actually destroys the agent (bounded resource lifetime).
    for (let i = 0; i < 50 && AgentFactory.teardownStats().pendingRetire > 0; i++) {
      AgentFactory.sweepRetiring();
      await sleep(10);
    }
    assert.equal(AgentFactory.teardownStats().pendingRetire, 0, 'agent reaped after quiescence');
  } finally {
    // Always release the OS handles, even when an assertion above fails — an open
    // server would otherwise keep the test child process alive forever.
    try { agent.destroy(); } catch { /* test cleanup */ }
    await new Promise<void>(r => server.close(() => r()));
  }
});
