# SSIM — FEATURE INVENTORY (Phase 1 map)

> Read-only audit map. No correctness judgements here — that is `LOGIC_AUDIT.md`.
> Every entry cites `file:line`. Line numbers are from the state of the tree on
> branch `feature/account-login-csfloat` at audit time (v1.3.0).
>
> SSIM = multi-tenant CS2/TF2 Steam inventory, trading & market tool. Express HTTP
> backend (`src/api/server.ts`, 2063 lines) serves a single-page dashboard
> (`public/index.html` + `public/app.js`, 6083 lines). Backend boots through a
> license gate + encrypted account vault before the dashboard server ever listens.

---

## Architecture at a glance

```
Tauri/Edge shell ──stdin/stdout SSIM_PORT──► node backend (src/index.ts boot)
                                                  │
       boot: lock → port → HWID → LICENSE gate → (auto-update) → VAULT unlock → startFullApp
                                                  │
                                   Express app (src/api/server.ts)
        ┌───────────────┬───────────────┬───────────────┬──────────────┬────────────┐
     Accounts/        Inventory/       Market/         Trading       Pricing/    CSFloat
     Sessions/Vault   Items/Refresh    Orders          (trade/buy)   Value/FX    integration
        │               │                │               │              │            │
   AccountManager   InventoryService  MarketService   AccountTrader  PricingSvc  CsFloatService
   SessionManager   InventoryManager  (mylistings)    TradeService   PriceCache  AutoAcceptWorker
   AccountVault     InventoryStore    MarketListings  BuyService     Exchange    RateLimiter
   TokenStore       (gcStore/store)   GcActionLayer   BanService     ValueHistory
```

Persistent state (the "data" folder, `dataDir()`):
`inventories.json` (web cache) · `inventories_gc.json` (full-fetch cache) ·
`inventories_tf2.json` · `prices.json` · `value_history.json` · `cs2-skins.json` ·
`refresh_tokens.json` · `app_settings.json` · `csfloat_keys.json` ·
`license.key/.token/.token.json/.meta.json` · `ssim.lock` · `ssim.port` ·
`Vault/vault.enc` · `Vault/accounts.json`.

---

