import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import fsExtra from 'fs-extra';
import axios from 'axios';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { UPDATE_MANIFEST_URL, UPDATE_PUBLIC_KEY, UPDATE_HTTP_TIMEOUT_MS } from './config';
import { IS_SIDECAR_MODE, dataDir } from '../utils/paths';
import {
  setUpdateOutcome, setBlockedUpdate, setAvailableUpdate, markChecked,
  type UpdateOutcome,
} from './updateStatus';

// ════════════════════════════════════════════════════════════════════════════
//  Updater — signed, self-replacing auto-update for the single self-contained SSIM.exe.
//
//  SSIM now ships as one binary: the Tauri shell with the Node backend embedded inside it. The
//  backend (this code) runs as the shell's child; the shell passes its own path as SSIM_SHELL_EXE.
//  So an update is a ONE-FILE swap: download the new SSIM.exe → verify (sha256 + Ed25519) → prove it
//  boots (anti-brick self-test) → swap SSIM_SHELL_EXE → relaunch it. The new shell re-extracts its
//  (new) embedded backend on next launch.
//
//  Flow:  GET /version → download to the app DATA dir (not %TEMP%) → verify sha256 + Ed25519 sig over
//         `${latest}:${sha256}` → self-test the new exe → write updater.bat → spawn detached → emit
//         SSIM_UPDATING → exit
//         → bat waits for backend + shell to die, swaps SSIM.exe, relaunches it, self-cleans.
//
//  A running .exe can't overwrite itself on Windows, so the swap is delegated to a tiny detached
//  batch launched via a hidden VBScript (so it survives our exit). The Ed25519 signature is what makes
//  this safe: a hijacked update URL can't ship a payload we'll execute, because it can't sign it.
//
//  DUAL-MODE (this client runs in both the still-deployed two-file fleet and the single-exe build):
//  the verify + self-test gates are identical; only the final swap shape differs, chosen at runtime:
//    • SINGLE-EXE  (SSIM_SHELL_EXE set)  → replace + relaunch the consolidated SSIM.exe.
//    • TWO-FILE    (sidecar, no SSIM_SHELL_EXE) → swap ssim-backend.exe in place; relaunch the existing
//      shell, which respawns the new sidecar. This keeps the deployed 1.2.x fleet auto-updatable.
//    • MIGRATION   (manifest kind:'single-exe' on a two-file install) → the artifact is the consolidated
//      SSIM.exe: replace the OLD shell (folder SSIM.exe) with it and delete the orphaned ssim-backend.exe,
//      then relaunch — a seamless two-file→single-exe cutover with no folder reinstall.
//    • STANDALONE  (headless ssim.exe) → swap + relaunch our own exe.
//  Every shape still passes the same sha256 + Ed25519 + boot self-test before anything touches disk.
// ════════════════════════════════════════════════════════════════════════════

interface VersionInfo {
  latest: string;   // semver
  url:    string;   // download URL of the artifact (consolidated SSIM.exe, or two-file ssim-backend.exe)
  sha256: string;   // hex digest of that file
  sig:    string;   // base64url Ed25519 over `${latest}:${sha256}` — LEGACY (kind-less). Still emitted by
                    // the server for the deployed fleet; this client verifies `sigKind` instead.
  /**
   * base64url Ed25519 over `${latest}:${sha256}:${kind ?? 'backend'}` — the KIND-INCLUSIVE signature.
   * This client verifies this, so a tampered `kind` (the swap-shape selector) is rejected, not just the
   * artifact bytes. (C14 integrity fix.) Required: an update without it is refused.
   */
  sigKind?: string;
  // OPTIONAL, server-set. 'single-exe' marks a TWO-FILE→single-exe MIGRATION cut (replace the SHELL +
  // delete ssim-backend.exe). Absent / 'backend' → normal in-place swap. NOW COVERED by `sigKind`, so it
  // can no longer be forged to force the destructive migration shape on a victim.
  kind?:  'single-exe' | 'backend';
  // OPTIONAL, server-set DISPLAY metadata (not signed). Present since the Discord-announce feature:
  // `notes` = this release's changelog text, `publishedAt` = ISO publish time. The update/verify path
  // ignores both; surfaced only for a possible future in-app changelog. Extra fields are tolerated,
  // so their presence never affects signature verification or the swap.
  notes?: string;
  publishedAt?: string;
}

const http = axios.create({ timeout: UPDATE_HTTP_TIMEOUT_MS, validateStatus: () => true });

/**
 * Emit a machine-readable update marker on stdout so the Tauri shell can reflect the live phase
 * (download %, verifying, installing) on the boot splash instead of a frozen spinner. No-op outside
 * sidecar mode — a console/dev run shows the human banner instead. The shell parses these per-line
 * (see src-tauri/src/lib.rs); keep the token spellings in sync with it.
 */
function emitUpdate(line: string): void {
  try { if (IS_SIDECAR_MODE) process.stdout.write(`${line}\n`); } catch { /* stdout may be closed */ }
}

/** Prominent console notice so the operator SEES that an update is happening. */
function printUpdateBanner(from: string, to: string): void {
  const V = '\x1b[35m', B = '\x1b[1m', R = '\x1b[0m', D = '\x1b[2m';
  const line = '─'.repeat(48);
  // eslint-disable-next-line no-console
  console.log(
    `\n  ${V}${B}◆ SSIM Update${R}\n` +
    `  ${D}${line}${R}\n` +
    `   ${B}New version available${R}   ${D}v${from}${R} → ${V}${B}v${to}${R}\n` +
    `   ${D}downloading and installing – SSIM will restart shortly…${R}\n` +
    `  ${D}${line}${R}\n`,
  );
}

/** semver-ish compare → true if `remote` is strictly newer than `local`. Compares every dotted segment
 *  (not a fixed 3), so a longer build tag like `1.3.5.1` is honoured. Exported for tests. */
export function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number), l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Validate the untrusted `/version` body into a VersionInfo, or `null` if it is malformed. This runs
 * before isNewer / download / verify, so a hijacked-manifest / MITM attacker (the exact adversary the
 * header threat model names) can never drive an unvalidated field into a filesystem path (`sha256` →
 * stagedArtifactPath) or the shell's version eval (`latest` → SSIM_UPDATE_DOWNLOADING → lib.rs w.eval)
 * before the sha256/Ed25519 gate — signature verification happens too late to guard those sinks.
 * Forward-compat: unknown extra fields are tolerated (matching the VersionInfo comment); only the
 * KNOWN fields are shape-checked. `sha256` is normalized to lowercase here so the whole file carries a
 * single canonical representation (folds in the case-inconsistency H-LIC-003 guards against).
 */
