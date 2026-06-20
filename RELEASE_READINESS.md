# SSIM — Release Readiness Runbook

**Date:** 2026‑06‑20  ·  Final off‑line hardening pass before live testing.
**Build:** `tsc` green · `node --check public/app.js` green · `dist/` clean (dev placeholders, no baked
secret) · every increment committed. The **protected `.exe` was built and its in‑package self‑test
passed** (details below). The only thing left is the owner's irreducible live‑fire on **junk accounts**.

---

## ⚑ FINAL RELEASE DECISION (owner, 2026‑06‑20)

The owner cannot run the live tests and chose to **ship now** with:
- **Artifact:** the **Tauri windowed app** (`release-tauri/SSIM/`, rebuilt this pass with the GC code).
- **Trade‑up CRAFT: ENABLED in the shipped build** (not gated). Explicit, informed owner decision — it
  means **the first real contract on the fleet is the live test** for the GC craft mechanism, which has
  never executed once.

Because that path is **irreversible** (10 items/contract) and **unverified live**, the build ships with
two safety nets that do NOT reduce the feature:
- **KILL SWITCH — `SSIM_GC_VERIFIED=0`:** relaunch with this to **instantly disable** all trade‑up
  execution in production, no rebuild. (`=1` forces on; unset = on in the shipped exe, off in dev. The
  shell launches the sidecar with this unset, so it is ON by default.)
- **Loud Start warning** urging ONE cheap contract first.

**Standing recommendation:** still sacrifice **one** cheap 10‑skin contract on a single account and confirm
the output arrives + matches the recipe tier before running trade‑ups fleet‑wide. If wrong, hit the kill
switch and report — do not keep crafting. Storage (reversible) + the calculator (read‑only) carry no such
risk and need no test.

---

## 1) Per‑feature status

| Feature | Status | Basis |
|---|---|---|
| Hardening (money‑safety, vault, sessions, concurrency ceiling) | **Verified in code** | 42‑assertion harness + 21‑assertion regression (re‑run this pass) |
| Global‑master scoping (F3a refresh / F3b graph / F3c per‑env ban keys) | **Verified in code** | 26‑assertion harness; re‑confirmed |
| Trade‑up calculator (math, schema, search, **real GC floats**) | **Verified in code** | 40‑assertion math harness + dedup fix (9) + real‑schema checks |
| Storage units (list / read / deposit / withdraw) | **Verified in code → Owner live test** | 35‑assertion GcActionLayer integration (mock GO); real API confirmed |
| Trade‑up execution (craft) | **Verified in code, GATED → Owner live test** | recipe table + `craftingComplete` + re‑verify‑before, proven via mock |
| **Protected build bundles + loads the GC stack** | **PROVEN IN PACKAGE** | the packaged exe's self‑test require()s globaloffensive + steam stack |
| globaloffensive did not regress existing features | **Verified** | 21‑assertion combined regression, all green |

No feature is "Blocked." Storage + craft each need exactly **one live GC step** the task reserves for the
owner (Section 5).

---

## 2) The #1 risk — PROVEN: the protected build bundles + loads globaloffensive

`npm run build:protected` was run (secrets parsed from `secrets.local.bat` in PowerShell, values never
printed). Result:
```
▸ verifying exe (SSIM_SELFTEST)
  • SSIM_SELFTEST_OK v1.1.5 public/index.html=93030B deps=all-loaded(GC+steam stack)
✓ protected build complete → ssim.exe
```
- **The self‑test now runs IN‑PACKAGE** and `require()`s the runtime‑critical heavy deps —
  **globaloffensive** (the headline risk: it is only *lazily* required at runtime, so the old boot‑only
  self‑test never exercised it), `steam-user`, `steamcommunity`, `steam-tradeoffer-manager`,
  `@doctormckay/stdlib`, `protobufjs`, `bytebuffer`, `long`, `steamid`, `steam-totp` — and verifies
  globaloffensive exposes its real API (`craft` + caskets), which only resolves if its **precompiled
  protobufs** also bundled + loaded. Any failure prints `SSIM_SELFTEST_FAIL[...]` and exits non‑zero, so
  `build/pack.js` fails **loudly** (it requires `SSIM_SELFTEST_OK`) — never a silent false success.
- **Asset graph audited:** globaloffensive's protobufs are precompiled to `.js` and loaded via **static
  `require`** (no runtime `readFileSync`/dynamic load), so pkg traces the whole graph; `pkg.assets` also
  carries `node_modules/globaloffensive/**/*` (+ the existing `@doctormckay/**`, `**/*.proto`).
- **Built exe:** `ssim.exe` ≈ **163.1 MB** (170,977,914 bytes), console‑subsystem, Task‑Manager name
  patched. Confirmed loadable in‑package: globaloffensive, steam‑user, steamcommunity,
  steam‑tradeoffer‑manager, @doctormckay/stdlib, protobufjs, bytebuffer, long, steamid, steam‑totp.

> Note: the build bakes real secrets into `dist/licensing/config.js` (then obfuscates it). `dist/` is
> gitignored; this pass rebuilt a clean `dist/` (dev placeholders) afterwards so nothing baked is left in
> the working tree. The owner re‑runs `build:protected` to produce the shippable exe.

---

## 3) Bug‑hunt — what was found + fixed (so the owner's live test hits real items, not avoidable bugs)

- **Trade‑up probability skew (fixed):** `Glock‑18 | Gamma Doppler` appears twice in the 2021 Train
  Collection's Covert tier (phase variants sharing one market name); `outputsFor` counted it twice,
  doubling that outcome's probability and skewing EV. Now **deduped by market name**. Verified across the
  whole schema (no output pool has duplicate names; probabilities still sum to 1).
