# Parity Fragment — Segment 2 (app.js:2250–4550)

Legacy source: `redesign/legacy_public/app.js` lines 2250–4550, plus the static markup those
functions drive in `redesign/legacy_public/index.html`. One row per user-facing capability/behavior.
💰 = money-affecting action. Refs are `app.js:NNNN` unless prefixed `index.html:NNNN`.

Money-format rules used throughout this segment (defined outside range but referenced here, for exact-copy fidelity):
- `fmtCents(cents)` — USD cents → display: `null`→`—`, else `fmtUsd(cents/100)`. USD shows `$1,234.56` (en-US), EUR shows `€1.234,56` (de-DE), 2 dp. (app.js:640–647)
- `fmtEurCents(cents)` — EUR cents → `€x,xx` de-DE, 2 dp, no FX. (app.js:649)
- `fmtMoneyMinor(minor, code)` — native Steam currency minor units → `Intl.NumberFormat` with per-currency locale + minor-digit count from `STEAM_CURRENCIES` (USD→en-US, EUR→de-DE, JPY 0 dp, etc.); `null/NaN`→`—`. (app.js:718–726)
- `stackValueCents(item)` = `(item.price||0) × (item.quantity||1)`. (app.js:679)

---

## A. Active Orders view (per-account sell listings + buy orders)

| # | Capability / behavior | Notes (exact copy where load-bearing) | Ref |
|---|---|---|---|
| 1 | Active Orders shell: two side-by-side sections "Active Buy Orders" + "Active Sell Orders" | `xl:grid-cols-2`; buy section success-green icon `fa-cart-arrow-down`, sell section listed-blue `fa-tag` | app.js:2250 |
| 2 | Empty state per section | Buy: "No active buy orders." Sell: "No active sell orders." | app.js:2259–2261 |
| 3 | Partial-fetch honesty banner | Amber banner when `data.partial`: "Order list may be incomplete (Steam/proxy error during fetch) — refresh to retry." | app.js:2264–2266 |
| 4 | Order icon render | 40×32 lazy `<img>`, `onerror` hides; placeholder box if no `iconUrl` | app.js:2270–2274 |
| 5 | 💰 Per-row Cancel button | Rose btn, title "Cancel this order on the Steam market" | app.js:2275–2278 |
| 6 | Per-row multi-select checkbox | violet `.order-check` | app.js:2279–2281 |
| 7 | Buy order row | Shows name, `#buyOrderId` (mono), price `fmtMoneyMinor(pricePerItemMinor,currency)`, qty text `remaining / total` or `remaining` | app.js:2282–2293 |
| 8 | Sell order row | Shows name, `#listingId` (mono), price `fmtMoneyMinor(...)`, `qty N` (default 1) | app.js:2294–2303 |
| 9 | Refresh button (orders view) | Re-runs `renderOrdersView(username, appId)` | app.js:2306–2308 |
| 10 | 💰 Single per-row cancel wiring | listing → `/api/market/cancel-listing`; buy → `/api/market/cancel-buy-order` | app.js:2311–2314 |
| 11 | Orders search filter | Filters `.order-row` by lowercased item name; hidden rows are unchecked; updates sel-count | app.js:2320–2329 |
| 12 | 💰 Cancel selected | Cancels only checked+visible rows | app.js:2333–2334, 2341–2344 |
| 13 | 💰 Cancel all (filtered) | Cancels currently-visible/filtered set (search "AK-47" then Cancel all = only those) | app.js:2335–2336, 2345–2348 |
| 14 | Selection count + disable | `orders-sel-count`; "Cancel selected" disabled when 0 checked | app.js:2349–2353 |
| 15 | 💰 Bulk-cancel confirm modal | `ssimConfirm` tone danger, title "Cancel orders", confirmLabel "Cancel N order(s)", body "Cancel N order(s) on the Steam market?" | app.js:2356–2361 |
| 16 | 💰 Bulk-cancel executes SEQUENTIALLY (anti-rate-limit) | Per-row spinner; on ok removes row, on fail restores btn | app.js:2362–2379 |
| 17 | Bulk-cancel result toast | `Cancelled OK[, N failed]`, type success or warn | app.js:2380 |
| 18 | 💰 Single-order cancel confirm | tone danger, "Cancel order" / body "Cancel this order on the Steam market?" | app.js:2385–2389 |
| 19 | Single-cancel toast | success "Order cancelled" / error `Cancel failed: <msg>` | app.js:2394, 2397 |
| 20 | Row removal + count/empty upkeep | Decrements section count span; when 0 remain shows "No active orders." | app.js:2402–2414 |