## Domain A — Accounts, Sessions, Auth & Vault

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| A1 | Boot vault unlock (console / `unlock.html` portal) | Derive AES key, enter VAULT MODE before any credential touch | `unlockVault()` `vaultBoot.ts:63`; `runUnlockPortal()` `unlockPortal.ts:29` | `AccountVault.unlockOrCreate` `AccountVault.ts:89`; scrypt `deriveKey` `AccountVault.ts:76` | `Vault/vault.enc` (0600 +`.bak`) | every credential read |
| A2 | Boot vault migration | Absorb plaintext `accounts.json` + `refresh_tokens.json` into vault, blank plaintext | `migrateAccountsIntoVault()` `vaultBoot.ts:153` | `importAccount` `AccountVault.ts:188`; `enterVaultMode` `AccountManager.ts:153` | `vault.enc`, rewrites `accounts.json`, **deletes** `accounts.json.bak` | A1, all account CRUD |
| A3 | Add account (maFile) — `POST /api/accounts` `server.ts:451` | Register full-tier account with maFile | route `server.ts:451` | `loadMaFileFromDisk` `maFiles.ts:21`; `AccountManager.add` `AccountManager.ts:245`; `upsertAccount` `AccountVault.ts:180` | `db.accounts`, `vault.enc` | A9 login |
| A4 | Import via QR login — `POST /api/accounts/login/qr/start` `server.ts:503` | Mint refresh token via Steam QR, create LIMITED account (no maFile) | `AccountImportService.startQr` `AccountImportService.ts:86` | `LoginSession.startWithQR`; `finalizeImport` `:220` | token store, `db.accounts` (tier='limited') | A9, A12 |
| A5 | Import via credentials — `POST /api/accounts/login/credentials` `server.ts:512` | One-shot password→refresh token (password never persisted) | `startCredentials` `AccountImportService.ts:125`; `submitGuard` `:162` | `LoginSession.startWithCredentials`; `finalizeImport` | token store, LIMITED account | A4, A9 |
| A6 | Attach maFile → upgrade to FULL — `POST /api/accounts/:u/attach-mafile` `server.ts:550` | Give imported account identity_secret; flip tier | route `server.ts:550` | `loadMaFileFromDisk`; `upsertAccount`; `update({tier:'full'})` `:573` | `vault.enc`, `accounts.json` (tier) | A9, Trade-confirm |
| A7 | Edit account — `PATCH /api/accounts/:u` `server.ts:760` | Mutate secrets/proxy/displayName; proxy change forces re-login | route `server.ts:760` | `upsertAccount` `:798`; `logoutAccount` on proxy change `:823` | `vault.enc`, `accounts.json`, session map | A10, A9 |
| A8 | Remove account — `DELETE /api/accounts/:u` `server.ts:864` | Delete record + secrets + cached inventory; logout | route `server.ts:864` | `logoutAccount`; inv store `delete`; `removeAccount` `AccountVault.ts` | `accounts.json`, `vault.enc`, inv caches | inventory, CSFloat key |
| A9 | Session login (lazy, deduped, slot-capped) | Bring account to LOGGED_IN + web cookies, token-first then credential | `loginAccount` `SessionManager.ts:138`→`performLogin` `:288` | `acquire/releaseLoginSlot` `:114`; `TokenStore.get/delete`; `AgentFactory.create` | persists refresh token on event `:352`; emits `loggedIn` | every refresh/trade/ban |
| A10 | Network/proxy resolution (computed, never persisted) | override → env proxy → local IP | `resolveNetwork` `AccountManager.ts:168`; `withNetwork` `:182` | `AgentFactory.create/fromProxy/fromLocalIp` `AgentFactory.ts:60` | attaches `account.network` | A9, LocalIpThrottle |
| A11 | Web-session cookie refresh (20-min timer) | Re-issue cookies on same CM, no IP hop | `refreshWebSession` `SessionManager.ts:644` | dedup `webRefreshInFlight` `:648` | `session.webSession` in place | inventory/trade reads |
| A12 | SteamID write-through cache | Persist steamId on login (rejects lossy maFile value) | `rememberSteamId` `AccountManager.ts:388` | regex guard `/^7656\d{13}$/` | `accounts.json` | A4/A9, BanService |
| A13 | Environments CRUD — `/api/environments*` `server.ts:314-372` | Folder-of-accounts with a shared proxy | `create/update/deleteEnvironment` `AccountManager.ts:200` | `getTree` `:546`; `countInEnvironment` | `db.environments` | A10 (env proxy) |
| A14 | Folders CRUD/move/reorder — `/api/folders*` `server.ts:910-957`, `/move` `:892` | Nested tree of accounts | `create/move/reorder/deleteFolder` `AccountManager.ts:406+` | `isDescendant` cycle guard `:580` | `db.folders/accounts` | dashboard tree |
| A15 | Bulk add array — `POST /api/mafiles/import` `server.ts:1836` | Add many accounts at once | `AccountManager.addMany` `:295` | per-item validate | `db.accounts` (+`save`) | A2 (vault blanking) |
| A16 | Import CSV into vault — `POST /api/import/csv` `server.ts:1792` | Bulk-import farm from CSV | `importCsvIntoVault` `vaultBoot.ts:255` | `parseAccountsCsv` `maFiles.ts:75` | `vault.enc`, `accounts.json` | A2 |
| A17 | Import external vault — `POST /api/import/vault` `server.ts:1811` | Merge another farm's vault | `importExternalVault` `vaultBoot.ts:322` | `decryptExternalVault` `AccountVault.ts:156` | new vault accounts + tokens | A2 |
| A18 | Import drop-zone maFiles — `server.ts:1848` (list `:1829`) | Vault selected `*.maFile` from `./mafiles` | `importDropZoneIntoVault` `vaultBoot.ts:203` | `listDropZoneMaFiles` `maFiles.ts:93` | vault | A2 |
| A19 | Token persistence store | Refresh tokens (vault or `refresh_tokens.json`) | `TokenStore.get/set/delete` `TokenStore.ts:67` | mode-switch on `isEnabled()` | `refresh_tokens.json` (0600) or vault | A9 |
| A20 | App settings (price source, CSFloat flags) — `/api/pricing/source`, `/api/csfloat/config` | Non-secret app prefs | `AppSettings` singleton `AppSettings.ts:26` | get/set price source, experimental, auto-accept | `app_settings.json` | Pricing, CSFloat |
| A21 | CSFloat per-account key — `PUT/DELETE /api/csfloat/:u/key` | Store dev API key in vault | `getCsFloatKey/setCsFloatKey` `AccountVault.ts:226` | debounced save | `vault.enc` (or `csfloat_keys.json`) | CSFloat domain |
| A22 | LocalIpThrottle (per-host-IP guard) | Serialize+jitter no-proxy refreshes | `LocalIpThrottle.run` `LocalIpThrottle.ts:48` | `isLocalIp` `InventoryService.ts:642` | none (RAM) | bulk refresh |

