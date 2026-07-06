import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { logsDir } from '../src/utils/paths';
import { SINK_MAX_BYTES } from '../src/utils/rollLog';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-004 — the hot stderr tee in bootflags.ts tracks bytes IN-PROCESS and
//  rolls to .1 past the cap (S47). The old code reset the byte counter to 0 even
//  when the roll's renameSync THREW (Windows EPERM/EBUSY under an external lock),
//  so the sink kept appending to the still-over-cap file and did not re-attempt
//  the roll for another full SINK_MAX_BYTES → overshoot to ~2× cap (unbounded
//  under a persistent lock). The fix leaves the counter high on a failed rename,
//  so the guard re-attempts the roll on the very NEXT write (matching rollIfLarge).
// ════════════════════════════════════════════════════════════════════════════

test('H-BOOT-004: a failed roll rename does not reset the counter — the sink re-rolls on the next write', () => {
  const trace = logsDir('stderr-trace.log');
  fs.mkdirSync(logsDir(), { recursive: true });
  // Seed the on-disk sink OVER the cap so bootflags seeds `written` high at import.
  fs.writeFileSync(trace, Buffer.alloc(SINK_MAX_BYTES + 10));
  try { fs.rmSync(`${trace}.1`); } catch { /* no prior roll */ }

  const origWrite = process.stderr.write.bind(process.stderr);
  const realRename = fs.renameSync;
  let renameCalls = 0;
  // Throw on the FIRST rename (simulate an external lock), delegate to the real
  // rename on the second — the fix must re-attempt on the next write.
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: fs.PathLike, to: fs.PathLike): void => {
    renameCalls += 1;
    if (renameCalls === 1) { const e = new Error('EPERM: locked') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; }
    return realRename(from, to);
  }) as typeof fs.renameSync;

  try {
    // Importing bootflags patches process.stderr.write and seeds `written` from the
    // over-cap on-disk size. Fresh require so the seed reads the file we just wrote.
    delete require.cache[require.resolve('../src/bootflags')];
    require('../src/bootflags');

    // Write 1: over cap → rename attempted, THROWS → counter must stay high, file NOT rolled.
    process.stderr.write('first-write\n');
    assert.equal(renameCalls, 1, 'the first over-cap write attempted the roll');
    assert.equal(fs.existsSync(`${trace}.1`), false, 'the failed rename left no .1 (file not rolled)');
    assert.ok(fs.statSync(trace).size > SINK_MAX_BYTES, 'the sink is still over cap after the failed roll');

    // Write 2: counter still high → rename re-attempted, SUCCEEDS → rolls to .1, resets.
    process.stderr.write('second-write\n');
    assert.equal(renameCalls, 2, 'the very next write re-attempted the roll (not deferred a full cap)');
    assert.equal(fs.existsSync(`${trace}.1`), true, 'the over-cap sink rolled to .1 on the retry');
    assert.ok(fs.statSync(trace).size <= SINK_MAX_BYTES, 'the fresh sink restarted small (no 2× overshoot)');
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    process.stderr.write = origWrite;
    try { fs.rmSync(`${trace}.1`); } catch { /* best-effort cleanup */ }
  }
});
