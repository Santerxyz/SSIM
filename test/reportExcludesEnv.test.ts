import { test } from 'node:test';
import assert from 'node:assert/strict';

// ════════════════════════════════════════════════════════════════════════════
//  H-XCT-008 — Node's diagnostic report (reportOnFatalError, armed in bootflags)
//  serializes the process env block. A fatal in the pre-unlock boot window would
//  otherwise capture SSIM_VAULT_PASSWORD in cleartext in logs/report.*.json.
//  bootflags now sets process.report.excludeEnv = true so the env block is omitted
//  from every report while the forensic payload (stacks + libuv handles) stays on.
// ════════════════════════════════════════════════════════════════════════════

test('H-XCT-008: bootflags arms the report with the env block excluded', () => {
  // Fresh require so the import side-effect runs against this process.report.
  delete require.cache[require.resolve('../src/bootflags')];
  require('../src/bootflags');

  const report = (process as unknown as {
    report?: { reportOnFatalError: boolean; excludeEnv: boolean };
  }).report;
  assert.ok(report, 'process.report is available on the bundled runtime');
  assert.equal(report!.excludeEnv, true, 'the env block is excluded from the diagnostic report');
  // The report itself must keep firing — excludeEnv strips only env, not the payload.
  assert.equal(report!.reportOnFatalError, true, 'reportOnFatalError stays armed for the 0xC0000409 investigation');
});
