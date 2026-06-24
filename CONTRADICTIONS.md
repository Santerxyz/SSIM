# SSIM — CONTRADICTIONS

> Every **impossible state** the system can currently represent — a state that
> contradicts another part of the system or reality. Each is PROVEN from code
> (file:line) unless marked HYPOTHESIS (mechanism proven; field trigger needs a
> runtime check). Ordered by severity. Full traces + fixes in `LOGIC_AUDIT.md`.
>
> "Impossible state" = two views/values that cannot both be true, yet both can be
> produced by the code as written.

---

## Remediation progress (Phase 3)

CRITICAL · `C1 ☑` `C2 ☑`
HIGH · `C3 ☑` `C4 ☑` `C5 ☑` `C6 ☐` `C7 ☑` `C8 ☑`
MEDIUM · `C9 ☐` `C10 ☐` `C11 ☐` `C12 ☐` `C13 ☐` `C14 ☐` `C15 ☐` `C16 ☐` `C17 ☐` `C18 ☐`
LOW · `C19 ☐` `C20 ☐` `C21 ☐` `C22 ☑`

☑ = fixed + covered by a test in `test/` (run `npm test`).
- Batch 1 — canonical MarketListing model: C1–C4, C7, C22 (`test/marketModel.test.ts`, `test/inventoryDeterminism.test.ts`).
- Batch 2 — account capability/recovery: C5, C8 (`test/accountCapability.test.ts`).

---

## ★ THE FIELD BUG — fully explained

> Reported: items show **Owned + trade-locked**, **count 0 in "Listed on market"**,
> yet appear under **"Active orders."** Deleting the `data` folder did **not** fix
> it. → A logic (derivation) defect, not stale cache. Confirmed below as **C1+C2+C3**
> acting together. Re-fetching reproduces it because the parsers are deterministic.

---

### C1 — "Listed on Market" count and "Active Sell Orders" disagree for the same listing — **CRITICAL · PROVEN**
The inventory **Listed** bucket and the **Active Orders** tab are two different parsers of the *same* Steam endpoint `market/mylistings/render`:
- `fetchListedItems` **drops** a listing when its asset has no entry in the page's `assets` map, or the description has no name: `if (!desc) continue` / `if (!desc.market_hash_name && !desc.name) continue` — `MarketListings.ts:62-64`.
- `collectSellOrders` **keeps** the same listing (desc defaults to `{}`, name → "Unknown") on just `listingId && id && appId` — `AccountTrader.ts:1126`.

So a listing Steam reports without a usable `assets`-map description is **0 in "Listed"** (bucket count `app.js:2407`) but **present in "Active Sell Orders"** (count `app.js:1756`). The UI even documents the split: the Active Orders view is *"independent of the inventory cache – orders are always pulled live"* (`app.js:1698`).
**Breaks INV-B3.** Same Steam reality, two answers.

### C2 — The same asset is Owned **and** an Active sell order — **CRITICAL · PROVEN**
The inventory refresh excludes listed assets using **only** `fetchListedItems`' ids:
`listedAssetIds = listed.flatMap(...)` `InventoryService.ts:228`, then
`ownedLockedRaw = [...ctx2, ...ctx16].filter(i => !listedAssetIds.has(i.assetId))` `:257`.
If `fetchListedItems` skipped the listing (C1), its asset id is **not** in `listedAssetIds`, so when that asset is still returned by the inventory contexts (pending/unconfirmed listing, or Steam eventual-consistency), it survives the filter and is bucketed Owned → `tradelocked`/`tradable` at `:267`. Meanwhile `collectSellOrders` lists it under Active Orders.
Net: **Owned (+trade-locked) AND Active sell order AND Listed=0** — the exact field triple. **Breaks INV-B1, INV-B6.**

