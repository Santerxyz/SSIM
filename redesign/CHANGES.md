# CHANGES — deliberate flow / IA / decision log for the redesign

Only **deliberate** deviations from a pure form-for-form re-skin are logged here. A change
that merely restyles existing markup (class swaps, DS tokens) is NOT logged. Backend is FROZEN;
nothing here changes an API call, handler, state write, or nav mechanic.

---

## V1 — App shell / chrome re-skin (`new_public/index.html`)  ·  2026-07-06

**Net IA/flow change: NONE.** Same 2 physical screens (`#screen-dashboard`, `#screen-inventory`),
same sidebar blocks, same view-switching, same handlers. Every one of the 292 legacy static
container ids + all `data-*` hooks preserved (verified by grep diff against `legacy_public`).
The masterpiece design was applied to the CHROME only; view inner-markup still renders through the
unchanged legacy `app.js` and stays legacy-styled until Phase 3 (expected).

Deliberate DECISIONS (not IA changes) made during the port, for reviewer awareness:

1. **DS layer ported INLINE into `index.html <head>`, ABOVE the linked `assets/ssim-ui.css`.**
   The masterpiece token `:root` set (69 custom props) + the shell component classes
   (`.btn*`, `.field`, `.surface`, `.stat-card`, `.card-rich`, `.env-tile*`, `.env-stat`, `.seg`,
   `.account-row/.account-btn`, `.avatar`, `.dot`, `.pill--*`, `.items-table`, `.rar-*`/`.rn-*`,
   type helpers `.t10–.t28`) were ported from `design_source.html:68-438` into the existing inline
   `<style>`. The legacy `assets/ssim-ui.css` link is KEPT (per task); the inline block loads after
   it, so the fuller/softer masterpiece definitions win on overlap while the foundation still styles
   legacy view markup until Phase 3. The Tailwind theme extension was upgraded in place (radii
   8/10/12/16/16, dual `glow`/`glow-sm`, `mono` family, `13`/`28` sizes, `balance` color); the
   legacy `2xs/3xs/4xs` sizes were RETAINED (legacy view markup still references them).

2. **CDN → vendored.** The prototype's CDN Tailwind Play / Font Awesome / Google-Fonts
   (`design_source.html:23,64-66`) were NOT introduced; the vendored local tags already present in
   `new_public` (`assets/vendor/tailwind.js`, `assets/vendor/fontawesome/css/all.min.css`,
   `assets/vendor/fonts.css`) are kept. No external URL remains (offline-always preserved).

3. **Prototype meta-chrome dropped** (DESIGN_SYSTEM §6): `.proto-bar`, portal `.pstate` switchers,
   the `designsys` style-guide screen, all mock generators/`S.bal`/`simulateRefresh`/`fillFailed`,
   hash deep-linking, and hardcoded `FX()` were NOT ported. The prototype's `[data-screen].is-on`
   reveal + `.app-shell{inset:44px…}` proto-bar offset were dropped — the shell keeps the legacy
   `#screen-dashboard`/`#screen-inventory` + Tailwind `hidden` toggle that `app.js showScreen`
   drives, and fills the window.

4. **Interactive sub-structures kept VERBATIM where `app.js` owns their DOM/classes** (re-skin
   would have broken function):
   - **Game toggle** (`#game-toggle` + `#btn-game-cs2`/`#btn-game-tf2`): `app.js updateGameToggle()`
     OVERWRITES each button's entire `.className` with `bg-brand text-white` / `bg-slate-800
     text-slate-400 hover:bg-slate-700` strings. Kept the legacy two-button structure (NOT the
     masterpiece `.seg`/`.is-on` control) so the active-state toggle keeps working; only the
     wrapper radius was softened. (`bg-brand` remaps to the new palette via the theme, so it still
     looks on-brand.)
   - **Price-source / currency split control**: kept `#src-logo` as an `<img>` (`app.js` swaps its
     `.src` on source change) and kept the `#src-menu` / `#cur-menu` popovers + `#src-label` /
     `#currency-label` (`app.js` toggles/sets them). Did NOT adopt the masterpiece `.seg` icon-only
     variant, which had dropped the logo img + menus.
   - **Item table**: kept the full `<table><thead><tr id="items-head"></tr></thead><tbody
     id="items-body"></tbody></table>` skeleton + `#search-empty` and the legacy `#items-*` inline
     styling; did NOT apply the masterpiece `.items-table`/`.items-wrap` classes yet (the table is a
     Phase-3 view re-skin, V4 — applying them now would fight the legacy non-sticky-header S-fix).
   - **Empty state** (`#empty-state`): kept the two-`<p>` shape (title = `querySelector('p')`,
     sub = `querySelector('p:last-child')`) that `app.js` writes text into; restyled to `.empty`
     with the sub `<p>` remaining the LAST child. Added the `hidden` default (app.js manages it).
   - **History** (`#history-wrap`): kept inner `#history-legend` + `#history-chart` mount points
     (`renderHistory()` draws into them); restyled the wrapper to `.card-rich`.