---

## Domain B — Inventory / Items / Refresh (the calibration-bug core)

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| B1 | **CS2 full refresh** — `POST /api/inventory/:u/refresh` (and "Refresh" button) | Assemble COMPLETE inventory: ctx2 + ctx16 + market listings, fully categorised | `refreshOne`→`refreshOneViaGc` `InventoryService.ts:158/198`; `doRefreshOneViaGc` `:209` | `fetchListedItems` `MarketListings.ts:27`; `InventoryManager.fetchRaw/parse/stack` `InventoryManager.ts:52/181/247`; bucket assign `:267` | `gcStore` (`inventories_gc.json`) | B2,B3,C-market, value-history |
| B2 | Cache read (dashboard) — `GET /api/inventory/:u`, `/api/inventory` | Serve cached inventory; GC record preferred over web | `getCached` `InventoryService.ts:133`; `allCs2` `:145` | GC overrides web; deep-copy clone `InventoryStore.ts:100` | none (read) | enrich (pricing) |
| B3 | Partial-read protection / reconcile | Never let an empty/partial Steam read wipe a known-non-empty cache | `reconcilePartialRead` `InventoryService.ts:340`; guards `:243`,`:309` | keep cached owned/locked, re-derive category, reconcile listings | `gcStore` | B1 |
| B4 | Optimistic post-sell cache update | Move assets Owned→Listed immediately after mass-sell | `markListed` `InventoryService.ts:394` | gated on `listedSet` (from `getListedAssetIds`); re-stack | `gcStore` | Mass-sell, B1 |
| B5 | TF2 + buy-verify refresh | Single-context fast fetch (TF2, and buy before/after diff) | `doRefreshOne` `InventoryService.ts:441`; `forceRefresh` `:178` | `fetchInventoryOnly` `InventoryManager.ts:278` | `tf2Store`/`store` | BuyService, TradeUp |
| B6 | Bulk refresh-all — `POST /api/inventory/refresh-all` (status/cancel) | Concurrency-capped fleet refresh with session release | `startRefresh` `:504`; `runRefresh` `:532` | `scaleConcurrency`(5→25); `refreshMaybeThrottled` `:630`; per-account release `:582` | all caches; history snapshot | B1, A9, A22 |
| B7 | Raw inventory fetch (paginated) | Pull ctx2/ctx16 web inventory, follow cursor to end | `InventoryManager.fetchRaw` `InventoryManager.ts:52` | silent cookie renewal `:119`; page-cap 50k `:29` | none | B1, B5 |
| B8 | Parse + trade-lock derivation | Raw assets+descriptions → CS2Item[]; lock from "Tradable After" notice | `parse` `:181`; `mapItem` `:208`; `parseTradeLock` `:373` | owner_descriptions regex; fail-safe `now+7d` `:400` | none | B1, B5 |
| B9 | Stacking | Collapse identical items (same name AND same lock expiry) | `stack` `InventoryManager.ts:247` | key = `name__lockISO` `:252` | none | B1, B5 |
| B10 | Manual protection override (`protectedUntil`) | Operator hand-sets a trade-lock window per account | applied read-time in API layer (`enrichInv`) | `account.protectedUntil` | `accounts.json` | B2 |
| B11 | Post-trade refresh (fire-and-forget) | After a trade, refetch sender+receiver | `refreshAfterTrade` `InventoryService.ts:649` | `Promise.allSettled` | caches | Trade send |
| B12 | Value-history snapshot per refresh | One (worth, wallet) point per env after each refresh | `onRefreshComplete`→`snapshotAll` `ValueHistoryService.ts:148` | `enrich`; `walletUsdCents` `:180` | `value_history.json` | Pricing, FX |

UI rendering (frontend): `renderMain`/`renderAccountView` `app.js:1655`; category pills + counts `renderAccountTabs` `app.js:2401` (`counts` `:2407`); strict 3-bucket table `renderTable` `:1684`.

---

