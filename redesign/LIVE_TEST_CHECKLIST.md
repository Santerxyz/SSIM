# LIVE TEST CHECKLIST — SSIM v1.4.0 new frontend (owner)

The re-skin was verified **statically** (node --check per view; global handler-safety proof:
zero handler/API/`ssimConfirm`/state line changed except the one documented game-toggle re-wire;
all 292 static ids + every `data-*` hook preserved vs `legacy_public`; per-view adversarial diff).
**Money actions were never triggered during development** — every path below needs a real live
click by the owner, ideally against a throwaway/low-value bot first.

How to run: cut over (or point the backend at `redesign/new_public/`), unlock the vault, then walk
each section. For every money action, confirm **(a)** the `ssimConfirm` styled dialog appears (never
a native browser `confirm()`), **(b)** the exact amount/count shown is correct, **(c)** the result
toast matches the real Steam/CSFloat outcome, **(d)** the post-action refresh shows the true new state.

---

## A. Non-money walkthrough (safe — do first)
- [ ] **Unlock / License / Splash portals** render with the new `image-Photoroom.png` logo; master-password unlock works; wrong password shows the error state.
- [ ] **Dashboard** env tiles: proxy pill (Proxy/Local IP), Accounts + Updated stats, **Test proxy** shows `✓ IP · CC (Country) · N ms` (geo) or a distinct `✗ error`.
- [ ] **Sidebar**: folder tree expand/collapse, account rows, multi-select checkboxes → auto-enters Multi-Select master; balance chip shows tri-state (`—` never-refreshed / `0,00` refreshed-empty / value funded).
- [ ] **Refresh** (the single Refresh button) pulls a full inventory; progress bar + "Failed accounts" panel behave; **there is only ONE refresh button** per scope.
- [ ] **Account view**: header pills (Proxy/Local, Full/Limited), category chips (All/Owned/Trade-Locked/Listed), item table (rarity bar, lock badge, value cell), sort, search, faceted filters, value-filter select-under.
- [ ] **Masters** (folder / selection / env / global): headers, stat cards, aggregated table; **Global** env-filter chips toggle envs.
- [ ] **Value-history chart** (env/global master): dual line, shared money Y-axis, **English** time axis (not German), legend shows `Items worth` / `Balance` / `N points`; a partial wallet shows a **dashed** balance line + **"(incomplete)"**.
- [ ] **Game toggle** CS2 ↔ TF2 (`.seg` control, active pill); TF2 lazy-loads; a failed TF2 cold fetch shows the distinct error+Retry panel (not an empty inventory).
- [ ] **Import wizard** (maFiles / CSV / Vault — exactly these 3, no native sign-in): each method's fields render; select-all + file list; **do a real maFile import of a test bot**.
- [ ] **Account modals**: Add-account, Edit-account (proxy override), Environment create/rename/**delete** (styled confirm), Folder create/rename/**delete**/reorder, Move-account (single + batch).
- [ ] **SDA modal**: Steam-Guard OTP code shows + copies; pending confirmations list loads.
- [ ] **Clean browser**: opens the isolated logged-in session through the account's proxy.
- [ ] **Layering (S68)**: open a modal, then trigger a toast/alert — the alert is on top; the bottom-left Live-Logs launcher never occludes a modal; Ban modal (z-30) sits BELOW the Move modal (z-40) when moving a category.
- [ ] **Reload survival (S1)**: hard-reload the UI (F5) mid-session, then perform any write (e.g. rename a folder) — it still works (capability-token re-delivery intact).

---

## B. 💰 MONEY PATHS — verify each with a real (small) transaction

### Market-Buy (V10) — includes the sacred buy re-POST
- [ ] Open **Buy** on a funded test bot. Wallet line shows the real balance (and stays **"Balance unknown — Refresh…"** distinct from `0,00` when not yet refreshed).
- [ ] Item search dropdown fills the market-hash-name; Max qty; Market-price fetch.
- [ ] Place a **real low-value buy order** → `ssimConfirm` → the order fills / posts. **Confirm the createBuyOrder finalize re-POST behaves exactly as before (owner-verified path).**

### Folder Mass-Buy (V11) — forced 2-phase pre-buy balance refresh
- [ ] Open **Mass Buy** on a small test folder. Confirm the **two-phase pre-buy balance refresh** runs before purchase (balances re-pulled), then the per-account results list shows success/failed per bot (failed stays visually distinct).

### Market-Sell (V12)
- [ ] Select items → **Sell on market**. Pricing strategy radios (undercut / match / custom net price). **Calculate** preview: priced rows show Gross / −fee / **Net** (emerald); unpriced rows show a distinct **"no price"** pill (never silently 0).
- [ ] List a **real low-value item** → `ssimConfirm` → progress panel → verify the listing appears in Active Orders.

### Send-Trade (V13)
- [ ] **Trade Offers** (per-account) and **Send selected** (recipient list). Send a **real trade to a known partner** (single) and a small **mass-send** → `ssimConfirm` → verify the offer is created on Steam; an unconfirmed one surfaces "awaiting mobile confirmation".

### Active Orders (V8)
- [ ] Open **Active Orders**. Cancel **one** buy order + **one** sell listing (each `ssimConfirm`). Then **Cancel selected** and **Cancel all** (filtered by search). Confirm each section's count decrements and the empty state appears when 0 remain.

### Trade-Offers manager (V9)
- [ ] Accept / Decline a **real received offer**; Cancel a **real sent offer**. Then **batch** Accept all / Decline all / Cancel all (each `ssimConfirm`). Verify 2FA "awaiting mobile confirmation" honesty on an unconfirmed accept.

### Trade-Ups + Storage Units (V15)
- [ ] **Trade-Ups**: run a scan, then **execute** a real 10-input contract on a test bot → `ssimConfirm` → verify the output skin.
- [ ] **Storage Units (caskets)**: deposit + withdraw items between inventory and a casket → `ssimConfirm` → verify counts.

### CSFloat (V16)
- [ ] Save an API key (Settings tab) → validates. Then verify each money action on a test listing: **Buy**, **List asset**, **Edit price**, **Delist**, **Create buy order**, **Delete buy order** — each behind its `ssimConfirm`. Clear key → confirm dialog → key removed.

### Ban Checker "Move this Category" (V14)
- [ ] Run a ban check on a folder; if a category has bots, click **"Move this category"** → the Move modal opens ABOVE the ban modal (z-40 > z-30) → move the flagged bots into a quarantine folder.

---

## C. Perf sanity (large fleet)
- [ ] Load a 500+ account environment master. Scroll the item table: virtualization active (no jank), no per-row listeners, and a single balance update (`patchSidebarBalances`) does NOT re-render the whole list.

---

## D. Sign-off
- [ ] All money paths behaved identically to the previous (v1.3.x) build.
- [ ] No native `confirm()`/`alert()` appeared anywhere.
- [ ] No console errors during the walkthrough.
- [ ] Version footer reads **1.4.0** (served from the API, not hardcoded).
