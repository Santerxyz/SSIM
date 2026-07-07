# VERIFICATION — SSIM frontend redesign (Phase 4)

Re-skin verified behavior-preserving by (a) direct global proofs, (b) an independent adversarial
multi-agent pass (12 read-only agents diffing new vs `legacy_public`), and (c) the untouched backend
staying green. Date 2026-07-07, branch `redesign/frontend-v2` @ tip after V19 + Phase-4 polish.

## 0. Global proofs (mechanical, whole-app)
- **Handler-safety.** `git diff <pre-V5>..HEAD -- new_public/app.js` filtered for
  `api(/csfApi(/fetch(/EventSource(/ssimConfirm/addEventListener/.method/setTimeout/state.=/CSF.=`
  → the ONLY match is the deliberate `updateGameToggle` re-wire (className overwrite →
  `classList.toggle('is-on')`, same `state.game` read). Every other diff line is a markup/CSS-class
  string inside a render template. **Zero handler/API/state/confirm logic changed.**
- **Hooks.** `comm -23` of `id="…"` sets (legacy vs new index.html) = EMPTY → **292/292 static ids
  preserved**. `comm -23` of `data-*` tokens (legacy vs new app.js) = EMPTY → **every delegation hook
  preserved**. No new `data-*` vocabulary introduced.
- **Per-view gate.** Every view committed only after `node --check new_public/app.js` = 0 and
  `index.html` div-balanced (250/250 throughout).
- **Backend (frozen).** `npm run build` (tsc) exit 0; `npm test` = **947 tests, 942 pass, 0 fail,
  5 skipped** (unchanged v1.3.6).

## 1. Contract audit (API_CONTRACT.md) — PASS
Independent agent: **101/101 endpoints preserved byte-for-byte, 0 changed/dropped.** All 119
`api()/csfApi()/fetch()/EventSource()` call sites in new app.js are byte-identical to legacy. HTTP
method multiset matches exactly (42 POST / 7 DELETE / 4 PATCH / 4 PUT). The capability-token layer
(`api()` wrapper, `capToken()`, `awaitCap()`, `X-SSIM-Cap`, `MUTATING_METHODS` gate, 120 s timeout,
error shape) is byte-identical → reload survival intact. Portal/stream endpoints
(vault/state·unlock, license/state·activate, app/ping·open-logs, logs/stream SSE) identical too.

## 2. Sacred invariants (§4) — 9/9 PASS
| # | Invariant | Where implemented + how verified |
|---|---|---|
| 1 | **Balance tri-state** | `fmtWallet`/`fmtBalance` (app.js ~730) byte-identical: null/undefined/'' → `—`, real 0 → `0,00`, else localized value. `renderBuyWallet` + `renderAccountRow`/`patchSidebarBalances` never gate on truthiness (a funded-0 wallet is a truthy object). Verified byte-identical vs legacy. |
| 2 | **One refresh button** | Refresh-affordance id set is 1:1 identical new vs legacy (`btn-refresh-all`, `btn-refresh-folder`, `btn-sel-refresh`, `btn-refresh-global`, `orders-refresh`, `offers-refresh`, `btn-load`). No second full-refresh affordance added; the quick ctx2 buy-verify stays in `submitBuy` (untouched). |
| 3 | **ssimConfirm on money actions** | `grep \bconfirm(/\balert(` in new app.js = only a code comment (0 real calls) — same as legacy. `ssimConfirm` call count = **19 == legacy**. Every buy/sell/list/cancel/accept/decline/delete/clear-key path gated. |
| 4 | **Layering law (S68)** | app.js z-index multiset byte-identical new==legacy (z-20×1, z-30×1, z-40×6, z-50×3, z-[100]×1). `#ban-overlay` stays **z-30** below Move **z-40**; Live-Logs launcher z-30 below overlays; toasts/alerts topmost. One documented scale. |
| 5 | **Pricing honesty (S2/S13)** | Sell-preview unpriced rows → distinct `.pill pill--danger` "no price" vs emerald Net (priced); Active-Orders `data.partial` amber banner preserved; history partial-wallet → dashed line + "(incomplete)". Failed fetch stays visually distinct from "no price". |
| 6 | **Reload survival (S1)** | `capToken()` / `awaitCap()` / `MUTATING_METHODS.has(method) → await awaitCap()` byte-identical; `index.html` `<script src="/app.js">` load timing + `window.__SSIM_CAP__` injection preserved (V1). |
| 7 | **Fleet scale** | Windowing (`unmountWindow`/`mountWindowedRows`/`renderTable` core) byte-identical; event delegation (`setupDelegation`, `onSidebarClick`) unchanged; single-cell `patchSidebarBalances` still updates only the balance chip (no full re-render). |
| 8 | **Brand** | Zero German UI strings (grep Konto/Löschen/Aktualisieren/Passwort/… = none); `de-DE` appears ONLY in EUR money formatters (ST-02) and never on a chart axis (V7 fixed to en-GB). New logo `image-Photoroom.png` wired across index/splash/unlock/license; **0** remaining `logo.png` image refs. Accent = `--brand-rgb`. |
| 9 | **Capability ceiling** | No native sign-in, no GC features added. Import methods = exactly maFiles/CSV/Vault (3). The only `globaloffensive`/`refresh_token` mentions are pre-existing status/warning strings, not new capability. Floor == ceiling == legacy. |