## Domain C — Market / Orders

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| C1 | Listed-items bucket (inventory "Listed on Market") | The 3rd inventory bucket: items currently on sale | `fetchListedItems` `MarketListings.ts:27` | parse `market/mylistings/render`; **skip if no desc / no name** `:62-64` | feeds B1 `listed[]` | B1, C3, C4 |
| C2 | **Active Orders** view — `GET /api/market/orders/:u` `server.ts:1596` | Live sell listings + buy orders tab | `MarketService.getOrders` `MarketService.ts:123`→`getMarketOrders` `AccountTrader.ts:364` | `collectSellOrders` `:1117` (keeps on `listingId&&id&&appId`), `collectBuyOrders` `:1146` | none (live read) | C1, C4 (same endpoint) |
| C3 | Listed-asset-id probe (mass-sell preflight + phantom detect) | Set of asset ids tied to listings (incl. pending) | `getListedAssetIds` `AccountTrader.ts:296` | parses assets-map keys **and** `listings/pending_listings/listings_to_confirm` `:329` | none | mass-sell, B4 |
| C4 | Mass-sell on market — `POST /api/market/sell` (preview/status/cancel) | Each bot lists selected assets, auto-confirms 2FA | `MarketService.startMassSell` `:183`→`processBot` `:301` | `sellOnMarket` `AccountTrader.ts:676`; `confirmMarketListings` `:947`; `markListed` `:440` | real listings; `gcStore` via B4 | C1,C2,C3, pricing |
| C5 | Single sell primitive (no route) | Create one listing at seller-net price | `AccountTrader.sellOnMarket` `:676` | POST `market/sellitem`; returns `{needsConfirmation}` | **writes nothing local** | C4 only |
| C6 | Cancel sell listing — `POST /api/market/cancel-listing` `server.ts:1614` | Remove one listing | `cancelMarketListing` `AccountTrader.ts:420` | POST `market/removelisting/<id>` | none (cache catches up next refresh) | C2 |
| C7 | Cancel buy order — `POST /api/market/cancel-buy-order` `server.ts:1631` | Remove one buy order | `cancelBuyOrder` `AccountTrader.ts:456` | POST `market/cancelbuyorder/` | none | C2 |
| C8 | Buy-modal live lowest ask — `GET /api/market/buy-price` `server.ts:1484` | Live lowest ask in account's native wallet currency | `MarketService.lowestAsk`→`MarketPricing.getLowestAsk` `MarketPricing.ts:138` | `priceoverview` in native currency | none | Buy, Pricing |

---

## Domain D — Trading (trade offers, buy, casket, trade-up, bans, GC)

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| D1 | Send trade — `POST /api/trade/send` `server.ts:1169` | One offer, auto-confirm 2FA | `TradeService.sendTrade` `:371`→`AccountTrader.sendTrade` `:608` | `createOffer/send`; `confirmOffer` `:660`; `inFlight` guard `:376` | real offer; deferred `refreshAfterTrade` | B11, mass-send |
| D2 | Mass-send (folder→storage) — `POST /api/trade/mass-send` `server.ts:1241` | Every bot sends selected assets to one URL | `startMassSend` `:415`→`runMassSend` `:444` | concurrency=1 `:50`; `sendTrade` | N offers; `massJob` | D1 |
| D3 | Auto-accept internal offers (event) — toggle `POST /api/trade/auto-accept` | Accept incoming offers from managed SteamIDs | `handleNewOffer` `TradeService.ts:517` | `isManagedSteamId` `:543`; `acceptOffer` | accepts offer | sessions set |
| D4 | Manual accept/decline/cancel (+batch) — `/api/trade/offer-action`, `/offers-batch` | Operator acts on offers | `offerAction` `:286`; `batchOfferAction` `:299` | `acceptTradeOffer`/`cancelOrDeclineOffer` `AccountTrader.ts:584/572` | offer state | sessions |
| D5 | Read trade offers — `POST /api/trade/offers` `server.ts:1346` | Aggregate sent+received, priced | `getOffersForAccounts` `:246`→`getTradeOffers` `AccountTrader.ts:500` | `shapeOffers`/`toOfferView`; release read sessions `:270` | none | pricing |
| D6 | Buy (single) + verify — `POST /api/market/buy` `server.ts:1542` | Place buy order, confirm, verify by inv/wallet diff | `BuyService.buy` `:148`→`createBuyOrder` `AccountTrader.ts:729` | `forceRefresh` before/after `:170/212`; ceilings `:185/191` | real order; inv cache ×2 | B5, money-safety |
| D7 | Mass-buy (folder) — `POST /api/market/folder-buy` `server.ts:1652` | Max each account's buy of one item | `startMassBuy` `:281`→`massBuyOne` `:392` | balance/ceiling math `:419` | real orders; caches | D6 |
| D8 | Storage unit (casket) list/read — `/api/casket/*` `server.ts:1753+` | Read storage-unit contents (GC) | `CasketService.listCaskets/contents` `CasketService.ts:43` | `GcActionLayer.listCaskets` `:242` | none | GC |
| D9 | Casket deposit/withdraw — `POST /api/casket/move` `server.ts:1770` | Move items in/out, verify-after | `startMove` `:56`→`moveCasketItems` `GcActionLayer.ts:268` | `verifyMove` poll `:310`; 1000-cap | real moves; **no cache write** | GC, D10 |
| D10 | Trade-up candidates (preview) — `POST /api/tradeup/candidates` `server.ts:1723` | Compute +EV contracts | `getCandidates` `TradeUpService.ts:153` | `forceRefresh` `:158`; skips `category==='listed'` `:251`; `computeContract` `tradeupMath.ts:112` | inv cache; warms prices | B5, pricing, GC |
| D11 | Trade-up execute (gated) — `POST /api/tradeup/execute` `server.ts:1735` | Craft 10-input contracts (irreversible) | `startExecute` `:100`→`craftTradeUp` `GcActionLayer.ts:330` | re-verify inputs live; `go.craft` once `:362` | destroys items; **no cache write** | GC, D9 |
| D12 | Ban check — `POST /api/bans/check` `server.ts:1695` | Classify VAC/game/community/economy via GetPlayerBans | `BanService.checkBans` `BanService.ts:150` | `resolveSteamId` `:393`; mints Web API key `createKey` `:492` | **creates real API key**; caches key | sessions, env keys |
| D13 | GC action layer (shared) | Per-account GC connect/guard/teardown | `GcActionLayer.withSession` `:182` | connect 730 → fn → disconnect (finally) | GC connection | D8-D11 |

