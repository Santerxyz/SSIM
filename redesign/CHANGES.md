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
