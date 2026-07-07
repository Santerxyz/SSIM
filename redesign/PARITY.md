# SSIM Redesign — MASTER PARITY CONTRACT

> The single checklist the frontend redesign is measured against. Every legacy user-facing
> capability/behavior is one numbered row. **Nothing here may be dropped.** The redesign adopts the
> visual language of `redesign/design_source.html`, but every row below must remain wired to the
> **frozen** backend (`src/`) exactly as the legacy UI wired it.
>
> **Merged from** `_parity/seg1.md` (app.js 1–2309 + index.html full), `_parity/seg2.md`
> (app.js 2250–4550), `_parity/seg3.md` (app.js 4500–6788). Overlapping rows across the three
> segment boundaries (Active-Orders ~2250–2309, CSFloat ~4008–4529, Env-modal ~4532–4607) were
> deduplicated — the fullest description of each capability was kept and its refs consolidated.
>
> **Legend:** 💰 = money- or real-asset-affecting action (extra care: confirm gates, live funds
> checks, post-action refresh, 2FA honesty). Refs are `app.js:NNNN` (JS source) or
> `index.html:NNNN` (static markup) — all relative to `redesign/legacy_public/`.
>
> **Status column** is intentionally blank — tick `✅` (done) / `🔨` (in progress) / `⛔` (blocked)
> per row as the build proceeds.

---

## Totals

- **Total rows:** 533 (P-001 … P-533, no gaps, no duplicates)
- **Views / feature groups:** 43
- **Money-affecting rows (💰):** 125

## Index (one line per view/feature group)

| Group | Rows | What it covers |
|---|---|---|
| A. Global shell / chrome | P-001 … P-025 | License guard, theme, palette, splash, glass, tooltips, keep-alive, Live-Logs launcher |
| B. Sidebar (chrome + tree) | P-026 … P-063 | Brand header, env context, refresh-all panel, search/filter/sort, folder nodes, account rows, delegation |
| C. Multi-select behavior | P-064 … P-066 | Auto-enter Selection-Master, select-all, clear |
| D. Screen navigation / view modes | P-067 … P-073 | 2 screens, 6 inventory modes, enter/leave env, dashboard/global/env master |
| E. Dashboard (environments) | P-074 … P-085 | Header actions, env tiles grid, proxy test, tile hover actions, ago formatting |
| F. Inventory header & stat bar | P-086 … P-109 | Breadcrumb, 4 stat cards, game toggle, Buy, price-source/currency split menus, Refresh, body sub-sections |
| G. Game toggle / inventory ingestion | P-110 … P-119 | setGame, TF2 lazy-load + error panel, reloadAll, wallet store, refreshed-vs-never |
| H. Money / currency formatting | P-120 … P-137 | fmt* family, wallet strictness, parse major→minor, count/compact, currency toggle |
| I. Price source / fill-watch / stale | P-138 … P-145 | setPriceSource, fill ETA badge, watchPriceFill poller |
| J. System-status poll + indicators | P-146 … P-156 | 30s loop, license revoke, update badge, breaker, store-corrupt warnings, crash/capability banners |
| K. Capability token / API layer | P-157 … P-160 | capToken, api() header + timeouts, global error handlers |
| L. Value-history chart | P-161 … P-168 | loadHistory cache/aggregate, dual-line SVG, partial-wallet, axes, legend |
| M. Folder-Master view | P-169 … P-177 | Aggregate folder, header/pills, Mass-Buy/Bans/Refresh, relabeled stats, table |
| N. Selection-Master (multi-select) view | P-178 … P-185 | Aggregate hand-picked, header, Mass-Buy/Refresh/Move/Bans/Delete, stats |
| O. Account view (single) | P-186 … P-203 | Header, trade-link, action buttons, refresh, warning, GC tabs, stats, table, empty |
| P. Active-Orders view | P-204 … P-224 | Live orders shell, buy/sell rows, single + bulk cancel, search, partial banner |
| Q. Global Trade-Offers manager | P-225 … P-255 | Two-sided sent/received, badges, values, batch accept/decline/cancel, search |
| R. Aggregated views internals | P-256 … P-266 | aggregate helper, stat labels, env/global master headers, global env-filter, placeholder |
| S. Trade-link (Feature 2) | P-267 … P-271 | Get/copy trade link, clipboard fallback |
| T. Item table / facets / sort / selection | P-272 … P-306 | Category tabs, windowed render, per-row cells, facets, sort, selection modes, select-under-value |
| U. Account selection + refresh | P-307 … P-325 | Select account, skeletons, single/all refresh, failed panel, stall, hide/unhide |
| V. Edit-account modal | P-326 … P-332 | Prefill, proxy toggle/hint, delete, save (proxy-intent + creds) |
| W. Add-account modal | P-333 … P-335 | Open, submit, fields |
| X. Account-Login modal (QR / creds) | P-336 … P-347 | Env select, tabs, QR stepper, credentials + guard, poll, Limited note |
| Y. Attach-maFile modal | P-348 … P-349 | Upgrade Limited→Full |
| Z. CSFloat workspace modal | P-350 … P-384 | Tabs, dashboard/listings/market/buy-orders/trades/inventory/settings, all buy/list/delist/order actions |
| AA. SDA overview modal | P-385 … P-401 | OTP roll + copy, countdown bar, confirmations list, approve single/selected/all |
| AB. Clean-browser action | P-402 … P-402 | Isolated proxied ephemeral session |
| AC. Environment modal | P-403 … P-407 | Create/edit (real proxy reveal), submit, delete |
| AD. Folder create/rename/delete/reorder | P-408 … P-411 | Folder modal, submit, delete (contents move up), reorder |
| AE. Move-account modal | P-412 … P-415 | Single/batch move, populate folders, submit, batch delete |
| AF. Ban-Checker modal | P-416 … P-425 | Job+poll, summary chips, accordions, tags, move-category, account/folder triggers |
| AG. Send-Trade modal (single + mass) | P-426 … P-437 | Target toggle, recipient picker, submit single/mass, progress/poll, failure surfacing |
| AH. End-Task (cooperative cancel) | P-438 … P-440 | Confirmed cancel, reset, wired buttons |
| AI. Market-Sell modal (mass-sell) | P-441 … P-451 | Strategy radios, preview, submit, progress/poll |
| AJ. Bulk-Import modal | P-452 … P-460 | Vault / CSV / maFiles methods, folder dest, submit, skip reasons |
| AK. Market-Buy modal + toolbar utils | P-461 … P-476 | Wallet resolvers, Max, market-price fetch, live search, submit (funds check), result |
| AL. Folder Mass-Buy modal | P-477 … P-483 | Open, search, price fetch, submit (confirm), progress/poll, results |
| AM. Trade-Ups feature modal | P-484 … P-491 | Scan, candidate list, execute (GC-unverified honesty), exec poll |
| AN. Storage-Units (Casket) feature modal | P-492 … P-500 | Unit select, two-panel deposit/withdraw, storable gate, move + poll |
| AO. Toasts / feedback infrastructure | P-501 … P-507 | Stacking toasts, dedupe, TTL, Undo, keep-alive, Live-Logs launcher |
| AP. Confirm dialog + modal infra + boot | P-508 … P-522 | ssimConfirm, overlay registry, open/close lifecycle, focus-trap, sidebar resize, license gate, splash |
| AQ. Shared formatting / security / poller helpers | P-523 … P-533 | escape/safeIconUrl, poller stall guard, money-format family, currency table, static wiring, cross-cutting patterns |

---