---

## Domain E — Pricing, Currency, Value

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| E1 | Per-item price lookup | Fresh cached USD-cents price for active source | `PricingService.priceCents` `PricingService.ts:84` | `activeSource` `:56`; `cacheKey` `:78`; TTL 24h `:10` | none | E2,E5 |
| E2 | Background price fill (throttled) | Fetch missing/stale prices off request path | `ensureFilled` `:112`→`run` `:132` | `SteamPriceSource`/`CsFloatPriceSource` fetch; backoff | `prices.json` | E1,E5 |
| E3 | Price-source select (Steam⟷CSFloat) — `PUT /api/pricing/source` `server.ts:597` | Switch provider; fall back to Steam if no CSFloat key | `setSource` `:68`; `activeSource` `:56` | `AppSettings.setPriceSource`; clears queue | `app_settings.json` | E1,E2,CSFloat |
| E4 | Per-item enrich + per-inventory total | Set `item.price` + `inv.totalValueUsd` | `PricingService.enrich` `:96` | TTL check `:103`; `cents*qty` `:105` | mutates in-memory inv | E1, value-history, UI |
| E5 | Inventory total display (stat + masters) | Show worth/wallet in display currency | `setMoneyStats` `app.js:668`; `aggregate` `:2231`; `stackValueCents` `:551` | sum `totalValueUsd` **or** recompute from items | DOM | E4, E6 |
| E6 | Currency select (USD⟷EUR display) | Toggle display currency | `setCurrency` `app.js:609`; `fmtUsd` `:514` | `*state.usdToEur` | `localStorage` | E5, E7 |
| E7 | Exchange-rate fetch + cache (USD→EUR) | Maintain live FX; fallback 0.92 | `ExchangeRateService.refresh` `:28`; `getUsdToEur` `:13` | frankfurter API; in-memory only | none (RAM) | E6, value-history |
| E8 | Value-history read/chart — `/api/history/:id`, `/api/history/aggregate` | Serve worth/wallet curve | `ValueHistoryService.get/aggregate` `:99/112` | carry-forward across series | none | B12 |
| E9 | CS2 schema lookups | Skin collections/rarities/floats for trade-up | `Cs2SchemaService.ensureLoaded` `:74` | disk cache→ByMykel API; index | `cs2-skins.json` | D10 |

---

