import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { resolveMaFilePath } from '../src/core/maFiles';
import { maFilesDir } from '../src/utils/paths';

// ─── B23: maFile path containment ──────────────────────────────────────────────
// A client-supplied maFilePath must never resolve outside the mafiles/ drop zone
// (absolute paths, ../ traversal) — that would let a caller probe/import arbitrary
// files. Every reference resolves to mafiles/<basename>.

const DIR = path.resolve(maFilesDir());

function assertContained(input: string): void {
  const out = path.resolve(resolveMaFilePath(input));
  assert.ok(
    out === DIR || out.startsWith(DIR + path.sep),
    `${JSON.stringify(input)} resolved to ${out}, which escapes ${DIR}`,
  );
}

test('a bare filename resolves inside the drop zone', () => {
  assert.equal(resolveMaFilePath('bot1.maFile'), path.join(DIR, 'bot1.maFile'));
});

test('absolute paths are contained to the drop zone (basename only)', () => {
  assertContained('C:/Windows/win.ini');
  assertContained('C:\\Windows\\System32\\config\\SAM');
  assertContained('/etc/passwd');
  assert.equal(resolveMaFilePath('C:/Windows/win.ini'), path.join(DIR, 'win.ini'));
});

test('../ traversal is defeated', () => {
  assertContained('../../../etc/passwd');
  assertContained('..\\..\\..\\secret.json');
  assertContained('subdir/../../escape.json');
});

test('empty / weird input never escapes', () => {
  assertContained('');
  assertContained('.');
  assertContained('..');
});
