# SSIM — Feature Build Report (Trade-Ups · Storage Units · Global-Master scoping)

**Date:** 2026‑06‑20  ·  Built on the hardened base (see `HARDENING_REPORT.md`).
**Build:** `tsc` green · `node --check public/app.js` green · `dist/` current · every increment committed.
**Money/item safety:** no real trade-ups, storage moves, or mass logins were executed — GC item
operations are **gated off by default**; the owner runs the first live execution (Section 7).

---

## 0) Two premise corrections (the task assumed code that did not exist)

The spec referenced `globaloffensive` as "already a dependency" and a `Cs2NameResolver` that fetches
the ByMykel schema. **Neither existed** in the repo:
- `globaloffensive` is **not installed** (absent from `node_modules`, `package.json`, lockfile).
- There is **no** `Cs2NameResolver`; item names come straight from Steam inventory descriptions.

Both were handled per the task's own fallback clause ("if the mechanism cannot be implemented with
full confidence, build calculation + UI + scaffolding, gate execution, and document"):
- A new **`Cs2SchemaService`** reads the schema (already cached at `data/cs2-skins.json`; fetches from
  ByMykel + caches if absent) and exposes collections/rarities/float-ranges/eligibility.
- A new **`GcActionLayer`** integrates `globaloffensive` via a **lazy, absence-tolerant `require`**, so
  the build and all non-GC paths work whether or not it is installed. Live item ops are gated.

`globaloffensive` was deliberately **not** `npm install`ed unattended — that would desync
`package.json`/lockfile and risk the owner's protected build. Install steps are in Section 7.

---

## 1) Feature 1 — Automated Max-Profit Trade-Ups

**Placement.** A **Trade-Ups** button in the **single-account view header only** (`renderAccountView`) —
never on folder/env/global/selection masters. Opens a dedicated modal.

**Flow (as specified).** *Get Trade-Ups* → live-refresh this account's inventory → compute every
positive-profit contract → list rows (10 inputs · outcomes + probabilities · cost · EV · profit ·
float), **all auto-selected** → *Deselect all* / *Select all* / multi-select → *Start (N)* → confirm →
live processing line + *Cancel* (stops after the current contract).

**The math — implemented exactly (`src/trading/tradeupMath.ts`, pure + unit-tested):**
- **Contract** = 10 inputs of the **same rarity tier** and **same StatTrak status**, each a trade-up-
  eligible weapon skin from a collection that has a next-rarity tier. Output rarity = input + 1.
- **Outcome pool** = next-rarity skins from the **collections** of the 10 inputs. Each outcome's
  probability = `(inputs_from_that_collection / 10) / (next-rarity_skins_in_that_collection)`. Summed
  across collections this is exactly 1 (proven).
- **Output float** = `avg(inputFloats) · (out.maxFloat − out.minFloat) + out.minFloat` → wear band →
  `market_hash_name` → price.
- **EV** = `Σ (probability × outcome_price_at_its_wear)`; **Profit** = `EV − Σ input_prices`. Integer
  USD cents throughout (same unit as `PricingService`). Only profit `> threshold` (default 0) is shown.
- **Data:** `Cs2SchemaService` (collections, rarity ladder, min/max float) + `PricingService` (prices).
  Weapon ladder `common→uncommon→rare→mythical→legendary→ancient`; Covert is terminal; the knife/glove
  `rarity_ancient` (no `_weapon`) is excluded. 1421 weapon skins carry a collection (eligible); 577 do
  not (treated as ineligible — no determinable output pool).

**Search strategy (`TradeUpService.getCandidates`) — bounded + documented (NOT brute force).**
Enumerating all C(n,10) is billions of combinations. Instead, inputs are grouped by (rarity, StatTrak)
and the realistic profitable contracts are evaluated: the **cheapest-10 mixed** contract, plus per
single collection the **cheapest-10** and the **lowest-float-10**. Each candidate is then scored with
the **exact** contract math. This finds the trade-ups a human would actually run; the EV/probability/
float math is exact for every candidate surfaced.

**Float estimate (honest limitation).** The pure-web inventory does **not** expose item floats, so input
floats are **estimated** from each item's wear-band midpoint (clamped to the skin's range) and the UI
flags EV as an estimate. The GC execution path can read the real `paint_wear` for exact EV.

**Execution (HIGH RISK — gated).** *Start* → `POST /api/tradeup/execute` → a serialized job that calls
`GcActionLayer.craftTradeUp(username, 10 assetIds)` per selected contract. Money/item safety: per-account
in-flight guard, **re-verify the 10 inputs are present in the live GC inventory immediately before
crafting**, submit exactly once, **never throw after submit** (no duplicate craft), cancel only between
contracts. When GC is not live the job completes as a **safe no-op** (`enabled:false`, nothing crafted).