## B. Global Trade-Offers manager (sent + received, two-sided, batch)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 21 | Opens for CURRENTLY-SELECTED account only | Requires `state.activeUsername` else toast "Select an account first" (warn) | app.js:2424–2433 |
| 22 | Scope pill shows displayName/username; search reset on open | | app.js:2429–2430 |
| 23 | Close manager | Hides overlay | app.js:2434 |
| 24 | Loading state (both panes) | Spinner + "Loading offers live from Steam…" | app.js:2439–2442 |
| 25 | Load error (both panes) | Rose triangle + `err.message` | app.js:2448–2452 |
| 26 | Closed-mid-fetch guard | Bails if overlay hidden | app.js:2453 |
| 27 | Sort: active first, then newest by updatedAt/createdAt | | app.js:2460–2464 |
| 28 | Per-account load-failure surfacing | Errors joined `username: error · …`; toast single error or "N account(s) could not be loaded" (warn) | app.js:2467–2472 |
| 29 | Offer state → badge | 11 In escrow / 9 Needs confirm (amber); active Active (sky); 3 Accepted (emerald); 7 Declined (rose); 6/10 Cancelled; 5 Expired; 4 Countered; else stateName/History | app.js:2482–2494 |
| 30 | 💰 Coloured headline value | sent: `−<fmtCents(valueGiveCents)>` (rose); received: `+<fmtCents(valueReceiveCents)>` (emerald); empty if unpriced | app.js:2498–2504 |
| 31 | Per-side item thumbs | count pill + up to 5 real icons (bare items skipped), `+N` overflow; "nothing" italic when empty | app.js:2508–2519 |
| 32 | Partner label + Steam profile link | "To/From <partnerName|SteamId>", links `steamcommunity.com/profiles/<id>`; id suffix shown when name resolved | app.js:2523–2533 |
| 33 | 💰 Row actions | sent → Cancel (rose); received → Accept (emerald) + Decline (rose) | app.js:2535–2543 |
| 34 | Offer row markup | checkbox only when active; date `toLocaleDateString(month:'short',day:'numeric',year:'numeric')`; give→arrow→receive thumbs; optional quoted message | app.js:2545–2575 |
| 35 | Empty pane | error variant (rose) if `offersError`, else "No sent/received offers." | app.js:2577–2582 |
| 36 | Pane counts | `N active · M total` per side | app.js:2585–2591 |
| 37 | 💰 Single offer action confirm | tone: accept→`spend`, else `danger`; body "Accept/Decline/Cancel trade offer #<id>?" | app.js:2604–2615 |
| 38 | 💰 Single accept "unconfirmed" outcome | If `res.status==='unconfirmed'` → warn "Offer accepted — awaiting mobile confirmation"; else success `Offer accepted/declined/cancelled` | app.js:2618–2623 |
| 39 | Single action failure | error `Accept/Decline/Cancel failed: <msg>`, row un-busied | app.js:2624–2627 |
| 40 | 💰 Batch accept/decline/cancel | `/api/trade/offers-batch`; backend caps concurrency at 2 | app.js:2630–2644 |
| 41 | 💰 Batch confirm modal | title "Accept/Decline/Cancel N offer(s)", body with count | app.js:2634–2638 |
| 42 | Batch "unconfirmed" handling | ok rows removed; unconfirmed counted separately | app.js:2650–2659 |
| 43 | Batch result toast | `Accept: X ok[, N await mobile confirmation][, N failed]`; warn if fail/unconfirmed else success | app.js:2660–2664 |
| 44 | Row busy state | opacity .5, pointer-events none, buttons disabled | app.js:2667–2671 |
| 45 | Row removal syncs data + counts + empty | Splices `offersData`, recomputes `N active · M total` | app.js:2674–2686 |
| 46 | Multi-select: visible+active only | select-all, checked-row helpers | app.js:2688–2706 |
| 47 | Select-all indeterminate sync | header checkbox checked/indeterminate per side | app.js:2700–2706 |
| 48 | Selection counts + button enable | sent cancel-sel, recv accept-sel/decline-sel disabled at 0 | app.js:2707–2717 |
| 49 | Offers search (both sides) | Filters by partner SteamID / bot name / item names (`data-search`); unchecks hidden | app.js:2719–2728 |
| 50 | 💰 Static batch controls wiring | Sent: Cancel selected / Cancel all. Recv: Accept sel / Decline sel / Accept all / Decline all | app.js:2731–2743 · index.html:1391–1419 |
| 51 | Offers modal static layout | Two-sided (Sent left rose / Received right emerald), max-w 1400px h-90vh, per-side "Select all (active)" | index.html:1354–1426 |

