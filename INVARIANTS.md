# SSIM — INVARIANT LEDGER

> The statements that must be true **at all times** for SSIM to be logically sound.
> Each invariant has: a plain-language statement, the code-level condition, the
> single source it should derive from, and current status:
> **HOLDS** · **VIOLABLE** (a code path can break it — see `LOGIC_AUDIT.md`) · **BROKEN** (provably false today).
>
> Status is proven from code, not runtime. `▶` links to the audit finding.

Legend for IDs: `INV-<domain><n>` — domains A..G match `FEATURES.md`.

> **Phase-3 status.** Fixes land batch-by-batch (severity order). Now **HOLDS**
> (was VIOLABLE/BROKEN), covered by tests in `test/`:
> **batch 1 — canonical MarketListing model:** INV-B1, INV-B2, INV-B3, INV-B4,
> INV-B6, INV-B7, INV-B8, INV-D1 (the whole market/bucket family), plus the
> determinism half of INV-B5. The remaining rows are still open and tracked below.

---

## Cross-cutting (the five principles)

- **P1 Single source of truth** — every derived value traces to exactly one authoritative source.
- **P2 Invariants hold always** — the statements below are never simultaneously false.
- **P3 State is a machine** — each entity has defined states and only defined transitions; no state computed two ways.
- **P4 Determinism & freshness** — same inputs → same output; live-vs-cached is always unambiguous.
- **P5 Idempotency & ordering** — refresh/sync/re-list are safe to run twice; no hidden ordering/races.

---

## Domain B/C — Inventory items, buckets, listings (the core)

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-B1** | An item occupies **exactly one** bucket (listed ∪ tradelocked ∪ tradable), and the three are pairwise disjoint. | `category ∈ {listed,tradelocked,tradable}`; partitions `inv.items`. | **VIOLABLE** ▶ B-1: a single asset can be Owned(ctx) **and** a sell order at once when `fetchListedItems` skips it. |
| **INV-B2** | A **trade-locked** item has **no live market sell listing** (Steam forbids listing locked items): `{tradelocked} ∩ {active sell listing} = ∅`. | `category==='tradelocked'` ⇒ assetId ∉ any sell order. | **BROKEN** ▶ C-1: nothing in the sell path checks lock; `collectSellOrders` shows it; bucket still locked. |
| **INV-B3** | "Listed on Market" (inventory bucket) and "Active Sell Orders" describe the **same** set of live sell listings. | `{items: category==='listed'}` ≡ `getMarketOrders().sellOrders` (by assetId). | **BROKEN** ▶ B-1: two parsers of one endpoint with different acceptance rules (`MarketListings.ts:62` vs `AccountTrader.ts:1126`). |
| **INV-B4** | An item in the **`tradable`** bucket is actually tradable (`item.tradable === true`). | `category==='tradable'` ⇒ `item.tradable===true`. | **BROKEN** ▶ B-2: category derived only from `tradeLockExpiry` (`InventoryService.ts:267`), ignoring the `tradable` flag. |
| **INV-B5** | An item in **`tradelocked`** has a future `tradeLockExpiry`; an item in `tradable`/`listed` has `tradeLockExpiry` null/past. | `category==='tradelocked' ⇔ tradeLockExpiry>now`. | **HOLDS** for the bucket derivation `InventoryService.ts:267`, but the *expiry value* is non-deterministic ▶ B-5. |
| **INV-B6** | The asset-id set excluded from owned/locked (`listedAssetIds`) is the **same** set used to render Active Orders and mass-sell pre-flight. | one `Set<assetId>` feeds dedup, Active Orders, preflight. | **BROKEN** ▶ B-1: dedup uses `fetchListedItems` set (`:228`); Active Orders uses `collectSellOrders`; preflight uses `getListedAssetIds` (`:296`) — three different sets. |
| **INV-B7** | A refresh is **idempotent**: running it twice on unchanged Steam state yields byte-identical buckets. | `refresh(x); refresh(x)` ⇒ same `category`/stacks. | **VIOLABLE** ▶ B-5 (now+7d lock placeholder shifts stack keys), ▶ B-8 (`markListed` optimistic write vs next refresh disagree). |
| **INV-B8** | `markListed` (optimistic Owned→Listed) is **monotone**: an item it moves to Listed is never silently moved back by the next refresh unless actually de-listed on Steam. | `markListed(a)` then refresh ⇒ `a` stays listed iff Steam still lists it. | **VIOLABLE** ▶ B-8: next refresh keys off `fetchListedItems` (stricter); if it skips `a`, `a` reverts to Owned though still listed. |
| **INV-B9** | `totalItems` equals the sum of stack quantities actually present. | `totalItems === Σ items[].quantity`. | **VIOLABLE** ▶ B-9: orphan assets dropped in `parse` (`InventoryManager.ts:195`); page-cap truncation cached as complete (`:167`). |
| **INV-B10** | A cached inventory is never presented as live, and a partial read never overwrites a known-good fuller one. | `fromCache` honest; `set()` newest-wins (`InventoryStore.ts:109`); partial-read guard (`InventoryService.ts:310`). | **HOLDS** (well-guarded), with one caveat ▶ B-9 (page-cap partial is cached `fromCache:false`). |

