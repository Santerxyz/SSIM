import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsExtra from 'fs-extra';
import { TokenStore } from '../src/core/TokenStore';
import { AccountVault } from '../src/core/AccountVault';

// ════════════════════════════════════════════════════════════════════════════
//  B2 — a PRESENT-but-corrupt refresh_tokens.json must mark the store DEGRADED
//  (refuse writes, keep the file + its .bak untouched) instead of silently
//  resetting to empty and mass-re-authing the fleet. Mirrors the CSFloat
//  delivered-store degraded-mode tests. (Plaintext mode only — vault mode reads
//  from the vault, so AccountVault must be disabled here, which it is by default.)
// ════════════════════════════════════════════════════════════════════════════

const mk = (contents?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-tok-'));
  const p = path.join(dir, 'refresh_tokens.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
};

test('B2: a corrupt (unparseable) file → DEGRADED, not silently reset to empty', () => {
  const p = mk('{ this is not json');
  const s = new TokenStore(p);
  assert.equal(s.isDegraded(), true, 'an unreadable file must degrade, not reset');
});

test('B2: a present-but-wrong-shape file (no tokens object) → DEGRADED', () => {
  const p = mk(JSON.stringify({ version: 1, tokens: 'not-an-object' }));
  assert.equal(new TokenStore(p).isDegraded(), true);
});

test('B2: a MISSING file (fresh install) is NOT degraded', () => {
  const p = mk(undefined); // path exists in a temp dir but the file was never written
  assert.equal(new TokenStore(p).isDegraded(), false);
});

test('B2: a valid file loads its tokens and is not degraded', () => {
  const p = mk(JSON.stringify({ version: 1, tokens: { alice: 'tok-a', bob: 'tok-b' } }));
  const s = new TokenStore(p);
  assert.equal(s.isDegraded(), false);
  assert.equal(s.get('Alice'), 'tok-a', 'lookup is case-insensitive');
  assert.equal(s.has('bob'), true);
});

test('B2: while DEGRADED, a set() does NOT clobber the corrupt file or write a .bak (recovery preserved)', () => {
  const corrupt = '{ half-written tokens file';
  const p = mk(corrupt);
  const s = new TokenStore(p);
  assert.equal(s.isDegraded(), true);
  s.set('carol', 'tok-c'); // must NOT persist
  assert.equal(fs.readFileSync(p, 'utf8'), corrupt, 'the corrupt file is left byte-for-byte untouched');
  assert.equal(fs.existsSync(`${p}.bak`), false, 'no .bak was written (would clobber the last-good backup)');
  // In-memory still works for THIS run so the current session isn’t forced to re-login.
  assert.equal(s.get('carol'), 'tok-c');
});

test('B2: a healthy store persists a token to disk (baseline — degraded is the only no-write path)', () => {
  const p = mk(JSON.stringify({ version: 1, tokens: {} }));
  const s = new TokenStore(p);
  s.set('dave', 'tok-d');
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.tokens.dave, 'tok-d', 'a non-degraded store still persists normally');
});

// ─── S35: three degraded-mode residuals ────────────────────────────────────────
test('S35a: a corrupt main with a VALID .bak recovers from the backup (no degrade) + repairs main', () => {
  const p = mk('{ corrupt main');
  fs.writeFileSync(`${p}.bak`, JSON.stringify({ version: 1, tokens: { alice: 'tok-a', bob: 'tok-b' } }));
  const s = new TokenStore(p);
  assert.equal(s.isDegraded(), false, 'a valid .bak means the store is NOT degraded');
  assert.equal(s.get('alice'), 'tok-a', 'tokens recovered from the backup (no fleet re-auth)');
  // main was repaired from the .bak, and the .bak was NOT clobbered (backup:false — the S5 lesson).
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).tokens, { alice: 'tok-a', bob: 'tok-b' }, 'main repaired');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')).tokens, { alice: 'tok-a', bob: 'tok-b' }, '.bak intact');
});

test('S35a: a corrupt main AND a corrupt .bak → DEGRADED (no valid backup to recover)', () => {
  const p = mk('{ corrupt main');
  fs.writeFileSync(`${p}.bak`, '{ also corrupt');
  assert.equal(new TokenStore(p).isDegraded(), true);
});

// ─── H-ACC-059: a MISSING main with a surviving .bak recovers (not a silent fresh start) ────────
test('H-ACC-059: missing main with a VALID .bak recovers from the backup (no silent fresh start)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-tok-'));
  const p = path.join(dir, 'refresh_tokens.json'); // main NEVER written → missing
  const bak = `${p}.bak`;
  fs.writeFileSync(bak, JSON.stringify({ version: 1, tokens: { alice: 'tok-a' } }));
  const bakBytesBefore = fs.readFileSync(bak, 'utf8');
  const s = new TokenStore(p);
  assert.equal(s.isDegraded(), false, 'a valid .bak means the store is NOT degraded');
  assert.equal(s.get('alice'), 'tok-a', 'tokens recovered from the backup (no fleet re-auth)');
  assert.equal(fs.existsSync(p), true, 'the main file was repaired on disk');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).tokens, { alice: 'tok-a' }, 'main repaired from .bak');
  assert.equal(fs.readFileSync(bak, 'utf8'), bakBytesBefore, '.bak left byte-identical (backup:false — S5 lesson)');
});