export function parseManifest(raw: unknown): VersionInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const b64url = (v: unknown): v is string => typeof v === 'string' && v.length <= 512 && /^[A-Za-z0-9_-]+$/.test(v);
  if (typeof m.latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.latest)) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return null;
  if (typeof m.url !== 'string') return null;
  try { if (new URL(m.url).protocol !== 'https:') return null; } catch { return null; }
  if (!b64url(m.sigKind)) return null;               // verify() already refuses a sig-less manifest — fail faster here
  if (m.sig !== undefined && !b64url(m.sig)) return null;   // LEGACY field, still emitted — validate-if-present
  if (m.kind !== undefined && m.kind !== 'single-exe' && m.kind !== 'backend') return null;
  if (m.notes !== undefined && typeof m.notes !== 'string') return null;
  if (m.publishedAt !== undefined && (typeof m.publishedAt !== 'string' || m.publishedAt.length > 64)) return null;
  const info: VersionInfo = {
    latest: m.latest,
    url: m.url,
    sha256: m.sha256.toLowerCase(),                  // canonical lowercase (path-safe + case-consistent)
    sig: typeof m.sig === 'string' ? m.sig : '',
    sigKind: m.sigKind as string,
  };
  if (m.kind !== undefined) info.kind = m.kind as 'single-exe' | 'backend';
  if (typeof m.notes === 'string') info.notes = m.notes.slice(0, 4096);
  if (typeof m.publishedAt === 'string') info.publishedAt = m.publishedAt;
  return info;
}

/** The three outcomes of a version check, kept DISTINCT so the caller never mistakes a failed check for
 * "up to date" — 'current' and 'check-failed' both used to collapse to a bare `null`. */
type CheckResult =
  | { status: 'update'; info: VersionInfo }
  | { status: 'current' }
  | { status: 'check-failed'; error: string };

/** 1. Ask the backend what the latest published version is. `get` is injectable for tests (matches the
 *  file's selfTestNewExe/buildSwapScript convention). */
async function check(
  currentVersion: string,
  get: (url: string) => Promise<{ status: number; data: unknown }> = (url) => http.get(url),
): Promise<CheckResult> {
  try {
    const res = await get(UPDATE_MANIFEST_URL);
    if (res.status !== 200) return { status: 'check-failed', error: `HTTP ${res.status}` };
    const info = parseManifest(res.data);
    if (!info) return { status: 'check-failed', error: 'malformed manifest' };
    return isNewer(info.latest, currentVersion) ? { status: 'update', info } : { status: 'current' };
  } catch (err) {
    logger.warn(`update check failed: ${(err as Error).message}`);
    return { status: 'check-failed', error: (err as Error).message };
  }
}

/**
 * Stream `src` to `dest`, resolving ONLY after the file descriptor is fsync'd and CLOSED.
 *
 * the FIX (Windows EACCES on self-test): the previous code resolved on the writable stream's `finish`
 * event, which fires when the bytes have been handed to the OS but before the fd is closed (Node closes
 * it asynchronously via autoClose, emitting `close` afterwards). Because runUpdate() runs
 * download→verify→self-test synchronously within one event-loop turn (microtasks), the libuv fd-close
 * macrotask had not yet run — so we still held an OPEN WRITABLE HANDLE to the .exe when execFileSync
 * asked Windows to CreateProcess it. Windows can't load an image that another handle still has open for
 * write → ERROR_ACCESS_DENIED / sharing violation → `spawnSync … EACCES`. (Reads still worked, so
 * verify()'s sha256 passed, because libuv opens the write stream with FILE_SHARE_READ — execution does
 * not share with a writer.) Resolving on `close` (after an fsync for durability) guarantees the handle
 * is released and the bytes are on disk before anyone executes the file.
 *
 * KEEPS whatever is already on disk on error (the download loop resumes from the partial). Exported for
 * tests.
 */
export function pipeToFile(
  src: NodeJS.ReadableStream,
  dest: string,
  opts: { append: boolean; stallMs: number; onData?: (hopBytes: number) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: opts.append ? 'a' : 'w' });
    let fd: number | undefined;
    let idle: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      if (err) {
        // Tear down both streams but KEEP whatever is on disk — the next attempt resumes from it.
        try { out.destroy(); } catch { /* noop */ }
        try { (src as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
        reject(err);
      } else {
        resolve();
      }
    };
    const arm = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => settle(new Error('stalled — no data')), opts.stallMs);
      opts.onData?.(out.bytesWritten); // bytesWritten is this-hop only; the caller adds the resume offset
    };
    out.on('open', (f: number) => { fd = f; });
    src.on('data', arm);
    src.on('error', settle);
    out.on('error', settle);
    // Durability: force the bytes to disk while the fd is still open…
    out.on('finish', () => {
      if (idle) clearTimeout(idle);
      try { if (fd !== undefined) fs.fsyncSync(fd); } catch { /* fd may already be gone — best-effort */ }
    });
    // …and resolve ONLY once the fd is CLOSED (handle released) — the crux of the EACCES fix.
    out.on('close', () => settle());
    src.pipe(out);
    arm(); // arm the stall timer immediately so a socket that never sends a byte still aborts
  });
}

/**
 * Where we stage the downloaded exe for the self-test + swap. We DELIBERATELY use the app's own data
 * dir (next to the install / SSIM_HOME) instead of %LOCALAPPDATA%\Temp:
 *   • %TEMP% is the location most commonly blocked for EXECUTION by AppLocker / SRP / the Defender
 *     Attachment Manager on managed machines → CreateProcess of the self-test exe returns
 *     ERROR_ACCESS_DENIED (EACCES). The app's data dir is already trusted + writable by the running
 *     app, so executing the staged exe from there is not blocked by those %TEMP%-scoped rules.
 *   • it sits on the same volume as the install target, so the swap's `move /Y` is an atomic rename
 *     rather than a cross-volume copy (faster, and far less exposed to an AV scan mid-copy).
 * Falls back to os.tmpdir() only if the data dir can't be created (a broken SSIM_HOME), preserving the
 * previous behaviour rather than dead-ending the update.
 */
function updatesStageDir(): string {
  try {
    const d = dataDir('updates');
    fs.mkdirSync(d, { recursive: true });
    return d;
  } catch {
    return os.tmpdir();
  }
}

/**
 * The DETERMINISTIC staged path for an artifact of this sha256: `ssim_update_<sha256>.exe`. Keying the
 * staged file by its content hash is the crux of C1 — it lets (a) a partial download RESUME across
 * boots, and (b) a verified-complete artifact be REUSED next boot instead of re-downloading ~185 MB
 * after a self-test kept the current version. (update-reliability finding 6.4.)
 */
export function stagedArtifactPath(dir: string, sha256: string): string {
  return path.join(dir, `ssim_update_${sha256.toLowerCase()}.exe`);
}

/** sha256 (hex, lowercase) of a file on disk, or '' if it can't be read. S8: STREAMS the file so a
 *  ~185 MB artifact is not slurped into memory with a synchronous readFileSync — which stalled the event
 *  loop (and dropped the resident fleet) when this runs in a live, session-carrying process. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('data', (chunk) => h.update(chunk));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', () => resolve('')); // unreadable → '' (never a false match), matching the old catch→''
    } catch { resolve(''); }
  });
}

/**
 * Best-effort sweep of staged artifacts from other (superseded) offers so data\updates never
 * accumulates multiple ~185 MB files. Keeps ONLY the artifact for the CURRENT offer's sha256. Because
 * the filename ENCODES the sha, this is a cheap name comparison — the stale files are never re-hashed.
 * The selftest-state.json sidecar (a .json, not .exe) is untouched. (C1: "sweep only artifacts whose
 * sha doesn't match the current offer".)
 */
export function sweepStaleStaged(dir: string, keepSha256: string): void {
  const keep = `ssim_update_${keepSha256.toLowerCase()}.exe`.toLowerCase();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^ssim_update_.*\.exe$/i.test(name)) continue;
      if (name.toLowerCase() === keep) continue;
      try { fsExtra.removeSync(path.join(dir, name)); } catch { /* may be in use */ }
    }
  } catch { /* dir unreadable — nothing to sweep */ }
}