## Domain B — Cache coherence

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-B11** | For a given account+game there is **one** authoritative cache record the dashboard reads. | `getCached` returns gcStore∨store, never both. | **HOLDS** `InventoryService.ts:136` (GC overrides web). |
| **INV-B12** | A read-time enrichment (price, manual lock, category overlay) never persists back into the cache. | API overlays on a deep clone (`InventoryStore.get` `:100`). | **HOLDS** (structuredClone guard). |
| **INV-B13** | Concurrent refreshes of the same account share one fetch (no two writers race the cache). | `inFlight` map per `game:user` (`:156`). | **VIOLABLE** ▶ B-10: `markListed` takes **no** lock and does read-modify-write on `gcStore` concurrently with a refresh (last-writer-wins). |

## Domain D — Trades, buys, money ops

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-D1** | A trade-locked item never enters a send/sell path. | sell/send guard on `category`/`tradeLockExpiry`. | **BROKEN** ▶ C-1/D-1: neither `sellOnMarket` (`:676`) nor `sendTrade` (`:608`) checks lock; rejection left to Steam. |
| **INV-D2** | A money op (buy/sell/trade) is **idempotent** under retry: the same request never places two orders. | per-request `inFlight` guard + "never throw after placed". | **VIOLABLE** ▶ D-2: guards are in-memory and cleared in `finally`; cross-restart / cross-service (buy vs sell of same asset) not covered. |
| **INV-D3** | "filled"/"spent" reported by a buy equals the real on-Steam outcome. | `filled = ownedAfter − ownedBefore` from two forceRefresh. | **VIOLABLE** ▶ D-3: if the "after" read trips the partial-read guard, `ownedAfter` reflects cache, mis-reporting fill. |
| **INV-D4** | After a market op (list/buy/trade), local state and Steam converge within one refresh. | optimistic write then reconcile. | **VIOLABLE** ▶ B-8, ▶ D-4: unconfirmed listing counted as `listed` while still pending on Steam (`MarketService.ts:407`). |
| **INV-D5** | Auto-accept only ever delivers/accepts what it should, exactly once. | dedup + managed-party check. | **VIOLABLE** ▶ F-1 (CSFloat worker re-delivers after restart, in-proc `delivered` Set), ▶ F-2 (no allow-list on delivery target). |
| **INV-D6** | Trade-up / casket inputs are present and eligible at execution. | live GC re-verify before craft (`GcActionLayer.ts:341`). | **HOLDS** for presence; **VIOLABLE** for lock ▶ D-5 (locked item not pre-filtered from trade-up). |

## Domain A — Accounts, sessions, vault

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-A1** | "tier === full" ⇒ the account can actually confirm trades/listings (has identity_secret). | `tier==='full' ⇔ maFile.identity_secret present`. | **BROKEN** ▶ A-1: two independent sources; attach-mafile sets tier but not `session.maFile`; full tier w/o identity_secret possible. |
| **INV-A2** | A registered account always has a usable login path (token ∨ maFile+password). | not (no token ∧ no maFile ∧ no password). | **VIOLABLE** ▶ A-2: auth-failure deletes the only token of a maFile-less LIMITED account → unrecoverable. |
| **INV-A3** | A secret (password/token/key) lives in exactly one store at a time. | vault XOR plaintext. | **VIOLABLE** ▶ A-3: `addMany` writes plaintext passwords in vault mode (`AccountManager.ts:313`); `refresh_tokens.json` left after migration. |
| **INV-A4** | The effective proxy used to log in is the one the operator last set. | `resolveNetwork` single source. | **VIOLABLE** ▶ A-4: proxy stored in vault vs accounts.json by mode; PATCH persists then logs out (race window). |
| **INV-A5** | A session marked "ready" has live, unexpired web cookies. | `isReady` ⇒ cookies valid. | **VIOLABLE** ▶ A-5: `isReady` checks presence not `obtainedAt`; expired-but-present cookies pass. |
| **INV-A6** | "released only sessions we created" never tears down a session another op owns. | `wasLiveBefore` snapshot correct. | **VIOLABLE** ▶ A-6: `isLive` includes `LOGGING_IN`; concurrent login in flight corrupts the snapshot. |
| **INV-A7** | Each session has exactly one defined state, reached only by defined transitions. | `SessionState` machine. | **HOLDS** except `RATE_LIMITED` is dead (declared, never assigned) ▶ A-7. |

