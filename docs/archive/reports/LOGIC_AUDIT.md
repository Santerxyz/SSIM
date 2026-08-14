# SSIM — LOGIC DEEP-DIVE (Phase 2)

> Per-feature end-to-end traces, the invariants each must preserve, and every way
> the trace can break them. Each violation carries **SEVERITY · PROOF (file:line) ·
> ROOT CAUSE · MINIMAL FIX**. Finding IDs are referenced by `INVARIANTS.md` and
> `CONTRADICTIONS.md`. PROVEN = the contradiction is visible in code as written;
> HYPOTHESIS = mechanism proven, field trigger needs a runtime check.
>
> Read order: **§B/§C first** (the calibration bug), then A, D, E, F, G.
> Nothing here has been changed — read-only audit pending your approval.

---

# §B / §C — INVENTORY BUCKETS & MARKET LISTINGS (the core)

## Process trace — "Refresh" on a CS2 account

```
User clicks Refresh
 → POST /api/inventory/:u/refresh
 → InventoryService.refreshOne → refreshOneViaGc → doRefreshOneViaGc  (InventoryService.ts:209)
     1. listed   = stack(fetchListedItems(session))           MarketListings.ts:27   ← PARSER #1 (strict)
        listedAssetIds = Set(listed.assetIds)                  InventoryService.ts:228
     2. ctx2  = parse(fetchRaw(session,'cs2',2))               InventoryManager.ts:52,181
        ctx16 = parse(fetchRaw(session,'cs2',16))
     3. ownedLockedRaw = [...ctx2,...ctx16].filter(¬listedAssetIds.has)   :257
        for each stack: category = tradeLockExpiry>now ? 'tradelocked' : 'tradable'   :267
     4. inv.items = ownedLocked ++ listed                      :275
     5. gcStore.set(u, inv)                                    :321
 → dashboard reads getCached → gcStore record                 :136
 → renderAccountTabs counts buckets from inv.items             app.js:2407
 → "Active Orders" tab is a SEPARATE live call:
     GET /api/market/orders/:u → getMarketOrders               AccountTrader.ts:364
        collectSellOrders(payload)                             :1117   ← PARSER #2 (lenient)
 → mass-sell pre-flight uses a THIRD parse:
     getListedAssetIds(payload)                                :296    ← PARSER #3 (most-lenient)
```

The three parsers read the **same** endpoint (`market/mylistings/render`) with **three different acceptance rules**, and there is no canonical model reconciling them. That asymmetry is the structural defect behind the field bug.

### Invariants this path must preserve
- INV-B1 (one bucket per asset), INV-B2 (locked ⇒ no sell listing), INV-B3 (Listed bucket ≡ Active sell orders), INV-B4 (tradable bucket ⇒ tradable), INV-B6 (one listed-set), INV-B7/B8 (idempotent/monotone), INV-B9 (honest counts).

---

### B-1 — Three parsers of one endpoint; Listed bucket ≠ Active Orders ≠ pre-flight — **CRITICAL · PROVEN**
**Proof.** Acceptance rules differ:
- `fetchListedItems` keeps a listing only if `assetMap[id]` exists **and** has a name: `if (!desc) continue` `MarketListings.ts:62`; `if (!desc.market_hash_name && !desc.name) continue` `:64`.
- `collectSellOrders` keeps it on `listingId && id && appId`, `desc` defaults to `{}` → name "Unknown": `AccountTrader.ts:1126-1136`.
- `getListedAssetIds` adds ids from the `assets` map **and** scans `listings`/`pending_listings`/`listings_to_confirm`: `AccountTrader.ts:324-337`.