/**
 * 2. Stream the new SSIM.exe to a temp file — RESUMABLY. The single binary is ~185 MB, and a download
 * that big over a real connection gets cut off mid-stream often enough that an all-or-nothing GET can
 * loop forever (every reset throws away everything and restarts from zero — exactly what stranded the
 * fleet). So we fetch it in resumable hops: each drop re-requests with `Range: bytes=<have>-` and
 * APPENDS from where we stopped, until the whole file is on disk. The server answers 206 + Content-Range,
 * so this is a plain partial-content fetch. An idle-stall guard aborts a silently-wedged socket so the
 * retry loop can resume it instead of hanging the launch. The partial file is KEPT between attempts
 * (that is the whole point) and removed only if we ultimately fail. verify()'s sha256 is the backstop:
 * a misassembled file can never be swapped in.
 */
async function download(info: VersionInfo): Promise<string> {
  const stageDir = updatesStageDir();
  const tmp = stagedArtifactPath(stageDir, info.sha256); // sha-keyed → resumes/reuses across boots (C1)
  sweepStaleStaged(stageDir, info.sha256); // clear artifacts from other offers (keeps this sha)
  // If a COMPLETE, byte-intact artifact for this sha is already staged from a prior boot, REUSE it —
  // skip the ~185 MB re-download entirely. verify() re-hashes as the authoritative gate; this cheap
  // pre-check just avoids touching the network when we already hold the exact bytes.
  if (fs.existsSync(tmp) && (await sha256File(tmp)) === info.sha256.toLowerCase()) {
    logger.info(`update artifact already staged + sha-intact – skipping download: ${tmp}`);
    return tmp;
  }
  const MAX_ATTEMPTS = 40;   // each good hop ADVANCES, so this tolerates ~40 drops, not 40 full restarts
  const STALL_MS = 30_000;   // no bytes for 30 s on an open socket → wedged; abort so we can resume it
  let total = 0;             // learned from the first response (Content-Length / Content-Range)
  let lastErr = '';
  let lastPct = -1;          // throttle splash progress emits to once per whole percent (≤100 lines total)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let have = 0;
    try { have = fs.statSync(tmp).size; } catch { /* no partial yet */ }
    if (total > 0 && have >= total) break; // already whole

    try {
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
      // No axios timeout on the body (we guard idle ourselves); we need the raw stream to resume.
      const res = await http.get(info.url, { responseType: 'stream', headers, timeout: 0 });

      if (res.status === 200) {
        // Full body (first fetch, or server ignored Range) → (re)start clean from zero.
        if (have > 0) { try { fs.truncateSync(tmp, 0); } catch { /* noop */ } have = 0; }
        total = Number(res.headers['content-length']) || total;
      } else if (res.status === 206) {
        const m = String(res.headers['content-range'] || '').match(/\/(\d+)\s*$/); // bytes a-b/TOTAL
        if (m) total = Number(m[1]);
      } else {
        try { res.data.destroy(); } catch { /* noop */ }
        throw new Error(`HTTP ${res.status}`);
      }

      const startHave = have; // bytes already on disk before this hop (resume offset)
      // Write via pipeToFile: it fsyncs + waits for the fd to CLOSE before resolving, so the staged
      // exe carries no lingering write handle when the self-test executes it (the EACCES fix).
      await pipeToFile(res.data, tmp, {
        append: res.status === 206,
        stallMs: STALL_MS,
        onData: (hopBytes) => {
          // Drive the splash progress bar. hopBytes is this-hop only; add the resume offset.
          if (total > 0) {
            const done = startHave + hopBytes;
            const pct = Math.min(99, Math.floor((done / total) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              emitUpdate(`SSIM_UPDATE_PROGRESS::${pct}::${(done / 1048576).toFixed(0)}::${(total / 1048576).toFixed(0)}`);
            }
          }
        },
      });

      try { have = fs.statSync(tmp).size; } catch { /* noop */ }
      if (total === 0 || have >= total) break;          // whole file on disk → done
      logger.warn(`update download short (${have}/${total} bytes) – resuming`); // server closed early
    } catch (err) {
      lastErr = (err as Error).message;
      let got = 0; try { got = fs.statSync(tmp).size; } catch { /* noop */ }
      logger.warn(`update download interrupted at ${(got / 1048576).toFixed(0)} MB (${lastErr}) – resume ${attempt}/${MAX_ATTEMPTS}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }

  let finalSize = 0; try { finalSize = fs.statSync(tmp).size; } catch { /* noop */ }
  if (finalSize === 0 || (total > 0 && finalSize < total)) {
    try { fsExtra.removeSync(tmp); } catch { /* noop */ }
    throw new Error(`download incomplete after ${MAX_ATTEMPTS} attempts (${finalSize}/${total || '?'} bytes)${lastErr ? ` – last: ${lastErr}` : ''}`);
  }
  return tmp;
}

/**
 * Verifies the KIND-INCLUSIVE update signature: Ed25519 over
 * `${latest}:${sha256}:${kind ?? 'backend'}`. `kind` defaults to 'backend' identically on the
 * server (`signing.js`), so both sides sign/verify the same bytes. Returns false if `sigKind`
 * is absent or doesn't verify — a tampered `kind` changes the payload, so the signature no
 * longer matches and the destructive swap-shape cannot be forced. Pure (key passed in) so it
 * is unit-testable with a throwaway keypair.
 */
export function verifyUpdateSignature(
  info: { latest: string; sha256: string; kind?: string; sigKind?: string },
  publicKeyPem: string,
): boolean {
  if (!info.sigKind) return false;
  const kindTag = info.kind ?? 'backend';
  try {
    return crypto.verify(
      null,
      Buffer.from(`${info.latest}:${info.sha256}:${kindTag}`),
      publicKeyPem,
      Buffer.from(info.sigKind, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** 3. Integrity (sha256) + authenticity (Ed25519 over latest:sha256:kind) gate before we trust the file.
 *  Returns `shaOk` separately so the caller deletes ONLY a sha-mismatched (corrupt) artifact, never a
 *  sha-intact-but-signature-failed one (re-download is pointless; keep it network-free). Exported for tests. */
export async function verify(file: string, info: VersionInfo): Promise<{ ok: boolean; shaOk: boolean }> {
  const digest = await sha256File(file); // S8: streaming hash — no 185 MB sync read that freezes the loop
  if (digest !== info.sha256) {
    logger.error('update sha256 mismatch – discarding download');
    return { ok: false, shaOk: false }; // S21: corrupt bytes → the caller SHOULD delete + re-download
  }
  // Authenticity gate: require the KIND-INCLUSIVE signature so a forged swap-shape `kind`
  // (the migration/delete selector) is rejected — not just the artifact bytes. An update
  // manifest without `sigKind` is refused (the server must dual-sign first; that is why the
  // server rollout ships before this client).
  if (!info.sigKind) {
    logger.error('update manifest has no kind-inclusive signature (sigKind) – refusing update');
    return { ok: false, shaOk: true }; // S21: sha intact — a re-download yields the identical failure
  }
  const sigOk = verifyUpdateSignature(info, UPDATE_PUBLIC_KEY);
  if (!sigOk) logger.error('update signature invalid (kind-inclusive) – possible tampering, discarding');
  return { ok: sigOk, shaOk: true };
}

/** Outcome of one self-test spawn: OK, a retryable transient lock, a retryable-with-longer-budget
 *  timeout, or a real keep-current failure ('crash' / 'no-marker'). */
export type SelfTestOutcome =
  | { ok: true }
  | { ok: false; kind: 'lock' | 'crash' | 'no-marker' | 'timeout'; errno?: string; detail: string };

/**
 * Classify a thrown execFileSync error so we retry ONLY a transient permission/lock condition or a
 * timeout, and NEVER a genuine failure (which must keep the current version — the anti-brick guard):
 *   • the child RAN and exited non-zero (self-test FAIL = 2) → numeric `.status`, no spawn errno →
 *     'crash'. real failure: keep current, do not retry. This is what preserves the guard.
 *   • WE killed the child because it exceeded the time budget (Node marks it `code:'ETIMEDOUT'` and/or
 *     `killed:true` + a kill signal, with NO numeric status) → 'timeout'. A slow/AV-heavy machine may
 *     legitimately need longer than the base budget, so a timeout earns one escalation to a 2× budget
 *     (see selfTestNewExe) — it is not the hard 'crash' the ≤1.3.3 generation used, which permanently
 *     stranded slow machines. (C2 / the self-test budget rule.)
 *   • the child could not be SPAWNED with EACCES/EBUSY/EPERM/ETXTBSY → a lingering write handle, an AV
 *     scan, or a MOTW/SmartScreen block → 'lock' (RETRYABLE with backoff).
 *   • anything else (ENOENT bad path, a self-inflicted fatal signal like SIGSEGV) → 'crash'.
 * Pure + exported so the keep-current-on-real-failure property is unit-testable without a real exe.
 */
export function classifySpawnError(err: unknown): Extract<SelfTestOutcome, { ok: false }> {
  const e = (err ?? {}) as NodeJS.ErrnoException & { status?: number | null; code?: string | number | null; signal?: string | null; killed?: boolean };
  // Exit code: SYNC execFileSync puts it on `.status`; ASYNC execFile puts it on `.code` (as a NUMBER).
  // Either way, a non-zero exit means the image LOADED and ran, then self-reported failure → real
  // 'crash', not a lock. This is what preserves the keep-current guard (S8 made the spawn async).
  const exitCode = typeof e.status === 'number' ? e.status : (typeof e.code === 'number' ? e.code : undefined);
  if (exitCode != null) return { ok: false, kind: 'crash', detail: `exit ${exitCode}` };
  // Only a STRING `.code` is a spawn errno (EACCES/ETIMEDOUT/…); a numeric one was the exit code above.
  const errno = typeof e.code === 'string' ? e.code : undefined;
  // A budget timeout: we killed the child (no exit status). `killed:true` means WE killed it (the
  // timeout), distinct from a child that died on its own fatal signal (killed:false → 'crash').
  if (errno === 'ETIMEDOUT' || e.killed === true) {
    return { ok: false, kind: 'timeout', errno: errno ?? undefined, detail: `self-test exceeded its time budget (${errno || e.signal || 'ETIMEDOUT'})` };
  }
  if (errno && ['EACCES', 'EBUSY', 'EPERM', 'ETXTBSY', 'UNKNOWN'].includes(errno)) {
    return { ok: false, kind: 'lock', errno, detail: `${e.syscall || 'spawn'} ${errno}` };
  }
  return { ok: false, kind: 'crash', errno, detail: `${errno || e.signal || 'spawn-error'}: ${String(e.message || '').slice(0, 160)}` };
}

/**
 * Strip the Mark-of-the-Web (NTFS `Zone.Identifier` alternate data stream) from a staged file so
 * SmartScreen / the Defender Attachment Manager doesn't block CreateProcess of it with
 * ERROR_ACCESS_DENIED (EACCES). A file we wrote ourselves via fs normally carries NO MOTW, so this is
 * defence-in-depth (and it is re-applied between retries in case an AV re-tags the file). Best-effort,
 * no-op on non-NTFS / when absent. Returns whether a tag was actually removed (for tests/logging).
 */
export function stripMarkOfTheWeb(file: string): boolean {
  try {
    fs.unlinkSync(`${file}:Zone.Identifier`); // remove the ADS by its stream name
    return true;
  } catch {
    return false; // ENOENT (none present — the common case for an fs-written file) or non-NTFS volume
  }
}

/** Base self-test time budget. MUST be >= the build/publish self-test budget (~180-200s) so a slow or
 *  AV-heavy machine that self-tested fine at build time is not rejected here. A TIMEOUT escalates once
 * to SELFTEST_TIMEOUT_ESCALATION× this before keeping current. */
const SELFTEST_BUDGET_MS = 240_000;
const SELFTEST_TIMEOUT_ESCALATION = 2; // one retry at 2× budget on a timeout (240s → 480s)

/**
 * One self-test spawn → a classified outcome. Boots the new exe with SSIM_SELFTEST=1 in an ISOLATED temp
 * home (its extraction + logs never touch the live install) and exit 0 (ok) / 2 (fail). `timeoutMs` is
 * injected so selfTestNewExe can escalate the budget on a timeout.
 *
 * DUAL: the OK marker arrives by a DIFFERENT channel per artifact, so we accept EITHER —
 *   • console ssim-backend.exe (two-file fleet artifact) prints `SSIM_SELFTEST_OK` to STDOUT, and
 *   • the GUI SSIM.exe (single-exe artifact) has no usable stdout, so its shell passthrough writes the
 *     report to <home>/.ssim-selftest.out.
 */
const execFileAsync = promisify(execFile);

async function runSelfTestOnce(file: string, timeoutMs: number = SELFTEST_BUDGET_MS): Promise<SelfTestOutcome> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim_selftest_'));
  try {
    // ASYNC execFile (not execFileSync) so the ~240–480s self-test NEVER freezes the event loop of a
    // live, session-carrying process (C5's mid-session "Install now") — a sync spawn stalled every HTTP
    // request, Steam CM keepalive and confirmation poll for minutes, dropping the resident fleet. Capture
    // stdout (not 'ignore') so a console artifact's marker is visible; a GUI artifact yields empty stdout
    // and we fall back to the file report. execFile throws on a non-zero exit or a `timeout` kill
    // (→ classifySpawnError → 'crash'/'timeout'). The keep-current guard is unchanged (still per-outcome).
    const { stdout } = await execFileAsync(file, [], {
      env: { ...process.env, SSIM_SELFTEST: '1', SSIM_HOME: home },
      timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    let report = '';
    try { report = fs.readFileSync(path.join(home, '.ssim-selftest.out'), 'utf8'); } catch { /* no file report */ }
    if (/SSIM_SELFTEST_OK/.test(String(stdout || '')) || /SSIM_SELFTEST_OK/.test(report)) return { ok: true };
    return { ok: false, kind: 'no-marker', detail: (String(stdout || '') || report).trim().slice(0, 300) };
  } catch (err) {
    return classifySpawnError(err);
  } finally {
    try { fsExtra.removeSync(home); } catch { /* best-effort */ }
  }
}

const SELFTEST_BACKOFF_MS = [300, 900, 2000, 4000]; // bounded retry for a transient handle/AV/MOTW lock
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 4. ANTI-BRICK: prove the new artifact boots + loads all bundled deps (incl. the globaloffensive +
 * steam stack) before we replace the working one — with a bounded retry-with-backoff so a transient
 * EACCES/EBUSY (a not-yet-released handle, an AV mid-scan, a MOTW tag) doesn't strand the update, and a
 * ONE-SHOT budget escalation so a slow/AV-heavy machine's legitimately-long boot isn't misread as a
 * failure. A GENUINE failure still keeps the current version. The artifact is already authentic
 * (sha256 + Ed25519).
 *
 * KEEP-CURRENT GUARD INTACT — the ONLY outcomes that lead to another spawn are:
 *   • 'lock'    → bounded retry with backoff (transient handle/AV/MOTW), then keep current.
 *   • 'timeout' → exactly one retry at 2× the budget (slow machine), then keep current.
 * A 'crash' (non-zero exit) or 'no-marker' boot returns immediately and we do not swap. Even after every
 * retry is exhausted we still return the failing outcome — never a weakening. Returns the classified
 * SelfTestOutcome (not a bare bool) so the caller can record WHY it failed for telemetry and the
 * per-sha failure streak. `runOnce`/`backoffMs`/`baseBudgetMs` are injectable for tests.
 */
export async function selfTestNewExe(
  file: string,
  runOnce: (f: string, timeoutMs: number) => SelfTestOutcome | Promise<SelfTestOutcome> = runSelfTestOnce,
  backoffMs: readonly number[] = SELFTEST_BACKOFF_MS,
  baseBudgetMs: number = SELFTEST_BUDGET_MS,
): Promise<SelfTestOutcome> {
  stripMarkOfTheWeb(file); // clear any Mark-of-the-Web before the first attempt
  let budget = baseBudgetMs;
  let timeoutEscalated = false;
  let lockAttempt = 0;
  for (;;) {
    const r = await runOnce(file, budget); // S8: runOnce is now async (execFile); a sync test fake awaits fine
    if (r.ok) {
      logger.info(`update self-test passed – new artifact boots + loads its deps${lockAttempt ? ` (after ${lockAttempt} retr${lockAttempt === 1 ? 'y' : 'ies'})` : ''}`);
      return r;
    }
    // A TIMEOUT earns one escalation to a 2× budget (a slow/AV-heavy machine may legitimately need
    // longer), then keeps current. Counted separately from the lock backoff so neither consumes the
    // other's budget. This is the ≤1.3.3 permanent-strand fix — a timeout was hard-'crash'ed before.
    if (r.kind === 'timeout') {
      if (!timeoutEscalated) {
        timeoutEscalated = true;
        const prev = budget;
        budget *= SELFTEST_TIMEOUT_ESCALATION;
        logger.warn(`update self-test hit its ${Math.round(prev / 1000)}s budget – ONE escalation retry at ${Math.round(budget / 1000)}s (slow/AV-heavy machine)`);
        continue;
      }
      logger.error(`update self-test still exceeded its budget after escalating to ${Math.round(budget / 1000)}s – not swapping (keeping current): ${file}`);
      return r;
    }
    // A real failure (ran and failed, or produced no OK marker) is not retried — keep the current
    // version. This IS the anti-brick guard; do not weaken it.
    if (r.kind !== 'lock') {
      logger.error(`update self-test failed – not swapping [${r.kind}]: ${r.detail}`);
      return r;
    }
    // A spawn-level permission/lock condition (EACCES/EBUSY/…): retry with backoff, re-stripping MOTW.
    if (lockAttempt < backoffMs.length) {
      logger.warn(`update self-test spawn lock (${r.detail}) on ${file} – retry ${lockAttempt + 1}/${backoffMs.length} after ${backoffMs[lockAttempt]}ms`);
      await sleep(backoffMs[lockAttempt]);
      stripMarkOfTheWeb(file);
      lockAttempt++;
      continue;
    }
    // Exhausted retries on a PERSISTENT lock → still keep the current version (guard intact), but say so.
    logger.error(`update self-test still locked (${r.detail}) after ${backoffMs.length} retries – not swapping: ${file}`);
    return r;
  }
}

/**
 * Build the Windows .bat for the swap. Pure + exported so the swap logic can be tested without
 * overwriting a live install. Waits for our backend PID and (when given) the shell PID — force-killing
 * after ~12 s so a stuck process can't deadlock it — then moves the new exe over `target` with retry
 * (Windows can hold a file handle briefly after exit), deletes any orphaned files, relaunches, self-cleans.
 *
 * Generalised over the four swap shapes: `target` (file to replace) and `relaunch` (exe to start) can
 * differ — e.g. a two-file backend swap replaces ssim-backend.exe but relaunches the shell SSIM.exe; a
 * migration replaces the shell SSIM.exe and deletes the orphaned ssim-backend.exe via `deletePaths`.
 */
export function buildSwapScript(o: {
  tmp: string;                 // downloaded new exe
  target: string;              // the file to REPLACE with tmp
  relaunch: string;            // the exe to START after the swap
  relaunchUpdatedFlag?: boolean; // pass --ssim-updated (single-exe shell shows the "Update installed" splash)
  backendPid: number;          // our PID — always waited for
  shellPid?: number;           // parent shell PID; omit for headless standalone
  deletePaths?: string[];      // extra files to remove after the swap (e.g. orphaned ssim-backend.exe on migration)
  vbsPath: string;             // deleted by the bat
  selfPath?: string;           // what the bat deletes last; defaults to %~f0 (itself) in production
  markerPath?: string;         // S9: file the bat writes on a FAILED move so the next boot counts it
  markerSha?: string;          // S9: the artifact sha recorded in that marker (per-sha swap-fail streak)
}): string {
  const waitOrKill = (pid: number, label: string): string =>
    `set /a ${label}=0\r\n:${label}\r\n` +
    `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul || goto ${label}_ok\r\n` +
    `set /a ${label}+=1\r\n` +
    `if %${label}% GEQ 12 (taskkill /F /PID ${pid} >nul 2>&1 & goto ${label}_ok)\r\n` +
    `timeout /t 1 >nul & goto ${label}\r\n:${label}_ok\r\n`;
  const dels = (o.deletePaths ?? []).map((p) => `del /F /Q "${p}" >nul 2>&1\r\n`).join('');
  // The orphan-delete (e.g. deleting the running ssim-backend.exe on a migration) MUST run
  // ONLY after a CONFIRMED successful swap. Before, `dels` ran unconditionally after the
  // move loop, so a move that never succeeded (AV/file lock) still deleted the orphan and
  // relaunched the un-swapped target → a bricked install. Now a successful `move` jumps to
  // :swapped (→ dels), and an exhausted retry jumps to :swapfail (skips dels). Both paths
  // still relaunch + self-clean, so a failed swap degrades to a no-op update, never a brick.
  return (
    `@echo off\r\n` +
    waitOrKill(o.backendPid, 'wbk') +                          // our backend
    (o.shellPid != null ? waitOrKill(o.shellPid, 'wsh') : '') + // the shell (if any)
    `set /a tries=0\r\n:swap\r\n` +
    `move /Y "${o.tmp}" "${o.target}" >nul 2>&1 && goto swapped\r\n` +
    `set /a tries+=1\r\n` +
    `if %tries% LSS 15 (timeout /t 1 >nul & goto swap)\r\n` +
    `goto swapfail\r\n` +                                       // move never succeeded → SKIP the delete
    `:swapped\r\n` +
    dels +                                                     // orphan delete — ONLY after a confirmed swap
    // SUCCESS: relaunch the new exe with --ssim-updated (the "Update installed" splash is now honest).
    `start "" "${o.relaunch}"${o.relaunchUpdatedFlag ? ' --ssim-updated' : ''}\r\n` +
    `goto done\r\n` +
    `:swapfail\r\n` +
    // RECORD the swap failure so the next boot can count it and, after N, BLOCK the swap instead of
    // looping boot→self-test→swap→relaunch forever. And relaunch the OLD exe without --ssim-updated (the
    // swap did not happen, so do not claim "Update installed").
    (o.markerPath ? `echo ${o.markerSha ?? ''}>"${o.markerPath}"\r\n` : '') +
    `start "" "${o.relaunch}"\r\n` +
    `:done\r\n` +
    `del "${o.vbsPath}" >nul 2>&1\r\ndel "${o.selfPath ?? '%~f0'}"\r\n`
  );
}

/** Launcher factory — the real `spawn` in production; injectable so a test can drive the WSH-blocked
 *  ('error') path without a real wscript.exe (mirrors selfTestNewExe's injected runner). */
export type SpawnLauncher = (cmd: string, args: string[]) => ChildProcess;
const realLauncher: SpawnLauncher = (cmd, args) =>
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });

/**
 * 5. Write the swap script + launch it (hidden, detached) so it can replace us after we exit. Picks the
 * swap SHAPE from the runtime environment + manifest, so this single client serves the deployed two-file
 * fleet, the single-exe build, and the one-time migration between them.
 */
export function swapAndRelaunch(newExe: string, info: VersionInfo, launcher: SpawnLauncher = realLauncher): Promise<{ updated: boolean; reason: string }> {
  const stamp = Date.now();
  const bat = path.join(os.tmpdir(), `ssim_updater_${stamp}.bat`);
  const vbs = path.join(os.tmpdir(), `ssim_updater_${stamp}.vbs`);
  const shellExe = process.env.SSIM_SHELL_EXE;            // set ONLY by the single-exe shell
  const installDir = path.dirname(process.execPath);
  const siblingShell = path.join(installDir, 'SSIM.exe'); // the two-file GUI shell next to ssim-backend.exe
  // Every swap shape records a failed move to this marker so the next boot counts it (→ block after N).
  const swapMarker = { markerPath: swapFailureMarkerPath(), markerSha: info.sha256 };

  let script: string;
  let mode: string;
  if (shellExe) {
    // (1) SINGLE-EXE: replace + relaunch the consolidated SSIM.exe (shell + embedded backend).
    script = buildSwapScript({
      tmp: newExe, target: shellExe, relaunch: shellExe, relaunchUpdatedFlag: true,
      backendPid: process.pid, shellPid: process.ppid, vbsPath: vbs, ...swapMarker,
    });
    mode = 'single-exe';
  } else if (info.kind === 'single-exe' && IS_SIDECAR_MODE && fs.existsSync(siblingShell)) {
    // (2) MIGRATION two-file → single-exe: the artifact IS the consolidated SSIM.exe. Replace the OLD
    // shell with it, DELETE the now-orphaned ssim-backend.exe (our own running file), relaunch SSIM.exe.
    script = buildSwapScript({
      tmp: newExe, target: siblingShell, relaunch: siblingShell, relaunchUpdatedFlag: true,
      backendPid: process.pid, shellPid: process.ppid, deletePaths: [process.execPath], vbsPath: vbs, ...swapMarker,
    });
    mode = 'two-file→single-exe migration';
  } else if (IS_SIDECAR_MODE) {
    // (3) TWO-FILE backend update: swap ssim-backend.exe in place; relaunch the EXISTING shell, which
    // respawns the freshly-swapped sidecar. No SSIM_SHELL_EXE → it's the OLD shell, so no --ssim-updated.
    script = buildSwapScript({
      tmp: newExe, target: process.execPath, relaunch: siblingShell,
      backendPid: process.pid, shellPid: process.ppid, vbsPath: vbs, ...swapMarker,
    });
    mode = 'two-file backend';
  } else {
    // (4) HEADLESS standalone (no shell): swap our own exe and relaunch it directly.
    script = buildSwapScript({
      tmp: newExe, target: process.execPath, relaunch: process.execPath,
      backendPid: process.pid, vbsPath: vbs, ...swapMarker,
    });
    mode = 'standalone';
  }

  fsExtra.writeFileSync(bat, script);
  // Hidden + detached launcher: window style 0 = invisible, False = don't wait.
  fsExtra.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "cmd /c ""${bat}""", 0, False\r\n`);
  // S9/hardening: WSH (wscript.exe) is disabled/removed on hardened & EDR-managed fleets (the same class
  // this app already fights). A ChildProcess whose image can't launch emits an async 'error' with NO
  // listener → uncaughtException → false crash marker + a money-ops breaker tick for a benign "your OS
  // blocks WSH" condition. So attach 'error'/'spawn' before unref and only take the exit path once the
  // launcher is KNOWN to have started; a failed launch means no swap happens → keep-current (no exit,
  // no SSIM_UPDATING), classified as swap-blocked.
  return new Promise((resolve) => {
    const child = launcher('wscript.exe', [vbs]);
    child.on('error', (e) => {
      logger.error(`update swap launcher failed to start (${(e as NodeJS.ErrnoException).code}) – keeping current; manual reinstall needed`);
      setUpdateOutcome('swap-blocked');
      resolve({ updated: false, reason: 'swap launcher blocked (WSH disabled?)' });
    });
    child.on('spawn', () => {
      child.unref();
      // Tell the shell this is an UPDATE, not a crash → quit cleanly so the file frees up. The single-exe
      // shell acts on this; the old two-file shell ignores it (it already follows its sidecar out on exit).
      emitUpdate('SSIM_UPDATING');
      logger.info(`update staged (${mode}) – swap script launched, exiting for replacement`);
      // Give WScript a moment to spin the bat up as an independent process before we vanish (do not unref).
      setTimeout(() => process.exit(0), 800);
      resolve({ updated: true, reason: 'swapping' });
    });
  });
}

// ── C3: per-artifact self-test failure streak (never pin silently) ────────────
/**
 * Persisted so the streak — and the "update blocked on this machine" surface — survives a reboot. The
 * whole point of C3 is that the same artifact failing its self-test on the same machine every boot is
 * now VISIBLE + bounded (logged with a stable marker, exposed to the UI, sent in telemetry), never an
 * infinite silent keep-current loop as it was for the stranded fleet. Keyed by sha256 so a new published
 * artifact always starts a fresh streak.
 */
export interface SelfTestState {
  sha256: string;
  version: string;
  consecutiveFailures: number;
  lastKind?: string;       // 'crash' | 'no-marker' | 'timeout' | 'lock'
  firstFailedAt?: number;
  lastFailedAt?: number;
}

const SELFTEST_STATE_FILE = 'selftest-state.json';
/** Surface (never silently pin) after this many identical-sha self-test failures. */
export const SELFTEST_BLOCK_THRESHOLD = 3;

// ── S9: swap-failure marker + per-sha streak (a MOVE that never succeeds must not loop forever) ───────
const SWAP_FAIL_MARKER = 'swap-failed.marker'; // written by the swap bat on :swapfail (contains the sha)
const SWAP_FAIL_STATE  = 'swap-fail-state.json';
/** Block re-attempting the swap after this many identical-sha move failures on this machine. */
export const SWAP_BLOCK_THRESHOLD = 3;
interface SwapFailState { sha256: string; count: number; }
/** Absolute path of the marker file the swap bat writes on a failed move (consumed next boot). */
export function swapFailureMarkerPath(dir: string = updatesStageDir()): string { return path.join(dir, SWAP_FAIL_MARKER); }
function readSwapFailState(dir: string): SwapFailState | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, SWAP_FAIL_STATE), 'utf8')) as Partial<SwapFailState>;
    if (typeof r.sha256 === 'string' && Number.isFinite(r.count)) return { sha256: r.sha256, count: Number(r.count) };
  } catch { /* absent/unreadable → no streak */ }
  return undefined;
}
/**
 * Consume a swap-failure marker the bat wrote last boot. If present, fold it into a per-sha streak
 * (a new sha starts a fresh streak of 1); delete the marker. Returns the current streak (or the existing
 * one when there is no new marker) so the caller can block after SWAP_BLOCK_THRESHOLD. Injectable dir.
 */