5. **Cap-token bootstrap / boot scripts preserved byte-for-byte.** The `<script src="/app.js">`
   load position + the keep-alive `GET /api/app/ping` (4000 ms) + the Live Logs launcher
   (bottom-left, `z-index:30`, below every overlay — S68) + `</body></html>` tail are IDENTICAL to
   `legacy_public/index.html` (verified by diff). The cap-token `capToken()`/`awaitCap()`/`api()`
   machinery lives in `app.js` (untouched, per PORT_PLAN §2.1) — index.html only preserves the
   script's load timing so the Tauri shell's `window.__SSIM_CAP__` injection lands unchanged. The
   license client-guard (`html.ssim-locked body{display:none}` + `classList.add('ssim-locked')`)
   and the Tailwind-Play local-runtime warning filter are also kept verbatim.

6. **All 20 static modals + progress panels + confirm + toast-stack**: region is byte-identical to
   `legacy_public` (verified by diff). They auto-convert to the glass card via the frozen
   `[id$="-overlay"] > div` adapter, whose blur was upgraded to the masterpiece `blur(18px)`
   spec via `--glass-blur`. Feature overlays (`tradeup-overlay`, `casket-overlay`) are still built
   at runtime by `app.js ensureFeatureOverlay()` — not in index.html, unchanged.

**Verification:** 292/292 legacy static ids present (0 missing); no external/CDN src|href; app.js
+ ping + launcher tail byte-identical to legacy; modals region byte-identical; structural tags
balanced; booted live against a stub backend through the real `app.js` (rich brand-gradient
primaries, sidebar depth gradient, S68 launcher at `left:18px bottom:18px z-index:30` all confirmed;
zero console errors).

---

## V2 — Dashboard environment tiles re-skin (`new_public/app.js` `envTile` + `renderDashboardSkeleton`)  ·  2026-07-06

**Net IA/flow change: NONE.** The `envTile(env)` template markup was re-authored to the
masterpiece `.env-tile` frame (glow strip `.env-tile__glow`, hover/focus-within-revealed
`.env-tile__actions`, icon+name+proxy-line header, `.pill pill--proxy/--local`, sunken
`.env-stat` cells, `.btn btn-ghost btn-sm` Test-proxy + `#proxytest-{id}` output span). Every
handler hook is byte-identical: `data-env`, `data-env-edit`, `data-env-del`, `data-name`,
`data-proxy-test`, and the `proxytest-${env.id}` span that `checkProxy()` writes to. No
fetch/state/handler touched; `renderDashboard`'s delegation, `checkProxy`, `formatAgo`,
`envLastUpdated`, `fmtCount` all unchanged.

Deliberate DECISION (design-source deviation, not an IA change):

1. **`.env-stat` cells show only the REAL per-env data (Accounts + Updated), not the
   prototype's Item worth / Wallet / Trade-locked / Accounts 2×2.** The masterpiece
   `renderEnvTiles` (`design_source.html:1533-1537`) reads `e.worth/e.wallet/e.locked` from its
   MOCK `ENVS` array. The frozen backend / legacy `env` object carries no per-environment
   worth/wallet/locked aggregate (only name, proxy/hasProxy, derived account count, and
   `envLastUpdated`). Inventing those numbers would require new fetches/aggregation — forbidden
   (backend FROZEN, "keep function exactly"). So the 2×2 grid renders the two truthful signals
   the legacy already has (Accounts via `fmtCount`, last-updated via `formatAgo`/`envLastUpdated`)
   in the same `.env-stat` sunken-cell styling. Invariant 1 (no fabricated money) upheld: no
   money value is shown that the data does not actually contain.

2. **Skeleton (`renderDashboardSkeleton`, P-309) re-shaped to the new tile frame** — 6 `.env-tile`
   shimmer tiles (glow strip + header row + 2×2 stat placeholders + button placeholder) so the
   loading state matches the re-skinned tile. Count (6), gating, and `el.envTiles.innerHTML`
   write unchanged.