## C. Aggregated views (env-master + global-master)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 52 | Aggregate over usernames | Merges stacks by marketHashName, sums items/locked-stacks/valueCents/walletUsd, counts loaded accounts | app.js:2746–2765 |
| 53 | Render aggregate header + stat bar; hides single-Refresh btn | | app.js:2767–2770 |
| 54 | 💰 Stat labels TF2 vs CS2 | TF2: "TF2 Items"/"TF2 Keys"; else "Items"/"Trade-Locked" | app.js:2773–2776 |
| 55 | 💰 Money stats (worth + wallet) | worth summed for BOTH games; `setMoneyStats(valueCents, walletUsd)` | app.js:2777–2779 |
| 56 | Aggregate empty state | "No TF2 inventories cached"/"No inventories in cache"/"No items" + "Click \"Refresh all\" to load inventories." | app.js:2781–2788 |
| 57 | Env-Master view | Title `<env name>` + "Portfolio" pill, "N account(s) in this environment" | app.js:2793–2803 |
| 58 | Env-Master "Check Bans" button | Opens ban checker for env accounts | app.js:2804–2809 |
| 59 | Global-Master view | Title "Global Master" + "Cross-environment" pill, "X of Y environments aggregated" | app.js:2812–2822 |
| 60 | Global-Master "Check Bans" + "Refresh all" buttons | | app.js:2823–2831 |
| 61 | Global-Master environment filter (facet toggles) | "Aggregate environments" chips per env with per-env account count `(N)`, checked-square icon, toggles `state.globalEnvs` and re-renders | app.js:2834–2848 |
| 62 | Placeholder ("No account selected") | Stat bar/toolbar/items hidden, custom msg | app.js:2851–2856 |

## D. Trade link (Feature 2)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 63 | "Get trade link" button (no cached URL) | `fa-link` | app.js:2862–2868 |
| 64 | Cached link display | `<code>` truncated to 280px + "Copy" button | app.js:2869–2874 |
| 65 | Fetch trade link | Loading state; on success stores + auto-copies; toast `Trade link fetched & copied[ (manual)]` | app.js:2882–2894 |
| 66 | Copy trade link | toast "Trade link copied" | app.js:2895–2900 |
| 67 | Clipboard fallback | Uses hidden textarea + `execCommand('copy')` if `navigator.clipboard` fails | app.js:2901–2910 |