### C3 — A trade-locked item carries a market sell listing — **HIGH · PROVEN (path) / HYPOTHESIS (Steam outcome)**
Steam forbids listing a trade-locked item, so `{tradelocked} ∩ {sell listing} = ∅` should hold (INV-B2). But:
- The sell path performs **no** trade-lock check: `sellOnMarket` validates only sessionid+price `AccountTrader.ts:678-680`; `processBot`/`listWithRetry` pass whatever assets the request carried `MarketService.ts:340-396`.
- So SSIM will *attempt* to list a locked item. If Steam leaves it pending/needs-confirmation (rather than hard-rejecting), the item stays in inventory (locked) while `collectSellOrders` surfaces a sell row → a trade-locked item with an "active" sell order. **Breaks INV-B2, INV-D1.**

> **C1+C2+C3 together** are the masterpiece finding: three parsers of one endpoint
> (`fetchListedItems` strict, `collectSellOrders` lenient, `getListedAssetIds`
> most-lenient `AccountTrader.ts:324`), no shared canonical model, and no lock guard
> on the sell path. A `data`-folder wipe cannot fix it because the divergence is in
> the *derivation*, not the *cache*.

---

### C4 — The "tradable" bucket contains items that are `tradable: false` — **HIGH · PROVEN**
`category` is derived **only** from `tradeLockExpiry`, never from the raw `tradable` flag:
`it.category = (tradeLockExpiry > now) ? 'tradelocked' : 'tradable'` `InventoryService.ts:267`.
An item that is non-tradable for any reason **other** than a parsed "Tradable After" hold (e.g. an untradable item type, or a hold whose date didn't parse and isn't future) has `tradable:false` (`InventoryManager.ts:223`) but `tradeLockExpiry:null` → it lands in **"Owned Items / tradable."** The operator then selects it to sell/send and Steam rejects it. **Breaks INV-B4.**

### C5 — A "Full" account that cannot confirm — **HIGH · PROVEN**
"Can this account confirm trades" is decided by **two** independent fields:
runtime truth = `maFile.identity_secret` (`LoginFlow.ts:19`, route guard `server.ts:560`);
UI/persisted truth = `account.tier` (`account.ts:96`).
They can disagree: a vault account whose maFile lacks `identity_secret` but `tier==='full'`; and immediately after `attach-mafile` (`server.ts:550-576`) the **persisted** tier flips to `full` but the **live** `session.maFile` is still `undefined` (loaded at login, before the attach; no re-login, no token refresh) — so a confirm in that window fails though the UI says Full. **Breaks INV-A1.**

### C6 — CSFloat sale delivered twice (double item send) — **HIGH · PROVEN (mechanism)**
Auto-delivery dedup is an **in-process** Set populated *after* a successful send: `this.delivered` `CsFloatAutoAcceptWorker.ts:26,95`. It is not persisted. If the app restarts after delivering but before CSFloat's trade leaves `state==='pending'`, the next pass re-fetches the same pending sale and calls `sendTrade` again. `TradeService.inFlight` is also in-process and only blocks *concurrent* identical sends, not sequential cross-restart ones. → a second real Steam offer for one CSFloat sale. **Breaks INV-D5/INV-F1.**

### C7 — An item is optimistically "Listed", then reverts to "Owned" while still listed on Steam — **HIGH · PROVEN (mechanism)**
After mass-sell, `markListed` moves assets Owned→Listed in the cache, gated on `getListedAssetIds` (`MarketService.ts:439`, `InventoryService.ts:394`). The next full refresh re-derives "listed" from `fetchListedItems` (stricter, C1). If it skips that listing, the asset is moved **back** to Owned even though it's still listed on Steam — the bucket flip-flops every refresh. Also: `markListed` takes **no lock** and read-modify-writes `gcStore` (`:397→434`) concurrently with a refresh → lost-update race. **Breaks INV-B8, INV-B13.**

### C8 — A registered account with no way to log in — **HIGH · PROVEN**
On a token auth-failure SSIM deletes the stored token, then falls through to credential login: `tokenStore.delete()` … then credential path `SessionManager.ts:206-220`. For a **LIMITED** account (imported via QR/credentials: no maFile, blank password), the deleted refresh token was its *only* credential → `doLoginAccount` then throws "maFile required." The account is unrecoverable without re-import. **Breaks INV-A2.**

