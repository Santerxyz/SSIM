import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { HEARTBEAT_FILE, startMemHeartbeat, stopMemHeartbeat } from '../src/utils/memHeartbeat';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-018 — the heartbeat file rolls via an IN-PROCESS byte counter, not a
//  per-tick statSync. The counter is seeded ONCE from disk on start (so a large
//  file left by a prior run still rolls), and no statSync runs per sample.
// ════════════════════════════════════════════════════════════════════════════

const MAX_BYTES = 8 * 1024 * 1024; // must mirror the module constant

test('H-BOOT-018: a pre-existing over-cap file rolls to .1 on start, seeded by a single statSync', () => {
  // Start clean.
  try { fs.rmSync(HEARTBEAT_FILE); } catch { /* no file yet */ }
  try { fs.rmSync(HEARTBEAT_FILE + '.1'); } catch { /* no prior roll */ }
  stopMemHeartbeat(); // resets the byte counter so start re-seeds from disk

  // A prior run left a file just past the 8 MB cap.
  fs.writeFileSync(HEARTBEAT_FILE, 'x'.repeat(MAX_BYTES + 1024));

  // Spy on fs.statSync to prove it is called at most once (the seed) for this file.
  const realStat = fs.statSync;
  let statCalls = 0;
  (fs as { statSync: typeof fs.statSync }).statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (p === HEARTBEAT_FILE) statCalls += 1;
    return (realStat as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.statSync;

  try {
    startMemHeartbeat(); // seeds the counter (one statSync) then writes the baseline sample
  } finally {
    (fs as { statSync: typeof fs.statSync }).statSync = realStat;
    stopMemHeartbeat();
  }

  assert.ok(fs.existsSync(HEARTBEAT_FILE + '.1'), 'the over-cap file was rolled to .1');
  assert.ok(fs.statSync(HEARTBEAT_FILE).size < MAX_BYTES, 'the fresh current file is under the cap');
  assert.ok(statCalls <= 1, `statSync ran at most once (the seed), was ${statCalls}`);

  // Cleanup.
  try { fs.rmSync(HEARTBEAT_FILE); } catch { /* ignore */ }
  try { fs.rmSync(HEARTBEAT_FILE + '.1'); } catch { /* ignore */ }
});