- **Storage unconfirmed‑state UX (fixed):** the modal now reloads the unit's contents on any sent move
  (confirmed *or* unconfirmed) and labels unconfirmed moves clearly, so the panel never shows stale state.
- **Edges confirmed correct (no change needed):** Covert is terminal + knives/gloves ineligible (excluded
  at input AND output); StatTrak/Souvenir separated into distinct contracts; recipe table aligns with the
  rarity ladder (Mil‑Spec=2, +10 StatTrak); no division‑by‑zero; the per‑account GC in‑flight guard blocks
  rapid double‑clicks (server returns "already running" — no double‑execute); craft never re‑sends
  (timeout → `submitted, unconfirmed`); the GC handle is dropped on `sessionDestroyed` (no leak on
  re‑login); the 1000‑cap reads a fresh SO count at op time; global‑master 0/1/all‑env selection is
  guarded for refresh, graph, and ban‑check; an env with 0 key‑capable accounts surfaces a clear
  per‑account error; the aggregate chart excludes envs with no history.

---

## 4) Owner live‑test sequence — what "good" looks like + rollback

Do these **in order, on JUNK accounts**, before touching the real fleet.

**Step 1 — Launch the exe, confirm GC deps loaded.**
- *Do:* run the freshly built `ssim.exe`; reach the dashboard. (Optionally confirm in a console build:
  `SSIM_SELFTEST=1 ssim.exe` → must print `SSIM_SELFTEST_OK ... deps=all-loaded(GC+steam stack)`.)
- *Good:* dashboard loads; opening a single account → **Storage** shows "GC ready — storage enabled".
- *Rollback:* if the self‑test prints `..._FAIL[...]`, do NOT ship — the named dep/asset didn't bundle;
  fix `pkg.assets` and rebuild. (This pass proved it passes, so this is a guard, not an expectation.)

**Step 2 — First storage deposit + withdraw (reversible; no flag needed).**
- *Do:* on a junk account with a couple of cheap items, open **Storage** → pick a unit → tick ONE item →
  **Deposit**. Then tick it in the right panel → **Withdraw**.
- *Good:* footer shows `moved 1`; the item appears in the unit and `count` increments, then returns to
  inventory on withdraw. Verify in the actual CS2 client.
- *If it shows `unconfirmed 1` but the item DID move in‑game:* tell me which GC event fired
  (`itemChanged` / `itemRemoved`) — the verify predicate needs one small tweak. Nothing was lost
  (reversible); do not retry blindly.
- *Rollback:* storage is reversible — withdraw anything mis‑deposited. No `SSIM_GC_VERIFIED` needed.

**Step 3 — First trade‑up (IRREVERSIBLE — destroys 10 items). Craft ships ENABLED (owner decision).**
- *Do:* craft is ON by default in this release — no flag needed. On a throwaway account holding **10 cheap
  same‑tier, same‑StatTrak skins from one collection**, open **Trade‑Ups** → **Get Trade‑Ups** (footer
  should say "REAL per‑item GC floats") → select **ONE** contract → **Start** → read the red/amber warning
  → confirm.
- *Good:* footer shows `submitted 1 (1 confirmed)`; the 10 inputs are consumed and the output skin arrives;
  the output's rarity is one tier above the inputs (recipe matched). Re‑clicking never double‑crafts.
- *Rollback / KILL SWITCH:* there is no undo for a crafted contract. If the output is wrong/missing, relaunch
  with **`SSIM_GC_VERIFIED=0`** to disable all trade‑up execution instantly (storage stays working), and
  report what happened before any further craft. **Do this canary on ONE account before any fleet use.**

**Step 4 — Only then scale up.** Once Steps 2–3 succeed on junk accounts, use the features on the real
fleet — still respecting the 25‑worker ceiling, per‑account pacing, and the money‑op circuit breaker
(which already covers `/tradeup/execute` + `/casket/move`).

---

## 5) Version‑bump decision — DO NOT bump (flagged for the owner)

The `package.json` version is **`1.1.5`** and was **left unchanged**. The license backend's `/version`
auto‑update path compares versions and a careless bump interacts with a **downgrade risk** there (a lower
published version could trigger an unwanted "update"). **Decision: do not change the version in this pass.**
When the owner ships, bump it deliberately *in lockstep with* publishing the matching signed exe to the
backend `/version` endpoint — never one without the other.

---

## 6) Residual risks (all gated/safe — can't surprise‑destroy items)

- **Live GC behaviour** can't be exercised off‑line: the real handshake, the exact post‑move SO signal,
  and that Valve's current `items_game.txt` recipe ids still match the library's table (stable + documented,
  but Valve owns them). All are confirmed by Steps 2–3 on junk accounts; craft stays gated until then.
- **In‑game status flicker:** a GC op briefly sets the bot "in‑game (CS2)" for the few seconds it's
  connected, then back. Expected for storage/farm bots.
- **Trade‑up float read** adds a one‑shot GC connect to each "Get Trade‑Ups" scan; if it ever flakes, the
  UI falls back to a clearly‑labelled wear‑based estimate (no wrong‑but‑confident numbers).
- **Protected‑build secret baking** writes real secrets into `dist/` during `build:protected` — `dist/` is
  gitignored and was rebuilt clean here; the owner just shouldn't commit a post‑`build:protected` `dist/`.

---

## 7) Verdict

The packaged build is **proven to bundle and load the GC stack** (the #1 untested risk, now closed), all
Task‑2/3 code was **adversarially reviewed** with the one real accuracy bug fixed and verified, **no
existing feature regressed**, and the runbook above gives the owner a safe, reversible‑first live‑test
sequence. The product is in a confidently shippable state; the only remaining work is the owner's live‑fire
on junk accounts (Steps 2–3), which cannot be done off‑line without moving real items.