---

### C9 — Unconfirmed listing/offer counted as done — **MEDIUM · PROVEN**
If `sellOnMarket` succeeds but `confirmMarketListings` ultimately fails, the run still counts the items listed (`job.listed`, `pendingForBot` `MarketService.ts:370-373`) and still calls `markListed` `:440` — the cache shows **Listed** while the listing is **unconfirmed/pending** on Steam (item effectively still held). Same shape for `sendTrade`→`unconfirmed` (`AccountTrader.ts:640`) and buy→`needsConfirmation` (`:856`). Cache-vs-Steam divergence with no reconciling record but a later refresh. **Breaks INV-D4.**

### C10 — A trade-locked skin selected as a trade-up input — **MEDIUM · HYPOTHESIS**
`buildEligibleInputs` excludes `category==='listed'` but **not** `'tradelocked'` (`TradeUpService.ts:251`). A locked skin is eligible; the only backstop is the live GC presence re-verify (`GcActionLayer.ts:341`), which checks presence, not lock. A locked item is still in the GC inventory, so a craft could be submitted on it. **Breaks INV-D6** (Steam may reject; app does not pre-filter).

### C11 — Buy reports a fill it didn't get (or misses one it did) — **MEDIUM · PROVEN (mechanism)**
`filled = ownedAfter − ownedBefore` from two `forceRefresh` reads (`BuyService.ts:219`). If the "after" read trips the partial-read protection (`InventoryService.ts:310`), `ownedAfter` reflects the *prior cache*, not the true post-buy inventory → mis-reported fill count. Money-safety (never throw) is preserved, but the reported number is derived from a value with a known soft spot. **Breaks INV-D3.**

### C12 — Cached inventory presented as complete when it is truncated — **MEDIUM · PROVEN**
`fetchRaw` stops at the 25-page / 50k-item cap and logs an error, but still returns the partial set; `doRefreshOneViaGc` does not check `hitPageCap` and caches it with `fromCache:false` (`InventoryManager.ts:167`, `InventoryService.ts:321`). The error log advises "trust the GC inventory" — but there **is no GC inventory anymore** (the method is legacy-named; comment `InventoryService.ts:195`). Orphan assets (no description) are also silently dropped (`InventoryManager.ts:195`). The operator gates trade/sell on an under-count. **Breaks INV-B9, INV-B10.**

### C13 — A valid offline license locked out by a clock change — **MEDIUM · PROVEN**
`maxSeenMs` is advanced from local `Date.now()` on every signature-valid boot (`LicenseClient.ts:120,210`) and HMAC-persisted. A single forward clock jump while a valid token is loaded writes a far-future `maxSeenMs`; on return to true time, `now < maxSeenMs − skew` (`:224`) becomes true and **offline grace is refused** for a legitimately-licensed user until they get online. Fail-closed, but a real lockout of a paying user. **Breaks INV-G2.**

### C14 — Update mis-placed/bricked via the unsigned `kind` flag — **MEDIUM · PROVEN (path)**
The Ed25519 signature covers `${latest}:${sha256}` only; `info.kind` (the swap-shape selector) is **outside** it (`Updater.ts:48-51,204`). A MITM that cannot forge the signature can still flip `kind:'backend'→'single-exe'`; on a two-file sidecar with a sibling `SSIM.exe`, the swap then overwrites the GUI shell with the authentic backend artifact **and deletes the running backend** (`deletePaths:[process.execPath]` `:319`) → a broken install. The migration swap also runs the orphan-delete unconditionally after the move loop (no swap-success gate, `:283-288`). **Breaks INV-G3.**

---

### C15 — "experimental off" still auto-delivers — **MEDIUM · PROVEN**
Enabling auto-accept requires the experimental flag ON (route gate `server.ts:736`), but the worker loop checks only `AppSettings.autoAcceptUsernames()` (`Worker.ts:51`), never `isCsfloatExperimental()`. Turning the flag off does **not** clear the persisted per-account toggles, so already-armed accounts keep delivering. **Breaks INV-F2.**

