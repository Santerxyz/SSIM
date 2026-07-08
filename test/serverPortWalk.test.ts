import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { listenAndAnnounce, _resetForTest } from '../src/utils/serverPort';

// ─── H-BOOT-019: the walk attempts EXACTLY `tries` ports, not tries+1 ───────────
//  The guard is `port < walkStart + tries - 1`, so with desiredPort=p and `tries`
//  the highest port attempted is p+tries-1 (a total of `tries` binds). The old
//  off-by-one guard (`port < walkStart + tries`) attempted p … p+tries (tries+1).

const HOST = '127.0.0.1';

const close = (s: http.Server): Promise<void> => new Promise((r) => s.close(() => r()));
const closeAll = (ss: http.Server[]): Promise<unknown> => Promise.all(ss.map(close));

/** An OS-assigned free port, then released — a good candidate base to reserve from. */
function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, HOST, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Bind a server on an exact port; resolves the server on success, null if the port is taken. */
function tryOccupy(port: number): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const s = http.createServer((_q, r) => r.end());
    s.once('error', () => resolve(null));
    s.listen(port, HOST, () => resolve(s));
  });
}

/**
 * Reserve `count` CONSECUTIVE occupied ports (base … base+count-1) while ensuring the
 * NEXT port (base+count) is free — the port an off-by-one walk would wrongly reach.
 * Retries with fresh bases so the test never depends on a specific port being free.
 */
async function occupyBlock(count: number): Promise<{ base: number; servers: http.Server[] }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const base = await findFreePort();
    if (base + count > 65535) continue;
    const servers: http.Server[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const s = await tryOccupy(base + i);
      if (!s) { ok = false; break; }
      servers.push(s);
    }
    if (ok) {
      const nextFree = await tryOccupy(base + count); // must be FREE to distinguish old vs new
      if (nextFree) { await close(nextFree); return { base, servers }; }
    }
    await closeAll(servers);
  }
  throw new Error(`could not reserve ${count} consecutive free ports`);
}

test('listenAndAnnounce: tries=1 attempts ONLY the desired port (no walk) and rejects when it is busy', async () => {
  _resetForTest();
  const p = await findFreePort();
  const occupied = await tryOccupy(p);
  assert.ok(occupied, 'test setup: could not occupy the desired port');
  const server = http.createServer((_q, r) => r.end());
  try {
    await assert.rejects(
      listenAndAnnounce(server, HOST, p, 1),
      (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE',
      'with tries=1 the walk must not step to p+1 — it attempts exactly the desired port',
    );
  } finally { await close(server); await close(occupied!); }
});

test('listenAndAnnounce: a walk stepping past the TCP ceiling rejects EADDRINUSE, not a RangeError (H-BOOT-020)', async () => {
  _resetForTest();
  // Make the very top port (65535) busy so the walk from 65535 must step to 65536 — out of
  // the valid TCP range. Whether we bind it or another process already holds it, it is busy.
  const top = await tryOccupy(65535);
  const server = http.createServer((_q, r) => r.end());
  try {
    await assert.rejects(
      listenAndAnnounce(server, HOST, 65535, 20),
      (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE',
      'stepping past 65535 must surface as walk-exhausted EADDRINUSE, never a raw RangeError from server.listen(65536)',
    );
  } finally { await close(server); if (top) await close(top); }
});

test('listenAndAnnounce: a block of `tries` occupied ports exhausts the walk (no tries+1 overrun)', async () => {
  _resetForTest();
  const tries = 4;
  const { base, servers } = await occupyBlock(tries);
  const server = http.createServer((_q, r) => r.end());
  try {
    // Exactly `tries` ports (base … base+tries-1) are occupied; base+tries is free.
    // Fixed guard attempts only those `tries` ports → all busy → reject.
    // The old off-by-one guard would have walked one further to the free base+tries and resolved.
    await assert.rejects(
      listenAndAnnounce(server, HOST, base, tries),
      (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE',
      'the walk must stop after `tries` ports, not overrun into the free next port',
    );
  } finally { await close(server); await closeAll(servers); }
});