export function consumeSwapFailureMarker(dir: string = updatesStageDir()): SwapFailState | undefined {
  const markerPath = path.join(dir, SWAP_FAIL_MARKER);
  let markerSha: string | undefined;
  try {
    if (fs.existsSync(markerPath)) { markerSha = (fs.readFileSync(markerPath, 'utf8') || '').trim() || undefined; fs.rmSync(markerPath, { force: true }); }
  } catch { /* best-effort */ }
  const prev = readSwapFailState(dir);
  if (!markerSha) return prev; // no new failure this boot → return the existing streak for the block check
  const same = prev && prev.sha256 === markerSha;
  const next: SwapFailState = { sha256: markerSha, count: same ? prev!.count + 1 : 1 };
  try { writeJsonAtomic(path.join(dir, SWAP_FAIL_STATE), next, { spaces: 0 }); } catch { /* best-effort */ }
  return next;
}
/** Clear the swap-fail streak + marker (on up-to-date / a fresh good state). Injectable dir for tests. */
export function clearSwapFailState(dir: string = updatesStageDir()): void {
  try { fs.rmSync(path.join(dir, SWAP_FAIL_STATE), { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(path.join(dir, SWAP_FAIL_MARKER), { force: true }); } catch { /* best-effort */ }
}

function selfTestStatePath(dir: string): string { return path.join(dir, SELFTEST_STATE_FILE); }

/** Read the persisted self-test failure state, or undefined if absent/unreadable. Injectable dir for tests. */
export function readSelfTestState(dir: string = updatesStageDir()): SelfTestState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(selfTestStatePath(dir), 'utf8')) as Partial<SelfTestState>;
    if (typeof raw.sha256 !== 'string' || !Number.isFinite(raw.consecutiveFailures)) return undefined;
    return {
      sha256: raw.sha256,
      version: typeof raw.version === 'string' ? raw.version : '',
      consecutiveFailures: Number(raw.consecutiveFailures),
      lastKind: typeof raw.lastKind === 'string' ? raw.lastKind : undefined,
      firstFailedAt: Number.isFinite(raw.firstFailedAt) ? Number(raw.firstFailedAt) : undefined,
      lastFailedAt: Number.isFinite(raw.lastFailedAt) ? Number(raw.lastFailedAt) : undefined,
    };
  } catch { return undefined; }
}

