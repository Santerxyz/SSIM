import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ════════════════════════════════════════════════════════════════════════════
//  S61 — the update badge installed-and-restarted on a SINGLE unconfirmed click,
//  bypassing the ssimConfirm convention every other install/spend/danger action
//  follows. confirmAndInstallUpdate() now confirms first.
// ════════════════════════════════════════════════════════════════════════════

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

async function run(confirmResult: boolean, installing = false): Promise<{ installed: number; confirmCalled: number }> {
  let installed = 0, confirmCalled = 0;
  const sandbox: any = {
    updateInstalling: installing,
    ssimConfirm: async () => { confirmCalled++; return confirmResult; },
    triggerUpdate: (install: boolean) => { if (install === true) installed++; },
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(APP_JS, 'confirmAndInstallUpdate')}\nthis.confirmAndInstallUpdate = confirmAndInstallUpdate;`, ctx);
  await ctx.confirmAndInstallUpdate();
  return { installed, confirmCalled };
}

test('S61: a CONFIRMED click installs (confirm shown first)', async () => {
  const r = await run(true);
  assert.equal(r.confirmCalled, 1, 'ssimConfirm is shown before installing');
  assert.equal(r.installed, 1, 'a confirmed click proceeds to install + restart');
});

test('S61: a DECLINED (or stray) click never installs + restarts', async () => {
  const r = await run(false);
  assert.equal(r.confirmCalled, 1, 'the confirm was presented');
  assert.equal(r.installed, 0, 'declining does NOT install — no silent restart on a stray click');
});

test('S61: while an install is already running, the click is a no-op (no re-confirm)', async () => {
  const r = await run(true, true);
  assert.equal(r.confirmCalled, 0, 'no confirm while already installing');
  assert.equal(r.installed, 0);
});