## Domain F — CSFloat integration

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| F1 | Set/remove key — `PUT/DELETE /api/csfloat/:u/key` | Validate against `/me`, persist per-account key | `CsFloatService.setKey/clearKey` `CsFloatService.ts:41/60` | `validateKey`; `CsFloatKeyStore.set` (vault or file) | `vault.enc`/`csfloat_keys.json` | A21, F4-F7 |
| F2 | Key status (masked) — `GET /api/csfloat/:u/key` | configured + last4 | `keyInfo` `:33` | `KeyStore.get` | none | F1 |
| F3 | Client ops — `/api/csfloat/:u/{me,listings,buy,…}` `server.ts:638-692` | Browse/list/edit/delist/buy on CSFloat | `clientFor` `:109`→`CsFloatClient.req` `Client.ts:138` | per-key client cache; money mutations | network (money) | F6 rate-limit |
| F4 | Experimental ops (flag-gated) — buy-orders/trades/inventory `server.ts:695-729` | Undocumented endpoints, opt-in | `requireExperimental` `server.ts:610` | gate on `isCsfloatExperimental` | network | A20, F8 |
| F5 | Pricing client selection | One client for app-wide CSFloat pricing (first keyed account) | `pricingClient` `CsFloatService.ts:88` | `usernamesWithKeys().sort()[0]` | caches `pricing` | E2, F6 |
| F6 | Rate limiter (per API key) | Keep one key under CSFloat limit; priority bands | `RateLimiter.schedule` `RateLimiter.ts:25`; `limiterFor` `Client.ts:70` | static map keyed by raw key; 1-flight, ≥600ms | order only | F3,F4,F5 |
| F7 | CSFloat as price source | Price CS2 from lowest buy-now ask | `CsFloatPriceSource.fetchPriceCents` `CsFloatPriceSource.ts:22` | `searchListings(lowest_price,limit:1)` | `prices.json` (`csfloat:` key) | E2,E3 |
| F8 | Auto-accept worker (auto-deliver sales) — toggle `PUT /api/csfloat/:u/auto-accept` | Poll pending CSFloat sales, deliver via Steam trade | `CsFloatAutoAcceptWorker.start/runOnce/deliverFor` `Worker.ts:36-98` | 45s poll; `trades(pending)`; `TradeService.sendTrade` | **real Steam offers**; in-proc `delivered` Set | D1 (TradeService), F6 |

---

## Domain G — Licensing, Updater, Boot, Process health

| # | Feature / trigger | Purpose | Entry point(s) | Core logic | Writes | Coupled with |
|---|---|---|---|---|---|---|
| G1 | Single-instance lock | One SSIM at a time | `acquireInstanceLock` `index.ts:59` | PID + image-name (`tasklist`) check | `data/ssim.lock` | G11 |
| G2 | Free-port selection + sidecar publish | Bind free port, announce to shell | `findFreePort` `index.ts:85`; `publishPort` `:124` | stdout `SSIM_PORT=` + `ssim.port` | `data/ssim.port` | shell handshake |
| G3 | HWID fingerprint | Salted machine id binding a seat | `HwidService.getHwid` `HwidService.ts:65` | HMAC(machine-id+host+mac+cpu, PEPPER) | none | G4-G7 |
| G4 | License gate (boot) | Allow vs must-(re)activate | `validate` `LicenseClient.ts:199` | token verify + grace math + online recheck | meta | G5-G10 |
| G5 | Token verify (offline) | Ed25519 sig + shape validation | `verifyToken` `LicenseClient.ts:135` | `LICENSE_PUBLIC_KEY` | none | G4 |
| G6 | Online recheck + heartbeat (45min) | Revoke/extend between beats | `onlineRecheck` `:249`; `heartbeat` `:283` | `/validate`,`/heartbeat`; `handleRevoked` | `license.token/.meta` | G4, G7 |
| G7 | Offline-grace + clock-rollback meta | Anchor grace to last contact; refuse rollback | `readMeta/markOnline/bumpClock` `:94-123` | HMAC'd `maxSeenMs`/`lastOnlineMs` | `license.meta.json` | G4 |
| G8 | Activation portal — `POST /api/license/activate` | License-entry page until valid key | `runActivationPortal` `ActivationServer.ts:28` | `saveKey`; `activate` | `license.key/.token` | G4, boot |
| G9 | Runtime revocation → re-activate | Teardown + return to portal | `onLicenseLost` `index.ts:275`; `handleRevoked` `:310` | `teardownFullApp`; `clearToken`; `gateAndRun` | clears token; logs out sessions | G6, G8 |
| G10 | Auto-update (boot gate) | Check/download/verify/self-test/swap | `maybeAutoUpdate` `index.ts:222`→`Updater.runUpdate` | `check/download/verify/selfTestNewExe/swapAndRelaunch` `Updater.ts` | tmp exe, swap `.bat`/`.vbs` | boot, cross-version data |
| G11 | Boot orchestration / shutdown | Phase ordering; graceful logout | `bootstrap` `index.ts:293`; `shutdown` `:342` | lock→port→hwid→license→update→vault→startFullApp | globals | all |
| G12 | App window lifecycle | Open dashboard (no-op when packaged) | `openUiWindow` `appWindow.ts:15` | dev browser / Tauri owns window | none | portals, startFullApp |
| G13 | Crash log + stderr tee + heap report | Synchronous last-words for silent deaths | `writeCrash` `crashlog.ts:44`; `bootflags.ts:14` | append `crash-log.txt`, `exit-trace.log`, `stderr-trace.log` | logs | G11 |
| G14 | Memory heartbeat | rss/heap/handles sample per 15s | `startMemHeartbeat` `memHeartbeat.ts:100` | fleet counts; loop-stall flag | `mem-heartbeat.log` | startFullApp |
| G15 | Process-health watchdog (money breaker) | Quarantine money ops after 3 uncaught/60s | `recordUncaught`/`moneyOpsBlocked` `ProcessHealth.ts:30/42` | latches; restart-only reset | RAM | money POST middleware `server.ts:301` |
| G16 | System/health routes — `/api/system/status`, `/api/health` | Report licensed/version/stable | route `server.ts:1886/1891` | `stable=!moneyOpsBlocked()` | none | UI guard |