/**
 * Record a self-test failure for `sha256`. Increments the streak if this is the same artifact, otherwise
 * starts a fresh streak of 1 (a new offer clears the old one). Persisted atomically. Returns the new
 * state so the caller can decide whether the threshold is reached. Injectable dir for tests.
 */
export function recordSelfTestFailure(sha256: string, version: string, kind: string, dir: string = updatesStageDir()): SelfTestState {
  const now = Date.now();
  const prev = readSelfTestState(dir);
  const same = prev && prev.sha256 === sha256;
  const next: SelfTestState = {
    sha256,
    version,
    consecutiveFailures: same ? prev!.consecutiveFailures + 1 : 1,
    lastKind: kind,
    firstFailedAt: same ? (prev!.firstFailedAt ?? now) : now,
    lastFailedAt: now,
  };
  try { writeJsonAtomic(selfTestStatePath(dir), next, { spaces: 2 }); } catch { /* best-effort */ }
  return next;
}

/** Clear the self-test failure state (a self-test passed, or the artifact is gone). */
export function clearSelfTestState(dir: string = updatesStageDir()): void {
  try { fsExtra.removeSync(selfTestStatePath(dir)); } catch { /* best-effort */ }
}

/**
 * Does a self-test failure of this KIND count toward the persistent C3 per-sha block?
 * A 'lock' (EACCES/EBUSY/MOTW — an AV mid-scan or a Controlled-Folder handle) is ENVIRONMENTAL, not an
 * artifact defect; the classifier itself calls it retryable and its backoff ladder (~7s) is far shorter
 * than a real AV scan. Counting it meant three cold-AV boots permanently BLOCKED a perfectly good update.
 * A 'crash' / 'no-marker' / 'timeout' IS a real per-artifact failure and still counts.
 */
