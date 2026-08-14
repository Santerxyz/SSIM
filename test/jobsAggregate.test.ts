import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/jobs — the one answer behind the rail's Activity view.
//
//  Owner report 2026-08-12: "the user thinks he has to wait till the first one is done before
//  doing anything else". SSIM always ran these concurrently; a job's progress just lived inside
//  the modal that started it, so closing that modal made a running job invisible.
//
//  What matters here, and what these pin: EVERY running job appears (several at once), a finished
//  one lingers briefly and then goes, an idle install reports nothing, and one job service with a
//  drifted status shape can never take the whole list down with it.
// ════════════════════════════════════════════════════════════════════════════

/** Every collaborator createApp touches for this route, each answering "idle" unless overridden. */
function stubDeps(over: Record<string, unknown> = {}) {
  const idle = { running: false, total: 0, done: 0, failed: [] };
  const base = {
    accounts: { get: () => undefined, getAll: () => [], getEnvironment: () => undefined },
    sessions: { isTokenStoreDegraded: () => false },
    inventory: { status: () => idle, allCs2: () => ({}) },
    trades: { massStatus: () => idle, isAutoAccept: () => false },
    market: { status: () => idle, ordersScanStatus: () => ({ running: false, progress: {}, accounts: [] }) },
    buy: { massBuyStatus: () => idle },
    bans: { status: () => ({ running: false, progress: {} }) },
    tradeup: { executeStatus: () => idle },
    casket: { moveStatus: () => idle },
    batch: { status: () => idle },
    distribute: { status: () => idle },
    csfloat: { isKeyStoreDegraded: () => false },
    csfloatBulk: { status: () => idle },
    csfloatWorker: { deliverStatus: () => idle },
    paysafe: { status: () => null },
    pricing: { enrich: () => [], ensureFilled: () => {} },
    store: {}, exchange: {}, history: {}, accountImport: {},
  };
  return { ...base, ...over };
}

async function jobsOf(deps: Record<string, unknown>): Promise<{ jobs: Array<Record<string, unknown>>; running: number }> {
  const { createApp } = await import('../src/api/server');
  const { getCapabilityToken } = await import('../src/api/capability');
  const app = createApp(deps as unknown as Parameters<typeof createApp>[0]);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, path: '/api/jobs', method: 'GET',
          headers: { Host: 'localhost', Origin: 'http://localhost', 'X-SSIM-Cap': getCapabilityToken() }, timeout: 4000,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}: ${body}`));
            try { resolve(JSON.parse(body)); } catch (e) { reject(e as Error); }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('an idle install reports no jobs at all', async () => {
  const r = await jobsOf(stubDeps());
  assert.deepEqual(r.jobs, []);
  assert.equal(r.running, 0);
});

test('THREE jobs running at once all appear — the point of the whole view', async () => {
  const r = await jobsOf(stubDeps({
    inventory: { status: () => ({ running: true, total: 500, done: 120, failed: [], game: 'cs2', startedAt: new Date().toISOString() }), allCs2: () => ({}) },
    market: {
      status: () => ({ running: true, total: 40, done: 9, failed: [], strategy: 'undercut', listed: 8 }),
      ordersScanStatus: () => ({ running: false, progress: {}, accounts: [] }),
    },
    casket: { moveStatus: () => ({ running: true, total: 200, done: 30, failed: 0, username: 'bot7', direction: 'deposit' }) },
  }));
  assert.equal(r.running, 3);
  assert.deepEqual(r.jobs.map((j) => j.id).sort(), ['casket-move', 'inventory-refresh', 'mass-sell']);
  const refresh = r.jobs.find((j) => j.id === 'inventory-refresh')!;
  assert.equal(refresh.total, 500);
  assert.equal(refresh.done, 120);
  assert.equal(refresh.cancelPath, '/api/inventory/refresh-cancel', 'a running job must offer its own co-operative stop');
});

test('a finished job lingers so a run that ended while you were elsewhere is still visible', async () => {
  const r = await jobsOf(stubDeps({
    tradeup: { executeStatus: () => ({ running: false, total: 3, done: 3, failed: 0, finishedAt: new Date().toISOString() }) },
  }));
  assert.equal(r.running, 0);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].running, false);
  assert.equal(r.jobs[0].cancelPath, undefined, 'a finished job must not offer to be cancelled');
});

test('a long-finished job is gone — this is a live view, not a history log', async () => {
  const r = await jobsOf(stubDeps({
    tradeup: { executeStatus: () => ({ running: false, total: 3, done: 3, finishedAt: new Date(Date.now() - 3600_000).toISOString() }) },
  }));
  assert.deepEqual(r.jobs, []);
});

test('a stopped job that never reports a finish time does not linger as "still working"', async () => {
  // A ban check has no finishedAt; its status object simply keeps its last snapshot forever. Showing
  // that would put a permanent phantom job in the list.
  const r = await jobsOf(stubDeps({ bans: { status: () => ({ running: false, progress: { total: 9, checked: 9 } }) } }));
  assert.deepEqual(r.jobs, []);
});

test('one job service throwing does not take the whole list down', async () => {
  // The list has to stay useful when a single status() drifts or blows up — it is the surface the
  // operator checks precisely when something is wrong.
  const r = await jobsOf(stubDeps({
    batch: { status: () => { throw new Error('boom'); } },
    casket: { moveStatus: () => ({ running: true, total: 10, done: 1, failed: 0, username: 'bot1', direction: 'withdraw' }) },
  }));
  assert.equal(r.running, 1);
  assert.deepEqual(r.jobs.map((j) => j.id), ['casket-move']);
});

test('a two-phase folder buy counts the phase it is actually in', async () => {
  // Both phases walk the same account list; counting only `processed` left the bar at 0% for the
  // whole balance-refresh half of the run.
  const refreshing = await jobsOf(stubDeps({
    buy: { massBuyStatus: () => ({ running: true, phase: 'refreshing', total: 50, refreshed: 20, processed: 0, failed: [], marketHashName: 'AK-47 | Redline (FT)' }) },
  }));
  assert.equal(refreshing.jobs[0].done, 20);
  const buying = await jobsOf(stubDeps({
    buy: { massBuyStatus: () => ({ running: true, phase: 'buying', total: 50, refreshed: 50, processed: 7, failed: [] }) },
  }));
  assert.equal(buying.jobs[0].done, 7);
});
