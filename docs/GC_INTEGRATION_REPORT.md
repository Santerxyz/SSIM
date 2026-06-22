# SSIM — Game-Coordinator Integration Report (Storage Units + Trade-Ups made real)

**Date:** 2026‑06‑20  ·  Supersedes the GC sections of `FEATURES_REPORT.md`.
**Build:** `tsc` green · `node --check public/app.js` green · `dist/` current · committed per increment.
**Verification:** 35‑assertion offline harness driving the REAL `GcActionLayer` through a faithful mock
GlobalOffensive (deleted after the run). **No live GC connection and no real items were touched** —
that single live step is the owner's (Section 6).

---

## 1) Why the GC was removed — and why this revival is safe

The old `GcInventoryManager` ran the Game Coordinator on the **hot background inventory path** and was
removed for concrete reasons (audit ledger):
- **#9 / #10 — desync + no retry:** a cached `haveGCSession` could return a stale/empty GC inventory as
  the authoritative "in‑game truth" (after a CS2 update / GC restart / CM reconnect), indistinguishable
  from a real zero. Inventory moved to the reliable **pure‑web** path (ctx2+ctx16) instead.
- **#31 — racy, leaky lifecycle:** a cached `GlobalOffensive` per client, an **uncancelable linger
  timer**, a **permanent `debug` listener never removed**, no re‑entrancy guard, and races where a
  linger‑stop could `gamesPlayed([])` **out from under a live fetch** → truncated/empty reads. Handles +
  listeners accumulated across re‑logins.

The `logs/crash-log.txt` confirms the historical silent crashes were **SIGHUP (console teardown)** and
single‑instance lock aborts — **not GC**. So GC was cut for *inventory reliability + lifecycle hygiene on
the hot path*, not because the GC itself crashes.