export function selfTestFailureCountsTowardBlock(kind: string | undefined): boolean {
  return kind !== 'lock';
}

/** Map a self-test failure kind → the coarse telemetry outcome (C4 enum). 'crash' has no dedicated
 *  bucket (a crash also means the boot never confirmed OK), so it folds into 'selftest-no-marker'. */
function selfTestOutcomeFor(kind: string | undefined): UpdateOutcome {
  switch (kind) {
    case 'lock':    return 'selftest-eacces';
    case 'timeout': return 'selftest-timeout';
    default:        return 'selftest-no-marker'; // 'no-marker' | 'crash' | anything else
  }
}

/**
 * Surface a persistently-failing update so it is NEVER silently pinned: a STABLE, greppable log
 * marker (`SSIM_UPDATE_BLOCKED` — keep the spelling stable for field log searches), a status field the
 * dashboard reads (updateStatus), and the telemetry outcome. The swap is still refused — this only
 * makes the block visible so the operator can do the manual reinstall (STRANDED_FLEET_RESCUE).
 */
function surfaceBlockedUpdate(info: VersionInfo, state: SelfTestState): void {
  logger.error(`SSIM_UPDATE_BLOCKED v${info.latest} sha=${info.sha256.slice(0, 12)} self-test failed ${state.consecutiveFailures}× on this machine [${state.lastKind}] – keeping current; a manual reinstall is needed`);
  setBlockedUpdate({
    version: info.latest,
    sha256: info.sha256,
    kind: state.lastKind ?? 'unknown',
    failures: state.consecutiveFailures,
    since: state.firstFailedAt ?? Date.now(),
  });
  setUpdateOutcome(selfTestOutcomeFor(state.lastKind));
}