## E. Item table, category tabs, faceted filters, sorting, selection

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 68 | Account category tab bar (GC) | Pills: All / Owned Items / Trade-Locked / Listed on Market with per-bucket counts; flat inv collapses to single "Items" pill | app.js:2923–2938 |
| 69 | "Active Orders" tab (always appended) | Teal `fa-receipt`, separated by divider; click sets `state.gcCat` and re-renders | app.js:2939–2949 |
| 70 | Windowed rendering for flat 10k list | Only visible rows (+10 buffer) between spacer `<tr>`s, recomputed on scroll; row height auto-measured; selection stays data-driven | app.js:2952–2995 |
| 71 | Per-row renderer (name/qty/rarity/value/status) | Item name colored by rarity; icon-with-lock; master row shows Accounts count instead of Exterior/Status | app.js:2997–3041 |
| 72 | Facet state per view | Persists per `invMode:env:user/folder/master`; `{status[], rarity[], maxCents}` | app.js:3043–3051 |
| 73 | Apply facets | status/rarity include-filters + `maxCents` (price < threshold) | app.js:3052–3062 |
| 74 | Toggle / clear facet values | Re-renders on each change | app.js:3063–3069 |
| 75 | Facet chip bar (TBL-03) | "Filter" label; status chips (Tradable success / Trade-Locked warn / Listed listed) only in flat views; rarity chips sorted by weight; `≤ <sym>` value input; "Clear (N)" when active | app.js:3070–3107 |
| 76 | Facet value input currency-aware | EUR converts via `usdToEur`; symbol `€`/`$` | app.js:3086–3104 |
| 77 | Render items table (master vs account columns) | master: Item/Qty/Accounts/Rarity/Value; account: Item/Qty/Exterior/Rarity/Value/Status | app.js:3109, 3137–3139 |
| 78 | "Select under value" control visibility | Only when rows selectable (account + folder-master) | app.js:3116–3117 |
| 79 | Trade-lock badge policy | Shown in flat lists (TF2/not-fully-refreshed CS2) and in the categorized Trade-Locked tab; never in master/aggregate | app.js:3120–3125 |
| 80 | Search filter (name + marketHashName) | Corrupt name fields coerced to avoid throw (S30) | app.js:3142–3145 |
| 81 | Sort (active/default) | With `state.sort`: `compareItems` asc/desc. Default: locked-first (account only) then qty desc | app.js:3147–3155 |
| 82 | Search-empty message | "No items for this search." toggled on filtered length | app.js:3157 · index.html:678 |
| 83 | Categorized GC bucket rendering | 3 strictly-separated groups w/ section headers in "All" ("Owned · freely tradable" success / "Trade-Locked" warn / "Listed on Steam Market" listed), each with `N item(s)` count; single-category shows "No items in this category." | app.js:3163–3189 |
| 84 | Qty badge | `×N` (bold pill) for N>1, else muted `×1` | app.js:3206–3210 |
| 85 | 💰 Value cell | `undefined`→`…` (Price loading…); `null`→`—` (no market price); else `fmtCents(stackValueCents)` + `(fmtCents(price)/ea.)` when qty>1 | app.js:3211–3216 |
| 86 | Rarity badge (colored) | | app.js:3217–3219 |
| 87 | Lock countdown text | "3 days, 14 h" / "5 h, 12 min" / "8 min" / "unlocked now" | app.js:3220–3230 |
| 88 | Compact lock badge | "7D" / "14H" / "32M" (null if free) | app.js:3231–3240 |
| 89 | Icon-with-lock overlay | Amber corner badge with title "Trade-Locked: unlocks in <countdown>" | app.js:3241–3254 |
| 90 | Status cell | locked → amber lock + countdown (title "Unlocks on <abs localeString>"); tradable → emerald "Tradable"; else rose "Locked" | app.js:3255–3263 |
| 91 | Sortable column header | Click toggles asc/desc; active arrow ▲/▼ in brand color | app.js:3265–3276 |
| 92 | Select-all header checkbox | title "Select all tradable" | app.js:3271 |
| 93 | Selection mode-awareness | account = assetId keys; folder/selection = marketHashName keys | app.js:3278–3297 |
| 94 | Per-key max selectable qty | master (agg) uses `sendable` portion only | app.js:3292–3297 |
| 95 | Per-row qty input (selected, maxSel>1) | number input min 1 max maxSel; syncs all matching `.sel-qty` | app.js:3024–3025, 3298–3305 |
| 96 | Targeted single-row re-render on toggle | Preserves scroll + siblings | app.js:3307–3328 |
| 97 | Select-all (data-driven, windowed-safe) | Selects all selectable rows incl. off-screen; repaints window | app.js:3329–3347 |
| 98 | Delegated change/click dispatchers | `.sel-check`, `.sel-qty`, header sort, `#select-all` | app.js:3348–3361 |
| 99 | 💰 Account send → concrete assetIds | Single-owner send | app.js:3363–3372 |
| 100 | 💰 Folder send → {username,assetId} refs across owners | Mass send fan-out | app.js:3373–3388 |
| 101 | Selection bar | Shows/hides; hides Sell button in TF2 view (market SELL is CS2-only); count text `N Item(s) · M Bot(s)/Stack(s)` | app.js:3391–3405 · index.html:639–653 |
| 102 | 💰 "Select under value" bulk-select | Threshold in display currency → USD cents; skips locked/untradable/unpriced; toast `Selected N item(s) under <sym><val>` or `No items under …` | app.js:3407–3433 · index.html:626–638 |