---

## V3 — Sidebar tree: folder nodes + account rows + multi-select re-skin (`new_public/app.js` `renderFolderNode` + `renderAccountRow`)  ·  2026-07-06

**Net IA/flow change: NONE.** The `renderFolderNode(node,…)` and `renderAccountRow(acc,depth)`
template markup was re-authored to the masterpiece DS look while every handler hook stays
byte-identical. Preserved exactly: `data-toggle`, `data-folder`, `data-folderup`,
`data-folderdown`, `data-banfolder`, `data-addsub`, `data-rename`+`data-name`,
`data-delfolder`+`data-name` (folders); `data-selacct`, `data-username`, `data-edit`,
`data-move`, `data-bancheck`, `data-hide`+`data-hidden`, `data-attach` (accounts); and the
delegation class hooks `.acct-check`/`.acct-check-wrap`, `.account-btn`, `.acct-balance`,
`.acct-actions`, `.edit-btn`/`.move-btn`/`.bancheck-btn`/`.hide-btn`/`.attach-btn`. The legacy
separate-sibling structure (checkbox `<label>` OUTSIDE the `.account-btn` `<button>`) is KEPT —
required because `onSidebarClick` returns early on `.acct-check-wrap` and `onSidebarChange`
handles the checkbox; nesting it inside the button (as the prototype does) would break both the
delegation and valid HTML. `renderNodes`/`renderAccounts` recursion, the `pad = 8 + depth*14`
indentation, `subtreeCount`, collapse state, balance-sort, flat-filter mode, `patchSidebarBalances`,
and `setupDelegation` are all untouched.

Applied DS classes: `.account-row`/`.account-btn`/`.is-active` (glowing left rail via the
inline `<style>` DS), `.avatar` tile for the user icon, `.pill pill--ltd` for the LTD badge,
`.row-actions` hover-reveal wrapper, `.btn btn-icon-sm btn-ghost` for every row/folder action
button, and the `t10–t13` type scale.

Deliberate DECISION (design-source deviation, not an IA change):

1. **The prototype's per-account session status dot (`.dot--${a.session}`, `design_source.html:1564`)
   was NOT ported.** It reads a mock `session:'online'|'offline'|'error'` field that the frozen
   backend / legacy account object does not carry (verified: no session/online/loggedIn field on
   real accounts; the legacy sidebar row has no status dot either — P-052 describes only
   icon+name+username). Rendering a dot would fabricate connection state the data does not contain
   (invariant 8 / honesty). So the row adopts the neutral `.avatar` tile look but omits the
   data-less dot — a faithful re-skin, no invented signal. Balance tri-state on `.acct-balance`
   (`known` = `!!wallet || refreshed`; value / `0,00` / `—`) is preserved verbatim (invariant 1,
   P-054); `patchSidebarBalances` still updates only that chip.

---

## V5 — Fleet masters (folder / selection / env / global master headers + global env-filter)  ·  2026-07-07

**Net IA/flow change: NONE.** The four master `#main-header` clusters (`renderFolderMaster`,
`renderSelectionMaster`, `renderEnvMaster`, `renderGlobalMaster`) and the global-master
environment filter (`renderGlobalFilter`) were re-authored to the masterpiece `headerCluster`
pattern (`design_source.html:1628-1660, 1802-1806`): an icon-less `.truncate` `<h2>` title + a
`.pill pill--brand` scope badge (Folder-Master / N account(s) / Portfolio / Cross-environment),
and `.btn <variant> btn-sm` actions (Mass Buy → `btn-buy`, Delete Selected → `btn-danger`, the
rest → `btn-secondary`). `renderGlobalFilter` became a `.surface` strip of `.chip aria-pressed`
toggles. Every `id` hook (`btn-folder-massbuy/-bans/-refresh-folder`,
`btn-sel-massbuy/-refresh/-move/-bans/-delete`, `sel-all`/`sel-clear-all`, `btn-env-bans`,
`btn-global-bans`/`btn-refresh-global`), the `data-genv` delegation hook, and all `addEventListener`
wiring are byte-identical to legacy; the diff is markup-only (no fetch/state/handler/API touched).
The stat cards, breadcrumb, toolbar and master table already carry their DS skin from the V1 shell
and V4, so the master body reuses them unchanged.

Deliberate DECISION (design-source deviation, not an IA change):

