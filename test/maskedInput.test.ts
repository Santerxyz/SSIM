import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { maskedQuestion } from '../src/core/vaultBoot';

// H-ACC-023: maskedQuestion must SWALLOW VT escape sequences (cursor / function keys) rather
// than appending their ANSI body to the password and echoing a star per byte. A single ↑ press
// (ESC [ A) previously injected the two chars "[A" behind two stars, silently corrupting the
// typed password — a lockout on the unlock path, an unopenable vault on the set path.
//
// The prompt string is written to stdout too, so we count only the '*' echoes.
function starCount(chunks: string[]): number {
  return chunks.join('').split('').filter((c) => c === '*').length;
}

// A capturing stdout: records every write; satisfies the WriteStream surface maskedQuestion uses.
function captureStdout(): { stream: PassThrough; writes: string[] } {
  const stream = new PassThrough();
  const writes: string[] = [];
  stream.on('data', (b: Buffer) => writes.push(b.toString('utf8')));
  return { stream, writes };
}

test('H-ACC-023: an inline arrow-key sequence is swallowed — password + star count are clean', async () => {
  const stdin = new PassThrough();
  const { stream: stdout, writes } = captureStdout();
  const p = maskedQuestion('pw: ', stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream);
  stdin.write('ab');      // two printable chars
  stdin.write('\x1b[A');  // ↑  = ESC [ A  → must be swallowed whole
  stdin.write('c\r');     // one more char, then Enter submits
  const result = await p;
  assert.equal(result, 'abc', 'the arrow sequence must not appear in the password');
  assert.equal(starCount(writes), 3, 'exactly three stars — one per real character, none for the escape');
});

test('H-ACC-023: an escape sequence split across two data chunks is still fully swallowed', async () => {
  const stdin = new PassThrough();
  const { stream: stdout, writes } = captureStdout();
  const p = maskedQuestion('pw: ', stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream);
  stdin.write('x');       // one real char
  stdin.write('\x1b');    // lone ESC — the CSI lead arrives in the NEXT chunk
  stdin.write('[3~');     // Delete body — state must survive the chunk boundary
  stdin.write('y\r');     // another char, then Enter
  const result = await p;
  assert.equal(result, 'xy', 'the split Delete sequence must not leak into the password');
  assert.equal(starCount(writes), 2, 'only the two real characters echo a star');
});

test('H-ACC-023: a bare ESC followed by a non-CSI key swallows exactly one byte', async () => {
  const stdin = new PassThrough();
  const { stream: stdout, writes } = captureStdout();
  const p = maskedQuestion('pw: ', stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream);
  stdin.write('a');       // real char
  stdin.write('\x1bZ');   // ESC then a bare (non-[/O) key → both swallowed, no CSI run
  stdin.write('b\r');     // real char, then Enter
  const result = await p;
  assert.equal(result, 'ab', 'the ESC and the single following key are both dropped');
  assert.equal(starCount(writes), 2);
});