## F. Account selection + inventory refresh

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 103 | Select account | Sets account mode, resets gcCat/search/sort/selection, clears search box | app.js:3439–3447 |
| 104 | Table skeleton rows (FB-03) | 9 shimmer rows mirroring table geometry | app.js:3450–3466 |
| 105 | Dashboard env-tile skeletons | 6 shimmer tiles on initial load | app.js:3467–3481 |
| 106 | Inv loading skeleton toggle | Hides bare spinner, empties header, shows skeleton; on off with skel still present re-renders | app.js:3482–3497 |
| 107 | 💰 Refresh single account (CS2) | `/api/inventory/<u>?refresh=1`; complete fetch; toast `Inventory refreshed: N items · L locked · X listed` | app.js:3499–3520 |
| 108 | 💰 Refresh single account (TF2) | `/api/inventory-tf2/<u>?refresh=1`; toast `TF2 inventory refreshed: N items, K keys` | app.js:3505–3510 |
| 109 | Background price-fill watch after refresh | `watchPriceFill` re-pulls so prices/totals update without restart (PRICE-REFRESH) | app.js:3521–3523 |
| 110 | Refresh button loading + finalize | "Refreshing…"; on done patches sidebar balances in place | app.js:3502, 3526–3530 |
| 111 | Start Refresh-All job | POST `/api/inventory/refresh-all`; shows progress bar, resets End-task btn + failure list + stall poller | app.js:3534–3546 |
| 112 | Failed-accounts panel | Lists each failed `username – <shortError>`; persists until dismissed/next run | app.js:3547–3559 · index.html:426–437 |
| 113 | shortError truncation | Collapses whitespace, truncates >140 chars with `…` | app.js:3560–3564 |
| 114 | 💰 Refresh-All scope | global mode: only enabled accounts in selected envs (`state.globalEnvs`); else whole env; toast warn "No accounts…to refresh" if empty | app.js:3565–3580 |
| 115 | Refresh folder | `refreshFolder(usernames)` | app.js:3581–3583 |
| 116 | Refresh-All progress poller (800ms) | Bar %, `done/total` count, label "Cancelling…"/"Refreshing…"/"Done" | app.js:3584–3593 |
| 117 | Stall detection | If no progress (not cancelling) → warn "Refresh appears stuck (no progress) – stopping the live updater. Check the server." + hide progress | app.js:3594–3599 |
| 118 | Poll completion re-pull (CS2/TF2) | Re-fetches full inventory map, invalidates history / heals TF2 load-error | app.js:3603–3619 |
| 119 | Refresh-All completion toast | With failures: panel + `Refresh complete/ended: done/total – failed: names[+N]` (warn); else `Refresh complete/ended: done/total` (success/warn if cancelled) | app.js:3620–3631 |
| 120 | Poll transient-error tolerance (S17) | Bounded retry until continuous-error stall, then error toast + hide progress | app.js:3632–3640 |
| 121 | Soft hide/unhide account | toast `"<u>" hidden/shown` with **Undo** action; falls back to env master if hiding active account | app.js:3644–3653 |