---

# STATE CATALOG

Every entity, the full set of states/buckets it can occupy, and the EXACT code that decides each.

### Account
| State / attribute | Values | Decided at |
|---|---|---|
| tier | `limited` \| `full` \| absent(→full) | set `AccountImportService.ts:232` / `server.ts:573`; read default `account.ts:96` |
| can-confirm (runtime) | yes/no | **`maFile.identity_secret`** `LoginFlow.ts:19`; route guard `server.ts:560` (⚠ second source vs tier) |
| storage backend | vaulted \| orphan(plaintext) | `AccountVault.hasAccount` `AccountVault.ts:177` → `enterVaultMode` blanking `AccountManager.ts:155` |
| enabled / hidden | bool | `accounts.json`; filtered in worker/UI |
| steamId known | string \| undefined | `rememberSteamId` `AccountManager.ts:388` |
| network | `proxy` \| local | `resolveNetwork` `AccountManager.ts:168` |

### Session (`ManagedSession.state`, `types/session.ts:7`)
`DISCONNECTED · CONNECTING · LOGGING_IN · LOGGED_IN · ERROR · RATE_LIMITED`
- transitions in `SessionManager.transition` `:608`; CONNECTING `:317`, LOGGING_IN `:408`, LOGGED_IN `:401`, ERROR `:337/462`, DISCONNECTED `:469/600`.
- **`RATE_LIMITED` is declared but never assigned** (dead state) — rate limits classified as `connection`/`ERROR` `SessionManager.ts:81`.
- Derived: `isLive = LOGGED_IN || LOGGING_IN` `:553`; `isReady = LOGGED_IN && webSession` `:618`.

### Inventory Item (`CS2Item`, `types/inventory.ts:24`)
| Attribute | Values | Decided at |
|---|---|---|
| **category** (the 3 buckets) | `listed` \| `tradelocked` \| `tradable` | `InventoryService.ts:267` (and duplicated `:360`, `:412`) |
| tradable (raw flag) | bool | `InventoryManager.mapItem:223` (`desc.tradable===1`) |
| tradeLockExpiry | Date \| null | `parseTradeLock` `InventoryManager.ts:373` (fail-safe `now+7d` `:400`) |
| source | `web` \| `gc` | set in `doRefreshOne` (web) vs `doRefreshOneViaGc` (`source:'gc'` `:260`) |
| listed membership | in/out | `listedAssetIds` from **`fetchListedItems` only** `InventoryService.ts:228` |

> ⚠ **The same "listed" fact is decided by three parsers**: `fetchListedItems` (bucket, `MarketListings.ts:62`), `collectSellOrders` (Active Orders, `AccountTrader.ts:1126`), `getListedAssetIds` (mass-sell, `:324`). See Sources-of-Truth.

### Order / Listing
| Entity | States | Decided at |
|---|---|---|
| Sell listing | active \| pending-confirm | `collectSellOrders` `AccountTrader.ts:1117`; created `sellOnMarket:676` |
| Buy order | resting | `collectBuyOrders` `:1146` |
| Trade offer | Active \| CreatedNeedsConfirmation \| InEscrow \| (history) | `isActiveOfferState` `AccountTrader.ts:1054` |
| Send outcome | sent \| confirmed \| unconfirmed | `sendTrade` `:622-643` |
| Buy outcome | placed/confirmed \| needsConfirmation \| filled/verifyFailed | `createBuyOrder` `:794`; `BuyService.ts:219` |

