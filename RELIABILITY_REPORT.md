# SSIM Reliability Report — the "silent crash under refresh", root-caused & killed

**Bottom line.** The backend was being **externally terminated while perfectly healthy** because a
fleet-wide operation drove the **resident live-session population** (each session = a Steam CM socket
+ a never-pooled per-account proxy agent + a polling `TradeOfferManager`) **upward without bound**, and
the shipped binary's session-release only covered the *refresh* path. The fix makes the storm
**structurally impossible** (every fleet-wide path now releases, plus a hard resident-session ceiling no
caller can exceed) **and** makes any backend death **non-fatal** (the Tauri shell now auto-restarts the
sidecar instead of letting a kill wipe the running app). Proven with a deterministic stress harness at
full 538-account scale, build green.

**Done so far:** root cause identified with evidence; all backend fixes implemented + `tsc` green +
proven bounded by harness; Tauri shell auto-restart + non-blocking stdout drain `cargo check`-clean; a
12-slice adversarial code audit corroborated the diagnosis and every confirmed finding is fixed.
**Rebuilt + verified:** the two-exe artifacts (`SSIM.exe` + `ssim-backend.exe`, 2026-06-20 16:31) now
contain every fix — boot self-test green, fixes confirmed present in the packaged build (§3.0).
**Pending you:** the vault master password for the live real-fleet confirmation run (§6).

---

## 1. The crash, in one paragraph

A **whole-fleet refresh** (refresh-all over all **538** accounts — far larger than the ≤140-account
refreshes that had always worked) accumulated **live Steam sessions monotonically**. The backend never
crashed: it was **healthy** (low RSS, no OOM, no native fault) at the last sample and then **vanished**
— a **clean external `TerminateProcess`** of a healthy process, i.e. the **UI shell / OS reclaiming the
backend**, not a bug *inside* it. The resident-session storm was the trigger; the fatal
**shell→backend coupling** turned it into a "wipe".

---

## 2. Evidence (definitive)

### 2.1 The last real death — `…/SSIM old/logs/mem-heartbeat.log`
A **blocking** `appendFileSync` every 15 s (so the last sample is guaranteed on disk):

```
12:56:57  rss=181  handles=75   sessions=42   traders=33
12:57:12  rss=239  handles=117  sessions=84   traders=73
12:57:27  rss=235  handles=139  sessions=110  traders=101
12:57:42  rss=283  handles=163  sessions=137  traders=125   ← last sample, STILL CLIMBING toward 538
(ssim.log continues normal refresh activity to 12:57:56, then the process is simply gone)
```
Sessions climbing **0→137 and rising**; RSS only **283 MB** vs a **3264 MB** V8 ceiling; `[vault]
unlocked (538 account(s))` at 12:56:26 → the whole fleet.

### 2.2 Every internal cause ruled out
| Suspect | Verdict | Why |
|---|---|---|
| V8 OOM | **No** | `reportOnFatalError=true` → would write `logs/report.*.json`; none exists; RSS 283 ≪ 3264 MB |
| Native fatal | **No** | same — no diagnostic report; no Windows WER (Event 1000/1001/1002 absent) |
| JS throw | **No** | `uncaughtException`/`unhandledRejection`/`SIGHUP` handlers write `crash-log.txt` and keep running; none fired for this death |
| Antivirus / Defender | **No** | no AV product registered, no Defender detection, no `WER\ReportQueue` entry |
| OS resource event | **No** | no System-log critical/error in the crash window |
| **External `TerminateProcess`** | **Yes** | both the blocking heartbeat *and* `ssim.log` stop dead while healthy → an **uncatchable** external kill |

### 2.3 Scale is the trigger
`SSIM old/logs/ssim.log` shows refresh-all of **104 / 140 / 48 / 40** completing cleanly many times on
2026-06-17. The death came only on the first **538-account whole-fleet** refresh.

---

## 3. Reproduction — used-to-crash → now-doesn't (deterministic, repeatable)

Three harnesses (`stress/`) drive the **real** `SessionManager` + `TradeService` + `InventoryService` /
`BuyService` / `MarketService` over synthetic accounts with the Steam libs mocked at the `require`
layer — no network, no credentials — and assert every resource returns to baseline.

**`refreshStress.js` — the refresh path:**
```
OLD (SSIM_REFRESH_RELEASE_SESSIONS=0):  ❌ 200/200 fleet held live, 199 clients leaked  ← the crash condition
NOW (release on, 538 accounts × 8):     ✅ peak live sessions = 25 (the cap), 4305 created == 4305 destroyed,
                                            handles FLAT 2→2, RSS FLAT 90→91MB
```