1. **The decorative leading FontAwesome icon on each master title (`fa-folder-open`,
   `fa-layer-group`, `fa-chart-pie`, `fa-globe`) was dropped.** The masterpiece `headerCluster`
   renders master titles icon-less (`<h2>${title}</h2><span class="pill pill--brand">…`,
   `design_source.html:1658`) — an inline title icon also fights the new `.truncate` single-line
   `<h2>`. This is a pure form change (no hook, no data): the folder/selection/env/global scope is
   already unambiguous from the `.pill pill--brand` badge + breadcrumb, so no information is lost.

---

## V6 — Inventory header / refresh controls (`index.html` game toggle + `app.js` toggle/breadcrumb)  ·  2026-07-07

**Net IA/flow change: NONE.** The two inventory-header controls that V1 deliberately left
legacy-styled were brought onto the masterpiece design:

1. **Game toggle → `.seg` control.** `#game-toggle` became the masterpiece `.seg` (segmented
   control) with a `.split` divider, and `updateGameToggle()` (`app.js:559`) was re-wired from
   overwriting each button's entire `.className` (the reason V1 kept it verbatim) to
   `classList.toggle('is-on', …)`. The button ids (`#btn-game-cs2` / `#btn-game-tf2`), the
   `setGame` click handlers, and the CS2/TF2/lazy-load logic are unchanged — only the active-state
   mechanism moved from utility strings to the DS `.is-on` class.

2. **Breadcrumb spine → masterpiece style.** `renderBreadcrumb()` now emits chevron separators
   (`fa-chevron-right`, replacing the `›` glyph) and paints the active (last) segment
   `text-brand-light` (`design_source.html:1615`). The `data-bc` / `data-bc-id` delegation hooks and
   the dash/env/folder nav actions are byte-identical.

Deliberate DECISION (kept, not changed — for reviewer awareness):

- **The price-source / currency split control was NOT forced into `.seg`.** `.seg` sets
  `overflow:hidden` (for its rounded segment corners), which would clip the `#src-menu` / `#cur-menu`
  dropdown popovers. The control already uses the same DS tokens as `.seg` (`--r-btn` radius,
  `--border-1`, `slate-800`), so it reads as part of the same control family while keeping
  `#src-logo` (whose `.src` app.js swaps) and both popovers (`data-src` / `data-cur`) intact — the
  JS contract V1 protected stays protected.

---

## V7 — Value-history chart (`app.js` `renderHistoryChart`)  ·  2026-07-07

**Net IA/flow change: NONE.** The dual-line SVG already renders through the `.hist-*` DS classes
(`.hist-line-items` = `--brand-rgb`, `.hist-line-wallet` = `--success-rgb`, `.hist-area-items`,
`.hist-grid`, `.hist-axis`, `.hist-ylabel`) inside the `.card-rich` wrap from the V1 shell, so the
chart was already on-design. Two focused refinements:

1. **Time axis locale `de-DE` → `en-GB`.** The X-axis time labels (`fmtTime`) formatted dates/times
   with the German locale in an English-only UI (invariant 8) — the exact cosmetic issue the P4
   polish fixes in legacy `public/app.js`. Switched to `en-GB` (24-hour, `DD/MM`), which preserves
   the day-before-month ordering and 24h clock the old `de-DE` produced. **Critically, `de-DE` is
   retained everywhere it is the correct *money* format** (EUR values, ST-02: `fmtUsd`, `fmtEurCents`,
   `fmtCount`, `fmtCompact`, `localeForIso`) — the change is scoped to the chart axis only, so EUR
   figures still render `1.234,56`.

2. **Legend markers → masterpiece bar swatches.** The round dot swatches became the design's slim
   `9×3px` bars, and the values are bolded `font-mono` in each line's color (`text-brand-light` /
   `text-emerald-400`). The swatch colors are pinned to the actual SVG line strokes
   (`--brand-rgb` / `--success-rgb`), **not** the prototype's `--balance-rgb`, so legend and line
   always agree.

**Pricing-honesty (S2/S13) preserved verbatim:** a partial wallet series still dashes the balance
line (`stroke-dasharray 4 3`) and appends the "(incomplete)" legend note with its explanatory
tooltip; the shared-money-scale math, area fill, last-point dots and point count are untouched.

---

## V8 💰 — Active Orders view (`app.js` `ordersShellHtml` / `cancelBtn` / `buyOrderRow` / `sellOrderRow`)  ·  2026-07-07