/**
 * Full orchestration; safe to call on boot or from a manual/periodic trigger.
 *
 * `opts.force` (a manual "Check for updates now") re-attempts an artifact that has been marked blocked
 *. The boot + periodic paths RESPECT the block so they don't re-run the ~200s self-test that has
 * already failed N times on this machine on every single launch — they surface it and keep current
 * fast. A new published sha always resets the streak, so a genuine new release is never suppressed.
 */
export async function runUpdate(currentVersion: string, opts?: { force?: boolean; isBusy?: () => boolean }): Promise<{ updated: boolean; reason: string }> {
  markChecked(Date.now());
  const checked = await check(currentVersion);
  if (checked.status === 'check-failed') {
    // The CHECK itself failed (network/server) — record it distinctly so the stranded-fleet histogram
    // counts this cohort. Do not clear the last-known available-update or the swap-fail streak: we learned
    // nothing about the current published sha, so keep whatever the last successful check surfaced.
    setUpdateOutcome('check-failed');
    return { updated: false, reason: `update check failed: ${checked.error}` };
  }
  if (checked.status === 'current') {
    setUpdateOutcome('up-to-date');
    setAvailableUpdate(undefined);
    clearSwapFailState(); // S9: on the latest, drop any stale swap-fail streak for a now-superseded sha
    return { updated: false, reason: 'up-to-date' };
  }
  const info = checked.info;
  // A newer version exists — surface it regardless of whether the swap ultimately succeeds.
  setAvailableUpdate({ version: info.latest, notes: info.notes, publishedAt: info.publishedAt });
  printUpdateBanner(currentVersion, info.latest);
  logger.info(`update available: ${currentVersion} → ${info.latest}`);

  // If this exact artifact has already failed its self-test ≥N times on this machine, don't re-run
  // the expensive self-test on every boot/periodic tick — surface the block and keep current fast. A
  // manual `force` re-attempts (the user explicitly asked); a new sha resets the streak.
  const prior = readSelfTestState();
  if (!opts?.force && prior && prior.sha256 === info.sha256 && prior.consecutiveFailures >= SELFTEST_BLOCK_THRESHOLD) {
    surfaceBlockedUpdate(info, prior);
    return { updated: false, reason: `update v${info.latest} blocked on this machine (self-test failed ${prior.consecutiveFailures}× [${prior.lastKind}]) – keeping current` };
  }

  // Consume the swap-failure marker the bat wrote on a FAILED move last boot, and fold it into a
  // per-sha streak. A persistent MOVE failure (AV/EDR lock, or Controlled Folder Access on a Desktop
  // install) used to loop boot→self-test→swap→relaunch FOREVER with nothing recorded. After N such
  // failures for this artifact, BLOCK the swap (surface it) instead of re-attempting. `force` overrides.
  const swapFail = consumeSwapFailureMarker();
  if (!opts?.force && swapFail && swapFail.sha256 === info.sha256 && swapFail.count >= SWAP_BLOCK_THRESHOLD) {
    logger.error(`SSIM_UPDATE_BLOCKED v${info.latest} sha=${info.sha256.slice(0, 12)} SWAP (move) failed ${swapFail.count}× on this machine – keeping current; likely AV/EDR or Controlled Folder Access on the install path. A manual reinstall (or an install-path exclusion) is needed.`);
    setBlockedUpdate({ version: info.latest, sha256: info.sha256, kind: 'swap-fail', failures: swapFail.count, since: Date.now() });
    setUpdateOutcome('swap-blocked');
    return { updated: false, reason: `update v${info.latest} SWAP blocked on this machine (move failed ${swapFail.count}×) – keeping current` };
  }

  // Tell the shell to show "Downloading update…" on its splash — the download can be ~175 MB and runs
  // before our server starts, so without this the launch window would just look frozen. The version
  // rides along so the splash can name what it's installing ("Downloading update v1.2.3…").
  emitUpdate(`SSIM_UPDATE_DOWNLOADING::${info.latest}`);

  let file: string;
  try {
    file = await download(info);
  } catch (err) {
    setUpdateOutcome('download-fail');
    return { updated: false, reason: `download failed: ${(err as Error).message}` };
  }
  // Verify (sha256, fast) + anti-brick self-test (boots the new exe, can take up to ~2 min). Both
  // are silent on disk, so flag the phase or the splash looks stuck on "Downloading" the whole time.
  emitUpdate('SSIM_UPDATE_VERIFYING');
  const v = await verify(file, info);
  if (!v.ok) {
    setUpdateOutcome('sig-fail');
    // Delete ONLY on a sha MISMATCH (corrupt/tampered bytes → re-fetching is worth it). A
    // signature-only failure (sha intact — a key-divergent or unsigned manifest) KEEPS the artifact:
    // re-downloading yields the identical bytes + the identical failure, so deleting just triggered a
    // 185 MB re-download every boot forever. The sha-keyed pre-check reuses the kept file → network-free.
    if (!v.shaOk) fsExtra.removeSync(file);
    else logger.warn('update signature failed but the sha is intact – KEEPING the staged artifact (a re-download would not help; check the server signing key / manifest sigKind)');
    return { updated: false, reason: 'verification failed' };
  }
  const selfTest = await selfTestNewExe(file);
  if (!selfTest.ok) {
    setUpdateOutcome(selfTestOutcomeFor(selfTest.kind));
    // A transient 'lock' (AV mid-scan / MOTW / Controlled-Folder handle) must not be folded into the C3
    // per-sha streak — three cold-AV boots would otherwise permanently BLOCK a good update. Keep current
    // this boot and retry fresh next boot; the keep-current guard is unchanged (still no swap).
    if (!selfTestFailureCountsTowardBlock(selfTest.kind)) {
      return { updated: false, reason: `new exe self-test locked [${selfTest.kind}] – kept current; retrying next boot (transient, not counted toward the C3 block)` };
    }
    // KEEP the verified artifact staged (do not remove it) so the next boot resumes at verify+self-test
    // without re-downloading ~185 MB. C3: record the streak; surface once it crosses the threshold — never a silent keep.
    const state = recordSelfTestFailure(info.sha256, info.latest, selfTest.kind);
    if (state.consecutiveFailures >= SELFTEST_BLOCK_THRESHOLD) surfaceBlockedUpdate(info, state);
    return { updated: false, reason: `new exe failed its self-test [${selfTest.kind}] – kept the current version` };
  }
  // Self-test passed → this artifact is good on this machine; clear any prior failure streak + block.
  clearSelfTestState();
  setBlockedUpdate(undefined);
  // S14 (TOCTOU): the busy-gate was checked minutes ago at the endpoint; the download+self-test window is
  // long enough for the operator to have STARTED a mass-sell / trade-up craft / casket move since. Re-check
  // immediately before the swap — a swap hard-exits the process and would interrupt an in-flight real-item
  // op. Defer instead: the verified, self-tested artifact is KEPT so the next attempt swaps without
  // re-downloading. This is ADDED after the selfTest.ok gate — swapAndRelaunch's single call site is still
  // reached only on a passed self-test (keep-current guard intact).
  if (opts?.isBusy?.()) {
    setUpdateOutcome('deferred-busy');
    logger.warn('[update] a trade/buy/sell/craft/move started during the update window – deferring the swap (keeping current; artifact staged for the next attempt)');
    return { updated: false, reason: 'a trade/buy/sell/craft/move started during the update — deferred; retry when idle' };
  }
  setUpdateOutcome('ok');
  return swapAndRelaunch(file, info); // does not return on success (process exits)
}

export const Updater = { check, runUpdate, parseManifest };