**`bulkOpRelease.js` — the offers view + mass-send:**
```
✅ every pass returns to the 5 pre-existing live baseline; pre-live sessions PRESERVED 5/5 (a user's
   in-progress session is never torn down by a bulk op)
```

**Ceiling backstop (release OFF + `SSIM_MAX_LIVE_SESSIONS=40`):**
```
✅ a pathological never-releasing path is BOUNDED to 40 live (41 clients created, the rest refused),
   NOT 200/538 — the storm is now structurally impossible regardless of call-site discipline
```

---

## 3.0 KEYSTONE: the shipped binary predated the fix

The audit's file-mtime forensics found the deployed `ssim-backend.exe` was packaged **before** the
session-release fix was compiled. The current source is fixed, but **users run the exe** — so the
**rebuild was mandatory**. ✅ **Done:** `npm run build:tauri` repacked `release-tauri/SSIM/` at 16:31
(boot self-test `SSIM_SELFTEST_OK`; `releaseCreatedSessions`, the `MAX_LIVE_SESSIONS` ceiling, and the
ban release all verified present in the packaged `dist/`). A build-drift guard is recommended (§5) so
"fixed in source, broken in the exe" can't recur.

---

## 4. The fix

### 4.1 Shell — a backend death can no longer wipe the app (`src-tauri/src/lib.rs`)
- **Auto-restart on unexpected death.** The shell used to `exit(0)` the instant the sidecar terminated.
  Now an **unexpected** death (external kill / fatal / anything that is *not* the user closing the
  window) **respawns** the sidecar — biased to the **same port** so the existing window is simply
  re-pointed (`webview.navigate`) at the fresh backend, which reloads its persisted state. **Killer-
  agnostic:** whatever terminates the backend, the app recovers instead of vanishing.
- **Crash-loop guard:** ≤ 8 restarts / 120 s, then an in-window "your data is safe — relaunch" message.
- **Intentional close still quits cleanly:** a `quitting` flag is set first so the resulting exit does
  *not* restart (graceful Steam logout + 8 s force-kill watchdog preserved).
- **Non-blocking stdout drain:** the port-probe + window setup now run on a **detached** task, so the
  reader never stops draining the sidecar's stdout (removes the event-loop-stall-via-pipe-backpressure
  vector the audit flagged). `cargo check` clean.

### 4.2 Backend — a bounded lifecycle on **every** fleet-wide login fan-out
The v1.2.1 release covered only `runRefresh`. **Six** other paths could log in the whole fleet and never
release, re-creating the exact storm. All now release the sessions they create:

| Path | File | Status |
|---|---|---|
| Refresh-all | `core/InventoryService.ts` `runRefresh` | already shipped v1.2.1 |
| Trade-Offers view | `trading/TradeService.ts` `getOffersForAccounts` | **fixed** |
| Mass-send | `trading/TradeService.ts` `runMassSend` | **fixed** |
| Mass-sell | `trading/MarketService.ts` `runMassSell` | **fixed** |
| Mass-buy | `trading/BuyService.ts` `runMassBuy` (Phase 1 + 2) | **fixed** (the audit's #1 critical) |
| Single buy | `trading/BuyService.ts` `buy()` | **fixed** (self-releases unless part of mass-buy) |
| Ban check | `trading/BanService.ts` `acquireEnvKeys` + `resolveViaLogin` | **fixed** (the only path with no release anywhere) |

Shared, proven mechanism (`TradeService.snapshotLive` + `releaseCreatedSessions`): capture which
accounts were **already live before** the op, and log out **only** the op's own freshly-created
sessions afterwards — a session the user already had live (mid-trade) is **never** torn down. Kill
switch `SSIM_RELEASE_READ_SESSIONS=0`.

### 4.3 Backend — a hard resident-session ceiling (the structural backstop)
`SessionManager` now enforces **`MAX_LIVE_SESSIONS`** (env `SSIM_MAX_LIVE_SESSIONS`, default **150** —
far above every 25-wide pool, far below a socket-exhaustion threshold; `0` disables). Once that many
sessions are resident, a **new** account's login is **refused fast** (a re-login of an already-resident
account is exempt). Refusal is classified transient → the bulk orchestrators record it as a per-account
failure and continue; **no token is ever deleted**. This makes the entire unbounded-resident-session
class impossible **regardless of call site** — present, future, or a missed release. Proven to bound a
deliberate leak to the cap (§3).

### 4.4 Diagnostics — make the blind spot diagnosable (`utils/memHeartbeat.ts`)
An **event-loop-stall breadcrumb**: each sample records the wall-clock gap since the previous one; a gap
≫ the interval (the loop was blocked, e.g. sync IO or pipe backpressure) is written as `stallMs`. A
stall that freezes both logs at once previously looked identical to an external kill; now it leaves a
trace.

