# SSIM — Auto-Update Operations Runbook (v1.3.0+, single-exe)

How to ship an update to deployed clients, safely. The client side (`src/licensing/Updater.ts`) is built
and **signature-secured**; this is the **publishing** side you operate against the license server. The
one command is **`npm run publish-update`** — it logs into the admin API, stages the artifact, has the
server sign it, and verifies the result. You almost never hand-edit `/version`.

> ⚠ This file was rewritten for the **single-exe** architecture. If you find advice to publish
> "only `ssim-backend.exe`" or that "the shell is not auto-updated", it is stale — that was the old
> two-file model. Publishing the wrong artifact for a fleet looks like *"the update silently does nothing"*.

---

## What gets shipped

**ONE file: `SSIM.exe`** = the Tauri shell with the Node backend (and the whole `public/` frontend)
**embedded inside it**. There is no separate frontend and no separate backend to upload. An update swaps
the entire `SSIM.exe` and relaunches it; on first launch the new exe re-extracts its backend to `runtime\`.

The build output is `release-tauri/SSIM/SSIM.exe` (≈185 MB), produced by `npm run build:tauri`.

---

## The `/version` contract

The client does `GET {LICENSE_API_URL}/version` at every **packaged** boot and reads the top-level fields:
```json
{ "latest": "1.3.0", "url": "https://license.ssim.dev/download/SSIM-1.3.0.exe",
  "sha256": "<hex>", "sig": "<base64url>", "kind": "single-exe" }
```
- It updates only if `latest` is **strictly newer** than the running version (3-part numeric compare).
- Then **downloads (resumable, Range) → verifies sha256 + Ed25519 `sig`** (over `${latest}:${sha256}` under
  the baked `LICENSE_PUBLIC_KEY`) → **self-tests the new exe** (`SSIM_SELFTEST_OK`, 120 s budget) → swaps +
  relaunches. Any failure → it keeps the current version (**fails open**; it retries next boot).
- `kind` is an optional, **unsigned** hint. Only a two-file client on the *dual* updater reads it, to choose
  the two-file→single-exe migration swap. A forged `kind` can only break an install (the exe is still fully
  signature-authenticated), never run unsigned code.

The server also emits a `files[]`/`filesSig` block for the **old Gen-B two-file client**; the current
single-exe client ignores it and reads only the top-level fields.

---

## Who's in the wild, and which artifact they can consume

| Installed client | Updater | Publish with | Why |
|---|---|---|---|
| **Fresh 1.3.0 single-exe** | single-exe swap (`SSIM_SHELL_EXE`) | *default* | swaps the whole `SSIM.exe`. |
| **Deployed two-file 1.2.x on the DUAL updater** (≥1.2.5) | dual-mode | `--migrate` | tagged `kind:'single-exe'` → replaces the shell + deletes `ssim-backend.exe` (one-time cutover). |
| **Deployed two-file 1.2.x on the OLD Gen-B updater** (1.2.0–1.2.2) | backend-swap only | `--legacy-backend` | their updater gates on `SSIM_SELFTEST_OK` **on stdout** and swaps over `ssim-backend.exe`; a GUI `SSIM.exe` fails that gate. Get them onto the dual updater FIRST. |

**Rollout ORDER (critical, do not skip):**
1. `npm run publish-update -- --legacy-backend --build` — ships the console `ssim-backend.exe` that carries
   the **dual updater** to any client still on the old Gen-B updater. (Done for 1.2.5.)
2. Only once the fleet is on the dual updater: `npm run publish-update -- --migrate --build` — the
   consolidated `SSIM.exe`, `kind:'single-exe'`. **A `--migrate` cut that reaches a still-Gen-B client fails
   silently.** `--migrate` REQUIRES the server to echo `kind` (the publish step verifies it and aborts if not).
3. Thereafter, fresh installs and migrated clients all take the *default* single-exe publish.

**Always canary one client before a fleet-wide cut.**

---

## Publish — the real flow

```
# 1. Bump the version (one source of truth; make-tauri.js syncs tauri.conf.json from it)
#    package.json "version" → e.g. 1.3.0