## A. Global shell / chrome (static, index.html)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-001 | License client-guard: `<html class="ssim-locked">` hides `<body>` until app.js confirms licensing; else redirects to activation (`html.ssim-locked body{display:none!important}`) | index.html:11–17, 336 | | |
| P-002 | Tailwind Play runtime vendored locally (`/assets/vendor/tailwind.js`); the one "cdn.tailwindcss.com … production" console.warn is filtered, all other warns intact | index.html:24–33 | | |
| P-003 | Tailwind theme: `brand`/`brand-dark`/`brand-light`, re-themed `slate` scale, semantic `success/warn/danger/buy/listed`; tightened radii; `text-2xs/3xs/4xs` (11/10/9px); Inter font | index.html:35–73 | | |
| P-004 | Design-system palette tokens in `:root` (byte-identical to old hex); dark color-scheme forced (`--brand-rgb:147 51 234` = #9333ea) | index.html:93–111 | | |
| P-005 | Body aurora background (2 radial violet gradients, fixed attachment); custom 6px scrollbars; violet `::selection` | index.html:115–127 | | |
| P-006 | Sidebar resize handle hover/drag styling: grip brightens; `body.resizing-x` locks cursor+selection (drag to resize · double-click to reset) | index.html:129–132, 484–491 | | |
| P-007 | Animations: `.fade-in` (0.25s), `.cs2-spin` (0.7s spinner), skeleton shimmer `.skel` (static under reduced-motion) | index.html:134–144 | | |
| P-008 | Startup splash `#ssim-splash`: purple bloom + Santer diamond stroke-draw, fades out ≤1.2s; gated by sessionStorage; hidden under reduced-motion; z-[70] | index.html:146–186, 338–357 | | |
| P-009 | Micro-interactions: buttons press down on `:active`; inputs glow; hover border on fields | index.html:188–192 | | |
| P-010 | Visible `:focus-visible` ring (2px brand) on interactive elements; fields keep own violet ring (A11Y-02) | index.html:194–198 | | |
| P-011 | Filled-button top-light + depth for brand/emerald/teal/rose (DS-04) | index.html:200–206 | | |
| P-012 | Items table framed surface; non-sticky header; violet row hover (`brand/.06`); item-icon drop shadow | index.html:208–220 | | |
| P-013 | Render virtualization: `content-visibility:auto` on `#items-body tr` (intrinsic 52px) and `.account-row` (56px); keeps full DOM (TBL-02) | index.html:222–228 | | |
| P-014 | Toolbars wrap gracefully in narrow window: `#stat-bar`, `#toolbar`, `#main-header` flex-wrap | index.html:230–245 | | |
| P-015 | KPI stat cards: hairline gradient top accent via `--stat-accent` | index.html:247–253 | | |
| P-016 | Env tiles: lift + violet glow on hover | index.html:255–260 | | done · app.js:1349 (.env-tile) |
| P-017 | Hybrid glass: every `div[id$="-overlay"] > div` modal card = translucent blurred glass + elevation; sticky modal sub-headers match glass (DS-04) | index.html:262–276 | | |
| P-018 | Sidebar depth gradient + active-row left indicator bar (`.account-btn.is-active::before`) | index.html:278–284 | | |
| P-019 | `.frosted` blur for headers above scroll | index.html:286–287 | | |
| P-020 | History chart color classes (SVG can't read `var()`): grid/ylabel/axis/line-items/line-wallet/dots | index.html:289–298 | | |
| P-021 | Status chip classes (`.chip--success/warn/danger/listed/buy/neutral`) + `aria-pressed=true` active look (DS-03) | index.html:300–312 | | |
| P-022 | Multi-select checkbox rests at low opacity, full on hover/focus/check | index.html:314–317 | | |
| P-023 | CSS-only hover info tooltip (`.ssim-tip` → `.ssim-tip-bubble`, 300px bubble w/ arrow) | index.html:319–332 | | |
| P-024 | Keep-alive ping: `fetch('/api/app/ping')` on load + every 4000ms (legacy Edge heartbeat) | index.html:1509–1515 | | |
| P-025 | "◳ Live Logs" floating launcher button (JS-created, fixed bottom-left `left:18px bottom:18px z-index:30`, violet gradient); click opens `/logs.html` popup AND POSTs `/api/app/open-logs` (S68 layering fix) | index.html:1516–1550 | | |

---

## B. Sidebar (chrome + tree)

### B.1 Sidebar chrome (static structure + render logic)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-026 | Brand header: logo (`/assets/logo.png`), "SSIM" title, "Santer Steam Inventory Manager" subtitle | index.html:362–370 | | |
| P-027 | Context-nav "All environments" back button (`#btn-back-dashboard`, hidden on dashboard) → `showDashboard()` | index.html:373–379; app.js:1192, 1213–1220 | | |
| P-028 | Env-context panel (shown only inside an env): env name + proxy line (`Local IP (no proxy)` when none) | index.html:382–386; app.js:1197–1200 | | |
| P-029 | "Master (environment)" button `#btn-env-master` → `selectEnvMaster()`; gets ring when active | index.html:387–390; app.js:1201–1202, 1244–1251 | | |
| P-030 | "Account" add button `#btn-add-account` (opens add-account modal) | index.html:393–396 | | |
| P-031 | "Create new folder" button `#btn-add-folder` (folder-plus) | index.html:398–401 | | |
| P-032 | "Refresh all" button `#btn-refresh-all` | index.html:403–407 | | |
| P-033 | Refresh-All progress panel `#refresh-progress`: label + count (mono), progress bar `#refresh-bar` (brand, width%), "End task" button `#refresh-end` (rose, stop icon); shows in Global-Master too | index.html:411–422 | | |
| P-034 | Failed-accounts panel `#refresh-failed` (amber, max-h-40 scroll): lists WHICH account failed + WHY, persists until dismissed or next refresh; `#refresh-failed-close` hide button | index.html:426–437 | | |
| P-035 | "Accounts" label + `#account-count` (mono); count = visibleAccounts via `fmtCount` | index.html:439–442; app.js:1521 | | |
| P-036 | Account search box `#account-search` (magnifier icon, "Search accounts…") | index.html:445–450 | | |
| P-037 | Quick inventory filter `#account-filter`: All accounts / Has items / Empty inventory | index.html:452–457; app.js:1392–1399 | | |
| P-038 | Account sort `#account-sort`: Default order / Balance High→Low / Balance Low→High (tooltip "Sort accounts by wallet balance") | index.html:458–463; app.js:1411–1420, 1464–1466 | | |
| P-039 | Account list `#account-list` (overflow-y scroll) | index.html:467 | | |
| P-040 | Show/Hide-hidden toggle `#btn-toggle-hidden`: "Show N hidden" / "Hide hidden" (only when hiddenCount>0); eye / eye-slash icons | index.html:469–471; app.js:1541–1550 | | |
| P-041 | Footer: pulsing emerald dot + `#footer-status` version (mono, filled from API — single source) | index.html:473–480 | | |

### B.2 Sidebar tree — folder nodes (app.js render)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-042 | Folder node: chevron toggle (collapse/expand), folder/folder-open icon, name (click → folder-master), subtree count (mono); indentation `8 + depth*14`px | app.js:1432–1458 | | ✅ done · app.js:1430–1461 (DS folder header, .row-actions) |
| P-043 | Folder name click → `openFolderMaster(id)`; active folder text = brand | app.js:1444–1445, 1570, 1949–1957 | | ✅ done · app.js:1442 (data-folder, text-brand-light active) |
| P-044 | Move folder **up** arrow (disabled if first, hover-reveal) → `reorderFolder(id,'up')` | app.js:1447–1448, 1559 | | ✅ done · app.js:1445 (data-folderup, btn-icon-sm) |
| P-045 | Move folder **down** arrow (disabled if last) → `reorderFolder(id,'down')` | app.js:1449–1450, 1560 | | ✅ done · app.js:1447 (data-folderdown) |
| P-046 | Folder "Check bans for all accounts in this folder" shield → `checkFolderBans(id)` | app.js:1451, 1564 | | ✅ done · app.js:1449 (data-banfolder) |
| P-047 | "Create subfolder" folder-plus → `openFolderModal({mode:'create',parentId})` | app.js:1452, 1561 | | ✅ done · app.js:1450 (data-addsub) |
| P-048 | "Rename" pen → `openFolderModal({mode:'rename',id,name})` | app.js:1453, 1562 | | ✅ done · app.js:1451 (data-rename, data-name) |
| P-049 | "Delete folder (contents move up)" trash → `deleteFolder(id,name)` | app.js:1454, 1563 | | ✅ done · app.js:1452 (data-delfolder, danger icon) |
| P-050 | Folder collapse state persisted in localStorage (`cs2.collapsed`) via `toggleFolder` | app.js:52–56, 1658–1662 | | ✅ done · app.js:1657 (unchanged; toggle re-skinned) |

### B.3 Sidebar tree — account rows (app.js render)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-051 | Account row: multi-select checkbox `[data-selacct]` (low opacity until hover/check) → `toggleAccountSelect` | app.js:1486–1489, 1574–1577, 1609–1615 | | ✅ done · app.js:1485 (data-selacct, .acct-check opacity-40) |
| P-052 | Account button: user icon + displayName (or username) + username subline; active row = brand ring + `is-active`; click → `selectAccount(username)` | app.js:1490–1503, 1470–1471 | | ✅ done · app.js:1488–1500 (.account-btn.is-active, .avatar) |
| P-053 | "LTD" badge when `canConfirm===false` (no identity_secret, amber): tooltip explains buy/cancel work, sell/trade need maFile | app.js:1499 | | ✅ done · app.js:1497 (.pill pill--ltd) |
| P-054 | Per-account balance chip `.acct-balance`: STRICT states — real wallet → value (incl 0); refreshed+no wallet → `0,00` in fleet currency; never refreshed → `—`; fades out on row hover (`fmtWallet`/`fmtMoneyMinor(0,fleetCurrency())`) | app.js:1475–1500, 1581–1594 | | ✅ done · app.js:1473–1498, 1581–1594 (tri-state verbatim) |
| P-055 | Hover action: **Edit** account pen → `openEditAccount(username)` | app.js:1505–1506, 1569 | | ✅ done · app.js:1503 (data-edit, .edit-btn) |
| P-056 | Hover action: **Move** folder-tree → `openMoveModal(username)` | app.js:1507–1508, 1568 | | ✅ done · app.js:1505 (data-move, .move-btn) |
| P-057 | Hover action: **Check bans** shield → `checkAccountBans(username)` | app.js:1509–1510, 1565 | | ✅ done · app.js:1507 (data-bancheck, .bancheck-btn) |
| P-058 | Hover action: **Hide/Show** eye/eye-slash → `toggleHide(username,isHidden)` | app.js:1511–1513, 1567 | | ✅ done · app.js:1509 (data-hide, data-hidden, .hide-btn) |
| P-059 | Hover action: **Attach maFile** (only when `canConfirm===false`, emerald shield) → `openAttachMaFile(username)` | app.js:1514–1515, 1566 | | ✅ done · app.js:1512 (data-attach, .attach-btn success icon) |
| P-060 | Search/quick-filter switches sidebar to FLAT cross-folder list; balance-sort alone keeps tree & only reorders within folders; empty → "No matching accounts." | app.js:1526–1537, 1460–1468 | | ✅ done · app.js:1524–1537 (unchanged; empty re-skinned) |
| P-061 | Empty list fallback: "No accounts." | app.js:1538 | | ✅ done · app.js:1536 (t12 text-slate-600) |
| P-062 | ONE delegated click/change listener per container (no per-row rebinding) via `setupDelegation` (PERF-01) | app.js:1553–1604 | | ✅ done · app.js:1554–1602 (delegation untouched) |
| P-063 | `patchSidebarBalances()`: updates only balance chips (no rebuild, scroll preserved) | app.js:1579–1595 | | ✅ done · app.js:1579–1593 (chip-only patch untouched) |

---

## C. Multi-select (account checkbox) behavior

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-064 | Any ticked account ⇒ auto-enter "Selection Master" (live-aggregated); all unticked ⇒ restore exact prior view (`preSelection` snapshot) via `syncSelectionView` | app.js:1606–1643 | | ✅ done · app.js:1618–1641 (logic untouched; row checkbox re-skinned) |
| P-065 | "Select all" — ticks every account in active env, shows master | app.js:1645–1650, 2054 | | ✅ done · app.js:1644–1648 (selectAllAccounts untouched) |
| P-066 | "Clear" — unticks all, reverts to pre-selection view | app.js:1652–1656, 2055 | | ✅ done · app.js:1651–1654 (clearSelectionAndRevert untouched) |

---

## D. Screen navigation / view modes

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-067 | Two screens: `#screen-dashboard` / `#screen-inventory` toggled by `showScreen(name)`; leaving inventory unmounts window scroll listener | app.js:1181–1187 | | |
| P-068 | 6 inventory view modes: `account` / `env-master` / `global` / `folder` / `selection`; dispatched by `renderMain()` | app.js:7–9, 1711–1732 | | |
| P-069 | `updateSidebar()` shows/hides context nav, env-context, accounts label/tools based on in-env state | app.js:1189–1211 | | |
| P-070 | `showDashboard()` resets to account mode, clears selections | app.js:1213–1220 | | |
| P-071 | `enterEnvironment(envId)` → env-master mode, loads tree, resets search/sort/selection; toasts err on tree fail | app.js:1222–1231 | | |
| P-072 | `showGlobalMaster()` → global mode; auto-selects ALL envs into `globalEnvs` on first entry | app.js:1233–1242 | | |
| P-073 | `selectEnvMaster()` → env-master mode | app.js:1244–1251 | | |

---

## E. Dashboard (environments)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-074 | Header title "Environments" + subtitle "Choose a farm environment or create a new one." | index.html:498–502 | | done · index.html:703–704 |
| P-075 | "Global Master" button `#btn-global-master` (globe, in dashboard header) → global-master view | index.html:504–507; app.js:1233 | | done · index.html:707–709 |
| P-076 | "Account Login" button `#btn-account-login` → QR/credentials import modal (Feature 1) | index.html:508–511 | | done · index.html:710–712 |
| P-077 | "Import bots" button `#btn-bulk-import` → bulk-import modal | index.html:512–515 | | done · index.html:713–715 |
| P-078 | "New environment" button `#btn-new-env` → env modal (create) | index.html:516–519 | | done · index.html:716–718 |
| P-079 | Env tiles grid `#env-tiles` (responsive 1/2/3 col) | index.html:522–523; app.js:1273–1285 | | done · index.html:722; app.js:1273–1285 |
| P-080 | Empty state `#env-empty`: "No environments yet" / "Create your first farm environment." (shown when 0 envs) | index.html:524–530; app.js:1275 | | done · index.html:723–727; app.js:1275 |
| P-081 | Env tile: layer-group icon, Proxy/Local-IP pill, name, proxy line (mono), account **count** (`fmtCount`), last-updated ago; click tile → enter env | app.js:1342–1381, 1257–1271 | | done · app.js:1345–1382 (.env-tile re-skin) |
| P-082 | Env tile "Test proxy" button `[data-proxy-test]` → `checkProxy()` | app.js:1367–1369, 1283–1284, 1287–1315 | | done · app.js:1374, 1283–1284 |
| P-083 | Proxy test states: spinner "Testing…/running…"; green `✓ IP · CC (Country) · N ms`; red `✗ error` (via `/check-proxy`) | app.js:1288–1315 | | done · app.js:1288–1315 (logic unchanged) |
| P-084 | Env tile hover actions: **Edit** pen → `openEnvModal('edit',id)`; **Delete** trash → `deleteEnvironment(id,name)` | app.js:1372–1379, 1279–1282 | | done · app.js:1352–1356 (.env-tile__actions), 1279–1282 |
| P-085 | Last-updated formatting: `just now` / `N min ago` / `N h ago` / `N d ago` / `never loaded` (`formatAgo`) | app.js:1265–1271, 1364 | | done · app.js:1265–1271, 1371 |

---

## F. Inventory header & stat bar (static + logic)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-086 | Breadcrumb `#breadcrumb`: truthful across all view modes, clickable segments (Environments › Env › Folder/Multi-Select › Account) (NAV-01) | index.html:537; app.js:1668–1709 | | ✅ done · app.js:1695–1704 (masterpiece spine: chevron separators + brand-light active; data-bc hooks unchanged) |
| P-087 | Breadcrumb nav actions: `dash`→showDashboard, `env`→selectEnvMaster, `folder`→openFolderMaster | app.js:1703–1708 | | ✅ done · app.js:1705–1710 (logic unchanged) |
| P-088 | Main header `#main-header` (per-view content) | index.html:538 | | ✅ done · index.html:734 (shell) + V4/V5 per-view headers |
| P-089 | Stat card **Items** `#stat-items` (brand accent, label overridable) | index.html:542–545 | | ✅ done · index.html:739–741 (.stat-card shell) |
| P-090 | Stat card **Trade-Locked** `#stat-locked` (amber/warn accent, label overridable) | index.html:546–551 | | ✅ done · index.html:742–744 (.stat-card shell) |
| P-091 | Stat card **Item value** `#stat-value` (brand-light, compact w/ exact on hover) | index.html:552–555; app.js:1122–1128 | | ✅ done · index.html:745–747 (.stat-card) + app.js:1125–1152 (setMoneyStats unchanged) |
| P-092 | Stat card **Balance** `#stat-wallet` (emerald, compact w/ exact on hover) | index.html:556–559; app.js:1125–1128 | | ✅ done · index.html:748–750 (.stat-card) + app.js setMoneyStats (tri-state unchanged) |
| P-093 | Game toggle CS2 ↔ TF2 (`#btn-game-cs2`/`#btn-game-tf2`) → `setGame`; active = brand fill; TF2 lazy-loads on first toggle | index.html:562–566; app.js:528–535, 559–564 | | ✅ done · index.html:762 (.seg control) + app.js:559–564 (updateGameToggle toggles .is-on; ids+setGame unchanged) |
| P-094 | "Buy" button `#btn-buy-market` (cart) → market-buy modal | index.html:567–570 | 💰 | ✅ done · index.html:766 (.btn btn-buy; handler unchanged) |
| P-095 | Price-source split control: `#src-btn` (Steam⟷CSFloat) w/ dropdown `#src-menu` (Steam Market / CSFloat); logo swaps | index.html:571–581; app.js:784–808 | | ✅ done · index.html:770–782 (DS-tokened custom split kept for dropdown contract; #src-logo/#src-menu/data-src unchanged) |
| P-096 | Currency split control: `#cur-btn` (USD⟷EUR) w/ dropdown `#cur-menu` (USD ($) / EUR (€)) | index.html:583–591; app.js:761–782 | | ✅ done · index.html:784–791 (DS-tokened; #cur-menu/data-cur unchanged) |
| P-097 | Currency button tooltip surfaces FX provenance: fallback-rate / stale (>36h) warning (C20/INV-E5) | app.js:767–782 | | ✅ done · app.js (logic unchanged) |
| P-098 | "Refresh" button `#btn-load` (assembles complete inventory: owned+locked+listed) | index.html:593–599; app.js:2142–2144 | | ✅ done · index.html:796 (.btn bg-brand; handler unchanged) |
| P-099 | Global-master env-filter container `#global-filter` (shown only in global mode) | index.html:605; app.js:1717 | | ✅ done · index.html:805 (shell) + V5 renderGlobalFilter |
| P-100 | Value-history chart wrap `#history-wrap` (chart-line header + legend + `#history-chart`) | index.html:607–616 | | ✅ done · index.html:809–817 (.card-rich shell; chart re-skin = V7) |
| P-101 | Item search box `#search-input` ("Search items…") | index.html:620–625 | | ✅ done · index.html:823 (.field shell) |
| P-102 | Value-filter `#value-filter`: "Select under" + currency-prefixed number input `#value-filter-input` + "Select" button → bulk-select items under threshold (account+folder views) | index.html:626–638 | 💰 | ✅ done · index.html:826–835 (.field + .btn btn-secondary btn-sm shell) |
| P-103 | Selection bar `#selection-bar`: `#selection-count`, "Clear selection", "Sell on market" `#btn-sell-selected`, "Send selected items" `#btn-send-selected` | index.html:639–653 | 💰 | ✅ done · index.html:837–845 (.btn btn-sell/bg-brand btn-sm shell; handlers unchanged) |
| P-104 | Empty state `#empty-state`: "No inventory loaded yet" / 'Select an account and click "Refresh".' (boxes-stacked icon) | index.html:656–662 | | ✅ done · index.html (.empty shell) |
| P-105 | Faceted filter chips bar `#facet-bar` (re-shown by renderTable) (TBL-03) | index.html:664–665; app.js:1725 | | ✅ done · index.html (shell) + V4 renderFacetBar |
| P-106 | GC 3-category filter pills `#gc-cat-tabs` (only for GC-fetched inventories) | index.html:667–668; app.js:1724 | | ✅ done · V4 renderAccountTabs (.chip aria-pressed) |
| P-107 | Items table `#items-wrap` (thead `#items-head`, tbody `#items-body`) + `#search-empty` "No items for this search." | index.html:670–679 | | ✅ done · index.html (.items-wrap/.items-table) + V4 |
| P-108 | Active-Orders view container `#orders-wrap` | index.html:681–682 | | ✅ done · index.html (shell; orders re-skin = V8) |
| P-109 | Live-pull indicator `#inv-loading`: spinner "Loading inventory live from Steam…" / "Owner view · reading trade locks" | index.html:684–689 | | ✅ done · index.html (shell) |

---

## G. Game toggle / inventory ingestion logic

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-110 | `setGame(game)`: clears selection, updates toggle, lazy-loads TF2 on first switch, re-renders | app.js:528–535 | | |
| P-111 | TF2 key counting: counts `Mann Co. Supply Crate Key` stacks (`countTf2Keys`) | app.js:515–522 | | |
| P-112 | `currentAppId()` = 440 (TF2) / 730 (CS2) — drives app-agnostic send | app.js:524–526 | | |
| P-113 | Failed cold TF2 fetch → records `tf2LoadError`, renders distinct error+Retry panel (never empty inventory) (H-FE-001) | app.js:537–557, 1714–1716, 1734–1764 | | |
| P-114 | `loadTf2Inventories()` on success starts price-fill watch (S29) | app.js:542–556 | | |
| P-115 | `reloadAll()`: parallel fetch environments + accounts + inventory + exchange-rate; records FX fallback/age provenance | app.js:566–583 | | |
| P-116 | GLOBAL wallet store `rememberWallet`: newest wallet (by fetchedAt) wins across CS2/TF2 so balance never clobbered by staler game-cache | app.js:585–598 | | |
| P-117 | `wasRefreshed(u)`: distinguishes "refreshed empty" (→0) from "never fetched" (→—) | app.js:600–609 | | |
| P-118 | `refreshActiveViewFromCache()`: re-pulls cache after a mass op (buy/sell/trade), invalidates history, re-renders main+sidebar (no re-login) | app.js:611–634 | | |
| P-119 | `invFor(u)`: active-game inventory lookup w/ lowercase-key normalize | app.js:506–512 | | |

---

## H. Money / currency formatting rules

| # | Formatting rule (exact) | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-120 | `fmtUsd(usdMajor)`: null/NaN→`—`; EUR = `usdMajor*usdToEur`; symbol `€`/`$`; locale de-DE (EUR) / en-US (USD); 2 fraction digits → `€1.234,56` / `$1,234.56` (ST-02) | app.js:638–645 | 💰 | |
| P-121 | `fmtCents(cents)` = cents/100 → fmtUsd; null→`—` | app.js:647 | 💰 | |
| P-122 | `fmtEurCents(cents)`: `€` + de-DE 2-digit (no FX; market-sell already EUR) | app.js:649–652 | 💰 | |
| P-123 | `walletToUsd(w)`: USD(1)→balance; EUR(3)→balance/usdToEur; 0 stays 0; unknown non-zero currency→null | app.js:653–662 | 💰 | |
| P-124 | `fleetCurrency()`: most-common wallet currency across accounts (fallback EUR=3) for empty-wallet display | app.js:663–677 | | |
| P-125 | `stackValueCents(item)` = price × quantity (0 unpriced) | app.js:678–679 | 💰 | |
| P-126 | `worthCentsForAccounts()`: SINGLE worth source = Σ backend `inv.totalValueUsd` (C19/INV-E3) | app.js:681–689 | 💰 | |
| P-127 | `STEAM_CURRENCIES` map (code→ISO+decimals, 46 currencies) + `curInfo` | app.js:691–705 | | |
| P-128 | `CURRENCY_LOCALE` per-ISO locale override (USD→en-US, JPY→ja-JP, …); default de-DE (ST-02) | app.js:706–716 | | |
| P-129 | `fmtMoneyMinor(minor,code)`: Intl.NumberFormat currency style, per-currency locale+decimals; fallback to number+ISO | app.js:717–726 | 💰 | |
| P-130 | `fmtWallet(w)`: STRICT — balance null/undefined/'' → `—`; real 0 → `0,00`; else localized native | app.js:729–738 | 💰 | |
| P-131 | `normalizeMajor`/`parseMajorToMinor`: parse typed "2,15"/"1.500,00"; disambiguate decimal-vs-grouping; never over-parse | app.js:739–759 | 💰 | |
| P-132 | `fmtCount(n)`: thousands-grouped in display-currency locale (12,480 / 12.480) | app.js:1130–1136 | | |
| P-133 | `fmtCompactCount(n)`: grouped-exact <1M, "1.2M" above | app.js:1137–1143 | | |
| P-134 | `fmtUsdCompact`: cents precision <100k, "€1.2M" above | app.js:1144–1152 | 💰 | |
| P-135 | `setCountStat(elem,n)`: compact text + exact grouped on hover (title) | app.js:1153–1160 | | |
| P-136 | `setMoneyStats(valueCents,walletUsd)`: compact display + exact `title`; null→`—` | app.js:1122–1128 | 💰 | |
| P-137 | `setCurrency(cur)`: persists `ssim.currency`, updates buttons, re-renders (localStorage) | app.js:761–766 | | |

---

## I. Price source / price-fill watch / stale states

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-138 | `setPriceSource(src)`: PUT `/api/pricing/source`; respects backend "effective" (falls back to Steam if no CSFloat key); toast; reload+repull; persists `ssim.priceSource` | app.js:791–808 | 💰 | |
| P-139 | Toast (source): success "Price source: X — re-pricing…"; error "No CSFloat API key found — pricing from Steam…" | app.js:800–801 | | |
| P-140 | `updatePriceSourceButton()`: label + logo swap Steam/CSFloat | app.js:786–790 | | |
| P-141 | `formatFillEta(left)`: "~Ns left" (<90s) / "~N min left" (<90m) / "~N.N h left" (3500ms/name) | app.js:850–861 | | |
| P-142 | `priceFillIndicator(status)`: show if running or queued>0; "long" hint if >200 left | app.js:863–870 | | |
| P-143 | Floating "Fetching prices…" badge `#price-fill-indicator` (fixed bottom-4 right-4 z-40): `N left · N done · ~eta · (large inventory)`; spinner tag; hover explains single-IP throttle; auto-hides on drain | app.js:871–892 | | |
| P-144 | `watchPriceFill(repull)`: polls `/api/pricing/status` every 2500ms; re-pulls whole fleet when `fetched` advances (coalesced ≥10s); drains-then-stops; 15-min no-progress safety stop; 24-consec-error dead-backend stop; token supersession (S10/S19/S42) | app.js:894–943, 826–843 | | |
| P-145 | `pollRepricing()`: after source switch, watch fill + live-update | app.js:1120–1121 | | |

---

## J. System-status poll + additive indicators (30s loop)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-146 | `watchSystemStatus()`: polls `/api/system/status` every 30000ms; launched once from init | app.js:1089–1118 | | |
| P-147 | Runtime license revocation: `st.licensed===false` → `window.location.replace('/')` (activation screen) (H-LIC-008, strict ===) | app.js:1096–1100 | | |
| P-148 | Update indicator badge `#update-indicator` (bottom-left z-40): "Update vX available — click to install" or blocked variant; click → confirm+install | app.js:984–1006 | 💰 | |
| P-149 | Update install flow `confirmAndInstallUpdate()`: ssimConfirm "Install & restart"; then `triggerUpdate(true)` (S61 confirm-before-install) | app.js:955–982 | 💰 | |
| P-150 | `triggerUpdate(install)`: POST `/api/app/check-update`; toasts "Installing update…", "Update vX available…", "You're on the latest version." | app.js:954–967 | 💰 | |
| P-151 | Post-install reconcile: if install ended without swap, clear "installing…", re-show badge, toast outcome (S34) | app.js:1105–1109 | | |
| P-152 | Breaker indicator `#breaker-indicator` (top-center rose z-50): "Money operations paused. {reason} — restart SSIM before more trades/buys." when `moneyOpsStable===false` (B3) | app.js:1008–1022 | 💰 | |
| P-153 | Token-store warning `#tokenstore-warning` (amber): "Refresh-token store is corrupt. …restore refresh_tokens.json from .bak…" | app.js:1024–1038 | | |
| P-154 | CSFloat key-store warning `#csfloatkeystore-warning` (amber): "CSFloat key store is corrupt. …restore csfloat_keys.json…" | app.js:1040–1054 | | |
| P-155 | Crash banner `#crash-banner` (top-right amber, dismissible ✕): "SSIM's backend crashed last run ({time}, code N)…" (B1, render once) | app.js:1056–1072 | | |
| P-156 | Capability banner `#capability-banner` (top-center rose): "This session lost its authorization… Fully restart SSIM…" on 401 capabilityRequired (S1) | app.js:1074–1087, 471 | | |

---

## K. Capability token / API layer

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-157 | `capToken()`: reads `window.__SSIM_CAP__`, persists to sessionStorage (survives reload), per-origin (S1/B26) | app.js:415–429 | | |
| P-158 | `api()` sends `X-SSIM-Cap` header; mutating methods await token (≤3s); reads never block | app.js:430–475 | | |
| P-159 | Every call bounded by client timeout (default 120000ms); AbortError → "The request timed out — the backend may be busy…" (S32) | app.js:448–463 | | |
| P-160 | Global UI error handlers: `window.onerror`/`unhandledrejection` → toast + POST `/api/app/client-error`; coalesced 1/sec (S30) | app.js:477–504 | | |

---

## L. Value-history chart

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-161 | `loadHistory(seriesId)`: 10s-TTL cache; global mode aggregates selected envs (POST `/api/history/aggregate`); else GET `/api/history/{id}?game=`; async race guard by cache key + game | app.js:1780–1821 | | ✅ done · app.js (logic unchanged) |
| P-162 | `invalidateHistory()` on refresh complete | app.js:1823–1824, 630 | | ✅ done · app.js (logic unchanged) |
| P-163 | Dual-line SVG chart: Items worth (brand) + Balance (emerald); shared money Y-axis (USD cents); area fill under items; last-point dots; dependency-free | app.js:1826–1901 | 💰 | ✅ done · app.js:1834–1902 (SVG uses .hist-* DS classes + --brand/--success tokens; shared-scale math + dots + area unchanged) |
| P-164 | <2 points → "Not enough data points yet – the curve grows with the next refresh." | app.js:1835–1839 | | ✅ done · app.js:1837–1841 (neutral DS message; unchanged) |
| P-165 | Partial-wallet series: emerald line dashed + "(incomplete)" legend note w/ tooltip | app.js:1834, 1894, 1906 | | ✅ done · app.js:1836, 1896, 1913 (partial dashing + honesty marker preserved verbatim) |
| P-166 | X-axis time labels: same-day → `HH:mm`; cross-day → `DD/MM HH:mm` (English, 24h) | app.js:1864–1870 | | ✅ done · app.js:1866–1873 (de-DE→en-GB axis; invariant 8 English-only / P4-align) |
| P-167 | Y-axis labels via `fmtCents`; grid lines at 25/50/75% | app.js:1873–1877 | 💰 | ✅ done · app.js:1877–1881 (unchanged) |
| P-168 | Legend: bar-swatch markers + "Items worth {fmtCents} · Balance {fmtCents} · N points" | app.js:1902–1907 | 💰 | ✅ done · app.js:1910–1915 (masterpiece bar swatches matching line colors; fmtCents + point count unchanged) |

---

## M. Folder-Master view

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-169 | `openFolderMaster(folderId)` → folder mode, resets search/sort/selection | app.js:1949–1957 | | ✅ done · app.js:1950–1958 (logic unchanged) |
| P-170 | Aggregates every asset across folder accounts (1:1 w/ single views); tracks quantity/sendable/owners; O(1) index (`aggregateWithOwners`) | app.js:1919–1947, 1959–1964 | | ✅ done · app.js:1961–1965 (logic unchanged) |
| P-171 | Header: name + "Folder-Master" pill; "N account(s) · aggregated 1:1…" | app.js:1967–1974 | | ✅ done · app.js:1966–1982 (icon-less title + .pill pill--brand; decorative fa dropped per masterpiece) |
| P-172 | "Mass Buy" button → `openFolderBuy(name,usernames)` | app.js:1976–1977, 1984–1985 | 💰 | ✅ done · app.js:1977 (.btn btn-buy btn-sm; id+handler untouched) |
| P-173 | "Check Bans" button → `openBanChecker(usernames,name)` | app.js:1978–1979, 1986–1987 | | ✅ done · app.js:1978 (.btn btn-secondary btn-sm) |
| P-174 | "Refresh folder" button → `refreshFolder(usernames)` | app.js:1980, 1982–1983 | | ✅ done · app.js:1979 (.btn btn-secondary btn-sm; id+handler untouched) |
| P-175 | Stats relabeled: Items→"Sendable items", Trade-Locked→"Bots"; value = worthCentsForAccounts; wallet = Σ walletToUsd | app.js:1989–1997 | 💰 | ✅ done · app.js:1990–1998 (logic unchanged; DS stat cards in shell) |
| P-176 | Empty: "No tradable items in cache" / 'Click "Refresh folder" to load the bot inventories.' | app.js:1999–2005 | | ✅ done · app.js:2000–2006 (logic unchanged; .empty in shell) |
| P-177 | Renders selectable master table (`renderTable({master,selectable})`) | app.js:2006–2007 | | ✅ done · app.js:2007–2008 (V4 .items-table skin) |

---

## N. Selection-Master (multi-select) view

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-178 | `renderSelectionMaster()`: aggregates hand-picked accounts; falls back to env-master if empty | app.js:2013–2023 | | ✅ done · app.js:2019–2023 (logic unchanged) |
| P-179 | Header: "Multi-Select" + "N account(s)" pill; inline "Select all" / "Clear" | app.js:2025–2037, 2054–2055 | | ✅ done · app.js:2026–2037 (icon-less title + .pill pill--brand; #sel-all/#sel-clear-all preserved) |
| P-180 | "Mass Buy" → openFolderBuy(`N selected account(s)`) | app.js:2039–2040, 2050 | 💰 | ✅ done · app.js:2040 (.btn btn-buy btn-sm; id+handler untouched) |
| P-181 | "Refresh selected" → refreshFolder | app.js:2041, 2049 | | ✅ done · app.js:2041 (.btn btn-secondary btn-sm) |
| P-182 | "Move Selected" → openMoveModal(usernames array) | app.js:2042–2043, 2051 | | ✅ done · app.js:2042 (.btn btn-secondary btn-sm; id+handler untouched) |
| P-183 | "Check Bans" → openBanChecker(usernames,`N selected`) | app.js:2044–2045, 2052 | | ✅ done · app.js:2043 (.btn btn-secondary btn-sm) |
| P-184 | "Delete Selected" → batchDeleteAccounts(usernames); maFiles kept | app.js:2046–2047, 2053 | 💰 | ✅ done · app.js:2044 (.btn btn-danger btn-sm; id+handler untouched) |
| P-185 | Stats + empty state mirror folder-master ("Refresh selected") | app.js:2057–2075 | | ✅ done · app.js:2053–2071 (logic unchanged) |

---

## O. Account view (single account)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-186 | `renderAccountView()`: header = displayName + Proxy/Local-IP pill + username (mono); placeholder if none | app.js:2079–2094, 2081 | | done · app.js:2080–2100 (.pill header + Full/LTD tier pill re-skin) |
| P-187 | Trade-link render/bind (`renderTradeLink`/`bindTradeLink`) | app.js:2096, 2124 | | done · app.js:2101, 2124; renderTradeLink 2863–2874 (.btn btn-secondary) |
| P-188 | "Check Bans" button → `checkAccountBans(username)` | app.js:2097–2099, 2125–2126 | | done · app.js:2102–2103, 2125–2126 (.btn btn-secondary btn-sm) |
| P-189 | "Logs" button → `openAccountLogs(username)` | app.js:2100–2102, 2127–2128 | | done · app.js:2104–2105, 2127–2128 |
| P-190 | "Trade-Ups" button (amber) → `openTradeUpModal(username)` | app.js:2104–2106, 2131–2132 | 💰 | done · app.js:2108–2109, 2131–2132 (.btn btn-secondary, amber icon) |
| P-191 | "Storage" (caskets) button (sky) → `openCasketModal(username)` | app.js:2107–2109, 2133–2134 | | done · app.js:2110–2111, 2133–2134 (sky icon) |
| P-192 | "Trade Offers" button → `openTradeOffers()` | app.js:2110–2112, 2129–2130 | 💰 | done · app.js:2112–2113, 2129–2130 (.btn btn-primary) |
| P-193 | "CSFloat" button → `openCsFloat(username)` | app.js:2113–2115, 2135–2136 | 💰 | done · app.js:2114–2115, 2135–2136 |
| P-194 | "SDA" button (emerald) → `openSda(username)` (Steam Guard + confirmations) | app.js:2116–2118, 2137–2138 | | done · app.js:2116–2117, 2137–2138 |
| P-195 | "Browser" button (violet) → `openCleanBrowser(btn,username)` (logged-in via linked proxy, ephemeral) | app.js:2119–2122, 2139–2140 | | done · app.js:2118–2120, 2139–2140 |
| P-196 | Refresh button shown+reset (enabled, rotate icon) | app.js:2142–2144 | | done · app.js:2142–2145 (unchanged; #btn-load chrome is V6) |
| P-197 | Warning "not refreshed yet – trade-locked/listed may be missing" only when CS2 & `inv.source!=='gc'` | app.js:2148–2152, 1766–1774 | | done · app.js:2148–2153 (logic unchanged) |
| P-198 | Stat labels: TF2 → "TF2 Items"/"TF2 Keys"; CS2 → "Items"/"Trade-Locked" | app.js:2152 | | done · app.js:2153 (logic unchanged) |
| P-199 | GC-sourced CS2 → category pills; else plain "Items" pill; Active-Orders tab always available (`renderAccountTabs`) | app.js:2154–2159 | | done · app.js:2155–2160; renderAccountTabs 2922–2950 (.chip pills) |
| P-200 | Stats: totalItems, locked/keys, value=`inv.totalValueUsd`, wallet=walletToUsd (0 when refreshed+empty); '—' when no cache | app.js:2161–2173 | 💰 | done · app.js:2162–2174 (tri-state logic unchanged, invariant 1) |
| P-201 | Active-Orders tab → `renderOrdersView(username,appId)` | app.js:2175–2182 | | done · app.js:2176–2183 (logic unchanged) |
| P-202 | Renders selectable table (both games; app-agnostic send) | app.js:2185–2190 | | done · app.js:2186–2191 (logic unchanged) |
| P-203 | Empty: "No TF2 inventory cached yet"/"No inventory in cache yet" + 'Click "Refresh" to load it live.' | app.js:2191–2196 | | done · app.js:2192–2197 (.empty shell, texts unchanged) |

---

## P. Active-Orders view (live sell listings + buy orders)

> Merged: seg1 rows 204–213 (app.js:2205–2309) + seg2 §A rows 1–20 (app.js:2250–2414). Overlap
> deduplicated (app.js ~2250–2309 appeared in both fragments).

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-204 | `renderOrdersView(username,appId)`: fetches GET `/api/market/orders/{username}?appId=`; loading spinner "Loading active orders live from Steam…"; in-flight guard (`stillHere`); always live | app.js:2205–2229 | | ✅ done · app.js:2208–2232 (spinner accent→brand; fetch+stillHere guard+api unchanged) |
| P-205 | Fetch error → shell w/ rose error message in both sections + retry controls | app.js:2218–2225 | | ✅ done · ordersShellHtml (unchanged flow; .surface shell) |
| P-206 | Orders shell: two side-by-side sections (`xl:grid-cols-2`) "Active Buy Orders" (success-green) + "Active Sell Orders" (listed-blue), header + item search `#orders-search` + "Cancel selected (N)" + "Cancel all" + "Refresh", per-section counts | app.js:2231–2254 | 💰 | ✅ done · ordersShellHtml (.surface + .panel-head + .field + .btn btn-sm; all ids + span.font-mono count preserved for removeOrderRow) |
| P-207 | Empty rows: "No active buy orders." / "No active sell orders." | app.js:2259–2261 | | ✅ done · ordersHtml (text unchanged) |
| P-208 | Partial-snapshot banner (amber) when `data.partial`: "Order list may be incomplete (Steam/proxy error during fetch) — refresh to retry." | app.js:2262–2267 | | ✅ done · ordersHtml (amber banner unchanged — pricing honesty) |
| P-209 | Order icon render: 40×32 lazy `<img>` (via `safeIconUrl`), `onerror` hides; placeholder box if no `iconUrl` | app.js:2270–2274 | | ✅ done · orderIcon (unchanged) |
| P-210 | Per-order Cancel button tooltip "Cancel this order on the Steam market" | app.js:2275–2278 | 💰 | ✅ done · cancelBtn (.order-cancel btn btn-sm + danger color; data-cancel-* + inner string preserved) |
| P-211 | Per-order multi-select checkbox (violet `.order-check`) | app.js:2279–2281 | | ✅ done · orderCheck (.order-check unchanged) |
| P-212 | Buy-order row: checkbox, icon, name + `#buyOrderId` (mono), price `fmtMoneyMinor(pricePerItemMinor,currency)`, qty `remaining / total`, Cancel (`data-cancel-buy`) | app.js:2282–2293 | 💰 | ✅ done · buyOrderRow (t13/t10 type scale; data-order-*/price/qty/cancel unchanged) |
| P-213 | Sell-order row: checkbox, icon, name + `#listingId` (mono), price `fmtMoneyMinor`, `qty N`, Cancel (`data-cancel-listing`) | app.js:2294–2303 | 💰 | ✅ done · sellOrderRow (t13/t10; hooks + fmtMoneyMinor unchanged) |
| P-214 | Refresh button (orders view) re-runs `renderOrdersView(username,appId)`; `bindOrdersControls()` wires all controls | app.js:2305–2308 | | ✅ done · bindOrdersControls (logic unchanged) |
| P-215 | Single per-row cancel wiring: listing → `/api/market/cancel-listing`; buy → `/api/market/cancel-buy-order` | app.js:2311–2314 | 💰 | ✅ done · bindOrdersControls (API + wiring unchanged) |
| P-216 | Orders search filter: filters `.order-row` by lowercased item name; hidden rows unchecked; updates sel-count | app.js:2320–2329 | | ✅ done · logic unchanged |
| P-217 | Cancel selected: cancels only checked+visible rows | app.js:2333–2334, 2341–2344 | 💰 | ✅ done · logic unchanged |
| P-218 | Cancel all (filtered): cancels currently-visible/filtered set | app.js:2335–2336, 2345–2348 | 💰 | ✅ done · logic unchanged |
| P-219 | Selection count + disable: `orders-sel-count`; "Cancel selected" disabled when 0 checked | app.js:2349–2353 | | ✅ done · updateOrdersSelCount (unchanged) |
| P-220 | Bulk-cancel confirm modal: `ssimConfirm` tone danger, title "Cancel orders", confirmLabel "Cancel N order(s)" | app.js:2356–2361 | 💰 | ✅ done · bulkCancelOrders ssimConfirm gate UNCHANGED |
| P-221 | Bulk-cancel executes SEQUENTIALLY (anti-rate-limit); per-row spinner; on ok removes row, on fail restores btn | app.js:2362–2379 | 💰 | ✅ done · bulkCancelOrders (unchanged; restore string matches cancelBtn inner) |
| P-222 | Bulk-cancel result toast: `Cancelled OK[, N failed]`, type success or warn | app.js:2380 | | ✅ done · unchanged |
| P-223 | Single-order cancel confirm: tone danger, "Cancel order" / body "Cancel this order on the Steam market?"; toast success/error | app.js:2385–2397 | 💰 | ✅ done · cancelOrder ssimConfirm gate + api UNCHANGED |
| P-224 | Row removal + count/empty upkeep: decrements section count span; when 0 remain shows "No active orders." | app.js:2402–2414 | | ✅ done · removeOrderRow UNCHANGED (relies on rows-list→prev(.panel-head)→span.font-mono, preserved by ordersShellHtml) |

---

## Q. Global Trade-Offers manager (sent + received, two-sided, batch) — `#offers-overlay`

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-225 | Opens for CURRENTLY-SELECTED account only; requires `state.activeUsername` else toast "Select an account first" (warn) | app.js:2424–2433 | | ✅ done · openTradeOffers logic unchanged |
| P-226 | Scope pill shows displayName/username; search reset on open | app.js:2429–2430 | | ✅ done · #offers-scope now .pill pill--brand; text set by unchanged JS |
| P-227 | Close manager hides overlay | app.js:2434 | | ✅ done · logic unchanged |
| P-228 | Loading state (both panes): spinner + "Loading offers live from Steam…" | app.js:2439–2442 | | ✅ done · logic unchanged |
| P-229 | Load error (both panes): rose triangle + `err.message`; closed-mid-fetch guard bails if overlay hidden | app.js:2448–2453 | | ✅ done · logic unchanged |
| P-230 | Sort: active first, then newest by updatedAt/createdAt | app.js:2460–2464 | | ✅ done · logic unchanged |
| P-231 | Per-account load-failure surfacing: errors joined; toast single error or "N account(s) could not be loaded" | app.js:2467–2472 | | ✅ done · logic unchanged (honesty surfacing preserved) |
| P-232 | Offer state → badge: In escrow/Needs confirm (warn); Active (listed); Accepted (success); Declined (danger); Cancelled/Expired/Countered/History (neutral) | app.js:2482–2494 | | ✅ done · offerStateBadge → .pill pill--* variants |
| P-233 | Coloured headline value: sent `−<fmtCents(valueGiveCents)>` (rose); received `+<fmtCents(valueReceiveCents)>` (emerald); empty if unpriced | app.js:2498–2504 | 💰 | ✅ done · offerHeadlineValue unchanged (money format intact) |
| P-234 | Per-side item thumbs: count pill + up to 5 real icons (bare items skipped), `+N` overflow; "nothing" italic when empty | app.js:2508–2519 | | ✅ done · offerSideThumbs preserved (real icons kept over prototype's count-only pills) |
| P-235 | Partner label + Steam profile link | app.js:2523–2533 | | ✅ done · offerPartnerLabel unchanged |
| P-236 | Row actions: sent → Cancel; received → Accept + Decline | app.js:2535–2543 | 💰 | ✅ done · offerRowActions → .btn btn-sm; .offer-act + data-offer-action preserved |
| P-237 | Offer row markup: checkbox only when active; date; give→arrow→receive thumbs; optional quoted message | app.js:2545–2575 | | ✅ done · offersRowHtml (badge span → .pill; all data-* hooks preserved) |
| P-238 | Empty pane: error variant (rose) if `offersError`, else "No sent/received offers." | app.js:2577–2582 | | ✅ done · emptyOffers unchanged (error honesty preserved) |
| P-239 | Pane counts: `N active · M total` per side | app.js:2585–2591 | | ✅ done · renderOffers count text unchanged |
| P-240 | Single offer action confirm: tone accept→`spend`, else `danger`; body "Accept/Decline/Cancel trade offer #<id>?" | app.js:2604–2615 | 💰 | ✅ done · onSingleOfferAction ssimConfirm gate UNCHANGED |
| P-241 | Single accept "unconfirmed" outcome → warn "awaiting mobile confirmation"; else success | app.js:2618–2623 | 💰 | ✅ done · 2FA-honesty surfacing UNCHANGED |
| P-242 | Single action failure: error toast, row un-busied | app.js:2624–2627 | | ✅ done · unchanged |
| P-243 | Batch accept/decline/cancel: `/api/trade/offers-batch`; backend caps concurrency at 2 | app.js:2630–2644 | 💰 | ✅ done · batchOffers API UNCHANGED |
| P-244 | Batch confirm modal: title "Accept/Decline/Cancel N offer(s)", body with count | app.js:2634–2638 | 💰 | ✅ done · ssimConfirm gate UNCHANGED |
| P-245 | Batch "unconfirmed" handling: ok rows removed; unconfirmed counted separately | app.js:2650–2659 | 💰 | ✅ done · 2FA-honesty UNCHANGED |
| P-246 | Batch result toast: `Accept: X ok[, N await mobile confirmation][, N failed]` | app.js:2660–2664 | | ✅ done · unchanged |
| P-247 | Row busy state: opacity .5, pointer-events none, buttons disabled | app.js:2667–2671 | | ✅ done · unchanged |
| P-248 | Row removal syncs data + counts + empty: splices `offersData`, recomputes count | app.js:2674–2686 | | ✅ done · removeOfferRow UNCHANGED |
| P-249 | Multi-select: visible+active only; select-all, checked-row helpers | app.js:2688–2706 | | ✅ done · unchanged |
| P-250 | Select-all indeterminate sync: header checkbox checked/indeterminate per side | app.js:2700–2706 | | ✅ done · unchanged |
| P-251 | Selection counts + button enable: sent cancel-sel, recv accept-sel/decline-sel disabled at 0 | app.js:2707–2717 | | ✅ done · unchanged (ids preserved) |
| P-252 | Offers search (both sides): filters by partner SteamID / bot name / item names (`data-search`); unchecks hidden | app.js:2719–2728 | | ✅ done · unchanged (data-search hook preserved) |
| P-253 | Static batch controls wiring: Sent → Cancel selected / Cancel all. Recv → Accept sel / Decline sel / Accept all / Decline all | app.js:2731–2743; index.html:1391–1419 | 💰 | ✅ done · bindOffersControls unchanged; buttons → .btn btn-sm (ids preserved) |
| P-254 | Offers modal static layout: two-sided (Sent left rose / Received right emerald), max-w 1400px h-90vh, per-side "Select all (active)"; env-wide aggregation | index.html:1354–1426 | | ✅ done · index.html:1551–1620 (header .t16/.field/.modal-x; batch btns → .btn btn-sm) |
| P-255 | `openTradeOffers()` entry: scope pill; both sides' batch buttons; per-side lists+counts | index.html:1354–1426 | 💰 | ✅ done · #offers-scope .pill pill--brand; all list/count/button ids preserved |

---

## R. Aggregated views internals (env-master + global-master)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-256 | Aggregate over usernames: merges stacks by marketHashName, sums items/locked-stacks/valueCents/walletUsd, counts loaded accounts | app.js:2746–2765 | | ✅ done · app.js:2742–2761 (logic unchanged) |
| P-257 | Render aggregate header + stat bar; hides single-Refresh btn | app.js:2767–2770 | | ✅ done · app.js:2764–2766 (logic unchanged; headerHtml re-skinned by callers) |
| P-258 | Stat labels TF2 vs CS2: TF2 "TF2 Items"/"TF2 Keys"; else "Items"/"Trade-Locked" | app.js:2773–2776 | | ✅ done · app.js:2769–2772 (logic unchanged) |
| P-259 | Money stats (worth + wallet): worth summed for BOTH games; `setMoneyStats(valueCents, walletUsd)` | app.js:2777–2779 | 💰 | ✅ done · app.js:2773–2775 (logic unchanged) |
| P-260 | Aggregate empty state: "No TF2 inventories cached"/"No inventories in cache"/"No items" + 'Click "Refresh all" to load inventories.' | app.js:2781–2788 | | ✅ done · app.js:2777–2784 (logic unchanged; .empty in shell) |
| P-261 | Env-Master view: title `<env name>` + "Portfolio" pill, "N account(s) in this environment" | app.js:2793–2803 | | ✅ done · app.js:2793–2802 (icon-less title + .pill pill--brand) |
| P-262 | Env-Master "Check Bans" button: opens ban checker for env accounts | app.js:2804–2809 | | ✅ done · app.js:2803–2808 (.btn btn-secondary btn-sm; #btn-env-bans+handler untouched) |
| P-263 | Global-Master view: title "Global Master" + "Cross-environment" pill, "X of Y environments aggregated" | app.js:2812–2822 | | ✅ done · app.js:2812–2821 (icon-less title + .pill pill--brand) |
| P-264 | Global-Master "Check Bans" + "Refresh all" buttons | app.js:2823–2831 | | ✅ done · app.js:2822–2830 (.btn btn-secondary btn-sm; #btn-global-bans/#btn-refresh-global+handlers untouched) |
| P-265 | Global-Master environment filter (facet toggles): per-env chips with account count, checked-square icon, toggles `state.globalEnvs` and re-renders | app.js:2834–2848 | | ✅ done · app.js:2829–2841 (.surface strip + .chip aria-pressed; data-genv+handler untouched) |
| P-266 | Placeholder ("No account selected"): stat bar/toolbar/items hidden, custom msg | app.js:2851–2856 | | ✅ done · app.js:2845–2850 (logic unchanged) |

---

## S. Trade-link (Feature 2)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-267 | "Get trade link" button (no cached URL, `fa-link`) | app.js:2862–2868 | | |
| P-268 | Cached link display: `<code>` truncated to 280px + "Copy" button | app.js:2869–2874 | | |
| P-269 | Fetch trade link: loading state; on success stores + auto-copies; toast `Trade link fetched & copied[ (manual)]` | app.js:2882–2894 | | |
| P-270 | Copy trade link: toast "Trade link copied" | app.js:2895–2900 | | |
| P-271 | Clipboard fallback: hidden textarea + `execCommand('copy')` if `navigator.clipboard` fails | app.js:2901–2910 | | |

---

## T. Item table / category tabs / faceted filters / sorting / selection

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-272 | Account category tab bar (GC): pills All / Owned Items / Trade-Locked / Listed on Market with per-bucket counts; flat inv collapses to single "Items" pill | app.js:2923–2938 | | done · app.js:2922–2946 (.chip aria-pressed toggles) |
| P-273 | "Active Orders" tab (always appended): teal `fa-receipt`, separated by divider; click sets `state.gcCat` and re-renders | app.js:2939–2949 | | done · app.js:2947–2950 (.chip chip--buy, divider) |
| P-274 | Windowed rendering for flat 10k list: only visible rows (+10 buffer) between spacer `<tr>`s, recomputed on scroll; row height auto-measured; selection stays data-driven | app.js:2952–2995 | | done · app.js:2952–2996 (windowing math UNCHANGED, invariant 7) |
| P-275 | Per-row renderer (name/qty/rarity/value/status): item name colored by rarity; icon-with-lock; master row shows Accounts count instead of Exterior/Status | app.js:2997–3041 | | done · app.js:2998–3042 (.rar bar + .item-icon + is-selected rows) |
| P-276 | Facet state per view: persists per `invMode:env:user/folder/master`; `{status[], rarity[], maxCents}` | app.js:3043–3051 | | done · app.js:3046–3055 (logic unchanged) |
| P-277 | Apply facets: status/rarity include-filters + `maxCents` (price < threshold) | app.js:3052–3062 | | done · app.js:3056–3065 (logic unchanged) |
| P-278 | Toggle / clear facet values: re-renders on each change | app.js:3063–3069 | | done · app.js:3066–3073 (logic unchanged) |
| P-279 | Facet chip bar: "Filter" label; status chips (Tradable success / Trade-Locked warn / Listed listed) only in flat views; rarity chips sorted by weight; `≤ <sym>` value input; "Clear (N)" when active (TBL-03) | app.js:3070–3107 | | done · app.js:3075–3111 (already .chip; unchanged) |
| P-280 | Facet value input currency-aware: EUR converts via `usdToEur`; symbol `€`/`$` | app.js:3086–3104 | 💰 | done · app.js:3090–3108 (logic unchanged) |
| P-281 | Render items table (master vs account columns): master Item/Qty/Accounts/Rarity/Value; account Item/Qty/Exterior/Rarity/Value/Status | app.js:3109, 3137–3139 | | done · app.js:3113, 3141–3143 (thSort/thPlain/thCheck re-skin) |
| P-282 | "Select under value" control visibility: only when rows selectable (account + folder-master) | app.js:3116–3117 | | done · app.js:3120–3121 (logic unchanged) |
| P-283 | Trade-lock badge policy: shown in flat lists (TF2/not-fully-refreshed CS2) and categorized Trade-Locked tab; never in master/aggregate | app.js:3120–3125 | | done · app.js:3124–3129 (logic unchanged) |
| P-284 | Search filter (name + marketHashName): corrupt name fields coerced to avoid throw (S30) | app.js:3142–3145 | | done · app.js:3146–3149 (logic unchanged) |
| P-285 | Sort (active/default): with `state.sort` → `compareItems` asc/desc; default → locked-first (account only) then qty desc | app.js:3147–3155 | | done · app.js:3151–3159 (logic unchanged) |
| P-286 | Search-empty message: "No items for this search." toggled on filtered length | app.js:3157; index.html:678 | | done · app.js:3161; index.html:875 |
| P-287 | Categorized GC bucket rendering: 3 strictly-separated groups w/ section headers in "All" ("Owned · freely tradable" success / "Trade-Locked" warn / "Listed on Steam Market" listed), each `N item(s)` count; single-category → "No items in this category." | app.js:3163–3189 | | done · app.js:3167–3193 (section headers kept, .rar-driven rows) |
| P-288 | Qty badge: `×N` (bold pill) for N>1, else muted `×1` | app.js:3206–3210 | | done · app.js:3210–3214 (unchanged) |
| P-289 | Value cell: `undefined`→`…` (Price loading…); `null`→`—` (no market price); else `fmtCents(stackValueCents)` + `(fmtCents(price)/ea.)` when qty>1 | app.js:3211–3216 | 💰 | done · app.js:3215–3220 (pricing-honesty distinct states, invariant 5) |
| P-290 | Rarity badge (colored) | app.js:3217–3219 | | done · app.js:3221–3223 (rarity-hex data color, unchanged) |
| P-291 | Lock countdown text: "3 days, 14 h" / "5 h, 12 min" / "8 min" / "unlocked now" | app.js:3220–3230 | | done · app.js:3225–3235 (unchanged) |
| P-292 | Compact lock badge: "7D" / "14H" / "32M" (null if free) | app.js:3231–3240 | | done · app.js:3236–3245 (unchanged) |
| P-293 | Icon-with-lock overlay: amber corner badge title "Trade-Locked: unlocks in <countdown>" | app.js:3241–3254 | | done · app.js:3248–3259 (unchanged) |
| P-294 | Status cell: locked → amber lock + countdown (title "Unlocks on <abs localeString>"); tradable → emerald "Tradable"; else rose "Locked" | app.js:3255–3263 | | done · app.js:3259–3267 (unchanged) |
| P-295 | Sortable column header: click toggles asc/desc; active arrow ▲/▼ in brand color | app.js:3265–3276 | | done · app.js:3269–3280 (.items-table th, arrow kept) |
| P-296 | Select-all header checkbox: title "Select all tradable" | app.js:3271 | | done · app.js:3275 (thCheck re-skin) |
| P-297 | Selection mode-awareness: account = assetId keys; folder/selection = marketHashName keys | app.js:3278–3297 | | done · app.js:3282–3301 (logic unchanged) |
| P-298 | Per-key max selectable qty: master (agg) uses `sendable` portion only; `aggItemByName` O(1) lookup for fan-out | app.js:3286–3297 | | done · app.js:3290–3301 (logic unchanged) |
| P-299 | Per-row qty input (selected, maxSel>1): number input min 1 max maxSel; syncs all matching `.sel-qty` | app.js:3024–3025, 3298–3305 | | done · app.js:3025–3026, 3302–3309 (.sel-qty hook kept) |
| P-300 | Targeted single-row re-render on toggle: preserves scroll + siblings | app.js:3307–3328 | | done · app.js:3311–3332 (logic unchanged) |
| P-301 | Select-all (data-driven, windowed-safe): selects all selectable rows incl. off-screen; repaints window | app.js:3329–3347 | | done · app.js:3333–3351 (logic unchanged) |
| P-302 | Delegated change/click dispatchers: `.sel-check`, `.sel-qty`, header sort, `#select-all` | app.js:3348–3361 | | done · app.js:3352–3365 (delegation unchanged, invariant 7) |
| P-303 | Account send → concrete assetIds (single-owner send) | app.js:3363–3372 | 💰 | done · app.js:3367–3376 (logic unchanged) |
| P-304 | Folder send → {username,assetId} refs across owners (mass send fan-out) | app.js:3373–3388 | 💰 | done · app.js:3377–3392 (logic unchanged) |
| P-305 | Selection bar: shows/hides; hides Sell button in TF2 view (market SELL is CS2-only); count text `N Item(s) · M Bot(s)/Stack(s)` | app.js:3391–3405; index.html:639–653 | 💰 | done · app.js:3395–3409; index.html:829–846 (logic unchanged; opens modal only) |
| P-306 | "Select under value" bulk-select: threshold in display currency → USD cents; skips locked/untradable/unpriced; toast `Selected N item(s) under <sym><val>` or `No items under …` | app.js:3407–3433; index.html:626–638 | 💰 | done · app.js:3411–3437; index.html:812–827 (logic unchanged; selection only) |

---

## U. Account selection + inventory refresh

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-307 | Select account: sets account mode, resets gcCat/search/sort/selection, clears search box | app.js:3439–3447 | | |
| P-308 | Table skeleton rows: 9 shimmer rows mirroring table geometry (FB-03) | app.js:3450–3466 | | |
| P-309 | Dashboard env-tile skeletons: 6 shimmer tiles on initial load | app.js:3467–3481 | | done · app.js:3468–3487 (.env-tile skeleton) |
| P-310 | Inv loading skeleton toggle: hides bare spinner, empties header, shows skeleton; on off with skel still present re-renders | app.js:3482–3497 | | |
| P-311 | Refresh single account (CS2): `/api/inventory/<u>?refresh=1`; complete fetch; toast `Inventory refreshed: N items · L locked · X listed` | app.js:3499–3520 | 💰 | |
| P-312 | Refresh single account (TF2): `/api/inventory-tf2/<u>?refresh=1`; toast `TF2 inventory refreshed: N items, K keys` | app.js:3505–3510 | 💰 | |
| P-313 | Background price-fill watch after refresh: `watchPriceFill` re-pulls so prices/totals update without restart (PRICE-REFRESH) | app.js:3521–3523 | | |
| P-314 | Refresh button loading + finalize: "Refreshing…"; on done patches sidebar balances in place | app.js:3502, 3526–3530 | | |
| P-315 | Start Refresh-All job: POST `/api/inventory/refresh-all`; shows progress bar, resets End-task btn + failure list + stall poller | app.js:3534–3546 | | |
| P-316 | Failed-accounts panel: lists each failed `username – <shortError>`; persists until dismissed/next run | app.js:3547–3559; index.html:426–437 | | |
| P-317 | shortError truncation: collapses whitespace, truncates >140 chars with `…` | app.js:3560–3564 | | |
| P-318 | Refresh-All scope: global mode → only enabled accounts in selected envs (`state.globalEnvs`); else whole env; toast warn "No accounts…to refresh" if empty | app.js:3565–3580 | 💰 | |
| P-319 | Refresh folder: `refreshFolder(usernames)` | app.js:3581–3583 | | |
| P-320 | Refresh-All progress poller (800ms): bar %, `done/total` count, label "Cancelling…"/"Refreshing…"/"Done" | app.js:3584–3593 | | |
| P-321 | Stall detection: no progress (not cancelling) → warn "Refresh appears stuck (no progress) – stopping the live updater. Check the server." + hide progress | app.js:3594–3599 | | |
| P-322 | Poll completion re-pull (CS2/TF2): re-fetches full inventory map, invalidates history / heals TF2 load-error | app.js:3603–3619 | | |
| P-323 | Refresh-All completion toast: with failures → panel + `Refresh complete/ended: done/total – failed: names[+N]` (warn); else `Refresh complete/ended: done/total` (success/warn if cancelled) | app.js:3620–3631 | | |
| P-324 | Poll transient-error tolerance: bounded retry until continuous-error stall, then error toast + hide progress (S17) | app.js:3632–3640 | | |
| P-325 | Soft hide/unhide account: toast `"<u>" hidden/shown` with **Undo** action; falls back to env master if hiding active account | app.js:3644–3653 | | |

---

## V. Edit-account modal (per-account proxy override + details) — `#edit-overlay`

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-326 | Open Edit Account: prefills displayName; "Use environment proxy" ON by default; loads current proxy async | app.js:3656–3690; index.html:955–1010 | | |
| P-327 | Proxy field enable/grey by toggle: disabled + opacity-40 while "Use env proxy" ON | app.js:3692–3698 | | |
| P-328 | Proxy source hint line: "own proxy" (emerald) / "environment proxy" (slate) / "local proxy (local IP)" (amber) | app.js:3700–3705 | | |
| P-329 | Close edit modal: clears editUsername | app.js:3706 | | |
| P-330 | Delete account (from edit): confirm danger "Remove account" (body: logged out, cache cleared, maFile kept, re-add via Import bots); DELETE; falls back to env master; toast `Account "<u>" removed` | app.js:3707–3728 | 💰 | |
| P-331 | Save edit account: sends displayName always; proxy only if intent changed (env/proxy:x/local); optional password + maFilePath; PATCH; re-pulls cached inv; toast "Account saved"; proxy change re-logs in | app.js:3729–3769; index.html:982–993 | | |
| P-332 | Change-credentials collapsible: `<details>` password + maFile (empty = unchanged) | index.html:982–990 | | |

---

## W. Add-account modal — `#modal-overlay`

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-333 | Open add account: resets form, populates env select (defaults to active env) | app.js:3776–3781; index.html:695–736 | | |
| P-334 | Submit add account: POST `/api/accounts` (username/password/maFilePath/environmentId/proxy?); toast `Account "<u>" added`; reloads + selects | app.js:3783–3804 | | |
| P-335 | Add-account fields: Environment select, Steam Username (req), Password (req), maFile path (req), Proxy override (optional, empty=env proxy) | index.html:702–727 | | |

---

## X. Account-Login modal (QR / credentials import → Limited tier) — `#login-overlay`

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-336 | Open Login: `#login-env` populated from environments, preselects active env; resets creds pane; defaults to QR tab | app.js:3809–3815 | | |
| P-337 | Close Login: stops poll, cancels both QR + cred sessions | app.js:3817–3826 | | |
| P-338 | Tab switch (QR / Credentials): cancels the other method's session; QR auto-starts | app.js:3828–3845; index.html:752–756 | | |
| P-339 | QR start: POST `/api/accounts/login/qr/start {environmentId}`; sets QR data-URL image; polls status if not terminal | app.js:3848–3862 | | |
| P-340 | QR status stepper: 4 pills Waiting→Scanned→Approved→Done; current = brand+spinner, done = emerald | app.js:3864–3881; index.html:763 | | |
| P-341 | QR terminal overlays: imported→done; expired→"QR code expired" + "New code"; error→msg + "Try again" | app.js:3866–3869 | | |
| P-342 | Credentials submit (login + guard phases): POST `/api/accounts/login/credentials`, then `/guard` with code | app.js:3895–3913 | | |
| P-343 | Guard prompt: EmailCode → "Email Steam Guard code (sent to …@<detail>)"; else "Steam Guard mobile code"; hint about mobile approval | app.js:3915–3935; index.html:778–782 | | |
| P-344 | Cred status messages: error rose / info slate / success emerald | app.js:3937–3941 | | |
| P-345 | Login poll (1500ms): polls `/status`; ignores transient/404 | app.js:3945–3952 | | |
| P-346 | On imported: toast `Account "<u>" imported/updated as Limited`; reloads + selects | app.js:3954–3960 | | |
| P-347 | Limited-tier explainer note (static): imports as Limited; buy orders/market buys/cancels work; sell listings & trade offers queued pending confirmation; attach maFile to upgrade | index.html:788–794 | | |

---

## Y. Attach-maFile modal (upgrade Limited → Full) — `#attach-overlay`

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-348 | Open Attach maFile: sets username on form | app.js:3963–3968; index.html:799–821 | | |
| P-349 | Submit attach: POST `/api/accounts/:u/attach-mafile {maFilePath}`; toast `"<u>" upgraded to Full`; reloads sidebar; maFile path field placeholder `username.maFile  or  C:\…\file.maFile` | app.js:3970–3983; index.html:810 | | |

---

## Z. CSFloat workspace modal (per-account marketplace) — `#csfloat-overlay`

> Merged: seg2 §K rows 146–173 + seg3 §A rows 1–35 (both cover app.js ~3992–4529). Overlap
> deduplicated. Static shell `index.html:823–836`: 4xl × 85vh flex-col, title `<i fa-water
> cyan-400>CSFloat` + `#csfloat-account` (mono), tab strip `#csfloat-tabs`, scroll body `#csfloat-body`.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-350 | Open CSFloat: sets `CSF.username`, resets market state, shows skeleton, parallel-fetches `/api/csfloat/config` (experimental flag) + per-account `/key`; opens Dashboard if key configured else Settings | app.js:4008–4022; index.html:823–836 | | |
| P-351 | Close CSFloat (`closeCsFloat`) | app.js:4023 | | |
| P-352 | Tab bar (core): Dashboard / My Listings / Market always shown; Settings always last | app.js:4179–4187 | | |
| P-353 | Tab bar (experimental): Buy Orders / Trades / Inventory shown ONLY when `CSF.experimental` true | app.js:4180–4182 | | |
| P-354 | Active-tab styling: active `border-brand text-white`; inactive `border-transparent text-slate-400 hover:text-slate-200` | app.js:4183–4186 | | |
| P-355 | Tab switch gate: any non-settings tab with no key → `csfNeedKey()` empty state ("No CSFloat API key for this account" + "Open Settings" btn) | app.js:4189–4197 | | |
| P-356 | Loading skeleton `csfSkeleton(rows)`: N pulse rows (`h-14 bg-slate-800/50 animate-pulse`) | app.js:4002 | | |
| P-357 | Error state (per tab) `csfError(msg)`: warn icon + message + "Retry" (`data-csf="retry"` reloads current tab) | app.js:4003, 4444 | | |
| P-358 | Empty state (per tab) `csfEmpty(icon,msg)`: icon + message | app.js:4004 | | |
| P-359 | Icon-host allow-list `csfImg(hash)`: builds steamstatic URL or accepts full URL, then through `safeIconUrl` (anti-IP-beacon) | app.js:3997–4001 | | |
| P-360 | Dashboard view: 3 stat cards — Balance (`csfUsd`), Active listings (count from `/listings?limit=50`), Account (username/steamid) + "Browse market" / "My listings" quick buttons | app.js:4200–4222 | 💰 | |
| P-361 | My Listings view: rows from `/listings?limit=50` — icon, name, float (4dp), editable price input (min 0.03, placeholder current 2dp), edit-price btn, delist btn, price label (`csfUsd` emerald) | app.js:4224–4243 | 💰 | |
| P-362 | Edit listing price `csfEditPrice`: reads `.csf-price` input, requires ≥$0.03; PATCH `/listings/:id` price=cents; toast "Price updated"; reload listings | app.js:4496–4502 | 💰 | |
| P-363 | Delist listing `csfDelist(id)`: `ssimConfirm` danger "Remove this listing from CSFloat?" → DELETE `/listings/:id`; toast "Listing removed"; reload | app.js:4491–4495 | 💰 | |
| P-364 | Market view search form: name, Min $, Max $, Sort select (Best deal/Lowest price/Highest price/Most recent/Lowest float/Highest float), Search btn | app.js:4245–4258 | 💰 | |
| P-365 | Market search exec `csfDoMarketSearch(reset)`: prices ×100 → cents, limit 24, cursor paging; results grid of cards | app.js:4261–4290 | 💰 | |
| P-366 | Market result card: icon, name, wear + float (4dp), price (`csfUsd` emerald), Buy button (data-id/price/name) | app.js:4291–4303 | 💰 | |
| P-367 | Market "Load more": shown when `CSF.market.cursor` present; appends next page (`csfDoMarketSearch(false)`) | app.js:4289, 4446 | | |
| P-368 | Buy from market `csfBuy(id,priceCents,name)`: `ssimConfirm` tone spend "Buy … for $X from your CSFloat balance?" → POST `/buy`; toast "Purchase sent" | app.js:4503–4508 | 💰 | |
| P-369 | Buy Orders view (exp): create-order form (item search-as-you-type, Max $, Qty default 1, Place order) + list of active orders | app.js:4305–4324 | 💰 | |
| P-370 | Buy-order item search `csfWireBoSearch`: debounced 300ms Steam market search (`/api/market/search?appId=730`), dropdown, click fills exact `market_hash_name`; Steam price deliberately NOT shown | app.js:4326–4357 | | |
| P-371 | Buy-order row: name, qty, max price (`csfUsd` emerald), delete-order btn | app.js:4358–4365 | 💰 | |
| P-372 | Place buy order `csfCreateBuyOrder(form)`: name+max_price required, price ×100, POST `/buy-orders`; toast "Buy order placed"; reload | app.js:4509–4515 | 💰 | |
| P-373 | Cancel buy order `csfDeleteBuyOrder(id)`: `ssimConfirm` danger "Cancel this buy order?" → DELETE `/buy-orders/:id`; toast "Buy order cancelled"; reload | app.js:4516–4520 | 💰 | |
| P-374 | Trades view (exp): auto-accept toggle card + trade rows | app.js:4368–4385 | 💰 | |
| P-375 | Auto-accept toggle state: card copy differs when account Limited (no identity_secret → disabled/greyed); ON=brand, OFF=slate; `data-enabled` is source of truth (never button text) | app.js:4378–4381, 4484 | | |
| P-376 | Toggle auto-accept `csfToggleAutoAccept(btn)`: PUT `/auto-accept enabled:!cur`; toast "Auto-accept enabled/disabled"; reload trades | app.js:4484–4490 | 💰 | |
| P-377 | Trade row: name, state/status, price (`csfUsd` emerald) | app.js:4386–4393 | 💰 | |
| P-378 | Inventory view (exp): rows from `/inventory` — icon, name, float, price input (min 0.03), List btn (disabled if no asset id); empty "No tradable CS2 items found on CSFloat." | app.js:4395–4414 | 💰 | |
| P-379 | List asset on CSFloat `csfListAsset(btn)`: needs asset id + price ≥$0.03; `ssimConfirm` brand "Create a CSFloat listing at $X?" → POST `/listings type=buy_now`; toast "Listing created"; reload inventory | app.js:4521–4529 | 💰 | |
| P-380 | Settings view: API-key form (password field, placeholder "configured ending …tail" when set), Save; Clear btn when configured (note stored encrypted per-account); Experimental toggle card | app.js:4416–4436 | | |
| P-381 | Save API key `csfSaveKey`: POST/PUT `/key`; msg "Validating…"→"Key saved & validated" (or warning); auto-switch to dashboard after ~700ms | app.js:4463–4474 | 💰 | |
| P-382 | Clear API key `csfClearKey`: `ssimConfirm` danger "Remove this account's CSFloat API key?" → DELETE `/key`; toast "CSFloat key cleared" | app.js:4475–4479 | | |
| P-383 | Toggle experimental `csfToggleExperimental`: PUT `/api/csfloat/config experimental:!`; re-renders tabs+settings | app.js:4480–4483 | | |
| P-384 | CSFloat money format `csfUsd(cents)` = `'$' + (cents/100).toLocaleString('en-US',{2 frac})` → `$1,234.56`; event delegation: tab clicks (`onCsfTabClick`), body clicks (`onCsfBodyClick`), body submits (`onCsfBodySubmit` key/market/bo forms) | app.js:3992, 4439–4460 | 💰 | |

---

## AA. SDA overview modal (Steam Guard OTP + confirmations) — `#sda-overlay`

> Merged: seg2 §L rows 174–182 + seg3 §B rows 36–49 (both cover app.js ~4034–4159). Static shell
> `index.html:838–872`: 3xl × 85vh, title "SDA" + mono `#sda-account`.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-385 | Open SDA: sets account, starts OTP roll, loads confirmations | app.js:4034–4041; index.html:838–872 | | |
| P-386 | Close SDA: clears OTP + bar timers | app.js:4043–4048 | | |
| P-387 | OTP display: large 5-char code `#sda-otp` (`text-4xl mono tracking-[0.3em] emerald-300 select-all`), placeholder `·····` | index.html:853 | | |
| P-388 | OTP auto-roll (30s): GET `/api/accounts/:u/otp` {code,msRemaining}; re-fetches ~300ms past expiry so displayed value never stale | app.js:4050–4071; index.html:849–859 | | |
| P-389 | OTP countdown bar: 30 000ms cycle; `#sda-otp-bar` width animated every 200ms via `barTimer` | app.js:4061–4069; index.html:856 | | |
| P-390 | OTP error handling: on fail shows `—`, bar 0%, toasts once per error streak, bounded 5s guarded retry (S17); heals on recovery; guarded to modal-open+same-account | app.js:4072–4082 | | |
| P-391 | Copy OTP `copySdaOtp`: copies LIVE DOM code (never `·····`/`—`); label flips "Copy"→"Copied" 1200ms | app.js:4085–4096; index.html:854 | | |
| P-392 | Pending confirmations header: title + count `#sda-conf-count`; buttons Approve selected (disabled until ≥1), Approve all, Refresh | index.html:862–867 | | |
| P-393 | Load confirmations `refreshSdaConfirmations`: GET `/confirmations`; loading spinner; error w/ inline Refresh | app.js:4098–4113 | | |
| P-394 | Render confirmations `renderSdaConfirmations`: per-row checkbox, type icon (trade=right-left, market=tag, else shield), title, subline `typeName · gives X · gets Y`, per-row Approve btn | app.js:4115–4135; index.html:860–869 | | |
| P-395 | Empty confirmations: "No pending confirmations." | app.js:4118 | | |
| P-396 | Confirmation multi-select: `selectedSdaIds`/`updateSdaSelCount` — updates `#sda-conf-sel-count`, enables/disables Approve-selected | app.js:4137–4147; index.html:863–866 | | |
| P-397 | Approve single (per-row btn) → `respondSda([id], true)` | app.js:4133 | 💰 | |
| P-398 | Approve selected → `respondSda(selectedIds, true)` | app.js:6401 | 💰 | |
| P-399 | Approve all → `respondSda([], true, true)` | app.js:6400 | 💰 | |
| P-400 | Respond result `respondSda`: POST `/confirmations/respond {ids,accept,all}`; toast "Approved/Denied N confirmation(s)[, M failed]"; ALWAYS re-fetch from canonical source | app.js:4149–4159 | 💰 | |
| P-401 | (Confirmations are trade/market approvals — approving a market/trade confirmation is money-affecting) | app.js:4115–4159 | 💰 | |

---

## AB. Clean-browser action (Phase 6)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-402 | Open account in clean browser `openCleanBrowser(btn,username)`: btn spinner "Opening…"; POST `/api/accounts/:u/open-browser`; surfaces warnings as info toasts; success toast shows proxy or "(LOCAL IP)" | app.js:4161–4177 | | |

---

## AC. Environment create / edit / delete modal — `#env-overlay`

> Merged: seg2 §N rows 184–188 + seg3 §F rows 64–67 (both cover app.js ~4532–4607). Static shell
> `index.html:874–903`: title toggles New/Edit environment; Name + "Global (rotating) proxy"
> (empty = local IP), any proxy format accepted.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-403 | Open env modal (create/edit) `openEnvModal(mode,id)`: edit → title "Edit environment", loads REAL saved proxy via GET `/environments/:id/proxy` (guards against a different modal opening meanwhile); create → "New environment", proxy placeholder | app.js:4532–4567; index.html:874–903 | | |
| P-404 | Proxy load-error: toast `Could not load the saved proxy: …` | app.js:4564 | | |
| P-405 | Close env modal | app.js:4568 | | |
| P-406 | Submit env `submitEnv`: create POST `/api/environments {name,proxy}`; edit PATCH sends proxy ONLY when changed (cleared→local IP / changed / omitted logic); toast "Environment updated" / `Environment "<name>" created`; reloads + re-renders | app.js:4569–4593 | | |
| P-407 | Delete environment `deleteEnvironment`: `ssimConfirm` danger "Delete environment X?" (only when it no longer contains any accounts) → DELETE; toast deleted; removes from `globalEnvs` | app.js:4595–4607 | | |

---

## AD. Folder create / rename / delete / reorder — `#folder-overlay`

> Static shell `index.html:905–926`: title toggles New folder / Rename folder.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-408 | Open folder modal `openFolderModal(action)`: create vs rename title/icon; prefill name on rename | app.js:4610–4619 | | |
| P-409 | Submit folder `submitFolder`: create POST `/api/folders {name,environmentId,parentId}` (un-collapses parent) / rename PATCH `/folders/:id`; toast; refresh env | app.js:4621–4639 | | |
| P-410 | Delete folder `deleteFolder`: `ssimConfirm` danger "Delete folder X? Subfolders and accounts move to the parent folder." → DELETE; toast | app.js:4640–4651 | | |
| P-411 | Reorder folder up/down `reorderFolder(id,direction)`: POST `/folders/:id/reorder {direction}`; refresh env | app.js:4653–4661 | | |

---

## AE. Move-account modal (single or batch) — `#move-overlay`

> Static shell `index.html:928–953`: env select + target-folder select. Reused by ban-category move.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-412 | Open move modal `openMoveModal(usernameOrList)`: single vs batch; label `Move "X":` or `Move N selected account(s):`; env dropdown; folder tree flattened & indented | app.js:4664–4678 | | |
| P-413 | Populate move folders `populateMoveFolders`: GET `/environments/:id/tree`; "— Root —" + indented options | app.js:4680–4689 | | |
| P-414 | Submit move (batch-safe) `submitMove`: `Promise.allSettled` per-account POST `/accounts/:u/move {folderId,environmentId}`; toast `N moved, M failed` / `Account moved` / `N accounts moved`; reload + refresh env | app.js:4690–4709 | | |
| P-415 | Batch delete accounts `batchDeleteAccounts`: `ssimConfirm` danger "Remove N selected account(s)? …maFiles kept" → allSettled DELETE `/accounts/:u`; clears selection; falls back to env master if active account removed; toast `N removed, M failed` | app.js:4713–4733 | 💰 | |

---

## AF. Ban-Checker modal — `#ban-overlay` (z-30, below Move z-40)

> Static shell `index.html:1428–1444`. Category set `BAN_CATS`: Clean(emerald), VAC(rose),
> Game(orange), Community(amber), Economy/Trade(fuchsia), Lookup Failed(slate); `movable` true for
> the 4 ban types.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-416 | Open ban checker (job + poll) `openBanChecker(usernames,scopeLabel)`: dedups; scope label `· X` or `· N account(s)`; POST `/api/bans/check {usernames}` (202 detached); 409 "already running" toast; then poll | app.js:4757–4776 | | |
| P-417 | Ban-check poll (1.5s) `pollBanCheck`: GET `/api/bans/status`; bounded error-retry (S17); stall guard; live phase label "Resolving SteamIDs…"/"Acquiring keys…"/"Checked X of N…" | app.js:4778–4817 | | |
| P-418 | Stuck detection: pollerStalled → amber "The ban check appears stuck (no progress)…" | app.js:4803–4806 | | |
| P-419 | Result summary chips `renderBanResult`: "N checked" + one chip per category w/ count (errors chip only when >0) | app.js:4845–4858 | | |
| P-420 | Category accordions `banAccordion`: collapsible per non-empty category; caret rotates; count badge; movable categories get "Move this Category" btn | app.js:4868–4885 | | |
| P-421 | Ban tags per account `banTags`: VAC (×count), Game (×count), Community, Trade:reason, "No bans"; "Nd since last ban" | app.js:4888–4899 | | |
| P-422 | Account row: user icon, display/username, mono steamId, tags | app.js:4901–4914 | | |
| P-423 | Accordion toggle + Move-category `onBanBodyClick`: header toggles body/caret; "Move this Category" collects category usernames → `openMoveModal` (layers z-40 above; ban modal stays open) | app.js:4916–4936 | | |
| P-424 | Account-level trigger `checkAccountBans(username)` | app.js:4821–4825 | | |
| P-425 | Folder-level trigger `checkFolderBans(folderId)`: every account in subtree | app.js:4827–4833 | | |

---

## AG. Send-Trade modal (single + folder mass-send) — `#trade-overlay`

> Static shell `index.html:1012–1078`. Internal-account vs External-link radio; env→folder→recipient
> picker; 2FA auto-confirm note.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-426 | Open trade modal `openTradeModal`: folder vs single; summary "N Item(s)"; from = bots list or active user; default env; reset target; internal radio checked | app.js:4939–4968 | | |
| P-427 | Target-mode toggle `updateTradeTargetVisibility`: shows internal-block or external-URL block | app.js:4971–4975 | | |
| P-428 | Populate trade folders `populateTradeFolders`: GET tree; "All folders" + "— no folder —" + indented; rebuild recipients | app.js:4979–4992 | | |
| P-429 | Build recipient list `buildRecipientList`: filter by env+folder+search; excludes self (single mode); drops stale selection; count line "Selected: X" / "N account(s) · click to select" | app.js:4995–5020 | | |
| P-430 | Recipient row `recipientRow`: selected highlight (brand ring), folder name subline, check icon | app.js:5022–5034 | | |
| P-431 | Read target `readTradeTarget`: internal {toUsername} (warn if none) / external {tradeUrl} (warn if empty) | app.js:5037–5046 | | |
| P-432 | Submit trade (single) `submitTrade`: POST `/api/trade/send {from,assetIds,appId,contextId:'2',target}`; clears selection; **unconfirmed** → warn "SENT but NOT 2FA-confirmed — confirm manually, do NOT resend"; confirmed/sent → success; **9s deferred re-refresh** of affected accounts (INV-E1) | app.js:5048–5089 | 💰 | |
| P-433 | Send-fail money-safety: on error w/ `verifyBeforeRetry` → error "Send may have placed an offer — verify outgoing offers before retrying" + refresh sender | app.js:5079–5086 | 💰 | |
| P-434 | Submit mass-trade (folder) `submitMassTrade`: POST `/api/trade/mass-send {items,appId,contextId:'2',target}`; shows progress; polls; toast `Mass trade started: N bot(s), M items` | app.js:5092–5111 | 💰 | |
| P-435 | Mass progress panel `showMassProgress`: bottom-center `#mass-progress`; bar, count `0/bots`, "Processing queue (max. 2 at a time)…" | app.js:5112–5118; index.html:1471–1485 | 💰 | |
| P-436 | Mass-trade poll (1s) `pollMass`: GET `/api/trade/mass-status`; bar %, `done/total`, detail `X confirmed · Y failed` (or cancelling); stall guard; on done re-pull cache + surface failures + toast `Mass trade done/ended/stopped: X confirmed[, Y failed]`; hides after 3500ms | app.js:5166–5205 | 💰 | |
| P-437 | Surface trade failures `surfaceTradeFailures`: groups by reason; up to 4 error toasts `reason — who (+N more)`; overflow warn | app.js:5148–5164 | | |

---

## AH. End-Task (cooperative cancel) — shared across mass jobs

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-438 | End task (confirmed cancel) `endTask({label,endpoint,button})`: MANDATORY `ssimConfirm` danger "End task? …account in progress finishes; remaining skipped" → POST endpoint; btn→"Stopping…"; warn toast | app.js:5129–5146 | | |
| P-439 | Reset end button `resetEndBtn`: re-enables + restores "End task" label on fresh run | app.js:5124–5128 | | |
| P-440 | Wired end-task buttons: Refresh (`/api/inventory/refresh-cancel`), Mass trade (`/api/trade/mass-cancel`), Market sale (`/api/market/sell-cancel`), Mass buy (`/api/market/folder-buy-cancel`) | app.js:6357–6360 | 💰 | |

---

## AI. Market-Sell modal (mass-sell) — `#sell-overlay`

> Static shell `index.html:1080–1141`. Strategy radios: Lowest listing / 1 cent below / Custom price
> (net). Gross/Net/fee note; 2FA-irreversible warning; EUR.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-441 | Flatten selection → sell items `selectedSellItems`: {username,assetId,marketHashName} across agg (folder) or single account | app.js:5211–5237 | 💰 | |
| P-442 | Sell strategy read `sellStrategy`: lowest / undercut / custom | app.js:5239–5242 | | |
| P-443 | Custom price parse `customSellCents`: EUR field → integer cents (comma/dot tolerant, >0) | app.js:5244–5249 | 💰 | |
| P-444 | Toggle custom-price row `toggleSellCustomRow`: shows `#sell-custom-row` when custom, focuses field | app.js:5258–5262 | | |
| P-445 | Open sell modal `openSellModal`: summary "N Item(s)"; from bots/user; resets preview; lowest checked | app.js:5264–5280 | | |
| P-446 | Preview sell prices `previewSell`: POST `/api/market/preview {names,strategy,username[,customCents]}`; btn "Calculating…"→"Calculate prices & proceeds"; renders table | app.js:5283–5304 | 💰 | |
| P-447 | Retry one price `retryOnePrice(name,btn)`: re-query single item; spinner; warn if still no price | app.js:5306–5322 | 💰 | |
| P-448 | Sell-preview table `renderSellPreview`: per item name ×count, Gross (`fmtEurCents`), Steam fee (−, amber), Net (emerald); "no price" rows w/ re-query btn; totals footer `Total (N item(s))`; missing-price note | app.js:5324–5379 | 💰 | |
| P-449 | Submit sell `submitSell`: POST `/api/market/sell {items,strategy[,customCents]}`; toast `Market sale started: N item(s) on M bot(s)`; progress + poll | app.js:5381–5406 | 💰 | |
| P-450 | Sell progress panel `showSellProgress`: bottom `#sell-progress`; "Creating listings & confirming via 2FA…" | app.js:5407–5413; index.html:1487–1501 | 💰 | |
| P-451 | Sell poll (1s) `pollSell`: GET `/api/market/sell-status`; bar %, `done/total`; parts `X listed · Y confirmed [· recovered/retries/gone/deferred] · Z failed`; phase label {preflight→Connecting,pricing,listing,confirming 2FA,done}; current bot; stall guard; on done toast + refresh sellers; hides after 4500ms | app.js:5414–5468 | 💰 | |

---

## AJ. Bulk-Import modal (maFiles / CSV / Vault) — `#bulk-overlay`

> Static shell `index.html:1267–1341`. 3-method chooser (Vault / CSV / maFiles) + env/folder dest.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-452 | Open bulk import `openBulkImport`: env dropdown (preselect active), populate folders, load maFile list, default to maFiles method | app.js:5471–5482 | | |
| P-453 | Method selector `selectImportMethod`: shows chosen panel, highlights btn (border-brand/bg-brand/10) | app.js:5486–5496 | | |
| P-454 | Import SSIM Vault `onBulkVaultImport`: sorts selected files into vault.enc(req)+accounts.json(opt); requires password; POST `/api/import/vault {vault,accountsJson,password,environmentId,folderId}`; status `Imported X new, Y skipped [· folders recreated]`; toast; clears pw | app.js:5498–5528 | | |
| P-455 | Populate bulk folders `populateBulkFolders`: tree → "— Root —" + indented | app.js:5529–5537 | | |
| P-456 | Load maFile list `loadBulkList`: GET `/api/mafiles/unlinked`; per file checkbox (disabled if no password), name, path, Password/no-password badge; empty → "No new maFiles in mafiles/" | app.js:5538–5558 | | |
| P-457 | Select-all maFiles `onBulkSelectAll`: checks only password-bearing files | app.js:5565–5569 | | |
| P-458 | Bulk submit button state `updateBulkSubmit`: label `Import (N)`, disabled when 0 | app.js:5560–5564 | | |
| P-459 | Submit maFile import `submitBulk`: POST `/api/mafiles/import {files,environmentId,folderId}`; vault vs legacy response; toast counts; surfaces skip reasons (first 5) (H-ACC-078) | app.js:5570–5593 | | |
| P-460 | CSV import `onBulkCsv`: reads file, POST `/api/import/csv {csv,…}`; status `Imported X new, Y skipped`; surfaces rejected rows (first 5, `line N: reason`); resets file input | app.js:5595–5621 | | |

---

## AK. Market-Buy modal + toolbar utilities — `#buy-overlay`

> Static shell `index.html:1144–1207`. Bot datalist + wallet line, Game select, Qty + Max, live item
> search, Price + Market-price fetch, × qty total, buy-order note, result.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-461 | Item search input `onSearch`: sets `state.search`, re-render | app.js:5627 | | |
| P-462 | Toggle hidden accounts `onToggleHidden`: flips `state.showHidden`, re-render sidebar | app.js:5628 | | |
| P-463 | Button loading helper `setButtonLoading(btn,loading,text,icon)`: spinner/icon swap | app.js:5630–5634 | | |
| P-464 | Wallet resolver `walletOf(u)`: GLOBAL wallet (not per-game), prefers remembered newest, falls back to either game cache | app.js:5642–5652 | 💰 | |
| P-465 | Buy currency code `buyCurrencyCode`: NEVER defaults to EUR (wrong scale would misprice); uses live buyWallet or `walletOf` | app.js:5655–5660 | 💰 | |
| P-466 | Open buy modal `openBuyModal`: datalist of all accounts, preselects active bot, game from `state.game`, qty 1, empty price/name, fetches wallet | app.js:5661–5680 | | |
| P-467 | Render buy wallet `renderBuyWallet(w)`: currency label `(ISO)`/"(currency unknown)"; `Balance: …` or "Balance unknown – Refresh the account first (buying disabled)" | app.js:5682–5687 | 💰 | |
| P-468 | Update buy wallet `updateBuyWallet`: instant local value, then GET `/api/accounts/:u/wallet` for freshest; caches | app.js:5690–5702 | 💰 | |
| P-469 | Refresh buy wallet (exact) `refreshBuyWallet`: live wallet fetch used by funds check + Max; throws on error | app.js:5710–5716 | 💰 | |
| P-470 | Recompute buy total `recomputeBuyTotal`: `fmtMoneyMinor(minor*qty, code)` or `—` | app.js:5717–5724 | 💰 | |
| P-471 | Max (spend entire balance) `fillMaxBuyQty`: fetches exact wallet, computes affordable qty at price, caps at per-order max (100); toasts capped/max info | app.js:5730–5762 | 💰 | |
| P-472 | Fetch buy market price `fetchBuyPrice`: GET `/api/market/buy-price?username&marketHashName&appId`; fills price (comma decimal); toast "Lowest offer: …" | app.js:5764–5781 | 💰 | |
| P-473 | Buy item live search `searchBuyItems` (debounced 350ms): GET `/api/market/search?q&appId`; dropdown ≤20; `renderBuySearch` icon+name+"from price"; click fills marketHashName | app.js:5782–5811 | | |
| P-474 | Submit market buy `submitBuy`: validates account/name/qty(1-100)/currency/price; **pre-buy live funds check** (`refreshBuyWallet`, aborts if insufficient); POST `/api/market/buy {username,marketHashName,appId,pricePerItemMinor,quantity}`; result box ok/info; toast; refreshes buyer for that game | app.js:5812–5872 | 💰 | |
| P-475 | Buy-fail money-safety: on error "Buy failed: … — verify inventory/orders before retrying" + refresh buyer (a failed POST may still have reached Steam) | app.js:5864–5868 | 💰 | |
| P-476 | Buy result box: shows `r.message`, `Order X · confirmed/unconfirmed · Total …` | app.js:5856–5859 | 💰 | |

---

## AL. Folder Mass-Buy modal — `#fbuy-overlay`

> Static shell `index.html:1209–1265`. Game, Price/item (own currency), item search, progress bar,
> results list.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-477 | Open folder buy `openFolderBuy(folderName,usernames)`: summary `<folder> · N account(s). Each bot's balance refreshed live, then maxed out` | app.js:5878–5891 | 💰 | |
| P-478 | Fbuy item search `searchFbuyItems`/`renderFbuySearch` (debounced 350ms): same Steam search dropdown | app.js:5894–5916 | | |
| P-479 | Fetch fbuy price `fetchFbuyPrice`: representative account's `/buy-price`; fills price; toast lowest offer | app.js:5919–5935 | 💰 | |
| P-480 | Submit folder buy `submitFolderBuy`: validates name/price; `ssimConfirm` tone spend "Mass Buy — real money … maxed out at X … Real money. Irreversible." → POST `/api/market/folder-buy {usernames,marketHashName,appId,pricePerItemMajor}`; progress + poll | app.js:5936–5965 | 💰 | |
| P-481 | Fbuy poll (1.2s / 0.9s done) `pollFolderBuy`: GET `/api/market/folder-buy-status`; phase refreshing (`refreshed/total`) vs placing (`processed/total`); bar %; bounded error-retry; stall guard | app.js:5966–6010 | 💰 | |
| P-482 | Fbuy results render `renderFolderBuyResults`: sorted rows; status color/icon {bought,placed,skipped,failed,refresh-failed}; qty `N×`/`0/planned`/`—`; message | app.js:6011–6025 | 💰 | |
| P-483 | Fbuy done toast: `Mass buy done/ended: X order(s), Y item(s) filled, Z skipped, W failed`; refresh active view from cache | app.js:6003–6008 | 💰 | |

---

## AM. Trade-Ups feature modal — `#tradeup-overlay` (lazily built)

> Built by `ensureFeatureOverlay` (app.js:6576); GC execution gated server-side.

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-484 | Open Trade-Ups `openTradeUpModal(username)`: empty state "Scan this account for profitable trade-up contracts."; scope `· username` | app.js:6605–6613 | 💰 | |
| P-485 | Trade-up toolbar `renderTuToolbar`: Scan; when candidates → Select all / Clear / Execute (N) | app.js:6615–6629 | | |
| P-486 | Scan trade-ups `tuScan`: POST `/api/tradeup/candidates {username}`; "Refreshing inventory & computing…"; auto-selects all; foot `N profitable contract(s) · M eligible input(s)` + warnings | app.js:6631–6647 | 💰 | |
| P-487 | Trade-up candidate list `renderTuList`: per contract checkbox, rarity→outputRarity, collection pill, avg float (3dp), ~est-prices pill, no-asset-ids pill; inputs summary; outcomes (name/wear/prob %1dp/price); profit ±`fmtCents`, cost, EV | app.js:6649–6692 | 💰 | |
| P-488 | Empty candidates: "No positive-profit trade-ups from this account's skins." | app.js:6652–6655 | | |
| P-489 | Execute trade-ups `tuStart`: only executable (asset ids) chosen; `ssimConfirm` danger "Execute N trade-up(s)? …Each destroys 10 real items. IRREVERSIBLE. ⚠ GC not live-verified… start with 1…" → POST `/api/tradeup/execute`; poll | app.js:6694–6711 | 💰 | |
| P-490 | Trade-up exec poll (1.2s) `tuPollExec`: GET `/api/tradeup/execute-status`; line `Executing X/Y · submitted Z (C confirmed) · failed F [· cancelling]` or "Execution disabled (reason)"; Cancel btn; bounded error-retry → "status LOST, verify in-game" (never fabricates done) | app.js:6713–6747 | 💰 | |
| P-491 | Feature overlay shell `ensureFeatureOverlay(id,title,icon,width)`: generic modal-card w/ scope/toolbar/body/foot; observeOverlay; backdrop-click close | app.js:6576–6597 | | |

---

## AN. Storage-Units (Casket) feature modal — `#casket-overlay` (lazily built)

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-492 | Open Storage Units `openCasketModal(username)`: "Connecting to the game coordinator…"; unit `<select>`; GET `/api/casket/:u/list`; loads first unit's contents | app.js:6755–6772 | | |
| P-493 | Unit select `renderCasketUnitSelect`: options `name (count/1000)` or "— no storage units —"; onchange reloads contents | app.js:6774–6782 | | |
| P-494 | Load contents `loadCasketContents`: GET `/api/casket/:u/contents?casketId` | app.js:6784–6790 | | |
| P-495 | Depositable inv rows `casketInvRows`: filters cache to in-inventory (not listed) w/ asset ids; search-filtered | app.js:6793–6798 | | |
| P-496 | Storable gate `casketStorable`: greys out Storage Unit / Collectible / Pass / Gift (GC-rejected) | app.js:6807–6813 | | |
| P-497 | Two-panel render `renderCasketPanels`: Inventory panel (checkboxes, ×count, not-storable greyed) ↔ Unit panel (contents, capacity bar `count/1000`, def index); Deposit → / ← Withdraw; per-panel Select-all; filter input | app.js:6815–6872 | | |
| P-498 | Empty states: inv "No depositable items in cache." / unit "Empty storage unit." or error "…need the GC layer (install globaloffensive + SSIM_GC_VERIFIED=1)" | app.js:6833, 6840 | | |
| P-499 | Casket move (deposit/withdraw) `casketMove(direction)`: collects asset/item ids; `ssimConfirm` brand "Deposit/Withdraw N item(s)?"; POST `/api/casket/move {username,casketId,itemIds,direction}`; poll | app.js:6874–6894 | 💰 | |
| P-500 | Casket move poll (1s / 2s err) `casketPollMove`: GET `/api/casket/move-status`; counters `direction: done/total · moved M [· unconfirmed U] · failed F`; error shown WITH partial counters (never error-only if progress); Cancel btn; budget-stop warn "N not attempted; run again"; cancelled prefix; unconfirmed → "verify in-game"; re-pulls cache + re-renders | app.js:6896–6949 | 💰 | |

---

## AO. Toasts / feedback infrastructure — `#toast-stack`

> Static container `index.html:1503–1505` (bottom-right z-[60], aria-live polite, pointer-events
> pass-through, newest at bottom).

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-501 | Toast API `toast(message,type,opts)`: types info/success/warn/error; de-dupes identical (`type\|message`); queue cap 50 (drops oldest) | app.js:6037–6050 | | |
| P-502 | Stacking (max 3 visible) `TOAST_MAX=3`; rest queued; `drainToasts` refills as slots free (FB-02) | app.js:6030, 6051–6056 | | |
| P-503 | Toast render: tone bg {success emerald, error rose, warn amber, info slate}; icon {circle-check, circle-exclamation, triangle-exclamation, circle-info}; role alert(error)/status | app.js:6057–6066 | | |
| P-504 | Auto-dismiss / persist: errors 20 000ms TTL, others 4000ms (or `opts.duration`); optional inline "Undo" button | app.js:6064–6076 | | |
| P-505 | Live-Logs floating launcher (duplicate anchor of P-025): bottom-LEFT pill "◳ Live Logs" (z-index 30, purple gradient); opens `/logs.html` popup + POST `/api/app/open-logs` (Tauri native window) | index.html:1516–1550 | | |
| P-506 | Keep-alive heartbeat (duplicate anchor of P-024): `fetch('/api/app/ping')` every 4000ms | index.html:1509–1515 | | |
| P-507 | Account activity log modal `#logs-overlay` `openAccountLogs(username)`: shows overlay, GET `/api/accounts/{username}/logs`; "Loading…"; entry row = timestamp (`toLocaleString`) + message, level tone error→rose / warn→amber / else slate; empty "No activity logged for this account yet."; error rose; `closeLogs()` hides | app.js:1317–1340; index.html:1343–1352 | | |

---

## AP. Confirm dialog (FB-01) + modal infrastructure (FB-04) + boot

> Static confirm shell `index.html:1446–1469` (z-[55]).

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-508 | Sticky header offset sync `syncStickyOffsets`/`setupStickyHeader`: `--ssim-stick-top` = live toolbar height (ResizeObserver) so pinned column headers sit flush | app.js:6115–6130 | | |
| P-509 | Overlay closer registry `OVERLAY_CLOSERS`: Esc/registry routes each overlay through its REAL close fn (17 overlays incl. confirm=safe-cancel) | app.js:6138–6146 | | |
| P-510 | Modal open lifecycle `onModalOpen`: records trigger, scroll-lock, autofocus first field | app.js:6165–6179 | | |
| P-511 | Modal close lifecycle `onModalClose`: runs teardown hook, unlocks scroll, restores focus to trigger if still valid (`isRestorable`) | app.js:6182–6201 | | |
| P-512 | Overlay MutationObserver `observeOverlay`: wires hidden↔shown class toggles to open/close lifecycle (also for lazily-built overlays) | app.js:6205–6212 | | |
| P-513 | Modal infra setup `setupModalInfra`: focusin/pointerdown trigger tracking; Esc closes top overlay; Tab focus-trap | app.js:6214–6244 | | |
| P-514 | Per-modal teardown hooks `MODAL_TEARDOWNS`: stops tradeup/casket status pollers on close (H-FE-010) | app.js:6152, 6603, 6753 | | |
| P-515 | Confirm dialog `ssimConfirm(opts)`: async boolean; tones danger/spend/brand (icon+btn color); optional typed-word gate (disables OK until exact match); DEFENSIVE focus on Cancel (never destructive btn); backdrop/Esc = cancel | app.js:6251–6305 | 💰 | |
| P-516 | Sidebar resize `setupSidebarResize`: drag `#sidebar-resizer` (220–560px), persists `ssim.sidebarWidth`, double-click resets | app.js:6307–6346; index.html:483 | | |
| P-517 | Static event wiring `bindStaticEvents`: binds ALL nav/toolbar/modal/import/source-menu/currency controls | app.js:6348–6490 | | |
| P-518 | Price-source + currency split menus: src-menu (Steam/CSFloat) + cur-menu (USD/EUR); mutually-exclusive open; click-away closes | app.js:6473–6477; index.html:571 | | |
| P-519 | License gate (client-guard) `ensureLicensed`: bounded 8s probe of `/api/system/status`; licensed→sets footer version; 403/licensed:false→activation screen; unreachable→retry screen (no reload loop) | app.js:6510–6539 | | |
| P-520 | Backend-unreachable screen `showBackendUnreachableScreen`: "Can't reach SSIM's backend" + Retry; auto re-probes every 3s, reloads once backend confirms licensed | app.js:6544–6566 | | |
| P-521 | Timeout signal helper `timeoutSignal(ms)`: AbortSignal.timeout fallback (bounds hanging fetches S23/S32) | app.js:6503–6508 | | |
| P-522 | Startup splash `playStartupSplash`: one-shot brand bloom on unlock→dashboard (sessionStorage-gated, skipped under reduced-motion) | app.js:6951–6966; index.html:338 | | |

---

## AQ. Shared formatting / security / poller helpers + cross-cutting patterns

| # | Capability / behavior | Legacy ref | 💰 | Status |
|---|---|---|---|---|
| P-523 | HTML/attr escaping `escapeHtml`/`escapeAttr`: entity-encode `&<>"'` | app.js:6078–6081 | | |
| P-524 | Icon-host allow-list `safeIconUrl`: only steamstatic/akamaihd/steamcommunity https; else '' (anti IP-beacon) | app.js:6083–6093 | | |
| P-525 | Poller stall guard `pollerStalled(key,done)` / `resetPoller`: 180 000ms (3min) zero-progress → give up | app.js:6095–6106 | | |
| P-526 | Steam currency table `STEAM_CURRENCIES` (code→ISO+decimals, 46 entries); `curInfo` default EUR/2 | app.js:694–705 | | |
| P-527 | Currency toggle `setCurrency(cur)`: persists `ssim.currency`, FX-provenance tooltip on `#cur-btn` (fallback/stale rate warnings) | app.js:761–779 | | |
| P-528 | `itemColor(item)`: rarity hex (RARITY_HEX map, 8 tiers + Unknown), respects item.rarityColor | app.js:364–378 | | |
| P-529 | `rarityWeight(r)` / `statusGroup(item)` / `compareItems(a,b,key)`: sort by name/quantity/rarity/value/accounts/status (locked expiry tiebreak) | app.js:379–403 | | |
| P-530 | Bounded error-retry pattern (S17): every self-rescheduling poller keeps polling through transient status errors until POLL_STALL_MS, then gives up with a visible non-fabricated terminal line | app.js:4779, 5171, 5199, 5462, 5970, 6717, 6741, 6900, 6943 | | |
| P-531 | Search debounce pattern: Buy/Fbuy/CSFloat-BO item search debounce ~300–350ms; ignore stale in-flight results | app.js:6458, 6469, 4336 | | |
| P-532 | Post-action live refresh pattern: trade (9s deferred), buy, sell, mass-buy, casket all re-pull affected accounts / active-view-from-cache so sent/sold/moved items stop showing as owned (INV-E1) | app.js:5076, 5456, 5862, 6008, 6936 | 💰 | |
| P-533 | Modal close policy: static data modals close only via X / Cancel / Esc (no backdrop-close, prevents accidental loss); confirm + feature overlays DO backdrop-close (safe cancel) | app.js:6378, 6595 | | |

---

## Polling loops / cadences (reference summary)

| Loop | Cadence | Row |
|---|---|---|
| Keep-alive ping `/api/app/ping` | 4000ms | P-024 / P-506 |
| Price-fill watch `/api/pricing/status` | 2500ms poll; re-pull coalesced ≥10000ms; drain-stop; 15-min no-progress stop; 24-error dead stop | P-144 |
| System-status watch `/api/system/status` | 30000ms | P-146 |
| Refresh-All progress | 800ms | P-320 |
| Login poll `/status` | 1500ms | P-345 |
| Ban-check poll `/api/bans/status` | 1500ms | P-417 |
| Mass-trade poll `/api/trade/mass-status` | 1000ms | P-436 |
| Mass-sell poll `/api/market/sell-status` | 1000ms | P-451 |
| Folder-buy poll `/api/market/folder-buy-status` | 1200ms (900ms on done) | P-481 |
| SDA OTP bar | 200ms + re-fetch at expiry | P-388/P-389 |
| Trade-up exec poll `/api/tradeup/execute-status` | 1200ms | P-490 |
| Casket move poll `/api/casket/move-status` | 1000ms (2000ms on error) | P-500 |
| Poller stall ceiling (all self-rescheduling pollers) | 180 000ms zero-progress | P-525 |

---

*End of master parity contract — 533 rows across 43 view/feature groups, 125 money-affecting.*
