# SSIM Frontend Redesign — PORT PLAN

> The concrete build plan for wiring the **masterpiece design**
> (`redesign/design_source.html`) onto the **legacy function**
> (`redesign/legacy_public/app.js` 7,007 lines + `index.html` 1,552 + portals).
> This is the spec Phase 3 executes, view by view.
>
> **Inputs this plan binds:** `API_CONTRACT.md` (every backend call — FROZEN surface),
> `PARITY.md` (533 rows P-001…P-533, 43 groups, 125 💰), `DESIGN_SYSTEM.md` (tokens,
> ~60 DS classes, IA, overlay registry), `00_PROGRESS.md` (the 9 sacred invariants).
>
> **Backend (`src/`, `src-tauri/`, `build/`) is FROZEN.** Nothing in this plan changes a
> path, method, body shape, header, cadence, or response field. The redesign changes **form
> only** (DOM markup + CSS + shell), never **function** (API calls, state, handlers).
>
> Legacy citations are `app.js:NNNN` / `index.html:NNNN` (relative to `legacy_public/`);
> design citations are `ds:NNNN` (relative to `design_source.html`). Parity rows are `P-nnn`.

---

## 1. OVERALL STRATEGY

### 1.1 Default: **RE-SKIN** (keep legacy `app.js` function, re-emit masterpiece markup + swap CSS/shell)

The decided strategy (`00_PROGRESS.md §STRATEGY`) is **re-skin, preserve function**. We keep the
legacy JS engine — state machine, `api()` wrapper, `capToken()`, all render functions, all
pollers, virtualization, event delegation — and change **how the DOM looks**, not **what the
code does**. Three mechanisms make this a re-skin and not a rewrite:

1. **The design ships a portable `<style>` DS layer + Tailwind theme mirror that AUTO-UPGRADES
   the legacy DOM.** The masterpiece's `<style>` block (`ds:68-438`) is written to skin *the
   legacy markup as-is*. It contains explicit **frozen-contract adapters**:
   - `button.bg-brand:not(.seg *)` → rich gradient primary; `button.bg-emerald-600/.bg-teal-600/
     .bg-rose-600` → accent sheen (`ds:220-230`). The legacy already emits exactly these classes
     on every modal submit / CTA (verified `index.html`, `envTile` `app.js:1367`), so **primaries
     re-skin with zero markup edits**.
   - `div[id$="-overlay"] > div` → glass modal card; `div[id$="-overlay"] .sticky.bg-slate-900`
     → glass-blur sticky sub-header (`ds:286-289`, DESIGN_SYSTEM §2.5). Every legacy overlay
     follows the `id$="-overlay"` + inner-`<div>` contract, so **all 22 modals convert
     automatically**.
   - Tailwind theme extension re-points `brand/brand-dark/brand-light`, the `slate` scale, the
     semantic `success/warn/danger/buy/listed` colors, radii, and `text-2xs/3xs/4xs`
     (`ds:24-61`; P-003/P-004). Legacy utility classes (`text-slate-400`, `rounded-2xl`,
     `bg-brand/15`) therefore **remap to the new palette without being rewritten**.
   Net: swapping `assets/ssim-ui.css` for the DS `<style>` layer + porting the Tailwind theme
   re-skins the majority of legacy markup on contact.

2. **Legacy render functions build DOM via `innerHTML` template strings** (verified: `renderDashboard`
   `app.js:1276`, `envTile` `app.js:1342-1381`, `openAccountLogs` `app.js:1330-1335`, and every
   list/table/modal renderer). Re-skinning a view = **editing the class strings inside its template
   literal** to add the DS component classes (`.stat-card`, `.env-tile`, `.pill`, `.chip`, `.seg`,
   `.btn btn-primary`, `.items-table`), while leaving the `data-*` hooks, IDs, and all surrounding
   JS logic byte-identical. The event-delegation wiring keys off `data-*`/IDs (`setupDelegation`
   `app.js:1553`), so re-emitting richer inner markup never breaks a handler.

3. **The masterpiece is a design prototype with the same IA the legacy already implements** — same
   sidebar + resizer + main split, same 2 physical screens (dashboard/inventory) hosting the same
   6 inventory view modes, same overlay set, same portals. `renderView → paintStats /
   renderFacetBar / applyAndRenderTable` in the prototype (`DESIGN_SYSTEM §5.4`) is the same spine
   as legacy `renderMain → renderTable`. So the port is a **class/markup mapping**, not a
   re-architecture.

**Re-skin recipe per view (the default loop):**
```
a. Identify the legacy render fn(s) + its innerHTML template(s).
b. From DESIGN_SYSTEM, pick the DS component classes that skin that markup.
c. Edit ONLY the class attributes / add wrapper elements the design requires
   (stat-card ::before accent, env-tile glow, seg control, pill/chip). Keep every
   id, data-*, event binding, and JS branch identical.
d. Delete the matching legacy ad-hoc Tailwind that the DS class now owns.
e. Verify the parity rows (P-nnn) the view covers still render + wire; verify the
   invariants in play; do NOT trigger any 💰 path (§5).
```

### 1.2 When a view DEVIATES to **per-view rebuild** (re-author the markup template, keep the JS contract)

A view deviates from pure re-skin when the design introduces **structure the legacy markup does
not have** — new wrapper elements, a different DOM tree, or a component the legacy faked with
ad-hoc utilities. In these cases we **rewrite the template literal's markup** (still inside the
same legacy render function, still emitting the same `id`/`data-*` hooks and feeding the same
handlers) rather than tweak class strings. The JS contract (inputs, API calls, state writes,
event names) stays frozen; only the emitted HTML tree is re-authored. Deviating views:

| View | Why it rebuilds the markup (not just classes) |
|---|---|
| **App shell / portals** | New `.portal` / `.portal-card` / `.env-tile` / `.stat-card` / `.seg` structures the legacy renders with flat divs. Shell wrapper + resizer restyle. |
| **Env tiles** (dashboard) | `.env-tile` adds `__glow` strip, `__actions`, inner `.env-stat` 2×2 grid (`ds:268-278`) — extra elements vs legacy's single flat card. |
| **Stat bar (4 KPI cards)** | `.stat-card` needs the `::before` gradient top-accent driven by inline `--stat-accent` (`ds:250`) — a per-card wrapper change. |
| **Segmented controls** (game / price-source / currency / login tabs) | `.seg` + `.split` structure (`ds:372-377`) replaces legacy split-button markup; children must NOT get the `bg-brand` auto-upgrade (`ds:224`). |
| **Item table** | `.items-wrap` + `.items-table` + `.rar` rarity bar + `.rn-*` name colors + sticky glass thead (`ds:334-353`). Row template re-authored; **`mountWindowed`/windowing math preserved verbatim**. |
| **Sidebar account row** | `.account-row` + `.account-btn` (`.is-active::before` left rail) + `.avatar` + status `.dot` + `.row-actions` (`ds:355-365`). |
| **Portals** (splash/unlock/license) | Full `.portal` rebuild — but these are **separate HTML files**; markup re-authored, the tiny inline `<script>` logic + fetch calls preserved verbatim. |