## 3. Per-view adversarial verdicts (9 money views) — all SAFE, 0 regressions
Each verified: handlers byte-identical, hooks preserved, DOM-traversal deps still satisfied, honesty invariants hold.
- **V8 Active-Orders** — `removeOrderRow`'s `row.parentElement → previousElementSibling(.panel-head) → querySelector('span.font-mono')` still resolves (count span is the only `span.font-mono` in the header); `.order-row/.order-check/.order-cancel` + `data-cancel-*` + `#orders-*` ids preserved; partial banner + bulk-cancel restore string intact.
- **V9 Trade-Offers** — 2FA honesty (single + batch "awaiting mobile confirmation") byte-identical; `removeOfferRow` `closest('#offers-sent-list')` valid; `.offer-row/.offer-check/.offer-act` + `data-offer-*` preserved.
- **V10 Market-Buy** — **sacred `createBuyOrder` re-POST to `/api/market/buy` byte-identical** (body/method/`Number(r.filled)>0` coercion/dual `startInventoryRefresh`); balance tri-state in `renderBuyWallet` not gated on truthiness; 16 `#buy-*` ids + `data-i` preserved.
- **V11 Folder Mass-Buy** — **forced 2-phase pre-buy balance refresh in `submitFolderBuy` byte-identical** (ssimConfirm spend gate + "Refreshing balances…" + `POST /api/market/folder-buy` + `pollFolderBuy`); 17 `#fbuy-*` ids preserved. (`handlersByteIdentical` flagged false only because the two *render* helpers' class strings differ — expected; all executors identical.)
- **V12 Market-Sell** — pricing honesty (unpriced `pill--danger` vs emerald Net) preserved; `submitSell`/`previewSell`/`pollSell` byte-identical; `data-reprice` + `sellstrategy` radios intact.
- **V13 Send-Trade** — `submitTrade` + ssimConfirm gate byte-identical; `[data-recip]` delegation intact.
- **V14 Ban-Checker** — `#ban-overlay` z-30 (below Move z-40) preserved; `onBanBodyClick` (`data-ban-toggle`/`data-ban-move` → `openMoveModal`) byte-identical; error/Lookup-Failed stays visually distinct from clean.
- **V15 Trade-Ups + Caskets** — `tuStart` (execute) + `casketMove` + `casketPollMove` + `loadCasketContents` byte-identical; lazily-built overlay inner ids preserved.
- **V16 CSFloat** — all 5 money `ssimConfirm` gates present; every `csfApi()` call + all `data-csf` actions byte-identical.

## 4. Completeness audit — core claim holds
0 missing hooks · 0 native confirm/alert · 0 new external/CDN URLs (offline-always holds) · 0 German
strings · `ssimConfirm` gate parity. Residuals found were **cosmetic and byte-identical to legacy**
(price-source/currency control kept custom for the dropdown contract; the confirm dialog + CSFloat
auto-accept toggle were subsequently DS-polished; a few decorative non-button hovers remain) — see
`CHANGES.md` (Phase-4 polish) + `OWNER_NOTES.md`. None affect behavior, hooks, or money paths.

## 5. Live run
Not executed against real Steam/CSFloat during development (money actions must never be auto-triggered).
The full click-through, and **every money path**, is enumerated for the owner in
`LIVE_TEST_CHECKLIST.md`. Backend build + 947-test suite are green, so a cutover smoke-test only needs
to confirm the frontend renders + the non-money walkthrough before the owner's money-path testing.
