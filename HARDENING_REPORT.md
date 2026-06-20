# SSIM — A‑to‑Z Hardening Report

**Date:** 2026‑06‑20  ·  **Scope:** full codebase (`src/**`, `public/**`, `build/**`, root scripts)
**Method:** every backend module read line‑by‑line; frontend XSS/state surface audited; pure‑function
invariants re‑proved with an isolated harness. **No live Steam/real‑money operations were performed.**
**Build state:** `tsc` green · `node --check public/app.js` green · `dist/` rebuilt and current.

---

## 1) Executive summary — the codebase's state

SSIM is a **mature, heavily‑hardened, security‑conscious** codebase. It has clearly been through
extensive prior remediation (the `#NN` markers throughout the source map to `AUDIT_LEDGER.md` /
`REMEDIATION_LOG.md`), and that work holds up under a fresh adversarial read. The money‑safety,
vault‑crypto, session‑lifecycle, defensive‑parsing, and data‑integrity invariants are **all present
and correct**. This was an audit of a strong system, not a rescue of a weak one.

Highlights confirmed sound:

- **Money safety** — `BuyService` enforces every documented invariant: per‑`(account,appid,item)`
  in‑flight guard, *currency‑must‑be‑known* (fail‑closed), per‑order value ceiling + live‑balance
  ceiling, **never‑throw‑after‑placed**, and a real inventory/wallet before→after diff as the source
  of truth. The sacred `createBuyOrder` finalize re‑POST (406 → type‑12 confirmation matched by
  CREATOR → approve → single re‑POST) is **untouched**.
- **Vault** — portable AES‑256‑GCM with scrypt (N=2¹⁵), KDF params stored in the header (re‑tuning
  never bricks an old vault), atomic writes with one‑gen backup, debounced saves, no machine binding,
  no backdoor. Wrong password fails on GCM auth. Round‑trip re‑proved (harness).
- **Imports are non‑destructive** — every path (`migrateAccountsIntoVault`, drop‑zone, CSV, external
  vault) is *add‑new‑only*, skips already‑known usernames (vault **or** un‑vaulted accounts.json
  orphans), uses `path.basename` against traversal, and never deletes plaintext sources. The
  `importAccount` guard refuses records missing `shared_secret`/`password`, so a transient failure can
  never blank a recoverable plaintext credential.
- **Security surface** — loopback‑only bind by default; layered DNS‑rebind Host allow‑list +
  same‑origin/anti‑CSRF guard; `express.json` limit; the money‑ops circuit breaker; thorough body
  validation on every route; the catch‑all error handler returns a generic 500 (no internal leak);
  proxy creds redacted in logs/crash sink/API errors; frontend escapes all dynamic HTML, validates
  item colors against a hex regex, and allow‑lists icon hosts.
- **Reliability** — `SessionManager` has per‑account in‑flight login dedup, full timer/listener/agent
  teardown, token‑preservation on transient errors; `InventoryManager` paginates with a hard cap and
  loud truncation warnings; `InventoryStore` deep‑clones on read (a correctness guard for trade‑lock
  state) and refuses to let a stale fetch clobber a newer snapshot; all JSON persistence is crash‑safe
  (temp + fsync + atomic rename + backup).