### C16 — A session "ready" with dead cookies — **MEDIUM · HYPOTHESIS**
`isReady` checks only that `webSession` is *present*, not its `obtainedAt` age (`SessionManager.ts:618`); `ensureWebSession` uses `hasLiveSessionId`, not age. A session whose cookies expired before the 20-min proactive refresh fires is treated as ready/live → an inventory/market call on stale cookies. **Breaks INV-A5.**

### C17 — A bulk refresh tears down (or fails to release) a session it shouldn't — **MEDIUM · HYPOTHESIS**
"Release only sessions we created" samples `wasLiveBefore = isLive(username)` before touching the account (`InventoryService.ts:569`), and `isLive` returns true for `LOGGING_IN` (`SessionManager.ts:555`). If another op has a login in flight at snapshot time, the boolean is wrong → either a leaked session (never released) or a torn-down session another op owns. **Breaks INV-A6.**

### C18 — Plaintext secrets persist in vault mode — **MEDIUM · PROVEN**
`addMany` (bulk add, `/api/mafiles/import` → `AccountManager.ts:295`) pushes `password: item.password` and `save()`s; `save()` only blanks accounts where `AccountVault.hasAccount(username)` is true (`:121-123`), but `addMany` never vaults → plaintext passwords written to `accounts.json` despite vault mode. Also `refresh_tokens.json` is deliberately left on disk after migration (`vaultBoot.ts:181`). **Breaks INV-A3.**

---

### C19 — Two client totals for one inventory — **LOW · PROVEN**
The headline worth is computed two ways on the client: `aggregate()` sums backend `inv.totalValueUsd` (`app.js:2231`), while folder/selected masters recompute from deduped items via `stackValueCents` (`app.js:1501,1569`). They diverge when cache/source state differs between the per-account enrich and the merged recompute. **Breaks INV-E3.**

### C20 — Same balance, two EUR numbers — **LOW · PROVEN**
USD→EUR is converted server-side with `ExchangeRateService.getUsdToEur()` (value-history `:183`) and client-side with `state.usdToEur` (a one-time snapshot `app.js:451`); the two copies drift after the rate updates. And per-item rounding (`app.js:2689`) vs whole-total rounding (`:520`) gives `Σround ≠ roundΣ`. The 0.92 fallback rate is shown without any "stale/fallback" flag (`/api/exchange-rate` drops `fallback`/`ageMs` `server.ts:1027`). **Breaks INV-E4, INV-E5.**

### C21 — A value-history point silently overwritten — **LOW · PROVEN**
`append` merges any point within 60s into the previous one (`ValueHistoryService.ts:191`), and `snapshotAll` re-snapshots **both** games each call (`:153`) — so a TF2-only refresh rewrites the CS2 series' latest point if within the window. Last-writer-wins on the curve. **Breaks INV-E6.**

### C22 — Stack identity churns across refreshes — **LOW · PROVEN**
When a trade-lock notice is present but its date is unparseable, `parseTradeLock` returns `now + 7 days` (`InventoryManager.ts:400`); `stack()` keys on `tradeLockExpiry.toISOString()` (`:252`), so the stack key changes every refresh → unstable stacking/counts for that item. **Breaks INV-B7 (determinism).**

---

## Severity tally

| Severity | Contradictions |
|---|---|
| **CRITICAL** | C1, C2 |
| **HIGH** | C3, C4, C5, C6, C7, C8 |
| **MEDIUM** | C9, C10, C11, C12, C13, C14, C15, C16, C17, C18 |
| **LOW** | C19, C20, C21, C22 |

The four CRITICAL/HIGH market findings (C1–C4, C7) collapse to **one** structural
root: no canonical model for "what is listed," and `category` derived from a single
flag. The single fix in `INVARIANTS.md` §1–2 retires all of them at once.