Everything else (buttons, fields, pills, chips, panels, empty states, toasts, confirm, modal
frames) re-skins via CSS class swap only.

---

## 2. FILE PLAN — the new `public/`

The build happens in `redesign/` and is only cut over to the live `public/` at the very end
(`00_PROGRESS §Cutover`; `ROLLBACK.md`). The new `public/` **mirrors the legacy file set 1:1** —
same filenames, same asset layout, same relative-URL contract (`API=''`, same-origin) — so the
Tauri shell serves it unchanged and the frozen backend never notices a difference.

```
public/
├── index.html          # dashboard shell — re-authored markup, DS <style> layer, SAME script/asset tags
├── app.js              # the legacy engine, re-skinned in place (see §2.2). ONE file, not ES modules.
├── unlock.html         # vault portal — re-skinned .portal, inline logic verbatim
├── license.html        # license portal — re-skinned .portal, inline logic verbatim
├── logs.html           # Live Logs window — re-skinned, EventSource stream verbatim
├── splash.html         # boot splash — re-skinned .portal
├── favicon.ico         # unchanged
└── assets/
    ├── ssim-ui.css     # the DS <style> layer extracted to a file (tokens + ~60 DS classes + adapters)
    ├── logo.png        # the SSIM shield (unchanged; used as-is, no recolor — DESIGN_SYSTEM §0)
    ├── logos/          # steam.svg, csfloat.svg (price-source swap) — unchanged
    └── vendor/         # tailwind.js, fontawesome/, inter/, fonts.css — unchanged, self-hosted (P-002, DS §6)
```

**Decisions:**

- **Single `app.js`, NOT ES modules.** The legacy is one 7,007-line file with a flat function
  namespace and one `<script src="/app.js">` tag (`index.html`). Splitting into modules would
  require rewriting the load order, the global function references the event-delegation relies on,
  and the cap-token boot timing — pure risk for zero design benefit. We re-skin `app.js` **in
  place**: edit template-literal markup, leave the module shape untouched. (If the file later
  needs splitting, that is a separate refactor, out of scope for the redesign.)

- **CSS as an extracted file, not inline `<style>`.** The masterpiece's DS layer (`ds:68-438`)
  becomes `assets/ssim-ui.css` (replacing the legacy `assets/ssim-ui.css` byte-for-byte in role).
  The Tailwind **theme extension** (`ds:24-61`) stays inline in `index.html`'s `<head>` where the
  legacy already configures Tailwind Play (P-003), because Tailwind Play reads its config from an
  inline block before scanning classes. Portals get their own minimal inline `.portal` CSS (they
  load before/without the dashboard CSS; keep them self-contained as the legacy does).

- **Vendored deps only — no CDN.** Tailwind Play, Font Awesome, Inter are all already vendored
  under `assets/vendor/` (verified in the legacy asset tree). The prototype's CDN `<link>`/`<script>`
  tags (`ds:23,64-66`) are **dropped**; we keep the legacy's local `<script src="/assets/vendor/
  tailwind.js">` + `assets/vendor/fonts.css` + fontawesome css (P-002, DS §6). CSP/self-contained
  requirement preserved.

- **Prototype meta-chrome is DROPPED** (DS §6): `.proto-bar`, `.portal-proto-states`/`.pstate`,
  the `designsys` style-guide screen, ALL mock generators (`ENVS/FOLDERS/genAccounts/genItems/
  itemsFor`), `S.bal`, `protoLoading()/protoError()`, `simulateRefresh()/fillFailed()`, hash
  deep-linking, `FX()` hardcoded 1.08. Real data/loading/error/refresh already come from the
  legacy engine.

### 2.1 Capability-token bootstrap + reload survival — preserved VERBATIM (P-157/P-158; API_CONTRACT §5; invariant 6)

This is the single most important mechanic and it is **copied byte-for-byte from legacy
`app.js:409-475`** into the new `app.js`. No re-skin touches it. Concretely preserved:

- `const API = ''` (`app.js:5`) — every call same-origin relative. Never a hardcoded port.
- `capToken()` (`app.js:415-429`): read `window.__SSIM_CAP__`; **stash to
  `sessionStorage['ssim_cap']`** the first time seen; **fall back to sessionStorage** after a
  reload; `try/catch` for private-mode. **Never `localStorage`** (cross-process leak). This is the
  S1 reload-survival fix and it is non-negotiable.
- `MUTATING_METHODS` + `awaitCap()` (`app.js:430-438`): poll the token every 25 ms up to 3000 ms
  before a mutating call; reads never wait.
- `api()` (`app.js:440-475`): attach `X-SSIM-Cap` on every call, 120 s default timeout
  (`opts.timeoutMs` override; `0/null` → none), AbortError → friendly timeout error with
  `status:0,timedOut:true`, rich thrown `Error` with `.status/.data/.message`, and the
  `401 {capabilityRequired:true}` → `renderCapabilityBanner()` trigger.
- Global error handlers (`app.js:477-504`): `window.onerror` / `unhandledrejection` → toast +
  capability-exempt POST `/api/app/client-error`, coalesced 1/s.

**How the shell delivers the token still works unchanged:** the Tauri shell `eval`s
`window.__SSIM_CAP__='<token>'` into the served `index.html` document out-of-band. The new
`index.html` keeps the same document shape and the same `<script src="/app.js">` load, so the
injection lands exactly as before. The re-skin **must not** reorder or defer that script in a way
that changes when `capToken()` first runs relative to the injection (`awaitCap`'s 3 s window
already tolerates the race).

### 2.2 Portal reload-survival + readiness gates — preserved VERBATIM (API_CONTRACT §2; invariant 8)

`unlock.html` / `license.html` / `splash.html` are **separate pages that render before the
dashboard cap token exists**. Their inline `<script>` logic is preserved verbatim; only their
markup is re-skinned into `.portal`/`.portal-card`. Preserved exactly:

- **No `X-SSIM-Cap`** on any portal fetch (they are capability-exempt): `/api/vault/state`,
  `/api/vault/unlock`, `/api/license/state`, `/api/license/activate`, `/api/system/status`
  (`cache:'no-store'`), `/api/app/ping`.
- **Readiness gates + `location.replace('/')`**: unlock polls `/api/system/status` every 500 ms,
  redirects when `vaultLocked !== true`; license polls every 700 ms, redirects when
  `licensed === true` (API_CONTRACT §2/§3). The vault discriminator is `vaultLocked!==true`, the
  license discriminator is `licensed===true` — kept exact.
- **Keep-alive `GET /api/app/ping` every 4000 ms** on index.html + unlock.html (P-024/P-506).
- **Orphan-vault mode**: `409 {orphaned:true}` on `/api/vault/unlock` switches unlock to the
  destructive "create NEW empty vault" mode (API_CONTRACT §7).