## G. Edit account modal (per-account proxy override + details)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 122 | Open Edit Account | Prefills displayName; "Use environment proxy" ON by default; loads current proxy async | app.js:3656–3690 · index.html:955–1010 |
| 123 | Proxy field enable/grey by toggle | Disabled + opacity-40 while "Use env proxy" ON | app.js:3692–3698 |
| 124 | Proxy source hint line | "own proxy" (emerald) / "environment proxy" (slate) / "local proxy (local IP)" (amber) | app.js:3700–3705 |
| 125 | Close edit modal | Clears editUsername | app.js:3706 |
| 126 | Delete account (from edit) | Confirm danger "Remove account" (body: logged out, cache cleared, maFile kept, re-add via Import bots); DELETE; falls back to env master; toast `Account "<u>" removed` | app.js:3707–3728 |
| 127 | 💰/⚙ Save edit account | Sends displayName always; proxy only if intent changed (env/proxy:x/local); optional password + maFilePath; PATCH; re-pulls cached inv; toast "Account saved"; proxy change re-logs in | app.js:3729–3769 · index.html:982–993 |
| 128 | Change-credentials collapsible | `<details>` password + maFile (empty = unchanged) | index.html:982–990 |

## H. Add-account modal

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 129 | Open add account | Resets form, populates env select (defaults to active env) | app.js:3776–3781 · index.html:695–736 |
| 130 | Submit add account | POST `/api/accounts` (username/password/maFilePath/environmentId/proxy?); toast `Account "<u>" added`; reloads + selects | app.js:3783–3804 |
| 131 | Add-account fields | Environment select, Steam Username (req), Password (req), maFile path (req), Proxy override (optional, empty=env proxy) | index.html:702–727 |

## I. Account Login modal (QR / credentials import → Limited tier)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 132 | Open Login | Populates env, resets creds pane, defaults to QR tab | app.js:3809–3815 |
| 133 | Close Login | Stops poll, cancels both QR + cred sessions | app.js:3817–3826 |
| 134 | Tab switch (QR / Credentials) | Cancels the other method's session; QR auto-starts | app.js:3828–3845 · index.html:752–756 |
| 135 | QR start | POST `/api/accounts/login/qr/start`; sets QR image; polls if not terminal | app.js:3848–3862 |
| 136 | QR status stepper | waiting → scanned → approved → imported, current step spins | app.js:3864–3881 |
| 137 | QR terminal overlays | imported→done; expired→"QR code expired" + "New code"; error→msg + "Try again" | app.js:3866–3868 |
| 138 | Credentials submit (login + guard phases) | POST `/api/accounts/login/credentials`, then `/guard` with code | app.js:3895–3913 |
| 139 | Guard prompt | EmailCode: "Email Steam Guard code (sent to …@<detail>)"; else "Steam Guard mobile code"; hint about mobile approval | app.js:3915–3925 · index.html:778–782 |
| 140 | Cred status messages | error rose / info slate / success emerald | app.js:3937–3941 |
| 141 | Login poll (1500ms) | Polls `/status`; ignores transient/404 | app.js:3945–3952 |
| 142 | On imported | toast `Account "<u>" imported/updated as Limited`; reloads + selects | app.js:3954–3960 |
| 143 | Limited-tier explainer note | Static: imports as Limited; sell listings & trade offers queued pending confirmation; attach maFile to upgrade | index.html:788–794 |

## J. Attach-maFile modal (upgrade Limited → Full)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 144 | Open Attach maFile | Sets username on form | app.js:3963–3968 · index.html:799–821 |
| 145 | Submit attach | POST `/attach-mafile`; toast `"<u>" upgraded to Full`; reloads | app.js:3970–3983 |