- **Licensing/anti‑tamper** — Ed25519 server‑authoritative tokens, HWID binding, clock‑rollback
  defense (#21), token shape validation (#39); the auto‑updater verifies sha256 **and** Ed25519
  signature before executing, gated on `IS_PACKAGED`.

**Changes shipped this session:** one surgical hardening fix (below) plus one zero‑risk comment
correction. Everything else either was already correct or is a consciously‑deferred low‑severity open
point (Section 4).

---

## 2) Per‑module findings

Severity key: **P0** money/security/vault · **P1** reliability · **P2** scale/perf · **P3** quality.
"✔ sound" = audited, no change needed.

### Trading (money paths)
| Module | Finding | Sev | Disposition |
|---|---|---|---|
| `trading/BuyService.ts` | All money‑safety invariants present & correct. Unclamped explicit `p.concurrency` in `runMassBuy` (not currently API‑reachable). | P2 | **Fixed** (clamped, defense‑in‑depth). Logic otherwise ✔ sound. |
| `trading/MarketService.ts` | `runMassSell` honoured an explicit `opts.concurrency` verbatim; that value **is** reachable from `/api/market/sell` body → could exceed the intentional 25 ceiling (proxy/socket stability). | **P2** | **Fixed** — see Section 3. |
| `trading/TradeService.ts` | Mass‑send correctly decoupled from the scaler, hard ceiling 1, jittered global throttle, per‑send in‑flight idempotency guard. Stale comment said "exactly 3". | P3 | Comment corrected to "1". Logic ✔ sound. |
| `trading/AccountTrader.ts` | The sacred `createBuyOrder` 406→confirm→single re‑POST path is correct and money‑safe (never re‑creates; never throws after placed). Per‑account network isolation, defensive `error` listeners, bounded confirmation retries. | — | ✔ sound — **untouched** (absolute constraint). |
| `trading/BanService.ts` | SteamID resolved only from precision‑safe **string** sources (never the lossy parsed number); login‑resolve hard‑capped at 25 to prevent a mass‑login crash; key caching; redaction. | — | ✔ sound. |

### Core (session / inventory / data)
| Module | Finding | Sev | Disposition |
|---|---|---|---|
| `core/SessionManager.ts` | In‑flight login dedup; full teardown (timer cleared, listeners dropped, no‑op error handler retained, per‑account proxy agent destroyed); token kept on transient/connection errors, deleted only on strong auth‑failure evidence. | — | ✔ sound. |
| `core/InventoryService.ts` | `forceRefresh` bypasses coalescing for buy‑verification; #10 guard never overwrites a known‑non‑empty cache with a 0‑read; per‑IP local throttle. Unclamped explicit `concurrency` in `startRefresh` (not currently API‑reachable). | P2 | **Fixed** (clamped, defense‑in‑depth). Logic ✔ sound. |
| `core/InventoryManager.ts` | Paginated fetch w/ hard cap + loud truncation (#12); mid‑pagination silent cookie renewal (#33); fail‑safe trade‑lock parsing (notice‑present‑but‑unparseable ⇒ treat as locked, #34); SteamID64 normalization. | — | ✔ sound. |
| `core/InventoryStore.ts` | Shape validation on load; deep‑clone on read (correctness guard for lock/category state); #13 newest‑wins on set; bounded LRU; atomic flush. | — | ✔ sound. |
| `core/AccountVault.ts` | AES‑256‑GCM + scrypt, header‑stored KDF params, atomic+backup writes, debounced token saves, blank‑credential import guard. | — | ✔ sound. Round‑trip re‑proved. |
| `core/vaultBoot.ts` | Every import path non‑destructive, add‑new‑only, traversal‑safe, never deletes plaintext. | — | ✔ sound. |
| `core/AccountManager.ts` | Atomic writes; in vault mode blanks secrets **only** for accounts actually vaulted (keeps recoverable plaintext otherwise); folder cycle guards; non‑destructive folder delete (re‑parents). | — | ✔ sound. |
| `core/TokenStore.ts`, `core/maFiles.ts`, `core/MarketListings.ts`, `core/ValueHistoryService.ts`, `core/LoginFlow.ts` | Shape validation, quoted‑CSV parsing, defensive `?? []`, bounded history, vault‑aware password fallback (`||` not `??` so a blank vault entry never masks a real plaintext). | — | ✔ sound. |

### API / security / licensing / pricing / utils
| Module | Finding | Sev | Disposition |
|---|---|---|---|
| `api/server.ts` | Layered Host + origin guards; money‑ops breaker; thorough per‑route validation; generic 500 catch‑all; async‑tail log read; sanitizers redact proxy creds. Inline Host/origin checks are redundant with `originGuard` (belt‑and‑braces). | — | ✔ sound (redundancy is intentional defense‑in‑depth; not removed). |
| `api/originGuard.ts` | Correct same‑origin CSRF logic + DNS‑rebind guard; refuses no‑Origin state‑changing calls. | — | ✔ sound. |
| `licensing/*` | Ed25519 verify, HWID binding, clock‑rollback defense, signed‑update verification. `config.ts` is honest about the shared‑pepper limit (#22). | — | ✔ sound. |
| `core/unlockPortal.ts`, `licensing/ActivationServer.ts` | Serve only `/assets` (no dashboard pre‑unlock), 403/423 all other API. Lack the main app's Host/origin guard. | low | **Open point O‑1** (see §4) — not changed unattended (boot‑critical, cryptographically gated). |
| `pricing/*` | Separator‑aware money parsing; spike‑resistant min(lowest,median); #17 bounded retries; #61 try/finally; FX fallback + provenance. | — | ✔ sound. |
| `utils/*`, `bootflags.ts`, `network/*` | Crash‑safe atomic JSON (fsync + unique temp), redaction in logger + crash sink, mem‑heartbeat, multi‑format proxy parse, SOCKS host‑IP‑leak prevention, local‑IP throttle. | — | ✔ sound. |
| `public/app.js` + HTML | `escapeHtml`/`escapeAttr` on all dynamic values; `HEX_RE` color validation; icon‑host allow‑list (#29); wallet 3‑state (`—`/`0,00`/value) preserved; English‑only confirmed. | — | ✔ sound. |

---

## 3) The fix shipped + invariants re‑proved

### Fix — enforce the 25‑worker concurrency ceiling against API overrides (P2)
**Root cause.** `MarketService.runMassSell` used `opts?.concurrency ?? scaleConcurrency(...)`. The
explicit override is reachable from the loopback API body (`POST /api/market/sell { concurrency }`),
so a client value such as `1000` would spawn `min(1000, bots)` workers — bypassing the **intentional
25 ceiling** (`MAX_CONCURRENCY`, documented in `REMEDIATION_LOG` #4 as deliberately lowered 50→25 for
proxy/socket stability). `BuyService.runMassBuy` and `InventoryService.startRefresh` shared the same
pattern (not currently API‑reachable, fixed defensively).

**Change.** New single enforcement point `clampConcurrency(value, fallback, max=25)` in
`utils/concurrency.ts`; all three `scaleConcurrency` consumers route through it. The **default path is
unchanged** — `scaleConcurrency` already returns ≤ 25, so clamping a scaled value is a no‑op; only an
out‑of‑band explicit override now changes. `TradeService` (hard ceiling 1) was already clamped and is
untouched apart from a stale‑comment fix. Files: `utils/concurrency.ts`, `trading/MarketService.ts`,
`trading/BuyService.ts`, `core/InventoryService.ts`, `trading/TradeService.ts`.

**Why safe.** It only ever *lowers* an over‑ceiling request to the documented maximum — it cannot
change a legitimate (≤25) value, and it aligns exactly with the standing invariant "do not raise 25".

### Invariants re‑proved (isolated harness — 42 assertions, all green)
Run with `SSIM_HOME` pointed at a throwaway temp dir and a throwaway password, so the **real `Vault/`
and `data/` were never touched** (confirmed: vault.enc mtime unchanged). Harness kept in a temp dir
and deleted after the run — no scaffolding left in the tree.

- **Concurrency** — scaler band intact (`10→5, 50→10, 100→20, 500→25, 5000→25, 0→5`);
  `clamp(1000)→25`, `clamp(26)→25`, `clamp(10)→10`, `clamp(undefined/0/−5/NaN)→fallback`,
  `clamp(fallback=999)→25`.
- **Currency/scale** — `"2,14€"→214`, `"$1,234.56"→123456`, `"1.234,56€"→123456`, `"¥150"(0‑dec)→150`,
  `"₩1,234"(0‑dec)→1234`, `"5"→500`, garbage/null→`null`; `currencyInfo` fallback + 0‑decimal table.
- **Market fee solver** — over buyer = 3…200 000: `net + feesForNet(net) ≤ buyer` **and** `net` is
  maximal (`net+1` would exceed). Fee floor `feesForNet(1)=2`.
- **Vault crypto** — create → upsert → token set → read‑back (case‑insensitive); wrong password →
  `null` (GCM auth fail); right password → recovers accounts; `importAccount` rejects blank
  `shared_secret`/`password`.
- **Redaction/proxy** — proxy creds masked to `***:***@`; multi‑format proxy normalization.
- **Inventory stacking** — identical unlocked items collapse (qty 2, both asset ids); a different
  lock‑state stays a separate stack.

### Balance 3‑state (statically proved, no harness needed)
`InventoryService` attaches `inv.wallet` *only* when `session.wallet` exists (the wallet event fired =
account was refreshed), with `balance = hasWallet ? balance : 0`. Frontend: `wallet ? fmtWallet(...) :
(refreshed ? 0,00 : '—')`. ⇒ never‑refreshed `—`, refreshed‑empty `0,00`, funded value. **Preserved.**

---

## 4) Open points (consciously deferred, with recommendation)

**O‑1 · Activation/unlock temp portals lack the main app's Host/origin guard — severity: low.**
The brief boot portals (`ActivationServer.ts`, `unlockPortal.ts`) bind loopback by default and serve
only `/assets`, but do not run the DNS‑rebind Host allow‑list / same‑origin guard the main app uses.
*Why low:* the sensitive operation (vault unlock) is cryptographically gated — an attacker needs the
correct master password (scrypt + GCM), responses are CORS‑unreadable, and failed attempts are
throttled; activation merely binds the operator's own key. *Why not changed unattended:* it is on the
boot‑critical path and the change must mirror the main app's `LOOPBACK_BOUND` conditional (so a
deliberate `HOST=<LAN‑IP>` opt‑in is not broken), which I cannot fully runtime‑verify without the live
Steam/license/window flow. **Recommendation:** extract the loopback Host‑guard middleware and mount it
on both portals, gated on `LOOPBACK_BOUND`; verify the local boot reaches the unlock page and a
`Host: evil.com` request is refused.

**O‑2 · The loopback API does not authenticate other *local* processes — severity: low (known, #26).**
The CSRF/origin guard defeats malicious **web pages** the operator visits, but `Origin` is not a
boundary against a non‑browser local process that sets the header itself. Already documented in
`AUDIT_LEDGER #26`. *Threat‑model note:* a hostile local process already has filesystem access to
`vault.enc` (though not the master password). **Recommendation (owner, as previously noted):** a
boot‑token cookie minted at startup and required on mutating routes.

**O‑3 · `decryptExternalVault` / `unlockOrCreate` trust the scrypt `N` from the file header —
severity: very low.** A maliciously huge `N` in an imported/edited vault file could make `scryptSync`
block (local DoS). Requires the attacker to supply the vault file. **Recommendation:** clamp header
`N` to a sane maximum (e.g. ≤ 2²⁰) before deriving.

**O‑4 · `PriceCache.load` does not validate per‑entry shape — severity: very low (display‑only).**
A corrupt/hand‑edited `prices.json` with a non‑number `cents` could yield `NaN` in *display* value
totals. Actual buy/sell prices come from the live `MarketPricing` path, **not** this cache, so there is
no money‑path impact. **Recommendation:** drop entries whose `cents` is not `number|null` on load.

No other open points. Every remaining item above is consciously deferred with a stated reason; there
are **zero unexplained open points**.

---

## 5) Owner‑only follow‑ups (require the live fleet — out of scope here)

These were **deliberately not performed** (real money / real accounts / unattended):

1. **Live buy‑confirm smoke test** — one real `createBuyOrder` on a funded test bot to re‑confirm the
   406 → type‑12 → re‑POST path end‑to‑end after any future change near it. (Unchanged this session.)
2. **Mass‑op at scale** — a real mass‑sell / folder mass‑buy across a folder, watching that the now
   server‑enforced 25 ceiling and per‑account pacing behave under proxy load.
3. **Real login at scale** — confirm token‑first login + web‑session refresh across the fleet.
4. **Updater end‑to‑end** — have the license backend serve a signed newer `ssim-backend.exe` and
   verify the two‑artifact sidecar swap/relaunch (noted untested in `tauri-migration` memory).
5. **Optional hardening** O‑1…O‑4 above, if the owner wants them; O‑1 is the highest‑value.
6. **Final protected build** — `npm run build:protected` / `build:tauri` is the owner's step (the
   protected `.exe` was intentionally not recompiled here).

---

## Verification trail
`tsc -p tsconfig.json` → exit 0 · `node --check public/app.js` → OK · isolated harness → 42/42 passed ·
real `Vault/` mtime unchanged · `git status` shows no secrets/user‑data tracked (`data/`, `Vault/`,
`mafiles/`, `secrets.local.bat`, `*.exe` all `!!` ignored). Baseline `44ffaf4`; fix `a42af43`.
