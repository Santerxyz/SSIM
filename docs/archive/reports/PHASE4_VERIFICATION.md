# Phase 4 — Running-app verification (the wiring, not the model)

Closes the gap the unit tests left open: that the **live app paths were actually
repointed** to the canonical model. `npm test` → **30/30 green**, `tsc --noEmit` clean,
`npm run build` emits clean.

---

## 1. Integration proof of the Critical fix (red on old → green on branch)

`test/integration.refreshBuckets.test.ts` drives the **real wiring end to end** — not
`parseMyListings` in isolation:

- `InventoryService.refreshOneViaGc()` → `fetchListedItems` → `parseMyListings` → bucket
  derivation (the actual refresh path), and
- `AccountTrader.getMarketOrders()` → `parseMyListings` (the actual Active Orders path),

with only the HTTP boundary (`axios.get`) mocked and a fake injected session. The
synthetic payload reproduces the field bug exactly: **A3** is a live SELL listing whose
asset has **no description** in the listings `assets` map (the metadata-less case) **and**
still appears in the inventory contexts; **A2** is trade-locked; A1 owned, A4 a normal listing.

It asserts, against the data the UI counts from:
- A3 is in **Listed**, ABSENT from owned/locked (no Owned+listed overlap).
- Listed-bucket asset-ids **==** Active Orders sell asset-ids (so the Listed pill count
  `app.js:2407` == the Active-Sell count `app.js:1756`).
- A2 (locked) is in **Locked**, ABSENT from Active Orders, and `isSellable(A2)===false`
  (the sell/send guard refuses it).

**Red on pre-fix, green on branch — reproduced:**

```
# revert just the 3 core files to the pre-fix commit and run the SAME test:
$ git checkout 0cf374d~1 -- src/core/MarketListings.ts src/trading/AccountTrader.ts src/core/InventoryService.ts
$ node --require ts-node/register/transpile-only --require ./test/_setup.cjs --test test/integration.refreshBuckets.test.ts
✖ INTEGRATION: refresh→bucket and getMarketOrders agree; field bug cannot recur
  AssertionError: A3 (description-less live listing) is in the Listed bucket
  ℹ pass 0  ℹ fail 1

# restore the branch:
$ git checkout HEAD -- src/core/MarketListings.ts src/trading/AccountTrader.ts src/core/InventoryService.ts
$ node ... --test test/integration.refreshBuckets.test.ts
✔ INTEGRATION: refresh→bucket and getMarketOrders agree; field bug cannot recur
  ℹ pass 1  ℹ fail 0
```

The old strict parser drops A3 from the Listed bucket while Active Orders keeps it →
the exact DIVERGED state. The branch reconciles them. **The wiring is proven, not assumed.**

---

## 2. The six "construction-only" fixes — verified

| Fix | How | Result |
|---|---|---|
| **A7** (dead RATE_LIMITED state) | automated · `test/constructionFixes.test.ts` | `SessionState` has exactly `{DISCONNECTED,CONNECTING,LOGGING_IN,LOGGED_IN,ERROR}` — no unreachable member. ✔ |
| **G6** (breaker reset on re-license) | automated · same | trip breaker (3 uncaught) → `moneyOpsBlocked()===true`; `ProcessHealth.reset()` → `false`. ✔ |
| **G1** (status reflects revoked) | automated · same | `LicenseClient.isRevoked()` exists, defaults `false`; `/api/system/status` returns `licensed: !isRevoked()` (tsc-verified one-liner). ✔ |
| **A4** (logout awaits in-flight login) | automated · same | injected a 30 ms in-flight login; `logoutAccount` ran `destroySession` **after** it settled (test 33 ms). ✔ |
| **G5** (cross-platform recycled-PID image) | recorded smoke (out-of-process) | `[G5] platform=win32 livePID=10696 -> image="node.exe"` · `bogusPID -> image=""`. A live PID yields a real name to compare; a dead PID yields none. POSIX `ps` branch is symmetric. ✔ |
| **F3** (CSFloat key vault migration) | recorded smoke (out-of-process, real code) | `BEFORE: undefined` → `migrateAccountsIntoVault` → `AFTER: CSFLOAT_KEY_123` → `PASS — plaintext file key migrated into the vault`. ✔ |

No fix remains "verified-by-construction" without at least a recorded check.

---

## 3. C14 — PARKED (not closed)

The client-side brick guard **stays** (orphan-delete gated on a confirmed swap, tested).
The `kind`-in-signature change is **blocked on the license server** and must NOT ship as a
client-only change. The exact server step and the safe `server-additive → client-enforce-
destructive-only → fleet-wide → mandatory` rollout order are written into
`CONTRADICTIONS.md` (C14). It is the one item crossing into the sibling `license-server` repo.

---

## 4. Full-app boot run

A full `boot → license gate → vault → dashboard → refresh a real account` run is **not
possible in this environment** (no license key/server, no vault password, no Steam
credentials, and alejandro's account lives on the deployed fleet). The refresh→bucket→
orders logic that run would exercise is covered by §1's integration test instead.

The production bundle was built (`npm run build` → exit 0, emits `dist/core/MarketModel.js`,
`dist/trading/MoneyOps.js`, …) and booted to the furthest point the environment allows.
Clean boot, no errors:

```
ssim.lock              → PID 13248         (G5 single-instance lock acquired cleanly)
logs/ssim.log:
  info  license gate: validating seat for hwid be95b20a3421…   (bootflags→lock→port→HWID OK)
  warn  not licensed (No license key found.) – opening activation portal
  info  license activation portal listening on 127.0.0.1:47823
logs/error.log         → 0 bytes           (no errors)
logs/stderr-trace.log  → 0 bytes           (no native/uncaught output)
```

Boot wiring is intact (no regression from the Phase-3 changes); the app correctly gates on
the missing license and serves the activation portal. The dashboard/refresh surface beyond
the gate is what §1 verifies.

---

## Verdict

- Critical fix proven through the **real** refresh + Active-Orders paths (red→green).
- All six construction-only fixes have an automated test or a recorded smoke.
- C14 parked with a written server step + safe rollout order.
- Production build clean; boot-to-gate clean, no errors.

`npm test` → **30/30**. Ready to merge (with C14's server step tracked separately).
