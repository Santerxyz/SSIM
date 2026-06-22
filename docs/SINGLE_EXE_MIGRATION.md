# SSIM single-exe migration — license-server contract

SSIM is now **one binary**: `SSIM.exe` = the Tauri shell with the Node backend embedded inside it
(self-extracts to `runtime\` on launch). Auto-update is a **single-file swap**. The client side lives
in this repo (`src/licensing/Updater.ts`, `build/publish.js`); the **server side** (`ssim-license-server`,
separate repo) must be updated to publish the manifest below. This file is that spec.

## The manifest the server serves (`GET /version`)

During the migration window, serve **all** of these fields (one published artifact = `SSIM.exe`):

```json
{
  "latest":  "1.3.0",
  "url":     "https://<cdn>/SSIM-1.3.0.exe",
  "sha256":  "<hex sha256 of SSIM.exe>",
  "sig":     "<base64url Ed25519 over `${latest}:${sha256}`>",
  "files":   [{ "name": "SSIM.exe", "url": "https://<cdn>/SSIM-1.3.0.exe", "sha256": "<same hex>" }],
  "filesSig":"<base64url Ed25519 over manifestSigPayload(latest, files)>"
}
```

- **Top-level `url`/`sha256`/`sig`** → consumed by **new single-exe clients** (and any legacy single-file
  clients). They download `SSIM.exe`, verify `sig` over `` `${latest}:${sha256}` ``, swap it, relaunch.
- **`files[]` + `filesSig`** → consumed by **existing two-file (v1.2.x) installs**. Their *already-shipped*
  `runManifestUpdate` downloads every entry (here just `SSIM.exe`), swaps it over their old `SSIM.exe`
  shell, and relaunches. The new exe then deletes the orphaned `ssim-backend.exe`. This is the whole
  migration — no new code on the deployed clients; it rides their existing updater.
- `manifestSigPayload(version, files)` = `` `${version}|SSIM.exe@${sha256}` `` (files sorted by name;
  a single entry here). Sign with the Ed25519 **private** key. Must be byte-identical to the client's
  `manifestSigPayload` — except the client no longer needs it (single-file only); only old clients verify it.

## `finalize` endpoint — NO server change needed (verified)

Verified against `ssim-license-server/src/admin.js`: the existing `release/stage` + `release/finalize`
already produce the manifest above from a SINGLE file. `build/publish.js` stages `SSIM.exe` and calls
`POST /admin/api/release/finalize` with `{ version, backend: 'SSIM.exe', files: [{ name:'SSIM.exe', storedAs }] }`:

- `if (!files.length)` passes (1 file) — there is no two-file requirement.
- `backend = manifest.find(name === 'ssim.exe')` → the SSIM.exe entry (and `manifest[0]` is SSIM.exe too),
  so top-level `url/sha256/sig` = `sign(`${version}:${SSIM.exe sha}`)`.
- `filesSig = sign(manifestSigPayload(version, [SSIM.exe]))` → `files:[SSIM.exe]` for old two-file clients.

So the server is left untouched. The publish flow is entirely in the CS2_Manager repo:

1. Bump `package.json` version to **> the currently published version** (clients only take a strictly newer one).
2. `npm run build:tauri` (syncs `tauri.conf.json`, builds + self-tests the single `SSIM.exe`).
3. `npm run publish-update` (stages `SSIM.exe`, finalizes with `backend:'SSIM.exe'`).

## After everyone has migrated

Once telemetry shows no v1.2.x two-file clients remain, you may drop `files[]`/`filesSig` from the
manifest — new clients read only the single-file fields and ignore them. Keep them until then.

## Anti-brick + rollback

- The new client self-tests the downloaded `SSIM.exe` (`SSIM_SELFTEST=1`, which boots the embedded
  backend + loads the GC/steam stack) before swapping — a bad publish can't replace a working install.
  ⚠ The *old* two-file client's self-test only fires on a file named `ssim-backend.exe`, so for the one
  migration hop it is **skipped** — validate the consolidated `SSIM.exe` yourself before publishing.
- **Rollback:** point `/version` back at the previous version's manifest. Clients only update when
  `latest` is strictly newer, so they never downgrade on their own.