## Domain E — Pricing, currency, value

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-E1** | A displayed price is fresh (≤ TTL) or shown as "loading", never stale-as-live. | age>TTL ⇒ `undefined` (`PricingService.ts:88/103`). | **HOLDS** (stale degrades to loading). |
| **INV-E2** | All cached prices are the same unit (USD cents). | every `PriceEntry.cents` is USD cents. | **VIOLABLE** ▶ E-1: no unit assertion at the CSFloat boundary (`CsFloatPriceSource.ts:29`); legacy bare-name keys assumed Steam. |
| **INV-E3** | The same inventory shows the same total worth in every view. | `Σ totalValueUsd` consistent. | **VIOLABLE** ▶ E-2: two client total computations (sum-of-totalValueUsd vs recompute-from-items). |
| **INV-E4** | A single FX rate governs every USD→EUR conversion shown at one moment. | one `usdToEur`. | **VIOLABLE** ▶ E-3: server copy (value-history) vs client copy (stat card) can differ; Σround≠roundΣ. |
| **INV-E5** | FX rate provenance (live vs fallback/stale) is visible wherever it changes a number. | staleness flag surfaced. | **VIOLABLE** ▶ E-4: `/api/exchange-rate` drops `fallback`/`ageMs`; 0.92 shown as if live. |
| **INV-E6** | A value-history point is appended, never silently overwritten by an unrelated refresh. | append-only series. | **VIOLABLE** ▶ E-5: <60s burst-coalesce overwrites; a TF2 refresh rewrites the CS2 latest point. |

## Domain F — CSFloat

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-F1** | Auto-delivery happens once per CSFloat sale, to the right Steam partner. | persistent dedup + verified target. | **VIOLABLE** ▶ F-1 (in-proc dedup only) / ▶ F-2 (target from undocumented payload, no allow-list). |
| **INV-F2** | Turning off "experimental" stops all experimental behavior. | flag gates routes **and** worker. | **VIOLABLE** ▶ F-3: worker keys off `autoAcceptUsernames`, never checks `isCsfloatExperimental`. |
| **INV-F3** | A key is read from exactly one backend; presence is computed one way. | vault XOR file. | **HOLDS** within a mode; **VIOLABLE** across a mode switch ▶ F-4 (keys in the other backend become invisible). |
| **INV-F4** | The CSFloat rate limit is never exceeded for one key. | one limiter per key. | **HOLDS** `Client.ts:70` (static per-key map). |

## Domain G — License, update, boot

| ID | Invariant | Code condition | Status |
|---|---|---|---|
| **INV-G1** | "is licensed" is decided in exactly one place. | only `validate()` gates. | **VIOLABLE** ▶ G-1: `/api/system/status` returns `{licensed:true}` positionally; UI trusts which server is bound. |
| **INV-G2** | A valid offline user is never locked out by a clock change they didn't cause. | grace anchored to server contact, skew-tolerant. | **VIOLABLE** ▶ G-2: `maxSeenMs` advanced from local `Date.now()`; a forward jump poisons it → later lockout. |
| **INV-G3** | No update is applied unless its artifact is authenticated. | sha256 + Ed25519 verified pre-swap. | **HOLDS** for the artifact; **VIOLABLE** for the swap *shape* ▶ G-3 (`info.kind` unsigned → can mis-place/delete). |
| **INV-G4** | The dashboard server never serves before license + vault are ready. | ordering in `bootstrap`. | **HOLDS** ▶ G-ok (validate→vault→startFullApp; portals 403/423 all `/api/*`). |
| **INV-G5** | Exactly one SSIM instance runs; a dead instance's lock never blocks a new one. | PID+image check. | **VIOLABLE** ▶ G-4: non-Windows recycled-PID false-positive; lockfile IO error fails open. |
| **INV-G6** | The money-ops breaker reflects the **current** process's health. | breaker scoped to live state. | **VIOLABLE** ▶ G-5: `ProcessHealth` latches process-global; survives an in-process re-license with a fresh session map. |

---

## How to read this ledger against a fix

A fix is "masterpiece-grade" when it makes an invariant hold **structurally** — by
collapsing to one source of truth — not by adding a second reconciliation pass.
The highest-leverage structural fixes (each retires multiple rows):

1. **One canonical `MarketListing` model** parsed once from `market/mylistings/render`,
   consumed by the inventory bucket, Active Orders, and mass-sell pre-flight.
   → repairs INV-B1, B3, B6, B8, and the count mismatch.
2. **Derive `category` from a single function** that considers both `tradeLockExpiry`
   **and** `tradable`, and never from `markListed`/reconcile copies. → INV-B4, B5, B7.
3. **One "can-confirm" predicate** = `maFile.identity_secret present`; make `tier` a
   pure projection of it, recomputed on attach + reloaded into the live session.
   → INV-A1.
4. **One pre-flight guard** rejecting trade-locked assets from every send/sell/trade-up
   entry. → INV-B2, D1, D5.
