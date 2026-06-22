# SSIM v1.2.1 — Stability patch (anti-crash)

**Date:** 2026‑06‑20 · Backend‑only fix on top of v1.2.0. Build green · packaged self‑test
`SSIM_SELFTEST_OK v1.2.1 … deps=all-loaded(GC+steam stack)` (exit 0) · clean `release/SSIM-1.2.1.zip`
(54.3 MB, zero secrets). No live Steam/GC/real‑money ops were run.

---

## Why this release exists

A production run on the **538‑account** fleet died silently mid‑session. Diagnosed from the production
logs (read‑only; no user data touched):

- The app was **logging in / refreshing a large part of the whole fleet at once** — the heartbeat shows
  live sessions climbing **0 → 137 in 90 s and still rising** toward 538, each with its own Steam CM
  connection + proxy sockets + a polling trade‑manager.
- The backend itself was **healthy at the last sample** (283 MB RSS, 163 handles) — **no OOM, no
  `crash-log.txt`, no native report** — then the process was **terminated externally with no clean
  shutdown**. The whole‑fleet load (resident sessions + a render/log storm) is the scale ceiling; 538 at
  once is past it. Prior runs had only ever refreshed **≤ 140** accounts (those succeeded).
- **Not** caused by the v1.2.0 features — trade‑ups / storage / the updater don't run during a refresh.
  This is a **pre‑existing architectural limit** (nothing capped the login *path*; a bulk refresh left the
  whole fleet logged in), exposed now that the fleet reached 538. **Not a v1.2.0 regression.**

## What changed (3 fixes — stability only, no feature/behaviour change to money paths)

1. **Global login concurrency cap** (`SessionManager`). A semaphore caps **simultaneous new logins** across
   *every* caller and both games to **25** (env `SSIM_MAX_CONCURRENT_LOGINS`); excess logins queue (FIFO)
   and start as slots free. Per‑account dedup is unchanged; a slot is held only during the handshake and
   released the instant the login settles (success *or* failure) — so no path can ever open hundreds of
   simultaneous proxy/CM sockets again.
   *Verified:* 300‑account storm → peak concurrency never exceeded 25; 50 concurrent callers for one
   account → exactly 1 login; slots fully reclaimed after failures; no deadlock.

2. **Bulk refresh releases the sessions it creates** (`InventoryService`). A full‑fleet refresh now **logs
   out each account it logged in, right after caching that account's inventory**, so live sessions stay
   bounded to ~the worker count during the pass and return to the **pre‑refresh baseline** after — instead
   of holding all 538 live at once. Accounts that were **already live** before the refresh (e.g. one you're
   trading with) are detected per‑account and **never touched**. Inventory is cached before logout, so
   nothing is lost; any later action re‑logs the account in on demand. Kill switch:
   `SSIM_REFRESH_RELEASE_SESSIONS=0` restores the old "stay logged in" behaviour.
   *Verified:* 60 refresh‑created sessions all released (incl. ones whose fetch failed); 2 pre‑live trader
   sessions preserved; 0 collateral logouts; kill‑switch releases none.

3. **Coalesced live‑log stream** (`/api/logs/stream`). A fleet refresh emits hundreds of log lines/sec; the
   SSE stream now **buffers and flushes on a 120 ms timer with a per‑flush cap (≤ ~500 lines/s)**, dropping
   the overflow with one synthetic summary line, so a "Live Logs" window can't be flooded into choking its
   WebView. The full log is always intact in the ring buffer + `error.log`. Frontend unchanged.

## Operational guidance (works now, no rebuild)

Even with the cap, **prefer refreshing per‑environment over the whole 538 fleet at once.** Global‑master
"Refresh all" honours the **environment selection** (F3a) — deselect down to one environment (each ~48–140
accounts) and refresh those. Lighter on sockets, the window, and Steam.

---

## Deploy (the fix is 100% backend — swap one file)

The Tauri shell **`SSIM.exe` is unchanged**; only **`ssim-backend.exe`** carries the fix (two‑artifact
model — the shell never auto‑updates).

**Manual swap (your production folder):**
1. Close the SSIM window (quits the backend too).
2. In `…\SSIM\`, rename the old `ssim-backend.exe` → `ssim-backend.exe.bak` (keep it as a rollback).
3. Copy the new `ssim-backend.exe` from `release-tauri\SSIM\ssim-backend.exe` (or extract it from
   `release\SSIM-1.2.1.zip`) into the folder.
4. Launch `SSIM.exe`. The footer reads **v1.2.1**.

**Or push as an auto‑update** to deployed clients: publish `ssim-backend.exe` labeled **exactly `1.2.1`**
(see `UPDATER_RUNBOOK.md`). Canary one client first.

**Rollback:** restore `ssim-backend.exe.bak`. Clients on the auto‑updater: point `/version` back to `1.2.0`.

## Residual / unchanged

- The *deeper* scale work (capping total resident sessions, virtualising the 538‑row sidebar) is **not** in
  this patch — it bounds the refresh storm, which is what killed it, but a UI rendering hundreds of rows is
  still heavy. Per‑environment refresh remains the recommended workflow at this fleet size.
- GC live features + the updater swap‑relaunch seam carry the same "prove once on a canary" caveats as
  v1.2.0 (`RELEASE_1.2.0.md`). Unchanged here.