---

## 3. VIEW-BY-VIEW BUILD ORDER (riskiest-data-first)

Ordering follows `00_PROGRESS §Phase 3`: shell/nav first (everything depends on it), then the
highest-data-density / highest-risk fleet + inventory surfaces (where virtualization + the balance
tri-state + worth math live), then money surfaces, then the long tail, ending with the portals
(lowest data risk, already near-static). Each view lists: **design component(s)**, **legacy render
fn + API calls to reuse (both cited)**, **parity rows**, **invariants in play**, **wiring risk**.

---

### V1 — App shell / nav / chrome  ·  P-001…P-073, P-508…P-522
**Design components:** app-shell (sidebar + `#sidebar-resizer` + main, `ds:477-551`); sidebar brand
lockup, `#env-context`, `#account-tools`, `#refresh-progress`, `#refresh-failed`, footer dot;
`updateSidebar(mode)` show/hide of the MID blocks (`ds:1549-1556`); `frosted` screen headers;
`#breadcrumb`; the **z-scale law** (DESIGN_SYSTEM §1.11) — Live Logs launcher **z-20 bottom-left**,
ban z-30, modals z-40, confirm z-55, toasts z-60, portals z-80.
**Legacy fn + API:** the static `index.html` shell + `showScreen` (`app.js:1181-1187`),
`updateSidebar` (`app.js:1189-1211`), `showDashboard/enterEnvironment/showGlobalMaster/
selectEnvMaster` (`app.js:1213-1251`), breadcrumb (`app.js:1668-1709`), `setupSidebarResize`
(`app.js:6307-6346`), sticky-offset sync (`app.js:6115-6130`), modal infra + Esc/focus-trap
(`app.js:6205-6244`), `ensureLicensed` boot gate + unreachable screen (`app.js:6510-6566`),
`bindStaticEvents` (`app.js:6348-6490`), keep-alive ping + Live Logs launcher creation
(`index.html:1509-1550`). No API beyond the boot `GET /api/system/status` gate.
**Invariants:** 4 (layering law — one documented z-scale; launcher never occludes alerts), 6
(cap-token boot + `ensureLicensed`/unreachable retry with NO reload loop), 8 (license gate).
**Wiring risk:** MEDIUM. The launcher must be **bottom-LEFT z-20** and toasts **bottom-RIGHT z-60**
(S68) so they never stack over each other. Keep the boot sequence order (cap injection → license
gate → splash → dashboard) so `capToken()`/`awaitCap` timing is unchanged.

---

### V2 — Dashboard: environment tiles  ·  P-074…P-085, P-016
**Design components:** `.env-tile` (rich frame, radial brand glow, hover lift `-4px`) + `__glow`
strip + `__actions` (edit/delete revealed on hover) + inner `.env-stat` FLAT cells (`ds:268-278`,
`ds:410-413`); dashboard header buttons as `.btn`; `.pill pill--proxy`/`pill--local`; `.empty`
empty state.
**Legacy fn + API:** `renderDashboard` (`app.js:1273-1285`), `envTile` (`app.js:1342-1381`),
`checkProxy` (`app.js:1288-1315`), `formatAgo` (`app.js:1265-1271`). APIs (reads only): env list
from `reloadAll` (`GET /api/environments`, `GET /api/accounts`), proxy test
`GET /api/environments/{id}/check-proxy` (P-082/P-083).
**Parity:** P-074…P-085 (header actions, tiles grid, proxy-test 3-state, hover edit/delete, ago
formatting), P-016, P-309 (6 skeleton tiles on load).
**Invariants:** 8 (brand: tiles are the canonical "rich frame"), 7 (skeletons on load).
**Wiring risk:** LOW-MEDIUM. **Rebuild** the `envTile` template markup (extra glow/actions/env-stat
elements) but keep the `data-env`/`data-env-edit`/`data-env-del`/`data-proxy-test` hooks and the
`#proxytest-{id}` output span exactly (that id is written by `checkProxy`).

---

### V3 — Sidebar tree: folders + account rows + multi-select  ·  P-026…P-066
**Design components:** `.account-row` (56px virtualization hint) + `.account-btn`
(`.is-active::before` 3px glowing left rail) + `.avatar` + status `.dot--online/offline/error` +
`.row-actions` (hidden→hover reveal); `.tree-line` folder indent; `.pill pill--ltd` for LTD;
`.chip`-styled filter/sort selects as `.field`; multi-select checkbox at low opacity (P-022).
**Legacy fn + API:** the sidebar tree renderer + `folderNode`/`accountRow` templates
(`app.js:1432-1550`), `setupDelegation` ONE delegated listener (`app.js:1553-1604`, PERF-01),
`patchSidebarBalances` (`app.js:1579-1595`), `syncSelectionView`/select-all/clear
(`app.js:1606-1656`), search/filter/sort (`app.js:1392-1468`), `toggleFolder` collapse-persist
(`app.js:1658-1662`). APIs: tree `GET /api/environments/{envId}/tree`; per-account balance rides
the inventory maps (§ balance below).
**Parity:** P-026…P-063 (chrome + folder nodes + account rows + delegation + patch-balances),
P-064…P-066 (multi-select → Selection-Master).
**Invariants:** 1 (**balance tri-state** on `.acct-balance` — real wallet incl. 0 → value;
refreshed+no wallet → `0,00`; never refreshed → `—`; P-054), 7 (event delegation + row
virtualization — one listener per container, no per-row rebind), 8 (brand).
**Wiring risk:** HIGH. This is the densest re-emit (500+ rows) and it carries the balance tri-state.
Keep `patchSidebarBalances` updating **only** the `.acct-balance` chips (no rebuild, scroll
preserved). Do not regress the tri-state to "falsy → unknown" (the INV-E5 bug, recurred 3×).
Keep the single delegated listener — do not rebind per row while re-skinning.

---