### 4.5 What was already correct (verified line-by-line, kept)
Login concurrency cap 25; per-session teardown (timers cleared, `logOff`, `removeAllListeners` + a
**re-added no-op `'error'` handler** — proven survivable by the harness — and per-account proxy agent
`destroy()`); **every emitter has an `'error'` listener** (steam-user, `TradeOfferManager`,
`SteamCommunity`, `GlobalOffensive`+`disconnectedFromGC`, the `SessionManager` itself); the GC layer's
one-handle-per-session (#31 fix) with `gamesPlayed([])` teardown in `finally`; all timers unref'd +
cleared; bounded caches (`InventoryStore` LRU + atomic writes; `PricingService` bounded queue); SSE log
stream coalesced (120 ms / ~500 lines·s⁻¹) with per-connection listener cleanup.

---

## 5. Residual risk + what to monitor

- **Attribution gap (honest):** the *exact* proximate terminator of the historical death (socket
  exhaustion vs the 8 s close-watchdog in a compound frozen-UI path vs pipe backpressure) cannot be
  proven from code alone — the leak (upstream cause) is proven; the proximate killer is inferred. The
  fix addresses **all** of them: release + ceiling bound the storm; the non-blocking drain removes
  backpressure; auto-restart makes any kill recoverable; the `stallMs` breadcrumb makes the *next*
  incident attributable. **Watch `logs/mem-heartbeat.log`**: `sessions` must fall back to baseline after
  every bulk op; a `stallMs` field or a `sessions` count pinned near the fleet size is the signal to
  investigate.
- **Build drift (the keystone class):** recommend gating the pack so it **fails if `dist/` is older
  than `src/`**, or asserts release markers in the packaged exe — so "fixed in source, broken in the
  shipped exe" cannot recur.
- **WebView2 render load at 538 rows:** the sidebar isn't virtualised; a whole-fleet render is a one-
  time spike on refresh *completion*. Auto-restart makes a WebView/shell death recoverable; virtualising
  the sidebar would reduce the trigger — recommended follow-up.
- **Tuning:** if `MAX_LIVE_SESSIONS` is set too low it could fail accounts during a legitimately large
  concurrent op — the default 150 clears every 25-wide pool with headroom; document `SSIM_MAX_LIVE_SESSIONS`.
- **Environmental:** a flaky 538-proxy fleet generating NoConnection/retry storms still pressures sockets
  provider-side; the ceiling mitigates but cannot eliminate provider reclaim.
- **No money-safety guard or the vault was touched** by any fix (in-flight guard, currency-known, order
  ceiling, never-throw-after-placed, `createBuyOrder` re-POST, AES-GCM vault all unchanged). No cases /
  containers / keys were touched. No money spent. No version bump.

---

## 6. Pending

1. ✅ **Two-exe rebuild** (done) — `npm run build:tauri` repacked `ssim-backend.exe` (with these fixes)
   and rebuilt `SSIM.exe` (auto-restart) into `release-tauri/SSIM/` (16:31, self-test green).
2. **Real-fleet live confirmation** — run the rebuilt backend **headless** (`SSIM_HEADLESS=1` +
   `SSIM_VAULT_PASSWORD=…`) against the real 538 accounts under sustained refresh-all while watching
   `mem-heartbeat.log` show the bounded curve live; then live-demo the shell auto-restart (kill the
   sidecar → window reconnects, no wipe). **Needs the vault master password from you** (paste it or set
   `SSIM_VAULT_PASSWORD`).

---

## 7. Multi-agent line-by-line audit (corroboration)

A 12-slice parallel audit (every backend file + the Tauri shell, each hunting emitters-without-error-
handlers / unbounded growth / listener+timer leaks / GC handles / external-kill vectors), each high-
signal finding **adversarially verified** by an independent skeptic, then synthesised. **40 agents,
27 findings reviewed, 3 confirmed** — all on the money/ban session-lifecycle, all now fixed:

| # | Confirmed finding | Status |
|---|---|---|
| 1 (critical) | Mass-buy Phase 1 force-refreshes the whole fleet, never releases | **Fixed** (§4.2) |
| 2 (high) | `buy()` single-buy holds a session with no release | **Fixed** (§4.2) |
| 3 (high) | BanService login fan-out leaves every minted/resolved session live (no release in source *or* dist) | **Fixed** (§4.2) |

The synthesis independently reached the same root cause (unbounded resident sessions defeating the
refresh-only release) and recommended exactly what was implemented: mirror the refresh release on the
money paths **and** add a hard `SessionManager` resident-session ceiling. It also surfaced the
**keystone** (shipped exe predated the fix → rebuild) and the **stdout-drain** hardening, both addressed
above. Full audit JSON: the workflow result (`wva6ufptt`).