# 2. Build + publish in one go (recommended — guarantees the artifact you ship is freshly built)
npm run publish-update -- --build                 # fresh installs / migrated single-exe fleet
npm run publish-update -- --migrate --build       # one-time two-file→single-exe cutover (dual updater only)
npm run publish-update -- --legacy-backend --build # the deployed two-file 1.2.x fleet (backend swap)

# 3. For a real release, also prove served == built (full re-download + re-hash):
npm run publish-update -- --build --verify-download
```

Needs in `secrets.local.bat` (or env): `LICENSE_API_URL` (e.g. `https://license.ssim.dev`) and
`SSIM_ADMIN_PASSWORD`. The signing **private key lives only on the server** — `publish-update` never
touches it; the server signs `${version}:${sha256}` during `finalize`.

`publish.js` runs these gates automatically (see its header):
1. **Self-test** the on-disk artifact (`SSIM_SELFTEST_OK`) before upload — refuses to publish a brick.
2. **Upload integrity** — local sha256 must equal the sha256 the server stored.
3. **Post-publish verification** — `GET /version` must advertise this exact build (`latest` + `sha256` +
   `url`, and `kind:'single-exe'` on `--migrate`). `--verify-download` re-hashes the served bytes.
4. **Rollback** — any post-publish failure rolls `/version` back to the previously-live manifest.

> **Manual fallback** (serving `/version` by hand, no admin API): `node build/sign-update.js --exe
> release-tauri/SSIM/SSIM.exe --version 1.3.0 --url <served-url> --key <private.pem>` prints the signed
> `/version` JSON. Use only if you are not running `publish-update` against the server.

---

## Safety — what protects you

- **Authenticity:** a hijacked URL/CDN can't ship a payload clients will run — they verify the Ed25519
  signature and only the server holds the private key.
- **Anti-brick (twice):** the build self-tests the consolidated exe, and `publish.js` re-self-tests it before
  upload; each **client** also self-tests the downloaded exe and only swaps if it boots + all bundled deps
  load (incl. globaloffensive).
- **Resumable download:** the client resumes via HTTP Range across drops (≈40 hops, 30 s idle guard). The
  artifact host **must honor `Range`/return 206** or a drop becomes a cold restart of a ~185 MB file. Keep
  `license.ssim.dev` grey-clouded for the 164 MB publish upload (Cloudflare free caps bodies at 100 MB);
  serve the *download* from a Range-friendly host.
- **Fails open:** any check/download/verify/self-test failure → the client keeps the current version and
  retries next boot. Updates never block boot. (Deliberate availability choice — there is intentionally **no
  hard min-version floor**; the license heartbeat is the server-side control point for forcing clients off a
  bad build.)

## Safety — what you must still do

- **Canary the FIRST update of any cut** (one client / small ring) before fleet-wide. The self-test gate
  stops a *non-booting* build; a *logic* bug that still boots only the canary will catch.
- **Version lockstep.** The new exe's `package.json` version, `latest`, the served file's bytes, and `sig`
  must all agree. Mismatch = no update or a re-update loop.
- **Stop a bad cut from spreading:** `publish.js` auto-rolls back on a failed verification; to pull a cut
  that already went live, re-point `/version` to the previous version (clients see "not newer" → no update),
  then ship a fixed higher version. Clients that already updated stay updated (no client-side downgrade).

---

## Quick reference

| Want to… | Do |
|---|---|
| Ship a normal single-exe update | bump version → `npm run publish-update -- --build` |
| One-time two-file→single-exe migration | `npm run publish-update -- --migrate --build` (dual-updater fleet only; canary) |
| Update the deployed two-file 1.2.x fleet | `npm run publish-update -- --legacy-backend --build` |
| Prove served == built for a release | add `--verify-download` |
| Stop a bad cut spreading | it auto-rolls back; else re-point `/version` to the previous version, then ship a fix |
| First-time / lost keys | `node build/sign-update.js --genkeys` (new keys invalidate every shipped client) |