The inventory dedup uses **only** parser #1's set (`InventoryService.ts:228,257`); Active Orders uses parser #2 (`app.js:1711,1756`); mass-sell uses parser #3 (`MarketService.ts:483`). Three sets, three views.
**Contradiction.** Same Steam listings → different "Listed" count, different "Active Sell Orders" count, different pre-flight set. (= C1.) **Breaks INV-B3, INV-B6.**
**Root cause.** No single canonical representation of "the account's live market listings." Each consumer re-parses raw JSON with its own tolerances.
**Minimal fix (structural).** Introduce one `parseMyListings(payload) → { listings: MarketListing[], assetIds: Set }` used by all three. `MarketListing` carries `{ listingId, assetId, appId, contextId, name, iconUrl, pricePerItemMinor, currency, confirmed }`. Derive the inventory "listed" bucket, the Active Orders sell list, and `getListedAssetIds` from this one structure. Keep the lenient acceptance (don't drop nameless listings) but tag `name:'Unknown'` uniformly, so the bucket and the orders view always agree. → retires B-1, B-3, B-6, B-8 and C1/C2/C7.

### B-2 — `category` derived from `tradeLockExpiry` only, ignoring `tradable` — **HIGH · PROVEN**
**Proof.** `it.category = (it.tradeLockExpiry && …>now) ? 'tradelocked' : 'tradable'` `InventoryService.ts:267` (and the same at `:360`). The raw `tradable` flag (`InventoryManager.ts:223`) is never consulted in bucketing.
**Contradiction.** A `tradable:false` item with no parsed future hold → "tradable" bucket (= C4). Operator selects it to sell/send; Steam rejects. **Breaks INV-B4.**
**Root cause.** Two independent notions of "can move this" (`tradable` flag vs `tradeLockExpiry`) collapsed to one bucket using only one of them.
**Minimal fix.** One classifier `bucketOf(item)`: `listed → tradelocked (tradeLockExpiry>now) → (item.tradable===false ? 'tradelocked'/'untradable' : 'tradable')`. If a 4th "untradable" state is undesirable, fold genuinely-untradable items into `tradelocked` with an "indefinite" marker so they never appear sellable. Call `bucketOf` from the one place; delete the duplicate at `:360`.

### C-1 — No trade-lock guard on the sell/send path — **HIGH · PROVEN (path)**
**Proof.** `sellOnMarket` checks only sessionid+price `AccountTrader.ts:678-680`; `processBot`/`listWithRetry` forward whatever assets the body carried `MarketService.ts:340-396,500-555`; the route accepts any `{assetId, marketHashName}` for a known account `server.ts:1449-1454`. `sendTrade`/`toEconItem` likewise do no lock check `AccountTrader.ts:608,1042`.
**Contradiction.** SSIM will attempt to list/trade a trade-locked item; if Steam parks it pending, you get a locked item with an "active" sell order (= C3). **Breaks INV-B2, INV-D1.**
**Root cause.** Validation delegated entirely to Steam; the local cache's lock knowledge is never used as a guard.
**Minimal fix.** A single `assertSellable(username, assetIds)` / `assertSendable(...)` pre-flight that reads the cached `category`/`tradeLockExpiry` and rejects locked (and `tradable:false`) assets before any `sellOnMarket`/`sendTrade`, surfacing them as skipped with a reason. Cheap, and it makes INV-B2 hold by construction.

### B-5 — Non-deterministic trade-lock expiry placeholder — **LOW · PROVEN**
**Proof.** Lock notice present but date unparseable ⇒ `return new Date(Date.now() + 7*24*60*60*1000)` `InventoryManager.ts:400`. `stack()` keys on `tradeLockExpiry.toISOString()` `:252`.
**Contradiction.** The expiry (and therefore the stack key, and the "locked until" shown) changes every refresh for that item (= C22). **Breaks INV-B7.**
**Root cause.** A fail-safe value that depends on wall-clock-at-parse rather than a stable derived date.
**Minimal fix.** Use a deterministic placeholder: derive from `marketRestriction` days off a stable anchor (e.g. the item's known received date if available), or set a sentinel "locked, date unknown" (`tradeLockExpiry = +Infinity` sentinel) that stacks stably and renders as "locked (date pending)".

### B-8 — Optimistic `markListed` disagrees with the authoritative refresh; unlocked write race — **HIGH · PROVEN**
**Proof.** `markListed` gates on `getListedAssetIds`-seeded `listedSet` (`MarketService.ts:439`) and writes `gcStore` (`InventoryService.ts:434`); the next refresh re-derives "listed" from `fetchListedItems` (`:228`). If parser #1 skips a listing parser #3 accepted, the refresh moves the asset **back** to Owned (= C7). `markListed` takes no lock and does `gcStore.get`→mutate→`gcStore.set` (`:397-434`) with no `inFlight` coordination, unlike `doRefreshOneViaGc` (`:199-206`).
**Contradiction.** Bucket flip-flop across refreshes; and a refresh completing mid-`markListed` is silently overwritten (lost update). **Breaks INV-B8, INV-B13.**
**Root cause.** Optimistic write and authoritative read use different "listed" sources (B-1), and the cache has no write serialization for the optimistic path.
**Minimal fix.** (1) After B-1, `markListed` and the refresh share one parser, so they agree. (2) Route `markListed` through the same per-account `inFlight`/lock used by `doRefreshOneViaGc` (or merge it into a single read-modify-write critical section keyed `gc:user`).

### B-9 — Partial/truncated/orphaned reads cached as authoritative — **MEDIUM · PROVEN**
**Proof.** Page-cap truncation logs an error but returns the partial set (`InventoryManager.ts:167`); `doRefreshOneViaGc` never inspects `hitPageCap` and caches it `fromCache:false` (`InventoryService.ts:321`). Orphan assets (no matching description) are dropped (`InventoryManager.ts:195`). The truncation log advises "trust the GC inventory," but GC was removed — the method is legacy-named (`InventoryService.ts:195` comment).
**Contradiction.** `totalItems` under-counts a real inventory and it is presented as complete (= C12). **Breaks INV-B9, INV-B10.**
**Root cause.** Truncation/orphan signals are logged, not propagated into the cached record or the refresh result.
**Minimal fix.** Thread a `partial:boolean` (set on `hitPageCap` or `orphans>0`) into `AccountInventory`; when `partial`, take the **partial-read reconciliation** branch (`reconcilePartialRead`) instead of overwriting, and surface a "partial" badge in the UI. Remove the stale "trust GC" guidance.

### B-10 — `markListed` ↔ refresh ordering race — **MEDIUM · HYPOTHESIS** *(folded into B-8 fix)*
**Proof/mechanism.** See B-8: no shared lock between the optimistic write and `doRefreshOneViaGc`. **Fix:** the B-8 critical-section change covers it.

> **§B/§C bottom line.** B-1 + B-2 + C-1 (+ B-8) produce the entire field-bug
> family (C1–C4, C7). One canonical `MarketListing` parse + one `bucketOf` classifier
> + one `assertSellable` guard makes INV-B1..B6 hold structurally. This is the
> masterpiece fix.

---

# §A — ACCOUNTS, SESSIONS, VAULT

## Process trace — lazy login
```
service needs account live
 → ensureSession (InventoryService.ts:487) → loginAccount (SessionManager.ts:138)
     dedup in-flight (:147) → acquire slot (:114) → token-first (TokenStore.get :196)
       performLogin (:288) → on 'refreshToken' persist (:352); on 'loggedIn' emit→rememberSteamId
       on auth-fail: tokenStore.delete (:206) → fall through to credential login (:220)
```

### A-1 — "can confirm" has two sources; attach-mafile doesn't refresh the live session — **HIGH · PROVEN**
**Proof.** Runtime: `maFile.identity_secret` (`LoginFlow.ts:19`, guard `server.ts:560`). Persisted/UI: `account.tier` (`account.ts:96`). `attach-mafile` upserts the vault maFile + flips tier `server.ts:573` but never `logoutAccount` nor deletes the token → a resident LIMITED session keeps `session.maFile===undefined` (`SessionManager.ts:193`) until next re-login.
**Contradiction.** "Full" account that can't confirm in the post-attach window (= C5). **Breaks INV-A1.**
**Root cause.** `tier` is a stored label, not a projection of the real capability; attach mutates persistence without reconciling the live session.
**Minimal fix.** Make `tier` a pure projection: `canConfirm(account) = !!loadMaFile(account)?.identity_secret`. On `attach-mafile`, call `sessions.logoutAccount(u)` (or hot-reload `session.maFile`) so the live session picks up the secret. Render the badge from `canConfirm`, not stored `tier`.

### A-2 — Deleting the only token of a maFile-less account is unrecoverable — **HIGH · PROVEN**
**Proof.** `tokenStore.delete()` on auth-fail `SessionManager.ts:206`, then credential path needs maFile (`doLoginAccount` throws "maFile required" `:220`). A LIMITED account has no maFile and a blank password.
**Contradiction.** A registered account with no login path (= C8). **Breaks INV-A2.**
**Root cause.** Token deletion is unconditional; it doesn't consider whether the token is the account's *sole* credential.
**Minimal fix.** Before deleting, check `canConfirm`/has-password/has-maFile; for a token-only (LIMITED) account, do **not** delete on a transient/ambiguous failure — mark the account `needs-reauth` and surface a re-import prompt instead of silently destroying its only credential.

### A-3 — Secrets in two stores in vault mode — **MEDIUM · PROVEN**
**Proof.** `addMany` writes `password:item.password` then `save()`; `save()` blanks only vaulted accounts (`AccountManager.ts:121-123,313`), and `addMany` never vaults. `refresh_tokens.json` left on disk after migration (`vaultBoot.ts:181`).
**Contradiction.** Plaintext password/token persists while vault mode is active (= C18). **Breaks INV-A3.**
**Root cause.** The bulk-add path bypasses the vault-import step the single-add path uses.
**Minimal fix.** Route `addMany` through `AccountVault.importAccount` per item in vault mode (same as `add`), so `save()` blanks them. Delete `refresh_tokens.json` after a verified vault migration (it's already redundant in vault mode).

### A-4 — Proxy edit persists then logs out (race) — **MEDIUM · HYPOTHESIS**
**Proof.** PATCH does `accounts.update()` then `await sessions.logoutAccount()` `server.ts:821-823`; between them a concurrent lazy login can read the new/old proxy, or logout can race a mid-handshake login (dedup holds the promise, but `destroySession` deletes the entry `performLogin` still references).
**Contradiction.** Effective proxy may not match the operator's last set value for one login cycle. **Breaks INV-A4.**
**Root cause.** Two-step persist-then-teardown with no mutual exclusion against the login path.
**Minimal fix.** Make the edit acquire the account's login slot (or set a short "reconfiguring" guard) so logout+next-login are atomic w.r.t. concurrent `loginAccount`.

### A-5 — `isReady` ignores cookie age — **MEDIUM · HYPOTHESIS**
**Proof.** `isReady = LOGGED_IN && webSession` (presence only) `SessionManager.ts:618`; `obtainedAt` is set (`:430`) but never compared by consumers.
**Contradiction.** A session with expired-but-present cookies passes as ready (= C16). **Breaks INV-A5.**
**Root cause.** Freshness data exists but isn't part of the readiness predicate.
**Minimal fix.** `isReady` also requires `now − webSession.obtainedAt < COOKIE_TTL`; trigger a `refreshWebSession` when stale before serving a market/inventory call.

### A-6 — `wasLiveBefore` snapshot corrupted by `LOGGING_IN` — **MEDIUM · HYPOTHESIS**
**Proof.** `wasLiveBefore = isLive(u)` `InventoryService.ts:569`; `isLive` includes `LOGGING_IN` (`SessionManager.ts:555`). A concurrent in-flight login makes the snapshot read "live" (or vice-versa).
**Contradiction.** A refresh leaks a session it created, or releases one another op owns (= C17). **Breaks INV-A6.**
**Root cause.** Ownership is inferred from a racy liveness snapshot rather than tracked explicitly.
**Minimal fix.** Track session ownership explicitly: `loginAccount` returns/records "created-by-this-call"; release only sessions this op created (a token/handle), not a re-derived `isLive` guess.

### A-7 — Dead `RATE_LIMITED` state — **LOW · PROVEN**
**Proof.** `SessionState.RATE_LIMITED` declared (`types/session.ts:7`) but never assigned; rate limits classified `connection`→`ERROR` (`SessionManager.ts:81`).
**Contradiction.** A declared state that no transition reaches (state-machine hygiene; P3). **Breaks INV-A7.**
**Root cause.** Leftover enum member.
**Minimal fix.** Either assign it where EResult 84/rate-limit is detected (and surface "rate-limited, backing off" in the UI) or delete the member. Prefer assigning it — it's diagnostically useful given the refresh-storm history.

---

# §D — TRADING, BUYS, MONEY OPS

## Process trace — buy + verify
```
POST /api/market/buy → BuyService.buy (:148)
  forceRefresh(before) → ownedBefore (:170,111)
  createBuyOrder (AccountTrader.ts:729) → confirm (:873) → optional re-POST finalize (:837)
  forceRefresh(after) → ownedAfter (:212) → filled = after-before (:219)
```

### D-1 — Locked item enters trade/sell — **HIGH · PROVEN** *(= C-1 above; same fix)*

### D-2 — Money-op idempotency gaps — **MEDIUM · PROVEN**
**Proof.** `TradeService.inFlight` (key `user|dest|sortedAssetIds` `:376`) and `BuyService.inFlight` (key `user|appId|item` `:156`) are in-memory and cleared in `finally` (`:399`,`:262`). A buy and a sell of the same asset use different services/keys (no shared lock); a post-dispatch timeout that clears the guard before a client retry can re-enter; nothing survives a restart.
**Contradiction.** Same logical action can place two orders/offers under retry/restart. **Breaks INV-D2.**
**Root cause.** Per-service, in-memory, request-shaped guards rather than an asset-level lease.
**Minimal fix.** A single asset-level lease (per `username:assetId`) held across buy/sell/trade for the op's lifetime, with a persisted "pending op" record reconciled on boot. At minimum, share one `inFlight` registry across BuyService/TradeService/MarketService keyed by asset.

### D-3 — Buy fill inferred from a cache diff that can be stale — **MEDIUM · PROVEN**
**Proof.** `filled = ownedAfter − ownedBefore` (`BuyService.ts:219`); the "after" `forceRefresh` can trip partial-read protection (`InventoryService.ts:310`) and return the prior cache.
**Contradiction.** Reported fill ≠ real fill (= C11). **Breaks INV-D3.**
**Root cause.** Outcome derived from an inventory diff rather than from the order's own confirmed result.
**Minimal fix.** Prefer the order API's confirmed quantity (createBuyOrder result / order status) as the authoritative fill; use the inventory diff only as a cross-check, and mark `verifyUncertain` when the after-read was partial.

### D-4 — Unconfirmed listing/offer counted as complete — **MEDIUM · PROVEN**
**Proof.** Confirm-fail still counts listed + calls `markListed` (`MarketService.ts:370-373,407,440`); `sendTrade`→`unconfirmed` (`AccountTrader.ts:640`); buy→`needsConfirmation` (`:856`).
**Contradiction.** Cache shows done; Steam shows pending (= C9). **Breaks INV-D4.**
**Root cause.** No "pending confirmation" state tracked locally; success counters conflate "created" with "confirmed."
**Minimal fix.** Track a `pendingConfirmation` state per listing/offer; count it separately from `listed/confirmed`; reconcile against the canonical `MarketListing.confirmed` (B-1) on next refresh.

### D-5 — Trade-locked skin eligible as trade-up input — **MEDIUM · HYPOTHESIS**
**Proof.** `buildEligibleInputs` excludes `'listed'` but not `'tradelocked'` (`TradeUpService.ts:251`); GC re-verify checks presence not lock (`GcActionLayer.ts:341`).
**Contradiction.** A locked item can be submitted to a craft (= C10). **Breaks INV-D6.**
**Root cause.** Eligibility filter omits the lock dimension.
**Minimal fix.** Add `&& item.category !== 'tradelocked' && item.tradable` to `buildEligibleInputs`; or reuse the `assertSellable`-style guard at craft submission.

### D-6 — Internal-offer auto-accept depends on a session that bulk ops release — **MEDIUM · HYPOTHESIS**
**Proof.** `handleNewOffer` auto-accepts only if `isManagedSteamId(partner)` at offer time (`TradeService.ts:526,543`), computed from live `getAllSessions()`; bulk reads/sends release sessions (`:270-272,505`).
**Contradiction.** A legitimately-internal offer arriving after the sender's session was released is treated as external and not accepted.
**Root cause.** "Managed" is derived from *live sessions* rather than from the *account registry*.
**Minimal fix.** `isManagedSteamId` should consult the persisted account set (known steamIds in `accounts.json`), not only live sessions.

### D-7 — BanService creates a real Web API key as a side effect; caches it for process life — **LOW · PROVEN**
**Proof.** `createKey` mints+confirms a key on accounts lacking one (`BanService.ts:492`); cached `apiKey`, cleared only on 401/403≠env (`:515`).
**Contradiction.** A "read-only" ban check has a money/identity side effect; a key revoked out-of-band but not returning 401 isn't refreshed.
**Root cause.** Key provisioning embedded in a read path.
**Minimal fix.** Make key creation explicit/opt-in (or reuse only existing keys for a ban check); add a TTL/revalidation to the key cache.

---

# §E — PRICING, CURRENCY, VALUE

### E-1 — No unit assertion at price-source boundaries — **MEDIUM · PROVEN**
**Proof.** `CsFloatPriceSource` returns `first.price` directly as cents (`CsFloatPriceSource.ts:29`); `PricingService` treats every entry as USD cents (`:84,105`); legacy bare-name keys are unconditionally Steam (`:78-81`) with no source/unit stamp in `PriceEntry` (`PriceCache.ts:8`).
**Contradiction.** A non-USD or mislabeled price silently mis-scales `totalValueUsd` and its EUR display. **Breaks INV-E2.**
**Root cause.** The cache contract (USD cents) is assumed, never validated at the boundary.
**Minimal fix.** Stamp `PriceEntry` with `{source, currency:'USD'}`; assert/normalize at write; treat a unit mismatch as a miss.

### E-2 — Two client computations of the headline total — **LOW · PROVEN**
**Proof.** `aggregate()` sums backend `inv.totalValueUsd` (`app.js:2231`); folder/selected masters recompute via `stackValueCents` over deduped items (`:1501,1569,551`).
**Contradiction.** The two totals diverge when cache/source state differs between per-account enrich and merged recompute (= C19). **Breaks INV-E3.**
**Root cause.** Two code paths for one number.
**Minimal fix.** Compute the view total one way — sum the backend `totalValueUsd` everywhere (drop the client recompute), or always recompute from items; do not mix.

### E-3 — Server vs client FX rate; rounding non-associativity — **LOW · PROVEN**
**Proof.** Server converts wallet→USD with `getUsdToEur()` (`ValueHistoryService.ts:183`); client with `state.usdToEur` snapshot (`app.js:451`). Per-item round (`:2689`) vs whole-total round (`:520`).
**Contradiction.** Same balance shows two EUR numbers; visible per-item EUR don't sum to the headline (= C20). **Breaks INV-E4.**
**Root cause.** Two copies of the rate; rounding applied at different granularities.
**Minimal fix.** One rate source for a given render (have the client always use the server's `/api/exchange-rate` value, including for history); convert once at the total and derive per-item display from it (or accept documented per-item rounding and convert the total from rounded items consistently).

### E-4 — FX fallback shown without provenance — **LOW · PROVEN**
**Proof.** `getInfo()` exposes `{fallback, ageMs}` (`ExchangeRateService.ts:16`) but `/api/exchange-rate` returns only `{usdToEur}` (`server.ts:1027`); cold start always begins at 0.92 (`:9`), never persisted.
**Contradiction.** A hardcoded/stale rate is displayed as if live. **Breaks INV-E5.**
**Root cause.** Provenance dropped at the API boundary; rate not persisted.
**Minimal fix.** Return `fallback`/`ageMs` from `/api/exchange-rate` and show a "rate stale/fallback" hint; persist the last good rate to disk so cold starts don't begin at 0.92.

### E-5 — Value-history burst-coalesce overwrites cross-game — **LOW · PROVEN**
**Proof.** `append` merges points <60s into the previous (`ValueHistoryService.ts:191`); `snapshotAll` re-snapshots both games each call (`:153`).
**Contradiction.** A TF2-only refresh rewrites the CS2 series' latest point (= C21). **Breaks INV-E6.**
**Root cause.** Coalescing keyed by time window, applied across independent series in one call.
**Minimal fix.** Coalesce per series-id, and only snapshot the game(s) that actually refreshed (pass the refreshed `game` into `snapshotAll`).

---

# §F — CSFLOAT

### F-1 — Auto-delivery dedup is in-process only → re-send after restart — **HIGH · PROVEN (mechanism)**
**Proof.** `delivered` is an in-process `Set` populated after send (`CsFloatAutoAcceptWorker.ts:26,95`); `TradeService.inFlight` also in-process and only blocks concurrent identical sends (`:376`). CSFloat trade stays `pending` until the buyer accepts.
**Contradiction.** Restart between "delivered" and "no longer pending" → a second real Steam offer for one sale (= C6). **Breaks INV-F1/INV-D5.**
**Root cause.** Idempotency key not persisted; CSFloat-side state lag not accounted for.
**Minimal fix.** Persist delivered CSFloat trade ids (or mark the trade delivered via the CSFloat API after sending); skip any trade whose id is already recorded. Reconcile on boot before the first pass.

### F-2 — No allow-list on the delivery target — **MEDIUM · PROVEN**
**Proof.** Target taken from the undocumented payload (`buyer.steam_id`/`trade_url`/`asset_id` `Worker.ts:111-121`); only the empty case is guarded.
**Contradiction.** A payload-shape drift could send an asset to an unintended recipient. **Breaks INV-F1.**
**Root cause.** Trust in an undocumented external payload shape with no sanity bounds.
**Minimal fix.** Validate the target (well-formed steamID64/trade URL) and the asset (belongs to this account's cached inventory) before sending; fail closed on anything unexpected.

### F-3 — "experimental off" doesn't stop the worker — **MEDIUM · PROVEN**
**Proof.** Route gate requires experimental (`server.ts:736`), but `runOnce` keys only off `autoAcceptUsernames()` (`Worker.ts:51`); turning the flag off doesn't clear toggles.
**Contradiction.** Armed accounts keep delivering after the flag is disabled (= C15). **Breaks INV-F2.**
**Root cause.** The kill-switch gates the UI/route, not the actuator.
**Minimal fix.** `runOnce` returns early when `!AppSettings.isCsfloatExperimental()`; or clear `csfloatAutoAccept` toggles when experimental is turned off.

### F-4 — Keys invisible across a vault-mode switch — **LOW · HYPOTHESIS**
**Proof.** `CsFloatKeyStore` reads only the current backend (vault vs file) (`KeyStore.ts:44-64`); no migration on mode switch. Account removal in plaintext mode can orphan a `csfloat_keys.json` entry.
**Contradiction.** Keys saved under the other backend become invisible/orphaned. **Breaks INV-F3.**
**Root cause.** No migration of CSFloat keys across the vault boundary.
**Minimal fix.** Migrate CSFloat keys in `migrateAccountsIntoVault`; clean `csfloat_keys.json` on account removal.

---

# §G — LICENSE, UPDATE, BOOT, PROCESS

### G-1 — "is licensed" decided positionally in the full-app route — **MEDIUM · PROVEN**
**Proof.** `GET /api/system/status` returns `{licensed:true}` unconditionally (`server.ts:1886`); the two portals assert `licensed:false`/`vaultLocked:true` by construction. The client's "licensed" signal is purely which server is bound.
**Contradiction.** The dashboard can't itself detect a revocation; it relies on teardown swapping the server (a brief no-answer window during re-gate). **Breaks INV-G1.**
**Root cause.** Trust derived from boot position, not a fresh check.
**Minimal fix.** Have `/api/system/status` reflect `LicenseClient`'s last known good/revoked state (cheap in-memory flag updated by heartbeat/recheck), so the client sees a revocation without a server swap.

### G-2 — `maxSeenMs` clock-poisoning locks out a valid offline user — **MEDIUM · PROVEN**
**Proof.** `bumpClock(Date.now())` on every signature-valid boot (`LicenseClient.ts:120,210`), HMAC-persisted (`:107`); grace refused when `now < maxSeenMs − skew` (`:224`).
**Contradiction.** A forward clock jump while a valid token is loaded poisons `maxSeenMs`; on return to true time, offline grace is refused for a legitimate user (= C13). **Breaks INV-G2.**
**Root cause.** The rollback anchor is advanced from untrusted local time, not from server-confirmed time.
**Minimal fix.** Advance `maxSeenMs` only from a **server-confirmed** timestamp (heartbeat/recheck response), not local `Date.now()`; keep local time only for the skew comparison.

### G-3 — Update swap `kind` is outside the signature — **MEDIUM · PROVEN (path)**
**Proof.** Signature covers `${latest}:${sha256}` only (`Updater.ts:204`); `kind` read separately (`:48-51`) and selects deletion-bearing swap shapes (`:314-321`). Migration swap runs the orphan-delete unconditionally after the move loop (`:283-288`, no swap-success gate).
**Contradiction.** A MITM flipping `kind` can mis-place the authentic artifact and delete the running backend → brick (= C14). **Breaks INV-G3.**
**Root cause.** A control flag affecting destructive file ops isn't authenticated.
**Minimal fix.** Include `kind` in the signed payload (`${latest}:${sha256}:${kind}`); gate the orphan-delete on a confirmed successful swap (check the move result before `del`).

### G-4 — Single-instance lock edge cases — **LOW · PROVEN**
**Proof.** `processImageName` returns `''` off-Windows, so any alive PID equal to the stale value blocks boot (`index.ts:51,69`); lockfile IO error returns `true`/proceed (`:75`); `EPERM`→alive (`:41`).
**Contradiction.** Recycled-PID false-positive blocks a legit start (non-Windows); IO-error path can allow a true second instance. **Breaks INV-G5.**
**Root cause.** PID liveness is an imperfect proxy; platform-specific mitigation only on Windows.
**Minimal fix.** Write a start-nonce/boot-id in the lockfile and verify the running process owns it (e.g. via the published `ssim.port` handshake) rather than PID alone.

### G-5 — Money-ops breaker latches across an in-process re-license — **LOW · PROVEN**
**Proof.** `ProcessHealth` is module-global and never resets except by restart (`ProcessHealth.ts:34`); an `onLicenseLost`→`teardownFullApp`→`startFullApp` cycle rebuilds `deps`/sessions but doesn't reset it (`index.ts:280`).
**Contradiction.** A fresh session map after re-licensing still has money ops blocked. **Breaks INV-G6.**
**Root cause.** Breaker state lives outside the app lifecycle it's meant to protect.
**Minimal fix.** Reset `ProcessHealth` in `teardownFullApp`/`startFullApp`, or scope it to `deps` so a rebuild clears it.

### G-ok — Boot ordering (positive finding) — **HOLDS**
`validate → maybeAutoUpdate → vault unlock → startFullApp` (`index.ts:242-265`); portals 403/423 every `/api/*` and scope static to `/assets` (`ActivationServer.ts:39,85`; `unlockPortal.ts:35,91`). The dashboard is physically unreachable before license+vault. Port hand-off waits for the actual `close` callback (`:76-79`), so no same-process bind race. **INV-G4 holds.** (Minor: `findFreePort` TOCTOU and the `taskkill /F`-vs-lock interaction are timing-only, noted in the Licensing agent report.)

---

# Severity-ordered remediation plan (Critical → Low)

| Order | Findings | One structural change |
|---|---|---|
| 1 | **B-1, C-1, B-2, B-8** (C1,C2,C3,C4,C7) | One canonical `parseMyListings`→`MarketListing[]` + one `bucketOf` classifier + one `assertSellable` guard; route `markListed` through the refresh lock. |
| 2 | **A-1, A-2** (C5,C8) | `canConfirm = !!maFile.identity_secret`; `tier` becomes a projection; attach reloads the live session; don't delete a token-only account's sole token. |
| 3 | **F-1, F-2, F-3** (C6,C15) | Persist delivered CSFloat trade ids; validate delivery target; gate worker on the experimental flag. |
| 4 | **D-2, D-3, D-4** | Asset-level lease across buy/sell/trade; authoritative fill from the order; track `pendingConfirmation`. |
| 5 | **B-9, A-3, A-5, A-6, G-2, G-3** | Propagate `partial`; vault `addMany`; cookie-age in `isReady`; explicit session ownership; sign `kind`; server-time clock anchor. |
| 6 | **E-1…E-5, A-7, D-5, D-6, D-7, F-4, G-1, G-4, G-5** | Unit stamps; single FX source; single total path; dead-state cleanup; misc guards. |

> Approve the findings and I will implement in this order, Critical first, each as a
> minimal, invariant-restoring change with a focused test that asserts the broken
> invariant now holds.
