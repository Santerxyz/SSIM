import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Updater } from '../src/update/Updater';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-001 — the /version manifest was cast straight to VersionInfo with ZERO
//  shape validation, so a hijacked-manifest / MITM attacker could drive an
//  unvalidated `sha256` into a filesystem path (stagedArtifactPath → a ~185 MB
//  write to a `..`-traversed location) and an unvalidated `latest` into the
//  Tauri shell's version eval — BOTH before the sha256/Ed25519 gate can ever
//  fire. parseManifest now validates every KNOWN field before check() proceeds;
//  a malformed manifest is treated identically to a failed check (keep-current,
//  no download, no file write, no emit).
// ════════════════════════════════════════════════════════════════════════════

const SHA = 'a'.repeat(64);
const good = { latest: '1.3.6', sha256: SHA, url: 'https://license.ssim.dev/SSIM.exe', sigKind: 'AAAA' };
const ok = (data: unknown) => async () => ({ status: 200 as const, data });

test('H-LIC-001: a well-formed manifest parses unchanged', () => {
  const info = Updater.parseManifest(good);
  assert.ok(info, 'a conforming manifest must parse');
  assert.equal(info!.latest, '1.3.6');
  assert.equal(info!.sha256, SHA);
  assert.equal(info!.url, 'https://license.ssim.dev/SSIM.exe');
  assert.equal(info!.sigKind, 'AAAA');
});

test('H-LIC-001: uppercase-hex sha256 is normalized to lowercase (folds in H-LIC-003)', () => {
  const info = Updater.parseManifest({ ...good, sha256: 'A'.repeat(64) });
  assert.ok(info);
  assert.equal(info!.sha256, 'a'.repeat(64), 'sha256 must be canonically lowercased at parse time');
});

test('H-LIC-001: a path-traversing sha256 is rejected (never reaches stagedArtifactPath)', () => {
  assert.equal(Updater.parseManifest({ ...good, sha256: '../../../Windows/System32/evil' }), null);
});

test('H-LIC-001: a script-injecting latest is rejected (never reaches the shell eval)', () => {
  assert.equal(Updater.parseManifest({ ...good, latest: "9.9.9');alert(1)//" }), null);
});

test('H-LIC-001: a non-https url is rejected', () => {
  assert.equal(Updater.parseManifest({ ...good, url: 'http://evil/x.exe' }), null);
  assert.equal(Updater.parseManifest({ ...good, url: 'not a url' }), null);
});

test('H-LIC-001: an over-long latest is rejected', () => {
  assert.equal(Updater.parseManifest({ ...good, latest: '9'.repeat(300) }), null);
});

test('H-LIC-001: a manifest with no sigKind is rejected (verify() would refuse it anyway)', () => {
  const { sigKind, ...noSig } = good;
  void sigKind;
  assert.equal(Updater.parseManifest(noSig), null);
});

test('H-LIC-001: a present-but-malformed sig / kind is rejected; a valid legacy sig passes', () => {
  assert.equal(Updater.parseManifest({ ...good, sig: 'not base64url!!' }), null);
  assert.equal(Updater.parseManifest({ ...good, kind: 'rootkit' }), null);
  const info = Updater.parseManifest({ ...good, sig: 'BBBB', kind: 'single-exe' });
  assert.ok(info);
  assert.equal(info!.kind, 'single-exe');
});

test('H-LIC-001: notes is truncated and non-object bodies are rejected', () => {
  const info = Updater.parseManifest({ ...good, notes: 'n'.repeat(9000) });
  assert.ok(info);
  assert.equal(info!.notes!.length, 4096, 'notes must be truncated to 4096 chars');
  assert.equal(Updater.parseManifest(null), null);
  assert.equal(Updater.parseManifest('<html>captive portal</html>'), null);
});

test('H-LIC-001: check() maps a malformed manifest to check-failed (no update, no download)', async () => {
  const r = await Updater.check('1.0.0', ok({ ...good, sha256: '../../x' }));
  assert.equal(r.status, 'check-failed');
  if (r.status === 'check-failed') assert.equal(r.error, 'malformed manifest');
});

test('H-LIC-001: check() still yields update on a well-formed newer manifest', async () => {
  const r = await Updater.check('1.0.0', ok(good));
  assert.equal(r.status, 'update');
});