**Net IA/flow change: NONE. Markup-only re-skin of a 💰 view — every handler, API call, funds
path and `ssimConfirm` gate is byte-identical.** Only the four template helpers changed:
`ordersShellHtml` (toolbar + the two sections → `.surface` / `.panel-head` / `.panel-title` /
`.field` search / `.btn btn-sm` actions), `cancelBtn` (→ `.order-cancel btn btn-sm btn-secondary`
with `--danger-rgb` text), and `buyOrderRow` / `sellOrderRow` (→ `.t13`/`.t10` type scale). The
loading spinner accent moved teal→brand.

**Load-bearing structure preserved (the reason this view is delicate):**

- `removeOrderRow()` updates a section's count by walking `row.parentElement` (the rows-list) →
  `.previousElementSibling` (the section header) → `querySelector('span.font-mono')`. The re-skin
  keeps that exact shape: each `.panel-head` header holds a `span.font-mono` count and is
  immediately followed by the rows-list `<div>` — so the untouched `removeOrderRow` still finds its
  count span. Documented inline in `ordersShellHtml`.
- `cancelBtn`'s inner HTML is `<i fa-xmark/><span>Cancel</span>` — it must match the string
  `bulkCancelOrders()` hard-codes when restoring a failed cancel button; kept identical.
- Every delegation/id hook the controllers read is intact: `#orders-search`,
  `#orders-cancel-selected`, `#orders-sel-count`, `#orders-cancel-all`, `#orders-refresh`,
  `.order-row`, `.order-check`, `.order-cancel`, `data-order-kind|-id|-name`,
  `data-cancel-buy|-listing`.

The amber partial-snapshot banner (`data.partial`) is unchanged — a truncated Steam/proxy fetch
still reads visibly as "incomplete", not as "no orders" (pricing/UI honesty S2/S13). The
`ssimConfirm` danger gates on both single-cancel (`cancelOrder`) and bulk-cancel
(`bulkCancelOrders`) are exactly as before (invariant 3).

---

## V9 💰 — Global Trade-Offers manager (`app.js` offer helpers + `index.html` `#offers-overlay`)  ·  2026-07-07

**Net IA/flow change: NONE. Markup-only re-skin of a 💰 view.** `app.js`: `offerStateBadge` now
returns a `.pill pill--*` variant (In escrow/Needs confirm → `warn`, Active → `listed`, Accepted →
`success`, Declined → `danger`, else `neutral`) consumed as `pill ${cls}`; `offerRowActions` →
`.btn btn-sm` (Accept emerald, Cancel/Decline `btn-secondary` + `--danger-rgb`). `index.html`:
the `#offers-overlay` chrome (header `.t16` / `.field` search / `.modal-x` close / `#offers-scope`
→ `.pill pill--brand`) and all six batch buttons → `.btn btn-sm`.

**Every controller stayed byte-identical:** `loadOffers`, `onSingleOfferAction` + `batchOffers`
(their `ssimConfirm` gates and the `/api/trade/offers-batch` call), `removeOfferRow`,
`bindOffersControls`, the search + select-all helpers. All 18 `#offers-*` ids and the
`.offer-row` / `.offer-check` / `.offer-act` / `data-offer-action|-id|-active|-search|-username`
hooks are preserved.

Deliberate DECISION (design-source deviation, not IA): **the prototype simplifies each side's items
to a single count pill; the port keeps `offerSideThumbs`' real item icons** (count pill + up to 5
thumbnails + `+N`) — strictly more informative and already truthful. **2FA-honesty preserved:** an
accepted-but-unconfirmed offer still surfaces "awaiting mobile confirmation" (invariant 3).

---

## V10 💰 — Market-Buy modal (`index.html` `#buy-overlay` + `app.js` `renderBuySearch`)  ·  2026-07-07

**Net IA/flow change: NONE. Markup-only re-skin of the highest-stakes 💰 view — every wallet/price
handler, funds path, and the sacred buy re-POST are byte-identical.** The static `#buy-overlay`
shell was ported to the masterpiece DS to match `design_source.html:1130-1148`: header `.t16` title +
`.modal-x` close, every label → `.field-label`, every input/select → `.field` (qty keeps
`flex-1 min-w-0`, price keeps `w-28`), the Max and Market-price buttons → `.btn btn-secondary
btn-sm`, Cancel → `.btn btn-secondary`, the **Buy submit → `.btn btn-buy`**, and the wallet line /
× qty total / amber buy-order note → the `.t11` type scale (info box `rounded-lg`→`rounded-xl`). In
`app.js`, `renderBuySearch`'s live-search dropdown rows moved to the `.t13`/`.t10` type scale and the
hover accent shifted teal→brand (`hover:bg-brand/15`).

