# SSIM v1.2.0 — Final Release

**Date:** 2026‑06‑20  ·  **Tag:** `v1.2.0`
**Build:** `tsc` green · `node --check public/app.js` green · regression 18/18 · `dist/` clean (dev
placeholders) · committed + tagged. **Built, verified, packaged — NOT published.** No live Steam / GC /
real‑money operations were performed; those are the owner's deliberate final steps.

---

## 1) What's in v1.2.0

Everything from the prior passes, now cut as a versioned release:
- **Hardening** — money‑safety, vault crypto, session lifecycle, the enforced 25‑worker concurrency ceiling.
- **Features** — vault; mass buy / sell / trade; global‑master scoping (refresh + worth graph follow the
  env selection; per‑environment ban API keys with 20/key rotation, no cross‑env); ban checker.
- **GC features** — trade‑up calculator with **real in‑game floats**, trade‑up **execution** (enabled,
  with the `SSIM_GC_VERIFIED=0` kill switch + loud warning), and **storage‑unit** management.
- **Auto‑updater** — signed, two‑artifact, with an **anti‑brick self‑test‑before‑swap** gate.

Two‑artifact Tauri release: **`SSIM.exe`** (window shell, never auto‑updates) + **`ssim-backend.exe`**
(the app **and the entire UI bundled inside it** — this is what auto‑updates).

---

## 2) Build proof — the packaged binary boots and loads every bundled dep

`npm run build:tauri` (secrets parsed from `secrets.local.bat` in PowerShell, never printed). The packaged
**`ssim-backend.exe`** runs its own in‑package self‑test during the build AND was independently re‑verified
from the **extracted ZIP**:

```
SSIM_SELFTEST_OK v1.2.0 public/index.html=93030B deps=all-loaded(GC+steam stack)   (exit 0)
```

The self‑test `require()`s each runtime‑critical heavy dep in‑package and exits non‑zero if any can't load
(so the build fails loudly otherwise). **Confirmed loadable inside the shipped exe:**
`globaloffensive` (+ its real `craft`/casket API, which only resolves if its **precompiled protobufs**
loaded), `steam-user`, `steamcommunity`, `steam-tradeoffer-manager`, `@doctormckay/stdlib`, `protobufjs`,
`bytebuffer`, `long`, `steamid`, `steam-totp`. The bundled frontend (`public/index.html`) reads from the
pkg VFS. **The exe reports exactly `1.2.0`.**

**Artifact sizes:** `SSIM.exe` **11.7 MB** · `ssim-backend.exe` **163.1 MB** (170,980,762 bytes).

---

## 3) Clean distributable — `release/SSIM-1.2.0.zip` (56.8 MB)

Built with `node build/make-zip.js` from an **explicit allow‑list** (only the two exes are copied — the
dev's `data/`, `Vault/`, `mafiles/`, secrets, logs can never reach it), then **scanned**, then
**independently extracted + re‑scanned**. **Complete file tree (zero secrets / user‑data):**

```
SSIM\                              <dir>
SSIM\SSIM.exe                      11.7 MB    ← window shell
SSIM\ssim-backend.exe             163.1 MB    ← app + UI (auto-updates)
SSIM\READ ME FIRST.txt             11,231 B   ← full guide (updated for the window model)
SSIM\START.txt                        512 B   ← short how-to
SSIM\data\                         <dir>      ← EMPTY skeleton (app fills it on first launch)
SSIM\data\README.txt                  104 B   ← "this fills itself" note
SSIM\mafiles\                      <dir>      ← EMPTY skeleton
SSIM\mafiles\PUT_MAFILES_HERE.txt     126 B   ← placeholder
```
**Verified: NO** `vault.enc`, `accounts.json`, refresh tokens, `secrets.local.bat`, `license.key`/`.token`,
`*.maFile`, real `mafiles/`, logs, or any other dev data. (`SSIM-1.2.0.zip` is gitignored — a 56 MB binary,
not committed; rebuild it any time with `node build/make-zip.js`.)

---

## 4) The owner's two actions

**(a) Distribute to fresh installs** — hand out **`release/SSIM-1.2.0.zip`**. The user unzips, keeps the
folder together, runs **`SSIM.exe`**, activates with their license key, sets a vault Master Password.

**(b) Publish as an auto‑update** — to push v1.2.0 to clients already on 1.1.x: log into
**`https://license.ssim.dev/admin.html`** and upload **`ssim-backend.exe`** (from `release-tauri/SSIM/`)
labeled **EXACTLY `1.2.0`**. The panel auto‑hashes, signs, and hosts it.
- The label **must equal** the built exe's version (`1.2.0`) and be **strictly higher** than clients'
  current version, or clients won't take it.
- You upload **only `ssim-backend.exe`** — the shell (`SSIM.exe`) is not auto‑updated (it rarely changes;
  a shell change needs a fresh ZIP).
- (CLI alternative if ever needed: `node build/sign-update.js …` produces the same signed `/version`
  manifest — see `UPDATER_RUNBOOK.md`.)

---

## 5) MANDATORY gate before fleet‑wide rollout

**Run ONE real end‑to‑end update test first.** Take a machine on a **1.1.x** install, publish 1.2.0 to it
(or a one‑client ring), launch it, and watch it: the backend checks `/version` → downloads → **self‑tests
the new exe** → the Tauri shell **swaps `ssim-backend.exe` and relaunches**, and SSIM comes back up on
1.2.0. Only after that succeeds should you roll out to the whole fleet. (The anti‑brick gate stops a
*non‑booting* update; this end‑to‑end test is what proves the **swap‑and‑relaunch seam** itself.)

---

## 6) Residual risks (state plainly)

- **Live GC features are still unproven on real Steam.** Trade‑up execution (irreversible — destroys 10
  items/contract) and storage moves have never run live. Before trusting them at scale, do the
  junk‑account canary: **one** cheap trade‑up + one storage deposit/withdraw (see `RELEASE_READINESS.md`
  §4 / `GC_INTEGRATION_REPORT.md`). Kill switch: `SSIM_GC_VERIFIED=0`.
- **The updater swap+relaunch seam is proven only once §5's end‑to‑end test passes** — it's coded + the
  anti‑brick gate is in, but the live two‑artifact relaunch hasn't been exercised.
- **No staged rollout / client rollback in the updater** — canary the first cut; to stop a bad update
  spreading, point `/version` back at the previous version.

---

## 7) Done

`1.2.0` everywhere · build green · the packaged binary's self‑test proves all deps (GC + Steam stack) load
in‑package · `SSIM-1.2.0.zip` verified to contain **zero** secrets/user‑data (full tree above) ·
`RELEASE_1.2.0.md` written · committed + tagged `v1.2.0`. **Nothing was published to the license server and
no live operations were run** — those final steps (publish, the end‑to‑end update test, the GC
junk‑account canary) are the owner's.