test('H-ACC-059: missing main with a corrupt .bak → DEGRADED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-tok-'));
  const p = path.join(dir, 'refresh_tokens.json'); // main NEVER written → missing
  fs.writeFileSync(`${p}.bak`, '{ corrupt bak');
  assert.equal(new TokenStore(p).isDegraded(), true, 'no valid backup to recover → degrade, do not fresh-start');
});

test('S24: a throwing vault setToken does NOT escape TokenStore.set (no uncaughtException burst)', () => {
  const s = new TokenStore(mk(undefined)); // fresh install → not degraded
  const origEnabled = AccountVault.isEnabled;
  const origSet = AccountVault.setToken;
  try {
    (AccountVault as unknown as { isEnabled: () => boolean }).isEnabled = () => true;                 // vault mode
    (AccountVault as unknown as { setToken: () => void }).setToken = () => { throw new Error('EACCES: disk locked'); };
    // In the OLD code this threw INSIDE steam-user's refreshToken emit → a global uncaughtException →
    // ProcessHealth.recordUncaught → the money breaker latched after a burst during a mass first-login.
    assert.doesNotThrow(() => s.set('bot1', 'tok-x'), 'a vault persist failure degrades to warn, never throws');
  } finally {
    (AccountVault as unknown as { isEnabled: typeof origEnabled }).isEnabled = origEnabled;
    (AccountVault as unknown as { setToken: typeof origSet }).setToken = origSet;
  }
});

test('S35b: in VAULT MODE a corrupt leftover plaintext file does NOT raise a false DEGRADED alarm', () => {
  const p = mk('{ corrupt and no bak');
  const s = new TokenStore(p); // degraded internally (no .bak to recover)
  const orig = AccountVault.isEnabled;
  try {
    (AccountVault as unknown as { isEnabled: () => boolean }).isEnabled = () => true; // simulate vault mode
    assert.equal(s.isDegraded(), false, 'vault mode masks the plaintext-file degraded flag');
  } finally {
    (AccountVault as unknown as { isEnabled: () => boolean }).isEnabled = orig;
  }
  assert.equal(s.isDegraded(), true, 'and it is reported again once back in plaintext mode');
});

// ─── H-ACC-055: transient FS locks at load are NOT corruption ───────────────────
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

test('H-ACC-055: a transient EBUSY lock (twice then success) loads the tokens — NOT degraded', () => {
  const good = { version: 1, tokens: { alice: 'tok-a' } };
  const p = mk(JSON.stringify(good)); // file is genuinely intact on disk
  const orig = fsExtra.readJsonSync;
  let calls = 0;
  try {
    (fsExtra as unknown as { readJsonSync: (fp: string) => unknown }).readJsonSync = (_fp: string) => {
      calls++;
      if (calls <= 2) throw errno('EBUSY'); // AV scanner holding the file for the first two attempts
      return good;
    };
    const s = new TokenStore(p);
    assert.equal(s.isDegraded(), false, 'a transient lock that clears must NOT degrade a healthy file');
    assert.equal(s.get('alice'), 'tok-a', 'tokens are loaded after the retry succeeds');
    assert.equal(calls >= 3, true, 'the read was retried past the transient failures');
  } finally {
    (fsExtra as unknown as { readJsonSync: typeof orig }).readJsonSync = orig;
  }
});

test('H-ACC-055: an ENOENT from the existsSync→read TOCTOU window loads fresh (empty, NOT degraded)', () => {
  const p = mk(JSON.stringify({ version: 1, tokens: { alice: 'tok-a' } })); // existsSync sees it…
  const orig = fsExtra.readJsonSync;
  try {
    (fsExtra as unknown as { readJsonSync: () => unknown }).readJsonSync = () => { throw errno('ENOENT'); }; // …but it vanished before the read
    const s = new TokenStore(p);
    assert.equal(s.isDegraded(), false, 'a vanished file is a fresh install, not corruption');
    assert.equal(s.get('alice'), undefined, 'the store is empty (fresh), not populated');
  } finally {
    (fsExtra as unknown as { readJsonSync: typeof orig }).readJsonSync = orig;
  }
});

test('S36: a fresh-install store must NOT leak tokens into a later instance (no shared EMPTY alias)', () => {
  assert.equal(AccountVault.isEnabled(), false, 'this test is plaintext-mode');
  // Instance A is a fresh install (missing file). In the buggy `{ ...EMPTY }` code its in-memory tokens
  // map WAS the shared module singleton `EMPTY.tokens`, so this set() poisoned it process-wide.
  const a = new TokenStore(mk(undefined));
  a.set('alice', 'refresh-token-A');
  assert.equal(a.get('alice'), 'refresh-token-A', 'A remembers its own token');
  // Instance B is ALSO a fresh install, on a DIFFERENT path. It must start genuinely empty.
  const b = new TokenStore(mk(undefined));
  assert.equal(b.get('alice'), undefined, "B must not inherit A's token via a shared EMPTY.tokens object");
  assert.equal(b.has('alice'), false, 'a fresh store is empty regardless of what other instances did');
});