**The sacred buy re-POST (`submitBuy` — the createBuyOrder finalize) is byte-identical, and so are
all wallet/price handlers:** `updateBuyWallet`, `refreshBuyWallet`, `recomputeBuyTotal`,
`fillMaxBuyQty`, `fetchBuyPrice`, `searchBuyItems`, `buyCurrencyCode`, `closeBuyModal`. The diff
touches only markup — no `api(`/`fetch(`/`addEventListener`/`state.` line changed. `renderBuySearch`'s
click-to-fill `addEventListener` block was left untouched (only its innerHTML template restyled;
`data-i` preserved so the click handler still resolves the picked item).

Deliberate DECISIONS (not IA changes), for reviewer awareness:

1. **`renderBuyWallet` and `openBuyModal` were left byte-identical.** Both are on the re-skin list,
   but neither emits DS-classable markup: `renderBuyWallet` only writes `textContent` to `#buy-cur` /
   `#buy-wallet`, and `openBuyModal` only emits bare `<option>`s into the datalist. So the wallet
   line's re-skin is applied to its **host** `#buy-wallet` `<p>` in `index.html` (`text-2xs`→`.t11`),
   leaving the balance-honesty logic completely untouched.

2. **`#buy-close` / `#buy-cancel` kept their `id`s (NOT switched to the prototype's `data-close`).**
   The handlers bind by id (`el.buyClose`/`el.buyCancel` → `closeBuyModal`, `app.js:242-243`,
   `6471-6472`); adopting `data-close` would break both. They wear `.modal-x` / `.btn btn-secondary`
   but keep their ids — same call as V9's `#offers-close`.

3. **`#buy-result` box markup left as-is.** `submitBuy` hard-codes the result box's full `className`
   (`px-3 py-2.5 rounded-lg border text-xs …`) when it reveals the box; re-styling the static
   placeholder would only diverge from what the untouched handler re-applies, so it was kept in sync.

**Balance tri-state honesty (invariant 1/3) preserved verbatim:** `renderBuyWallet` still shows the
three visually distinct states — never-refreshed `Balance unknown – "Refresh" the account first
(buying disabled)`, refreshed-empty `Balance: 0,00 …`, and a funded value — with no gating on
truthiness. EUR money formatting (de-DE `1.234,56`) inside the money formatters is untouched.

---

## V11 💰 — Folder Mass-Buy modal (`index.html` `#fbuy-overlay` + `app.js` `renderFbuySearch` / `renderFolderBuyResults`)  ·  2026-07-07

**Net IA/flow change: NONE. Markup-only re-skin of a multi-account 💰 view — every handler, the
`ssimConfirm` spend gate, and the FORCED 2-PHASE PRE-BUY BALANCE REFRESH are byte-identical.** The
static `#fbuy-overlay` shell was ported to the masterpiece DS to match `design_source.html:1152–1169`:
header `.t16` title + `.modal-x` close (`#fbuy-close` id kept — handler binds by id), the summary line
→ `.t12`, every label → `.field-label`, Game/Price/Search inputs & selects → `.field` (price keeps
`flex-1 min-w-0`), the Market-price button → `.btn btn-secondary btn-sm`, the amber safety note →
`.t11` (`rounded-lg`→`rounded-xl`), **Start-mass-buy submit → `.btn btn-buy`**, Close → `.btn
btn-secondary`. The in-flight progress panel was brought onto the DS too: the bar accent moved
teal→brand (`#fbuy-bar` → `bg-brand`), the phase/count line → `.t10`, and the End-task button →
`.btn btn-danger btn-sm` (its inner `<i fa-stop/><span>End task</span>` kept byte-identical to what
`resetEndBtn` re-emits). In `app.js`, `renderFbuySearch`'s live-search dropdown rows moved to the
`.t13`/`.t10` type scale with the hover accent shifted teal→brand (`hover:bg-brand/15`), mirroring V10's
`renderBuySearch`; its `data-i` click-fill `addEventListener` block was left untouched.

**The FORCED 2-PHASE PRE-BUY BALANCE REFRESH (`submitFolderBuy`) is byte-identical** — the critical
money-safety mechanic (every account's balance is refreshed live server-side before any bot is maxed
out) was not touched on any line, and neither were its `ssimConfirm` spend gate nor the POST to
`/api/market/folder-buy`. All other handlers stayed byte-identical too: `pollFolderBuy`,
`searchFbuyItems`, `fetchFbuyPrice`, `openFolderBuy`, `closeFolderBuy`, `hideFbuySearch`. The diff
touches only markup — no `api(`/`fetch(`/`ssimConfirm`/`addEventListener`/`setTimeout`/`state.` line
changed.

Deliberate DECISION (design-source deviation, not IA), for reviewer awareness:

1. **The progress panel + per-account results list have no counterpart in the mock** (the
   `design_source.html` `#fbuy-overlay` block is a static snapshot with no in-flight run), so both were
   re-skinned by analogy to the rest of the DS rather than copied. In `renderFolderBuyResults`, each
   row's status is now carried by a `.pill pill--success/listed/neutral/danger` on the qty (replacing
   the legacy status-colored `<span>`), while the **leading status icon is kept with its tint** — so
   `refresh-failed` still surfaces its distinct `fa-triangle-exclamation` (rose) and reads visibly
   apart from a plain `failed` or an empty run (pricing/balance honesty — a failed refresh must never
   look like "nothing bought"). The real per-account message (Steam's actual reason) and its `title`
   tooltip are preserved verbatim.

---

## V12 💰 — Market-Sell modal (mass-sell) (`index.html` `#sell-overlay` + `#sell-progress` + `app.js` `renderSellPreview`)  ·  2026-07-07

**Net IA/flow change: NONE. Markup-only re-skin of a 💰 view — every price/funds handler, the
`ssimConfirm` spend gate, and the sell execution are byte-identical.** The static `#sell-overlay`
shell was ported to the masterpiece DS to match `design_source.html:1100–1127`: header `.t16` title +
`.modal-x` close, the item-summary line → `.t14` (`rounded-lg`→`rounded-xl`), "Sale price (EUR)" →
`.field-label`, the three pricing-strategy radio cards → `rounded-xl` / `.t14` / `.t11` sub-text (the
`peer-checked:border-emerald-500` selected state kept — emerald = sell), the custom net-price input →
`.field w-32`, the **Calculate prices & proceeds** button → `.btn btn-secondary btn-sm w-full`, the
`#sell-preview-result` mount → `rounded-xl` `.t12`, the amber 2FA-irreversible/Gross-vs-Net note →
`.t11` (`rounded-lg`→`rounded-xl`), Cancel → `.btn btn-secondary`, and the **Sell & confirm submit →
`.btn btn-sell`**. The floating `#sell-progress` panel was brought onto the DS too: the bar accent
moved emerald→brand (`#sell-bar` → `bg-brand`, matching every other progress bar V6/V11), the
title/count/detail → `.t14`/`.t12`/`.t10`, and the **End-task button → `.btn btn-danger btn-sm`** (its
inner `<i fa-stop/><span>End task</span>` kept byte-identical to what `resetEndBtn` re-emits). In
`app.js`, `renderSellPreview`'s table moved to the DS type scale (header `.t10`, table `.t13`, missing
note `.t10`); the per-item re-query button → `.btn btn-icon-sm btn-secondary` (safe: `retryOnePrice`
only swaps the button's `innerHTML` icon, never its `className`, so the DS class persists).

**Every handler stayed byte-identical:** `submitSell` (POST `/api/market/sell` + its `ssimConfirm`
spend gate), `previewSell` (POST `/api/market/preview`), `pollSell` (1 s `/api/market/sell-status`
poll + bar/phase/stall/completion-refresh), `retryOnePrice`, `selectedSellItems`, `sellStrategy`,
`customSellCents`, `toggleSellCustomRow`, `openSellModal`, `showSellProgress`, `closeSellModal`. No
`api(`/`fetch(`/`ssimConfirm`/`addEventListener`/`setTimeout`/`state.` line changed; `openSellModal`
and `showSellProgress` emit no DS-classable markup (only `textContent` + class toggles), so their
re-skin lands on the static `#sell-overlay` / `#sell-progress` hosts. `#sell-close`/`#sell-cancel`
kept their `id`s (handlers bind by id — NOT the prototype's `data-close`; same call as V10/V11).

Deliberate DECISION (pricing honesty — invariant 5), for reviewer awareness:

1. **The sell preview keeps failed/unpriced items VISUALLY DISTINCT from priced ones.** A priced row
   still shows its Gross / Steam-fee(−, amber) / Net(emerald, `font-mono`) figures; an unpriced item
   now renders a rose `.pill pill--danger` "no price" (replacing the bare `text-rose-400` cell) beside
   its per-item re-query button, and the footer still appends the amber "N item(s) without price …"
   note. So an item whose live price fetch failed can never be mistaken for a zero-value or a priced
   sale — the money the operator will actually receive stays unambiguous. The amber deducted-fee `−`
   cue and the emerald Net (the payout figure) were preserved rather than flattened to neutral, since
   both carry meaning on a money view. EUR formatting (de-DE `1.234,56`) inside `fmtEurCents` untouched.

---

## V13 💰 — Send-Trade modal (single + folder mass-send) (`index.html` `#trade-overlay` + `#mass-progress` + `app.js` `recipientRow`)  ·  2026-07-07

**Net IA/flow change: NONE. Markup-only re-skin of a 💰 view — every send/trade handler, the
`/api/trade/send` + `/api/trade/mass-send` POSTs, and the End-task `ssimConfirm` gate are
byte-identical.** The static `#trade-overlay` shell was ported to the masterpiece DS to match
`design_source.html:1070–1097`: header `.t16` title + `.modal-x` close, the item-summary line →
`rounded-xl` `.t14`, the Internal-account / External-link radio cards → `rounded-xl` `.t14` (the
`peer-checked:border-brand/text-brand/bg-brand/10` selected state kept — brand = trade), the
Environment/Folder selects and the external trade-URL input → `.field`, every label → `.field-label`,
the recipient search → `.field pl-9` (magnifier kept), the recipient-list wrapper `rounded-lg`→
`rounded-xl`, the empty/count lines → `.t11`, the amber 2FA auto-confirm note → `.t11`
(`rounded-lg`→`rounded-xl`), Cancel → `.btn btn-secondary`, and the **Send & confirm submit →
`.btn btn-primary`** (brand; inner `<i fa-paper-plane/><span>Send & confirm</span>` kept byte-identical
to what `setButtonLoading` re-emits). The floating `#mass-progress` panel was brought onto the DS too:
the title/count/detail → `.t14`/`.t12`/`.t10`, the bar stays `bg-brand` (already on-brand, matching
every other progress bar), and the **End-task button → `.btn btn-danger btn-sm`** (its inner
`<i fa-stop/><span>End task</span>` kept byte-identical to what `resetEndBtn` re-emits). In `app.js`,
`recipientRow`'s clickable row moved to the DS look — `.avatar` tile + `.t13` name + `.t10` folder
subline — while keeping the load-bearing `data-recip` hook, the selected brand-ring highlight, and the
check icon.

**Every handler stayed byte-identical:** `submitTrade` (POST `/api/trade/send` + the unconfirmed
"SENT but NOT 2FA-confirmed — do NOT resend" money-safety warn + the `verifyBeforeRetry` guard + the
INV-E1 9-second deferred re-refresh of affected accounts), `submitMassTrade` (POST
`/api/trade/mass-send`), `pollMass` (1 s `/api/trade/mass-status` poll + bar/detail/stall/completion
re-pull + `surfaceTradeFailures`), `endTask` (the MANDATORY End-task `ssimConfirm` danger gate),
`closeTradeModal`, `openTradeModal`, `populateTradeFolders`, `buildRecipientList`, `readTradeTarget`,
`updateTradeTargetVisibility`, `surfaceTradeFailures`. No `api(`/`fetch(`/`ssimConfirm`/
`addEventListener`/`setTimeout`/`state.`-mutation line changed. `openTradeModal`, `populateTradeFolders`
and `showMassProgress` emit no DS-classable markup (only `textContent` + bare `<option>`s + class/style
toggles), so their re-skin lands on the static `#trade-overlay` / `#mass-progress` hosts.
`#trade-close`/`#trade-cancel` kept their `id`s (handlers bind by id — NOT the prototype's
`data-close`; same call as V10/V11/V12).

Deliberate DECISION (design-source deviation, not an IA change), for reviewer awareness:

1. **The recipient row is kept as a `[data-recip]` `<button>`, NOT the prototype's `<label>`+radio.**
   The mock's `#trade-overlay` recipient rows are `<label><input type="radio" name="recip">…</label>`
   (`design_source.html:1089–1090`), but the legacy `buildRecipientList` binds a click listener on
   every `[data-recip]` and reads `r.dataset.recip` to set `state.tradeTarget`, then re-renders the
   list to paint the selection. Swapping to the mock's radio structure (which has no `data-recip`)
   would break both the delegation and the selected-state re-render. So the row adopts the masterpiece
   `.avatar`/type-scale look but stays a `data-recip` button — same call as V3's sidebar rows, a
   faithful re-skin with the JS contract intact.