### Refresh job (`RefreshJob`, `InventoryService.ts:66`)
`running · cancelling · cancelled` + `done/total/failed[]`.

### License (`validate` result, `LicenseClient.ts:199`)
`token-valid · offline-grace · expired(no-key/activate) · activated · seat-in-use · unknown-key · hwid-mismatch · key-mismatch · revoked · clock-rollback-refused · no-meta-refused` — table of deciders in `LOGIC_AUDIT.md §G`.

### Import session (`AccountImportService`)
`waiting · scanned · guard · approved · imported · expired · error` — `wireEvents:199`, `prune:283`.

### Update
`check → download → verify → self-test → swap(4 shapes) → relaunch` — `Updater.ts`.

---

# SOURCES-OF-TRUTH TABLE

For each derived value: the ONE source it should have, and EVERY place it is actually computed. Rows flagged ⚠ are computed in >1 place (single-source-of-truth violations — detailed in `LOGIC_AUDIT.md`).

| Derived value | Should be | Actually computed in | Flag |
|---|---|---|---|
| **"what is listed on market"** (asset ids + rows) | one parse of `market/mylistings/render` | `fetchListedItems` `MarketListings.ts:33` · `collectSellOrders` `AccountTrader.ts:1117` · `getListedAssetIds` `AccountTrader.ts:296` (3 parsers, 3 acceptance rules) | ⚠⚠⚠ |
| **"Listed on Market" count vs "Active Sell Orders" count** | the same set | bucket count `app.js:2407` (from `fetchListedItems`) vs orders count `app.js:1756` (live `collectSellOrders`) | ⚠ |
| **item.category** | one derivation | `InventoryService.ts:267` · `:360` (reconcile) · `:412` (markListed) | ⚠ |
| owned/locked count | one place | `InventoryService.ts:262` · `:313` · `:375` · `:401` · `app.js:2407` | ⚠ |
| **"can account confirm"** | `maFile.identity_secret` | `account.tier` (label) · `maFile.identity_secret` (runtime) · `session.maFile` (loaded-at-login) | ⚠ |
| per-account proxy | one store | vault `proxy` `AccountVault.ts:36` vs `accounts.json.networkOverride`; re-read in `resolveNetwork:168`, `GET /proxy:844`, `PATCH:773` | ⚠ |
| refresh token | one store | `refresh_tokens.json` `TokenStore.ts:8` vs vault `payload.tokens` `AccountVault.ts:43` (file left after migration) | ⚠ |
| `totalValueUsd` (view total) | backend enrich | `PricingService.enrich` `:100` · `aggregate` sums it `app.js:2231` · `stackValueCents` recompute `app.js:1501/1569` | ⚠ |
| usdToEur FX rate | one source | `ExchangeRateService` (server, value-history `:183`) vs `state.usdToEur` (client snapshot `app.js:451`) | ⚠ |
| EUR display total | one rounding point | per-item round `app.js:2689` vs whole-total round `app.js:520` (Σround ≠ roundΣ) | ⚠ |
| CSFloat key presence | `CsFloatKeyStore` | `hasKey` `:31` · `usernamesWithKeys` `:89` · `available` `CsFloatPriceSource:20` (all delegate — OK) | ✓ |
| "is licensed" (client) | `LicenseClient.validate` | `validate` (crypto) vs `/api/system/status` `{licensed:true}` positional `server.ts:1886` vs portal constructs | ⚠ |
| `maxSeenMs` (clock anchor) | server time | advanced from local `Date.now()` on every valid boot `LicenseClient.ts:120` | ⚠ |
| trade-lock truth | Steam owner_descriptions | `parseTradeLock` `:373`; but `now+7d` placeholder on parse-fail `:400` makes it non-deterministic | ⚠ |
| update swap shape (`kind`) | signed by server | `info.kind` read but **outside** the Ed25519 signature `Updater.ts:48` | ⚠ |

> The single most consequential row is the first: three independent parsers of one
> Steam endpoint, feeding three different consumers (inventory bucket, Active Orders
> tab, mass-sell pre-flight), with no shared canonical model. That is the structural
> root of the field bug. See `CONTRADICTIONS.md` C1/C2 and `LOGIC_AUDIT.md §B/§C`.
