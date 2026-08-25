#!/usr/bin/env node
/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════════════════
//  build/verify-release.js — "would the fleet actually update?"
//
//  WHY THIS EXISTS. On 2026-08-25 a customer reported having to update by hand.
//  Nothing was wrong with the updater: v1.5.2 shipped as a GitHub release, but
//  RELEASING.md step 5 (commit version.json to main) was skipped, so the live
//  manifest still advertised 1.5.1 — and pointed at a v1.5.1 release tag that
//  never existed. Every client was therefore either told it was up to date
//  (on 1.5.1) or handed a 404 download (on 1.5.0). Silently, for four days.
//
//  Every gate in that failure is checkable from outside, with no private key, so
//  this runs the WHOLE client-side decision against the LIVE published state and
//  says plainly whether a given customer would update. Run it after publishing —
//  it is the last step of a release, and the one that catches a skipped step.
//
//  It deliberately imports the CLIENT's own parseManifest / isNewer out of dist/
//  rather than reimplementing them: a reimplementation could agree with itself
//  while disagreeing with the fleet, which is the one bug this must never have.
//
//  USAGE
//    npm run verify-release                 # check the live manifest vs package.json
//    npm run verify-release -- --expect 1.5.3
//    npm run verify-release -- --from 1.5.0,1.5.1,1.5.2   # who would update?
//    npm run verify-release -- --quick      # skip the (145 MB) asset download
//    npm run verify-release -- --manifest <url> | --file version.json
//
//  Exit code 0 = the fleet updates. Non-zero = it does not, and the reason is printed.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes('--' + n);

const problems = [];
const fail = (msg, detail) => { problems.push({ msg, detail }); console.error(`✗ ${msg}${detail ? `\n    ${detail}` : ''}`); };
const ok = (msg) => console.error(`✓ ${msg}`);
const info = (msg) => console.error(`  ${msg}`);

// ── The client's OWN logic, not a copy of it ────────────────────────────────
let clientCfg, clientUpdater;
try {
  clientCfg = require(path.resolve(__dirname, '..', 'dist', 'update', 'config.js'));
  clientUpdater = require(path.resolve(__dirname, '..', 'dist', 'update', 'Updater.js'));
} catch (e) {
  console.error('✗ cannot load dist/update/* — run `npm run build` first.\n    ' + e.message);
  process.exit(2);
}
const { parseManifest, isNewer } = clientUpdater;
if (typeof parseManifest !== 'function' || typeof isNewer !== 'function') {
  console.error('✗ dist/update/Updater.js no longer exports parseManifest/isNewer — this checker is stale, fix it before trusting a release.');
  process.exit(2);
}

const pkg = require(path.resolve(__dirname, '..', 'package.json'));
const expected = arg('expect') || pkg.version;
const manifestUrl = arg('manifest') || clientCfg.UPDATE_MANIFEST_URL;
const fromVersions = (arg('from') || '').split(',').map((s) => s.trim()).filter(Boolean);

/** GET following redirects (release assets redirect to objects.githubusercontent.com). */
function get(url, { method = 'GET', redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'User-Agent': 'ssim-verify-release' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, { method, redirects: redirects - 1 }));
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res, url });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
const readAll = (res) => new Promise((resolve, reject) => {
  let b = ''; res.stream.setEncoding('utf8');
  res.stream.on('data', (c) => { b += c; }); res.stream.on('end', () => resolve(b)); res.stream.on('error', reject);
});
const hashStream = (res) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  let bytes = 0;
  res.stream.on('data', (c) => { bytes += c.length; h.update(c); });
  res.stream.on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
  res.stream.on('error', reject);
  // A truncated response that ENDS cleanly would otherwise hash short and be reported as a
  // content mismatch, which would send someone hunting a signing bug that does not exist.
  res.stream.on('aborted', () => reject(new Error('connection aborted mid-download')));
});

/**
 * Hash the asset, retrying a dropped connection. A 145 MB download over a flaky link fails often
 * enough that a single attempt makes this gate unreliable — and an unreliable gate gets skipped,
 * which is exactly how the 1.5.1/1.5.2 manifests shipped unchecked. Distinguishes "could not
 * finish downloading" (inconclusive, retry) from "hash differs" (a real, reportable failure).
 */