---

## 2) Feature 2 — Storage Unit (Casket) Management

**Placement.** A **Storage** button in the **single-account view only**. Opens a two-panel modal.

**UI.** Top: storage-unit selector (name + `count/1000`). Left panel: depositable inventory (per-stack,
search, select-all, live counts). Right panel: selected unit's contents (select-all, multi-select).
Actions: **Deposit →** / **← Withdraw** with confirm + live progress + *Cancel*. The 1000-item cap is
enforced server-side on deposit.

**Technical.** `CasketService` over the shared `GcActionLayer`, using the documented `globaloffensive`
casket API: `getCasketContents` (read), `addToCasket` (deposit), `removeFromCasket` (withdraw), and
`gc.inventory` to enumerate units. Reads need only the library; **moves are gated** like trade-ups.
Money/item safety: per-account in-flight guard, each item moved + verified **one at a time**, deposit
respects the 1000 cap, never-throw-after-move, cancel stops only between items. When the GC layer is
unavailable the modal degrades clearly (the inventory panel still renders from cache).

---

## 3) Feature 3 — Global-Master scoping (all three, fully implemented + unit-tested)

**3a — Refresh the SELECTED environments only.** `refreshAll()` in global-master now sends an explicit
username list of the **enabled accounts in `state.globalEnvs`** (all selected → all; a 2-env selection →
only those two), instead of `{}` (= everything). Backend already validates the list.

**3b — Money graph follows the selection.** New `ValueHistoryService.aggregate(seriesIds, game)` sums the
per-environment series of the selected envs with **carry-forward** semantics (at each timestamp every env
contributes its latest value at-or-before that time, or 0 before its first point — so toggling a young
env in never makes the total dip). Endpoint `POST /api/history/aggregate`; the global chart fetches it
with a selection-keyed cache + async race guard, updating live as envs toggle.

**3c — Per-environment ban API keys, 20/key rotation, strict no cross-env.** `BanService.checkBans` now
groups accounts by environment and checks **each env only with key(s) sourced from accounts within that
env** (`acquireEnvKeys` — already-logged-in accounts first, bounded logins). A key covers ≤ **20** accounts
then **rotates** to another same-env key; a key is **never** reused across environments. Envs that can't be
fully covered (more accounts than `keys × 20`, or 0 keys) surface a clear per-account error. The old
`ensureApiKey` was removed (its cross-env candidate pool violated this). An explicit `STEAM_WEB_API_KEY`
stays a documented global operator override. The pure planner `planPerEnvBanChecks` is unit-tested.

---

## 4) The GC mechanism — what is verified vs. what is still needed

| Operation | In published `globaloffensive`? | This build |
|---|---|---|
| Storage: list units (`gc.inventory`), read (`getCasketContents`), deposit (`addToCasket`), withdraw (`removeFromCasket`) | **Yes** (documented) | Implemented against that API, gated. **Untested live** (no library installed; owner runs first move). |
| Trade-up **craft** | **No** — the library exposes no craft/trade-up call | `craftTradeUp` **probes** for a `gc.craft` method and **refuses** (throws, touches nothing) if absent. It never guesses a raw GC message that could destroy items. |

**Exact mechanism still required for trade-up EXECUTION:** a GC craft message must be sent — historically
`k_EMsgGCCraft` (the in-client "craft/trade-up" request carrying the 10 input item ids + recipe), via
either (a) a `globaloffensive` build that exposes a `craft(items, recipe, cb)` method, or (b) a raw
`steamUser.sendToGC(730, <craft msg id>, {}, <protobuf payload>)` with the verified message id + schema.
This could not be implemented with full confidence without a live GC to verify against, so it is left
gated + documented rather than guessed. **The calculation, search, and full UI are complete and exact.**

---

## 5) What was unit-tested (3 throwaway harnesses, all deleted; real `Vault/`/`data/` untouched)

