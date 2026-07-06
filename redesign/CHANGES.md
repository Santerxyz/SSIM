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