async function hashAssetWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await get(url);
      if (res.status !== 200) return { error: `HTTP ${res.status}` };
      return await hashStream(res);
    } catch (e) {
      lastErr = e;
      if (i < attempts) info(`download attempt ${i} failed (${e.message}) — retrying`);
    }
  }
  return { error: lastErr ? lastErr.message : 'download failed' };
}

(async () => {
  console.error(`\nSSIM release check — expecting v${expected}`);
  console.error(`manifest: ${arg('file') ? arg('file') : manifestUrl}\n`);

  // ── 1. Fetch the manifest the FLEET reads ────────────────────────────────
  let raw;
  if (arg('file')) {
    raw = fs.readFileSync(arg('file'), 'utf8');
    ok(`read local manifest ${arg('file')}`);
  } else {
    let res;
    try { res = await get(manifestUrl); }
    catch (e) { fail('cannot reach the manifest URL', e.message); return finish(); }
    if (res.status !== 200) {
      fail(`manifest URL returned HTTP ${res.status}`,
        'Every client treats this as check-failed and stays on its current version. If the repo is private, raw.githubusercontent.com 404s for everyone.');
      return finish();
    }
    raw = await readAll(res);
    ok('manifest fetched (HTTP 200)');
  }

  let json;
  try { json = JSON.parse(raw); } catch (e) { fail('manifest is not valid JSON', e.message); return finish(); }

  // ── 2. Shape-validate with the CLIENT's parser ───────────────────────────
  const parsed = parseManifest(json);
  if (!parsed) {
    fail('the client REJECTS this manifest as malformed',
      'parseManifest() returned null, so every client logs "malformed manifest" and never updates. Fields: ' + Object.keys(json).join(', '));
    return finish();
  }
  ok(`manifest parses (latest=${parsed.latest}, kind=${parsed.kind ?? 'backend (default)'})`);

  // ── 3. THE step that was skipped: does it advertise what we shipped? ─────
  if (parsed.latest !== expected) {
    if (isNewer(expected, parsed.latest)) {
      fail(`the manifest advertises v${parsed.latest} but this repo is at v${expected}`,
        `Every client on v${parsed.latest} is told it is UP TO DATE and will never see v${expected}. `
        + 'This is RELEASING.md step 5 (commit version.json to main) not being done.');
    } else {
      fail(`the manifest advertises v${parsed.latest}, which is NEWER than this repo's v${expected}`,
        'You are probably on an old branch, or the manifest was published from a later release.');
    }
  } else {
    ok(`manifest advertises v${parsed.latest}, matching package.json`);
  }

  // ── 4. Is the artifact actually there? ───────────────────────────────────
  // NOTE: an unreachable asset must NOT short-circuit the report. The per-version verdict in
  // step 7 is the headline answer ("would my customer update?"), and it is most needed exactly
  // when something upstream is broken. So this block records failures and falls through.
  info(`asset: ${parsed.url}`);
  let assetRes = null;
  try { assetRes = await get(parsed.url); }
  catch (e) { fail('the download URL is unreachable', e.message); }

  if (assetRes && assetRes.status !== 200) {
    fail(`the download URL returns HTTP ${assetRes.status}`,
      'Any client that sees this update downloads nothing and fails, every boot, forever. '
      + 'Usually means the release tag in the URL does not exist or the asset was never uploaded.');
    assetRes.stream.resume();
    assetRes = null;
  } else if (assetRes) {
    ok(`asset reachable (HTTP 200${assetRes.headers['content-length'] ? `, ${(Number(assetRes.headers['content-length']) / 1048576).toFixed(1)} MB` : ''})`);
  }

  // ── 5. Does the artifact match the hash the manifest swears to? ──────────
  if (assetRes) { assetRes.stream.resume(); }   // the reachability probe's body is not the one we hash
  if (!assetRes) {
    info('skipping the sha256 check — no asset to hash');
  } else if (has('quick')) {
    info('skipped the sha256 check (--quick) — the fleet does NOT skip it');
  } else if (arg('asset')) {
    // Hash a local copy instead of re-downloading. Legitimate when that copy IS the published
    // asset and you have already proved it (e.g. `sha256sum -c` against the release's own
    // SHA256SUMS): re-pulling 145 MB over a flaky link proves nothing extra and, as seen on
    // 1.5.3, can fail three times in a row. It does NOT prove the bytes are what GitHub serves —
    // only that this file matches the manifest — so verify the copy's provenance first.
    const p = arg('asset');
    if (!fs.existsSync(p)) { fail(`--asset not found: ${p}`); }
    else {
      const h = crypto.createHash('sha256');
      h.update(fs.readFileSync(p));
      const local = h.digest('hex');
      if (local !== parsed.sha256.toLowerCase()) {
        fail('the local --asset does NOT match the manifest sha256',
          `manifest ${parsed.sha256}\n    actual   ${local}`);
      } else {
        ok(`--asset sha256 matches the manifest (${path.basename(p)}, provenance is YOUR responsibility)`);
      }
    }
  } else {
    const r = await hashAssetWithRetry(parsed.url);
    if (r.error) {
      fail('could not download the asset to verify its sha256', `${r.error}. This is inconclusive, not a pass — re-run before publishing.`);
    } else if (r.sha256 !== parsed.sha256.toLowerCase()) {
      fail('the published asset does NOT match the manifest sha256',
        `manifest ${parsed.sha256}\n    actual   ${r.sha256}\n    Every client downloads it, fails the integrity gate and discards it.`);
    } else {
      ok(`asset sha256 matches (${(r.bytes / 1048576).toFixed(1)} MB verified)`);
    }
  }

  // ── 6. Would the baked key accept it? ────────────────────────────────────
  const pubPem = String(clientCfg.UPDATE_PUBLIC_KEY || '').trim();
  if (!pubPem) {
    fail('dist/update/config.js has no UPDATE_PUBLIC_KEY — cannot verify the signature');
  } else if (!parsed.sigKind) {
    fail('the manifest has no sigKind', 'Kind-aware clients REFUSE an update without the kind-inclusive signature.');
  } else {
    const payload = `${parsed.latest}:${parsed.sha256}:${parsed.kind ?? 'backend'}`;
    let good = false;
    try {
      good = crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(pubPem), Buffer.from(parsed.sigKind, 'base64url'));
    } catch (e) { fail('signature check threw', e.message); }
    if (good) ok('sigKind verifies under the public key baked into this build');
    else fail('sigKind does NOT verify under the baked public key',
      `signed payload was "${payload}". The fleet would refuse this update. Wrong private key, or the manifest was edited after signing.`);
  }

  // ── 7. The bottom line, per customer ─────────────────────────────────────
  // `assetOk` matters here: a client that decides to update but cannot fetch the artifact is not
  // "updating", it is failing on a loop. Reporting that as "→ updates" would hide the worse bug.
  const assetOk = !!assetRes || (assetRes === null && problems.every((p) => !/download URL/.test(p.msg)));
  const cohort = fromVersions.length ? fromVersions : guessCohort(parsed.latest, expected);
  console.error('\nWould a client update?');
  for (const v of cohort) {
    const wants = isNewer(parsed.latest, v);
    const verdict = !wants ? '→ STAYS PUT (told it is up to date)'
      : assetOk ? '→ updates'
      : '→ TRIES AND FAILS (manifest is newer, but the download 404s)';
    console.error(`  on v${v.padEnd(8)} ${verdict}`);
    if (!wants && isNewer(expected, v)) {
      fail(`a client on v${v} will NOT auto-update even though v${expected} exists`,
        'It is stranded until the manifest advertises a newer version.');
    }
  }
  finish();
})().catch((e) => { console.error('✗ verify-release crashed: ' + (e && e.stack || e)); process.exit(2); });

/** Prior versions worth reporting on when the caller named none. */
function guessCohort(latest, expected) {
  const out = new Set([latest]);
  const [maj, min, pat] = expected.split('.').map(Number);
  for (let p = Math.max(0, pat - 2); p < pat; p++) out.add(`${maj}.${min}.${p}`);
  return [...out].filter((v) => v !== expected).sort();
}

function finish() {
  if (problems.length === 0) {
    console.error('\n✓ RELEASE OK — the fleet will pick this up.\n');
    process.exit(0);
  }
  console.error(`\n✗ ${problems.length} problem(s) — the fleet will NOT update correctly.\n`);
  process.exit(1);
}