- **F3 (26 assertions):** `planPerEnvBanChecks` — 20/key chunking, key-index rotation, **strict cross-env
  isolation** (every chunk's SteamIDs belong to its own env), 0-key + over-capacity uncovered; and
  `ValueHistoryService.aggregate` — carry-forward sum, single-env passthrough, unknown/empty, TF2 prefix.
- **Trade-up math (40 assertions):** wear-band boundaries, output-float formula, `parseSkinName`
  (StatTrak/Souvenir/wear/knife), a **known-answer** Chroma Mil-Spec→Restricted contract (4 outcomes
  @0.25, exact wears/EV/profit/cost), multi-collection probability split summing to 1, validation throws,
  and the **real schema** (Chroma yields 4 outputs, ladder, eligibility, knives excluded).
- **GC safety gate (18 assertions):** with `globaloffensive` absent or `SSIM_GC_VERIFIED` off, **no item op
  runs** — craft/deposit/withdraw all refuse, the verified flag alone is insufficient (needs both), jobs end
  as safe no-ops, and the 10-input contract shape is enforced before any job starts.

All ran green (26/26, 40/40, 18/18). Harnesses pointed `SSIM_HOME` at a throwaway temp dir.

---

## 6) Open points (each deferred with a reason)

- **O‑1 · `globaloffensive` not installed — GC features inert until the owner adds it.** Severity: expected.
  *Action:* `npm install globaloffensive` (adds it + updates the lockfile consistently), and add
  `"node_modules/globaloffensive/**/*"` to `package.json` → `pkg.assets` for the protected build (its
  `.proto`/@doctormckay deps are already covered by the existing `**/*.proto` + `@doctormckay/**` entries).
- **O‑2 · Trade-up CRAFT mechanism (Section 4).** Severity: high (blocks live trade-up execution only).
  *Action:* confirm the GC craft message id + payload on a **test account with throwaway skins**, expose it
  (or `sendToGC`), then enable. Until then the calculator + UI are fully usable; execution refuses safely.
- **O‑3 · `SSIM_GC_VERIFIED` is the live-execution gate.** Severity: by design. Set `=1` **only after** the
  owner verifies the mechanism on a test account. Without it, deposit/withdraw/craft never run.
- **O‑4 · Trade-up input floats are estimated (web has no floats).** Severity: low (preview accuracy). EV is
  flagged as an estimate; exact EV needs the GC `paint_wear` (available on the execution path) or an
  inspect-link float service. *Action (optional):* read real floats via the GC at preview time.
- **O‑5 · Casket right-panel item names.** Severity: low (cosmetic). GC casket items are raw (id + def_index);
  full `market_hash_name` resolution needs the `items_game` schema. The panel shows id/custom_name/def_index.
- **O‑6 · Trade-up search is bounded, not exhaustive over all C(n,10).** Severity: low (by design, Section 1).
  It evaluates cheapest-mixed + per-collection cheapest/lowest-float; the per-candidate math is exact.
  *Action (optional):* add more candidate generators (e.g. profit-optimized float/cost trade-offs).
- **O‑7 · Single-collection trade-ups need ≥10 eligible items of one collection in the account.** Severity:
  low (inherent to the contract rules). Mixed-collection cheapest-10 covers the rest.

No unexplained open points.

---

## 7) Owner-only live tests + enablement (require the live fleet)

1. **Install + wire the GC dependency:** `npm install globaloffensive`; add
   `"node_modules/globaloffensive/**/*"` to `pkg.assets`; rebuild (`npm run build`).
2. **Verify the trade-up CRAFT mechanism** on a test account with throwaway skins (O‑2), then implement/
   confirm `GcActionLayer.craftTradeUp`'s actual GC send.
3. **Enable execution:** set `SSIM_GC_VERIFIED=1` (after step 2).
4. **First real storage move:** deposit then withdraw a **single** item on one bot via the Storage modal;
   confirm it lands/leaves the unit and the cache updates.
5. **First real trade-up:** run ONE positive-profit contract on a bot you don't mind spending; confirm the
   10 inputs are consumed and the output arrives, and that re-clicking never double-crafts.
6. **Ban-check at scale (read-only, allowed):** run a multi-env Global ban check; confirm per-env keys,
   the 20-per-key rotation, and that no env's key ever touches another env's accounts (watch the logs).

---

## 8) Files

New: `src/trading/tradeupMath.ts`, `src/core/Cs2SchemaService.ts`, `src/trading/TradeUpService.ts`,
`src/trading/GcActionLayer.ts`, `src/trading/CasketService.ts`.
Changed: `src/api/server.ts` (deps + endpoints + money-op breaker), `src/trading/BanService.ts` (F3c),
`src/core/ValueHistoryService.ts` (F3b aggregate), `public/app.js` (F3a/b + both modals + header buttons).
Commits: `7a45415` (F3c) · `310cb90` (trade-up math/schema) · `8504d39` (GC layer + execution + API) ·
`248f1f4` (UIs), plus `c9d9938`/earlier (F3a/F3b).