## K. CSFloat workspace modal (per-account marketplace)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 146 | 💰 CSFloat USD format | `csfUsd(cents)` = `$` + `(cents/100).toLocaleString('en-US', 2 dp)` | app.js:3992 |
| 147 | CSFloat icon host allow-list | `csfImg` builds Steam economy URL or accepts full URL, always through `safeIconUrl` (#29) | app.js:3997–4001 |
| 148 | Open CSFloat | Loads config (experimental) + per-account key; renders tabs; opens dashboard or settings (if no key) | app.js:4008–4022 · index.html:823–836 |
| 149 | Tab bar | Core: Dashboard / My Listings / Market + Settings; experimental adds Buy Orders / Trades / Inventory | app.js:4179–4187 |
| 150 | Switch tab | Non-settings tabs need key → `csfNeedKey` prompt | app.js:4189–4197 |
| 151 | "No API key" prompt | Empty state + "Open Settings" | app.js:4195–4197 |
| 152 | 💰 Dashboard | Balance `csfUsd(bal)`, Active listings count, Account name; quick links to Market/My listings | app.js:4200–4222 |
| 153 | 💰 My Listings | Rows: icon, name, float, editable price input, **Update price**, **Delist**, current `csfUsd(price)` (min 0.03) | app.js:4224–4243 |
| 154 | 💰 Market search | Filters: name, min $, max $, sort (best_deal/lowest_price/highest_price/most_recent/lowest_float/highest_float); paginates via cursor "Load more" | app.js:4245–4290 |
| 155 | 💰 Market card + Buy | icon, name, wear+float, `csfUsd(price)`, **Buy** (teal) | app.js:4291–4303 |
| 156 | 💰 Buy Orders (exp) | Place-order form (item search, max $, qty); list rows with **cancel**; empty "No active buy orders." | app.js:4305–4324 |
| 157 | Buy-order item search-as-you-type | Debounced 300ms; hits `/api/market/search?...&appId=730`; dropdown fills exact `marketHashName`; deliberately hides Steam price | app.js:4326–4357 |
| 158 | 💰 Trades (exp) + Auto-accept toggle | Auto-accept ON/OFF; disabled+explainer when account Limited (no identity_secret); trade rows w/ `csfUsd(price)` | app.js:4367–4393 |
| 159 | 💰 Inventory (exp) — list item | Rows: icon, name, float, price input (min 0.03), **List**; empty "No tradable CS2 items found on CSFloat." | app.js:4395–4414 |
| 160 | Settings — API key | password field (shows `configured (ending …tail)` when set); Save; Clear (if configured); note stored encrypted per-account | app.js:4416–4436 |
| 161 | Settings — Experimental toggle | ON/OFF; enables Buy Orders/Trades/Inventory + auto-accept | app.js:4431–4434, 4480–4483 |
| 162 | CSFloat delegation | tab clicks + `[data-csf]` action dispatch | app.js:4438–4460 |
| 163 | 💰 Save API key | PUT `/key`; validating msg; `Key saved & validated.`/warning; jumps to dashboard | app.js:4463–4474 |
| 164 | Clear API key | Confirm danger; DELETE `/key`; toast "CSFloat key cleared" | app.js:4475–4479 |
| 165 | Toggle experimental | PUT `/api/csfloat/config` | app.js:4480–4483 |
| 166 | 💰 Toggle auto-accept | PUT `/auto-accept`; toast enabled/disabled; state derived from `data-enabled` not button text | app.js:4484–4490 |
| 167 | 💰 Delist listing | Confirm danger; DELETE `/listings/<id>`; toast "Listing removed" | app.js:4491–4495 |
| 168 | 💰 Edit price | requires ≥ $0.03; PATCH `/listings/<id>`; toast "Price updated" | app.js:4496–4502 |
| 169 | 💰 Buy on CSFloat | Confirm tone spend "Buy for <csfUsd>", body from CSFloat balance; POST `/buy`; toast "Purchase sent" | app.js:4503–4508 |
| 170 | 💰 Create buy order | requires name + max price; POST `/buy-orders`; toast "Buy order placed" | app.js:4509–4515 |
| 171 | 💰 Cancel buy order | Confirm danger; DELETE `/buy-orders/<id>`; toast "Buy order cancelled" | app.js:4516–4520 |
| 172 | 💰 List asset | requires asset + price ≥ $0.03; Confirm brand "List for $X"; POST `/listings` type buy_now; toast "Listing created" | app.js:4521–4529 |
| 173 | CSFloat skeleton/error/empty/msg helpers | pulse skeletons; error w/ Retry; tinted status messages | app.js:4002–4006 |

## L. SDA Overview modal (Steam Guard OTP + confirmations)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 174 | Open SDA | Sets account, starts OTP roll, loads confirmations | app.js:4034–4041 · index.html:838–872 |
| 175 | Close SDA | Clears OTP + bar timers | app.js:4043–4048 |
| 176 | OTP auto-roll (30s) | GET `/otp`; big 5-char code, animated countdown bar (200ms), re-fetch just past expiry | app.js:4050–4083 · index.html:849–859 |
| 177 | OTP error handling | Shows `—`, toast once per error streak, bounded 5s guarded retry (S17); heals on recovery | app.js:4072–4082 |
| 178 | Copy OTP | Copies live-DOM code (never `·····`/`—`); "Copy"→"Copied" 1.2s | app.js:4085–4096 |
| 179 | Refresh confirmations | GET `/confirmations`; loading spinner; error w/ Refresh | app.js:4098–4113 |
| 180 | Render confirmations | Per-conf: checkbox, type icon (trade/market/shield), title, `typeName · gives X · gets Y`, **Approve**; empty "No pending confirmations." | app.js:4115–4135 · index.html:860–869 |
| 181 | Confirmation multi-select | selected ids; count + "Approve selected (N)" disable at 0 | app.js:4137–4147 · index.html:863–866 |
| 182 | 💰 Respond to confirmations (single/selected/all) | POST `/confirmations/respond {ids,accept,all}`; toast `Approved/Denied N confirmation(s)[, N failed]`; always re-fetch canonical | app.js:4149–4159 |

## M. Clean browser (isolated proxied ephemeral session)

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 183 | Open clean browser | Btn "Opening…" spinner; POST `/open-browser`; surfaces warnings as info toasts; toast `Opened <u> in a browser (proxy X, authed / LOCAL IP)` | app.js:4161–4177 |

## N. New/Edit environment modal

| # | Capability / behavior | Notes | Ref |
|---|---|---|---|
| 184 | Open env modal (create/edit) | Edit: title "Edit environment", loads real saved proxy; create: "New environment", proxy placeholder | app.js:4532–4567 · index.html:874–903 |
| 185 | Close env modal | | app.js:4568 |
| 186 | Submit env (create/edit) | Edit: PATCH (proxy only if changed, cleared→local IP); create: POST; toast "Environment updated" / `Environment "<name>" created` | app.js:4569–4594 |
| 187 | Proxy format helper text | Static: host:port:user:pass · user:pass@host:port · full URL ("Any format works…") | index.html:891–893 |
| 188 | Delete environment (start of confirm) | Confirm danger "Delete environment" body "Only possible when it no longer contains any accounts." | app.js:4595–4599 |

## O. Cross-cutting formatting / state rules referenced in this range

| # | Rule | Notes | Ref |
|---|---|---|---|
| 189 | Rarity weight ordering | Facet rarity chips + default sort use `rarityWeight` | app.js:3083 (helper at :385) |
| 190 | TF2 key counting | `countTf2Keys` drives the "TF2 Keys" stat | app.js:2776 (helper at :518) |
| 191 | Multi-owner selection index | `aggItemByName` O(1) lookup for mass send/sell/buy fan-out | app.js:3286–3288 |
| 192 | Wallet USD conversion | `walletToUsd`: USD(1) direct, EUR(3)/usdToEur, 0 is 0 in any currency, unknown→null | app.js:2754 (helper at :654) |
