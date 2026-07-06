# SSIM Parity Fragment — Segment 1

**Source range:** `legacy_public/app.js` lines 1–2300 (read through 2309) + `legacy_public/index.html` (full, lines 1–1552) for static UI in scope.
**Legend:** 💰 = money-affecting action. Refs are `app.js:NNNN` or `index.html:NNNN`.
**Note on shared helpers:** `toast()` (app.js:6037), `ssimConfirm()` (app.js:6253), `renderTable()`, `escapeHtml/escapeAttr/safeIconUrl`, `walletOf`, and the many modal *open/submit* handlers are DEFINED beyond line 2300 — this fragment records the call sites & the DOM contract they touch; their internal behavior belongs to later segments.

---

## GLOBAL SHELL / CHROME (static, index.html)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 1 | License client-guard: `<html class="ssim-locked">` hides `<body>` until app.js confirms licensing; else redirects to activation | index.html:11–17, 336 | `html.ssim-locked body{display:none!important}` |
| 2 | Tailwind Play runtime vendored locally; the one "cdn.tailwindcss.com … production" console.warn is filtered, all other warns intact | index.html:24–33 | `/assets/vendor/tailwind.js` |
| 3 | Tailwind theme: `brand`/`brand-dark`/`brand-light`, re-themed `slate` scale, semantic `success/warn/danger/buy/listed`; tightened radii; `text-2xs/3xs/4xs` (11/10/9px); Inter font | index.html:35–73 | DS-01 channel-var palette |
| 4 | Design-system palette tokens in `:root` (byte-identical to old hex); dark color-scheme forced | index.html:93–111 | `--brand-rgb:147 51 234` (#9333ea) |
| 5 | Body aurora background (2 radial violet gradients, fixed attachment); custom 6px scrollbars; violet `::selection` | index.html:115–127 | |
| 6 | Sidebar resize handle hover/drag styling: grip brightens; `body.resizing-x` locks cursor+selection | index.html:129–132, 484–491 | drag to resize · double-click to reset |
| 7 | Animations: `.fade-in` (0.25s), `.cs2-spin` (0.7s spinner), skeleton shimmer `.skel` (static under reduced-motion) | index.html:134–144 | FB-03 |
| 8 | Startup splash `#ssim-splash`: purple bloom + Santer diamond stroke-draw, fades out ≤1.2s; gated by sessionStorage; hidden under reduced-motion; z-[70] | index.html:146–186, 338–357 | played by `playStartupSplash()` (def >2300) |
| 9 | Micro-interactions: buttons press down on `:active`; inputs glow; hover border on fields | index.html:188–192 | |
| 10 | A11Y-02 visible `:focus-visible` ring (2px brand) on interactive elements; fields keep own violet ring | index.html:194–198 | |
| 11 | Filled-button top-light+depth for brand/emerald/teal/rose | index.html:200–206 | DS-04 |
| 12 | Items table framed surface; non-sticky header; violet row hover (`brand/.06`); item-icon drop shadow | index.html:208–220 | |
| 13 | TBL-02 render virtualization: `content-visibility:auto` on `#items-body tr` (intrinsic 52px) and `.account-row` (56px) | index.html:222–228 | keeps full DOM |
| 14 | Toolbars wrap gracefully in narrow window: `#stat-bar`, `#toolbar`, `#main-header` flex-wrap | index.html:230–245 | |
| 15 | KPI stat cards: hairline gradient top accent via `--stat-accent` | index.html:247–253 | |
| 16 | Env tiles: lift + violet glow on hover | index.html:255–260 | |
| 17 | DS-04 hybrid glass: every `div[id$="-overlay"] > div` modal card = translucent blurred glass + elevation; sticky modal sub-headers match glass | index.html:262–276 | |
| 18 | Sidebar depth gradient + active-row left indicator bar (`.account-btn.is-active::before`) | index.html:278–284 | |
| 19 | `.frosted` blur for headers above scroll | index.html:286–287 | |
| 20 | History chart color classes (SVG can't read var()): grid/ylabel/axis/line-items/line-wallet/dots | index.html:289–298 | |
| 21 | DS-03 status chip classes (`.chip--success/warn/danger/listed/buy/neutral`) + `aria-pressed=true` active look | index.html:300–312 | |
| 22 | Multi-select checkbox rests at low opacity, full on hover/focus/check | index.html:314–317 | |
| 23 | CSS-only hover info tooltip (`.ssim-tip` → `.ssim-tip-bubble`, 300px bubble w/ arrow) | index.html:319–332 | |
| 24 | Keep-alive ping: `fetch('/api/app/ping')` on load + every 4000ms | index.html:1509–1515 | legacy Edge heartbeat |
| 25 | "◳ Live Logs" floating launcher button (JS-created, fixed bottom-left `left:18px bottom:18px z-index:30`, violet gradient); click opens `/logs.html` popup AND POSTs `/api/app/open-logs` | index.html:1516–1550 | S68 layering fix |

---

## SIDEBAR (static structure + render logic)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 26 | Brand header: logo (`/assets/logo.png`), "SSIM" title, "Santer Steam Inventory Manager" subtitle | index.html:362–370 | |
| 27 | Context-nav "All environments" back button (`#btn-back-dashboard`, hidden on dashboard) → `showDashboard()` | index.html:373–379; app.js:1192, 1213–1220 | |
| 28 | Env-context panel (shown only inside an env): env name + proxy line (`Local IP (no proxy)` when none) | index.html:382–386; app.js:1197–1200 | |
| 29 | "Master (environment)" button `#btn-env-master` → `selectEnvMaster()`; gets ring when active | index.html:387–390; app.js:1201–1202, 1244–1251 | |
| 30 | "Account" add button `#btn-add-account` (opens add-account modal) | index.html:393–396 | handler >2300 |
| 31 | "Create new folder" button `#btn-add-folder` (folder-plus) | index.html:398–401 | |
| 32 | "Refresh all" button `#btn-refresh-all` | index.html:403–407 | |
| 33 | Refresh-All progress panel `#refresh-progress`: label + count (mono), progress bar `#refresh-bar` (brand, width%), "End task" button `#refresh-end` (rose, stop icon) | index.html:411–422 | shows in Global-Master too |
| 34 | Failed-accounts panel `#refresh-failed`: amber, lists WHICH account failed + WHY, persists until dismissed or next refresh; `#refresh-failed-close` hide button | index.html:426–437 | max-h-40 scroll |
| 35 | "Accounts" label + `#account-count` (mono) | index.html:439–442; app.js:1521 | count = visibleAccounts, `fmtCount` |
| 36 | Account search box `#account-search` (magnifier icon, "Search accounts…") | index.html:445–450 | Phase 2 B |
| 37 | Quick inventory filter `#account-filter`: All accounts / Has items / Empty inventory | index.html:452–457; app.js:1392–1399 | |
| 38 | Account sort `#account-sort`: Default order / Balance High→Low / Balance Low→High | index.html:458–463; app.js:1411–1420, 1464–1466 | tooltip "Sort accounts by wallet balance" |
| 39 | Account list `#account-list` (overflow-y scroll) | index.html:467 | |
| 40 | Show/Hide-hidden toggle `#btn-toggle-hidden`: "Show N hidden" / "Hide hidden" (only shown if hiddenCount>0) | index.html:469–471; app.js:1541–1550 | eye / eye-slash icons |
| 41 | Footer: pulsing emerald dot + `#footer-status` version (mono, filled from API — single source) | index.html:473–480 | |

### Sidebar tree — folder nodes (app.js render)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 42 | Folder node: chevron toggle (collapse/expand), folder/folder-open icon, name (click → folder-master), subtree count (mono) | app.js:1432–1458 | indentation `8 + depth*14`px |
| 43 | Folder name click → `openFolderMaster(id)`; active folder text = brand | app.js:1444–1445, 1570, 1949–1957 | |
| 44 | Move folder **up** arrow (disabled if first) → `reorderFolder(id,'up')` | app.js:1447–1448, 1559 | hover-reveal |
| 45 | Move folder **down** arrow (disabled if last) → `reorderFolder(id,'down')` | app.js:1449–1450, 1560 | |
| 46 | Folder "Check bans for all accounts in this folder" shield → `checkFolderBans(id)` | app.js:1451, 1564 | |
| 47 | "Create subfolder" folder-plus → `openFolderModal({mode:'create',parentId})` | app.js:1452, 1561 | |
| 48 | "Rename" pen → `openFolderModal({mode:'rename',id,name})` | app.js:1453, 1562 | |
| 49 | "Delete folder (contents move up)" trash → `deleteFolder(id,name)` | app.js:1454, 1563 | |
| 50 | Folder collapse state persisted in localStorage (`cs2.collapsed`) | app.js:52–56, 1658–1662 | `toggleFolder` |

### Sidebar tree — account rows (app.js render)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 51 | Account row: multi-select checkbox `[data-selacct]` (low opacity until hover/check) → `toggleAccountSelect` | app.js:1486–1489, 1574–1577, 1609–1615 | |
| 52 | Account button: user icon + displayName (or username) + username subline; active row = brand ring + `is-active` | app.js:1490–1503, 1470–1471 | click → `selectAccount(username)` |
| 53 | "LTD" badge when `canConfirm===false` (no identity_secret): tooltip explains buy/cancel work, sell/trade need maFile | app.js:1499 | amber |
| 54 | Per-account balance chip `.acct-balance`: STRICT states — real wallet → value (incl 0); refreshed+no wallet → `0,00` in fleet currency; never refreshed → `—`; fades out on row hover | app.js:1475–1500, 1581–1594 | `fmtWallet`/`fmtMoneyMinor(0,fleetCurrency())` |
| 55 | Hover action: **Edit** account pen → `openEditAccount(username)` | app.js:1505–1506, 1569 | |
| 56 | Hover action: **Move** folder-tree → `openMoveModal(username)` | app.js:1507–1508, 1568 | |
| 57 | Hover action: **Check bans** shield → `checkAccountBans(username)` | app.js:1509–1510, 1565 | |
| 58 | Hover action: **Hide/Show** eye/eye-slash → `toggleHide(username,isHidden)` | app.js:1511–1513, 1567 | |
| 59 | Hover action: **Attach maFile** (only when `canConfirm===false`) → `openAttachMaFile(username)` | app.js:1514–1515, 1566 | emerald shield |
| 60 | Search/quick-filter switches sidebar to FLAT cross-folder list; balance-sort alone keeps tree & only reorders within folders | app.js:1526–1537, 1460–1468 | empty → "No matching accounts." |
| 61 | Empty list fallback: "No accounts." | app.js:1538 | |
| 62 | PERF-01: ONE delegated click/change listener per container (no per-row rebinding) | app.js:1553–1604 | `setupDelegation` |
| 63 | `patchSidebarBalances()`: updates only balance chips (no rebuild, scroll preserved) | app.js:1579–1595 | |

---

## MULTI-SELECT (account checkbox) BEHAVIOR

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 64 | Any ticked account ⇒ auto-enter "Selection Master" (live-aggregated); all unticked ⇒ restore exact prior view (`preSelection` snapshot) | app.js:1606–1643 | `syncSelectionView` |
| 65 | "Select all" — ticks every account in active env, shows master | app.js:1645–1650, 2054 | |
| 66 | "Clear" — unticks all, reverts to pre-selection view | app.js:1652–1656, 2055 | |

---

## SCREEN NAVIGATION / VIEW MODES

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 67 | Two screens: `#screen-dashboard` / `#screen-inventory` toggled by `showScreen(name)`; leaving inventory unmounts window scroll listener | app.js:1181–1187 | |
| 68 | 6 inventory view modes: `account` / `env-master` / `global` / `folder` / `selection`; dispatched by `renderMain()` | app.js:7–9, 1711–1732 | |
| 69 | `updateSidebar()` shows/hides context nav, env-context, accounts label/tools based on in-env state | app.js:1189–1211 | |
| 70 | `showDashboard()` resets to account mode, clears selections | app.js:1213–1220 | |
| 71 | `enterEnvironment(envId)` → env-master mode, loads tree, resets search/sort/selection | app.js:1222–1231 | toasts err on tree fail |
| 72 | `showGlobalMaster()` → global mode; auto-selects ALL envs into `globalEnvs` on first entry | app.js:1233–1242 | |
| 73 | `selectEnvMaster()` → env-master mode | app.js:1244–1251 | |

---

## DASHBOARD SCREEN (environments)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 74 | Header title "Environments" + subtitle "Choose a farm environment or create a new one." | index.html:498–502 | |
| 75 | "Global Master" button `#btn-global-master` (globe) → global-master view | index.html:504–507; app.js:1233 | lives in dashboard header |
| 76 | "Account Login" button `#btn-account-login` → QR/credentials import modal | index.html:508–511 | Feature 1 |
| 77 | "Import bots" button `#btn-bulk-import` → bulk-import modal | index.html:512–515 | |
| 78 | "New environment" button `#btn-new-env` → env modal (create) | index.html:516–519 | |
| 79 | Env tiles grid `#env-tiles` (responsive 1/2/3 col) | index.html:522–523; app.js:1273–1285 | |
| 80 | Empty state `#env-empty`: "No environments yet" / "Create your first farm environment." | index.html:524–530; app.js:1275 | shown when 0 envs |
| 81 | Env tile: layer-group icon, Proxy/Local-IP pill, name, proxy line (mono), account **count** (`fmtCount`), last-updated ago | app.js:1342–1381, 1257–1271 | click tile → enter env |
| 82 | Env tile "Test proxy" button `[data-proxy-test]` → `checkProxy()` | app.js:1367–1369, 1283–1284, 1287–1315 | |
| 83 | Proxy test states: spinner "Testing…/running…"; green `✓ IP · CC (Country) · N ms`; red `✗ error` | app.js:1288–1315 | via `/check-proxy` |
| 84 | Env tile hover actions: **Edit** pen → `openEnvModal('edit',id)`; **Delete** trash → `deleteEnvironment(id,name)` | app.js:1372–1379, 1279–1282 | |
| 85 | Last-updated formatting: `just now` / `N min ago` / `N h ago` / `N d ago` / `never loaded` | app.js:1265–1271, 1364 | `formatAgo` |

---

## INVENTORY SCREEN — HEADER & STAT BAR (static + logic)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 86 | Breadcrumb `#breadcrumb` (NAV-01): truthful across all view modes, clickable segments (Environments › Env › Folder/Multi-Select › Account) | index.html:537; app.js:1668–1709 | `›` separator |
| 87 | Breadcrumb nav actions: `dash`→showDashboard, `env`→selectEnvMaster, `folder`→openFolderMaster | app.js:1703–1708 | |
| 88 | Main header `#main-header` (per-view content) | index.html:538 | |
| 89 | Stat card **Items** `#stat-items` (label overridable) | index.html:542–545 | brand accent |
| 90 | Stat card **Trade-Locked** `#stat-locked` (amber; label overridable) | index.html:546–551 | warn accent |
| 91 | Stat card **Item value** `#stat-value` (brand-light, compact w/ exact on hover) | index.html:552–555; app.js:1122–1128 | |
| 92 | Stat card **Balance** `#stat-wallet` (emerald, compact w/ exact on hover) | index.html:556–559; app.js:1125–1128 | |
| 93 | Game toggle CS2 ↔ TF2 (`#btn-game-cs2`/`#btn-game-tf2`) → `setGame`; active = brand fill | index.html:562–566; app.js:528–535, 559–564 | TF2 lazy-loads on first toggle |
| 94 | 💰 "Buy" button `#btn-buy-market` (teal cart) → market-buy modal | index.html:567–570 | |
| 95 | Price-source split control: `#src-btn` (Steam⟷CSFloat) w/ dropdown `#src-menu` (Steam Market / CSFloat) | index.html:571–581; app.js:784–808 | logo swaps |
| 96 | Currency split control: `#cur-btn` (USD⟷EUR) w/ dropdown `#cur-menu` (USD ($) / EUR (€)) | index.html:583–591; app.js:761–782 | |
| 97 | Currency button tooltip surfaces FX provenance: fallback-rate / stale (>36h) warning | app.js:767–782 | C20/INV-E5 |
| 98 | "Refresh" button `#btn-load` (assembles complete inventory: owned+locked+listed) | index.html:593–599; app.js:2142–2144 | handler >2300 |

### Stat-bar / body sub-sections (static)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 99 | Global-master env-filter container `#global-filter` (shown only in global mode) | index.html:605; app.js:1717 | |
| 100 | Value-history chart wrap `#history-wrap` (chart-line header + legend + `#history-chart`) | index.html:607–616 | |
| 101 | Item search box `#search-input` ("Search items…") | index.html:620–625 | |
| 102 | 💰 Value-filter `#value-filter` (Phase 2 A): "Select under" + currency-prefixed number input `#value-filter-input` + "Select" button → bulk-select items under threshold | index.html:626–638 | account+folder views |
| 103 | Selection bar `#selection-bar`: `#selection-count`, "Clear selection", 💰 "Sell on market" `#btn-sell-selected`, 💰 "Send selected items" `#btn-send-selected` | index.html:639–653 | |
| 104 | Empty state `#empty-state`: "No inventory loaded yet" / 'Select an account and click "Refresh".' | index.html:656–662 | boxes-stacked icon |
| 105 | Faceted filter chips bar `#facet-bar` (TBL-03) | index.html:664–665; app.js:1725 | re-shown by renderTable |
| 106 | GC 3-category filter pills `#gc-cat-tabs` (only for GC-fetched inventories) | index.html:667–668; app.js:1724 | |
| 107 | Items table `#items-wrap` (thead `#items-head`, tbody `#items-body`) + `#search-empty` "No items for this search." | index.html:670–679 | |
| 108 | Active-Orders view container `#orders-wrap` | index.html:681–682 | |
| 109 | Live-pull indicator `#inv-loading`: spinner "Loading inventory live from Steam…" / "Owner view · reading trade locks" | index.html:684–689 | |

---

## GAME TOGGLE / INVENTORY INGESTION LOGIC

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 110 | `setGame(game)`: clears selection, updates toggle, lazy-loads TF2 on first switch, re-renders | app.js:528–535 | |
| 111 | TF2 key counting: counts `Mann Co. Supply Crate Key` stacks | app.js:515–522 | `countTf2Keys` |
| 112 | `currentAppId()` = 440 (TF2) / 730 (CS2) — drives app-agnostic send | app.js:524–526 | |
| 113 | H-FE-001: failed cold TF2 fetch → records `tf2LoadError`, renders distinct error+Retry panel (never empty inventory) | app.js:537–557, 1714–1716, 1734–1764 | |
| 114 | `loadTf2Inventories()` on success starts price-fill watch (S29) | app.js:542–556 | |
| 115 | `reloadAll()`: parallel fetch environments + accounts + inventory + exchange-rate; records FX fallback/age provenance | app.js:566–583 | |
| 116 | GLOBAL wallet store: newest wallet (by fetchedAt) wins across CS2/TF2 so balance never clobbered by staler game-cache | app.js:585–598 | `rememberWallet` |
| 117 | `wasRefreshed(u)`: distinguishes "refreshed empty" (→0) from "never fetched" (→—) | app.js:600–609 | |
| 118 | `refreshActiveViewFromCache()`: re-pulls cache after a mass op (buy/sell/trade), invalidates history, re-renders main+sidebar (no re-login) | app.js:611–634 | |
| 119 | `invFor(u)`: active-game inventory lookup w/ lowercase-key normalize | app.js:506–512 | |

---

## MONEY / CURRENCY FORMATTING RULES

| # | Formatting rule (exact) | Legacy ref | Notes |
|---|---|---|---|
| 120 | `fmtUsd(usdMajor)`: null/NaN→`—`; EUR = `usdMajor*usdToEur`; symbol `€`/`$`; locale de-DE (EUR) / en-US (USD); 2 fraction digits → `€1.234,56` / `$1,234.56` | app.js:638–645 | ST-02 |
| 121 | `fmtCents(cents)` = cents/100 → fmtUsd; null→`—` | app.js:647 | |
| 122 | `fmtEurCents(cents)`: `€` + de-DE 2-digit (no FX; market-sell already EUR) | app.js:649–652 | |
| 123 | `walletToUsd(w)`: USD(1)→balance; EUR(3)→balance/usdToEur; 0 stays 0; unknown non-zero currency→null | app.js:653–662 | |
| 124 | `fleetCurrency()`: most-common wallet currency across accounts (fallback EUR=3) for empty-wallet display | app.js:663–677 | |
| 125 | `stackValueCents(item)` = price × quantity (0 unpriced) | app.js:678–679 | |
| 126 | `worthCentsForAccounts()`: SINGLE worth source = Σ backend `inv.totalValueUsd` (C19/INV-E3) | app.js:681–689 | |
| 127 | `STEAM_CURRENCIES` map (code→ISO+decimals, 46 currencies) + `curInfo` | app.js:691–705 | |
| 128 | `CURRENCY_LOCALE` per-ISO locale override (USD→en-US, JPY→ja-JP, …); default de-DE | app.js:706–716 | ST-02 |
| 129 | `fmtMoneyMinor(minor,code)`: Intl.NumberFormat currency style, per-currency locale+decimals; fallback to number+ISO | app.js:717–726 | |
| 130 | `fmtWallet(w)`: STRICT — balance null/undefined/'' → `—`; real 0 → `0,00`; else localized native | app.js:729–738 | |
| 131 | `normalizeMajor`/`parseMajorToMinor`: parse typed "2,15"/"1.500,00"; disambiguate decimal-vs-grouping; never over-parse | app.js:739–759 | |
| 132 | `fmtCount(n)`: thousands-grouped in display-currency locale (12,480 / 12.480) | app.js:1130–1136 | |
| 133 | `fmtCompactCount(n)`: grouped-exact <1M, "1.2M" above | app.js:1137–1143 | |
| 134 | `fmtUsdCompact`: cents precision <100k, "€1.2M" above | app.js:1144–1152 | |
| 135 | `setCountStat(elem,n)`: compact text + exact grouped on hover (title) | app.js:1153–1160 | |
| 136 | `setMoneyStats(valueCents,walletUsd)`: compact display + exact `title`; null→`—` | app.js:1122–1128 | |
| 137 | `setCurrency(cur)`: persists `ssim.currency`, updates buttons, re-renders | app.js:761–766 | localStorage |

---

## PRICE SOURCE / PRICE-FILL WATCH / STALE STATES

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 138 | 💰 `setPriceSource(src)`: PUT `/api/pricing/source`; respects backend "effective" (falls back to Steam if no CSFloat key); toast; reload+repull | app.js:791–808 | persists `ssim.priceSource` |
| 139 | Toast (source): success "Price source: X — re-pricing…"; error "No CSFloat API key found — pricing from Steam…" | app.js:800–801 | |
| 140 | `updatePriceSourceButton()`: label + logo swap Steam/CSFloat | app.js:786–790 | |
| 141 | `formatFillEta(left)`: "~Ns left" (<90s) / "~N min left" (<90m) / "~N.N h left" | app.js:850–861 | 3500ms/name |
| 142 | `priceFillIndicator(status)`: show if running or queued>0; "long" hint if >200 left | app.js:863–870 | |
| 143 | Floating "Fetching prices…" badge `#price-fill-indicator`: `N left · N done · ~eta · (large inventory)`; spinner tag; hover explains single-IP throttle; auto-hides on drain | app.js:871–892 | fixed bottom-4 right-4 z-40 |
| 144 | `watchPriceFill(repull)`: polls `/api/pricing/status` every 2500ms; re-pulls whole fleet when `fetched` advances (coalesced ≥10s); drains-then-stops; 15-min no-progress safety stop; 24-consec-error dead-backend stop; token supersession | app.js:894–943, 826–843 | S10/S19/S42 |
| 145 | `pollRepricing()`: after source switch, watch fill + live-update | app.js:1120–1121 | |

---

## SYSTEM-STATUS POLL + ADDITIVE INDICATORS (30s loop)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 146 | `watchSystemStatus()`: polls `/api/system/status` every 30000ms; launched once from init | app.js:1089–1118 | |
| 147 | Runtime license revocation: `st.licensed===false` → `window.location.replace('/')` (activation screen) | app.js:1096–1100 | H-LIC-008, strict === |
| 148 | 💰 Update indicator badge `#update-indicator` (bottom-left z-40): "Update vX available — click to install" or blocked variant; click → confirm+install | app.js:984–1006 | |
| 149 | 💰 Update install flow `confirmAndInstallUpdate()`: ssimConfirm "Install & restart"; then `triggerUpdate(true)`; S61 confirm-before-install | app.js:955–982 | |
| 150 | `triggerUpdate(install)`: POST `/api/app/check-update`; toasts "Installing update…", "Update vX available…", "You're on the latest version." | app.js:954–967 | |
| 151 | Post-install reconcile: if install ended without swap, clear "installing…", re-show badge, toast outcome | app.js:1105–1109 | S34 |
| 152 | Breaker indicator `#breaker-indicator` (top-center rose z-50): "Money operations paused. {reason} — restart SSIM before more trades/buys." when `moneyOpsStable===false` | app.js:1008–1022 | B3 |
| 153 | Token-store warning `#tokenstore-warning` (amber): "Refresh-token store is corrupt. …restore refresh_tokens.json from .bak…" | app.js:1024–1038 | |
| 154 | CSFloat key-store warning `#csfloatkeystore-warning` (amber): "CSFloat key store is corrupt. …restore csfloat_keys.json…" | app.js:1040–1054 | |
| 155 | Crash banner `#crash-banner` (top-right amber, dismissible ✕): "SSIM's backend crashed last run ({time}, code N)…" | app.js:1056–1072 | B1, render once |
| 156 | Capability banner `#capability-banner` (top-center rose): "This session lost its authorization… Fully restart SSIM…" on 401 capabilityRequired | app.js:1074–1087, 471 | S1 |

---

## CAPABILITY TOKEN / API LAYER

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 157 | `capToken()`: reads `window.__SSIM_CAP__`, persists to sessionStorage (survives reload), per-origin | app.js:415–429 | S1/B26 |
| 158 | `api()` sends `X-SSIM-Cap` header; mutating methods await token (≤3s); reads never block | app.js:430–475 | |
| 159 | Every call bounded by client timeout (default 120000ms); AbortError → "The request timed out — the backend may be busy…" | app.js:448–463 | S32 |
| 160 | Global UI error handlers: `window.onerror`/`unhandledrejection` → toast + POST `/api/app/client-error`; coalesced 1/sec | app.js:477–504 | S30 |

---

## VALUE HISTORY CHART

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 161 | `loadHistory(seriesId)`: 10s-TTL cache; global mode aggregates selected envs (POST `/api/history/aggregate`); else GET `/api/history/{id}?game=`; async race guard by cache key + game | app.js:1780–1821 | |
| 162 | `invalidateHistory()` on refresh complete | app.js:1823–1824, 630 | |
| 163 | Dual-line SVG chart: Items worth (brand) + Balance (emerald); shared money Y-axis (USD cents); area fill under items; last-point dots | app.js:1826–1901 | dependency-free |
| 164 | <2 points → "Not enough data points yet – the curve grows with the next refresh." | app.js:1835–1839 | |
| 165 | Partial-wallet series: emerald line dashed + "(incomplete)" legend note w/ tooltip | app.js:1834, 1894, 1906 | |
| 166 | X-axis time labels: same-day → `HH:mm` (de-DE); cross-day → `dd.MM HH:mm` | app.js:1864–1870 | |
| 167 | Y-axis labels via `fmtCents`; grid lines at 25/50/75% | app.js:1873–1877 | |
| 168 | Legend: "Items worth {fmtCents} · Balance {fmtCents} · N points" | app.js:1902–1907 | |

---

## FOLDER-MASTER VIEW

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 169 | `openFolderMaster(folderId)` → folder mode, resets search/sort/selection | app.js:1949–1957 | |
| 170 | Aggregates every asset across folder accounts (1:1 w/ single views); tracks quantity/sendable/owners; O(1) index | app.js:1919–1947, 1959–1964 | `aggregateWithOwners` |
| 171 | Header: folder-open icon + name + "Folder-Master" pill; "N account(s) · aggregated 1:1…" | app.js:1967–1974 | |
| 172 | 💰 "Mass Buy" button → `openFolderBuy(name,usernames)` | app.js:1976–1977, 1984–1985 | teal |
| 173 | "Check Bans" button → `openBanChecker(usernames,name)` | app.js:1978–1979, 1986–1987 | |
| 174 | "Refresh folder" button → `refreshFolder(usernames)` | app.js:1980, 1982–1983 | |
| 175 | Stats relabeled: Items→"Sendable items", Trade-Locked→"Bots"; value = worthCentsForAccounts; wallet = Σ walletToUsd | app.js:1989–1997 | |
| 176 | Empty: "No tradable items in cache" / 'Click "Refresh folder" to load the bot inventories.' | app.js:1999–2005 | |
| 177 | Renders selectable master table | app.js:2006–2007 | `renderTable({master,selectable})` |

---

## SELECTION-MASTER (MULTI-SELECT) VIEW

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 178 | `renderSelectionMaster()`: aggregates hand-picked accounts; falls back to env-master if empty | app.js:2013–2023 | |
| 179 | Header: layer-group + "Multi-Select" + "N account(s)" pill; inline "Select all" / "Clear" | app.js:2025–2037, 2054–2055 | |
| 180 | 💰 "Mass Buy" → openFolderBuy(`N selected account(s)`) | app.js:2039–2040, 2050 | |
| 181 | "Refresh selected" → refreshFolder | app.js:2041, 2049 | |
| 182 | "Move Selected" → openMoveModal(usernames array) | app.js:2042–2043, 2051 | |
| 183 | "Check Bans" → openBanChecker(usernames,`N selected`) | app.js:2044–2045, 2052 | |
| 184 | 💰 "Delete Selected" (rose) → batchDeleteAccounts(usernames) | app.js:2046–2047, 2053 | maFiles kept |
| 185 | Stats + empty state mirror folder-master ("Refresh selected") | app.js:2057–2075 | |

---

## ACCOUNT VIEW (single account)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 186 | `renderAccountView()`: header = displayName + Proxy/Local-IP pill + username (mono); placeholder if none | app.js:2079–2094, 2081 | |
| 187 | Trade-link render/bind (`renderTradeLink`/`bindTradeLink`) | app.js:2096, 2124 | defs >2300 |
| 188 | "Check Bans" button → `checkAccountBans(username)` | app.js:2097–2099, 2125–2126 | |
| 189 | "Logs" button → `openAccountLogs(username)` | app.js:2100–2102, 2127–2128 | |
| 190 | 💰 "Trade-Ups" button (amber) → `openTradeUpModal(username)` | app.js:2104–2106, 2131–2132 | def >2300 |
| 191 | "Storage" (caskets) button (sky) → `openCasketModal(username)` | app.js:2107–2109, 2133–2134 | |
| 192 | 💰 "Trade Offers" button → `openTradeOffers()` | app.js:2110–2112, 2129–2130 | |
| 193 | 💰 "CSFloat" button → `openCsFloat(username)` | app.js:2113–2115, 2135–2136 | |
| 194 | "SDA" button (emerald) → `openSda(username)` (Steam Guard + confirmations) | app.js:2116–2118, 2137–2138 | |
| 195 | "Browser" button (violet) → `openCleanBrowser(btn,username)` (logged-in via linked proxy, ephemeral) | app.js:2119–2122, 2139–2140 | |
| 196 | Refresh button shown+reset (enabled, rotate icon) | app.js:2142–2144 | |
| 197 | Warning "not refreshed yet – trade-locked/listed may be missing" only when CS2 & `inv.source!=='gc'` | app.js:2148–2152, 1766–1774 | |
| 198 | Stat labels: TF2 → "TF2 Items"/"TF2 Keys"; CS2 → "Items"/"Trade-Locked" | app.js:2152 | |
| 199 | GC-sourced CS2 → category pills; else plain "Items" pill; Active-Orders tab always available | app.js:2154–2159 | `renderAccountTabs` (def >2300) |
| 200 | Stats: totalItems, locked/keys, value=`inv.totalValueUsd`, wallet=walletToUsd (0 when refreshed+empty); '—' when no cache | app.js:2161–2173 | |
| 201 | Active-Orders tab → `renderOrdersView(username,appId)` | app.js:2175–2182 | |
| 202 | Renders selectable table (both games; app-agnostic send) | app.js:2185–2190 | |
| 203 | Empty: "No TF2 inventory cached yet"/"No inventory in cache yet" + 'Click "Refresh" to load it live.' | app.js:2191–2196 | |

---

## ACTIVE-ORDERS VIEW (live sell listings + buy orders)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 204 | `renderOrdersView(username,appId)`: fetches GET `/api/market/orders/{username}?appId=`; loading spinner "Loading active orders live from Steam…"; in-flight guard (`stillHere`) | app.js:2205–2229 | always live |
| 205 | Fetch error → shell w/ rose error message in both sections + retry controls | app.js:2218–2225 | |
| 206 | Orders shell: "Active market orders" header + item search `#orders-search` + 💰 "Cancel selected (N)" + 💰 "Cancel all" + "Refresh"; two sections (Active Buy Orders / Active Sell Orders) w/ counts | app.js:2231–2254 | |
| 207 | Partial-snapshot banner (amber): "Order list may be incomplete (Steam/proxy error during fetch) — refresh to retry." | app.js:2262–2267 | |
| 208 | Buy-order row: checkbox, icon, name + `#id` (mono), price (`fmtMoneyMinor`), qty `remaining / total` (or remaining), 💰 Cancel button (`data-cancel-buy`) | app.js:2282–2293 | |
| 209 | Sell-order row: checkbox, icon, name + `#listingId`, price, `qty N`, 💰 Cancel button (`data-cancel-listing`) | app.js:2294–2303 | |
| 210 | Per-order Cancel button tooltip "Cancel this order on the Steam market" | app.js:2275–2278 | |
| 211 | Empty rows: "No active buy orders." / "No active sell orders." | app.js:2259–2261 | |
| 212 | `bindOrdersControls()` wires Refresh, per-row cancel, search, multi-select, cancel selected/all | app.js:2305–2309 | full body >2300 |
| 213 | Order icon: img w/ lazy load + onerror hide (via `safeIconUrl`), else spacer | app.js:2270–2274 | |

---

## ACCOUNT ACTIVITY LOG MODAL (Phase 4)

| # | Capability / behavior | Legacy ref | Notes |
|---|---|---|---|
| 214 | `openAccountLogs(username)`: shows `#logs-overlay`, GET `/api/accounts/{username}/logs`; "Loading…" → entries | app.js:1317–1339 | index.html:1343–1352 |
| 215 | Entry row: timestamp (`toLocaleString`) + message; level tone error→rose / warn→amber / else slate | app.js:1329–1335 | |
| 216 | Empty: "No activity logged for this account yet." | app.js:1325–1328 | |
| 217 | Error: rose message | app.js:1336–1337 | |
| 218 | `closeLogs()` hides overlay | app.js:1340; index.html:1348 | |

---

## STATIC MODALS (structure; open/submit handlers mostly >2300)

| # | Modal + its outcomes/controls | Legacy ref | Notes |
|---|---|---|---|
| 219 | **Add-account** `#modal-overlay`: Environment select, Username, Password, maFile path, optional Proxy override; Cancel / "Add" submit | index.html:695–736 | |
| 220 | **Account-Login** `#login-overlay` (Feature 1): Environment select; QR/Credentials tabs; QR pane (img + overlay + status + instructions); credentials form (username/password/Guard code); "Limited account" info note | index.html:738–797 | |
| 221 | **Attach-maFile** `#attach-overlay`: upgrade Limited→Full; maFile path; "Upgrade to Full" submit | index.html:799–821 | |
| 222 | **CSFloat workspace** `#csfloat-overlay`: account label, tabs `#csfloat-tabs`, body `#csfloat-body` | index.html:823–836 | |
| 223 | **SDA overview** `#sda-overlay` (Phase 6): large OTP `#sda-otp` (30s countdown bar `#sda-otp-bar`) + Copy; pending confirmations list w/ Approve selected (N) / Approve all / Refresh | index.html:838–872 | |
| 224 | **New/Edit environment** `#env-overlay`: Name, "Global (rotating) proxy" (multi-format hint, empty=local IP); Cancel / Create-or-Save | index.html:874–903 | title/label swap by mode |
| 225 | **Folder name** `#folder-overlay`: Folder name; Cancel / Save (create or rename) | index.html:905–926 | |
| 226 | **Move-account** `#move-overlay`: Environment select, Target folder select; Cancel / Move | index.html:928–953 | reused by ban-category move |
| 227 | **Edit-account** `#edit-overlay`: account label; Display name; Network/proxy ("Use environment proxy" checkbox + custom proxy + current line); collapsible "Change credentials" (password + maFile); re-login note; Cancel / Save; 💰-adjacent **Delete account** (rose, "Removes only from SSIM…") | index.html:955–1010 | |
| 228 | 💰 **Send-trade** `#trade-overlay`: summary + from; Internal/External radio; internal = Env→Folder→Recipient search list (count + empty); external = trade link; 2FA auto-confirm note; Cancel / "Send & confirm" | index.html:1012–1078 | |
| 229 | 💰 **Market-sell** `#sell-overlay`: summary + from; price strategy radios (Lowest listing / 1 cent below / Custom price w/ €-input); "Calculate prices & proceeds" preview button + result; Gross/Net + irreversible note; Cancel / "Sell & confirm" | index.html:1080–1141 | EUR |
| 230 | 💰 **Market-buy** `#buy-overlay`: Bot account datalist + wallet line; Game select (730/440); Quantity + "Max" (spend entire balance); item live-search `#buy-name` + results; Price per item + "Market price" fetch + `× qty = total` echo; Buy-Order note (verified via inventory increase); result; Cancel / "Buy & confirm" | index.html:1144–1207 | |
| 231 | 💰 **Folder Mass-Buy** `#fbuy-overlay`: summary; Game select; Price/item (own cur.) + market-price fetch; item live-search + results; "balance refreshed live first, each bot maxes out" note; progress (phase/count/bar/End task); results list; Close / "Start mass buy" | index.html:1209–1265 | |
| 232 | **Bulk-import** `#bulk-overlay`: Target env + folder; method chooser (SSIM Vault / CSV / maFiles); Vault panel (vault.enc+accounts.json file picker + master pw + Import vault + status); CSV panel (format hint + Choose CSV + status); maFiles panel ("All Accounts" select-all + found-list + Import); Close | index.html:1267–1341 | |
| 233 | **Account-logs** `#logs-overlay` (see #214–218) | index.html:1343–1352 | |
| 234 | 💰 **Trade Offers Manager** `#offers-overlay`: scope pill; search `#offers-search`; Refresh; two sides — Sent (select-all active, 💰 Cancel selected (N), 💰 Cancel all) / Received (select-all, 💰 Accept (N), 💰 Decline, 💰 Accept all, 💰 Decline all); per-side lists+counts | index.html:1354–1426 | env-wide aggregation |
| 235 | **Ban Checker results** `#ban-overlay` (z-30): scope label; summary (per-category counts); accordion body; each category "Move this Category" reuses Move modal (z-40 above) | index.html:1428–1444 | |
| 236 | **Confirm dialog** `#confirm-overlay` (FB-01, z-[55]): icon + title + body + optional typed-confirm input ("Type X to confirm"); Cancel / OK; driven by `ssimConfirm()` | index.html:1446–1469 | ssimConfirm def >2300 |
| 237 | 💰 **Mass-send progress** `#mass-progress` (bottom-center z-50): "Mass trade running…" + count + bar + detail + "End task" | index.html:1471–1485 | |
| 238 | 💰 **Mass-sell progress** `#sell-progress` (bottom-center z-50): "Market sale running…" + count + bar + detail + "End task" | index.html:1487–1501 | |
| 239 | **Toast stack** `#toast-stack` (FB-02, bottom-right z-[60], newest at bottom, `aria-live=polite`, pointer-events pass-through) | index.html:1503–1505 | toast() def >2300 |

---

## POLLING LOOPS / CADENCES (summary)

| # | Loop | Cadence | Ref |
|---|---|---|---|
| 240 | Keep-alive ping `/api/app/ping` | 4000ms | index.html:1511–1513 |
| 241 | Price-fill watch `/api/pricing/status` | 2500ms poll; re-pull coalesced ≥10000ms; drain-stop; 15-min no-progress stop; 24-error dead stop | app.js:894–943 |
| 242 | System-status watch `/api/system/status` | 30000ms | app.js:1089–1118 |
| 243 | Ban-check status poll (`state.banTimer`) | (setTimeout loop, def >2300) | app.js:36 (state) |

---

## FORMATTING/ICON HELPERS TOUCHED IN RANGE

| # | Helper | Ref | Notes |
|---|---|---|---|
| 244 | `itemColor(item)` — rarity hex (RARITY_HEX map, 8 tiers + Unknown), respects item.rarityColor | app.js:364–378 | |
| 245 | `rarityWeight(r)` / `statusGroup(item)` / `compareItems(a,b,key)` — sort by name/quantity/rarity/value/accounts/status(locked expiry tiebreak) | app.js:379–403 | |
| 246 | `escapeHtml`/`escapeAttr`/`safeIconUrl` — used throughout (defs >2300) | app.js:1300, 2272 (calls) | |
| 247 | `formatAgo(ts)` (dashboard) — see #85 | app.js:1265–1271 | |