### V4 — Account detail view + item table + inventory grid  ·  P-186…P-203, P-272…P-306
**Design components:** account header (displayName + `.pill pill--proxy/--local` + `.pill --full/
--ltd`) + per-view action buttons as `.btn`; `#gc-cat-tabs` as `.chip` category pills
(Owned/Locked/Listed + Active-Orders jump); `.items-wrap` + `.items-table` (sticky glass thead,
`.rar` rarity bar, `.rn-*` name colors, `.item-icon` shadow, lock badge, StatTrak, value cell);
`.stat-card` KPI bar; `#facet-bar` `.chip` facets; `.empty` states; `#inv-loading` spinner.
**Legacy fn + API:** `renderAccountView` (`app.js:2079-2196`), `renderAccountTabs`
(`app.js:2154-2159`), the item-table pipeline — category tabs (`app.js:2923-2949`), **windowed
render** (`app.js:2952-2995`), per-row renderer (`app.js:2997-3041`), facets
(`app.js:3043-3107`), sort/select (`app.js:3109-3361`), `renderTradeLink`/`bindTradeLink`
(`app.js:2096-2124`, P-267…P-271). APIs: cache reads `GET /api/inventory`/`inventory-tf2`; **live
refresh** `GET /api/inventory/{u}?refresh=1` (P-311, 💰-adjacent but read-only fetch — safe),
trade-url `GET /api/accounts/{u}/trade-url`.
**Parity:** P-186…P-203 (account view), P-272…P-306 (table/tabs/facets/sort/selection/select-under-
value), P-119 (`invFor` lowercase-normalize).
**Invariants:** 1 (stat wallet tri-state; worth = `inv.totalValueUsd` single source), 2 (**one
refresh button** — the full pipeline; the quick ctx2 buy-verify stays where legacy puts it; no
second refresh affordance), 7 (**windowing** — only visible rows + buffer between spacer `<tr>`s;
selection stays data-driven, windowed-safe select-all).
**Wiring risk:** HIGH. The 10k-row windowing math (`mountWindowed`, spacer rows, scroll recompute,
auto-measured row height) is **preserved verbatim** — re-skin only the row's inner class strings /
rarity bar, never the windowing arithmetic. Selection keys differ by mode (assetId vs
marketHashName, P-297) — do not touch that logic. `Select under value` (P-102/P-306) and the
selection bar (P-103/P-305) are 💰-gated affordances (they feed sell/send) — style them but the
Sell/Send buttons only OPEN modals, they don't fire money (safe to render).

---

### V5 — Aggregated fleet views: Env-Master, Global-Master, Folder-Master, Selection-Master  ·  P-169…P-185, P-256…P-266
**Design components:** master header (icon + name + `.pill` portfolio/folder/multi-select) + action
`.btn`s (Mass Buy teal, Check Bans, Refresh, Move, Delete rose); `.stat-card` bar relabeled
(Items→"Sendable items", Trade-Locked→"Bots"); `#global-filter` env-aggregate `.chip` toggles;
master `.items-table` (Accounts column replaces Exterior/Status); `.empty`.
**Legacy fn + API:** `aggregateWithOwners` (`app.js:1919-1947`), `openFolderMaster`
(`app.js:1949-2007`), `renderSelectionMaster` (`app.js:2013-2075`), env/global master renderers +
global env-filter (`app.js:2746-2856`), `worthCentsForAccounts` single worth source
(`app.js:681-689`). APIs: same inventory-map reads; `showGlobalMaster` auto-selects all envs into
`state.globalEnvs` (P-072).
**Parity:** P-169…P-185 (folder + selection master), P-256…P-266 (aggregate internals, env/global
master, env-filter, placeholder).
**Invariants:** 1 (aggregate wallet = Σ `walletToUsd`, tri-state preserved), 7 (same windowed table
at fleet scale), 8 (brand).
**Wiring risk:** MEDIUM. Aggregation is O(1)-indexed and 1:1 with single views — re-skin the header
+ stat labels + table columns, keep `aggItemByName` fan-out and the `sendable` portion math
(P-298) untouched. Mass Buy / Delete Selected buttons OPEN modals / go through `ssimConfirm` — no
money fires on render.

---

### V6 — Inventory header: stat bar, game toggle, price-source, currency, refresh  ·  P-086…P-118, P-138…P-145
**Design components:** 4 `.stat-card`s with per-card `--stat-accent` `::before` (brand/warn/brand-
light/emerald); `.seg` game toggle (CS2/TF2), `.seg` price-source split (Steam/CSFloat, logo swap),
`.seg` currency split (USD/EUR); `.btn-buy` Buy; `#btn-load` Refresh `.btn`; floating "Fetching
prices…" badge `#price-fill-indicator` (fixed bottom-4 right-4 **z-40**).
**Legacy fn + API:** `setGame`/`currentAppId`/`countTf2Keys` (`app.js:515-535`),
`loadTf2Inventories` + TF2 error panel (`app.js:537-557`), `reloadAll` (`app.js:566-583`),
`rememberWallet`/`wasRefreshed` (`app.js:585-609`), the `fmt*` money family (`app.js:638-759`,
`1122-1160`), `setCurrency`/`setPriceSource`/`updatePriceSourceButton`/FX-provenance tooltip
(`app.js:761-808`), `formatFillEta`/`priceFillIndicator`/`watchPriceFill` (`app.js:850-943`).
APIs: `GET /api/exchange-rate`, `GET /api/pricing/source`, `PUT /api/pricing/source`,
`GET /api/pricing/status` (watch), `GET /api/inventory-tf2` (lazy).
**Parity:** P-086…P-118 (header + stat bar + game toggle + ingestion), P-120…P-145 (money
formatting + price source + fill-watch).
**Invariants:** 1 (`setMoneyStats(cents,walletUsd)` — null→`—`; tri-state), 5 (**pricing honesty**:
fill badge shows `N left · N done · ~eta`; a stalled/dead fill hides distinctly from "no price"),
8 (brand tokens; `.seg` children EXEMPT from `bg-brand` auto-upgrade — `ds:224`).
**Wiring risk:** MEDIUM. `watchPriceFill` cadence (2500 ms, coalesced ≥10 s re-pull, drain-stop,
15-min no-progress stop, 24-consec-error dead-stop) is **load-bearing against a busy backend** —
preserve verbatim (API_CONTRACT §3). Price-source `PUT` is 💰-adjacent (re-prices the fleet) but
is a config write, not a trade — safe to wire, do not auto-trigger in verification.

---

