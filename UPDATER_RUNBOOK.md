# SSIM — Auto-Update Operations Runbook

How to ship an update to deployed clients, safely. The client side (`src/licensing/Updater.ts`) is
built and **signature-secured**; this is the **publishing** side you operate on the license backend.

---

## What gets uploaded

**Only `ssim-backend.exe`.** The frontend (`public/`) is **bundled inside** that exe (a pkg asset), so the
backend exe *is* the UI + all logic. There is **no separate frontend to upload.**

The Tauri **shell** (`SSIM.exe`) is **NOT** auto-updated (two-artifact design — the updater swaps only the
backend, which is ~99% of all changes). A shell change (rare; Rust/window code) needs a **manual
re-download** of the folder. Keep shell changes rare.

---

## The contract

The client does `GET {LICENSE_API_URL}/version` at every packaged boot and expects:
```json
{ "latest": "1.1.6", "url": "https://your-cdn/ssim-backend-1.1.6.exe", "sha256": "<hex>", "sig": "<base64url>" }
```
It updates only if `latest` is **newer** than the running version, then **downloads → verifies sha256 +
Ed25519 signature** (over `${latest}:${sha256}` under the baked `LICENSE_PUBLIC_KEY`) → **self-tests the new
exe** → swaps + relaunches. Anything else → it keeps running the current version (fails open).

---

## Publish an update — step by step

1. **Bump the version** in `package.json` (e.g. `1.2.0` → `1.2.1`). This becomes the new exe's reported
   version **and** must equal `latest` (the signature binds them).
2. **Build the backend:** `npm run build:tauri` (loads secrets from `secrets.local.bat`). Output:
   `release-tauri/SSIM/ssim-backend.exe`. The build's own in-package self-test must print
   `SSIM_SELFTEST_OK` (it does, or the build fails).
3. **Host the exe** at a stable URL (your CDN), e.g. `…/ssim-backend-1.1.6.exe`.
4. **Sign the manifest** with your PRIVATE key (kept on the backend, never committed):
   ```
   set LICENSE_PUBLIC_KEY=<your public key>           # optional, to self-verify
   node build/sign-update.js \
     --exe release-tauri/SSIM/ssim-backend.exe \
     --version 1.1.6 \
     --url https://your-cdn/ssim-backend-1.1.6.exe \
     --key path\to\license_private.pem                # or env LICENSE_PRIVATE_KEY
   ```
   It prints the exact `/version` JSON (and self-verifies the signature if the public key is set).
5. **Serve that JSON** from `GET {LICENSE_API_URL}/version`. Done — clients pick it up at their next boot.

> Keys lost / first-time setup: `node build/sign-update.js --genkeys` generates an Ed25519 pair. The PUBLIC
> key gets baked into the build (`LICENSE_PUBLIC_KEY`); the PRIVATE stays on the backend. **New keys
> invalidate every already-shipped client**, so only do this for a fresh deployment.

---

## Safety — what protects you

- **Authenticity:** a hijacked URL/CDN can't ship a payload clients will run — they verify the Ed25519
  signature, and only you hold the private key.
- **Anti-brick:** before swapping, each client runs the downloaded exe's `SSIM_SELFTEST=1` and **only swaps
  if it boots + all bundled deps load** (incl. globaloffensive). A new exe that won't start is **rejected**,
  so a bad publish can't replace a working install with a dead one.
- **Fails open:** any check/download/verify/self-test failure → the client logs it and keeps running the
  current version. Updates never block boot.

## Safety — what you must still do

- **Canary the FIRST update of any cut.** Point `/version` at the new build for **one** test client first
  (or a small ring), confirm it updates + runs, then roll it out to everyone. The self-test gate stops a
  *non-booting* build, but a *logic* bug that still boots would propagate — the canary catches that.
- **No client-side rollback.** Clients that already updated stay updated. To stop further spread of a bad
  cut, revert `/version` to advertise the previous version (clients then see "not newer" → no update). Then
  ship a fixed higher version.
- **Version lockstep.** The new exe's `package.json` version, `latest`, the served file, and `sig` must all
  agree. Mismatch = no update or a re-update loop.
- **Halt updates entirely (if needed):** make `/version` return the currently-deployed version (or a 4xx) —
  clients then never update until you re-point it.

---

## Quick reference

| Want to… | Do |
|---|---|
| Ship a normal update | bump version → `build:tauri` → host exe → `sign-update.js` → serve `/version` |
| Stop a bad update spreading | set `/version` `latest` back to the previous version |
| Disable auto-update temporarily | make `/version` 4xx or return the current version |
| Update the window shell (rare) | ship a fresh `release-tauri/SSIM/` folder for manual re-download |