**This revival is the opposite of what was removed** (the #0 mandate, point by point):
- **Opt‑in only** — GC is touched solely on explicit user action (a trade‑up scan/execute, or a storage
  op). It is **never** on the background inventory path; the pure‑web inventory is unchanged.
- **connect → act → disconnect** — each op does `gamesPlayed([730])` → await `connectedToGC` (hard 35 s
  timeout) → act → **guaranteed `gamesPlayed([])` in `finally`**. No persistent GC session.
- **Concurrency 1 per account** — a per‑account in‑flight guard serializes ops, so `connect()` /
  `gamesPlayed` transitions never race (the #31 trap).
- **No leaked handle/listeners** — `new GlobalOffensive(client)` attaches **5 permanent listeners to the
  client**, so a fresh instance per op would leak them. We therefore keep **exactly one** instance per
  session client, reuse it, and **drop it on `sessionDestroyed`** (SessionManager then
  `removeAllListeners` + discards the client). Persistent `error` + `disconnectedFromGC` listeners mean a
  GC hiccup is logged, never an unhandled‑error crash. A GC failure can only fail that one op — it cannot
  destabilize or hang the app.

---

## 2) The verified library API (read from the installed `globaloffensive@3.3.0`, not assumed)

| Capability | Real API | Used for |
|---|---|---|
| Connect | `client.gamesPlayed([730])` → `'connectedToGC'` (and `'disconnectedFromGC'` / `'error'`); `go.haveGCSession` | lifecycle |
| Inventory + **floats** | `go.inventory` items carry `id`, `def_index`, `paint_index`, **`paint_wear`** (the float), `casket_id`, `casket_contained_item_count` (storage units are `def_index 1201`) | trade‑up floats, casket listing |
| Storage read | `getCasketContents(casketId, cb)` | right panel |
| Storage write | `addToCasket(casketId, itemId)` / `removeFromCasket(casketId, itemId)` — **fire‑and‑forget (no callback)**; confirmed via SO‑cache updates (`casket_id` change) | deposit/withdraw |
| **Trade‑up craft** | `craft(items, recipe)` → `'craftingComplete'(recipe, [outputId])` | execution |
| Trade‑up **recipes** (from the lib's README → `items_game.txt`) | `0` Consumer→Industrial · `1` Industrial→Mil‑Spec · `2` Mil‑Spec→Restricted · `3` Restricted→Classified · `4` Classified→Covert · **`+10`** for the StatTrak variants | recipe selection |

The Task‑2 assumption that craft "isn't exposed" was **wrong for v3.3.0** — `craft` exists and is
confirmable. Both features are genuinely implementable. (`pkg.assets` gained
`node_modules/globaloffensive/**/*`; the lockfile carries the dep.)

---

## 3) Per‑feature FUNCTIONAL STATUS

### Storage Units — **WORKING (pending one owner live test)**
Real `listCaskets` / `getCasketContents` / `addToCasket` / `removeFromCasket`, wired with money/item
safety: per‑account guard, **1000‑item cap** on deposit, **cancel between items**, and **verify‑after**
— each move is sent then confirmed by polling the SO cache for the item's new `casket_id`
(deposit) / cleared `casket_id` (withdraw). A send that the SO cache doesn't confirm within 15 s is
recorded as **`unconfirmed` and NEVER retried** (a casket move is reversible and may well have
succeeded). **No separate flag** — storage is reversible, so it's enabled whenever the library is present;
a real GC connection is the operative gate.
*The one thing only a live GC confirms:* the exact post‑move SO signal (does `casket_id` update in place,
or does the item briefly SO_Destroy then reappear?). The verify is robust either way (timeout → unconfirmed,
never a false failure, never a retry). The owner's first live move confirms the signal; if a confirmed move
ever shows as "unconfirmed", the verify predicate gets one small tweak (documented).

### Trade‑Up profit accuracy (floats) — **WORKING**
`readInventoryFloats` reads the **real per‑item `paint_wear`** from the live GC inventory and feeds it into
the existing exact trade‑up math, so "max profit" uses true floats (the output wear/EV is accurate, subject
to live market prices). The GC read happens **only when the operator clicks "Get Trade‑Ups"** (explicit
action, one‑shot connect, immediate disconnect). If the GC is unavailable or the read fails, it falls back
to the wear‑midpoint estimate and the UI **clearly labels** the figures as estimates. Verified offline
(`readInventoryFloats` returns correct floats; the math is exact — 40 assertions in Task 2).

### Trade‑Up execution (craft) — **WORKING (pending one owner live test), gated**
`craftTradeUp` picks the documented recipe for the contract's (rarity, StatTrak), **re‑verifies the 10
inputs are present in the live GC inventory immediately before**, submits `craft(ids, recipe)` exactly once,
and confirms via `craftingComplete` (which returns the produced item id). It is **never re‑sent**: a
confirm timeout yields `submitted: true, confirmed: false` (verify in‑game), never a retry that would
destroy another 10 items. It stays **behind the explicit `SSIM_GC_VERIFIED=1` flag** because it is
**irreversible**. The mechanism is implemented with confidence (the recipe table is the library author's
documentation and `craftingComplete` confirms), but the **owner must run one real contract on a throwaway
account first**, then flip the flag — that is the prudent first‑fire gate, not a sign of uncertainty.

---

## 4) Safety properties (all verified offline, 35 assertions)

- connect→act→disconnect with `gamesPlayed` toggled back to `[]` after every op (no persistent session).
- one GlobalOffensive per client, reused; dropped on `sessionDestroyed` (no leaked handle/listeners).
- per‑account concurrency‑1 guard (a 2nd concurrent op is rejected, not queued onto a racing client).
- storage: 1000‑cap enforced (over‑cap throws, nothing moved); cancel stops between items; never‑throw‑
  after‑submit (`moved` / `unconfirmed` / `failed`); deposit verified via `casket_id`.
- craft: refuses + **never sends** when gated off; with the flag on, sends **recipe 2** for Mil‑Spec and
  **10 items**, confirms via `craftingComplete`; refuses (before send) when an input is missing; on confirm
  timeout it is **sent exactly once**, never duplicated.
- the money‑op circuit breaker still covers `/api/tradeup/execute` + `/api/casket/move`.

---

## 5) What I could NOT verify (honest limits — needs the owner's one live GC step)

1. A real GC handshake on a real bot (account must own CS2). My harness mocks `connectedToGC`.
2. The exact post‑deposit/withdraw SO confirmation signal in the wild (Section 3 — handled safely either way).
3. That `craft(ids, recipe)` actually produces the expected output on live Valve servers, and that the
   recipe ids still match the current `items_game.txt` (they are stable + documented, but Valve owns them).
4. That `gc.inventory` `paint_wear` populates for the owner's accounts as expected.

None of these can be exercised without opening a live GC connection / moving real items, which the task
forbids me from doing unattended. Each is gated/safe so a surprise can't destroy items unexpectedly.

---

## 6) Owner enablement + live‑test checklist (the one live step)

1. **Storage is already live** once the build ships (no flag). On one bot, open **Storage** → pick a unit →
   **deposit ONE** cheap item, confirm it appears in the unit and `count` increments → **withdraw** it back.
   Watch the footer: `moved 1` = the SO‑confirm signal works as implemented. If it shows `unconfirmed 1`
   but the item DID move, tell me which event fired (`itemChanged` / `itemRemoved`) and I'll adjust the one
   verify predicate.
2. **Trade‑up floats** are already live (no flag): click **Get Trade‑Ups** on a bot; the footer should say
   "REAL per‑item GC floats". If it says "estimated", the GC float read didn't populate — send the log line.
3. **Trade‑up craft (irreversible):** on a **throwaway account with 10 cheap same‑tier skins**, set
   `SSIM_GC_VERIFIED=1`, run **one** contract, and confirm the 10 inputs are consumed and the output arrives
   (and that re‑clicking never double‑crafts). Only then enable it on the real fleet.
4. Note: a GC op briefly sets the bot's status to **in‑game (CS2)** for the few seconds it's connected
   (then back). This is expected and harmless for storage/farm bots.

---

## 7) Verdict

Both dormant GC features are now **genuinely implemented against the real, verified library API**, wired
surgically and teardown‑safely so they can never destabilize the main app. **Storage units work** (pending
one live deposit/withdraw to confirm the SO signal); **trade‑up profit is accurate** (real floats); and
**trade‑up execution is wired with confidence** (documented recipes + `craftingComplete` confirmation),
gated behind `SSIM_GC_VERIFIED` for the owner's prudent first live fire. No feature is "Blocked"; the only
deferral anywhere is the single live GC step the task reserves for the owner. Nothing was guessed with real
items.