### V7 — Value-history chart  ·  P-161…P-168
**Design components:** `#history-wrap` rich frame + SVG using the `.hist-*` stroke/fill classes
(SVG can't read `var()`); dual polyline (items brand + wallet emerald), area fill, last-point dots,
dashed "(incomplete)" wallet line, legend.
**Legacy fn + API:** `loadHistory` (10 s TTL cache, race guard, `app.js:1780-1821`),
`invalidateHistory` (`app.js:1823-1824`), the dependency-free SVG renderer (`app.js:1826-1907`).
APIs: `GET /api/history/{seriesId}?game=`; global mode `POST /api/history/aggregate`.
**Parity:** P-161…P-168 (cache/aggregate, dual-line, partial-wallet, axes, labels, legend).
**Invariants:** 5 (partial-wallet honesty — dashed line + "(incomplete)" note, not a fake full
curve), 8 (brand line colors from the `.hist-*` classes).
**Wiring risk:** LOW. Re-skin = swap the SVG presentation-attr class names to `.hist-*`; keep the
point math, axis scaling, and the <2-points message (P-164).

---

### V8 — Active-Orders view (live sell listings + buy orders)  ·  P-204…P-224
**Design components:** two side-by-side `.surface` sections (Buy success-green / Sell listed-blue),
per-order row (icon via `safeIconUrl`, mono id, `.pill`-priced, `.btn-danger` Cancel, `.chip`
checkbox), search field, "Cancel selected (N)"/"Cancel all"/"Refresh" `.btn`s, amber partial banner.
**Legacy fn + API:** `renderOrdersView` (`app.js:2205-2308`), `bindOrdersControls` +
single/bulk-cancel (`app.js:2311-2414`). APIs: `GET /api/market/orders/{u}?appId=` (read);
cancel `POST /api/market/cancel-listing`, `POST /api/market/cancel-buy-order` (💰).
**Parity:** P-204…P-224.
**Invariants:** 3 (`ssimConfirm` on every cancel — single + bulk; zero native confirm), 4 (bulk
confirm modal z-40 above the view), 7 (search filter + sequential bulk cancel anti-rate-limit).
**Wiring risk:** MEDIUM-HIGH (💰). Cancels are real market ops. Re-skin the rows/buttons; keep the
`ssimConfirm` gate (P-220/P-223), the SEQUENTIAL bulk execution (P-221, anti-rate-limit), and the
per-row spinner/restore-on-fail. **Never fire a cancel during verification.**

---

### V9 — Global Trade-Offers manager  ·  P-225…P-255
**Design components:** `offers-overlay` two-column (Sent rose / Received emerald), per-side
select-all + batch `.btn`s, per-offer row (state `.pill` badge ×11 states, colored headline value,
item thumbs + `+N` overflow, partner Steam link, Accept/Decline/Cancel `.btn`s).
**Legacy fn + API:** `openTradeOffers` (`app.js:2424-2433`), the two-sided renderer + badges +
values + batch (`app.js:2447-2743`). APIs: `POST /api/trade/offers {usernames}` (read/aggregate),
`POST /api/trade/offer-action` (💰), `POST /api/trade/offers-batch` (💰, backend caps concurrency 2).
**Parity:** P-225…P-255.
**Invariants:** 3 (`ssimConfirm` on every accept/decline/cancel, single + batch), 1 (💰 values via
`fmtCents`), 4 (overlay z-40).
**Wiring risk:** HIGH (💰). Accepting an offer moves real items. Keep the confirm tones
(accept→spend, else danger, P-240), the **"unconfirmed → awaiting mobile confirmation" honesty**
(P-241/P-245 — never claim confirmed when 2FA pending), and the batch concurrency cap. Never fire
in verification.

---

### V10 — Market-Buy modal + toolbar utilities  ·  P-461…P-476
**Design components:** `buy-overlay` glass card — bot datalist + wallet line, Game `.field`, Qty +
Max `.btn`, live item search dropdown, Price + Market-price fetch `.btn`, ×qty total, buy-order
note, result box, `.btn-buy` submit.
**Legacy fn + API:** `openBuyModal`/`renderBuyWallet`/`updateBuyWallet`/`refreshBuyWallet`/
`recomputeBuyTotal`/`fillMaxBuyQty`/`fetchBuyPrice`/`searchBuyItems`/`submitBuy`
(`app.js:5642-5872`). APIs: `GET /api/accounts/{u}/wallet` (tri-state), `GET /api/market/buy-price`,
`GET /api/market/search`, `POST /api/market/buy` (💰).
**Parity:** P-461…P-476.
**Invariants:** 1 (**wallet tri-state + never default currency to EUR** — `buyCurrencyCode` P-465;
"Balance unknown → buying disabled"), 3 (money POST after validation; result honesty), 6 (mutating
buy needs cap token via `awaitCap`).
**Wiring risk:** HIGH (💰). `submitBuy` does a **pre-buy live funds check** (`refreshBuyWallet`,
aborts if insufficient) and money-safety on failure ("may have reached Steam — verify before
retrying" + refresh buyer, P-475). Preserve all of it. Never submit in verification.

---

### V11 — Folder Mass-Buy modal  ·  P-477…P-483
**Design components:** `fbuy-overlay` — game, price/item, item search, live-balance note, progress
bar, results list; `.btn-buy` submit; End-task `.btn-danger`.
**Legacy fn + API:** `openFolderBuy`/`searchFbuyItems`/`fetchFbuyPrice`/`submitFolderBuy`/
`pollFolderBuy`/`renderFolderBuyResults` (`app.js:5878-6025`). APIs: `GET /api/market/buy-price`,
`GET /api/market/search`, `POST /api/market/folder-buy` (💰), `GET /api/market/folder-buy-status`
(poll 1200/900 ms), `POST /api/market/folder-buy-cancel` (End-task).
**Parity:** P-477…P-483.
**Invariants:** 3 (`ssimConfirm` tone spend — "Mass Buy — real money … Irreversible", P-480), 5
(poll ETA/phase honesty), 7 (bounded error-retry + stall guard on the poller).
**Wiring risk:** HIGH (💰). Buys across the whole folder/selection. Keep the spend-confirm, the
two-phase (refresh→place) poll (P-481), and the post-op cache re-pull (P-483). Never submit.

---

### V12 — Market-Sell modal (mass-sell)  ·  P-441…P-451
**Design components:** `sell-overlay` — strategy radios (lowest/undercut/custom), gross/fee/net
preview table, EUR note, 2FA-irreversible warning, `.btn-sell` submit, End-task, progress bar.
**Legacy fn + API:** `selectedSellItems`/`sellStrategy`/`customSellCents`/`previewSell`/
`retryOnePrice`/`renderSellPreview`/`submitSell`/`pollSell` (`app.js:5211-5468`). APIs:
`POST /api/market/preview`, `POST /api/market/sell` (💰), `GET /api/market/sell-status`
(poll 1000 ms), `POST /api/market/sell-cancel`.
**Parity:** P-441…P-451.
**Invariants:** 3 (preview before submit; irreversible-sell warning), 5 (sell poll phase labels +
`recovered/retried/gone/deferred` honesty), 7 (poll stall guard).
**Wiring risk:** HIGH (💰). Real listings + 2FA confirmation. Keep `fmtEurCents` (EUR, no FX),
preview-then-submit, and the post-done seller refresh. Never submit.

---

### V13 — Send-Trade modal (single + folder mass-send)  ·  P-426…P-440
**Design components:** `trade-overlay` — internal-vs-external radio, env→folder→recipient picker
(`.field`s + selectable recipient rows w/ brand-ring), 2FA auto-confirm note, submit `.btn`;
`#mass-progress` bottom-center panel; shared End-task infra.
**Legacy fn + API:** `openTradeModal`/`updateTradeTargetVisibility`/`populateTradeFolders`/
`buildRecipientList`/`readTradeTarget`/`submitTrade`/`submitMassTrade`/`showMassProgress`/
`pollMass`/`surfaceTradeFailures`/`endTask` (`app.js:4939-5205`, `5124-5146`). APIs:
`POST /api/trade/send` (💰), `POST /api/trade/mass-send` (💰), `GET /api/trade/mass-status`
(poll 1000 ms), `POST /api/trade/mass-cancel`, tree for the picker.
**Parity:** P-426…P-440 (send single + mass + end-task).
**Invariants:** 3 (End-task mandatory `ssimConfirm`, P-438), 5 (**unconfirmed-send honesty** —
"SENT but NOT 2FA-confirmed — confirm manually, do NOT resend", P-432; `verifyBeforeRetry`
handling P-433), 7 (mass poll stall guard; 9 s deferred re-refresh INV-E1).
**Wiring risk:** HIGH (💰). Moves real items across bots. Keep the unconfirmed/verify-before-retry
copy exactly and the deferred re-refresh. Never submit.

---

### V14 — Ban-Checker modal  ·  P-416…P-425 (z-30)
**Design components:** `ban-overlay` **z-30** (below Move z-40) — summary `.pill`/`.chip` chips per
category, collapsible `<details>` accordions, per-account tags, "Move this category" `.btn` (opens
Move modal at z-40 above).
**Legacy fn + API:** `openBanChecker`/`pollBanCheck`/`renderBanResult`/`banAccordion`/`banTags`/
`onBanBodyClick`/`checkAccountBans`/`checkFolderBans` (`app.js:4757-4936`). APIs:
`POST /api/bans/check {usernames}` (202; 409 already-running), `GET /api/bans/status` (poll 1500 ms).
**Parity:** P-416…P-425.
**Invariants:** 4 (**z-30 layering** — ban modal below the Move modal it launches; documented
z-scale), 7 (bounded poll error-retry + stall guard), 5 (live phase label honesty).
**Wiring risk:** MEDIUM. Read-only (no money) but the z-30/z-40 stacking with Move is a specific
layering contract — preserve it. 409 → "already running" toast.

---

### V15 — Casket / Storage-Units + Trade-Ups feature modals  ·  P-484…P-500
**Design components:** lazily-built feature overlays via `ensureFeatureOverlay` — Casket two-panel
deposit/withdraw (capacity bars, storable gate greying), Trade-Ups 10-input grid + outcome pool;
`.btn` toolbars, progress lines, Cancel `.btn`.
**Legacy fn + API:** `ensureFeatureOverlay` (`app.js:6576-6597`); Casket
`openCasketModal`/`loadCasketContents`/`renderCasketPanels`/`casketMove`/`casketPollMove`
(`app.js:6755-6949`); Trade-Ups
`openTradeUpModal`/`tuScan`/`renderTuList`/`tuStart`/`tuPollExec` (`app.js:6605-6747`). APIs:
`GET /api/casket/{u}/list`, `GET /api/casket/{u}/contents`, `POST /api/casket/move` (💰),
`GET /api/casket/move-status` (poll 1000/2000 ms); `POST /api/tradeup/candidates`,
`POST /api/tradeup/execute` (💰), `GET /api/tradeup/execute-status` (poll 1200 ms).
**Parity:** P-484…P-500.
**Invariants:** 3 (`ssimConfirm` — trade-up "destroys 10 real items, IRREVERSIBLE, GC not
live-verified, start with 1", P-489; casket deposit/withdraw confirm), 5 (**lost-status honesty** —
a lost money-job poll renders "status LOST, verify in-game", NEVER a fabricated done, P-490/P-500),
9 (**capability ceiling** — trade-up/casket GC execution is gated exactly as legacy; add NOTHING
that was cut; the "GC not live-verified" honesty is part of the ceiling), P-514 (teardown hooks
stop the pollers on modal close).
**Wiring risk:** HIGH (💰 + irreversible). Preserve the terminal-lost-status line verbatim and the
per-modal poller teardown. Never execute.

---

### V16 — CSFloat workspace modal  ·  P-350…P-384
**Design components:** `csfloat-overlay` tabbed (`.chip` tabs Dashboard/Listings/Market/Buy Orders/
Trades/Inventory/Settings) — stat cards, listing rows, market grid cards, buy-order/trade rows,
API-key settings form; experimental tabs gated.
**Legacy fn + API:** the whole `csfApi`-based workspace (`app.js:3992-4529`) — `openCsFloat`, tab
router, all list/create/delist/reprice/buy/order/auto-accept handlers. APIs: `csfApi` →
`/api/csfloat/{u}/*` (config/key/me/listings/search/buy-orders/buy/trades/auto-accept/inventory);
listing create/reprice/delist (💰), buy (💰), buy-order place/cancel (💰), list-asset (💰).
**Parity:** P-350…P-384.
**Invariants:** 3 (`ssimConfirm` on every buy/list/delist/order — spend/danger tones), 9 (capability
ceiling — CSFloat is a legacy feature, ported as-is, nothing added), 1 (`csfUsd` money format).
**Wiring risk:** HIGH (💰) but well-isolated behind `csfApi`. Re-skin tabs→`.chip`, rows, cards;
keep the defensive field extraction (undocumented shapes, API_CONTRACT §1 CSFloat note), the
experimental-tab gate (P-353), and every confirm. Never fire a buy/list.

---

### V17 — Account modals: Add, Edit, Login (QR/creds), Attach-maFile, SDA, Move, Env, Folder, Clean-Browser  ·  P-326…P-415
**Design components:** the glass modal frames (auto-converted by the `id$="-overlay"` adapter) —
`.field`s, `.seg` login tabs (QR/Credentials) + QR stepper pills, `.details` credential collapse,
danger-zone `.btn-danger`, SDA OTP display + countdown bar + confirmations list, recipient/folder
selects.
**Legacy fn + API:** Add `openAddAccount`/`submitAddAccount` (`app.js:3776-3804`); Edit
`openEditAccount`/`saveEditAccount`/delete (`app.js:3656-3769`); Login modal + QR/creds/guard/poll
(`app.js:3809-3960`); Attach `openAttachMaFile`/submit (`app.js:3963-3983`); SDA
`openSda`/OTP-roll/confirmations/respond (`app.js:4034-4159`); Move
`openMoveModal`/`populateMoveFolders`/`submitMove`/`batchDeleteAccounts` (`app.js:4664-4733`); Env
`openEnvModal`/`submitEnv`/`deleteEnvironment` (`app.js:4532-4607`); Folder
`openFolderModal`/`submitFolder`/`deleteFolder`/`reorderFolder` (`app.js:4610-4661`); Clean-browser
`openCleanBrowser` (`app.js:4161-4177`). APIs: full accounts/environments/folders/login/otp/
confirmations/move/attach surface (API_CONTRACT §Accounts, §Login, §Env/folders).
**Parity:** P-326…P-347 (edit/add/login), P-348…P-349 (attach), P-385…P-401 (SDA), P-402
(clean-browser), P-403…P-415 (env/folder/move + batch delete).
**Invariants:** 3 (delete-account / delete-env / delete-folder / batch-delete all `ssimConfirm`
danger; SDA confirmation approvals are 💰 → confirmed honesty), 6 (all these are mutating → cap
token via `awaitCap`; login/import survive without a stale token), 9 (**Login imports as "Limited"
tier only** — the token-only ceiling; no native sign-in was added, and Attach-maFile is the ONLY
Limited→Full path; P-347).
**Wiring risk:** MEDIUM. Mostly config writes (safe) plus SDA confirmation approvals (💰 — approving
a market/trade confirmation moves money, P-401). Keep the QR poll cadence (1500 ms), the OTP
self-reschedule (`msRemaining+300`), and the Limited-tier explainer. Never approve a confirmation
in verification.

---

### V18 — Bulk-Import modal  ·  P-452…P-460
**Design components:** `bulk-overlay` `.import-method` grid (Vault/CSV/maFiles), file pickers,
source master-pw field, env/folder dest selects, per-file checkbox rows + password badges,
`Import (N)` submit.
**Legacy fn + API:** `openBulkImport`/`selectImportMethod`/`onBulkVaultImport`/`loadBulkList`/
`onBulkSelectAll`/`submitBulk`/`onBulkCsv` (`app.js:5471-5621`). APIs: `POST /api/import/vault`,
`POST /api/import/csv`, `GET /api/mafiles/unlinked`, `POST /api/mafiles/import`.
**Parity:** P-452…P-460.
**Invariants:** 6 (mutating imports need the cap token), 9 (import is the sanctioned bulk path;
nothing added).
**Wiring risk:** LOW-MEDIUM. Not money-affecting. Keep skip-reason surfacing (first 5) and the
select-all-only-password-bearing rule (P-457).

---

### V19 — Settings surfaces (price-source / currency menus, CSFloat experimental, sidebar resize)  ·  P-518, P-137, P-383, P-516
**Design components:** the split-menu popovers (`#src-menu`/`#cur-menu`) as glass popovers,
mutually-exclusive open + click-away close; CSFloat Settings tab (already in V16); sidebar resizer
grip.
**Legacy fn + API:** split-menu wiring in `bindStaticEvents` (`app.js:6473-6490`), `setCurrency`
(`app.js:761-766`), `setupSidebarResize` (`app.js:6307-6346`), `csfToggleExperimental`
(`app.js:4480-4483`). APIs: `PUT /api/pricing/source`, `PUT /api/csfloat/config`.
**Parity:** P-137, P-383, P-516, P-518, P-527.
**Invariants:** 8 (persisted prefs — `ssim.currency`/`ssim.priceSource`/`ssim.sidebarWidth`),
5 (currency FX-provenance tooltip — fallback/stale warnings, P-097/P-527).
**Wiring risk:** LOW. Config-only. Keep localStorage persistence + the FX-provenance tooltip copy.

---

### V20 — Live Logs window (`logs.html`)  ·  P-025/P-505, API_CONTRACT §4
**Design components:** re-skin `logs.html` — `livelogs-overlay`-style level chips (All/Warn/Error),
search field, pause/follow toggle, color-coded `[account]`-tagged lines, buffer footer; opened by
the z-20 launcher.
**Legacy fn + API:** the standalone `logs.html` inline script — `EventSource('/api/logs/stream')`,
`addLine`, level filter/search/follow, 3000-row cap, native reconnect (`logs.html:76-140`).
Dashboard side: launcher `window.open('/logs.html')` + `POST /api/app/open-logs`
(`index.html:1539-1546`).
**Parity:** P-025, P-505, P-507 (per-account activity-log modal is separate — in V17-adjacent
`openAccountLogs`).
**Invariants:** 4 (launcher z-20 bottom-left; the stream window is its own popup), 6 (stream is
capability-exempt — no `X-SSIM-Cap`), 10 (`/api/logs/stream` must work while capless).
**Wiring risk:** LOW. Separate file. Re-skin markup; keep the single `EventSource`, the JSON
`{t,level,msg}` parse, unknown-level→info coercion, native `retry:3000` reconnect, and the DOM cap.

---

### V21 — Unlock portal (`unlock.html`)  ·  API_CONTRACT §2, invariant 8
**Design components:** `.portal` / `.portal-card` — logo halo, master-password field, firstrun
(confirm + no-recovery warning) vs returning vs wrong vs busy states, `.portal-msg` err/ok/info.
**Legacy fn + API:** the inline unlock script — `GET /api/vault/state` (firstRun=`!exists`),
`POST /api/vault/unlock {password,confirm,createEmptyAnyway?}` (409 `{orphaned:true}` → orphan
mode), readiness poll `GET /api/system/status` (500 ms) → `location.replace('/')` when
`vaultLocked!==true`, keep-alive ping. Preserved **verbatim** (§2.2).
**Invariants:** 8 (portal readiness gate + vault discriminator), 6 (no cap token pre-dashboard),
9 (master-password AES-GCM path is legacy — unchanged).
**Wiring risk:** LOW-MEDIUM. Re-skin markup only; the redirect + orphan-mode logic is exact.
DROP the prototype's `.portal-proto-states` switcher — real state comes from the backend.

---

### V22 — License portal (`license.html`)  ·  API_CONTRACT §2, invariant 8
**Design components:** `.portal` / `.portal-card` — HWID display, license-key field, idle/checking/
activated/seat/hwid/invalid states.
**Legacy fn + API:** the inline license script — `GET /api/license/state` (shows `hwid`),
`POST /api/license/activate {key}` (`ok`,`tier`,`error`), readiness poll `GET /api/system/status`
(700 ms) → `location.replace('/')` when `licensed===true`. Preserved **verbatim** (§2.2).
**Invariants:** 8 (readiness gate + license discriminator `licensed===true`), 6 (no cap token
pre-dashboard).
**Wiring risk:** LOW. Re-skin markup; redirect logic exact; DROP the proto state switcher.

---

### V23 — Splash portal (`splash.html`) + startup splash  ·  P-008, P-522
**Design components:** `.portal` boot/updater card (states start/update/done) — purple bloom +
Santer diamond stroke-draw; the in-dashboard one-shot `playStartupSplash` (`#ssim-splash`,
sessionStorage-gated, skipped under reduced-motion, z-70/portal-tier).
**Legacy fn + API:** `splash.html` markup + `playStartupSplash` (`app.js:6951-6966`;
`index.html:338-357`). No API (updater state arrives via `system/status.update` in V1/V6).
**Invariants:** 8 (brand — Santer diamond, #9333ea bloom), 4 (portal-tier layering, above
dashboard, below nothing it must sit under).
**Wiring risk:** LOW. Pure presentation; keep the sessionStorage gate + reduced-motion skip.

**Total distinct views/surfaces in the build order: 23.**

---

## 4. INVARIANT PLAN — the 9 sacred invariants (`00_PROGRESS §SACRED INVARIANTS`)

One line each on how the port preserves it:

1. **Balance tri-state** — Carry `inv.wallet` + `inv.fetchedAt` through unchanged; keep the
   newest-wins `state.wallets` store (`rememberWallet`/`wasRefreshed` `app.js:585-609`) and the
   three distinct display states in `.acct-balance` (V3), the stat cards (`setMoneyStats`, V6), and
   the buy wallet (V10); re-skin the chip, never re-decide from truthiness. (API_CONTRACT §6.)
2. **One refresh button** — Keep the single `#btn-load` full-pipeline Refresh (V4/V6,
   `app.js:2142`); the quick ctx2 buy-verify stays exactly where legacy invokes it (post-buy
   refresh). Add no second refresh affordance while re-skinning.
3. **`ssimConfirm` on every money action** — Reuse `ssimConfirm` (`app.js:6251-6305`) verbatim on
   all 💰 paths (orders cancel V8, offers V9, buy V10, mass-buy V11, sell V12, send/end-task V13,
   trade-up/casket V15, CSFloat V16, delete/SDA V17); zero native `confirm()`/`alert()`. The
   confirm overlay skins via the glass adapter.
4. **Layering law (S68)** — Adopt the one documented z-scale (DESIGN_SYSTEM §1.11): launcher z-20
   **bottom-left**, ban z-30, modals z-40, confirm z-55, toasts z-60 **bottom-right**, portals
   z-80. Wired in V1; enforced per-modal (V14 ban z-30 under Move z-40). Ambient elements never
   occlude alerts/modals.
5. **Pricing honesty (S2/S13)** — Keep the "Fetching prices…" badge with `N left · N done · ~eta`
   (V6, `app.js:850-892`) and `watchPriceFill`'s drain/stall/dead-stop; a failed/stale fetch
   renders distinctly from "no price" (value cell: `undefined`→`…`, `null`→`—`, P-289); job-lost
   pollers show terminal "verify", never fake done (V13/V15).
6. **Reload survival (S1)** — Copy `capToken()`/`awaitCap()`/`api()` byte-for-byte (§2.1); keep the
   `sessionStorage['ssim_cap']` stash + `X-SSIM-Cap` header + `capabilityRequired` banner; never
   `localStorage`; portals stay capability-exempt (§2.2). After any hard reload, all writes still
   work.
7. **Fleet scale** — Preserve `mountWindowed`/windowed table render (V4/V5, `app.js:2952-2995`),
   the single delegated listener per container (`setupDelegation` `app.js:1553`, PERF-01), and
   `patchSidebarBalances` in-place chip updates (V3). Re-skin row markup only; never rebind
   per-row or drop windowing.
8. **Brand** — English-only, "Santer", accent #9333ea; the masterpiece tokens/DS classes are the
   single palette source (DS-01, `assets/ssim-ui.css`). No hardcoded hex outside the token list
   except CS2 rarity item-data colors (`.rar-*`/`.rn-*`).
9. **Capability ceiling = legacy exactly** — No native sign-in (Login imports "Limited" only, V17,
   P-347); no GC features beyond what legacy ships (trade-up/casket carry the "GC not live-verified"
   honesty, V15); nothing added that was cut. The port re-emits the same feature set — it adds no
   new capability.

---

## 5. MONEY-PATH CAUTION (💰) — verification must NEVER trigger these live

PARITY tags **125 rows 💰**. Verification (Phase 4) runs the app against the live backend but
performs **NO money actions** — those go to a separate `LIVE_TEST_CHECKLIST.md` the owner runs
deliberately. The 💰 flows to render/wire but never fire in verification, grouped by view:

| View | 💰 flow (endpoint) | Parity | Verify rule |
|---|---|---|---|
| V4 | `Select under value` / selection-bar Sell/Send **open** modals only | P-102, P-103, P-305, P-306 | Open + inspect; do not submit the opened modal |
| V6 | `PUT /api/pricing/source` (re-prices fleet) | P-138 | Read `/pricing/source`; do NOT switch source live |
| V8 | cancel-listing / cancel-buy-order | P-210…P-223 | Render orders; never click a Cancel |
| V9 | offer-action / offers-batch (accept/decline/cancel) | P-236, P-240…P-246 | Render offers; never act on one |
| V10 | `POST /api/market/buy` (+ pre-buy funds check) | P-472…P-476 | Open modal, inspect wallet tri-state; never submit |
| V11 | `POST /api/market/folder-buy` | P-480…P-483 | Open modal; never confirm the spend |
| V12 | `POST /api/market/sell` (+ preview) | P-446…P-451 | Preview is read-only-priced; never submit the sale |
| V13 | trade/send + trade/mass-send | P-432…P-437 | Build recipient list; never submit |
| V15 | tradeup/execute, casket/move | P-489, P-499 | Scan/list is safe; never execute/move |
| V16 | CSFloat buy / listing create / reprice / delist / buy-order / list-asset / auto-accept | P-361…P-383 | Render tabs; never fire a marketplace action |
| V17 | SDA confirmations/respond (approves trade/market 2FA) | P-397…P-401 | Render OTP + confirmations; never approve |

**Rules:** (a) preview/price/search/wallet/status GETs and POST-preview are read-safe and may run;
(b) any POST/PUT/DELETE that places/cancels/moves/approves/repricesreal assets or funds is
**forbidden in verification**; (c) every 💰 submit stays behind its `ssimConfirm` gate (invariant 3)
so an accidental click is still caught; (d) money-safety copy (`verifyBeforeRetry`, unconfirmed-2FA
honesty, terminal lost-status) is preserved verbatim so a real failure never reads as success.

---

## 6. BUILD SEQUENCING NOTES

- **Phase 2 first (primitives), then Phase 3 (views).** Ship `assets/ssim-ui.css` (tokens + ~60 DS
  classes + the auto-upgrade adapters) and the Tailwind theme extension before any view, so V1+
  re-skins on contact. Primitives to land first: buttons, fields, `.surface`/`.stat-card`,
  `.card-rich`/`.env-tile`, modal frame + glass adapter, `.pill`/`.chip`, `.dot`/`.avatar`,
  `.empty`, `.items-table`, `.seg`, `.app-sidebar` parts, `.portal`, the Live Logs launcher, toast
  container — plus confirm + skeleton styling.
- **Commit per view/milestone** (`00_PROGRESS §RESUME`); tick PARITY status (`✅/🔨/⛔`) per row as
  each view lands.
- **Cutover last.** Build in `redesign/`; only copy the new frontend into the live `public/` at the
  very end after verification (`ROLLBACK.md`); `legacy_public/` stays the untouched rollback.
- **Version bump is a Compile-step action, not a dev change** — `1.3.5 → 1.4.0` in `package.json:3`
  + `src-tauri/tauri.conf.json:4` at compile time only; the footer reads it from the API, never
  hardcoded (`00_PROGRESS §RELEASE VERSION`).
- **Do not touch** `src/`, `src-tauri/` (beyond the version line at compile), or `build/`. The API
  surface in `API_CONTRACT.md` is the immovable contract.

---

*End of PORT_PLAN — 23 build surfaces, riskiest-data-first, mapping the frozen legacy function to
the masterpiece design under the 9 sacred invariants and the 💰 no-fire rule.*
