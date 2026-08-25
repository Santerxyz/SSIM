// ════════════════════════════════════════════════════════════════════════════
//  SSIM — Santer Steam Inventory Manager · Frontend (Vanilla JS)
// ════════════════════════════════════════════════════════════════════════════

const API = '';

const state = {
  nav: 'dashboard',             // 'dashboard'|'portfolios'|'inventories'|'accounts'|'batch' — top-level rail destination (W1_10)
  screen: 'dashboard',          // (Inventories-internal) 'dashboard'(env-picker) | 'inventory'(drill)
  invMode: 'account',           // 'account' | 'env-master' | 'global' | 'folder' | 'selection'
  selectedAccounts: new Set(),  // usernames checkbox-picked in the sidebar (multi-select scope)
  preSelection: null,           // view snapshot {invMode,activeUsername,activeFolder} to restore when selection clears
  environments: [],
  activeEnv: null,              // current environment id
  activeFolder: null,           // current folder id (folder-master view)
  tree: { folders: [], accounts: [] },
  allAccounts: [],              // flat across ALL environments (dropdowns, master, counts)
  inventories: {},              // username → CS2 inventory (from persistent cache)
  tf2Inventories: {},           // username → TF2 inventory (lazy-loaded on first toggle)
  wallets: {},                  // lcUser → { wallet:{currency,balance}, ts } – GLOBAL Steam wallet, NEWEST across games
  tf2Loaded: false,             // whether the TF2 cache has been fetched at least once
  tf2LoadError: null,           // H-FE-001: error message if the first TF2 fetch failed – a failed load must
                                //           render as a distinct error+Retry panel, never as an empty inventory
  game: 'cs2',                  // 'cs2' | 'tf2' – which inventory the views show
  globalEnvs: new Set(),        // selected environment ids for the Global Master
  aggItems: [],                 // last aggregated items WITH owners (folder-master selection source)
  collapsed: loadCollapsed(),   // Set<folderId> – persisted in localStorage
  activeUsername: null,
  selection: {},                // selection key (assetId | marketHashName) → qty
  tradeUrls: {},                // username → fetched trade URL
  folderModal: null,            // { mode:'create', parentId } | { mode:'rename', id }
  envModal: null,               // { mode:'create' } | { mode:'edit', id }
  envProxyInitial: '',          // raw saved env proxy the field was pre-filled with (change-detection)
  moveUsername: null,
  moveUsernames: null,   // batch multi-select move scope (array of usernames)
  banResult: null,       // last Ban Checker result { accounts, totals } for the results modal
  banTimer: null,        // H-TRD-033: setTimeout handle for the ban-check status poll loop
  // Active Orders tab (single account OR a folder / multi-selection):
  //   run       – paint token; an in-flight fetch/poll of an older paint is discarded
  //   key/rows  – the scope the cached rows belong to + the rows themselves (re-render ⇒ repaint,
  //               never a silent refetch of a whole folder)
  //   autoStart – set ONLY by an explicit tab click / Refresh, so an incidental re-render
  //               (ticking another sidebar checkbox) can never launch a fleet-wide live scan
  //   cursor    – how many scanned accounts the client has already received (server-side slice)
  // `game` pins Active Orders to a game independently of the Inventories tab. null ⇒ follow
  // state.game, so nothing changes for someone who never touches the control. It exists because
  // the BUY modal has its own game selector: buying a TF2 item while the tab reads CS2 filed a
  // 440 order that this view then hid, making a real order look like it was never placed.
  orders: { run: 0, timer: null, key: '', rows: null, autoStart: false, cursor: 0, game: null },
  editUsername: null,
  editProxyInitial: '',         // raw saved proxy the edit field was pre-filled with (change-detection)
  editUseEnvInitial: true,      // was "Use environment proxy" on when the edit modal opened (change-detection)
  search: '',
  sort: null,
  accountSort: 'default',       // sidebar account order: 'default' | 'balance-desc' | 'balance-asc'
  refreshTimer: null,
  lastFailedUsernames: [],      // accounts that failed the last refresh (the panel's Retry re-runs exactly these)
  gcCat: 'all', // active GC category filter (all | tradable | tradelocked | listed)
  massTimer: null,
  currency: localStorage.getItem('ssim.currency') || 'EUR',  // 'EUR' | 'USD'
  priceSource: localStorage.getItem('ssim.priceSource') || 'steam', // Feature 3: 'steam' | 'csfloat'
  dashSummary: null,            // W1_12: last GET /api/dashboard/summary payload, or null
  gamesCache: {},               // W2_20: username → { username, count, games:[{appId,name,playtimeMinutes,iconUrl}], scannedAt }
  profileCache: {},             // W2_20: username → { name, realName, summary, avatarUrl, privacy, partial }
  accountsBusy: {},             // W2_20: username → 'wallet'|'profile'|'games'|null (per-sub-card spinner)
  accountsUser: null,           // W2_20: selected account in the Accounts module (null → aggregate table)
  accountsEditProfile: null,    // W2_20: username whose profile edit form is open
  accountsGameFilter: '',       // W2_20: owned-games filter text
  accountsAddFunds: null,       // W3_31: username whose Add-Funds (wallet-code) form is open
  accEnv: null,                 // Accounts module: selected environment (null → env-tile picker)
  accSel: new Set(),            // Accounts module: multi-selected usernames (mass move)
  paysafeEnabled: false,        // W4_40: is the paysafecard top-up flag on? (probed once)
  accountsPaysafe: null,        // W4_40: username whose single-account paysafecard form is open
  accPaysafeSession: null,      // W4_40: the single-account paysafecard session (open→verify)
  accTree: { targets: null, expanded: new Set(), search: '', _loading: false }, // Accounts sidebar folder tree data/state
  batch: { registry: [], scopeEnvs: new Set(), scopeFolders: new Set(), scopeAccounts: new Set(), expanded: new Set(), search: '', targets: null, jobType: null, params: {}, status: null, timer: null, history: [], dist: { sel: { envs: new Set(), folders: new Set(), accounts: new Set(), expanded: new Set(), search: '' }, amount: '', minItem: '', game: null, include: [], exclude: [], picker: null, pickerSearch: '', showPool: false, plan: null, status: null, timer: null }, paysafe: { session: null, busy: false, timer: null, tierMinor: 0, freeAmount: '', _attached: false }, _loading: false, _targetsLoading: false, _targetsGen: 0, _histLoaded: false }, // W3_32 (micro-selection) + inline Distribute + sequential paysafecard jobs
  paysafeTiers: {},             // K3: username → { currency, tiers[] } | 'loading' | { error } — Steam's real top-up amount options
  prime: { rows: {}, loaded: false, _loading: false },   // 1.5.1: lowercased username → CS2 Prime ownership row (server cache, read-only)
  proxies: { rules: [], authoritative: false, loaded: false, _loading: false, _gen: 0, modal: null, targets: null, preview: null, previewSearch: '', previewFilter: 'all' }, // Proxies module (v5)
  usdToEur: 0.92,               // live rate from /api/exchange-rate (fallback 0.92)
};

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('cs2.collapsed') || '[]')); }
  catch { return new Set(); }
}
function saveCollapsed() { localStorage.setItem('cs2.collapsed', JSON.stringify([...state.collapsed])); }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  // top-level nav rail (W1_10)
  navRail:          $('nav-rail'),
  appSidebar:       $('app-sidebar'),
  sidebarResizer:   $('sidebar-resizer'),
  // sidebar context
  sidebarNav:       $('sidebar-nav'),
  btnBackDashboard: $('btn-back-dashboard'),
  btnGlobalMaster:  $('btn-global-master'),   // now lives in the dashboard header
  envContext:       $('env-context'),
  envName:          $('env-name'),
  envProxy:         $('env-proxy'),
  btnEnvMaster:     $('btn-env-master'),
  btnAddAccount:    $('btn-add-account'),
  btnAddFolder:     $('btn-add-folder'),
  btnRefreshAll:    $('btn-refresh-all'),
  refreshProgress:  $('refresh-progress'),
  refreshLabel:     $('refresh-label'),
  refreshCount:     $('refresh-count'),
  refreshBar:       $('refresh-bar'),
  refreshEnd:       $('refresh-end'),
  refreshFailed:      $('refresh-failed'),
  refreshFailedList:  $('refresh-failed-list'),
  refreshFailedClose: $('refresh-failed-close'),
  historyWrap:        $('history-wrap'),
  historyChart:       $('history-chart'),
  historyLegend:      $('history-legend'),
  btnGameCs2:         $('btn-game-cs2'),
  btnGameTf2:         $('btn-game-tf2'),
  accountsLabel:    $('accounts-label'),
  accountList:      $('account-list'),
  accountCount:     $('account-count'),
  // screens
  screenDashboard:  $('screen-dashboard'),
  screenInventory:  $('screen-inventory'),
  screenSummary:    $('screen-summary'),
  screenPortfolios: $('screen-portfolios'),
  screenAccounts:   $('screen-accounts'),
  screenBatch:      $('screen-batch'),
  summaryHeader:    $('summary-header'),
  portfoliosHeader: $('portfolios-header'),
  portfoliosBody:   $('portfolios-body'),
  gameToggle:       $('game-toggle'),
  accountsHeader:   $('accounts-header'),
  accountsBody:     $('accounts-body'),
  batchHeader:      $('batch-header'),
  batchBody:        $('batch-body'),
  screenProxies:    $('screen-proxies'),
  proxiesHeader:    $('proxies-header'),
  proxiesBody:      $('proxies-body'),
  screenActivity:   $('screen-activity'),
  activityBody:     $('activity-body'),
  navActivityBadge: $('nav-activity-badge'),
  envTiles:         $('env-tiles'),
  envEmpty:         $('env-empty'),
  btnNewEnv:        $('btn-new-env'),
  btnBulkImport:    $('btn-bulk-import'),
  // inventory screen
  mainHeader:   $('main-header'),
  breadcrumb:   $('breadcrumb'),
  statBar:      $('stat-bar'),
  statItems:    $('stat-items'),
  statLocked:   $('stat-locked'),
  statItemsLabel:  $('stat-items-label'),
  statLockedLabel: $('stat-locked-label'),
  statLockedWarn:  $('stat-locked-warn'),
  statValue:       $('stat-value'),
  statValueLabel:  $('stat-value-label'),
  statWallet:      $('stat-wallet'),
  statWalletLabel: $('stat-wallet-label'),
  currencyLabel:   $('currency-label'),
  srcBtn:          $('src-btn'),
  srcLogo:         $('src-logo'),
  srcLabel:        $('src-label'),
  curBtn:          $('cur-btn'),
  btnLoad:      $('btn-load'),
  gcCatTabs:      $('gc-cat-tabs'),
  globalFilter: $('global-filter'),
  facetBar:     $('facet-bar'),
  emptyState:   $('empty-state'),
  invLoading:   $('inv-loading'),
  itemsWrap:    $('items-wrap'),
  itemsHead:    $('items-head'),
  itemsBody:    $('items-body'),
  ordersWrap:   $('orders-wrap'),
  searchEmpty:  $('search-empty'),
  toolbar:      $('toolbar'),
  searchInput:  $('search-input'),
  selectionBar:   $('selection-bar'),
  selectionCount: $('selection-count'),
  btnClearSel:    $('btn-clear-selection'),
  btnSendSel:     $('btn-send-selected'),
  btnSellSel:     $('btn-sell-selected'),
  // Phase 2: master value-filter + account search/quick-filter
  valueFilter:      $('value-filter'),
  valueFilterInput: $('value-filter-input'),
  valueFilterBtn:   $('value-filter-btn'),
  valueFilterCur:   $('value-filter-cur'),
  accountTools:     $('account-tools'),
  accountSearch:    $('account-search'),
  accountFilter:    $('account-filter'),
  accountSort:      $('account-sort'),
  toastStack:   $('toast-stack'),
  // trade-offers manager
  offersOverlay:  $('offers-overlay'),
  offersClose:    $('offers-close'),
  offersRefresh:  $('offers-refresh'),
  offersSearch:   $('offers-search'),
  offersScope:    $('offers-scope'),
  offersSentList: $('offers-sent-list'),
  offersRecvList: $('offers-recv-list'),
  offersSentCount: $('offers-sent-count'),
  offersRecvCount: $('offers-recv-count'),
  offersSentSelAll: $('offers-sent-selall'),
  offersRecvSelAll: $('offers-recv-selall'),
  offersSentCancelSel: $('offers-sent-cancel-selected'),
  offersSentCancelAll: $('offers-sent-cancel-all'),
  offersSentSelCount:  $('offers-sent-sel-count'),
  offersRecvAcceptSel: $('offers-recv-accept-selected'),
  offersRecvDeclineSel:$('offers-recv-decline-selected'),
  offersRecvAcceptAll: $('offers-recv-accept-all'),
  offersRecvDeclineAll:$('offers-recv-decline-all'),
  offersRecvSelCount:  $('offers-recv-sel-count'),
  // add-account modal
  modalOverlay:  $('modal-overlay'),
  modalClose:    $('modal-close'),
  modalCancel:   $('modal-cancel'),
  modalSubmit:   $('modal-submit'),
  addForm:       $('add-form'),
  addEnv:        $('add-env'),
  // account-login modal (Feature 1)
  btnAccountLogin: $('btn-account-login'),
  loginOverlay:    $('login-overlay'),
  loginClose:      $('login-close'),
  loginEnv:        $('login-env'),
  loginPaneQr:     $('login-pane-qr'),
  loginQrImg:      $('login-qr-img'),
  loginQrOverlay:  $('login-qr-overlay'),
  loginQrStatus:   $('login-qr-status'),
  loginCredForm:   $('login-cred-form'),
  loginGuard:      $('login-guard'),
  loginGuardLabel: $('login-guard-label'),
  loginGuardInput: $('login-guard-input'),
  loginCredMsg:    $('login-cred-msg'),
  loginCredSubmit: $('login-cred-submit'),
  loginCredSubmitLabel: $('login-cred-submit-label'),
  // attach-maFile modal (Feature 1)
  attachOverlay:   $('attach-overlay'),
  attachClose:     $('attach-close'),
  attachCancel:    $('attach-cancel'),
  attachForm:      $('attach-form'),
  attachUsername:  $('attach-username'),
  attachSubmit:    $('attach-submit'),
  // CSFloat workspace (Feature 2)
  csfloatOverlay:  $('csfloat-overlay'),
  csfloatClose:    $('csfloat-close'),
  csfloatAccount:  $('csfloat-account'),
  csfloatTabs:     $('csfloat-tabs'),
  csfloatBody:     $('csfloat-body'),
  // SDA overview (Phase 6)
  sdaOverlay:        $('sda-overlay'),
  sdaClose:          $('sda-close'),
  sdaAccount:        $('sda-account'),
  sdaOtp:            $('sda-otp'),
  sdaOtpBar:         $('sda-otp-bar'),
  sdaOtpCopy:        $('sda-otp-copy'),
  sdaOtpCopyLabel:   $('sda-otp-copy-label'),
  sdaConfBody:       $('sda-conf-body'),
  sdaConfCount:      $('sda-conf-count'),
  sdaConfSelCount:   $('sda-conf-sel-count'),
  sdaConfApproveSel: $('sda-conf-approve-sel'),
  sdaConfApproveAll: $('sda-conf-approve-all'),
  sdaConfRefresh:    $('sda-conf-refresh'),
  // environment modal
  envOverlay:    $('env-overlay'),
  envClose:      $('env-close'),
  envCancel:     $('env-cancel'),
  envForm:       $('env-form'),
  envNameInput:  $('env-name-input'),
  envModalTitle: $('env-modal-title'),
  envSubmitLabel:$('env-submit-label'),
  // mass-send progress
  massProgress:  $('mass-progress'),
  massBar:       $('mass-bar'),
  massCount:     $('mass-count'),
  massDetail:    $('mass-detail'),
  massEnd:       $('mass-end'),
  // market-sell modal + progress
  sellOverlay:     $('sell-overlay'),
  sellClose:       $('sell-close'),
  sellCancel:      $('sell-cancel'),
  sellForm:        $('sell-form'),
  sellSubmit:      $('sell-submit'),
  sellSummary:     $('sell-summary'),
  sellFrom:        $('sell-from'),
  sellPreviewBtn:  $('sell-preview-btn'),
  sellPreviewResult: $('sell-preview-result'),
  // per-account currency labelling (prices are native, not EUR)
  sellPriceLabel:   $('sell-price-label'),
  sellCustomSymbol: $('sell-custom-symbol'),
  sellUndercutHint: $('sell-undercut-hint'),
  sellCurrencyNote: $('sell-currency-note'),
  // market-buy modal
  btnBuyMarket:  $('btn-buy-market'),
  buyOverlay:    $('buy-overlay'),
  buyClose:      $('buy-close'),
  buyCancel:     $('buy-cancel'),
  buyForm:       $('buy-form'),
  buySubmit:     $('buy-submit'),
  buyAccount:    $('buy-account'),
  buyWallet:     $('buy-wallet'),
  buyGame:       $('buy-game'),
  buyQty:        $('buy-qty'),
  buyMax:        $('buy-max'),
  buyQtyEcho:    $('buy-qty-echo'),
  buyName:       $('buy-name'),
  buyPrice:      $('buy-price'),
  buyCur:        $('buy-cur'),
  buyTotal:      $('buy-total'),
  buyResult:     $('buy-result'),
  buyAccountList:$('buy-account-list'),
  buyPriceFetch: $('buy-price-fetch'),
  buyNameResults:$('buy-name-results'),
  // folder mass-buy modal
  fbuyOverlay:   $('fbuy-overlay'),
  fbuyClose:     $('fbuy-close'),
  fbuyCancel:    $('fbuy-cancel'),
  fbuyForm:      $('fbuy-form'),
  fbuySubmit:    $('fbuy-submit'),
  fbuySummary:   $('fbuy-summary'),
  fbuyGame:      $('fbuy-game'),
  fbuyName:      $('fbuy-name'),
  fbuyNameResults: $('fbuy-name-results'),
  fbuyPrice:     $('fbuy-price'),
  fbuyPriceFetch:$('fbuy-price-fetch'),
  fbuyProgress:  $('fbuy-progress'),
  fbuyPhase:     $('fbuy-phase'),
  fbuyBar:       $('fbuy-bar'),
  fbuyCount:     $('fbuy-count'),
  fbuyEnd:       $('fbuy-end'),
  fbuyResults:   $('fbuy-results'),
  sellCustomRow:   $('sell-custom-row'),
  sellCustomPrice: $('sell-custom-price'),
  sellProgress:    $('sell-progress'),
  sellBar:         $('sell-bar'),
  sellCount:       $('sell-count'),
  sellDetail:      $('sell-detail'),
  sellEnd:         $('sell-end'),
  // folder modal
  folderOverlay: $('folder-overlay'),
  folderClose:   $('folder-close'),
  folderCancel:  $('folder-cancel'),
  folderForm:    $('folder-form'),
  folderName:    $('folder-name'),
  folderTitle:   $('folder-modal-title'),
  // move modal
  moveOverlay:   $('move-overlay'),
  moveClose:     $('move-close'),
  moveCancel:    $('move-cancel'),
  moveForm:      $('move-form'),
  moveEnv:       $('move-env'),
  moveFolder:    $('move-folder'),
  moveLabel:     $('move-account-label'),
  // ban checker modal
  banOverlay:    $('ban-overlay'),
  banClose:      $('ban-close'),
  banScope:      $('ban-scope'),
  banSummary:    $('ban-summary'),
  banBody:       $('ban-body'),
  // edit-account modal
  editOverlay:      $('edit-overlay'),
  editClose:        $('edit-close'),
  editCancel:       $('edit-cancel'),
  editForm:         $('edit-form'),
  editSubmit:       $('edit-submit'),
  editDelete:       $('edit-delete'),
  editLabel:        $('edit-account-label'),
  editDisplayName:  $('edit-displayname'),
  editPassword:     $('edit-password'),
  editMafile:       $('edit-mafile'),
  // trade modal
  tradeOverlay:    $('trade-overlay'),
  tradeClose:      $('trade-close'),
  tradeCancel:     $('trade-cancel'),
  tradeForm:       $('trade-form'),
  tradeSubmit:     $('trade-submit'),
  tradeSummary:    $('trade-summary'),
  tradeFrom:       $('trade-from'),
  tradeInternal:   $('trade-internal-block'),
  tradeExternal:   $('trade-external-block'),
  tradeTargetUrl:  $('trade-target-url'),
  tradeEnv:        $('trade-env'),
  tradeFolder:     $('trade-folder'),
  tradeSearch:     $('trade-search'),
  tradeList:       $('trade-recipient-list'),
  tradeListEmpty:  $('trade-recipient-empty'),
  tradeListCount:  $('trade-recipient-count'),
  // bulk-import modal
  bulkOverlay:     $('bulk-overlay'),
  bulkClose:       $('bulk-close'),
  bulkCancel:      $('bulk-cancel'),
  bulkSubmit:      $('bulk-submit'),
  bulkSubmitLabel: $('bulk-submit-label'),
  bulkEnv:         $('bulk-env'),
  bulkFolder:      $('bulk-folder'),
  bulkList:        $('bulk-list'),
  bulkSelectAll:   $('bulk-select-all'),
  bulkCsv:         $('bulk-csv'),
  bulkCsvStatus:   $('bulk-csv-status'),
  bulkVaultFile:   $('bulk-vault-file'),
  bulkVaultPw:     $('bulk-vault-pw'),
  bulkVaultImport: $('bulk-vault-import'),
  bulkVaultStatus: $('bulk-vault-status'),
  // account logs modal (Phase 4)
  logsOverlay:     $('logs-overlay'),
  logsClose:       $('logs-close'),
  logsAccount:     $('logs-account'),
  logsBody:        $('logs-body'),
};

// ════════════════════════════════════════════════════════════════════════════
//  Rarity colour + weight + sorting
// ════════════════════════════════════════════════════════════════════════════

const RARITY_HEX = {
  'Consumer Grade': '#b0c3d9', 'Base Grade': '#b0c3d9',
  'Industrial Grade': '#5e98d9', 'High Grade': '#5e98d9',
  'Mil-Spec Grade': '#4b69ff', 'Distinguished': '#4b69ff',
  'Restricted': '#8847ff', 'Exceptional': '#8847ff',
  'Classified': '#d32ce6', 'Remarkable': '#d32ce6',
  'Covert': '#eb4b4b', 'Superior': '#eb4b4b',
  'Extraordinary': '#e4ae39', 'Exotic': '#e4ae39',
  'Master': '#e4ae39', 'Contraband': '#e4ae39', 'Unknown': '#9ca3af',
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function itemColor(item) {
  if (item.rarityColor && HEX_RE.test(item.rarityColor)) return item.rarityColor;
  return RARITY_HEX[item.rarity] || RARITY_HEX['Unknown'];
}
const RARITY_WEIGHT = {
  'Consumer Grade': 1, 'Base Grade': 1, 'Industrial Grade': 2, 'High Grade': 2,
  'Mil-Spec Grade': 3, 'Distinguished': 3, 'Restricted': 4, 'Exceptional': 4,
  'Classified': 5, 'Remarkable': 5, 'Covert': 6, 'Superior': 6,
  'Extraordinary': 7, 'Exotic': 7, 'Master': 7, 'Contraband': 8, 'Unknown': 0,
};
function rarityWeight(r) { return RARITY_WEIGHT[r] ?? 0; }
function statusGroup(item) { return item.tradeLockExpiry ? 2 : (item.tradable ? 1 : 0); }
function compareItems(a, b, key) {
  switch (key) {
    case 'name':     return (a.name || '').localeCompare(b.name || ''); // coerce: a malformed cached row has no name (S30)
    case 'quantity': return (a.quantity || 1) - (b.quantity || 1);
    case 'rarity':   return rarityWeight(a.rarity) - rarityWeight(b.rarity);
    case 'value':    return stackValueCents(a) - stackValueCents(b);
    case 'accounts': return (a.accounts?.size || 0) - (b.accounts?.size || 0);
    case 'status': {
      const g = statusGroup(a) - statusGroup(b);
      if (g !== 0) return g;
      const ta = a.tradeLockExpiry ? new Date(a.tradeLockExpiry).getTime() : 0;
      const tb = b.tradeLockExpiry ? new Date(b.tradeLockExpiry).getTime() : 0;
      return ta - tb;
    }
    default: return 0;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  API
// ════════════════════════════════════════════════════════════════════════════

// ── Boot capability token (B26/P5) ───────────────────────────────────────────
// The backend authenticates the dashboard with a per-run secret so a random local
// process can't drive money/vault ops. The Tauri shell injects it as window.__SSIM_CAP__
// out-of-band; the dev/Edge build injects it into index.html. We send it on EVERY call
// (harmless on open reads) and, for MUTATING calls, briefly wait for it if the shell's
// injection hasn't landed yet (reads never wait, so the initial load is never blocked).
function capToken() {
  // The shell delivers the per-run token via an eval that sets window.__SSIM_CAP__ on the
  // dashboard document. That in-memory value does NOT survive a reload (F5 / WebView2 renderer
  // recovery / the S23 location.replace('/')), which previously 401'd every money/config/refresh
  // op until a full app restart. Persist it to sessionStorage the first time we see it and fall
  // back to that copy, so the token survives any in-webview reload for the life of the process.
  // sessionStorage is per-origin (http://127.0.0.1:<port>), so a fresh process/port never inherits
  // a stale token. (S1)
  let t = (typeof window !== 'undefined' && window.__SSIM_CAP__) || '';
  try {
    if (t) sessionStorage.setItem('ssim_cap', t);
    else t = sessionStorage.getItem('ssim_cap') || '';
  } catch (_) { /* sessionStorage unavailable (private mode / non-browser) — fall back to window only */ }
  return t;
}
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
async function awaitCap(timeoutMs = 3000) {
  if (capToken()) return capToken();
  const started = Date.now();
  while (!capToken() && Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 25));
  }
  return capToken();
}

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  // A protected (mutating) call needs the token; wait briefly if the shell hasn't injected
  // it yet. Reads proceed immediately (they still send whatever token is available).
  if (MUTATING_METHODS.has(method)) await awaitCap();
  const cap = capToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cap) headers['X-SSIM-Cap'] = cap;
  // S32: bound EVERY call with a client timeout so an interactive "live" request (orders / confirmations /
  // trade-up candidates / ?refresh=1) that queues behind a fleet refresh's login semaphore can't spin an
  // INDEFINITE modal spinner. Generous default (2 min) — longer than any legitimate call, far shorter than
  // the "many minutes" pathological wait; a caller can override via opts.timeoutMs (0/null → no timeout).
  const timeoutMs = ('timeoutMs' in opts) ? opts.timeoutMs : 120000;
  const signal = opts.signal || (timeoutMs ? timeoutSignal(timeoutMs) : undefined);
  let res;
  try {
    res = await fetch(API + path, { ...opts, headers, signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      const te = new Error('The request timed out — the backend may be busy (e.g. a fleet refresh is running). Please try again.');
      te.status = 0; te.timedOut = true; throw te;
    }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.data = data; e.status = res.status; // expose flags like verifyBeforeRetry / quarantined / capabilityRequired
    // The session has no valid capability token (never delivered, or lost before sessionStorage
    // could stash it). Reads still work, so the app looks alive while the whole write surface 401s.
    // Surface a dedicated "restart required" banner instead of a bare per-action toast. (S1)
    if (res.status === 401 && data && data.capabilityRequired) renderCapabilityBanner();
    throw e;
  }
  return data;
}

// ── Global error visibility (S30) ─────────────────────────────────────────────
// WebView2 has NO visible console and there were no global handlers, so an uncaught error in a
// render/filter/sort path (e.g. a malformed cached row) escaped the DOM handler, left a half-rendered
// view, and surfaced NOWHERE — and init()'s own rejection was invisible too. Catch them globally:
// toast the operator AND ship to the backend log so the failure is visible via Live Logs / shell.log
// on an unattended machine. The reporter must never itself throw or storm.
let __lastUiErrorAt = 0;
function reportUiError(kind, message, extra) {
  try {
    const now = Date.now();
    if (now - __lastUiErrorAt < 1000) return; // coalesce bursts (a render loop can fire many)
    __lastUiErrorAt = now;
    const msg = `${kind}: ${message}`;
    try { toast(`UI error: ${String(message).slice(0, 200)}`, 'error'); } catch (_) {}
    const body = JSON.stringify({ message: msg.slice(0, 2000), source: (extra && extra.source) || '', stack: (extra && extra.stack) || '' });
    // Best-effort; the endpoint is capability-exempt so it also works while the session is capless (S1).
    fetch(API + '/api/app/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
  } catch (_) { /* the reporter must never itself raise */ }
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => reportUiError('window.onerror',
    (e && (e.message || (e.error && e.error.message))) || 'unknown error',
    { source: `${(e && e.filename) || ''}:${(e && e.lineno) || ''}`, stack: e && e.error && e.error.stack }));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    reportUiError('unhandledrejection', (r && r.message) || String(r), { stack: r && r.stack });
  });
}

// Inventories are cached server-side keyed by lowercase username – normalise lookup.
/** Inventory of the ACTIVE game for a user – all views read through this. */
function invFor(u) { return invForGame(u, state.game); }

/** invFor for an EXPLICIT game rather than the active Inventories tab. Batch Jobs hides the CS2/TF2
 *  toggle (setNav: it is an Inventories-only control), so anything reachable from there has to name
 *  the game it means instead of inheriting an invisible one. */
function invForGame(u, game) {
  if (!u) return undefined;
  const src = game === 'tf2' ? state.tf2Inventories : state.inventories;
  return src[u] || src[u.toLowerCase()];
}

// ── Game toggle (CS2 ↔ TF2) ───────────────────────────────────────────────────
const TF2_KEY_NAME = 'Mann Co. Supply Crate Key';

/** Total Mann Co. Supply Crate Keys in a (stacked) item list. */
function countTf2Keys(items) {
  let n = 0;
  for (const it of items || []) if (it.marketHashName === TF2_KEY_NAME) n += it.quantity || 1;
  return n;
}

/** Steam app id of the active game tab — drives the app-agnostic send path (CS2 730 / TF2 440,
 *  both context 2). The send carries this so a TF2 offer is built for 440, not CS2's 730. */
function currentAppId() { return state.game === 'tf2' ? 440 : 730; }

async function setGame(game) {
  if (state.game === game) return;
  state.game = game;
  clearSelection();
  updateGameToggle();
  if (game === 'tf2' && !state.tf2Loaded) await loadTf2Inventories();
  renderMain();
}

/** H-FE-001: the cold TF2 fetch (over the fleet's flaky proxies) is the app's flakiest load. On success it
 *  fills state.tf2Inventories + starts the price-fill watch; on FAILURE it records state.tf2LoadError so the
 *  render path shows a distinct "couldn't load TF2 — Retry" panel instead of a silently-empty inventory (a
 *  failed load masquerading as a legitimate empty state — the S4/S13 UI-truth class at the display layer).
 *  Also invoked by the Retry button in renderTf2LoadError. Keeps state.game='tf2' so the toggle stays honest. */
async function loadTf2Inventories() {
  try {
    const invMap = await api('/api/inventory-tf2');
    state.tf2Inventories = {};
    for (const k of Object.keys(invMap || {})) { const inv = invMap[k]; storeTf2Inv(inv); }
    state.tf2Loaded = true;
    state.tf2LoadError = null;
    // S29: this first TF2 load enriches + queues a server-side price fill for the cold TF2 cache, but
    // nothing watched it (boot/refresh/source-switch all start a watch; this path did not) → TF2 prices
    // stayed "…" until an unrelated trigger. Start the watch so prices + totals fill in live (mirrors init()).
    void watchPriceFill(refreshActiveViewFromCache);
  } catch (err) {
    state.tf2LoadError = err.message;
    toast(err.message, 'error');
  }
}

function updateGameToggle() {
  // .seg control (index.html): the active button carries .is-on (brand fill via the DS);
  // toggle it rather than overwriting className so the seg structure + ids stay intact.
  if (el.btnGameCs2) el.btnGameCs2.classList.toggle('is-on', state.game === 'cs2');
  if (el.btnGameTf2) el.btnGameTf2.classList.toggle('is-on', state.game === 'tf2');
}

// W1_11: hide feature removed — strip any residual hidden flag so no account can strand.
function normalizeAccounts(list) {
  if (Array.isArray(list)) for (const a of list) if (a && a.hidden) delete a.hidden;
  return list;
}

async function reloadAll() {
  const [environments, allAccounts, invMap, fx] = await Promise.all([
    api('/api/environments'), api('/api/accounts'), api('/api/inventory'),
    api('/api/exchange-rate').catch(() => ({ usdToEur: state.usdToEur })),
  ]);
  state.environments = environments;
  state.allAccounts = normalizeAccounts(allAccounts);
  if (fx && typeof fx.usdToEur === 'number') state.usdToEur = fx.usdToEur;
  // FX provenance (C20 / INV-E5): record whether the rate is the hardcoded fallback or
  // stale, so EUR figures aren't presented as live when they aren't.
  state.fxFallback = !!(fx && fx.fallback);
  state.fxAgeMs = fx && typeof fx.ageMs === 'number' ? fx.ageMs : null;
  state.inventories = {};
  for (const k of Object.keys(invMap || {})) {
    const inv = invMap[k];
    storeCs2Inv(inv);
  }
  invalidateStructureCaches();
}

/** Every cached copy of the env → folder → account tree, dropped in one place.
 *
 *  Both consumers are listed here ON PURPOSE. The Batch scope tree used to be missed, so a freshly
 *  imported account stayed invisible in Batch Jobs (and in the Distribute source picker, which
 *  shares the same data) until the whole app was restarted — the account existed everywhere else,
 *  the batch simply could never see it. Any structural change (import, add, move, delete) must land
 *  here, not on one tree at a time. */
function invalidateStructureCaches() {
  state.accTree.targets = null;                 // Accounts tree
  state.batch.targets = null;                   // Batch scope tree + Distribute source picker
  state.batch._targetsGen = (state.batch._targetsGen || 0) + 1;   // a fetch in flight is now stale — its answer is dropped
  // Proxies module (v5) — it caches BOTH the scope targets (environment/folder/account names shown
  // in the rule editor and the resolution preview) AND the rule list itself, behind a one-shot
  // `loaded` flag. A structural change can invalidate both: deleting an environment with its
  // accounts also PRUNES every proxy rule that targeted them (AccountManager.pruneRuleTargets), so
  // without this the module keeps rendering rules the server has already deleted — and editing one
  // 404s. Clearing `loaded` makes renderProxiesModule refetch on its next paint.
  state.proxies.loaded = false;
  state.proxies.targets = null;
  state.proxies.preview = null;
  state.proxies._gen = (state.proxies._gen || 0) + 1;   // same reason as _targetsGen — drop an answer already on the wire
  // Already looking at Batch / Proxies when the change landed? Re-mount so it reflects reality now
  // rather than on the next visit (both fetches are lazy, driven by their render entry).
  if (state.nav === 'batch') renderBatchModule();
  if (state.nav === 'proxies') renderProxiesModule();
}

// ── Inventory ingestion (single funnel so the GLOBAL wallet store stays current) ──
/** The Steam wallet is ONE account property, not a per-game one — the SAME balance must show in
 *  CS2 and TF2. Remember the MOST RECENTLY fetched wallet (compared by inv.fetchedAt) so loading
 *  a staler game-cache can NEVER clobber a fresher balance. Both games attach inv.wallet at
 *  refresh, so whichever game was refreshed last is the source of truth for both views. */
function rememberWallet(inv) {
  if (!inv || !inv.username || !inv.wallet) return;
  const lc = inv.username.toLowerCase();
  const ts = inv.fetchedAt ? new Date(inv.fetchedAt).getTime() : 0;
  const prev = state.wallets[lc];
  if (!prev || !(prev.ts > ts)) state.wallets[lc] = { wallet: inv.wallet, ts };   // newest (or equal) wins
}
function storeCs2Inv(inv) { state.inventories[inv.username] = inv; rememberWallet(inv); }
function storeTf2Inv(inv) { state.tf2Inventories[inv.username] = inv; rememberWallet(inv); }

/** True once the account has been SUCCESSFULLY refreshed (a cached inventory in either game, or a
 *  remembered wallet). Distinguishes "refreshed but empty/no-wallet" (→ show 0) from "never
 *  fetched" (→ show —), so an empty balance never masquerades as unknown. */
function wasRefreshed(u) {
  if (!u) return false;
  const lc = u.toLowerCase();
  return !!(state.inventories[u] || state.inventories[lc]
    || state.tf2Inventories[u] || state.tf2Inventories[lc]
    || state.wallets[lc]);
}

/** Refetch the persisted inventory cache (active game) + the account list, then re-render the
 *  active Master/Env/Global view + sidebar. Called when a MASS OP (buy/sell/trade) completes so
 *  the views become a LIVE reflection of the new balances/inventories with no manual click — the
 *  backend cache is already post-op fresh, so no slow re-login refresh is needed. */
async function refreshActiveViewFromCache() {
  try {
    const accountsList = await api('/api/accounts').catch(() => null);
    if (Array.isArray(accountsList)) state.allAccounts = normalizeAccounts(accountsList);
    if (state.game === 'tf2') {
      const invMap = await api('/api/inventory-tf2');
      state.tf2Inventories = {};
      for (const k of Object.keys(invMap || {})) storeTf2Inv(invMap[k]);
      state.tf2Loaded = true;
      state.tf2LoadError = null;   // H-FE-001: a successful TF2 load heals any prior load-error panel
    } else {
      const invMap = await api('/api/inventory');
      state.inventories = {};
      for (const k of Object.keys(invMap || {})) storeCs2Inv(invMap[k]);
    }
    invalidateHistory();   // a fresh worth/wallet curve point exists now
    renderMain();          // re-aggregate + redraw the active Master/Env/Global view
    renderSidebar();       // updated wallet balances next to each account
  } catch { /* keep the current view on a transient fetch error */ }
}

// ── Money / currency ──────────────────────────────────────────────────────────
/** USD major units → string in the selected display currency. */
function fmtUsd(usdMajor) {
  if (usdMajor == null || isNaN(usdMajor)) return '—';
  const eur = state.currency === 'EUR';
  const v = eur ? usdMajor * state.usdToEur : usdMajor;
  // ST-02: locale follows the DISPLAYED currency → USD reads $1,234.56 (en-US),
  // EUR reads €1.234,56 (de-DE). Previously both used de-DE (USD shown as $1.234,56).
  return (eur ? '€' : '$') + v.toLocaleString(eur ? 'de-DE' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** USD cents → string. null/undefined handled by caller via fmtUsd. */
function fmtCents(cents) { return cents == null ? '—' : fmtUsd(cents / 100); }
/** Steam wallet (native currency) → USD major units. Supports USD(1) + EUR(3). */
function walletToUsd(w) {
  if (!w) return null;
  const b = typeof w.balance === 'number' ? w.balance : Number(w.balance);
  if (!Number.isFinite(b)) return null;                   // null/undefined/'' → unknown
  if (b === 0) return 0;                                  // zero is zero in ANY currency (empty wallet)
  if (w.currency === 1) return b;                         // USD
  if (w.currency === 3) return b / state.usdToEur;        // EUR → USD
  return null;                                            // unknown non-zero currency → skip
}
/** Best-effort display currency for an account whose own wallet currency isn't known yet (empty /
 *  not-yet-captured): the MOST COMMON currency across accounts that DO have a wallet — a farm is
 *  almost always one currency/region — falling back to EUR. Lets an empty balance show "0,00 €"
 *  (or $/£/…) instead of a bare number, and adapts automatically to whatever the fleet uses. */
function fleetCurrency() {
  const counts = {};
  for (const k in state.wallets) {
    const w = state.wallets[k];
    const c = w && w.wallet && w.wallet.currency;
    if (typeof c === 'number' && c > 0) counts[c] = (counts[c] || 0) + 1;
  }
  let best = 3, bestN = 0;                                // default EUR (3)
  for (const c in counts) { if (counts[c] > bestN) { bestN = counts[c]; best = Number(c); } }
  return best;
}
/** Stack value in USD cents (price × quantity); 0 when unpriced. */
function stackValueCents(item) { return (item.price || 0) * (item.quantity || 1); }

// SINGLE source of truth for a multi-account "worth" total: sum each account's
// backend-computed totalValueUsd (USD cents). Every multi-account view (folder, multi-
// select, env/global) uses THIS, so the headline worth can never disagree between two
// views the way the old per-view recompute-from-items could. (C19 / INV-E3.)
function worthCentsForAccounts(usernames) {
  let cents = 0;
  for (const u of usernames) { const inv = invFor(u); if (inv) cents += inv.totalValueUsd || 0; }
  return cents;
}

// ── Native Steam currencies (code → ISO + minor-unit decimals) ────────────────
// Used by the market BUY flow so every account is shown/charged in its OWN wallet
// currency (no global EUR/USD conversion). Mirrors src/pricing/currencies.ts.
const STEAM_CURRENCIES = {
  1:{iso:'USD',d:2},2:{iso:'GBP',d:2},3:{iso:'EUR',d:2},4:{iso:'CHF',d:2},5:{iso:'RUB',d:2},
  6:{iso:'PLN',d:2},7:{iso:'BRL',d:2},8:{iso:'JPY',d:0},9:{iso:'NOK',d:2},10:{iso:'IDR',d:0},
  11:{iso:'MYR',d:2},12:{iso:'PHP',d:2},13:{iso:'SGD',d:2},14:{iso:'THB',d:2},15:{iso:'VND',d:0},
  16:{iso:'KRW',d:0},17:{iso:'TRY',d:2},18:{iso:'UAH',d:2},19:{iso:'MXN',d:2},20:{iso:'CAD',d:2},
  21:{iso:'AUD',d:2},22:{iso:'NZD',d:2},23:{iso:'CNY',d:2},24:{iso:'INR',d:2},25:{iso:'CLP',d:0},
  26:{iso:'PEN',d:2},27:{iso:'COP',d:2},28:{iso:'ZAR',d:2},29:{iso:'HKD',d:2},30:{iso:'TWD',d:2},
  31:{iso:'SAR',d:2},32:{iso:'AED',d:2},33:{iso:'SEK',d:2},34:{iso:'ARS',d:2},35:{iso:'ILS',d:2},
  37:{iso:'KZT',d:2},38:{iso:'KWD',d:2},39:{iso:'QAR',d:2},40:{iso:'CRC',d:2},41:{iso:'UYU',d:2},
  42:{iso:'BGN',d:2},43:{iso:'HRK',d:2},44:{iso:'CZK',d:2},45:{iso:'DKK',d:2},46:{iso:'HUF',d:0},47:{iso:'RON',d:2},
};
function curInfo(code) { return STEAM_CURRENCIES[code] || { iso: 'EUR', d: 2 }; }
/** ST-02: ISO currency → a locale whose number conventions match it, so a wallet
 *  never reads in the wrong format (USD as 1.234,56). Only currencies that
 *  conventionally use a period decimal / leading symbol are overridden; everything
 *  else keeps the prior de-DE (comma-decimal, Latin digits) — guaranteeing no
 *  exotic numerals/RTL are introduced. */
const CURRENCY_LOCALE = {
  USD:'en-US', GBP:'en-GB', AUD:'en-AU', CAD:'en-CA', NZD:'en-NZ', SGD:'en-SG', HKD:'en-HK',
  INR:'en-IN', PHP:'en-PH', ZAR:'en-ZA', ILS:'en-IL', JPY:'ja-JP', KRW:'ko-KR', CNY:'zh-CN',
  TWD:'zh-TW', CHF:'de-CH', MXN:'es-MX',
};
function localeForIso(iso) { return CURRENCY_LOCALE[iso] || 'de-DE'; }
/** minor units (e.g. cents) of currency `code` → localized string WITH symbol. */
function fmtMoneyMinor(minor, code) {
  if (minor == null || isNaN(minor)) return '—';
  const c = curInfo(code);
  const major = minor / Math.pow(10, c.d);
  const locale = localeForIso(c.iso);   // ST-02: per-currency locale (USD→en-US, EUR→de-DE)
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: c.iso, minimumFractionDigits: c.d, maximumFractionDigits: c.d }).format(major);
  } catch { return major.toLocaleString(locale, { minimumFractionDigits: c.d, maximumFractionDigits: c.d }) + ' ' + c.iso; }
}
/** Bare currency symbol for a Steam code ("€", "zł", "¥") — for input adornments, where a
 *  full formatted amount would be wrong. Falls back to the ISO code when Intl has no symbol. */
function currencySymbol(code) {
  const c = curInfo(code);
  try {
    const part = new Intl.NumberFormat(localeForIso(c.iso), { style: 'currency', currency: c.iso })
      .formatToParts(0).find((p) => p.type === 'currency');
    return (part && part.value) || c.iso;
  } catch { return c.iso; }
}
/** Steam wallet (balance in MAJOR units) → minor units of its own currency. */
function walletMinor(w) { return w ? Math.round(w.balance * Math.pow(10, curInfo(w.currency).d)) : null; }
/** Wallet → localized string in its NATIVE currency. STRICT zero-vs-unknown:
 *  balance null/undefined/'' (never fetched) → '—'; a real 0 (or "0") → 0,00. */
function fmtWallet(w) {
  if (!w) return '—';
  const b = w.balance;
  if (b === null || b === undefined || b === '') return '—'; // not fetched yet
  const num = typeof b === 'number' ? b : Number(b);
  if (!Number.isFinite(num)) return '—';
  return fmtMoneyMinor(walletMinor({ currency: w.currency, balance: num }), w.currency);
}
/** Parse a typed major amount ("2,15"/"2.15"/"1.500,00") → minor units of currency `code`.
 *  Disambiguates decimal-vs-grouping ONLY when unambiguous; a lone separator stays the
 *  decimal point (today's safe under-parse), so no input ever parses HIGHER than typed. */
function normalizeMajor(str) {
  const s = String(str ?? '').replace(/[\s']/g, ''); // strip whitespace + apostrophe/Swiss group marks
  const hasDot = s.indexOf('.') >= 0, hasComma = s.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    // Both present: the LAST-occurring separator is the decimal; the other is grouping.
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    return s.split(grp).join('').replace(dec, '.');
  }
  const sep = hasDot ? '.' : hasComma ? ',' : '';
  if (sep && s.indexOf(sep) !== s.lastIndexOf(sep)) return s.split(sep).join(''); // 2+ of same sep → all grouping
  return s.replace(',', '.'); // zero or one separator → treat as the decimal point (unchanged from today)
}
function parseMajorToMinor(str, code) {
  const c = curInfo(code);
  const v = parseFloat(normalizeMajor(str));
  return Number.isFinite(v) && v > 0 ? Math.round(v * Math.pow(10, c.d)) : null;
}

function setCurrency(cur) {
  state.currency = cur;
  localStorage.setItem('ssim.currency', cur);
  updateCurrencyButton();
  renderMain();
  if (state.nav === 'portfolios') renderPortfolios();   // W1_13: reformat all Portfolios columns
  else if (state.nav === 'dashboard') paintSummary();    // W1_12: reformat Dashboard KPI tiles
}
function updateCurrencyButton() {
  if (el.currencyLabel) el.currencyLabel.textContent = state.currency;
  if (el.valueFilterCur) el.valueFilterCur.textContent = state.currency === 'EUR' ? '€' : '$';
  // Surface FX-rate provenance as a tooltip (non-structural) so EUR figures from a
  // fallback/stale rate aren't read as live. (C20 / INV-E5.)
  const btn = document.getElementById('cur-btn');
  if (btn) {
    if (state.currency === 'EUR' && state.fxFallback) {
      btn.title = `EUR shown at the fallback rate ${state.usdToEur} (live USD→EUR unavailable)`;
    } else if (state.currency === 'EUR' && state.fxAgeMs != null && state.fxAgeMs > 36 * 3600 * 1000) {
      btn.title = `EUR rate ${state.usdToEur} is stale (${Math.round(state.fxAgeMs / 3600000)}h old)`;
    } else {
      btn.title = 'Currency';
    }
  }
}

// ── Feature 3: price source (Steam ⟷ CSFloat) ──
function updatePriceSourceButton() {
  const csf = state.priceSource === 'csfloat';
  if (el.srcLabel) el.srcLabel.textContent = csf ? 'CSFloat' : 'Steam';
  if (el.srcLogo) el.srcLogo.setAttribute('src', csf ? '/assets/logos/csfloat.svg' : '/assets/logos/steam.svg');
}
async function setPriceSource(src) {
  if ((src !== 'steam' && src !== 'csfloat') || src === state.priceSource) return;
  const prev = state.priceSource;
  state.priceSource = src; localStorage.setItem('ssim.priceSource', src); updatePriceSourceButton();
  try {
    const r = await api('/api/pricing/source', { method: 'PUT', body: JSON.stringify({ source: src }) });
    const eff = (r && r.effective) || src;
    if (eff !== state.priceSource) { state.priceSource = eff; localStorage.setItem('ssim.priceSource', eff); updatePriceSourceButton(); }
    if (src === 'csfloat' && eff === 'steam') toast('No CSFloat API key found — pricing from Steam. Add a key in an account’s CSFloat → Settings.', 'error');
    else toast(`Price source: ${eff === 'csfloat' ? 'CSFloat' : 'Steam Market'} — re-pricing…`, 'success');
    await reloadAll(); renderMain();
    pollRepricing();           // live-fill the new source's prices without a manual Refresh
  } catch (err) {
    state.priceSource = prev; localStorage.setItem('ssim.priceSource', prev); updatePriceSourceButton();
    toast(`Could not switch price source: ${err.message}`, 'error');
  }
}

/**
 * Watch the backend's BACKGROUND price-fill and re-pull + re-render as prices land, so item prices,
 * per-account totals AND portfolio aggregates update on screen WITHOUT a restart.
 *
 * WHY THIS EXISTS: a refresh (single/all) or a source switch enriches inventories from the price cache
 * and QUEUES the missing/stale names; PricingService fills them in the background (~3.5s/name) and
 * writes the cache. The one-shot fetch+render the trigger already did therefore shows prices as they
 * were AT THAT INSTANT — every name fetched afterwards stays stale on screen until the app is restarted
 * (which re-GETs + re-enriches from the now-warm cache). This poller closes that gap: it polls
 * /api/pricing/status and calls `repull` — which re-fetches the LIVE inventory (the backend re-enriches
 * from the warm cache, recomputing per-item price AND inv.totalValueUsd) and re-renders — each time new
 * prices arrive. A token supersedes an older watch (there is a single backend queue); we only re-pull
 * when `fetched` actually advanced (cheap, no needless re-render); the watch caps at 90s while the fill
 * continues server-side. `baseline` is read up-front so a fill that completes between polls is still
 * caught (we re-pull on the drain tick because `fetched` exceeds the pre-fill baseline).
 */
// Mirrors src/pricing/repriceReconciler.ts (repriceDecision) — keep in sync. DURABLE, NOT
// deadline-capped: re-pulls whenever the backend's `fetched` advances and keeps watching until
// the fill queue DRAINS, so a large fleet's price fill (which can far outlast the old 90s
// window) always reaches the UI — no displayed total stays stale-as-if-live after prices have
// actually been fetched (INV-E1). A single no-progress safety stop bounds a wedged backend.
const REPRICE_NO_PROGRESS_MS = 15 * 60_000;
// S10: bound how often the fill-watch re-pulls the WHOLE /api/inventory (a deep-clone + enrich +
// multi-MB stringify server-side, plus a full renderMain/renderSidebar client-side). A fill advances
// ~1 name/3.5s, so the old "re-pull on every advance" hammered the event loop ~every 2.5s poll for the
// whole fill. Coalesce to at most one re-pull per this interval; the final drain still pulls immediately.
// Keep in sync with src/pricing/repriceReconciler.ts MIN_REPULL_MS (repriceDecision models this gate).
const REPRICE_MIN_REPULL_MS = 10_000;
/** Decide whether the fill-watch should re-pull now: always on drain (queue empty), else only when the
 *  fill advanced AND at least REPRICE_MIN_REPULL_MS has elapsed since the last re-pull. (S10) */
function shouldRepullFill(progressed, busy, msSinceLastRepull, minRepullMs) {
  if (!busy) return true;                                    // queue drained → final re-pull always
  return progressed && msSinceLastRepull >= minRepullMs;     // bounded cadence during an active fill
}

// Mirrors src/pricing/repriceReconciler.ts (priceFillIndicator) — keep in sync. Visible while the
// backend fill runs or names are queued; hidden the moment the queue drains (dismiss-on-complete).
// Prices fill one name at a time from a SINGLE IP, throttled to match the backend's
// PricingService.FETCH_DELAY_MS (~17 names/min). A 500+-account cold cache legitimately runs tens of
// minutes, so the badge shows a rough ETA (and a "large inventory" hint) — slow no longer reads as frozen.
const FILL_MS_PER_NAME = 3500;

/** Rough remaining time for `left` queued names at the single-IP throttle, e.g. "~35s left" / "~6 min left"
 *  / "~1.9 h left". Empty string when nothing is left. Pure + exported-shaped for unit tests. */
function formatFillEta(left) {
  const secs = Math.round(Math.max(0, Number(left) || 0) * FILL_MS_PER_NAME / 1000);
  if (secs <= 0) return '';
  if (secs < 90) return `~${secs}s left`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `~${mins} min left`;
  return `~${Math.round(secs / 360) / 10} h left`;
}

function priceFillIndicator(status) {
  const left = Math.max(0, (status && Number(status.queued)) || 0);
  const done = Math.max(0, (status && Number(status.fetched)) || 0);
  const show = !!(status && (status.running || left > 0));
  const eta = formatFillEta(left);
  const long = left > 200; // a large cold cache legitimately takes a while at ~17 names/min
  return { show, left, done, eta, long };
}
/** Renders the floating "Fetching prices…" badge from a /api/pricing/status snapshot; hides it on
 *  completion. Additive: a self-created fixed element, no dependency on the frozen DOM contract. */
function renderPriceFillIndicator(status) {
  const { show, left, done, eta, long } = priceFillIndicator(status);
  let node = document.getElementById('price-fill-indicator');
  if (!show) { if (node) node.classList.add('hidden'); return; }
  if (!node) {
    node = document.createElement('div');
    node.id = 'price-fill-indicator';
    node.className = 'fixed bottom-4 right-4 z-40 flex items-center gap-2 px-3.5 py-2 rounded-full '
      + 'bg-slate-900/95 border border-slate-700 shadow-lg text-xs text-slate-200 backdrop-blur-sm';
    document.body.appendChild(node);
  }
  node.classList.remove('hidden');
  // Hover explains WHY a large fill is slow (single-IP throttle) so it doesn't read as a hang.
  node.title = 'Prices load one at a time from a single IP (~17/min), so a large cold inventory can take a while. It keeps filling in the background — you can keep working.';
  node.innerHTML = `<i class="fa-solid fa-tag text-brand cs2-spin"></i>`
    + `<span>Fetching prices… <b class="text-white">${left}</b> left · <b class="text-white">${done}</b> done`
    + (eta ? ` · <span class="text-slate-400">${eta}</span>` : '')
    + (long ? ` <span class="text-slate-500">(large inventory)</span>` : '')
    + `</span>`;
}

async function watchPriceFill(repull) {
  const token = (state.repriceToken = (state.repriceToken || 0) + 1);
  let baseline = 0;
  let s0;
  try { s0 = await api('/api/pricing/status'); if (state.repriceToken !== token) return; baseline = s0 ? (s0.fetched || 0) : 0; }
  catch { /* status unavailable → nothing to watch */ return; }
  renderPriceFillIndicator(s0); // reflect the current fill state immediately
  let lastPulled = baseline;
  let lastProcessed = 0; // S19: liveness by ANY terminal resolution, not just a successful fetch
  let lastProgressAt = Date.now();
  let lastRepullAt = 0; // S10: bound the whole-fleet re-pull cadence
  let consecErrors = 0; // S42: consecutive status-fetch failures → stop against a dead backend
  const MAX_CONSEC_ERRORS = 24; // ~1 min at the 2.5s poll — rides out a blip, but never spins forever
  while (true) {
    await new Promise((r) => setTimeout(r, 2500));
    if (state.repriceToken !== token) return;                    // superseded by a newer watcher (it owns the indicator now)
    let st;
    try { st = await api('/api/pricing/status'); consecErrors = 0; }
    catch {
      // S42: a DEAD backend fails EVERY poll. The old `continue` spun here forever with the "Fetching
      // prices…" badge frozen. Count consecutive failures and STOP after a bounded streak (a transient
      // blip resets the count on the next good poll, so a live fill is never abandoned).
      if (++consecErrors >= MAX_CONSEC_ERRORS) { renderPriceFillIndicator(null); return; }
      continue;
    }
    if (state.repriceToken !== token) return;
    renderPriceFillIndicator(st);                                // live "N left / X done"; auto-hides when drained
    const fetched = st ? (st.fetched || 0) : 0;
    const processed = st ? (st.processed || 0) : 0;
    const busy = !!(st && (st.running || (st.queued || 0) > 0));
    // The backend resets `fetched`/`processed` to 0 at the start of each fill generation → a DROP means a
    // new generation; re-baseline so its prices are re-pulled (and liveness re-anchored), not ignored.
    if (fetched < lastPulled) lastPulled = 0;
    if (processed < lastProcessed) lastProcessed = 0;
    const progressed = fetched > lastPulled;                     // NEW PRICES available → drives the re-pull (S10)
    if (progressed) lastPulled = fetched;
    // S19: advance the no-progress clock on ANY terminal resolution (success OR error/429-exhaustion), so a
    // sustained 429/error storm — which advances `processed` but not `fetched` — is NOT mistaken for a dead
    // fill (which would terminally stop the watch AND hide the "Fetching prices…" badge while it runs on).
    if (processed > lastProcessed) { lastProcessed = processed; lastProgressAt = Date.now(); }
    const noProgress = busy && (Date.now() - lastProgressAt > REPRICE_NO_PROGRESS_MS);
    if (noProgress) console.warn('[reprice] no pricing progress for 15 min – stopping the watch');
    // S10: coalesce re-pulls to at most one per REPRICE_MIN_REPULL_MS while the fill runs (the drain
    // always pulls immediately), instead of re-pulling+re-rendering the whole fleet on every 2.5s poll.
    const repullNow = shouldRepullFill(progressed, busy, Date.now() - lastRepullAt, REPRICE_MIN_REPULL_MS);
    const stop = !busy || noProgress;
    if (repullNow) { lastRepullAt = Date.now(); try { await repull(); } catch { /* keep the current view on a transient fetch error */ } }
    if (stop) { renderPriceFillIndicator(null); return; }        // dismiss the indicator on completion
  }
}

// ── System-status surface (C3/B3/B1) ────────────────────────────────────────
// Polls /api/system/status and surfaces three ADDITIVE, self-created elements — a brand-new id
// appended to <body>, exactly like renderPriceFillIndicator — so the frozen DOM contract is untouched:
//   • an "update available / ready-but-blocked-here" badge (C3/C5), clickable to install now,
//   • a "money operations paused" banner when the breaker is tripped (B3),
//   • a dismissible "SSIM crashed last run" banner (B1).
let updateInstalling = false;
let crashBannerDismissed = false;

/** Manual update check (install=false) or user-confirmed install (install=true). */
async function triggerUpdate(install) {
  try {
    const r = await api('/api/app/check-update', { method: 'POST', body: JSON.stringify(install ? { install: true } : {}) });
    if (install) {
      if (r && r.installing) { updateInstalling = true; renderUpdateIndicator(null); toast('Installing update — SSIM will restart shortly. Please don’t close it.', 'success'); }
      else toast((r && r.error) || 'Could not start the update.', 'error');
    } else if (r && r.available) {
      toast(`Update v${r.latest} available${r.blocked ? ' (blocked on this machine — manual reinstall may be needed)' : ' — click the badge to install'}.`, 'info');
    } else {
      toast('You’re on the latest version.', 'success');
    }
  } catch (e) { toast(`Update check failed: ${e.message}`, 'error'); }
}

/** S61: the update badge used to install-and-restart on a SINGLE unconfirmed click. Every other
 *  install/spend/danger action goes through ssimConfirm first; this now does too, so a stray click can't
 *  silently download + restart the app mid-session. Extracted (not inline) so it's unit-testable. */
async function confirmAndInstallUpdate() {
  if (updateInstalling) return;
  if (!(await ssimConfirm({
    title: 'Install update',
    body: 'SSIM will download, verify, and <b>restart</b> to apply the update. It won’t interrupt a trade, buy, or refresh in progress.',
    tone: 'brand',
    confirmLabel: 'Install & restart',
    confirmIcon: 'fa-circle-arrow-up',
  }))) return;
  void triggerUpdate(true);
}

function renderUpdateIndicator(update) {
  let node = document.getElementById('update-indicator');
  const show = !!(update && update.available) && !updateInstalling;
  if (!show) { if (node) node.classList.add('hidden'); return; }
  if (!node) {
    node = document.createElement('div');
    node.id = 'update-indicator';
    node.className = 'fixed bottom-4 left-4 z-40 flex items-center gap-2 px-3.5 py-2 rounded-full '
      + 'bg-slate-900/95 border border-slate-700 shadow-lg text-xs text-slate-200 backdrop-blur-sm cursor-pointer';
    node.addEventListener('click', () => { void confirmAndInstallUpdate(); }); // S61: confirm before install+restart
    document.body.appendChild(node);
  }
  node.classList.remove('hidden');
  if (update.blocked) {
    node.title = `This update has failed its self-test ${update.blockedFailures || ''}× on this machine (${update.blockedKind || 'unknown'}). Click to retry, or reinstall SSIM manually.`;
    node.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-amber-400"></i>`
      + `<span>Update <b class="text-white">v${escapeHtml(String(update.latest || ''))}</b> ready but blocked here — <b>click to retry / reinstall</b></span>`;
  } else {
    node.title = 'Click to install now (SSIM will restart). Refused while a trade/buy/refresh is running.';
    node.innerHTML = `<i class="fa-solid fa-circle-arrow-up text-brand"></i>`
      + `<span>Update <b class="text-white">v${escapeHtml(String(update.latest || ''))}</b> available — <b>click to install</b></span>`;
  }
}

function renderBreakerIndicator(status) {
  let node = document.getElementById('breaker-indicator');
  const tripped = status && status.moneyOpsStable === false;
  if (!tripped) { if (node) node.classList.add('hidden'); return; }
  if (!node) {
    node = document.createElement('div');
    node.id = 'breaker-indicator';
    node.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg '
      + 'bg-rose-950/95 border border-rose-700 shadow-lg text-xs text-rose-100 backdrop-blur-sm max-w-2xl';
    document.body.appendChild(node);
  }
  node.classList.remove('hidden');
  node.innerHTML = `<i class="fa-solid fa-hand text-rose-400"></i>`
    + `<span><b>Money operations paused.</b> ${escapeHtml(String(status.quarantineReason || 'internal error burst'))} — restart SSIM before more trades/buys.</span>`;
}

function renderTokenStoreWarning(status) {
  let node = document.getElementById('tokenstore-warning');
  const degraded = status && status.tokenStoreDegraded === true;
  if (!degraded) { if (node) node.classList.add('hidden'); return; }
  if (!node) {
    node = document.createElement('div');
    node.id = 'tokenstore-warning';
    node.className = 'fixed bottom-16 left-4 z-40 flex items-center gap-2 px-3.5 py-2 rounded-lg max-w-md '
      + 'bg-amber-950/95 border border-amber-700 shadow-lg text-xs text-amber-100 backdrop-blur-sm';
    document.body.appendChild(node);
  }
  node.classList.remove('hidden');
  node.innerHTML = '<i class="fa-solid fa-key text-amber-400"></i>'
    + '<span><b>Refresh-token store is corrupt.</b> Tokens are NOT saving — restore refresh_tokens.json from its .bak and restart before a full refresh, or the fleet will re-login/2FA.</span>';
}

function renderCsFloatKeyStoreWarning(status) {
  let node = document.getElementById('csfloatkeystore-warning');
  const degraded = status && status.csfloatKeyStoreDegraded === true;
  if (!degraded) { if (node) node.classList.add('hidden'); return; }
  if (!node) {
    node = document.createElement('div');
    node.id = 'csfloatkeystore-warning';
    node.className = 'fixed bottom-28 left-4 z-40 flex items-center gap-2 px-3.5 py-2 rounded-lg max-w-md '
      + 'bg-amber-950/95 border border-amber-700 shadow-lg text-xs text-amber-100 backdrop-blur-sm';
    document.body.appendChild(node);
  }
  node.classList.remove('hidden');
  node.innerHTML = '<i class="fa-solid fa-key text-amber-400"></i>'
    + '<span><b>CSFloat key store is corrupt.</b> Keys are NOT saving — pricing falls back to Steam and auto-accept skips accounts. Restore csfloat_keys.json from its .bak and restart.</span>';
}

function renderCrashBanner(status) {
  if (crashBannerDismissed) return;
  if (document.getElementById('crash-banner')) return; // render once
  if (!(status && status.priorCrash)) return;
  const node = document.createElement('div');
  node.id = 'crash-banner';
  node.className = 'fixed top-3 right-3 z-50 flex items-start gap-3 max-w-sm px-4 py-3 rounded-lg '
    + 'bg-amber-950/95 border border-amber-700 shadow-lg text-xs text-amber-100 backdrop-blur-sm';
  const when = status.priorCrash.at ? new Date(status.priorCrash.at).toLocaleString() : 'last run';
  const code = status.priorCrash.code != null ? `, code ${escapeHtml(String(status.priorCrash.code))}` : '';
  node.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-amber-400 mt-0.5"></i>`
    + `<div><b>SSIM’s backend crashed last run</b> (${escapeHtml(when)}${code}). Your saved data is safe. See the logs folder (shell.log / exit-trace.log).</div>`
    + `<button id="crash-banner-x" class="ml-1 text-amber-300 hover:text-white" title="Dismiss">✕</button>`;
  document.body.appendChild(node);
  const x = document.getElementById('crash-banner-x');
  if (x) x.addEventListener('click', () => { crashBannerDismissed = true; node.remove(); });
}

/** The session has no valid capability token (S1). Reads keep working, so nothing else signals that
 *  every money/config/refresh action is silently 401ing. Render a persistent, unmissable banner whose
 *  advice is the ONLY real recovery — a full restart (a reload cannot re-mint the per-run token). */
function renderCapabilityBanner() {
  if (document.getElementById('capability-banner')) return; // render once
  const node = document.createElement('div');
  node.id = 'capability-banner';
  node.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg '
    + 'bg-rose-950/95 border border-rose-700 shadow-lg text-xs text-rose-100 backdrop-blur-sm max-w-2xl';
  node.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-rose-400"></i>'
    + '<span><b>This session lost its authorization.</b> Money &amp; settings actions are disabled. '
    + 'Fully restart SSIM — close its window and reopen it — to restore them.</span>';
  document.body.appendChild(node);
}

/** Poll /api/system/status forever (30s) and paint the additive indicators. Self-superseding-safe:
 *  it is launched exactly once from init(). */
async function watchSystemStatus() {
  while (true) {
    let st; try { st = await api('/api/system/status'); } catch { st = null; }
    if (st) {
      // H-LIC-008: a RUNTIME revocation (or deactivation) makes the backend report `licensed:false`
      // (server.ts, `licensed:!LicenseClient.isRevoked()`, and the rebound activation portal). The boot
      // guard (ensureLicensed) only runs once, so this hot poll is the ONLY runtime consumer that can turn
      // that state into the activation screen. Strict `=== false` mirrors ensureLicensed (S23): a half-up
      // status that merely OMITS `licensed` must NOT redirect — only an explicit server-stated false does.
      if (st.licensed === false) { window.location.replace('/'); return; }
      // S34: a user-confirmed install 202s then runs async; a SUCCESS swaps + exits (this page reloads),
      // but a KEPT-CURRENT install just returns. When the server reports no update op in flight anymore,
      // clear the "installing…" state + re-show the badge (instead of showing "installing…" forever), and
      // surface the outcome so the operator knows it didn't install.
      if (updateInstalling && st.update && st.update.installing === false) {
        updateInstalling = false;
        const outcome = st.update.currentOutcome;
        if (outcome && !['ok', 'up-to-date'].includes(outcome)) toast(`Update did not install (${outcome}) — you can retry from the badge.`, 'warn');
      }
      renderUpdateIndicator(st.update);
      renderBreakerIndicator(st);
      renderTokenStoreWarning(st);
      renderCsFloatKeyStoreWarning(st);
      renderCrashBanner(st);
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

/** After a source switch the new source's price cache is cold; watch the fill and live-update. */
function pollRepricing() { return watchPriceFill(async () => { await reloadAll(); renderMain(); }); }
/** Updates the Item value + Balance stat cards. Pass null to show "—".
 *  ST-02: cards show a COMPACT value (€1.2M) only when large; the exact amount is
 *  always on hover (title). */
function setMoneyStats(valueCents, walletUsd) {
  if (el.statValue)  { el.statValue.textContent  = valueCents == null ? '—' : fmtCentsCompact(valueCents); el.statValue.title  = valueCents == null ? '' : fmtCents(valueCents); }
  if (el.statWallet) { el.statWallet.textContent = walletUsd  == null ? '—' : fmtUsdCompact(walletUsd);   el.statWallet.title = walletUsd  == null ? '' : fmtUsd(walletUsd); }
}

// ── ST-02: count + compact formatting (thousands grouping, locale-correct) ──────
/** Thousands-grouped integer in the displayed-currency locale (12,480 / 12.480). */
function fmtCount(n) {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return String(n ?? '—');
  return num.toLocaleString(state.currency === 'EUR' ? 'de-DE' : 'en-US');
}
/** Compact integer for stat cards; grouped-exact below 1,000,000, "1.2M" above. */
function fmtCompactCount(n) {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return String(n ?? '—');
  if (Math.abs(num) < 1_000_000) return fmtCount(num);
  return num.toLocaleString(state.currency === 'EUR' ? 'de-DE' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 });
}
/** Compact money for stat cards; keeps cents precision below 100k, "€1.2M" above. */
function fmtUsdCompact(usdMajor) {
  if (usdMajor == null || isNaN(usdMajor)) return '—';
  const eur = state.currency === 'EUR';
  const v = eur ? usdMajor * state.usdToEur : usdMajor;
  if (Math.abs(v) < 100000) return fmtUsd(usdMajor);
  return (eur ? '€' : '$') + v.toLocaleString(eur ? 'de-DE' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 });
}
function fmtCentsCompact(cents) { return cents == null ? '—' : fmtUsdCompact(cents / 100); }
/** Stat-card count: compact text (1.2M) + exact grouped value on hover (title). */
function setCountStat(elem, n) {
  if (!elem) return;
  const num = Number(n);
  if (!Number.isFinite(num)) { elem.textContent = (n == null ? '—' : String(n)); elem.title = ''; return; }
  elem.textContent = fmtCompactCount(num);
  elem.title = fmtCount(num);
}

async function loadTree(envId) {
  state.tree = await api(`/api/environments/${encodeURIComponent(envId)}/tree`);
}

async function refreshEnv() {
  const [tree, allAccounts] = await Promise.all([
    api(`/api/environments/${encodeURIComponent(state.activeEnv)}/tree`),
    api('/api/accounts'),
  ]);
  state.tree = tree;
  state.allAccounts = normalizeAccounts(allAccounts);
  invalidateStructureCaches();   // folders/accounts may have moved → the Batch + Accounts trees must refetch
  renderSidebar();
  renderMain();
}

// ════════════════════════════════════════════════════════════════════════════
//  Top-level navigation rail (state.nav) — W1_10
// ════════════════════════════════════════════════════════════════════════════

// Allow-list guards against a bad localStorage value or a typo destination.
const NAV_DEST = { dashboard: 1, portfolios: 1, inventories: 1, accounts: 1, batch: 1, proxies: 1, activity: 1 };

function setNav(nav) {
  if (!NAV_DEST[nav]) nav = 'dashboard';
  state.nav = nav;
  const inInv = nav === 'inventories';

  // (a) New standalone module containers — one-hot visibility.
  el.screenSummary.classList.toggle('hidden', nav !== 'dashboard');
  el.screenPortfolios.classList.toggle('hidden', nav !== 'portfolios');
  el.screenAccounts.classList.toggle('hidden', nav !== 'accounts');
  el.screenBatch.classList.toggle('hidden', nav !== 'batch');
  el.screenProxies.classList.toggle('hidden', nav !== 'proxies');
  el.screenActivity.classList.toggle('hidden', nav !== 'activity');

  // (b) The Inventories module wraps the two LEGACY screens. Force both hidden on exit
  //     and drop the windowed-scroll listener (mirrors showScreen's own TBL-02 teardown).
  if (!inInv) {
    el.screenDashboard.classList.add('hidden');
    el.screenInventory.classList.add('hidden');
    unmountWindow();
  }

  // (c) The account sidebar + resizer belong to Inventories only.
  el.appSidebar.classList.toggle('hidden', !inInv);
  el.sidebarResizer.classList.toggle('hidden', !inInv);

  // (d) Rail active highlight.
  updateNavRail();
  // (d2) The CS2/TF2 toggle is Inventories-only — hide it on every other module (W1_13).
  el.gameToggle?.classList.toggle('hidden', nav !== 'inventories');

  // (e) Mount the destination's render entry (stubs until each module's wave lands).
  if      (nav === 'dashboard')  renderSummary();
  else if (nav === 'portfolios') renderPortfolios();
  else if (nav === 'accounts')   renderAccountsModule();
  else if (nav === 'batch')      renderBatchModule();
  else if (nav === 'proxies')    renderProxiesModule();
  else if (nav === 'activity')   renderActivityModule();
  else                           enterInventories();
}

/** Enter the Inventories module. Land on the env-picker, or re-land on a live drill-down —
 *  the legacy showScreen/invMode machinery then owns everything inside, exactly as before. */
function enterInventories() {
  if (state.invMode === 'global')                          { showScreen('inventory'); renderMain(); }
  else if (state.activeEnv && state.invMode !== 'account') { showScreen('inventory'); renderMain(); }
  else                                                     { showScreen('dashboard'); renderDashboard(); }
}

function updateNavRail() {
  el.navRail.querySelectorAll('[data-nav]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.nav === state.nav));
}

// ════════════════════════════════════════════════════════════════════════════
//  Screen navigation (INTERNAL to the Inventories module)
// ════════════════════════════════════════════════════════════════════════════

function showScreen(name) {
  if (state.nav !== 'inventories') return;   // legacy screens live only inside the Inventories module
  state.screen = name;
  el.screenDashboard.classList.toggle('hidden', name !== 'dashboard');
  el.screenInventory.classList.toggle('hidden', name !== 'inventory');
  if (name !== 'inventory') unmountWindow();   // TBL-02: drop the windowed scroll listener when leaving the table
  updateSidebar();
}

function updateSidebar() {
  // "in an environment" covers account/env-master/folder modes (global has no env).
  const inEnv = state.screen === 'inventory' && state.invMode !== 'global' && !!state.activeEnv;
  // Chrome refactor (2026-07-09): on the env PICKER the context sidebar has nothing to show
  // (brand + version live in the rail now; add-controls live in Accounts) — hide the whole
  // panel there. The GLOBAL master hides it too (owner: it held only a back button — the
  // breadcrumb's "All inventories" is the way back). It shows only inside an env drill-down.
  const showSidebar = state.nav === 'inventories' && state.screen === 'inventory' && state.invMode !== 'global';
  el.appSidebar.classList.toggle('hidden', !showSidebar);
  el.sidebarResizer.classList.toggle('hidden', !showSidebar);
  el.sidebarNav.classList.toggle('hidden', state.screen === 'dashboard');
  el.envContext.classList.toggle('hidden', !inEnv);
  el.accountsLabel.classList.toggle('hidden', !inEnv);
  el.accountTools.classList.toggle('hidden', !inEnv);

  if (inEnv) {
    const env = state.environments.find(e => e.id === state.activeEnv);
    el.envName.textContent = env ? env.name : '—';
    el.envProxy.textContent = env ? envEgressLabel(env) : '';
    el.btnEnvMaster.classList.toggle('ring-1', state.invMode === 'env-master');
    el.btnEnvMaster.classList.toggle('ring-brand', state.invMode === 'env-master');
    el.accountSearch.value = state.accountSearch || '';     // keep the controls in sync with state
    el.accountFilter.value = state.accountFilter || 'all';
    el.accountSort.value = state.accountSort || 'default';
    renderSidebar();
  } else {
    el.accountList.innerHTML = '';
  }
}

function showDashboard() {
  state.invMode = 'account';
  state.activeEnv = null;
  state.activeUsername = null;
  clearSelection(); clearAccountSelection();
  showScreen('dashboard');
  renderDashboard();
}

async function enterEnvironment(envId) {
  state.activeEnv = envId;
  state.invMode = 'env-master';
  state.activeUsername = null;
  state.search = ''; state.sort = null; clearSelection(); clearAccountSelection();
  el.searchInput.value = '';
  try { await loadTree(envId); } catch (err) { toast(err.message, 'error'); return; }
  showScreen('inventory');
  renderMain();
}

function showGlobalMaster() {
  state.invMode = 'global';
  state.activeEnv = null;
  state.activeUsername = null;
  state.search = ''; state.sort = null; clearSelection(); clearAccountSelection();
  el.searchInput.value = '';
  if (state.globalEnvs.size === 0) state.environments.forEach(e => state.globalEnvs.add(e.id));
  showScreen('inventory');
  renderMain();
}

function selectEnvMaster() {
  state.invMode = 'env-master';
  state.activeUsername = null;
  state.search = ''; state.sort = null; clearSelection();
  el.searchInput.value = '';
  updateSidebar();
  renderMain();
}

// ════════════════════════════════════════════════════════════════════════════
//  Dashboard (environment tiles)
// ════════════════════════════════════════════════════════════════════════════

function envLastUpdated(envId) {
  let latest = 0;
  for (const a of state.allAccounts.filter(x => x.environmentId === envId)) {
    const inv = invFor(a.username);
    if (inv?.fetchedAt) { const t = new Date(inv.fetchedAt).getTime(); if (t > latest) latest = t; }
  }
  return latest || null;
}
function formatAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function renderDashboard() {
  const envs = state.environments;
  el.envEmpty.classList.toggle('hidden', envs.length > 0);
  // Staggered entrance ONLY on the first real paint (empty container or skeleton tiles
  // underneath) — re-renders (proxy test, reloadAll, data refresh) must not replay it.
  const animate = !el.envTiles.children.length || !!el.envTiles.querySelector('.skel');
  el.envTiles.innerHTML = envs.map((e, i) => envTile(e, i, animate)).join('');
  el.envTiles.querySelectorAll('[data-env]').forEach((c) =>
    c.addEventListener('click', () => enterEnvironment(c.dataset.env)));
  // Rename/delete are NOT wired here any more (owner 2026-08-25): environments are CREATED in the
  // Accounts module, so they are renamed and deleted there too. Inventories only navigates into them.
  el.envTiles.querySelectorAll('[data-proxy-test]').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); checkProxy(b.dataset.proxyTest, b); }));
}

/** Tests an environment's proxy via GET /check-proxy and shows green (IP+latency) / red (error). */
async function checkProxy(envId, btn) {
  const out = document.getElementById(`proxytest-${envId}`);
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i><span>Testing…</span>';
  if (out) { out.className = 'text-2xs text-slate-500 truncate min-w-0'; out.innerHTML = '<i class="fa-solid fa-circle-notch cs2-spin mr-1"></i>running…'; }
  try {
    const r = await api(`/api/environments/${encodeURIComponent(envId)}/check-proxy`);
    if (out) {
      if (r.ok) {
        out.className = 'text-2xs text-emerald-400 font-medium truncate min-w-0';
        const geo = r.countryCode ? ` · ${escapeHtml(r.countryCode)}${r.country ? ` (${escapeHtml(r.country)})` : ''}` : '';
        out.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i>${escapeHtml(r.ip)}${geo} · ${r.latencyMs} ms`;
      } else {
        out.className = 'text-2xs text-rose-400 font-medium truncate min-w-0';
        out.innerHTML = `<i class="fa-solid fa-circle-xmark mr-1"></i>${escapeHtml(r.error || 'Error')}`;
      }
    }
  } catch (err) {
    if (out) {
      out.className = 'text-2xs text-rose-400 font-medium truncate min-w-0';
      out.innerHTML = `<i class="fa-solid fa-circle-xmark mr-1"></i>${escapeHtml(err.message)}`;
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ── Account activity-log modal (Phase 4) ───────────────────────────────────────
async function openAccountLogs(username) {
  el.logsAccount.textContent = username;
  el.logsBody.innerHTML = '<p class="text-slate-500 py-6 text-center">Loading…</p>';
  el.logsOverlay.classList.remove('hidden');
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(username)}/logs`);
    const entries = Array.isArray(r.entries) ? r.entries : [];
    if (!entries.length) {
      el.logsBody.innerHTML = '<p class="text-slate-500 py-8 text-center">No activity logged for this account yet.</p>';
      return;
    }
    const tone = (lvl) => lvl === 'error' ? 'text-rose-400' : lvl === 'warn' ? 'text-amber-400' : 'text-slate-300';
    el.logsBody.innerHTML = entries.map((e) => {
      const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
      return `<div class="flex gap-2 py-1 border-b border-slate-800/40 last:border-0">
        <span class="text-slate-600 shrink-0 whitespace-nowrap">${escapeHtml(ts)}</span>
        <span class="${tone(e.level)} break-words min-w-0">${escapeHtml(e.message)}</span></div>`;
    }).join('');
  } catch (err) {
    el.logsBody.innerHTML = `<p class="text-rose-400 py-8 text-center">${escapeHtml(err.message)}</p>`;
  }
}
function closeLogs() { el.logsOverlay.classList.add('hidden'); }

// ── Environment egress (v1.4.4, owner issue 1) ────────────────────────────────
// Egress is resolved PER ACCOUNT by the proxy-rule engine; the legacy `env.proxy` string is retired once
// rules are authoritative and stays permanently empty. Rendering `hasProxy`/`proxy` therefore showed
// "Local IP (no proxy)" for every environment even while a rule was live. `env.egress` (from
// GET /api/environments) carries the RESOLVED truth; the legacy fields remain the pre-cutover fallback.
/** True when this environment's accounts actually leave through a proxy. */
function envIsProxied(env) {
  if (env && env.egress && env.egress.kind !== 'none') return env.egress.kind !== 'local';
  return !!(env && env.hasProxy);
}
/** Ready-to-render egress label for an environment. */
function envEgressLabel(env) {
  if (!env) return '';
  if (env.egress && env.egress.kind !== 'none') return env.egress.label;
  return env.hasProxy ? env.proxy : 'Local IP (no proxy)';
}

function envTile(env, idx = 0, animate = false) {
  const accs = state.allAccounts.filter((a) => a.environmentId === env.id);
  const count = accs.length;
  // Masterpiece parity: the tile shows the environment's VALUES (item worth / wallet /
  // trade-locked), not just an account count. Same aggregation the master views use, so
  // the tile can never disagree with the env-master screen. '—' until inventories are cached.
  const agg = aggregate(accs.map((a) => a.username));
  const last = envLastUpdated(env.id);
  const proxyPill = envIsProxied(env)
    ? `<span class="pill pill--proxy"><i class="fa-solid fa-shield-halved"></i>Proxy</span>`
    : `<span class="pill pill--local"><i class="fa-solid fa-network-wired"></i>Local IP</span>`;
  return `
    <div data-env="${escapeAttr(env.id)}" role="button" tabindex="0"
      class="env-tile group cursor-pointer${animate ? ' tile-in' : ''}" style="--i:${idx}">
      <div class="env-tile__glow"></div>
      <div class="flex items-center gap-3 mb-3">
        <span class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style="background:rgb(var(--brand-rgb)/.15);color:rgb(var(--brand-l-rgb))">
          <i class="fa-solid fa-layer-group"></i></span>
        <div class="min-w-0 flex-1">
          <p class="t16 font-bold text-white truncate">${escapeHtml(env.name)}</p>
          <p class="t10 font-mono text-slate-500 truncate" title="${escapeAttr(envEgressLabel(env))}">${envIsProxied(env)
            ? `<i class="fa-solid fa-globe mr-1" style="color:rgb(var(--listed-rgb))"></i>${escapeHtml(envEgressLabel(env))}`
            : 'local IP'}</p>
        </div>
        ${proxyPill}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div class="env-stat"><p class="k">Item worth</p><p class="v font-mono text-brand-light" title="${agg.accountCount ? escapeAttr(fmtCents(agg.valueCents)) : ''}">${agg.accountCount ? fmtCentsCompact(agg.valueCents) : '—'}</p></div>
        <div class="env-stat"><p class="k">Wallet</p><p class="v font-mono text-emerald-400" title="${agg.walletAccounts ? escapeAttr(fmtUsd(agg.walletUsd)) : ''}">${agg.walletAccounts ? fmtUsdCompact(agg.walletUsd) : '—'}</p></div>
        <div class="env-stat"><p class="k">Trade-locked</p><p class="v font-mono text-amber-400">${agg.accountCount ? fmtCount(agg.lockedStacks) : '—'}</p></div>
        <div class="env-stat"><p class="k">Accounts</p><p class="v font-mono text-white">${fmtCount(count)}</p></div>
      </div>
      <div class="flex items-center justify-between gap-2 mt-3 min-w-0">
        <span class="t10 text-slate-600 shrink-0" title="Newest inventory refresh in this environment">
          <i class="fa-regular fa-clock mr-1"></i>${last ? `updated ${escapeHtml(formatAgo(last))}` : 'never refreshed'}</span>
        <span id="proxytest-${escapeAttr(env.id)}" class="text-2xs text-slate-500 truncate min-w-0 flex-1 text-right"></span>
        <button data-proxy-test="${escapeAttr(env.id)}" title="Test this environment's proxy connection" class="btn btn-ghost btn-sm shrink-0">
          <i class="fa-solid fa-tower-broadcast"></i><span>Test proxy</span></button>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Sidebar tree (environment-scoped)
// ════════════════════════════════════════════════════════════════════════════

function envAccounts() { return state.allAccounts.filter((a) => a.environmentId === state.activeEnv); }
function visibleAccounts() { return envAccounts(); }   // W1_11: hide feature removed — all accounts always visible
function accountVisible() { return true; }             // W1_11: no-op (hide removed); kept — still used as a filter predicate for counts/render

/** Phase 2 (B+C): does an account pass the quick-filter (inventory state) + name search? */
function accountMatchesFilters(acc) {
  const f = state.accountFilter || 'all';
  if (f === 'has' || f === 'empty') {
    const inv = invFor(acc.username);
    const hasItems = !!inv && (inv.totalItems || 0) > 0;
    if (f === 'has' && !hasItems) return false;
    if (f === 'empty' && hasItems) return false;
  }
  const q = (state.accountSearch || '').trim().toLowerCase();
  if (q && !(`${acc.displayName || ''}`.toLowerCase().includes(q) || acc.username.toLowerCase().includes(q))) return false;
  return true;
}

/** Common-unit balance key (USD major) for sidebar balance sorting; null when the
 *  account has no cached wallet (or an unconvertible currency) → always sorts last. */
function accountBalanceKey(acc) {
  const v = walletToUsd(walletOf(acc.username));
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
/** Orders accounts by wallet balance; accounts without a known balance go last. */
function sortAccountsByBalance(accs, dir) {
  return [...accs].sort((a, b) => {
    const va = accountBalanceKey(a), vb = accountBalanceKey(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // unknown balance → after b
    if (vb == null) return -1;  // unknown balance → after a
    return dir === 'asc' ? va - vb : vb - va;
  });
}

function subtreeCount(node) {
  let n = node.accounts.filter(accountVisible).length;
  for (const c of node.children) n += subtreeCount(c);
  return n;
}

function renderNodes(nodes, depth) {
  return nodes.map((node, i) => renderFolderNode(node, depth, i, nodes.length)).join('');
}

function renderFolderNode(node, depth, sibIndex = 0, sibCount = 1) {
  const { id, name } = node.folder;
  const collapsed = state.collapsed.has(id);
  const pad = 8 + depth * 14;
  const count = subtreeCount(node);
  const isFirst = sibIndex === 0;
  const isLast = sibIndex === sibCount - 1;
  const activeFolder = state.invMode === 'folder' && state.activeFolder === id;
  const header = `
    <div class="folder-header group flex items-center gap-1.5 pr-2 py-1.5 rounded-lg hover:bg-slate-800/50 transition" style="padding-left:${pad}px">
      <button data-toggle="${escapeAttr(id)}" class="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-slate-300 shrink-0" aria-label="${collapsed ? 'Expand' : 'Collapse'} folder ${escapeAttr(name)}">
        <i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} t10"></i></button>
      <i class="fa-solid ${collapsed ? 'fa-folder' : 'fa-folder-open'} text-brand t12 shrink-0"></i>
      <span data-folder="${escapeAttr(id)}" title="Open folder master (aggregated inventory)"
        class="t12 font-semibold truncate flex-1 cursor-pointer ${activeFolder ? 'text-brand-light' : 'text-slate-300 hover:text-white'}">${escapeHtml(name)}</span>
      <span class="t10 font-mono text-slate-600 mr-1">${count}</span>
      <span class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button ${isFirst ? 'disabled' : `data-folderup="${escapeAttr(id)}"`} title="Move folder up" aria-label="Move folder ${escapeAttr(name)} up"
          class="btn btn-icon-sm btn-ghost ${isFirst ? 'opacity-40' : ''}"><i class="fa-solid fa-angle-up t10"></i></button>
        <button ${isLast ? 'disabled' : `data-folderdown="${escapeAttr(id)}"`} title="Move folder down" aria-label="Move folder ${escapeAttr(name)} down"
          class="btn btn-icon-sm btn-ghost ${isLast ? 'opacity-40' : ''}"><i class="fa-solid fa-angle-down t10"></i></button>
        <button data-ordersfolder="${escapeAttr(id)}" title="Active market orders for all accounts in this folder" aria-label="Active orders for folder ${escapeAttr(name)}" class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-receipt t10"></i></button>
        <button data-banfolder="${escapeAttr(id)}" title="Check bans for all accounts in this folder" aria-label="Check bans for folder ${escapeAttr(name)}" class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-shield-halved t10"></i></button>
        <button data-addsub="${escapeAttr(id)}" title="Create subfolder" aria-label="Create subfolder in ${escapeAttr(name)}" class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-folder-plus t10"></i></button>
        <button data-rename="${escapeAttr(id)}" data-name="${escapeAttr(name)}" title="Rename" aria-label="Rename folder ${escapeAttr(name)}" class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-pen t10"></i></button>
        <button data-delfolder="${escapeAttr(id)}" data-name="${escapeAttr(name)}" title="Delete folder (contents move up)" aria-label="Delete folder ${escapeAttr(name)}" class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-trash-can t10" style="color:rgb(var(--danger-rgb))"></i></button>
      </span>
    </div>`;
  const body = collapsed ? '' : renderNodes(node.children, depth + 1) + renderAccounts(node.accounts, depth + 1);
  return `<div class="folder-node">${header}${body}</div>`;
}

function renderAccounts(accounts, depth) {
  let accs = accounts.filter(accountVisible);
  // Balance sort reorders the accounts INSIDE this folder/root only — the folder
  // tree itself keeps its manual order (folders have no balance to sort by).
  if ((state.accountSort || 'default') !== 'default') {
    accs = sortAccountsByBalance(accs, state.accountSort === 'balance-asc' ? 'asc' : 'desc');
  }
  return accs.map((acc) => renderAccountRow(acc, depth)).join('');
}

function renderAccountRow(acc, depth) {
  const active = state.invMode === 'account' && acc.username === state.activeUsername;
  const pad = 8 + depth * 14;
  // Instant balance overview. STRICT states: a real wallet → its value (incl. 0,00); a refreshed
  // account with NO/empty Steam wallet → 0,00 (it IS zero, not unknown); never refreshed → '—'.
  const wallet = walletOf(acc.username);
  const refreshed = wasRefreshed(acc.username);
  const known = !!wallet || refreshed;
  // Empty/no-wallet but refreshed → 0 in the fleet's currency (e.g. "0,00 €"); never refreshed → '—'.
  const bal = wallet ? fmtWallet(wallet) : (refreshed ? fmtMoneyMinor(0, fleetCurrency()) : '—');
  const selected = state.selectedAccounts.has(acc.username);
  // UX: the FULL account name stays visible (no permanently-reserved action gutter). On hover
  // the balance fades out and the mini action buttons fade in over the same right-hand slot,
  // so they never truncate the name nor overlap the balance. P1 states (—/0,00/value) unchanged.
  return `
    <div class="account-row group relative flex items-stretch ${selected ? 'bg-brand/5 rounded-xl' : ''}" style="padding-left:${pad}px">
      <label class="acct-check-wrap flex items-center pl-1 pr-1.5 shrink-0 cursor-pointer" title="Select for multi-account actions (Mass Buy/Sell/Trade + master)">
        <input type="checkbox" data-selacct="${escapeAttr(acc.username)}" ${selected ? 'checked' : ''}
          aria-label="Select ${escapeAttr(acc.username)} for multi-account actions"
          class="acct-check w-4 h-4 rounded accent-brand cursor-pointer ${selected ? '' : 'opacity-40'}"></label>
      <button data-username="${escapeAttr(acc.username)}"
        class="account-btn flex-1 min-w-0 text-left pr-3 py-2 rounded-xl border border-transparent transition flex items-center gap-2.5
               ${active ? 'is-active' : 'hover:bg-slate-800/60'}">
        <span class="avatar shrink-0" style="width:2rem;height:2rem">
          <i class="fa-solid fa-user t11 ${active ? 'text-brand-light' : ''}"></i></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="t13 font-semibold truncate min-w-0 ${active ? 'text-white' : 'text-slate-200'}">
              ${escapeHtml(acc.username)}</span>
            ${acc.canConfirm === false ? `<span class="pill pill--ltd t10 shrink-0" style="padding:0 .4rem" title="Cannot confirm trades — its maFile has no identity_secret (or none is attached). Buy orders, market buys &amp; cancels work; sell listings &amp; trade offers need one. Attach a maFile to fix.">LTD</span>` : ''}
            <span class="acct-balance ml-auto shrink-0 t11 font-mono font-semibold leading-none transition-opacity group-hover:opacity-0 ${known ? 'text-emerald-400/90' : 'text-slate-600'}" title="${known ? 'Wallet balance' : 'Balance not fetched yet — refresh this account'}">${escapeHtml(bal)}</span>
          </div>
        </div>
      </button>
      <div class="acct-actions row-actions absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        <button data-otpcopy="${escapeAttr(acc.username)}" title="Copy Steam Guard code" aria-label="Copy Steam Guard code for ${escapeAttr(acc.username)}"
          class="otpcopy-btn btn btn-icon-sm btn-ghost"><i class="fa-solid fa-shield-halved t10"></i></button>
      </div>
    </div>`;
}
// (Edit / Move / Attach row buttons moved to the Accounts module's function bar, 2026-07-09 —
// account management belongs to Accounts; the Inventories row keeps only the quick OTP copy.)

function renderSidebar() {
  // HARD CONTEXT GUARD: never paint the account tree outside an environment context.
  // Async completions (refresh-all done, wallet updates, price-fill re-pulls) call this
  // unconditionally; on the dashboard they repopulated the context-hidden #account-list —
  // stale account rows showed on "All environments", clicking one wiped it (the click path
  // re-ran this with screen='dashboard'), and the next poll brought it back (owner report).
  // Mirrors updateSidebar()'s inEnv definition; keeps every call site safe by construction.
  const inEnvContext = state.screen === 'inventory' && state.invMode !== 'global' && !!state.activeEnv;
  if (!inEnvContext) {
    el.accountList.innerHTML = '';
    return;
  }
  el.accountCount.textContent = fmtCount(visibleAccounts().length);
  // A search term or quick-filter switches to a FLAT list across folders (ignoring
  // collapse) — you're looking for accounts, not browsing the tree. A balance SORT
  // alone keeps the folder tree intact and only reorders accounts WITHIN each folder
  // (see renderAccounts) so folders are never reordered by a balance they don't have.
  const filtering = (state.accountSearch || '').trim() !== '' || (state.accountFilter || 'all') !== 'all';
  const sorting = (state.accountSort || 'default') !== 'default';
  let html;
  if (filtering) {
    let matches = visibleAccounts().filter(accountMatchesFilters);
    if (sorting) matches = sortAccountsByBalance(matches, state.accountSort === 'balance-asc' ? 'asc' : 'desc');
    html = matches.length
      ? matches.map((a) => renderAccountRow(a, 0)).join('')
      : `<p class="t12 text-slate-600 px-3 py-6 text-center">No matching accounts.</p>`;
  } else {
    html = renderNodes(state.tree.folders, 0) + renderAccounts(state.tree.accounts, 0);
  }
  el.accountList.innerHTML = html || `<p class="t12 text-slate-600 px-3 py-6 text-center">No accounts.</p>`;
  // PERF-01: events are delegated once (setupDelegation) — no per-row re-binding here.
}

// ── PERF-01: ONE delegated listener per container (attached once in setupDelegation) ──
// replaces the per-row re-binding that ran on every render — eliminating the listener
// churn that made large fleets/inventories jank. Checks run most-specific-first.
/** One-click Steam Guard (TOTP) copy for a sidebar account row. Offline read — the
 *  shared_secret never leaves the backend (server.ts:670). The toast reports a SNAPSHOT
 *  of the remaining validity at fetch time (no live tick). */
async function copyAccountOtp(username) {
  try {
    const { code, msRemaining } = await api(`/api/accounts/${encodeURIComponent(username)}/otp`);
    await copyToClipboard(code);
    const secsLeft = Math.max(1, Math.ceil((Number(msRemaining) || 0) / 1000));
    toast(`Code ${code} copied · ${secsLeft}s left`, 'success');
  } catch (e) {
    if (e && e.status === 400) {
      toast('No Steam Guard secret for this account — attach a maFile to enable codes', 'warn');
    } else {
      toast(e && e.message ? e.message : 'Could not fetch Steam Guard code', 'error');
    }
  }
}

function onSidebarClick(e) {
  const t = e.target; let n;
  if ((n = t.closest('[data-toggle]')))     return toggleFolder(n.dataset.toggle);
  if ((n = t.closest('[data-folderup]')))   return reorderFolder(n.dataset.folderup, 'up');
  if ((n = t.closest('[data-folderdown]'))) return reorderFolder(n.dataset.folderdown, 'down');
  if ((n = t.closest('[data-addsub]')))     return openFolderModal({ mode: 'create', parentId: n.dataset.addsub });
  if ((n = t.closest('[data-rename]')))     return openFolderModal({ mode: 'rename', id: n.dataset.rename, name: n.dataset.name });
  if ((n = t.closest('[data-delfolder]')))  return deleteFolder(n.dataset.delfolder, n.dataset.name);
  if ((n = t.closest('[data-ordersfolder]'))) return openFolderOrders(n.dataset.ordersfolder);
  if ((n = t.closest('[data-banfolder]')))  return checkFolderBans(n.dataset.banfolder);
  if ((n = t.closest('.otpcopy-btn')))      return copyAccountOtp(n.dataset.otpcopy);
  if ((n = t.closest('[data-folder]')))     return openFolderMaster(n.dataset.folder);
  if (t.closest('.acct-check-wrap'))        return;   // label wrapper; checkbox handled on change
  if ((n = t.closest('.account-btn')))      return selectAccount(n.dataset.username);
}
function onSidebarChange(e) {
  const cb = e.target.closest('.acct-check');
  if (cb) toggleAccountSelect(cb);
}

/** PERF-01: update ONLY the wallet-balance chips in the sidebar — no list rebuild, scroll
 *  preserved. Mirrors renderAccountRow's strict P1 states (—/0,00/value) exactly. */
function patchSidebarBalances() {
  el.accountList.querySelectorAll('.account-row').forEach((row) => {
    const cb = row.querySelector('.acct-check');
    const u = cb && cb.dataset.selacct;
    const span = row.querySelector('.acct-balance');
    if (!u || !span) return;
    const wallet = walletOf(u);
    const refreshed = wasRefreshed(u);
    const known = !!wallet || refreshed;
    span.textContent = wallet ? fmtWallet(wallet) : (refreshed ? fmtMoneyMinor(0, fleetCurrency()) : '—');
    span.title = known ? 'Wallet balance' : 'Balance not fetched yet — refresh this account';
    span.classList.toggle('text-emerald-400/90', known);
    span.classList.toggle('text-slate-600', !known);
  });
}

/** PERF-01: attach the delegated container listeners ONCE (containers persist across renders). */
function setupDelegation() {
  el.accountList.addEventListener('click', onSidebarClick);
  el.accountList.addEventListener('change', onSidebarChange);
  el.itemsBody.addEventListener('change', onItemsBodyChange);
  el.itemsHead.addEventListener('click', onItemsHeadClick);
  el.itemsHead.addEventListener('change', onItemsHeadChange);
  el.activityBody?.addEventListener('click', onActivityClick);
}

/** Toggles one account's multi-select membership. The row's checked styling is flipped
 *  inline (no full rebuild → scroll stays put while ticking many boxes); the view itself
 *  is then driven automatically by syncSelectionView(). */
function toggleAccountSelect(cb) {
  const u = cb.dataset.selacct;
  if (cb.checked) state.selectedAccounts.add(u); else state.selectedAccounts.delete(u);
  cb.closest('.account-row')?.classList.toggle('bg-brand/5', cb.checked);
  cb.closest('.account-row')?.classList.toggle('rounded-lg', cb.checked);
  syncSelectionView();
}

/** The checkbox selection DRIVES the main view automatically — there is no manual toolbar.
 *  Any ticked account ⇒ Selection Master (live-aggregated). All unticked ⇒ restore the exact
 *  view the user was on before they started selecting. */
function syncSelectionView() {
  const n = state.selectedAccounts.size;
  if (n > 0) {
    if (state.invMode !== 'selection') {
      // entering: remember where we were so we can return on clear
      state.preSelection = { invMode: state.invMode, activeUsername: state.activeUsername, activeFolder: state.activeFolder };
      state.invMode = 'selection';
      state.activeUsername = null; state.activeFolder = null;
      updateSidebar();
      renderSidebar();   // one-time on entry: clears any stale active-account highlight
    }
    renderMain();        // (re)aggregate live as boxes toggle
  } else if (state.invMode === 'selection') {
    // selection emptied → leave the Selection Master, restore the prior view
    const prev = state.preSelection || {};
    state.invMode = (prev.invMode && prev.invMode !== 'selection') ? prev.invMode : 'env-master';
    state.activeUsername = prev.activeUsername || null;
    state.activeFolder = prev.activeFolder || null;
    state.preSelection = null;
    updateSidebar();
    renderSidebar();
    renderMain();
  }
}

/** "Select all" — tick every account in the active environment, then show the master. */
function selectAllAccounts() {
  for (const a of envAccounts()) state.selectedAccounts.add(a.username);
  renderSidebar();       // reflect all checks
  syncSelectionView();   // enter / re-aggregate the Selection Master
}

/** "Clear" — untick everything and fall back to the pre-selection view. */
function clearSelectionAndRevert() {
  clearAccountSelection();
  syncSelectionView();   // n === 0 → reverts the view + re-renders the sidebar unchecked
}

function toggleFolder(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
  saveCollapsed();
  renderSidebar();
}

// ════════════════════════════════════════════════════════════════════════════
//  Main render dispatch
// ════════════════════════════════════════════════════════════════════════════

// ── NAV-01: persistent breadcrumb / context spine (truthful across all 6 view modes) ──
function renderBreadcrumb() {
  const bc = el.breadcrumb;
  if (!bc) return;
  if (state.screen !== 'inventory') { bc.classList.add('hidden'); bc.innerHTML = ''; return; }
  const env = state.environments.find((e) => e.id === state.activeEnv);
  const seg = [{ label: 'All inventories', go: 'dash' }];
  if (state.invMode === 'global') {
    seg.push({ label: 'Global Master' });
  } else if (env) {
    seg.push({ label: env.name, go: 'env' });
    if (state.invMode === 'folder') {
      const node = findFolderNode(state.tree.folders, state.activeFolder);
      if (node) seg.push({ label: node.folder.name });
    } else if (state.invMode === 'selection') {
      seg.push({ label: `Multi-Select (${state.selectedAccounts.size})` });
    } else if (state.invMode === 'account' && state.activeUsername) {
      const acc = state.allAccounts.find((a) => a.username === state.activeUsername);
      if (acc && acc.folderId) {
        const fnode = findFolderNode(state.tree.folders, acc.folderId);
        if (fnode) seg.push({ label: fnode.folder.name, go: 'folder', id: acc.folderId });
      }
      seg.push({ label: (acc && (acc.displayName || acc.username)) || state.activeUsername });
    }
    // env-master → just Environments › {env}
  }
  bc.classList.remove('hidden');
  // Masterpiece spine: chevron separators + brand-light active (last) segment (design_source:1615).
  bc.innerHTML = seg.map((s, i) => {
    const last = i === seg.length - 1;
    const sep = i > 0 ? '<i class="fa-solid fa-chevron-right t10 text-slate-700 mx-2" aria-hidden="true"></i>' : '';
    const cls = last ? 'text-brand-light font-medium' : 'text-slate-400';
    return s.go && !last
      ? `${sep}<button data-bc="${s.go}"${s.id ? ` data-bc-id="${escapeAttr(s.id)}"` : ''} class="${cls} hover:text-brand-light transition">${escapeHtml(s.label)}</button>`
      : `${sep}<span class="${cls}"${last ? ' aria-current="page"' : ''}>${escapeHtml(s.label)}</span>`;
  }).join('');
  bc.querySelectorAll('[data-bc]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.bc;
    if (a === 'dash') showDashboard();
    else if (a === 'env') selectEnvMaster();
    else if (a === 'folder') openFolderMaster(b.dataset.bcId);
  }));
}

// ── Top-level module render entries (W1_10 stubs; later waves replace the bodies) ──
// ── W1_12 Dashboard (fleet summary + value graph) — read-only aggregation of the cache ──
// Mount entry (called by setNav('dashboard')): build the body skeleton once, kick off the two
// read-only GETs, then paint tiles from current state (loading → data). No login, no per-account loop.
function renderSummary() {
  ensureSummarySkeleton();
  fetchDashboardSummary();
  loadDashboardHistory();
  paintSummary();
}

// Body skeleton — created ONCE so the async graph draw and the tile re-paints never clobber
// each other. Density-first (owner 2026-07-09): compact KPI grid, then the GRAPH immediately
// (visible without scrolling), then the two compact Top-10 lists.
function ensureSummarySkeleton() {
  const body = document.getElementById('summary-body');
  if (!body || body.dataset.mounted === '1') return;
  body.dataset.mounted = '1';
  body.innerHTML =
    `<div id="summary-kpis"></div>
     <div class="mt-3 p-4 rounded-2xl border border-slate-800 bg-slate-900/40">
       <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
         <h3 class="t12 font-bold text-white uppercase tracking-wider">Fleet value over time</h3>
         <div id="summary-legend" class="flex items-center gap-3 t11 text-slate-400"></div>
       </div>
       <div id="summary-chart"></div>
     </div>
     <div id="summary-toplists" class="mt-3"></div>`;
}

async function fetchDashboardSummary() {
  try {
    state.dashSummary = await api('/api/dashboard/summary');
  } catch (e) {
    state.dashSummary = null;
    toast(e && e.message ? e.message : 'Could not load the dashboard summary', 'error');
  }
  paintSummary();   // re-paint tiles only (never the chart panel)
}

async function loadDashboardHistory() {
  const chart = document.getElementById('summary-chart');
  const legend = document.getElementById('summary-legend');
  if (!chart || !legend) return;
  try {
    const points = await api('/api/dashboard/history');
    renderHistoryChart(Array.isArray(points) ? points : [], chart, legend);
  } catch { renderHistoryChart([], chart, legend); }
}

function dashAgo(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function dashFreshnessLine(s) {
  if (!s || !s.asOf) return 'Fleet summary across your environments.';
  return `As of last refresh · newest ${dashAgo(s.asOf)} · oldest ${dashAgo(s.oldestAsOf)}`;
}

// One stat card. `big` is trusted HTML (caller builds it); label/sub are the caller's responsibility to escape.
function dashCard(label, big, opts = {}) {
  const { sub = '', accent = 'brand', wide = false } = opts;
  return `<div class="stat-card ${wide ? 'sm:col-span-2 xl:col-span-3' : ''}" style="--stat-accent:rgb(var(--${accent}-rgb))">
    <p class="stat-label">${escapeHtml(label)}</p>
    <p class="stat-value text-white font-mono ${wide ? 't28' : ''}">${big}</p>
    ${sub ? `<p class="t10 text-slate-500 mt-1">${sub}</p>` : ''}
  </div>`;
}

// One ranked Top-10 list card — COMPACT (dashboard = density): one slim line per item,
// capped height with inner scroll so the two lists never push the page tall.
// `mode` picks the emphasized figure: 'value' → unit price (rarest skins), 'owned' → quantity.
function dashTopList(title, icon, entries, mode) {
  const list = Array.isArray(entries) ? entries : [];
  const rows = list.map((e, i) => {
    const gamePill = `<span class="t10 px-1 rounded font-bold shrink-0 ${e.game === 'tf2'
      ? 'text-amber-300' : 'text-brand-light'}" style="background:rgb(var(--${e.game === 'tf2' ? 'warn' : 'brand'}-rgb) / .12)">${e.game === 'tf2' ? 'TF2' : 'CS2'}</span>`;
    const big = mode === 'value'
      ? `<span class="t11 font-mono font-bold text-brand-light" title="${escapeAttr(fmtCents(e.unitCents))} each">${fmtCentsCompact(e.unitCents)}</span>`
      : `<span class="t11 font-mono font-bold text-white">${fmtCount(e.qty)}×</span>`;
    const sub = mode === 'value'
      ? `<span class="t10 text-slate-600 font-mono">×${fmtCount(e.qty)}</span>`
      : `<span class="t10 text-slate-600 font-mono" title="${e.unitCents == null ? '' : escapeAttr(`${fmtCents(e.unitCents)} each`)}">${e.totalCents ? fmtCentsCompact(e.totalCents) : ''}</span>`;
    return `<li class="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-slate-800/60 transition">
      <span class="w-4 shrink-0 text-center t10 font-mono font-bold ${i === 0 ? 'text-amber-300' : i < 3 ? 'text-slate-300' : 'text-slate-600'}">${i + 1}</span>
      ${gamePill}
      <span class="t11 text-slate-200 truncate flex-1 min-w-0" title="${escapeAttr(e.name)}">${escapeHtml(e.name)}</span>
      ${big}${sub}
    </li>`;
  }).join('');
  return `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-3 min-w-0">
    <h3 class="t11 font-bold text-white uppercase tracking-wider mb-1.5 px-1">
      <i class="fa-solid ${icon} mr-1.5 text-brand"></i>${escapeHtml(title)}</h3>
    ${list.length
      ? `<ul class="max-h-52 overflow-y-auto pr-1">${rows}</ul>`
      : `<p class="t11 text-slate-600 px-1 py-3">No priced items in cache yet — refresh some inventories.</p>`}
  </section>`;
}

// Pure formatting from state.dashSummary into the header + #summary-kpis grid.
// Basis is GROSS market value only — the Gross/Net toggle was removed (owner, 2026-07-09).
function paintSummary() {
  const s = state.dashSummary;
  if (el.summaryHeader) {
    el.summaryHeader.innerHTML =
      `<div>
        <h2 class="t28 font-bold text-white tracking-tight">Dashboard</h2>
        <p class="t14 text-slate-500 mt-1">${escapeHtml(dashFreshnessLine(s))}</p>
      </div>`;
  }
  const kpis = document.getElementById('summary-kpis');
  if (!kpis) return;
  if (!s) {
    kpis.innerHTML = `<div class="empty py-16"><div class="empty-icon"><i class="fa-solid fa-spinner cs2-spin"></i></div><p class="empty-title">Loading fleet summary…</p></div>`;
    return;
  }
  const money = (c) => fmtCentsCompact(c);
  const exact = (c) => fmtCents(c);
  const partialHint = s.items.partial ? ` · <span class="text-amber-400/80" title="Some prices are still loading — this total will rise as they fill.">~ prices loading</span>` : '';
  const neverChip = s.counts.accountsNeverRefreshed > 0 ? `${fmtCount(s.counts.accountsNeverRefreshed)} not refreshed` : 'all refreshed';
  const unknownChip = s.counts.walletUnknown > 0 ? `${fmtCount(s.counts.walletUnknown)} wallet unknown/excluded` : '&nbsp;';
  const cell = (c) => `<span title="${escapeAttr(exact(c))}">${money(c)}</span>`;
  const keys = s.tf2Keys || { count: 0, grossCents: 0 };

  // EXACTLY 8 cards in a 4-column grid → two rows; the graph sits directly below (density-first).
  kpis.innerHTML =
    `<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      ${dashCard('Grand Total', cell(s.grandTotal.grossCents), { accent: 'brand', sub: `items + balance · gross${partialHint}` })}
      ${dashCard('Items Value', cell(s.items.totalGrossCents), { accent: 'brand', sub: `${fmtCount(s.items.totalCount)} items${partialHint}` })}
      ${dashCard('Total Balance', cell(s.balance.usdCents), { accent: 'success', sub: unknownChip })}
      ${dashCard('Trade-Locked', `<span title="${escapeAttr(exact(s.tradelocked.grossCents))}">${fmtCount(s.tradelocked.count)}</span>`, { accent: 'warn', sub: `worth ${money(s.tradelocked.grossCents)}` })}
      ${dashCard('CS2 Value', cell(s.items.cs2.grossCents), { accent: 'brand', sub: `${fmtCount(s.items.cs2.count)} items` })}
      ${dashCard('TF2 Value', cell(s.items.tf2.grossCents), { accent: 'brand', sub: `${fmtCount(s.items.tf2.count)} items` })}
      ${dashCard('TF2 Keys', `<span title="${escapeAttr(exact(keys.grossCents))}">${fmtCount(keys.count)}</span>`, { accent: 'warn', sub: `worth ${money(keys.grossCents)}` })}
      ${dashCard('Fleet', fmtCount(s.counts.accounts), { accent: 'brand', sub: `${fmtCount(s.counts.environments)} environments · ${fmtCount(s.counts.accountsWithInventory)} with inventory · ${neverChip}` })}
    </div>`;

  const toplists = document.getElementById('summary-toplists');
  if (toplists) {
    toplists.innerHTML =
      `<div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
        ${dashTopList('Top 10 · Most valuable', 'fa-gem', s.topValuable, 'value')}
        ${dashTopList('Top 10 · Most owned', 'fa-layer-group', s.topOwned, 'owned')}
      </div>`;
  }
}
// ══════════════════════════════════════════════════════════════════════════════
//  W1_13 — Portfolios (cross-environment value: CS2 + TF2 + wallet, both games)
//  Pure client-side aggregation of already-cached inventories/wallets. Reads BOTH
//  caches explicitly (never invFor/state.game). Money tri-state honest.
// ══════════════════════════════════════════════════════════════════════════════

// Sum both games' item worth + wallet for one environment. A column is null only when NO
// account in the env has that datum cached (→ "—"); a refreshed-empty account keeps it a real 0.
function envBreakdown(envId) {
  const accts = state.allAccounts.filter((a) => a.environmentId === envId);
  let cs2Cents = 0, cs2Loaded = 0, tf2Cents = 0, tf2Loaded = 0, walletUsd = 0, walletAccounts = 0;
  let tf2Keys = 0, lockedCount = 0;
  for (const a of accts) {
    const u = a.username, lc = u.toLowerCase();
    const cs2 = state.inventories[u] || state.inventories[lc];
    const tf2 = state.tf2Inventories[u] || state.tf2Inventories[lc];
    if (cs2) {
      cs2Loaded++; cs2Cents += cs2.totalValueUsd || 0;
      for (const it of cs2.items) if (it.tradeLockExpiry) lockedCount += it.quantity || 1;
    }
    if (tf2) {
      tf2Loaded++; tf2Cents += tf2.totalValueUsd || 0;
      tf2Keys += countTf2Keys(tf2.items);
      for (const it of tf2.items) if (it.tradeLockExpiry) lockedCount += it.quantity || 1;
    }
    const wu = walletToUsd(walletOf(u));
    if (wu != null) { walletUsd += wu; walletAccounts++; }
  }
  return {
    accountCount: accts.length,
    cs2Cents: cs2Loaded ? cs2Cents : null,
    tf2Cents: tf2Loaded ? tf2Cents : null,
    walletUsd: walletAccounts ? walletUsd : null,
    tf2Keys, lockedCount,
    cs2Loaded, tf2Loaded, walletAccounts,
  };
}

// Per-env grand total in USD cents: items(CS2)+items(TF2)+wallet(→cents). null iff all three null.
function envGrandCents(br) {
  if (br.cs2Cents == null && br.tf2Cents == null && br.walletUsd == null) return null;
  return (br.cs2Cents || 0) + (br.tf2Cents || 0) + Math.round((br.walletUsd || 0) * 100);
}

// Grand total across the SELECTED environments (state.globalEnvs).
function portfolioGrand() {
  let cs2 = 0, tf2 = 0, wallet = 0, anyCs2 = false, anyTf2 = false, anyWallet = false;
  for (const env of state.environments) {
    if (!state.globalEnvs.has(env.id)) continue;
    const br = envBreakdown(env.id);
    if (br.cs2Cents != null) { cs2 += br.cs2Cents; anyCs2 = true; }
    if (br.tf2Cents != null) { tf2 += br.tf2Cents; anyTf2 = true; }
    if (br.walletUsd != null) { wallet += br.walletUsd; anyWallet = true; }
  }
  return {
    cs2Cents: anyCs2 ? cs2 : null,
    tf2Cents: anyTf2 ? tf2 : null,
    walletUsd: anyWallet ? wallet : null,
    grandCents: (!anyCs2 && !anyTf2 && !anyWallet) ? null : cs2 + tf2 + Math.round(wallet * 100),
  };
}

// One-shot lazy TF2 load so the TF2 column isn't a false "—". Re-renders on settle.
function ensureTf2ForPortfolios() {
  if (state.tf2Loaded || state.tf2LoadError || state._tf2Loading) return;
  state._tf2Loading = true;
  loadTf2Inventories().finally(() => {
    state._tf2Loading = false;
    if (state.nav === 'portfolios') renderPortfolios();
  });
}

// TF2 column is honest about the lazy cache: … while loading, retry on error, "—"/value otherwise.
function tf2Cell(br) {
  if (!state.tf2Loaded && state.tf2LoadError) {
    return `<button data-pf-tf2-retry class="text-amber-400 hover:text-amber-300 underline decoration-dotted" title="${escapeAttr(state.tf2LoadError)}">TF2 failed — retry</button>`;
  }
  if (!state.tf2Loaded) return `<span class="text-slate-600">…</span>`;
  return `<span title="${br.tf2Cents == null ? '' : escapeAttr(fmtCents(br.tf2Cents))}">${fmtCentsCompact(br.tf2Cents)}</span>`;
}

function renderPortfolios() {
  // Open with every environment selected (matches the legacy global-master default-fill).
  if (state.globalEnvs.size === 0 && state.environments.length) {
    for (const env of state.environments) state.globalEnvs.add(env.id);
  }
  ensureTf2ForPortfolios();

  const g = portfolioGrand();
  if (el.portfoliosHeader) {
    el.portfoliosHeader.innerHTML =
      `<div class="flex items-center justify-between flex-wrap gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="t28 font-bold text-white tracking-tight">Portfolios</h2>
            <span class="t10 px-2 py-0.5 rounded-full" style="background:rgb(var(--brand-rgb) / .15); color:rgb(var(--brand-rgb))">Cross-environment</span>
          </div>
          <p class="t14 text-slate-500 mt-1">${state.globalEnvs.size} of ${state.environments.length} environments selected · CS2 + TF2 + wallet</p>
        </div>
        <div class="text-right shrink-0">
          <p class="t10 font-semibold uppercase tracking-wider text-slate-500">Grand total · ${state.globalEnvs.size} selected</p>
          <p class="t28 font-mono font-bold text-brand-light leading-tight" title="${g.grandCents == null ? '' : escapeAttr(fmtCents(g.grandCents))}">${fmtCentsCompact(g.grandCents)}</p>
          <p class="t11 text-slate-500 font-mono">CS2 ${fmtCentsCompact(g.cs2Cents)} · TF2 ${fmtCentsCompact(g.tf2Cents)} · Wallet ${fmtUsdCompact(g.walletUsd)}</p>
        </div>
      </div>`;
  }
  if (!el.portfoliosBody) return;

  el.portfoliosBody.innerHTML = state.environments.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        ${state.environments.map((env, i) => portfolioTile(env, i)).join('')}
      </div>`
    : `<div class="empty py-20"><div class="empty-icon"><i class="fa-solid fa-layer-group"></i></div><p class="empty-title">No environments yet</p><p class="empty-sub">Create an environment to see it here.</p></div>`;

  wirePortfolioDelegation();
  void loadPortfolioSparks();
}

// One portfolio card — the same .env-tile/.env-stat look the Environments picker uses, so the
// two grids read as one family. The whole card opens the env in Inventories (data-pf-open);
// only the leading checkbox toggles grand-total inclusion (data-genv2 — delegation checks it first).
function portfolioTile(env, idx = 0) {
  const on = state.globalEnvs.has(env.id);
  const br = envBreakdown(env.id);
  const grand = envGrandCents(br);
  const anyLoaded = (br.cs2Loaded + br.tf2Loaded) > 0;
  const stat = (k, vHtml, tone = '') =>
    `<div class="env-stat"><p class="k">${k}</p><p class="v font-mono ${tone}">${vHtml}</p></div>`;
  const money = (c) => `<span title="${c == null ? '' : escapeAttr(fmtCents(c))}">${fmtCentsCompact(c)}</span>`;
  const keysCell = !state.tf2Loaded ? '<span class="text-slate-600">…</span>' : (br.tf2Loaded ? fmtCount(br.tf2Keys) : '—');
  const lockedCell = anyLoaded ? fmtCount(br.lockedCount) : '—';
  return `
    <div data-pf-open="${escapeAttr(env.id)}" role="button" tabindex="0" title="Open in Inventories"
      class="env-tile group cursor-pointer" style="--i:${idx}">
      <div class="env-tile__glow"></div>
      <div class="${on ? '' : 'opacity-45'}">
        <div class="flex items-center gap-2.5 mb-3 min-w-0">
          <button data-genv2="${escapeAttr(env.id)}" aria-pressed="${on}" title="Include in the grand total"
            class="shrink-0 t16 ${on ? 'text-brand' : 'text-slate-600'} hover:text-brand-light transition">
            <i class="fa-solid ${on ? 'fa-square-check' : 'fa-square'}"></i></button>
          <div class="min-w-0 flex-1">
            <p class="t14 font-bold text-white truncate">${escapeHtml(env.name)}</p>
            <p class="t10 text-slate-500">${fmtCount(br.accountCount)} account(s)</p>
          </div>
          <span class="pill pill--brand shrink-0" title="${grand == null ? 'No cached data yet' : escapeAttr(fmtCents(grand))}">${fmtCentsCompact(grand)}</span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          ${stat('CS2 worth', money(br.cs2Cents), 'text-brand-light')}
          ${stat('TF2 worth', tf2Cell(br), 'text-brand-light')}
          ${stat('TF2 keys', keysCell, 'text-amber-300')}
          ${stat('Trade-locked', lockedCell, 'text-amber-400')}
          ${stat('Wallet', `<span title="${br.walletUsd == null ? '' : escapeAttr(fmtUsd(br.walletUsd))}">${fmtUsdCompact(br.walletUsd)}</span>`, 'text-emerald-400')}
          ${stat('Grand total', money(grand), 'text-white font-bold')}
        </div>
        <div data-spark="${escapeAttr(env.id)}" class="mt-3 h-10"></div>
      </div>
    </div>`;
}

// ── Per-card sparkline: CS2+TF2 series carry-forward-merged client-side (same join as the
// backend /api/dashboard/history), then drawn as one grand-total (items+wallet) curve. ──
const pfSparkCache = new Map();   // envId → merged HistoryPoint[] (cleared with invalidateHistory)

function mergeGameSeries(cs2, tf2) {
  const series = [cs2, tf2].filter((a) => Array.isArray(a) && a.length > 0);
  if (series.length === 0) return [];
  if (series.length === 1) return series[0];
  const ts = [...new Set(series.flatMap((a) => a.map((p) => p.t)))].sort((a, b) => a - b);
  const cur = series.map(() => 0);
  return ts.map((t) => {
    let items = 0, wallet = null;
    series.forEach((arr, s) => {
      let i = cur[s];
      while (i + 1 < arr.length && arr[i + 1].t <= t) i++;
      cur[s] = i;
      const p = arr[i];
      if (p && p.t <= t) { items += p.items; if (wallet === null) wallet = p.wallet; }  // wallet once
    });
    return { t, items, wallet: wallet || 0 };
  });
}

function pfSparkline(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && typeof p.t === 'number');
  if (pts.length < 2) return `<p class="t10 text-slate-600 text-center pt-3">History grows with the next refresh.</p>`;
  const W = 240, H = 40, P = 3;
  const t0 = pts[0].t, span = Math.max(1, pts[pts.length - 1].t - t0);
  const vals = pts.map((p) => (p.items || 0) + (p.wallet || 0));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { hi += 1; lo = Math.max(0, lo - 1); }
  const x = (t) => P + ((t - t0) / span) * (W - 2 * P);
  const y = (v) => P + (H - 2 * P) - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const d = smoothLinePath(pts.map((p, i) => [x(p.t), y(vals[i])]), P, H - P);
  const area = `${d}L${(W - P).toFixed(1)},${H - P}L${P},${H - P}Z`;
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-10 block" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" fill="rgb(var(--brand-rgb) / .12)"/>
    <path d="${d}" fill="none" stroke="rgb(var(--brand-rgb))" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

async function loadPortfolioSparks() {
  if (!el.portfoliosBody) return;
  const jobs = [...el.portfoliosBody.querySelectorAll('[data-spark]')].map(async (m) => {
    const envId = m.dataset.spark;
    let pts = pfSparkCache.get(envId);
    if (!pts) {
      try {
        const [cs2, tf2] = await Promise.all([
          api(`/api/history/${encodeURIComponent(envId)}?game=cs2`),
          api(`/api/history/${encodeURIComponent(envId)}?game=tf2`),
        ]);
        pts = mergeGameSeries(cs2, tf2);
      } catch { pts = []; }
      pfSparkCache.set(envId, pts);
    }
    // The body may have re-rendered while we awaited — paint the CURRENT mount for this env.
    const live = el.portfoliosBody.querySelector(`[data-spark="${CSS.escape(envId)}"]`);
    if (live && state.nav === 'portfolios') live.innerHTML = pfSparkline(pts);
  });
  await Promise.allSettled(jobs);
}

// One delegated listener on the body (PERF-01), attached once and surviving re-renders.
function wirePortfolioDelegation() {
  if (!el.portfoliosBody || el.portfoliosBody.dataset.wired === '1') return;
  el.portfoliosBody.dataset.wired = '1';
  el.portfoliosBody.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-genv2]');
    if (chip) {
      const id = chip.dataset.genv2;
      if (state.globalEnvs.has(id)) state.globalEnvs.delete(id); else state.globalEnvs.add(id);
      return renderPortfolios();
    }
    const open = e.target.closest('[data-pf-open]');
    if (open) return openPortfolioEnv(open.dataset.pfOpen);
    const retry = e.target.closest('[data-pf-tf2-retry]');
    if (retry) { state.tf2LoadError = null; state.tf2Loaded = false; ensureTf2ForPortfolios(); return renderPortfolios(); }
  });
}

async function openPortfolioEnv(envId) {
  setNav('inventories');            // Lock A: rail-highlight + sidebar un-gate
  await enterEnvironment(envId);    // invMode='env-master', loadTree, renderMain
}
// ══════════════════════════════════════════════════════════════════════════════
//  W2_20 — Accounts module (per-account Steam management: wallet / profile / games)
//  Self-contained: aggregate table → click an account → a card with wallet, profile
//  (inline edit) and owned-games (scan + add free-on-demand). Mutations are ssimConfirm-
//  gated. ⚠ The /api/steam/* backend needs a live Steam session — joint acceptance test.
// ══════════════════════════════════════════════════════════════════════════════
const ACC_IN = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 t13 focus:border-brand outline-none';

// Accounts module = the EXACT Inventories layout twin (owner 2026-07-09): an env-tile picker
// (less info: balance + account count) → click an env → left sidebar with the account list,
// right pane with the selected account's functions.
function renderAccountsModule() {
  ensureAccountsWiring();
  const envValid = state.accEnv && state.environments.some((e) => e.id === state.accEnv);
  if (!envValid) { state.accEnv = null; state.accountsUser = null; return renderAccountsPicker(); }
  if (state.accountsUser) {
    const a = state.allAccounts.find((x) => x.username === state.accountsUser);
    if (!a || a.environmentId !== state.accEnv) state.accountsUser = null;   // stale selection
  }
  renderAccountsEnv();
}

function ensureAccountsWiring() {
  const body = el.accountsBody || document.getElementById('accounts-body');
  if (!body || body.dataset.wired === '1') return;
  body.dataset.wired = '1';
  body.addEventListener('click', onAccountsClick);
  body.addEventListener('input', onAccountsInput);
  if (el.accountsHeader) el.accountsHeader.addEventListener('click', onAccountsClick);   // Back / header buttons
}
function acctBusy(u, kind) { return state.accountsBusy[u] === kind; }
function setAcctBusy(u, kind) { state.accountsBusy[u] = kind; }

// ── Accounts picker: env-tile card grid (same .env-tile look as Inventories, LESS info —
//    balance + account count only). All top-level ADD controls live in this header. ──
function renderAccountsPicker() {
  if (el.accountsHeader) {
    el.accountsHeader.innerHTML =
      `<div class="flex items-center justify-between flex-wrap gap-3">
        <div><h2 class="t28 font-bold text-white tracking-tight">Accounts</h2>
          <p class="t14 text-slate-500 mt-1">Environments — choose one to manage its accounts.</p></div>
        <div class="flex gap-2 flex-wrap">
          <button data-acc-login class="btn btn-secondary" title="Log in &amp; import an account via QR or credentials">
            <i class="fa-solid fa-right-to-bracket text-brand"></i><span>Account Login</span></button>
          <button data-acc-import class="btn btn-secondary"><i class="fa-solid fa-file-import"></i><span>Import bots</span></button>
          <button data-acc-newenv class="btn bg-brand text-white"><i class="fa-solid fa-plus"></i><span>New environment</span></button>
        </div>
      </div>`;
  }
  if (!el.accountsBody) return;
  el.accountsBody.className = 'flex-1 overflow-y-auto p-8';
  el.accountsBody.innerHTML = state.environments.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
        ${state.environments.map((e, i) => accEnvTile(e, i)).join('')}
      </div>`
    : `<div class="empty py-20"><div class="empty-icon"><i class="fa-solid fa-user-gear"></i></div>
        <p class="empty-title">No environments yet</p>
        <p class="empty-sub">Create your first environment, then import or add accounts.</p></div>`;
}

function accEnvTile(env, idx = 0) {
  const accs = state.allAccounts.filter((a) => a.environmentId === env.id);
  let walletUsd = 0, walletAccounts = 0;
  for (const a of accs) {
    const wu = walletToUsd(walletOf(a.username));
    if (wu != null) { walletUsd += wu; walletAccounts++; }
  }
  return `
    <div data-accenv="${escapeAttr(env.id)}" role="button" tabindex="0"
      class="env-tile group cursor-pointer" style="--i:${idx}">
      <div class="env-tile__glow"></div>
      <div class="env-tile__actions">
        <button data-accenv-edit="${escapeAttr(env.id)}" title="Rename environment" class="btn btn-icon-sm btn-secondary">
          <i class="fa-solid fa-pen t11"></i></button>
        <button data-accenv-del="${escapeAttr(env.id)}" title="Delete environment" class="btn btn-icon-sm btn-secondary">
          <i class="fa-solid fa-trash-can t11" style="color:rgb(var(--danger-rgb))"></i></button>
      </div>
      <div class="flex items-center gap-3 mb-3">
        <span class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style="background:rgb(var(--brand-rgb)/.15);color:rgb(var(--brand-l-rgb))">
          <i class="fa-solid fa-user-gear"></i></span>
        <div class="min-w-0 flex-1">
          <p class="t16 font-bold text-white truncate">${escapeHtml(env.name)}</p>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div class="env-stat"><p class="k">Balance</p><p class="v font-mono text-emerald-400" title="${walletAccounts ? escapeAttr(fmtUsd(walletUsd)) : ''}">${walletAccounts ? fmtUsdCompact(walletUsd) : '—'}</p></div>
        <div class="env-stat"><p class="k">Accounts</p><p class="v font-mono text-white">${fmtCount(accs.length)}</p></div>
      </div>
    </div>`;
}

// ── Accounts env view: left sidebar (folder tree + account rows — the Inventories sidebar's
//    twin, incl. the per-env ADD controls) + right pane with the selected account's functions. ──
function renderAccountsEnv() {
  const env = state.environments.find((e) => e.id === state.accEnv);
  const accs = state.allAccounts.filter((a) => a.environmentId === state.accEnv);
  if (el.accountsHeader) {
    el.accountsHeader.innerHTML =
      `<div class="flex items-center gap-3 flex-wrap">
        <button data-accenv-back class="btn btn-secondary btn-sm"><i class="fa-solid fa-arrow-left"></i><span>All accounts</span></button>
        <div><div class="flex items-center gap-2 flex-wrap">
          <h2 class="t28 font-bold text-white tracking-tight">${escapeHtml(env.name)}</h2>
          <span class="pill pill--brand">Accounts</span></div>
          <p class="t12 text-slate-500 mt-0.5">${fmtCount(accs.length)} account(s) · click one to manage it</p></div>
        <div class="flex items-center gap-2 ml-auto">
          <button data-accenv-edit="${escapeAttr(env.id)}" class="btn btn-secondary btn-sm" title="Rename this environment">
            <i class="fa-solid fa-pen"></i><span>Rename</span></button>
          <button data-accenv-del="${escapeAttr(env.id)}" class="btn btn-secondary btn-sm" title="Delete this environment">
            <i class="fa-solid fa-trash-can" style="color:rgb(var(--danger-rgb))"></i><span>Delete</span></button>
        </div>
      </div>`;
  }
  if (!el.accountsBody) return;
  el.accountsBody.className = 'flex-1 overflow-hidden flex';
  el.accountsBody.innerHTML =
    `<aside class="app-sidebar w-72 shrink-0 border-r border-slate-800 flex flex-col">
      <div class="px-4 pt-3 space-y-2">
        <div class="flex gap-2">
          <button data-acctree-addacct="${escapeAttr(env.id)}"
            class="flex-1 px-2 py-2 rounded-xl bg-brand hover:bg-brand-dark text-white t12 font-bold transition flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-plus"></i><span>Account</span></button>
          <button data-acctree-addfolder="${escapeAttr(env.id)}" title="Create new folder"
            class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 t12 transition">
            <i class="fa-solid fa-folder-plus"></i></button>
        </div>
        <div class="relative">
          <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs z-10"></i>
          <input data-acctree-search type="text" autocomplete="off" placeholder="Search accounts…"
            value="${escapeAttr(state.accTree.search || '')}" class="field pl-8 py-2 t12" />
        </div>
        ${state.accSel.size ? `
        <div class="flex items-center gap-2 px-1">
          <span class="t11 text-slate-400 flex-1">${fmtCount(state.accSel.size)} selected</span>
          <button data-accsel-move class="btn btn-secondary btn-sm" title="Move the selected accounts to another environment/folder">
            <i class="fa-solid fa-folder-tree t10"></i><span>Move</span></button>
          <button data-accsel-clear class="btn btn-ghost btn-sm" title="Clear selection"><i class="fa-solid fa-xmark t10"></i></button>
        </div>` : ''}
      </div>
      <nav id="acc-env-list" class="flex-1 overflow-y-auto px-3 py-2 mt-1">${accEnvTreeHtml(state.accEnv)}</nav>
    </aside>
    <div id="acc-env-main" class="flex-1 overflow-y-auto p-8"></div>`;
  if (state.accountsUser) renderAccountCard(state.accountsUser);
  else {
    const main = document.getElementById('acc-env-main');
    if (main) main.innerHTML = `<div class="empty py-24"><div class="empty-icon"><i class="fa-solid fa-user"></i></div>
      <p class="empty-title">Select an account</p>
      <p class="empty-sub">Pick an account on the left to see its functions — wallet, profile, games &amp; more coming.</p></div>`;
  }
}

/** Lazy structural data for the Accounts tree (same /api/batch/targets shape the Batch scope
 *  tree uses: environments + folders(parentId) + accounts(folderId)). invalidateStructureCaches()
 *  nulls it — alongside the Batch scope tree's copy — so any structural change (import/add/move/
 *  delete) refetches on the next paint. */
function accTreeData() {
  const t = state.accTree;
  if (!t.targets && !t._loading) {
    t._loading = true;
    api('/api/batch/targets')
      .then((r) => { t.targets = r && r.environments ? r : { environments: [], folders: [], accounts: [] }; })
      .catch(() => { t.targets = { environments: [], folders: [], accounts: [] }; })
      .finally(() => {
        t._loading = false;
        if (state.nav === 'accounts') renderAccountsModule();
      });
  }
  return t.targets;
}

/** The one-environment folder→account tree for the Accounts sidebar (Inventories twin: search
 *  flattens, folders collapse, rows show balance; the ACTIVE account row is highlighted). */
function accEnvTreeHtml(envId) {
  const t = accTreeData();
  if (!t) return '<div class="t12 text-slate-600 py-4 px-2"><i class="fa-solid fa-spinner cs2-spin mr-2"></i>Loading…</div>';
  const st = state.accTree;
  const q = (st.search || '').trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (u) => !searching || u.toLowerCase().includes(q);
  const caret = (open) => `<i class="fa-solid fa-chevron-${open ? 'down' : 'right'} t10 text-slate-500 w-3"></i>`;

  const childFolders = new Map(), acctsByFolder = new Map(), rootAccts = [];
  for (const f of t.folders) {
    if (f.environmentId !== envId) continue;
    const p = f.parentId || null;
    if (!childFolders.has(p)) childFolders.set(p, []);
    childFolders.get(p).push(f);
  }
  for (const a of t.accounts) {
    if (a.environmentId !== envId) continue;
    if (a.folderId) { if (!acctsByFolder.has(a.folderId)) acctsByFolder.set(a.folderId, []); acctsByFolder.get(a.folderId).push(a); }
    else rootAccts.push(a);
  }

  // Row = the Inventories sidebar row's twin: leading multi-select checkbox, name + balance,
  // hover-revealed action SYMBOLS (shield → copy OTP, pen → edit) over the balance slot.
  const acctRow = (a, depth) => {
    const w = walletOf(a.username);
    const meta = state.allAccounts.find((x) => x.username === a.username);
    const active = state.accountsUser === a.username;
    const selected = state.accSel.has(a.username);
    const bal = w ? fmtWallet(w) : (wasRefreshed(a.username) ? fmtMoneyMinor(0, fleetCurrency()) : '—');
    return `
    <div class="account-row group relative flex items-stretch ${selected ? 'bg-brand/5 rounded-xl' : ''}" style="padding-left:${depth * 14}px">
      <label class="acct-check-wrap flex items-center pl-1 pr-1.5 shrink-0 cursor-pointer" title="Select for mass actions (Move)">
        <input type="checkbox" data-accsel="${escapeAttr(a.username)}" ${selected ? 'checked' : ''}
          aria-label="Select ${escapeAttr(a.username)} for mass actions"
          class="acct-check w-4 h-4 rounded accent-brand cursor-pointer ${selected ? '' : 'opacity-40'}"></label>
      <button data-acc-open="${escapeAttr(a.username)}" class="account-btn flex-1 min-w-0 text-left pr-2 py-1.5 rounded-xl border border-transparent transition flex items-center gap-2 ${active ? 'is-active' : 'hover:bg-slate-800/50'}">
        <span class="avatar shrink-0" style="width:1.5rem;height:1.5rem"><i class="fa-solid fa-user t10 ${active ? 'text-brand-light' : ''}"></i></span>
        <span class="t12 font-medium truncate flex-1 min-w-0 ${active ? 'text-white' : 'text-slate-200'}">${escapeHtml(a.username)}</span>
        ${meta && meta.canConfirm === false ? '<span class="pill pill--ltd t10 shrink-0" style="padding:0 .4rem" title="Cannot confirm trades — no identity_secret attached">LTD</span>' : ''}
        <span class="acct-balance t11 font-mono shrink-0 transition-opacity group-hover:opacity-0 ${w ? 'text-emerald-400/90' : 'text-slate-600'}" title="${w ? 'Wallet balance' : 'Balance not fetched yet'}">${escapeHtml(bal)}</span>
      </button>
      <div class="acct-actions row-actions absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        <button data-acc-fn-otp="${escapeAttr(a.username)}" title="Copy Steam Guard code" aria-label="Copy Steam Guard code for ${escapeAttr(a.username)}"
          class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-shield-halved t10"></i></button>
        <button data-acc-fn-edit="${escapeAttr(a.username)}" title="Edit account" aria-label="Edit ${escapeAttr(a.username)}"
          class="btn btn-icon-sm btn-ghost"><i class="fa-solid fa-pen t10"></i></button>
      </div>
    </div>`;
  };

  const renderFolder = (f, depth) => {
    const kids = childFolders.get(f.id) || [];
    const own = acctsByFolder.get(f.id) || [];
    const shown = own.filter((a) => matches(a.username));
    const kidHtml = kids.map((k) => renderFolder(k, depth + 1)).join('');
    if (searching && !shown.length && !kidHtml) return '';
    const open = searching || st.expanded.has(f.id);
    const head = `<div class="group flex items-center gap-1.5 rounded-lg hover:bg-slate-800/40 transition pr-1" style="padding-left:${depth * 14}px">
      <button data-acctree-exp="${escapeAttr(f.id)}" class="px-1 py-1.5" aria-label="${open ? 'Collapse' : 'Expand'} folder ${escapeAttr(f.name)}">${caret(open)}</button>
      <i class="fa-solid ${open ? 'fa-folder-open' : 'fa-folder'} text-brand t11 shrink-0"></i>
      <span class="t12 font-semibold text-slate-300 truncate flex-1 py-1.5">${escapeHtml(f.name)}</span>
      <span class="t10 font-mono text-slate-600">${fmtCount(own.length)}</span>
      <button data-acctree-addsub="${escapeAttr(f.id)}" data-env="${escapeAttr(f.environmentId)}" title="Create subfolder in ${escapeAttr(f.name)}"
        class="btn btn-icon-sm btn-ghost opacity-0 group-hover:opacity-100 transition-opacity"><i class="fa-solid fa-folder-plus t10"></i></button>
    </div>`;
    return head + (open ? kidHtml + shown.map((a) => acctRow(a, depth + 1)).join('') : '');
  };

  const roots = (childFolders.get(null) || []);
  const html = roots.map((f) => renderFolder(f, 0)).join('')
    + rootAccts.filter((a) => matches(a.username)).map((a) => acctRow(a, 0)).join('');
  return html || `<div class="t12 text-slate-600 px-2 py-6 text-center">${searching ? `Nothing matches “${escapeHtml(st.search)}”.` : 'No accounts in this environment yet.'}</div>`;
}

function renderAccountCard(u) {
  const acc = state.allAccounts.find((a) => a.username === u);
  if (!acc) { state.accountsUser = null; return renderAccountsModule(); }
  // The card renders into the env view's RIGHT pane (falls back to the module body when
  // called outside the two-pane layout, e.g. by a stale async repaint).
  const mount = document.getElementById('acc-env-main') || el.accountsBody;
  const card = (title, inner, actions = '') =>
    `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4">
       <div class="flex items-center justify-between mb-3 gap-2 flex-wrap"><h3 class="t14 font-bold text-white">${title}</h3>${actions}</div>${inner}</section>`;

  // ── Wallet ──
  const addingFunds = state.accountsAddFunds === u;
  const payingSafe = state.accountsPaysafe === u;
  const ps = state.accPaysafeSession;                    // single-account session (this account only)
  const psCur = ps && ps.results && ps.results[0];       // the 1-account result row
  if (payingSafe && !psCur) ensurePaysafeTiers(u, () => { if (state.accountsPaysafe === u) renderAccountsModule(); });
  const psT = payingSafe ? paysafeTiersOf(u) : null;
  const psReady = paysafeSupported(psT);   // loaded, no error, EUR wallet → Open enabled; amount validated on click
  let psAmountCtrl = '';
  if (payingSafe && !psCur) {
    if (!psT || psT === 'loading') psAmountCtrl = `<p class="t11 text-slate-500"><i class="fa-solid fa-spinner cs2-spin mr-1"></i>Loading Steam's amount options…</p>`;
    else if (psT.error) psAmountCtrl = `<p class="t11 text-rose-400">Couldn't load amounts — ${escapeHtml(psT.error)}. <button data-paysafe-tiers-retry-acc="${escapeAttr(u)}" class="underline text-brand-light">retry</button></p>`;
    else if (!psT.supported) psAmountCtrl = `<p class="t11 text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${psT.iso ? `paysafecard top-ups need a <b>EUR</b> Steam wallet — this account's wallet is ${escapeHtml(psT.iso)}.` : `SSIM couldn't read this account's wallet currency from Steam, so the top-up is refused rather than guessed.`}</p>`;
    else if (!psT.tiers.length) psAmountCtrl = `<input id="acc-paysafe-free" class="${ACC_IN}" type="number" min="1" max="1000" step="0.01" placeholder="Amount (EUR), e.g. 5.00"><p class="t10 text-slate-600">Steam didn't list fixed amounts for this region — enter how much to top up. ${escapeHtml(paysafeAmountHint())}.</p>`;
    else psAmountCtrl = `<select id="acc-paysafe-tier" class="${ACC_IN}">${psT.tiers.map((v) => `<option value="${v}">${escapeHtml(fmtPaysafe(v))}</option>`).join('')}</select>`;
  }
  const paysafeForm = payingSafe ? `
         <div class="mt-3 space-y-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
           <p class="t11 font-semibold text-white"><i class="fa-solid fa-money-bill-wave text-brand mr-1.5"></i>Add funds via paysafecard <span class="t10 px-1 rounded ml-1" style="background:rgb(var(--warn-rgb) / .2); color:rgb(var(--warn-rgb))">Beta</span></p>
           ${!psCur ? `
             ${psAmountCtrl}
             <p class="t10 text-slate-600">Opens the paysafecard page for this account in a secure browser. Enter your code there and the new balance is confirmed automatically. Your code is only ever entered on paysafecard's own page.</p>
             <div class="flex gap-2">
               <button ${psReady ? `data-acc-paysafe-go="${escapeAttr(u)}"` : 'disabled'} class="btn ${psReady ? 'bg-brand text-white' : 'btn-secondary opacity-50 cursor-not-allowed'} btn-sm"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>Open checkout</span></button>
               <button data-acc-paysafe-cancel class="btn btn-secondary btn-sm">Cancel</button>
             </div>`
           : `
             <p class="t12 ${psCur.status === 'credited' ? 'text-emerald-400' : psCur.status === 'error' ? 'text-rose-400' : 'text-slate-300'}">${paysafeStatusIcon(psCur.status)} ${escapeHtml(psCur.detail)}</p>
             <div class="flex gap-2">
               ${ps.running ? `<button data-acc-paysafe-verify class="btn bg-brand text-white btn-sm"${state.batch.paysafe.busy ? ' disabled' : ''}><i class="fa-solid fa-circle-check"></i><span>I've paid — verify credit</span></button>` : ''}
               <button data-acc-paysafe-cancel class="btn btn-secondary btn-sm">${ps.running ? 'Close' : 'Done'}</button>
             </div>`}
         </div>` : '';
  const walletInner = acctBusy(u, 'wallet')
    ? `<p class="text-slate-500 t13"><i class="fa-solid fa-spinner cs2-spin mr-2"></i>Working…</p>`
    : `<p class="t28 font-mono font-bold text-emerald-400">${escapeHtml(fmtWallet(walletOf(u)))}</p>
       ${addingFunds ? `
         <div class="mt-3 space-y-2">
           <input id="acc-wallet-code" class="${ACC_IN}" placeholder="Wallet code (XXXXX-XXXXX-XXXXX)" autocomplete="off" spellcheck="false">
           <p class="t10 text-slate-600">Redeems a Steam wallet code into this account. The code is never stored or logged.</p>
           <div class="flex gap-2">
             <button data-acc-redeem="${escapeAttr(u)}" class="btn bg-brand text-white btn-sm"><i class="fa-solid fa-plus"></i><span>Redeem</span></button>
             <button data-acc-cancel-funds class="btn btn-secondary btn-sm">Cancel</button>
           </div>
         </div>` : ''}
       ${paysafeForm}`;
  const walletActions = (acctBusy(u, 'wallet') || addingFunds || payingSafe) ? '' :
    `<div class="flex items-center gap-2">
       <button data-acc-addfunds="${escapeAttr(u)}" class="btn btn-secondary btn-sm" title="Redeem a Steam wallet code"><i class="fa-solid fa-plus"></i><span>Wallet code</span></button>
       ${state.paysafeEnabled ? `<button data-acc-paysafe="${escapeAttr(u)}" class="btn btn-secondary btn-sm" title="Top up via paysafecard (beta)"><i class="fa-solid fa-money-bill-wave"></i><span>paysafecard</span><span class="t10 px-1 rounded ml-1" style="background:rgb(var(--warn-rgb) / .2); color:rgb(var(--warn-rgb))">Beta</span></button>` : ''}
       <button data-acc-refresh-wallet="${escapeAttr(u)}" class="btn btn-ghost btn-sm" title="Fetch the live balance"><i class="fa-solid fa-rotate"></i></button>
     </div>`;
  const walletCard = card('Wallet', walletInner, walletActions);

  // ── Profile ──
  const editing = state.accountsEditProfile === u;
  const prof = state.profileCache[u];
  let profileInner;
  if (editing) {
    profileInner =
      `<div class="space-y-3">
        <label class="block t11 text-slate-400">Persona name<input id="acc-pf-name" class="${ACC_IN} mt-1" maxlength="64" value="${escapeAttr((prof && prof.name) || acc.displayName || '')}"></label>
        <label class="block t11 text-slate-400">Summary<textarea id="acc-pf-summary" class="${ACC_IN} mt-1" rows="2" maxlength="1000">${escapeHtml((prof && prof.summary) || '')}</textarea></label>
        <label class="block t11 text-slate-400">Profile visibility
          <select id="acc-pf-privacy" class="${ACC_IN} mt-1"><option value="">(unchanged)</option><option value="public">Public</option><option value="friends">Friends only</option><option value="private">Private</option></select></label>
        <div class="flex gap-2 pt-1">
          <button data-acc-save-profile="${escapeAttr(u)}" class="btn bg-brand text-white btn-sm"><i class="fa-solid fa-check"></i><span>Save</span></button>
          <button data-acc-cancel-edit class="btn btn-secondary btn-sm">Cancel</button></div>
      </div>`;
  } else {
    profileInner = acctBusy(u, 'profile')
      ? `<p class="text-slate-500 t13"><i class="fa-solid fa-spinner cs2-spin mr-2"></i>Loading…</p>`
      : `<p class="t14 text-slate-200 font-semibold">${escapeHtml((prof && prof.name) || acc.displayName || '—')}</p>
         ${prof && prof.summary ? `<p class="t12 text-slate-500 mt-1">${escapeHtml(prof.summary)}</p>` : ''}
         ${prof && prof.partial ? `<p class="t10 text-slate-600 mt-1">Steam has no read-back API; edit to set new values.</p>` : ''}`;
  }
  const profileCard = card('Profile', profileInner,
    editing ? '' : `<button data-acc-edit="${escapeAttr(u)}" class="btn btn-secondary btn-sm"><i class="fa-solid fa-pen"></i><span>Edit</span></button>`);

  // ── Owned games ──
  const gc = state.gamesCache[u];
  const q = (state.accountsGameFilter || '').toLowerCase();
  let gamesInner;
  if (acctBusy(u, 'games')) gamesInner = `<p class="text-slate-500 t13"><i class="fa-solid fa-spinner cs2-spin mr-2"></i>Scanning owned games…</p>`;
  else if (!gc) gamesInner = `<p class="text-slate-500 t13">Not scanned yet — click <b>Scan</b> to read this account's owned games (uses one login slot).</p>`;
  else {
    const rows = gc.games.map((g) => {
      const hide = q && !g.name.toLowerCase().includes(q);
      return `<div data-gname="${escapeAttr(g.name.toLowerCase())}" class="flex items-center justify-between py-1.5 t13 ${hide ? 'hidden' : ''}">
        <span class="text-slate-300 truncate"><span class="text-slate-600 font-mono mr-2">${g.appId}</span>${escapeHtml(g.name)}</span>
        <span class="text-slate-500 font-mono shrink-0 ml-2">${(Number(g.playtimeMinutes) / 60).toFixed(1)}h</span></div>`;
    }).join('');
    gamesInner =
      `<input id="acc-games-filter" class="${ACC_IN} mb-3" placeholder="Filter games…" value="${escapeAttr(state.accountsGameFilter || '')}">
       <div class="max-h-80 overflow-y-auto divide-y divide-slate-800/60">${rows || '<p class="text-slate-600 t12 py-4 text-center">No games.</p>'}</div>
       <p class="t10 text-slate-600 mt-2">${fmtCount(gc.count)} owned · scanned ${gc.scannedAt ? new Date(gc.scannedAt).toLocaleString('en-GB') : ''}</p>`;
  }
  const gamesActions =
    `<div class="flex items-center gap-2">
       <input id="acc-freeapp" class="${ACC_IN}" style="width:7rem" placeholder="appId" inputmode="numeric">
       <button data-acc-addfree="${escapeAttr(u)}" class="btn btn-secondary btn-sm" title="Add a free-on-demand game by appId"><i class="fa-solid fa-plus"></i><span>Add free</span></button>
       <button data-acc-scan="${escapeAttr(u)}" class="btn btn-secondary btn-sm"><i class="fa-solid fa-magnifying-glass"></i><span>Scan</span></button>
     </div>`;
  const gamesCard = card(`Owned games${gc ? ` (${fmtCount(gc.count)})` : ''}`, gamesInner, gamesActions);

  // Title + the account's FUNCTION bar. Edit/Move/OTP live as row SYMBOLS in the sidebar now
  // (owner 2026-07-09) — the pane keeps the heavier functions; more land here over time.
  const title =
    `<div class="mb-4">
      <h2 class="t20 font-bold text-white">${escapeHtml(acc.displayName || u)}</h2>
      <p class="t12 text-slate-500 font-mono mt-0.5">@${escapeHtml(u)}${acc.canConfirm === false ? ' · <span class="text-amber-400/80" title="Cannot confirm trades — no identity_secret attached">LTD</span>' : ''}</p>
    </div>`;
  const fnBar =
    `<div class="flex items-center gap-2 flex-wrap mb-5">
      <button data-acc-fn-browser="${escapeAttr(u)}" class="btn btn-secondary btn-sm" title="Open this account in an isolated, proxied browser session">
        <i class="fa-solid fa-globe text-brand"></i><span>Open in Browser</span></button>
      ${acc.canConfirm === false ? `<button data-acc-fn-attach="${escapeAttr(u)}" class="btn btn-secondary btn-sm" title="Attach maFile → upgrade to Full"><i class="fa-solid fa-shield-halved" style="color:rgb(var(--success-rgb))"></i><span>Attach maFile</span></button>` : ''}
      ${acc.canConfirm === false
        ? `<button disabled class="btn btn-secondary btn-sm opacity-50 cursor-not-allowed" title="Needs a maFile and a password — signing out all devices revokes the refresh token that is this account's only way in">
             <i class="fa-solid fa-right-from-bracket"></i><span>Sign out all devices</span></button>`
        : acctBusy(u, 'signout')
        ? `<button disabled class="btn btn-secondary btn-sm opacity-70 cursor-not-allowed">
             <i class="fa-solid fa-spinner cs2-spin"></i><span>Signing out…</span></button>`
        : `<button data-acc-fn-signout="${escapeAttr(u)}" class="btn btn-secondary btn-sm" title="Steam's &quot;sign out of all devices&quot; — ends every session on this account everywhere">
             <i class="fa-solid fa-right-from-bracket" style="color:rgb(var(--danger-rgb))"></i><span>Sign out all devices</span></button>`}
      <button data-acc-fn-logs="${escapeAttr(u)}" class="btn btn-ghost btn-sm"><i class="fa-solid fa-clock-rotate-left"></i><span>Activity log</span></button>
    </div>`;

  mount.innerHTML = title + fnBar + walletCard + profileCard + gamesCard;

  // First view: pull the (cheap, best-effort) profile once so the name/summary populate.
  if (!prof && !acctBusy(u, 'profile')) loadProfileCard(u);
}

function onAccountsClick(e) {
  const t = e.target; let n;
  // IA refactor: header add-controls + env tiles + sidebar tree (all ADD flows live in Accounts now).
  if (t.closest('[data-acc-login]'))                return openLogin();
  if (t.closest('[data-acc-import]'))               return openBulkImport();
  if (t.closest('[data-acc-newenv]'))               return openEnvModal('create');
  // Rename/delete live on the env TILE (and in the env header) and must be tested BEFORE the
  // [data-accenv] tile-open below — the buttons sit inside the tile, so the tile would otherwise
  // swallow the click and just navigate into the environment.
  if ((n = t.closest('[data-accenv-edit]')))        return openEnvModal('edit', n.dataset.accenvEdit);
  if ((n = t.closest('[data-accenv-del]')))         return deleteEnvironment(n.dataset.accenvDel);
  if ((n = t.closest('[data-accenv]')))             { state.accEnv = n.dataset.accenv; state.accountsUser = null; state.accTree.search = ''; state.accSel.clear(); return renderAccountsModule(); }
  if (t.closest('[data-accenv-back]'))              { state.accEnv = null; state.accountsUser = null; state.accTree.search = ''; state.accSel.clear(); return renderAccountsModule(); }
  if ((n = t.closest('[data-accsel]')))             { toggleInSet(state.accSel, n.dataset.accsel); return renderAccountsEnv(); }
  if (t.closest('.acct-check-wrap'))                return;   // label wrapper; the checkbox above handles it
  if (t.closest('[data-accsel-move]'))              return openMoveModal([...state.accSel]);
  if (t.closest('[data-accsel-clear]'))             { state.accSel.clear(); return renderAccountsEnv(); }
  if ((n = t.closest('[data-acc-fn-browser]')))     return openCleanBrowser(n, n.dataset.accFnBrowser);
  if ((n = t.closest('[data-acctree-exp]')))        { toggleInSet(state.accTree.expanded, n.dataset.acctreeExp); return renderAccountsModule(); }
  if ((n = t.closest('[data-acctree-addacct]')))    return openAddAccount(n.dataset.acctreeAddacct);
  if ((n = t.closest('[data-acctree-addfolder]')))  return openFolderModal({ mode: 'create', parentId: null, environmentId: n.dataset.acctreeAddfolder });
  if ((n = t.closest('[data-acctree-addsub]')))     return openFolderModal({ mode: 'create', parentId: n.dataset.acctreeAddsub, environmentId: n.dataset.env });
  if ((n = t.closest('[data-acc-open]')))           { state.accountsUser = n.dataset.accOpen; state.accountsEditProfile = null; state.accountsGameFilter = ''; return renderAccountsModule(); }
  if (t.closest('[data-acc-back]'))                 { state.accountsUser = null; return renderAccountsModule(); }
  // Account function bar (relocated from the Inventories sidebar rows).
  if ((n = t.closest('[data-acc-fn-edit]')))        return openEditAccount(n.dataset.accFnEdit);
  if ((n = t.closest('[data-acc-fn-move]')))        return openMoveModal(n.dataset.accFnMove);
  if ((n = t.closest('[data-acc-fn-otp]')))         return copyAccountOtp(n.dataset.accFnOtp);
  if ((n = t.closest('[data-acc-fn-attach]')))      return openAttachMaFile(n.dataset.accFnAttach);
  if ((n = t.closest('[data-acc-fn-logs]')))        return openAccountLogs(n.dataset.accFnLogs);
  if ((n = t.closest('[data-acc-fn-signout]')))     return signOutAllDevices(n.dataset.accFnSignout);
  if ((n = t.closest('[data-acc-refresh-wallet]'))) return loadWalletCard(n.dataset.accRefreshWallet);
  if ((n = t.closest('[data-acc-addfunds]')))       { state.accountsAddFunds = n.dataset.accAddfunds; state.accountsPaysafe = null; return renderAccountsModule(); }
  if (t.closest('[data-acc-cancel-funds]'))         { state.accountsAddFunds = null; return renderAccountsModule(); }
  if ((n = t.closest('[data-acc-redeem]')))         return redeemWalletCode(n.dataset.accRedeem);
  if ((n = t.closest('[data-acc-paysafe]')))        { state.accountsPaysafe = n.dataset.accPaysafe; state.accPaysafeSession = null; state.accountsAddFunds = null; return renderAccountsModule(); }
  if (t.closest('[data-acc-paysafe-cancel]'))       { state.accountsPaysafe = null; state.accPaysafeSession = null; return renderAccountsModule(); }
  if ((n = t.closest('[data-acc-paysafe-go]')))     return startPaysafe(n.dataset.accPaysafeGo);
  if ((n = t.closest('[data-paysafe-tiers-retry-acc]'))) { delete state.paysafeTiers[n.dataset.paysafeTiersRetryAcc]; return renderAccountsModule(); }
  if (t.closest('[data-acc-paysafe-verify]'))       return verifyPaysafe();
  if ((n = t.closest('[data-acc-edit]')))           { state.accountsEditProfile = n.dataset.accEdit; return renderAccountsModule(); }
  if (t.closest('[data-acc-cancel-edit]'))          { state.accountsEditProfile = null; return renderAccountsModule(); }
  if ((n = t.closest('[data-acc-save-profile]')))   return saveAccountProfile(n.dataset.accSaveProfile);
  if ((n = t.closest('[data-acc-scan]')))           return loadGamesCard(n.dataset.accScan, true);
  if ((n = t.closest('[data-acc-addfree]')))        return addAccountFreeGame(n.dataset.accAddfree);
}

// In-place owned-games filter (no re-render → no focus loss).
function onAccountsInput(e) {
  // Sidebar account search: repaint ONLY the #acc-env-list mount so the input keeps focus.
  const s = e.target && e.target.closest && e.target.closest('[data-acctree-search]');
  if (s) {
    state.accTree.search = s.value;
    const mount = document.getElementById('acc-env-list');
    if (mount && state.accEnv) mount.innerHTML = accEnvTreeHtml(state.accEnv);
    return;
  }
  if (!e.target || e.target.id !== 'acc-games-filter') return;
  state.accountsGameFilter = e.target.value;
  const qq = e.target.value.toLowerCase();
  el.accountsBody.querySelectorAll('[data-gname]').forEach((row) =>
    row.classList.toggle('hidden', !!qq && !row.dataset.gname.includes(qq)));
}

async function loadWalletCard(u) {
  setAcctBusy(u, 'wallet'); renderAccountsModule();
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(u)}/wallet`);
    const w = r && (r.wallet || (typeof r.currency !== 'undefined' ? r : null));
    if (w) state.wallets[u.toLowerCase()] = { wallet: w, ts: Date.now() };
  } catch (e) { toast(e.message || 'Could not refresh wallet', 'error'); }
  setAcctBusy(u, null); renderAccountsModule();
}

async function loadProfileCard(u) {
  setAcctBusy(u, 'profile'); renderAccountsModule();
  try { state.profileCache[u] = await api(`/api/steam/${encodeURIComponent(u)}/profile`); }
  catch (e) { toast(e.message || 'Could not load profile', 'warn'); }
  setAcctBusy(u, null); renderAccountsModule();
}

async function loadGamesCard(u, refresh) {
  setAcctBusy(u, 'games'); renderAccountsModule();
  try { state.gamesCache[u] = await api(`/api/steam/${encodeURIComponent(u)}/games${refresh ? '?refresh=1' : ''}`); }
  catch (e) { toast(e.message || 'Owned-games scan failed', 'error'); }
  setAcctBusy(u, null); renderAccountsModule();
}

async function saveAccountProfile(u) {
  const name = (document.getElementById('acc-pf-name')?.value ?? '').trim();
  const summary = document.getElementById('acc-pf-summary')?.value ?? '';
  const privacy = document.getElementById('acc-pf-privacy')?.value ?? '';
  const body = { summary };
  if (name) body.name = name;
  if (privacy) body.privacy = { profile: privacy };
  const changes = [name ? `Persona → “${escapeHtml(name)}”` : '', privacy ? `Profile visibility → ${privacy}` : '', 'Summary updated'].filter(Boolean).join('<br>');
  if (!(await ssimConfirm({ title: 'Edit Steam profile', body: `This changes the <b>live</b> Steam account <span class="font-mono">@${escapeHtml(u)}</span>:<br><br>${changes}`, confirmLabel: 'Apply', confirmIcon: 'fa-user-pen', tone: 'brand' }))) return;
  state.accountsEditProfile = null; setAcctBusy(u, 'profile'); renderAccountsModule();
  try {
    await api(`/api/steam/${encodeURIComponent(u)}/profile`, { method: 'POST', body: JSON.stringify(body) });
    toast('Profile updated', 'success');
    delete state.profileCache[u];
  } catch (e) { toast(e.message || 'Profile update failed', 'error'); }
  setAcctBusy(u, null); renderAccountsModule();
}

/**
 * Steam's "sign out of all devices" for one account: revokes every refresh token on the account,
 * so every session everywhere ends — the Steam client, the mobile app, browsers, and SSIM itself.
 *
 * The button is disabled for accounts that cannot confirm (no maFile), and the server refuses them
 * outright: for a token-only account the refresh token IS the only credential, and revoking it
 * would lock SSIM out of the account permanently. For a full account this is recoverable — SSIM
 * logs back in with the password + TOTP on the next use — but it does mean re-authenticating,
 * so it is confirm-gated.
 */
async function signOutAllDevices(u) {
  if (!(await ssimConfirm({
    title: 'Sign out of all devices', tone: 'danger', confirmLabel: 'Sign out everywhere', confirmIcon: 'fa-right-from-bracket',
    body: `End <b>every</b> Steam session on <span class="font-mono">@${escapeHtml(u)}</span>?<br><br>
      <span class="text-slate-500">This is Steam's own "sign out of all devices". It revokes every login on the account — the Steam client, the mobile app, every browser, and SSIM's own session.</span><br><br>
      <span class="text-slate-500">SSIM signs this account back in automatically the next time it is used, with its stored password and 2FA code. Anyone else signed in will have to log in again.</span>`,
  }))) return;
  setAcctBusy(u, 'signout'); renderAccountsModule();
  try {
    const r = await api(`/api/steam/${encodeURIComponent(u)}/signout-all-devices`, { method: 'POST' });
    // 'ambiguous' is a real outcome, not a success: Steam answered without confirming. Say so
    // plainly instead of reporting a clean sign-out that may not have happened.
    if (r.status === 'ambiguous') toast(`Outcome unknown — ${r.detail || 'check the account on Steam'}`, 'warn');
    else toast('Signed out of all devices', 'success');
  } catch (e) { toast(e.message || 'Sign-out failed', 'error'); }
  setAcctBusy(u, null); renderAccountsModule();
}

async function addAccountFreeGame(u) {
  const appId = Number(document.getElementById('acc-freeapp')?.value);
  if (!Number.isInteger(appId) || appId <= 0) { toast('Enter a numeric appId', 'warn'); return; }
  if (!(await ssimConfirm({ title: 'Add free game', body: `Add app <b>${appId}</b> as a free-on-demand license to <span class="font-mono">@${escapeHtml(u)}</span>?`, confirmLabel: 'Add', confirmIcon: 'fa-plus', tone: 'brand' }))) return;
  try {
    const r = await api(`/api/steam/${encodeURIComponent(u)}/free-license`, { method: 'POST', body: JSON.stringify({ appIds: [appId] }) });
    toast(`Granted ${(r.grantedAppIds || []).length} app(s)`, 'success');
    delete state.gamesCache[u];
    return loadGamesCard(u, true);   // re-scan to show it
  } catch (e) { toast(e.message || 'Free-license request failed', 'error'); }
}

// W4_40: paysafecard status → an icon. Shared by the single-account form and the batch wizard.
function paysafeStatusIcon(status) {
  return {
    awaiting:    '<i class="fa-solid fa-hourglass-half text-amber-400"></i>',
    credited:    '<i class="fa-solid fa-circle-check text-emerald-400"></i>',
    unconfirmed: '<i class="fa-solid fa-circle-question text-amber-400"></i>',
    skipped:     '<i class="fa-solid fa-forward text-slate-500"></i>',
    error:       '<i class="fa-solid fa-circle-xmark text-rose-400"></i>',
  }[status] || '<i class="fa-solid fa-circle text-slate-500"></i>';
}

// W4_40: single-account paysafecard (a 1-account run). Opens the checkout in the clean browser; the
// operator enters the code ON THE STEAM PAGE, then clicks Verify → SSIM reconciles by wallet read-back.
// SSIM never handles the PIN. Money-safe: 'credited' only on an observed balance rise, else 'unconfirmed'.
async function startPaysafe(u) {
  const t = paysafeTiersOf(u);
  if (!t || t === 'loading' || t.error) { toast('Steam amount options not loaded yet', 'warn'); return; }
  if (!t.supported) { toast(t.iso ? `paysafecard top-ups need a EUR Steam wallet — this account's wallet is ${t.iso}` : `SSIM couldn't read this account's wallet currency from Steam`, 'warn'); return; }
  let amountMinor;
  if (t.tiers && t.tiers.length) {                       // fixed-tier region → dropdown
    amountMinor = Number(document.getElementById('acc-paysafe-tier')?.value || 0);
    if (!t.tiers.includes(amountMinor)) { toast('Pick an amount', 'warn'); return; }
  } else {                                               // custom-amount region → free-text (bounds-checked)
    amountMinor = paysafeMinorFromMajor(document.getElementById('acc-paysafe-free')?.value || '');
    if (amountMinor == null) { toast(paysafeAmountHint(), 'warn'); return; }
  }
  const disp = fmtPaysafe(amountMinor);
  if (!(await ssimConfirm({ title: 'Add funds via paysafecard', body: `Top up <span class="font-mono">@${escapeHtml(u)}</span> with <b>${escapeHtml(disp)}</b>?<br><br>The paysafecard page opens in a secure browser — enter your code there and the new balance is confirmed automatically.`, confirmLabel: 'Open checkout', confirmIcon: 'fa-arrow-up-right-from-square', tone: 'spend' }))) return;
  state.batch.paysafe.busy = true; setAcctBusy(u, 'wallet'); renderAccountsModule();
  try {
    state.accPaysafeSession = await api(`/api/steam/${encodeURIComponent(u)}/paysafe/open`, { method: 'POST', body: JSON.stringify({ amountMinor }) });
    toast('Checkout opened — pay in the browser, then click Verify credit.', 'success', { duration: 10000 });
  } catch (e) {
    toast(e && e.message ? e.message : 'Could not open the paysafecard checkout', 'warn', { duration: 12000 });
  }
  state.batch.paysafe.busy = false; setAcctBusy(u, null); renderAccountsModule();
}

async function verifyPaysafe() {
  state.batch.paysafe.busy = true; renderAccountsModule();
  try {
    state.accPaysafeSession = await api('/api/steam/paysafe/verify', { method: 'POST', body: '{}' });
    const r = state.accPaysafeSession.results && state.accPaysafeSession.results[0];
    if (r) toast(`paysafecard: ${r.detail}`, r.status === 'credited' ? 'success' : 'info', { duration: 10000 });
  } catch (e) {
    toast(e && e.message ? e.message : 'Verify failed', 'warn', { duration: 10000 });
  }
  state.batch.paysafe.busy = false; renderAccountsModule();
}

// W3_31: redeem a Steam wallet code into this account (money-in). Serialized, confirm-gated, masked.
async function redeemWalletCode(u) {
  const raw = (document.getElementById('acc-wallet-code')?.value ?? '').trim();
  const norm = raw.replace(/[^A-Za-z0-9]/g, '');
  if (!norm) { toast('Enter a wallet code', 'warn'); return; }
  const masked = '•••••-•••••-•' + norm.slice(-4);
  if (!(await ssimConfirm({ title: 'Redeem wallet code', body: `Redeem <span class="font-mono">${escapeHtml(masked)}</span> into <span class="font-mono">@${escapeHtml(u)}</span>?<br><br>This adds <b>real funds</b> to the account.`, confirmLabel: 'Redeem', confirmIcon: 'fa-plus', tone: 'spend' }))) return;
  state.accountsAddFunds = null; setAcctBusy(u, 'wallet'); renderAccountsModule();
  try {
    const r = await api(`/api/steam/${encodeURIComponent(u)}/redeem`, { method: 'POST', body: JSON.stringify({ code: raw }) });
    if (r && r.status === 'redeemed') { toast(`Redeemed ${r.codeMasked} — refreshing balance`, 'success'); setAcctBusy(u, null); return loadWalletCard(u); }
    if (r && r.status === 'ambiguous') toast(`${r.codeMasked}: outcome unknown — verify the balance on Steam. No auto-retry.`, 'warn', { duration: 12000 });
    else toast(`${(r && r.codeMasked) || 'Code'} ${(r && r.status) || 'rejected'}: ${(r && r.detail) || ''}`, 'error');
  } catch (e) {
    // api() throws on 409 (needs-verify) / 502 (ambiguous) — never auto-retry; tell the operator to verify.
    toast(e && e.message ? e.message : 'Redeem failed — verify the balance on Steam before retrying.', 'warn', { duration: 12000 });
  }
  setAcctBusy(u, null); renderAccountsModule();
}
// ══════════════════════════════════════════════════════════════════════════════
//  W3_32 — Batch Jobs (scope → job → params → run → one progress view → history)
//  The backend engine is a router; this UI collects a scope (usernames), a job + params,
//  and polls one status surface. Money jobs are ssimConfirm-gated. Legacy bulk UIs still work.
// ══════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  Proxies module (v5) — declarative proxy rules (most-specific match wins)
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
//  ACTIVITY — every running job, from anywhere in the app
//
//  SSIM has always run these concurrently, but nothing ever said so: a job's progress lived only
//  inside the modal that started it, so closing that modal made a running job invisible and the
//  operator sat waiting for a machine that was already free (owner, 2026-08-12). The poller below
//  runs for the WHOLE session, independent of which module or modal is open, and drives two things:
//  the rail's live count badge (always on screen — the part that actually changes the behaviour)
//  and this view.
// ════════════════════════════════════════════════════════════════════════════

const ACT = { jobs: [], running: 0, timer: null, failed: 0 };
/** Fast while work is in flight, lazy when idle — the endpoint is an in-memory snapshot, but there
 *  is no reason to ask 40× a minute on an idle install. */
const ACT_POLL_BUSY_MS = 1500;
const ACT_POLL_IDLE_MS = 6000;

/** Icon per job kind. Unknown ids (a job added later) fall back rather than render an empty box. */
const ACT_ICON = {
  'inventory-refresh': 'fa-rotate', 'mass-send': 'fa-paper-plane', 'mass-sell': 'fa-tags',
  'folder-buy': 'fa-cart-shopping', 'orders-scan': 'fa-magnifying-glass-dollar', tradeup: 'fa-arrows-up-to-line',
  'casket-move': 'fa-box-archive', batch: 'fa-list-check', distribute: 'fa-share-nodes',
  'csfloat-bulk': 'fa-layer-group', 'csfloat-deliver': 'fa-truck-fast', 'ban-check': 'fa-shield-halved',
  paysafe: 'fa-wallet',
};

function startActivityPoll() {
  if (ACT.timer) return;
  const tick = async () => {
    ACT.timer = null;
    try {
      const r = await api('/api/jobs');
      ACT.jobs = Array.isArray(r.jobs) ? r.jobs : [];
      ACT.running = Number(r.running) || 0;
      ACT.failed = 0;
    } catch {
      // A blip must not blank the badge — that would read as "everything finished". Keep the last
      // known list and only give up on the display after several consecutive failures.
      if (++ACT.failed > 3) { ACT.jobs = []; ACT.running = 0; }
    }
    paintActivityBadge();
    if (state.nav === 'activity') paintActivity();
    ACT.timer = setTimeout(tick, ACT.running ? ACT_POLL_BUSY_MS : ACT_POLL_IDLE_MS);
  };
  tick();
}

function paintActivityBadge() {
  const b = el.navActivityBadge;
  if (!b) return;
  b.textContent = String(ACT.running);
  b.classList.toggle('hidden', ACT.running === 0);
}

function renderActivityModule() {
  startActivityPoll();     // idempotent; the poll is session-wide, this just guarantees it is up
  paintActivity();
}

function actElapsed(j) {
  const from = j.startedAt || 0;
  if (!from) return '';
  const s = Math.max(0, Math.round(((j.finishedAt || Date.now()) - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function paintActivity() {
  if (!el.activityBody) return;
  const running = ACT.jobs.filter((j) => j.running);
  const recent = ACT.jobs.filter((j) => !j.running);
  el.activityBody.innerHTML = `
    <div class="max-w-4xl">
      ${running.length
        ? `<p class="t12 text-slate-400 mb-3">${running.length} job${running.length === 1 ? '' : 's'} running${running.length > 1 ? ' — at the same time. You never have to wait for one to finish before starting another.' : '. You can leave this screen; it keeps running.'}</p>
           <div class="space-y-2">${running.map(actCard).join('')}</div>`
        : `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-bolt"></i></div>
             <div class="empty-title">Nothing running</div>
             <p class="t12 text-slate-500 mt-2 max-w-md mx-auto">Refreshes, mass sends, sells, storage moves, trade-ups, batch jobs and CSFloat deliveries all show up here while they run — including several at once.</p></div>`}
      ${recent.length ? `<p class="t12 text-slate-500 mt-6 mb-2">Just finished</p><div class="space-y-2">${recent.map(actCard).join('')}</div>` : ''}
    </div>`;
}

function actCard(j) {
  const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : (j.running ? 100 : 100);
  const indeterminate = !j.total;   // a job that cannot say how much work it has (a scan sizing itself)
  return `<div class="surface px-4 py-3">
    <div class="flex items-center gap-3">
      <i class="fa-solid ${ACT_ICON[j.id] || 'fa-gear'} ${j.running ? 'text-brand' : 'text-slate-600'} w-4 text-center shrink-0"></i>
      <div class="min-w-0 flex-1">
        <p class="t13 font-semibold ${j.running ? 'text-slate-100' : 'text-slate-400'} truncate">
          ${escapeHtml(j.label)}${j.detail ? ` <span class="t11 font-normal text-slate-500">· ${escapeHtml(j.detail)}</span>` : ''}
        </p>
        <p class="t10 text-slate-500 font-mono">
          ${indeterminate ? (j.running ? 'working…' : 'done') : `${j.done}/${j.total}`}
          ${j.phase ? ` · ${escapeHtml(j.phase)}` : ''}
          ${j.failed ? ` · <span class="text-rose-400">${j.failed} failed</span>` : ''}
          ${j.startedAt ? ` · ${escapeHtml(actElapsed(j))}` : ''}
          ${j.cancelling ? ' · <span class="text-amber-400">stopping…</span>' : ''}
          ${!j.running ? ' · <span class="text-emerald-400">finished</span>' : ''}
        </p>
      </div>
      ${j.nav ? `<button data-act-go="${escapeAttr(j.nav)}" class="btn btn-ghost btn-sm shrink-0">Open</button>` : ''}
      ${j.cancelPath ? `<button data-act-cancel="${escapeAttr(j.cancelPath)}" data-label="${escapeAttr(j.label)}" ${j.cancelling ? 'disabled' : ''} class="btn btn-danger btn-sm shrink-0 ${j.cancelling ? 'opacity-40 cursor-not-allowed' : ''}">End task</button>` : ''}
    </div>
    <div class="h-1.5 mt-2 rounded-full bg-slate-800 overflow-hidden">
      <div class="h-full rounded-full ${j.running ? 'bg-brand' : 'bg-emerald-500/60'} transition-all" style="width:${indeterminate && j.running ? 100 : pct}%"></div>
    </div>
  </div>`;
}

/** "End task" from Activity hits each job's OWN cancel route — the same co-operative stop its own
 *  screen offers, never a kill. Confirmed, because several of these are mid-flight money ops. */
async function onActivityClick(e) {
  const go = e.target.closest('[data-act-go]');
  if (go) return setNav(go.getAttribute('data-act-go'));
  const stop = e.target.closest('[data-act-cancel]');
  if (!stop) return;
  const path = stop.getAttribute('data-act-cancel');
  const label = stop.getAttribute('data-label') || 'this job';
  const ok = await ssimConfirm({
    title: `End ${label}?`, tone: 'danger', confirmLabel: 'End task', confirmIcon: 'fa-stop',
    body: `Stop <b class="text-slate-100">${escapeHtml(label)}</b> after the step it is on. Work already committed (offers sent, listings created, items moved) stays done — only the remaining steps are skipped.`,
  });
  if (!ok) return;
  try { await api(path, { method: 'POST' }); toast(`${label}: stopping…`, 'warn'); }
  catch (err) { toast(err.message, 'error'); }
}

function renderProxiesModule() {
  ensureProxiesWiring();
  const p = state.proxies;
  if (!p.loaded && !p._loading) {
    p._loading = true;
    // Generation captured BEFORE the request and re-checked on arrival (the Batch tree's idiom): a
    // structural change landing mid-flight — an environment deleted with its accounts, which also
    // prunes proxy rules — must not have its invalidation undone by the older answer still on the
    // wire. Superseded → drop the answer and re-enter, which refetches.
    const gen = p._gen || 0;
    Promise.all([api('/api/proxies/rules'), api('/api/proxies/targets')])
      .then(([rulesResp, targets]) => {
        p._loading = false;
        if ((p._gen || 0) !== gen) { renderProxiesModule(); return; }
        p.rules = (rulesResp && rulesResp.rules) || [];
        p.authoritative = !!(rulesResp && rulesResp.authoritative);
        p.targets = targets || { environments: [], folders: [], accounts: [] };
        p.loaded = true; paintProxies();
      })
      .catch((e) => { p._loading = false; toast(e.message || 'Could not load proxy rules', 'error'); });
  }
  paintProxies();
}

function ensureProxiesWiring() {
  const body = el.proxiesBody || document.getElementById('proxies-body');
  if (body && body.dataset.wired !== '1') {
    body.dataset.wired = '1';
    body.addEventListener('click', onProxiesClick);
    body.addEventListener('input', onProxiesInput);
    const header = el.proxiesHeader || document.getElementById('proxies-header');
    if (header) header.addEventListener('click', onProxiesClick); // the "New rule" button lives here
  }
  if (!document.getElementById('proxy-modal-overlay')) {
    const ov = document.createElement('div');
    ov.id = 'proxy-modal-overlay';
    ov.className = 'hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4';
    ov.innerHTML = '<div id="proxy-modal-card" class="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl fade-in max-h-[90vh] overflow-y-auto"></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', onProxyModalClick);
    ov.addEventListener('input', onProxyModalInput);
    ov.addEventListener('change', onProxyModalInput);
    // T1: this overlay is created LAZILY (after init's modalOverlays().forEach(observeOverlay) ran), so
    // wire it into the shared FB-04 lifecycle explicitly — otherwise Esc takes the raw classList
    // fallback, bypassing closeProxyModal(): state.proxies.modal stays set, the reveal race-guard
    // passes, and the un-redacted pool gets written into the still-open hidden DOM.
    observeOverlay(ov);
    OVERLAY_CLOSERS.set('proxy-modal-overlay', closeProxyModal);
  }
}

function paintProxies() {
  const p = state.proxies;
  if (el.proxiesHeader) el.proxiesHeader.innerHTML = `<div class="flex items-center justify-between gap-4"><div><h2 class="t28 font-bold text-white tracking-tight">Proxies</h2><p class="t14 text-slate-500 mt-1">Add a proxy once, assign it by rule. Most-specific match wins: account ▸ folder ▸ environment ▸ global.</p></div><button data-proxy-add class="px-4 py-2 rounded-xl t13 font-semibold bg-brand text-white hover:brightness-110 shrink-0"><i class="fa-solid fa-plus mr-1.5"></i>New rule</button></div>`;
  const body = el.proxiesBody; if (!body) return;
  if (!p.loaded) { body.innerHTML = `<div class="t13 text-slate-500">Loading proxy rules…</div>`; return; }
  // Coverage tab REMOVED (owner 2026-07-09) — a stale saved tab falls back to Rules.
  const tab = p.tab === 'preview' ? 'preview' : 'rules';
  const tabBtn = (id, label) => `<button data-proxy-tab="${id}" class="px-3 py-1.5 rounded-lg t12 border ${tab === id ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-400 hover:text-slate-200'}">${label}</button>`;
  const tabs = `<div class="flex gap-2 mb-4">${tabBtn('rules', 'Rules')}${tabBtn('preview', 'Resolution preview')}</div>`;
  const content = tab === 'preview' ? renderPreviewTab() : renderRulesTab();
  body.innerHTML = tabs + content;
  // Re-apply the resolution-preview search/filter after every repaint (tab switch, segment click),
  // so a persisted search term / non-'all' segment stays honoured across the innerHTML rebuild.
  if (tab === 'preview' && p.preview) applyProxyPreviewFilter();
}

function renderRulesTab() {
  const p = state.proxies;
  const banner = p.authoritative ? '' : `<div class="rounded-xl border border-amber-700/50 bg-amber-500/10 px-4 py-3 mb-4 t12 text-amber-300 flex items-center justify-between gap-3"><span><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>Rules were synthesized from your current proxy config but are <b>not yet live</b> — some accounts resolve differently. Review the <b>Resolution preview</b> first.</span><button data-proxy-activate class="px-3 py-1.5 rounded-lg t12 font-semibold bg-amber-500/20 border border-amber-600/60 text-amber-200 hover:bg-amber-500/30 shrink-0"><i class="fa-solid fa-bolt mr-1"></i>Activate</button></div>`;
  const tester = `<div class="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 mb-4">
    <div class="flex items-center gap-2">
      <input data-proxy-test-input value="${escapeAttr(p.testInput || '')}" class="${ACC_IN} font-mono t12 flex-1" placeholder="Test a proxy — host:port:user:pass · full URL (empty = local IP)">
      <button data-proxy-test-run class="px-3 py-2 rounded-lg t12 border border-slate-700 text-slate-300 hover:text-white shrink-0">${p.testBusy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-gauge-high mr-1"></i>Test'}</button>
    </div>${renderTestResult(p.testResult)}
  </div>`;
  const rows = p.rules.length
    ? p.rules.map((r, i) => proxyRuleRow(r, i, p.rules.length)).join('')
    : `<div class="t13 text-slate-500 px-1 py-8 text-center">No proxy rules yet. Click <b>New rule</b> to add one.</div>`;
  return `${banner}${tester}<div class="rounded-2xl border border-slate-800 bg-slate-900/40 divide-y divide-slate-800">${rows}</div>`;
}

function renderTestResult(r) {
  if (!r) return '';
  if (r.ok) return `<div class="mt-2 t12 text-emerald-400"><i class="fa-solid fa-check mr-1"></i>${r.mode === 'localip' ? 'Local IP' : 'Proxy'} OK — ${escapeHtml(String(r.ip))}${r.countryCode ? ` (${escapeHtml(r.countryCode)})` : ''} · ${r.latencyMs} ms</div>`;
  return `<div class="mt-2 t12 text-red-400"><i class="fa-solid fa-xmark mr-1"></i>Failed — ${escapeHtml(String(r.error || 'unknown'))}${r.latencyMs != null ? ` · ${r.latencyMs} ms` : ''}</div>`;
}

function renderPreviewTab() {
  const p = state.proxies;
  if (!p.preview) { if (!p._previewLoading) loadProxyPreview(); return `<div class="t13 text-slate-500">Resolving every account…</div>`; }
  const rows = p.preview.rows || [];
  const ruleName = (id) => { const r = p.rules.find((x) => x.id === id); return r ? (r.name || (r.scope + ' rule')) : (id ? id.slice(0, 8) : '—'); };
  const envName = (id) => { const e = ((p.targets && p.targets.environments) || []).find((x) => x.id === id); return e ? e.name : id; };
  // Egress bucket for the filter segments: pool lost > proxied > local IP (covers no-rule + force-local).
  const catOf = (r) => r.poolLost ? 'poollost' : (r.network && r.network.type === 'proxy' ? 'proxied' : 'localip');
  // ── Search + filter-segment chrome (all client-side; rows carry data-search / data-cat / data-conflict) ──
  const search = p.previewSearch || '';
  const filter = p.previewFilter || 'all';
  const counts = {
    all: rows.length,
    proxied: rows.filter((r) => catOf(r) === 'proxied').length,
    localip: rows.filter((r) => catOf(r) === 'localip').length,
    poollost: rows.filter((r) => r.poolLost).length,
    conflict: rows.filter((r) => r.conflicts && r.conflicts.length).length,
  };
  const segBtn = (id, label) => `<button data-proxy-preview-filter="${id}" class="px-2.5 py-1 rounded-lg t11 border ${filter === id ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-400 hover:text-slate-200'}">${label}<span class="ml-1.5 t10 ${filter === id ? 'text-brand/70' : 'text-slate-600'}">${counts[id]}</span></button>`;
  const controls = `<div class="flex items-center gap-3 mb-3 flex-wrap">
    <div class="relative flex-1 min-w-[12rem]">
      <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs z-10"></i>
      <input data-proxy-preview-search type="text" autocomplete="off" placeholder="Search account, environment, rule or egress…" value="${escapeAttr(search)}" class="field pl-8 py-2 t12 w-full" />
    </div>
    <div class="flex gap-1.5 flex-wrap shrink-0">${segBtn('all', 'All')}${segBtn('proxied', 'Proxied')}${segBtn('localip', 'Local IP')}${segBtn('poollost', 'Pool lost')}${segBtn('conflict', 'Conflicts')}</div>
  </div>`;
  const tbody = rows.map((r) => {
    const net = r.poolLost
      ? '<span class="text-red-400">pool lost — login refused</span>'
      : (r.network ? (r.network.type === 'localip' ? '<span class="text-amber-400">local IP</span>' : escapeHtml(r.network.value)) : '—');
    const rule = r.ruleId ? escapeHtml(ruleName(r.ruleId)) : '<span class="text-slate-600">no rule → local IP</span>';
    const hasConflict = !!(r.conflicts && r.conflicts.length);
    const conflict = hasConflict ? `<span class="t10 ml-1 px-1 rounded bg-amber-500/15 text-amber-400" title="Overlapping rules at the same specificity">⚠ ${r.conflicts.length}</span>` : '';
    // Plain-text haystack (network.value is already backend-redacted, so safe in a data- attribute).
    const netText = r.poolLost ? 'pool lost login refused' : (r.network ? (r.network.type === 'localip' ? 'local ip' : r.network.value) : '');
    const searchText = `${r.username} ${envName(r.environmentId)} ${r.ruleId ? ruleName(r.ruleId) : 'no rule local ip'} ${netText}`.toLowerCase();
    return `<tr class="border-t border-slate-800" data-cat="${catOf(r)}" data-conflict="${hasConflict ? '1' : '0'}" data-search="${escapeAttr(searchText)}"><td class="py-1.5 pr-4 text-slate-200">${escapeHtml(r.username)}</td><td class="py-1.5 pr-4 text-slate-500">${escapeHtml(String(envName(r.environmentId)))}</td><td class="py-1.5 pr-4">${rule}${conflict}</td><td class="py-1.5 font-mono t11 text-slate-400">${net}</td></tr>`;
  }).join('');
  const emptyRow = `<tr data-proxy-preview-empty class="hidden"><td class="py-6 text-slate-600 text-center" colspan="4">No accounts match the current search / filter.</td></tr>`;
  return `${controls}<div class="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 overflow-x-auto"><table data-proxy-preview-table class="w-full t12"><thead><tr class="text-slate-500 text-left"><th class="pb-2 pr-4 font-medium">Account</th><th class="pb-2 pr-4 font-medium">Environment</th><th class="pb-2 pr-4 font-medium">Winning rule</th><th class="pb-2 font-medium">Effective egress</th></tr></thead><tbody>${tbody ? tbody + emptyRow : '<tr><td class="py-3 text-slate-600" colspan="4">No accounts.</td></tr>'}</tbody></table></div>`;
}

// In-place search + category filter for the resolution preview. Toggles row visibility from
// data-search / data-cat / data-conflict (never repaints → the search box keeps focus while typing).
function applyProxyPreviewFilter() {
  const p = state.proxies;
  const q = (p.previewSearch || '').trim().toLowerCase();
  const f = p.previewFilter || 'all';
  const table = document.querySelector('[data-proxy-preview-table]');
  if (!table) return;
  let shown = 0;
  table.querySelectorAll('tr[data-cat]').forEach((r) => {
    const catOk = f === 'all' || (f === 'conflict' ? r.dataset.conflict === '1' : r.dataset.cat === f);
    const textOk = !q || (r.dataset.search || '').includes(q);
    const match = catOk && textOk;
    r.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  const empty = table.querySelector('[data-proxy-preview-empty]');
  if (empty) empty.classList.toggle('hidden', shown > 0);
}

async function loadProxyPreview() {
  const p = state.proxies; p._previewLoading = true;
  try { p.preview = await api('/api/proxies/resolution'); } catch (e) { toast(e.message, 'error'); p.preview = { rows: [] }; }
  p._previewLoading = false; paintProxies();
}
async function runProxyTest() {
  const p = state.proxies; p.testBusy = true; paintProxies();
  try { p.testResult = await api('/api/proxies/check', { method: 'POST', body: JSON.stringify({ proxy: p.testInput || '' }) }); }
  catch (e) { p.testResult = { ok: false, error: e.message }; }
  p.testBusy = false; paintProxies();
}

function proxyRuleRow(r, i, n) {
  const scopeBadge = { global: 'Global', environment: 'Environment', folder: 'Folder', account: 'Account' }[r.scope] || r.scope;
  const targetSummary = r.scope === 'global' ? 'everything' : proxyTargetsSummary(r);
  const poolLabel = r.kind === 'local' ? '<span class="text-amber-400">force local IP</span>' : `${r.proxyCount} prox${r.proxyCount === 1 ? 'y' : 'ies'}`;
  const enabledCls = r.enabled ? 'text-emerald-400' : 'text-slate-600';
  return `<div class="flex items-center gap-3 px-4 py-3" data-rule="${escapeAttr(r.id)}">
    <div class="flex flex-col gap-0.5 shrink-0">
      <button data-rule-up="${escapeAttr(r.id)}" ${i === 0 ? 'disabled' : ''} class="t10 leading-none ${i === 0 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-white'}"><i class="fa-solid fa-chevron-up"></i></button>
      <button data-rule-down="${escapeAttr(r.id)}" ${i === n - 1 ? 'disabled' : ''} class="t10 leading-none ${i === n - 1 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-white'}"><i class="fa-solid fa-chevron-down"></i></button>
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="t13 font-semibold text-white truncate">${escapeHtml(r.name || scopeBadge + ' rule')}</span>
        <span class="t10 px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">${scopeBadge}</span>
      </div>
      <div class="t11 text-slate-500 mt-0.5 truncate">${escapeHtml(targetSummary)} · ${poolLabel}</div>
    </div>
    <button data-rule-toggle="${escapeAttr(r.id)}" title="${r.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}" class="${enabledCls} t18 px-1"><i class="fa-solid ${r.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></button>
    <button data-rule-edit="${escapeAttr(r.id)}" class="t12 text-slate-400 hover:text-white px-2"><i class="fa-solid fa-pen"></i></button>
    <button data-rule-del="${escapeAttr(r.id)}" class="t12 text-slate-500 hover:text-red-400 px-2"><i class="fa-solid fa-trash"></i></button>
  </div>`;
}

function proxyTargetsSummary(r) {
  const t = state.proxies.targets || {};
  const names = (r.targets || []).map((id) => {
    if (r.scope === 'environment') return ((t.environments || []).find((e) => e.id === id) || {}).name || id;
    if (r.scope === 'folder') return ((t.folders || []).find((f) => f.id === id) || {}).name || id;
    return id; // account username
  });
  if (!names.length) return '(no targets)';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

function onProxiesClick(e) {
  const tab = e.target.closest('[data-proxy-tab]');
  if (tab) { state.proxies.tab = tab.getAttribute('data-proxy-tab'); paintProxies(); return; }
  const pf = e.target.closest('[data-proxy-preview-filter]');
  if (pf) { state.proxies.previewFilter = pf.getAttribute('data-proxy-preview-filter'); paintProxies(); return; }
  if (e.target.closest('[data-proxy-test-run]')) return runProxyTest();
  if (e.target.closest('[data-proxy-activate]')) return activateProxyRulesUi();
  const t = e.target.closest('[data-proxy-add],[data-rule-edit],[data-rule-del],[data-rule-toggle],[data-rule-up],[data-rule-down]');
  if (!t) return;
  if (t.hasAttribute('data-proxy-add')) return openProxyRuleModal('create');
  const rid = t.getAttribute('data-rule-edit') || t.getAttribute('data-rule-del') || t.getAttribute('data-rule-toggle') || t.getAttribute('data-rule-up') || t.getAttribute('data-rule-down');
  const rule = state.proxies.rules.find((r) => r.id === rid);
  if (!rule) return;
  if (t.hasAttribute('data-rule-edit')) return openProxyRuleModal('edit', rule);
  if (t.hasAttribute('data-rule-del')) return deleteProxyRuleUi(rule);
  if (t.hasAttribute('data-rule-toggle')) return toggleProxyRuleUi(rule);
  if (t.hasAttribute('data-rule-up')) return reorderProxyRuleUi(rule.id, -1);
  if (t.hasAttribute('data-rule-down')) return reorderProxyRuleUi(rule.id, +1);
}

function onProxiesInput(e) {
  if (e.target.matches('[data-proxy-test-input]')) { state.proxies.testInput = e.target.value; return; }
  // Resolution-preview live search: update state and filter rows in place (no repaint → keeps focus).
  if (e.target.matches('[data-proxy-preview-search]')) { state.proxies.previewSearch = e.target.value; applyProxyPreviewFilter(); return; }
}

async function activateProxyRulesUi() {
  if (!(await ssimConfirm({ title: 'Activate proxy rules', tone: 'brand', confirmLabel: 'Activate', confirmIcon: 'fa-bolt', body: 'Make these rules the live source of proxy resolution?<br><span class="text-slate-500">Accounts take effect on their next login/refresh — no live session is disturbed. Review the resolution preview first.</span>' }))) return;
  try { await api('/api/proxies/activate', { method: 'POST' }); await reloadProxyRules(); toast('Proxy rules activated', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

async function reloadProxyRules() {
  const resp = await api('/api/proxies/rules');
  state.proxies.rules = (resp && resp.rules) || [];
  state.proxies.authoritative = !!(resp && resp.authoritative);
  state.proxies.preview = null;
  paintProxies();
  // A rule change (create / edit / delete / reorder / enable / activate) re-resolves egress FLEET-WIDE,
  // and the environment tiles + header render that resolution via `env.egress`. Without this re-pull the
  // Environment tab kept showing the pre-change value until a manual reload — the operator saw "Local IP"
  // while the logs already reported the proxy applied. Every mutation path funnels through here, so one
  // refresh covers them all. Environments + accounts only (NOT reloadAll: inventories are unaffected by a
  // routing change and re-fetching them would make a rule toggle needlessly expensive).
  // (v1.4.4 — owner issue 1.)
  try {
    const [environments, allAccounts] = await Promise.all([api('/api/environments'), api('/api/accounts')]);
    state.environments = environments;
    state.allAccounts = normalizeAccounts(allAccounts);
    // Repaint whichever surface is showing the egress, so the change is visible without navigating away.
    if (state.nav === 'dashboard' || state.screen === 'dashboard') renderDashboard();
    else if (state.screen === 'inventory' && state.activeEnv) updateSidebar();
  } catch { /* the rules themselves are already painted; a stale tile is not worth failing the action */ }
}

async function toggleProxyRuleUi(rule) {
  try { await api(`/api/proxies/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) }); await reloadProxyRules(); }
  catch (e) { toast(e.message, 'error'); }
}

async function deleteProxyRuleUi(rule) {
  if (!(await ssimConfirm({ title: 'Delete proxy rule', tone: 'danger', confirmLabel: 'Delete', confirmIcon: 'fa-trash', body: `Delete this ${escapeHtml(rule.scope)} rule?<br><span class="text-slate-500">Accounts it covered fall to the next-most-specific rule (or local IP) on their next login.</span>` }))) return;
  try { await api(`/api/proxies/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }); await reloadProxyRules(); toast('Rule deleted', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

async function reorderProxyRuleUi(id, dir) {
  const ids = state.proxies.rules.map((r) => r.id);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try { await api('/api/proxies/rules/reorder', { method: 'POST', body: JSON.stringify({ order: ids }) }); await reloadProxyRules(); }
  catch (e) { toast(e.message, 'error'); }
}

// ── Add/Edit rule modal ───────────────────────────────────────────────────────

async function openProxyRuleModal(mode, rule) {
  const isEditPool = mode === 'edit' && !!rule && rule.kind === 'pool';
  const m = {
    mode, id: (rule && rule.id) || null, name: (rule && rule.name) || '',
    scope: (rule && rule.scope) || 'global',
    targets: new Set(mode === 'edit' && rule ? rule.targets : []),
    kind: (rule && rule.kind) || 'pool',
    proxiesText: '', validation: null,
    // F2: Save is BLOCKED while the current pool is being fetched, and after a fetch FAILURE, so an
    // edit can never save an empty/half-loaded pool (which the backend turns into a vault-wipe).
    revealPending: isEditPool, revealFailed: false,
  };
  state.proxies.modal = m;
  renderProxyModal();
  const ov = document.getElementById('proxy-modal-overlay'); if (ov) ov.classList.remove('hidden');
  if (isEditPool) {
    try {
      const info = await api(`/api/proxies/rules/${encodeURIComponent(rule.id)}/reveal`);
      if (state.proxies.modal !== m) return; // a different modal opened meanwhile
      m.proxiesText = (info.proxies || []).join('\n');
      m.revealPending = false;
      renderProxyModal();
    } catch {
      if (state.proxies.modal !== m) return;
      m.revealPending = false;
      m.revealFailed = true; // Save stays disabled until the operator re-enters a non-empty pool
      renderProxyModal();
    }
  }
}

function closeProxyModal() {
  state.proxies.modal = null;
  const ov = document.getElementById('proxy-modal-overlay'); if (ov) ov.classList.add('hidden');
  const card = document.getElementById('proxy-modal-card'); if (card) card.innerHTML = ''; // T1: clear the un-redacted pool out of the hidden DOM
}

function folderPathLabel(f, t) {
  const env = (t.environments || []).find((e) => e.id === f.environmentId);
  return `${env ? env.name : '?'} / ${f.name}`;
}

function targetCheckboxes(items, selected) {
  if (!items.length) return '<p class="t12 text-slate-600">Nothing to target at this scope.</p>';
  return items.map((it) => `<label class="flex items-center gap-2 t12 text-slate-300 py-0.5 cursor-pointer"><input type="checkbox" data-target="${escapeAttr(it.id)}" ${selected.has(it.id) ? 'checked' : ''}> ${escapeHtml(it.label)}</label>`).join('');
}

function crossRuleUsage(redacted) {
  const modal = state.proxies.modal;
  for (const rule of state.proxies.rules) {
    if (modal && rule.id === modal.id) continue;
    if ((rule.proxies || []).includes(redacted)) return rule.name || (rule.scope + ' rule');
  }
  return null;
}

function renderValidation(v) {
  if (!v) return '';
  if (!v.length) return '<p class="t11 text-slate-500 mt-2">Nothing to validate.</p>';
  return `<div class="mt-2 space-y-0.5">${v.map((r) => {
    if (!r.valid) return `<div class="t11 text-red-400"><i class="fa-solid fa-xmark mr-1"></i>${escapeHtml(r.input)} — ${escapeHtml(r.reason)}</div>`;
    const cross = crossRuleUsage(r.redacted);
    return `<div class="t11 ${r.dup ? 'text-amber-400' : 'text-emerald-400'}"><i class="fa-solid ${r.dup ? 'fa-triangle-exclamation' : 'fa-check'} mr-1"></i>${escapeHtml(r.redacted)}${r.dup ? ' — duplicate in this list' : ''}${cross ? ` — <span class="text-amber-400">already in “${escapeHtml(cross)}”</span>` : ''}</div>`;
  }).join('')}</div>`;
}

function renderProxyModal() {
  const m = state.proxies.modal; if (!m) return;
  const card = document.getElementById('proxy-modal-card'); if (!card) return;
  const t = state.proxies.targets || { environments: [], folders: [], accounts: [] };
  const scopeBtn = (val, label) => `<button data-scope="${val}" class="px-3 py-1.5 rounded-lg t12 border ${m.scope === val ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-400 hover:text-slate-200'}">${label}</button>`;
  let picker;
  if (m.scope === 'environment') picker = targetCheckboxes(t.environments.map((e) => ({ id: e.id, label: e.name })), m.targets);
  else if (m.scope === 'folder') picker = targetCheckboxes(t.folders.map((f) => ({ id: f.id, label: folderPathLabel(f, t) })), m.targets);
  else if (m.scope === 'account') picker = targetCheckboxes(t.accounts.map((a) => ({ id: a.username.toLowerCase(), label: a.username })), m.targets);
  else picker = '<p class="t12 text-slate-500">Applies to every account.</p>';

  const poolLines = m.proxiesText.split('\n').map((s) => s.trim()).filter(Boolean);
  // F2/F7: a pool rule may only Save with a non-empty pool AND never while its prefill is pending.
  const saveDisabled = m.kind === 'pool' && (m.revealPending || poolLines.length === 0);
  const revealNote = m.revealPending
    ? '<p class="t11 text-slate-500 mt-2"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Loading the current pool…</p>'
    : (m.revealFailed
      ? '<p class="t11 text-red-400 mt-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Couldn’t load the current pool — re-enter the proxies or cancel. Saving is blocked (an empty save would delete the pool).</p>'
      : '');
  // Validate & dedupe button + pin-per-account checkbox REMOVED (owner 2026-07-09):
  // Save validates every line itself and duplicates are dropped automatically — no extra click.
  const pool = m.kind === 'local'
    ? '<p class="t12 text-amber-400"><i class="fa-solid fa-house-laptop mr-1"></i>This rule forces its targets onto the local IP (no proxy).</p>'
    : `<textarea data-proxy-text rows="5" ${m.revealPending ? 'disabled' : ''} class="${ACC_IN} font-mono t12 ${m.revealPending ? 'opacity-50' : ''}" placeholder="One proxy per line — host:port:user:pass · user:pass@host:port · full URL">${escapeHtml(m.proxiesText)}</textarea>
       <p class="t10 text-slate-600 mt-1.5">Lines are validated on save; duplicates are removed automatically.</p>
       ${revealNote}${renderValidation(m.validation)}`;

  card.innerHTML = `
    <div class="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
      <h3 class="t16 font-bold text-white"><i class="fa-solid fa-network-wired text-brand mr-2"></i>${m.mode === 'edit' ? 'Edit' : 'New'} proxy rule</h3>
      <button data-proxy-cancel aria-label="Close" class="modal-x"><i class="fa-solid fa-xmark text-lg"></i></button>
    </div>
    <div class="px-6 py-5 space-y-4">
      <label class="block t11 text-slate-400">Name <span class="text-slate-600">(optional)</span><input data-proxy-name value="${escapeAttr(m.name)}" class="${ACC_IN} mt-1" placeholder="e.g. EU residential pool"></label>
      <div><p class="t11 text-slate-400 mb-1.5">Scope</p><div class="flex flex-wrap gap-2">${scopeBtn('global', 'Global')}${scopeBtn('environment', 'Environment')}${scopeBtn('folder', 'Folder')}${scopeBtn('account', 'Account')}</div></div>
      <div><p class="t11 text-slate-400 mb-1.5">Targets</p><div class="max-h-40 overflow-y-auto rounded-lg border border-slate-800 p-2">${picker}</div></div>
      <div><p class="t11 text-slate-400 mb-1.5">Type</p><div class="flex gap-2">
        <button data-kind="pool" class="px-3 py-1.5 rounded-lg t12 border ${m.kind === 'pool' ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-400'}">Proxy pool</button>
        <button data-kind="local" class="px-3 py-1.5 rounded-lg t12 border ${m.kind === 'local' ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-400'}">Force local IP</button>
      </div></div>
      <div>${pool}</div>
    </div>
    <div class="px-6 py-4 border-t border-slate-800 flex justify-end gap-2">
      <button data-proxy-cancel class="px-4 py-2 rounded-xl t13 text-slate-400 hover:text-white">Cancel</button>
      <button data-proxy-save ${saveDisabled ? 'disabled' : ''} class="px-4 py-2 rounded-xl t13 font-semibold ${saveDisabled ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand text-white hover:brightness-110'}">${m.mode === 'edit' ? 'Save' : 'Create'}</button>
    </div>`;
}

function onProxyModalClick(e) {
  const m = state.proxies.modal; if (!m) return;
  if (e.target === document.getElementById('proxy-modal-overlay')) return closeProxyModal();
  const scope = e.target.closest('[data-scope]'); if (scope) { m.scope = scope.getAttribute('data-scope'); m.targets = new Set(); renderProxyModal(); return; }
  const kind = e.target.closest('[data-kind]'); if (kind) { m.kind = kind.getAttribute('data-kind'); renderProxyModal(); return; }
  if (e.target.closest('[data-proxy-cancel]')) return closeProxyModal();
  if (e.target.closest('[data-proxy-save]')) return saveProxyModal();
}

function onProxyModalInput(e) {
  const m = state.proxies.modal; if (!m) return;
  if (e.target.matches('[data-proxy-name]')) m.name = e.target.value;
  else if (e.target.matches('[data-proxy-text]')) m.proxiesText = e.target.value;
  else if (e.target.matches('[data-target]')) { const id = e.target.getAttribute('data-target'); if (e.target.checked) m.targets.add(id); else m.targets.delete(id); }
}

async function saveProxyModal() {
  const m = state.proxies.modal; if (!m) return;
  if (m.revealPending) return; // F2: never save a half-loaded edit
  // Automatic dedupe (owner 2026-07-09): duplicate lines are dropped silently — no extra click.
  const proxies = m.kind === 'pool' ? [...new Set(m.proxiesText.split('\n').map((s) => s.trim()).filter(Boolean))] : [];
  if (m.kind === 'pool') {
    if (!proxies.length) { toast('Add at least one proxy, or switch the type to “Force local IP”.', 'error'); return; }
    // F7: classify on Save (not only via the button) so the operator sees per-line reasons; block if
    // NONE are valid — the server 400s anyway, but this shows exactly which lines are bad.
    try {
      const resp = await api('/api/proxies/validate', { method: 'POST', body: JSON.stringify({ proxies }) });
      m.validation = (resp && resp.results) || [];
      renderProxyModal();
      if (!m.validation.some((r) => r.valid)) { toast('No valid proxies — fix the highlighted lines.', 'error'); return; }
    } catch (e) { toast(e.message, 'error'); return; }
  }
  // pinPerAccount feature removed (owner 2026-07-09) — saving a rule always clears any old pin.
  const body = { name: m.name, scope: m.scope, targets: [...m.targets], kind: m.kind, proxies, pinPerAccount: false };
  try {
    if (m.mode === 'edit') { await api(`/api/proxies/rules/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('Rule saved', 'success'); }
    else { await api('/api/proxies/rules', { method: 'POST', body: JSON.stringify(body) }); toast('Rule created', 'success'); }
    closeProxyModal(); await reloadProxyRules();
  } catch (e) { toast(e.message, 'error'); }
}

function renderBatchModule() {
  ensureBatchWiring();
  if (!state.batch.registry.length && !state.batch._loading) {
    state.batch._loading = true;
    api('/api/batch/registry').then((r) => { state.batch.registry = Array.isArray(r) ? r : []; state.batch._loading = false; paintBatch(); }).catch(() => { state.batch._loading = false; });
  }
  if (!state.batch.targets && !state.batch._targetsLoading) {
    state.batch._targetsLoading = true;
    // The generation is captured BEFORE the request and re-checked on arrival: an invalidation that
    // lands mid-flight (an import finishing while this very screen is open) must not have its fresh
    // tree overwritten by the older answer still on the wire.
    const gen = state.batch._targetsGen || 0;
    api('/api/batch/targets').then((r) => {
      state.batch._targetsLoading = false;
      if ((state.batch._targetsGen || 0) !== gen) { renderBatchModule(); return; }   // superseded → refetch
      state.batch.targets = r && r.environments ? r : { environments: [], folders: [], accounts: [] };
      paintBatch();
    }).catch(() => { state.batch._targetsLoading = false; });
  }
  if (!state.batch._histLoaded) { state.batch._histLoaded = true; loadBatchHistory(); }
  if (!state.prime.loaded && !state.prime._loading) loadPrimeStatus();
  if (state.batch.status && state.batch.status.running && !state.batch.timer) pollBatch();
  // The paysafecard sub-run needs the SAME re-arm as the headless job poll above. pollPaysafeStatus()
  // self-clears the moment the operator navigates away (and a human-in-the-loop run gives them plenty of
  // time to), so without this the money-run view would come back frozen on a stale snapshot: no
  // auto-advance, no credited tally, no completion toast.
  const ps = state.batch.paysafe;
  if (ps.session && ps.session.running && !ps.timer) pollPaysafeStatus();
  // On a fresh page load the server may still be driving a run we know nothing about — reattach to it
  // rather than leaving the operator locked out (a new Start would just 409).
  if (!ps.session && !ps._attached) { ps._attached = true; reattachPaysafeRun(); }
  paintBatch();
}

/** Adopt a paysafecard run that the SERVER is still driving (page reload / backend restart of the UI). */
async function reattachPaysafeRun() {
  const p = state.batch.paysafe;
  try {
    const s = await api('/api/steam/paysafe/status');
    if (s && s.running) { p.session = s; pollPaysafeStatus(); paintBatch(); }
  } catch { /* no run in progress, or the backend isn't up yet — nothing to adopt */ }
}

function ensureBatchWiring() {
  const body = el.batchBody || document.getElementById('batch-body');
  if (!body || body.dataset.wired === '1') return;
  body.dataset.wired = '1';
  body.addEventListener('click', onBatchClick);
  body.addEventListener('input', onBatchInput);
}

/** All descendant folder ids of `fid` (inclusive), walking the parentId tree from state.batch.targets. */
function batchFolderSubtree(fid) {
  const t = state.batch.targets;
  const out = new Set([fid]);
  if (!t) return out;
  const kids = new Map();
  for (const f of t.folders) { const p = f.parentId || null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(f.id); }
  const stack = [fid];
  while (stack.length) { const cur = stack.pop(); for (const c of (kids.get(cur) || [])) if (!out.has(c)) { out.add(c); stack.push(c); } }
  return out;
}

/** The batch scope selection (step 1) as a generic tree-selection object. */
function batchScopeSel() {
  const b = state.batch;
  return { envs: b.scopeEnvs, folders: b.scopeFolders, accounts: b.scopeAccounts, expanded: b.expanded, search: b.search || '' };
}

/** Resolve an env/folder/account micro-selection to a username set. The scope is PURE
 *  (owner 2026-07-09): only the tree picks count — no side-channel "current selection".
 *  `sel` defaults to the step-1 scope; the Distribute SOURCE picker passes its own. */
function batchScopeUsernames(sel = batchScopeSel()) {
  const b = state.batch;
  const set = new Set();
  const accts = (b.targets && b.targets.accounts) || state.allAccounts;
  // Folder selection expands to descendants (a parent folder covers its subfolders' accounts).
  let wantedFolders = null;
  if (sel.folders.size) { wantedFolders = new Set(); for (const fid of sel.folders) for (const d of batchFolderSubtree(fid)) wantedFolders.add(d); }
  for (const a of accts) {
    if (sel.envs.has(a.environmentId)) { set.add(a.username); continue; }
    if (wantedFolders && a.folderId && wantedFolders.has(a.folderId)) { set.add(a.username); continue; }
    if (sel.accounts.has(a.username)) set.add(a.username);
  }
  return [...set];
}

/** Is this account already pulled in by a selected environment or (ancestor) folder? (for display) */
function batchAccountCovered(a, sel = batchScopeSel()) {
  if (sel.envs.has(a.environmentId)) return 'environment';
  if (sel.folders.size && a.folderId) { for (const fid of sel.folders) if (batchFolderSubtree(fid).has(a.folderId)) return 'folder'; }
  return null;
}

/** The env→folder→account selection tree (search-filterable, collapsible). Parameterized so it
 *  serves BOTH the step-1 scope (prefix 'batch') and the Distribute SOURCE picker (prefix 'dist')
 *  with independent selection state; the structural data (state.batch.targets) is shared. */
function batchScopeTree(sel = batchScopeSel(), prefix = 'batch') {
  const t = state.batch.targets;
  if (!t) return '<div class="t12 text-slate-600 py-2">Loading accounts…</div>';
  const q = (sel.search || '').trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (u) => !searching || u.toLowerCase().includes(q);
  const chk = (on) => `<span class="inline-flex items-center justify-center w-4 h-4 rounded border ${on ? 'bg-brand border-brand text-white' : 'border-slate-600'}">${on ? '<i class="fa-solid fa-check t10"></i>' : ''}</span>`;
  const caret = (open) => `<i class="fa-solid fa-chevron-${open ? 'down' : 'right'} t10 text-slate-500 w-3"></i>`;

  const childFolders = new Map();
  for (const f of t.folders) {
    const p = f.parentId || null; if (!childFolders.has(p)) childFolders.set(p, []); childFolders.get(p).push(f);
  }
  const acctsByEnv = new Map(); const acctsByFolder = new Map(); const rootAcctsByEnv = new Map();
  for (const a of t.accounts) {
    if (!acctsByEnv.has(a.environmentId)) acctsByEnv.set(a.environmentId, []);
    acctsByEnv.get(a.environmentId).push(a);
    if (a.folderId) { if (!acctsByFolder.has(a.folderId)) acctsByFolder.set(a.folderId, []); acctsByFolder.get(a.folderId).push(a); }
    else { if (!rootAcctsByEnv.has(a.environmentId)) rootAcctsByEnv.set(a.environmentId, []); rootAcctsByEnv.get(a.environmentId).push(a); }
  }

  const acctRow = (a, depth) => {
    const covered = batchAccountCovered(a, sel);
    const on = sel.accounts.has(a.username) || !!covered;
    return `<button data-${prefix}-acct="${escapeAttr(a.username)}" class="w-full flex items-center gap-2 py-1 pr-2 rounded hover:bg-slate-800/40 text-left" style="padding-left:${depth * 16 + 8}px" title="${covered ? 'Covered by the selected ' + covered : 'Select this account'}">
      ${chk(on)}<span class="t12 ${on ? 'text-slate-200' : 'text-slate-400'} truncate">${escapeHtml(a.username)}</span>${covered ? `<span class="t10 text-slate-600">· via ${covered}</span>` : ''}</button>`;
  };
  // Recursive folder render; returns '' if searching and nothing inside matches.
  const renderFolder = (f, depth) => {
    const kids = childFolders.get(f.id) || [];
    const own = (acctsByFolder.get(f.id) || []);
    const shownAccts = own.filter((a) => matches(a.username));
    const kidHtml = kids.map((k) => renderFolder(k, depth + 1)).join('');
    if (searching && !shownAccts.length && !kidHtml) return '';
    const open = searching || sel.expanded.has(f.id);
    const on = sel.folders.has(f.id);
    const total = (acctsByFolder.get(f.id) || []).length;
    const head = `<div class="flex items-center gap-1" style="padding-left:${depth * 16}px">
      <button data-${prefix}-exp="${escapeAttr(f.id)}" class="px-1 py-1">${caret(open)}</button>
      <button data-${prefix}-folder="${escapeAttr(f.id)}" class="flex items-center gap-2 py-1 pr-2 rounded hover:bg-slate-800/40 flex-1 text-left">${chk(on)}<i class="fa-solid fa-folder t11 ${on ? 'text-brand' : 'text-slate-500'}"></i><span class="t12 ${on ? 'text-brand' : 'text-slate-300'} truncate">${escapeHtml(f.name)}</span><span class="t10 text-slate-600">${fmtCount(total)}</span></button></div>`;
    const body = open ? `${kidHtml}${shownAccts.map((a) => acctRow(a, depth + 1)).join('')}` : '';
    return head + body;
  };

  const envBlocks = t.environments.map((e) => {
    const roots = (childFolders.get(null) || []).filter((f) => f.environmentId === e.id);
    const rootAccts = (rootAcctsByEnv.get(e.id) || []);
    const shownRootAccts = rootAccts.filter((a) => matches(a.username));
    const foldersHtml = roots.map((f) => renderFolder(f, 1)).join('');
    if (searching && !shownRootAccts.length && !foldersHtml) return '';
    const open = searching || sel.expanded.has(e.id);
    const on = sel.envs.has(e.id);
    const total = (acctsByEnv.get(e.id) || []).length;
    const head = `<div class="flex items-center gap-1">
      <button data-${prefix}-exp="${escapeAttr(e.id)}" class="px-1 py-1">${caret(open)}</button>
      <button data-${prefix}-env="${escapeAttr(e.id)}" class="flex items-center gap-2 py-1.5 pr-2 rounded hover:bg-slate-800/40 flex-1 text-left">${chk(on)}<i class="fa-solid fa-layer-group t11 ${on ? 'text-brand' : 'text-slate-500'}"></i><span class="t13 font-medium ${on ? 'text-brand' : 'text-slate-200'} truncate">${escapeHtml(e.name)}</span><span class="t10 text-slate-600">${fmtCount(total)} acct</span></button></div>`;
    const body = open ? `<div class="border-l border-slate-800 ml-3">${foldersHtml}${shownRootAccts.map((a) => acctRow(a, 1)).join('')}</div>` : '';
    return `<div class="mb-0.5">${head}${body}</div>`;
  }).join('');

  return envBlocks || `<div class="t12 text-slate-600 py-2">${searching ? 'No accounts match “' + escapeHtml(sel.search) + '”.' : 'No environments.'}</div>`;
}

function paintBatch() {
  const b = state.batch;
  if (el.batchHeader) el.batchHeader.innerHTML = `<div><h2 class="t28 font-bold text-white tracking-tight">Batch Jobs</h2><p class="t14 text-slate-500 mt-1">Pick a scope, pick a job, run it across many accounts with one progress view.</p></div>`;
  if (!el.batchBody) return;
  const scopeUsernames = batchScopeUsernames();   // resolved ONCE per paint — it walks every account × folder
  const scopeCount = scopeUsernames.length;
  const running = !!(b.status && b.status.running);

  const anySel = b.scopeEnvs.size || b.scopeFolders.size || b.scopeAccounts.size;
  // Accounts currently VISIBLE in the tree given the active filter — the exact set "Select all" grabs.
  const scopeQ = (b.search || '').trim().toLowerCase();
  const scopeVisibleAccts = ((b.targets && b.targets.accounts) || []).filter((a) => !scopeQ || a.username.toLowerCase().includes(scopeQ));
  // Scope = PURE selection (owner 2026-07-09): the tree and nothing else. For Distribute the
  // scope is the RECEIVING accounts; everything job-specific lives in step 3.
  const scopeSection = `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="t14 font-bold text-white">1 · Scope <span class="t11 text-slate-500 font-normal">— ${fmtCount(scopeCount)} account${scopeCount === 1 ? '' : 's'} selected</span></h3>
      <div class="flex items-center gap-3">
        ${scopeVisibleAccts.length ? `<button data-batch-select-all class="t11 text-slate-500 hover:text-slate-300"><i class="fa-solid fa-check-double mr-1"></i>Select all${scopeQ ? ' ' + fmtCount(scopeVisibleAccts.length) : ''}</button>` : ''}
        ${anySel ? '<button data-batch-clear class="t11 text-slate-500 hover:text-slate-300"><i class="fa-solid fa-xmark mr-1"></i>Clear</button>' : ''}
      </div>
    </div>
    <p class="t11 text-slate-500 mb-2">Pick any mix — whole environments, individual folders (subfolders included), or single accounts.</p>
    <div class="relative mb-2"><i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 t11 text-slate-600"></i>
      <input data-batch-search type="text" placeholder="Filter accounts…" value="${escapeAttr(b.search || '')}" class="${ACC_IN}" style="padding-left:2rem"></div>
    <div data-scope-scroll="batch" class="max-h-72 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-2">${batchScopeTree()}</div>
  </section>`;

  // Distribute + paysafecard are first-class client-routed JOBS in step 2 (their own engines/
  // sequential flow; the registry stays server-truth for headless fan-out jobs).
  const allJobs = [...b.registry, BATCH_DIST_JOB, ...(state.paysafeEnabled ? [BATCH_PAYSAFE_JOB] : [])];
  const groups = { read: 'Read', money: 'Money', manage: 'Manage' };
  const jobCards = Object.keys(groups).map((g) => {
    const jobs = allJobs.filter((j) => j.group === g);
    if (!jobs.length) return '';
    return `<div class="mb-3"><p class="t10 text-slate-500 uppercase tracking-wide mb-1.5">${groups[g]}</p><div class="flex flex-wrap gap-2">${jobs.map((j) => {
      const sel = b.jobType === j.jobType, dis = !j.enabled;
      return `<button ${dis ? 'disabled' : `data-batch-job="${escapeAttr(j.jobType)}"`} class="px-3 py-1.5 rounded-lg t12 border ${dis ? 'border-slate-800 text-slate-600 cursor-not-allowed' : sel ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-300 hover:text-white'}" title="${dis ? 'Not runnable from Batch — see the button hint' : (j.experimental ? 'Beta — wired but not yet live-verified' : '')}">${escapeHtml(j.label)}${j.moneySafe ? ' <span class="t10" style="color:rgb(var(--brand-rgb))">$</span>' : ''}${j.experimental && !dis ? ' <span class="t10 px-1 rounded" style="background:rgb(var(--warn-rgb) / .2); color:rgb(var(--warn-rgb))">Beta</span>' : ''}${dis ? ' <i class="fa-solid fa-lock t10"></i>' : ''}</button>`;
    }).join('')}</div></div>`;
  }).join('');
  const jobSection = `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4"><h3 class="t14 font-bold text-white mb-3">2 · Job</h3>${jobCards || '<span class="t12 text-slate-600">Loading…</span>'}</section>`;

  let runSection;
  if (b.jobType === 'distribute') {
    runSection = batchDistributeSection(scopeCount);
  } else if (b.jobType === 'paysafe') {
    runSection = batchPaysafeSection(scopeCount);
  } else {
    const def = b.registry.find((j) => j.jobType === b.jobType);
    let paramInner;
    if (def && def.paramSchema && def.paramSchema.length) {
      paramInner = def.paramSchema.map((f) => {
        const val = b.params[f.key] ?? '';
        if (f.type === 'select') return `<label class="block t11 text-slate-400 mb-2">${escapeHtml(f.label)}<select data-batch-param="${escapeAttr(f.key)}" class="${ACC_IN} mt-1">${(f.options || []).map((o) => `<option value="${escapeAttr(o.value)}" ${String(val) === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></label>`;
        // 'multiline' → a REAL textarea: paste one-per-line lists without guessing (owner 2026-07-09).
        if (f.type === 'multiline') return `<label class="block t11 text-slate-400 mb-2">${escapeHtml(f.label)}<textarea data-batch-param="${escapeAttr(f.key)}" rows="8" spellcheck="false" class="${ACC_IN} mt-1 font-mono" placeholder="One per line…">${escapeHtml(String(val))}</textarea>${f.help ? `<span class="block t10 text-slate-600 mt-0.5">${escapeHtml(f.help)}</span>` : ''}</label>`;
        return `<label class="block t11 text-slate-400 mb-2">${escapeHtml(f.label)}<input data-batch-param="${escapeAttr(f.key)}" type="${f.type === 'money' || f.type === 'number' ? 'number' : 'text'}" ${f.min != null ? `min="${f.min}"` : ''} class="${ACC_IN} mt-1" value="${escapeAttr(String(val))}">${f.help ? `<span class="block t10 text-slate-600 mt-0.5">${escapeHtml(f.help)}</span>` : ''}</label>`;
      }).join('');
    } else if (def) paramInner = `<p class="t12 text-slate-500">No parameters — runs on the ${fmtCount(scopeCount)}-account scope.</p>`;
    else paramInner = `<p class="t12 text-slate-600">Select a job above.</p>`;
    // The two Prime jobs lead with fleet coverage: "which of these already has Prime?" is the question
    // the operator has before running either one, and it must be answerable without spending anything.
    const primeStrip = (b.jobType === 'buy-prime' || b.jobType === 'check-prime')
      ? primeCoverageHtml(scopeUsernames, b.jobType) : '';
    const canRun = !!(def && def.enabled && scopeCount > 0 && !running);
    runSection = `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4"><h3 class="t14 font-bold text-white mb-3">3 · Run</h3>${primeStrip}${paramInner}
      <div class="mt-3 flex gap-2">
        <button ${canRun ? 'data-batch-run' : 'disabled'} class="btn ${canRun ? (def && def.moneySafe ? 'bg-brand text-white' : 'btn-secondary') : 'btn-secondary opacity-50 cursor-not-allowed'} btn-sm"><i class="fa-solid fa-play"></i><span>Run</span></button>
        ${running ? '<button data-batch-cancel class="btn btn-secondary btn-sm"><i class="fa-solid fa-stop"></i><span>Cancel</span></button>' : ''}
      </div></section>`;
  }

  let progressSection = '';
  const st = b.status;
  if (st && (st.running || st.finishedAt)) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    progressSection = `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4">
      <div class="flex items-center justify-between mb-2"><h3 class="t14 font-bold text-white">${escapeHtml(st.label || 'Job')} ${st.running ? '<span class="t11 text-brand">running…</span>' : '<span class="t11 text-emerald-400">done</span>'}</h3><span class="t12 font-mono text-slate-400">${fmtCount(st.done)}/${fmtCount(st.total)} · ${fmtCount((st.failed || []).length)} failed</span></div>
      <div class="h-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full bg-brand transition-all" style="width:${pct}%"></div></div>
      ${batchResultRows(st)}
      ${(st.failed || []).length ? `<div class="mt-3 max-h-40 overflow-y-auto t11 text-slate-500 space-y-0.5">${st.failed.slice(0, 50).map((f) => `<div><span class="font-mono text-amber-400/80">${escapeHtml(f.username)}</span> — ${escapeHtml(f.error)}</div>`).join('')}</div>` : ''}
    </section>`;
  }

  const histSection = `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5"><h3 class="t14 font-bold text-white mb-3">History</h3>${
    (b.history || []).length ? `<div class="space-y-1">${b.history.slice(0, 30).map((h) => `<div class="flex items-center justify-between t12 py-1 border-b border-slate-800/60"><span class="text-slate-300">${escapeHtml(h.label)} <span class="text-slate-600">· ${fmtCount(h.scopeCount)} acct</span></span><span class="font-mono text-slate-500">${fmtCount(h.done)}/${fmtCount(h.total)} · <span class="${h.outcome === 'ok' ? 'text-emerald-400' : h.outcome === 'error' ? 'text-red-400' : 'text-amber-400'}">${escapeHtml(h.outcome)}</span></span></div>`).join('')}</div>` : '<p class="t12 text-slate-600">No runs yet.</p>'
  }</section>`;

  el.batchBody.innerHTML = scopeSection + jobSection + runSection + progressSection + histSection;
}

// ── Per-account outcome rows (W4_41) ──────────────────────────────────────────
// done/failed counts cannot express a money job's real outcomes: "already owned", "wallet too low"
// and "bought" are all non-failures that mean very different things. A job that returns a row per
// account (BatchJobService collects them into status.result.rows) gets them rendered here; every
// other job returns nothing and this stays invisible.
const BATCH_ROW_TONE = {
  purchased:   ['text-emerald-400', 'bought'],
  owned:       ['text-sky-400',     'already owned'],
  skipped:     ['text-slate-400',   'skipped'],
  refused:     ['text-amber-400',   'not bought'],
  unconfirmed: ['text-red-400',     'UNCONFIRMED'],
};
// The read-only Prime check reports OWNERSHIP, not a purchase outcome, so it gets its own wording.
// 'unreadable' is deliberately its own row and never folded into "no Prime" — an account SSIM could
// not read is not an account that needs buying.
const BATCH_ROW_TONE_PRIME = {
  owned:      ['text-sky-400',     'has Prime'],
  missing:    ['text-emerald-400', 'no Prime'],
  unreadable: ['text-amber-400',   'could not read'],
};
function batchResultRows(st) {
  const rows = st && st.result && Array.isArray(st.result.rows) ? st.result.rows : null;
  if (!rows || !rows.length) return '';
  const tones = st.jobType === 'check-prime' ? BATCH_ROW_TONE_PRIME : BATCH_ROW_TONE;
  // Summary first: on a 500-account run nobody scrolls a list to find the one that needs attention.
  const counts = {};
  for (const r of rows) counts[r && r.status] = (counts[r && r.status] || 0) + 1;
  const summary = Object.keys(tones).filter((k) => counts[k]).map((k) => {
    const [tone, label] = tones[k];
    return `<span class="${tone}">${fmtCount(counts[k])} ${escapeHtml(label)}</span>`;
  }).join('<span class="text-slate-700 mx-1.5">·</span>');
  const list = rows.slice(-200).reverse().map((r) => {
    const [tone, label] = tones[r && r.status] || ['text-slate-400', String((r && r.status) || '?')];
    return `<div class="flex gap-2 items-baseline py-0.5 border-b border-slate-800/40">
      <span class="font-mono text-slate-300 shrink-0" style="min-width:9rem">${escapeHtml(String((r && r.username) || ''))}</span>
      <span class="${tone} shrink-0" style="min-width:6.5rem">${escapeHtml(label)}</span>
      <span class="text-slate-500">${escapeHtml(String((r && r.detail) || ''))}</span>
    </div>`;
  }).join('');
  return `<div class="mt-3"><p class="t11 mb-1.5">${summary}</p>
    <div class="max-h-72 overflow-y-auto t11">${list}</div></div>`;
}

/** Repaint the whole batch body but KEEP each scope tree's scroll position. The tree lives inside a
 *  full innerHTML re-render (paintBatch), so its container is destroyed & recreated with scrollTop=0 —
 *  making the list "jump to top" on every account toggle. Save→restore mirrors the search-input focus
 *  preservation; keyed by data-scope-scroll ("batch"/"dist") so the fresh node is matched 1:1. */
function paintBatchKeepScroll() {
  const body = el.batchBody;
  const saved = new Map();
  if (body) for (const c of body.querySelectorAll('[data-scope-scroll]')) saved.set(c.getAttribute('data-scope-scroll'), c.scrollTop);
  paintBatch();
  if (body) for (const c of body.querySelectorAll('[data-scope-scroll]')) { const v = saved.get(c.getAttribute('data-scope-scroll')); if (v) c.scrollTop = v; }
}
/** Add every account currently VISIBLE under the step-1 filter to the explicit account scope. */
function batchSelectAllVisible() {
  const b = state.batch;
  const accts = (b.targets && b.targets.accounts) || [];
  const q = (b.search || '').trim().toLowerCase();
  for (const a of accts) if (!q || a.username.toLowerCase().includes(q)) b.scopeAccounts.add(a.username);
}
function toggleInSet(set, id) { if (set.has(id)) set.delete(id); else set.add(id); }
function onBatchClick(e) {
  const t = e.target; let n;
  if ((n = t.closest('[data-batch-exp]')))    { toggleInSet(state.batch.expanded, n.dataset.batchExp); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-batch-env]')))    { toggleInSet(state.batch.scopeEnvs, n.dataset.batchEnv); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-batch-folder]'))) { toggleInSet(state.batch.scopeFolders, n.dataset.batchFolder); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-batch-acct]')))   { toggleInSet(state.batch.scopeAccounts, n.dataset.batchAcct); return paintBatchKeepScroll(); }
  if (t.closest('[data-batch-select-all]'))   { batchSelectAllVisible(); return paintBatchKeepScroll(); }
  if (t.closest('[data-batch-clear]'))        { state.batch.scopeEnvs.clear(); state.batch.scopeFolders.clear(); state.batch.scopeAccounts.clear(); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-batch-job]')))    { state.batch.jobType = n.dataset.batchJob; state.batch.params = {}; state.batch.dist.plan = null; return paintBatch(); }
  if (t.closest('[data-batch-run]'))          return runBatch();
  if (t.closest('[data-batch-cancel]'))       return cancelBatch();
  // Distribute SOURCE micro-selection tree (prefix 'dist') + its actions.
  if ((n = t.closest('[data-dist-exp]')))     { toggleInSet(state.batch.dist.sel.expanded, n.dataset.distExp); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-dist-env]')))     { toggleInSet(state.batch.dist.sel.envs, n.dataset.distEnv); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-dist-folder]')))  { toggleInSet(state.batch.dist.sel.folders, n.dataset.distFolder); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-dist-acct]')))    { toggleInSet(state.batch.dist.sel.accounts, n.dataset.distAcct); return paintBatchKeepScroll(); }
  if (t.closest('[data-dist-clear]'))         { const s = state.batch.dist.sel; s.envs.clear(); s.folders.clear(); s.accounts.clear(); return paintBatchKeepScroll(); }
  if ((n = t.closest('[data-dist-game]')))     { return distSetGame(n.dataset.distGame); }
  // Active Orders' own CS2/TF2 pin (independent of the Inventories tab — see ordersGame).
  if ((n = t.closest('[data-orders-game]')))   { return ordersSetGame(n.dataset.ordersGame); }
  if (t.closest('[data-dist-pool-toggle]'))   { state.batch.dist.showPool = !state.batch.dist.showPool; return paintBatchKeepScroll(); }
  // Item-filter picker: add a pick, drop a chip, close the list.
  if ((n = t.closest('[data-dist-pick]')))    { return distPickerAdd(n.dataset.distPickKind, n.dataset.distPick); }
  if ((n = t.closest('[data-dist-chip]')))    { return distPickerRemove(n.dataset.distChipKind, n.dataset.distChip); }
  if (t.closest('[data-dist-pick-close]'))    { const d = state.batch.dist; d.picker = null; d.pickerSearch = ''; return paintBatchKeepScroll(); }
  // CLICKING the box opens the full list. Without this the only way in was to type a character,
  // which is exactly wrong for the operator who does not know what the items are called.
  if ((n = t.closest('[data-dist-pick-search]'))) {
    const kind = n.dataset.distPickSearch;
    if (state.batch.dist.picker === kind) return;      // already open — let the click place the caret
    state.batch.dist.picker = kind;
    state.batch.dist.pickerSearch = '';
    return repaintBatchKeepingPickerFocus(kind);
  }
  if (t.closest('[data-batch-dist-preview]')) return batchDistPreview();
  if (t.closest('[data-batch-dist-run]'))     return batchDistRun();
  if (t.closest('[data-batch-dist-cancel]'))  return batchDistCancel();
  // Sequential paysafecard wizard.
  if (t.closest('[data-paysafe-start]'))      return batchPaysafeStart();
  if (t.closest('[data-paysafe-stop]'))       return batchPaysafeStop();
  if (t.closest('[data-paysafe-reset]'))      { const p = state.batch.paysafe; if (p.timer) { clearInterval(p.timer); p.timer = null; } p.session = null; return paintBatch(); }
  const retry = t.closest('[data-paysafe-tiers-retry]');
  if (retry) { delete state.paysafeTiers[retry.dataset.paysafeTiersRetry]; return paintBatch(); }   // drop the cached error → re-fetch on next render
}
function onBatchInput(e) {
  const s = e.target.closest && e.target.closest('[data-batch-search]');
  if (s) {
    state.batch.search = e.target.value;
    paintBatch();
    const sb = el.batchBody && el.batchBody.querySelector('[data-batch-search]');
    if (sb) { sb.focus(); sb.setSelectionRange(sb.value.length, sb.value.length); }
    return;
  }
  const ds = e.target.closest && e.target.closest('[data-dist-search]');
  if (ds) {
    state.batch.dist.sel.search = e.target.value;
    paintBatch();
    const sb = el.batchBody && el.batchBody.querySelector('[data-dist-search]');
    if (sb) { sb.focus(); sb.setSelectionRange(sb.value.length, sb.value.length); }
    return;
  }
  const d = e.target.closest && e.target.closest('[data-batch-dist]');
  if (d) { state.batch.dist[d.dataset.batchDist] = e.target.value; return; }   // no repaint → no focus loss
  // The item-filter search DOES repaint (the candidate list has to re-filter as you type), so it
  // restores focus + caret afterwards — the same trick the scope search uses.
  const pk = e.target.closest && e.target.closest('[data-dist-pick-search]');
  if (pk) {
    const kind = pk.dataset.distPickSearch;
    state.batch.dist.picker = kind;
    state.batch.dist.pickerSearch = e.target.value;
    return repaintBatchKeepingPickerFocus(kind);
  }
  const ps = e.target.closest && e.target.closest('[data-paysafe-tier]');
  if (ps) { state.batch.paysafe.tierMinor = Number(e.target.value); return; }   // <select> — no repaint needed
  const pf = e.target.closest && e.target.closest('[data-paysafe-free]');
  if (pf) { state.batch.paysafe.freeAmount = e.target.value; return; }          // no repaint → no focus loss (validated on Start)
  const n = e.target.closest && e.target.closest('[data-batch-param]');
  if (n) state.batch.params[n.dataset.batchParam] = e.target.value;
}

async function runBatch() {
  const b = state.batch;
  const def = b.registry.find((j) => j.jobType === b.jobType);
  if (!def) return;
  const usernames = batchScopeUsernames();
  if (!usernames.length) { toast('Pick a scope first', 'warn'); return; }
  // Buying Prime is the one job that charges wallets unattended, so it states plainly what it is
  // about to spend on — a single Confirm, no typed word (owner 2026-08-05).
  if (def.jobType === 'buy-prime') {
    if (!(await ssimConfirm({
      title: 'Buy CS2 Prime with real balance',
      body: `This <b>charges the Steam wallet</b> of up to <b>${usernames.length}</b> account(s), one at a time, at whatever Steam prices Prime at in each account's own currency.<br><br>`
        + `Accounts that already have Prime, or whose wallet does not cover it, are <b>skipped</b> — not charged.<br><br>`
        + `<b>Beta.</b> Start with a few accounts and read the results before running the whole fleet.`,
      confirmLabel: 'Confirm', confirmIcon: 'fa-cart-shopping', tone: 'spend',
    }))) return;
  } else if (def.moneySafe || def.experimental) {
    const testWarn = def.experimental ? '<br><br><b>Beta.</b> Start with a few accounts and review the results before running at scale.' : '';
    const moneyWarn = def.moneySafe ? 'This is a <b>money</b> job. ' : '';
    if (!(await ssimConfirm({ title: `Run "${def.label}"`, body: `${moneyWarn}Run across <b>${usernames.length}</b> account(s)?${testWarn}`, confirmLabel: 'Run', confirmIcon: 'fa-play', tone: def.moneySafe ? 'spend' : 'brand', typedWord: (def.moneySafe && usernames.length > 25) ? 'RUN' : null }))) return;
  }
  try {
    b.status = await api('/api/batch/run', { method: 'POST', body: JSON.stringify({ jobType: def.jobType, scope: { usernames }, params: b.params, game: state.game }) });
    toast(`${def.label} started on ${usernames.length} account(s)`, 'success');
    pollBatch();
  } catch (e) { toast(e.message || 'Could not start the job', 'error'); }
  paintBatch();
}

function pollBatch() {
  if (state.batch.timer) clearInterval(state.batch.timer);
  state.batch.timer = setInterval(async () => {
    try {
      const s = await api('/api/batch/status');
      state.batch.status = s;
      if (!s.running) {
        clearInterval(state.batch.timer); state.batch.timer = null;
        loadBatchHistory();
        // A Prime job (either one) just re-read ownership on the server — pull the refreshed coverage
        // in so the panel is not still showing what was true before the run.
        if (s.jobType === 'check-prime' || s.jobType === 'buy-prime') loadPrimeStatus();
        toast(`Job finished: ${fmtCount(s.done)}/${fmtCount(s.total)}${(s.failed || []).length ? ` · ${s.failed.length} failed` : ''}`, (s.failed || []).length ? 'warn' : 'success');
      }
      paintBatch();
    } catch { /* transient — keep polling */ }
  }, 1200);
}

async function cancelBatch() {
  try { state.batch.status = await api('/api/batch/cancel', { method: 'POST' }); toast('Cancelling…', 'info'); paintBatch(); }
  catch (e) { toast(e.message || 'Cancel failed', 'error'); }
}

async function loadBatchHistory() {
  try { const h = await api('/api/batch/history'); state.batch.history = Array.isArray(h) ? h : []; paintBatch(); } catch { /* ignore */ }
}

/** The server's CACHED Prime answers — a plain read, no logins, safe to call on every visit.
 *  Accounts nobody has checked yet are simply absent from the map, which is what "not checked" means
 *  everywhere downstream: never confused with "no Prime". */
async function loadPrimeStatus() {
  state.prime._loading = true;
  try {
    const r = await api('/api/steam/prime-status');
    const rows = {};
    for (const row of (r && Array.isArray(r.rows) ? r.rows : [])) if (row && row.username) rows[row.username.toLowerCase()] = row;
    state.prime.rows = rows;
    state.prime.loaded = true;
    if (state.nav === 'batch') paintBatch();
  } catch { /* the coverage strip just stays "not checked" — never a blocker */ }
  state.prime._loading = false;
}

/** Prime coverage over a username list, as the three states the backend reports plus "never checked".
 *  Kept strictly separate: an account SSIM could not read is not an account without Prime. */
function primeCoverage(usernames) {
  const c = { owned: 0, missing: 0, unreadable: 0, unchecked: 0, missingNames: [] };
  for (const u of usernames) {
    const row = state.prime.rows[String(u).toLowerCase()];
    if (!row) { c.unchecked++; continue; }
    if (row.status === 'owned') c.owned++;
    else if (row.status === 'missing') { c.missing++; c.missingNames.push(u); }
    else c.unreadable++;
  }
  return c;
}

/** The coverage strip shown on the two Prime jobs' Run panel. Answers the owner's question —
 *  "which of these already has Prime?" — before a single euro moves. */
function primeCoverageHtml(usernames, jobType) {
  if (!usernames.length) return '';
  const c = primeCoverage(usernames);
  const pill = (n, cls, label, title) => (n ? `<span class="${cls}" title="${escapeAttr(title)}">${fmtCount(n)} ${escapeHtml(label)}</span>` : '');
  const parts = [
    pill(c.owned, 'text-sky-400', 'already have Prime', 'Confirmed from the account’s own Steam licences — a purchase would be refused as "already owned".'),
    pill(c.missing, 'text-emerald-400', 'need Prime', 'Checked, and Prime is not on the account.'),
    pill(c.unreadable, 'text-amber-400', 'unreadable', 'SSIM could not read these accounts’ licences, so it will not guess either way.'),
    pill(c.unchecked, 'text-slate-500', 'not checked yet', 'No ownership reading for these accounts yet — run "Check CS2 Prime ownership".'),
  ].filter(Boolean).join('<span class="text-slate-700 mx-1.5">·</span>');
  const needCheck = c.unchecked > 0 && jobType !== 'check-prime';
  return `<div class="rounded-xl border border-slate-800 bg-slate-950/40 p-3 mb-3">
    <p class="t11">${parts}</p>
    ${needCheck ? `<p class="t10 text-slate-500 mt-1.5">Ownership is re-verified per account during the run either way — nothing is ever charged twice. <button data-batch-job="check-prime" class="text-brand hover:underline">Check ${fmtCount(c.unchecked)} account(s) first</button> to see the split before you start.</p>` : ''}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  W3_33 — Distribute Items modal. Targets come from the scope; the modal collects a
//  source environment + a per-target NET amount, previews the packing plan, then serial-
//  sends. Money-gated (ssimConfirm spend + typed-word on large buyer totals). Wire = USD cents.
// ══════════════════════════════════════════════════════════════════════════════
function distToCents(amount) { const a = Number(amount); if (!Number.isFinite(a) || a <= 0) return 0; return Math.round((state.currency === 'EUR' ? a / state.usdToEur : a) * 100); }

// ── Distribute as a Batch JOB (owner 2026-07-09): scope (step 1) = the RECEIVING accounts;
//    step 3 collects the source pool + amount, PREVIEWS the exact plan (who receives what,
//    from which sources — multi-source per target is the default), then runs + polls inline. ──
const BATCH_DIST_JOB = { jobType: 'distribute', label: 'Distribute items', group: 'money', moneySafe: true, enabled: true, experimental: true, synthetic: true };

// ── W4_40 — paysafecard as a SEQUENTIAL Batch job (owner 2026-07-09): scope = accounts to top up,
//    step 3 = amount + Start → SSIM opens account 1's checkout; you pay in the browser, click Next;
//    it opens account 2; and so on. SSIM never handles the PIN (entered on the Steam page) and only
//    marks an account 'credited' when a wallet read-back confirms the balance rose. ──
const BATCH_PAYSAFE_JOB = { jobType: 'paysafe', label: 'Add funds via paysafecard', group: 'money', moneySafe: true, enabled: true, experimental: true, synthetic: true };

function batchPaysafeSection(scopeCount) {
  const p = state.batch.paysafe;
  const s = p.session;
  const running = !!(s && s.running);
  const cur = running && s.results ? s.results[s.index] : null;

  // Per-account progress list (index-aligned to the queue).
  const rows = s && s.queue ? s.queue.map((u, i) => {
    const r = s.results[i];
    const isCur = running && i === s.index;
    const st = r ? r.status : (i > s.index ? 'queued' : 'awaiting');
    const icon = r ? paysafeStatusIcon(r.status) : '<i class="fa-solid fa-clock text-slate-600"></i>';
    return `<div class="flex items-center gap-2 py-1 t12 ${isCur ? 'text-white font-semibold' : 'text-slate-400'}">
      <span class="w-5 text-center t10 font-mono text-slate-600">${i + 1}</span>${icon}
      <span class="font-mono truncate flex-1">${escapeHtml(u)}</span>
      <span class="t10 ${r && r.status === 'credited' ? 'text-emerald-400' : r && r.status === 'error' ? 'text-rose-400' : 'text-slate-500'}">${r ? escapeHtml(r.status) : (i > (s.index) ? 'queued' : '')}</span>
    </div>`;
  }).join('') : '';

  let body;
  if (!s || (!running && !s.finishedAt)) {
    // Amount tiers come from Steam itself (the account's region) — fetched from the first scope account.
    const firstAcct = batchScopeUsernames()[0];
    if (firstAcct) ensurePaysafeTiers(firstAcct, () => { if (state.nav === 'batch') paintBatch(); });
    const t = paysafeTiersOf(firstAcct);
    let amountControl, tiersReady = false;
    if (!firstAcct) {
      amountControl = `<p class="t12 text-slate-500">Pick a scope (step 1) — SSIM then loads Steam's amount options for the region.</p>`;
    } else if (!t || t === 'loading') {
      amountControl = `<p class="t12 text-slate-500"><i class="fa-solid fa-spinner cs2-spin mr-1"></i>Loading Steam's amount options for <b>${escapeHtml(firstAcct)}</b>…</p>`;
    } else if (t.error) {
      amountControl = `<p class="t12 text-rose-400">Couldn't load amounts — ${escapeHtml(t.error)}. <button data-paysafe-tiers-retry="${escapeAttr(firstAcct)}" class="underline text-brand-light">retry</button></p>`;
    } else if (!t.supported) {
      amountControl = `<p class="t12 text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${t.iso ? `paysafecard top-ups need a <b>EUR</b> Steam wallet — <b>${escapeHtml(firstAcct)}</b>'s wallet is ${escapeHtml(t.iso)}. Pick a scope of EUR accounts.` : `SSIM couldn't read <b>${escapeHtml(firstAcct)}</b>'s wallet currency from Steam, so the top-up is refused rather than guessed.`}</p>`;
    } else if (!t.tiers.length) {
      // Steam lists no fixed tiers (custom-amount region / page changed) → free-text entry, in EUR.
      amountControl = `<label class="block t11 text-slate-400 max-w-xs">Amount per account (EUR)<input data-paysafe-free class="${ACC_IN} mt-1" type="number" min="1" max="1000" step="0.01" value="${escapeAttr(String(p.freeAmount ?? ''))}" placeholder="e.g. 5.00"></label>
      <p class="t10 text-slate-500 mt-1">Steam didn't list fixed amounts for this region — enter how much to top up each account. ${escapeHtml(paysafeAmountHint())}.</p>`;
      tiersReady = true;   // Start enabled; the amount is validated on click (matches the Distribute field)
    } else {
      if (!t.tiers.includes(Number(p.tierMinor))) p.tierMinor = t.tiers[0];   // default / repair the selection
      const opts = t.tiers.map((v) => `<option value="${v}" ${Number(p.tierMinor) === v ? 'selected' : ''}>${escapeHtml(fmtPaysafe(v))}</option>`).join('');
      amountControl = `<label class="block t11 text-slate-400 max-w-xs">Amount per account<select data-paysafe-tier class="${ACC_IN} mt-1">${opts}</select></label>`;
      tiersReady = true;
    }
    const canStart = scopeCount > 0 && !p.busy && tiersReady;
    body = `
      <p class="t11 text-slate-500 mb-3">Top up the <b>${fmtCount(scopeCount)}</b> account(s) in your scope. Choose an amount and press Start — the paysafecard page opens for each account in turn. Enter your code, and the balance is confirmed before moving to the next one.</p>
      <p class="t10 text-slate-500 mb-3">Your code is only ever entered on paysafecard's own page. Each top-up is confirmed against the live balance before SSIM continues.</p>
      ${amountControl}
      <div class="mt-3"><button ${canStart ? 'data-paysafe-start' : 'disabled'} class="btn ${canStart ? 'bg-brand text-white' : 'btn-secondary opacity-50 cursor-not-allowed'} btn-sm"><i class="fa-solid fa-play"></i><span>Start</span></button></div>`;
  } else if (running) {
    const done = s.results.filter((r) => r && r.status !== 'awaiting').length;
    const stopping = !!s.stopping;   // a stop was accepted but an in-flight step still owns the run
    body = `
      <div class="rounded-xl border border-slate-800 bg-slate-950/40 p-4 mb-3">
        <p class="t11 text-slate-500">Account <b class="text-slate-300">${s.index + 1}</b> of ${s.total} · top up <b class="text-slate-300">${escapeHtml(fmtPaysafe(s.amountMinor))}</b></p>
        <p class="t16 font-mono font-bold text-white mt-0.5">${escapeHtml(s.queue[s.index] || '')}</p>
        <p class="t12 mt-1 ${cur && cur.status === 'error' ? 'text-rose-400' : 'text-slate-300'}">${cur ? paysafeStatusIcon(cur.status) + ' ' + escapeHtml(cur.detail) : ''}</p>
        <p class="t10 text-brand-light/80 mt-1.5"><i class="fa-solid fa-robot mr-1"></i>Enter your code in the browser — SSIM <b>opens the next account automatically</b> once the balance updates.</p>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <button ${p.busy || stopping ? 'disabled' : 'data-paysafe-stop'} class="btn btn-ghost btn-sm ${p.busy || stopping ? 'opacity-50' : ''}"><i class="fa-solid fa-stop"></i><span>${stopping ? 'Stopping…' : 'Stop'}</span></button>
        <span class="t11 text-slate-500 self-center ml-1">${done}/${s.total} done${stopping ? ' · finishing this account…' : p.busy ? ' · working…' : ''}</span>
      </div>`;
  } else {
    const credited = s.results.filter((r) => r && r.status === 'credited').length;
    const unconfirmed = s.results.filter((r) => r && r.status === 'unconfirmed').length;
    body = `
      <div class="rounded-xl border border-slate-800 bg-slate-950/40 p-4 mb-3 t12">
        <p class="text-slate-300"><b class="text-emerald-400">${credited}</b> credited · <b class="text-amber-400">${unconfirmed}</b> unconfirmed (verify on Steam) · ${s.results.filter((r) => r && r.status === 'skipped').length} skipped · ${s.results.filter((r) => r && r.status === 'error').length} error</p>
      </div>
      <button data-paysafe-reset class="btn btn-secondary btn-sm"><i class="fa-solid fa-rotate-left"></i><span>New run</span></button>`;
  }

  return `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4">
    <h3 class="t14 font-bold text-white mb-3">3 · Run — Add funds via paysafecard</h3>
    ${body}
    ${rows ? `<div class="mt-4 max-h-56 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/30 p-2">${rows}</div>` : ''}
  </section>`;
}

// Background status poll: reflects SERVER-SIDE auto-advances (the wallet-credit poll opens the next
// account without a click). Runs while a paysafe run is active; a manual step pauses it via p.busy.
function pollPaysafeStatus() {
  const p = state.batch.paysafe;
  if (p.timer) clearInterval(p.timer);
  p.timer = setInterval(async () => {
    if (state.nav !== 'batch' || !p.session || !p.session.running) { clearInterval(p.timer); p.timer = null; return; }
    if (p.busy) return;   // a manual advance/stop is mid-flight — don't clobber it with a poll snapshot
    try {
      const s = await api('/api/steam/paysafe/status');
      if (p.busy) return;
      const before = p.session ? JSON.stringify(p.session) : '';
      p.session = s;
      if (JSON.stringify(s) !== before) paintBatch();   // repaint only on a real change (auto-advance / credit)
      if (!s.running) {
        clearInterval(p.timer); p.timer = null;
        const credited = (s.results || []).filter((r) => r && r.status === 'credited').length;
        toast(`paysafecard run done — ${credited}/${s.total} credited`, credited === s.total ? 'success' : 'info', { duration: 10000 });
      }
    } catch { /* transient — keep polling */ }
  }, 2500);
}

// paysafecard is EUR-ONLY (owner 2026-07-10). Every amount on this path is EURO-CENTS — the tier Steam
// printed, the value we POST, and the credit threshold the backend reconciles against. There is no
// conversion anywhere, which is exactly what keeps the wallet read-back honest.
const PAYSAFE_CUR = 3;              // Steam ECurrencyCode for EUR
const PAYSAFE_MIN_MINOR = 100;      // €1.00     — mirrors PAYSAFE_MIN_MINOR in src/store/PaysafeService.ts
const PAYSAFE_MAX_MINOR = 100000;   // €1000.00  — mirrors PAYSAFE_MAX_MINOR (the fat-finger ceiling)
function fmtPaysafe(minor) { return fmtMoneyMinor(minor, PAYSAFE_CUR); }
function paysafeAmountHint() { return `Enter an amount between ${fmtPaysafe(PAYSAFE_MIN_MINOR)} and ${fmtPaysafe(PAYSAFE_MAX_MINOR)}`; }
/** A typed major amount ("5", "5,00", "1.500,00") → euro-cents, or null when it is not a usable amount.
 *  The decimal count comes from the currency table (EUR → 2), never a hardcoded ×100, and the result is
 *  bounds-checked here as well as at the route. */
function paysafeMinorFromMajor(str) {
  const major = Number(normalizeMajor(str));
  if (!Number.isFinite(major) || major <= 0) return null;
  const minor = Math.round(major * Math.pow(10, curInfo(PAYSAFE_CUR).d));
  if (!Number.isSafeInteger(minor) || minor < PAYSAFE_MIN_MINOR || minor > PAYSAFE_MAX_MINOR) return null;
  return minor;
}
/** The account can be topped up: tiers loaded, no error, and Steam says the wallet is EUR. */
function paysafeSupported(t) { return !!(t && t !== 'loading' && !t.error && t.supported); }
function paysafeTiersOf(username) { return username ? state.paysafeTiers[username] : null; }
// Fetch (once) Steam's real top-up amount tiers for this account; re-render when they land.
// ANY cache entry (loading | error | real tiers) stops the auto-fetch — an error must NOT retry on
// every render (that loops: error → re-render → re-fetch). Only the retry button (which deletes the
// entry) re-triggers a fetch.
function ensurePaysafeTiers(username, onDone) {
  if (!username) return;
  const cache = state.paysafeTiers;
  if (cache[username] !== undefined) return;
  cache[username] = 'loading';
  api(`/api/steam/${encodeURIComponent(username)}/paysafe/tiers`)
    .then((r) => { cache[username] = { currency: Number(r && r.currency) || 0, iso: (r && r.iso) || '', tiers: Array.isArray(r && r.tiers) ? r.tiers : [], supported: !!(r && r.supported) }; })
    .catch((e) => { cache[username] = { error: (e && e.message) || 'could not load amounts', currency: 0, iso: '', tiers: [], supported: false }; })
    .finally(() => { if (typeof onDone === 'function') onDone(); });
}

async function batchPaysafeStart() {
  const p = state.batch.paysafe;
  const usernames = batchScopeUsernames();
  if (!usernames.length) { toast('Pick a scope first — the accounts to top up', 'warn'); return; }
  const t = paysafeTiersOf(usernames[0]);
  if (!t || t === 'loading' || t.error) { toast('Steam amount options not loaded yet', 'warn'); return; }
  if (!t.supported) { toast(t.iso ? `paysafecard top-ups need a EUR Steam wallet — ${usernames[0]}'s wallet is ${t.iso}` : `SSIM couldn't read ${usernames[0]}'s wallet currency from Steam`, 'warn'); return; }
  let amountMinor;
  if (t.tiers.length) {                                  // fixed-tier region → dropdown selection
    amountMinor = Number(p.tierMinor);
    if (!t.tiers.includes(amountMinor)) { toast('Pick an amount', 'warn'); return; }
  } else {                                               // custom-amount region → free-text (bounds-checked)
    amountMinor = paysafeMinorFromMajor(p.freeAmount);
    if (amountMinor == null) { toast(paysafeAmountHint(), 'warn'); return; }
  }
  // Show BOTH the per-account amount and what the whole run costs — the operator is authorising N charges.
  const disp = fmtPaysafe(amountMinor);
  const total = fmtPaysafe(amountMinor * usernames.length);
  if (!(await ssimConfirm({ title: 'Add funds via paysafecard', body: `Top up <b>${escapeHtml(disp)}</b> into each of <b>${usernames.length}</b> account(s) — <b>${escapeHtml(total)}</b> in total?<br><br>The paysafecard page opens for each account in turn. Enter your code, and SSIM confirms the balance and moves to the next one automatically.<br><br><span class="t11 text-slate-500">Accounts whose Steam wallet is not in euros are refused before anything is charged.</span>`, confirmLabel: 'Start', confirmIcon: 'fa-play', tone: 'spend' }))) return;
  p.busy = true; paintBatch();
  try {
    p.session = await api('/api/steam/paysafe/batch/start', { method: 'POST', body: JSON.stringify({ usernames, amountMinor }) });
    pollPaysafeStatus();   // watch for server-side auto-advances
  } catch (e) { toast(e.message || 'Could not start', 'error'); }
  p.busy = false; paintBatch();
}


async function batchPaysafeStop() {
  const p = state.batch.paysafe;
  if (!(await ssimConfirm({ title: 'Stop the paysafecard run', body: 'Stop the run? The current account finishes and is confirmed first; the rest are left untouched.', confirmLabel: 'Stop', confirmIcon: 'fa-stop', tone: 'danger' }))) return;
  p.busy = true; paintBatch();
  try { p.session = await api('/api/steam/paysafe/batch/stop', { method: 'POST', body: '{}' }); }
  catch (e) { toast(e.message || 'Stop failed', 'error'); }
  p.busy = false; paintBatch();
  // A stop that lands while a step is in flight is DEFERRED by the backend: it returns `stopping: true` with
  // the run still `running`, and the in-flight step ends it. Keep polling until the server says it's done —
  // killing the timer here (as this used to) freezes the view on "Stopping…" forever.
  if (p.session && p.session.running) pollPaysafeStatus();
  else if (p.timer) { clearInterval(p.timer); p.timer = null; }
}

function batchDistributeSection(scopeCount) {
  const d = state.batch.dist;
  const st = d.status, running = !!(st && st.running);
  const distSources = batchScopeUsernames(d.sel);   // resolved once — the picker reads it too
  const srcCount = distSources.length;
  const anySrc = d.sel.envs.size || d.sel.folders.size || d.sel.accounts.size;
  let planHtml = '';
  if (d.plan) {
    const pl = d.plan;
    planHtml = `<div class="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 t12">
      <p class="text-slate-300">Sends <b>${fmtCentsCompact(pl.totalBuyerCents)}</b> of market value so targets net <b>${fmtCentsCompact(pl.totalNetCents)}</b>, across <b>${pl.tradeCount}</b> offer(s).</p>
      <p class="t10 text-slate-500 mt-1">Amount = what each target receives net of Steam fees (~13%). A target may be filled from SEVERAL source accounts (one offer per source). Skipped: ${pl.skipped.unpriced} unpriced · ${pl.skipped.locked} locked · ${pl.skipped.untradable} untradable${pl.skipped.filtered ? ` · <span class="text-brand-light">${fmtCount(pl.skipped.filtered)} item(s) filtered out by name</span>` : ''}.</p>
      ${distPoolNamesHtml(pl)}
      ${pl.poolExhausted ? '<p class="t10 text-amber-400/80 mt-1">⚠ The pool can\'t fully cover every target — some are under-filled (shortfall shown).</p>' : ''}
      <div class="mt-2 space-y-0.5 max-h-48 overflow-y-auto">${pl.targets.map((t) => `
        <div class="flex justify-between gap-3 py-0.5 border-b border-slate-800/50">
          <span class="font-mono text-slate-300 shrink-0">${escapeHtml(t.target)}</span>
          <span class="t10 text-slate-500 truncate flex-1 text-right" title="${escapeAttr((t.sources || []).join(', '))}">← ${t.itemCount} item(s) from ${(t.sources || []).length ? escapeHtml((t.sources || []).join(' + ')) : '—'}</span>
          <span class="font-mono shrink-0">${fmtCentsCompact(t.netCents)}${t.shortfallCents ? ` <span class="text-amber-400/80">(short ${fmtCentsCompact(t.shortfallCents)})</span>` : ''}</span>
        </div>`).join('')}</div>
    </div>`;
  }
  let progHtml = '';
  if (st && (st.running || st.finishedAt)) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    progHtml = `<div class="mt-4"><div class="flex justify-between t11 mb-1"><span>${running ? 'Distributing…' : 'Done'}</span><span class="font-mono">${st.done}/${st.total} offers · ${st.confirmed || 0} confirmed · ${(st.failed || []).length} failed</span></div>
      <div class="h-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full bg-brand transition-all" style="width:${pct}%"></div></div>
      ${(st.failed || []).length ? `<div class="mt-2 max-h-32 overflow-y-auto t11 text-slate-500 space-y-0.5">${st.failed.slice(0, 30).map((f) => `<div><span class="font-mono text-amber-400/80">${escapeHtml(f.source)} → ${escapeHtml(f.target)}</span> — ${escapeHtml(f.error)}</div>`).join('')}</div>` : ''}
    </div>`;
  }
  const canPreview = scopeCount > 0 && srcCount > 0 && !running;
  const canRun = !!(d.plan && d.plan.tradeCount && !running);
  return `<section class="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 mb-4">
    <h3 class="t14 font-bold text-white mb-1">3 · Run — Distribute items</h3>
    <p class="t11 text-slate-500 mb-3">Your scope is the <b>${fmtCount(scopeCount)} receiving</b> account(s). Choose the source pool below — environments, folders or individual accounts — preview the plan, then run.</p>
    <p class="t10 text-amber-400/70 mb-3">⚠ If a source or target lacks mobile authentication, Steam may hold items in escrow up to 15 days — this can't be detected before sending.</p>
    ${distGameToggle()}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <p class="t11 text-slate-400">Source pool — <b>${fmtCount(srcCount)}</b> account${srcCount === 1 ? '' : 's'} selected</p>
          ${anySrc ? '<button data-dist-clear class="t11 text-slate-500 hover:text-slate-300"><i class="fa-solid fa-xmark mr-1"></i>Clear</button>' : ''}
        </div>
        <div class="relative mb-2"><i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 t11 text-slate-600"></i>
          <input data-dist-search type="text" placeholder="Filter accounts…" value="${escapeAttr(d.sel.search || '')}" class="${ACC_IN}" style="padding-left:2rem"></div>
        <div data-scope-scroll="dist" class="max-h-56 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-2">${batchScopeTree(d.sel, 'dist')}</div>
      </div>
      <div class="space-y-3">
        <label class="block t11 text-slate-400">Net amount per target (${state.currency})<input data-batch-dist="amount" class="${ACC_IN} mt-1" type="number" min="0.01" step="0.01" value="${escapeAttr(String(d.amount ?? ''))}"></label>
        <label class="block t11 text-slate-400">Min item value (${state.currency}, optional)<input data-batch-dist="minItem" class="${ACC_IN} mt-1" type="number" min="0" step="0.01" value="${escapeAttr(String(d.minItem ?? ''))}"></label>
        ${distFilterPicker('include', 'Only these items', 'leave empty to allow every item', distSources, distGame())}
        ${distFilterPicker('exclude', 'Never these items', 'held back no matter what', distSources, distGame())}
        <p class="t10 text-slate-600">The list is built from the source pool you picked, so it only offers items those accounts actually hold. A pick matches anywhere in the item name and ignores case, so <span class="font-mono">Case</span> covers every case. <b>Never</b> wins over <b>Only</b>.</p>
        <p class="t10 text-slate-600">A target can be filled from SEVERAL source accounts — one trade offer per source→target pair. Accounts that are both source and target never send to themselves.</p>
      </div>
    </div>
    <div class="mt-3 flex gap-2">
      <button ${canPreview ? 'data-batch-dist-preview' : 'disabled'} class="btn btn-secondary btn-sm ${canPreview ? '' : 'opacity-50 cursor-not-allowed'}"><i class="fa-solid fa-eye"></i><span>Preview plan</span></button>
      <button ${canRun ? 'data-batch-dist-run' : 'disabled'} class="btn ${canRun ? 'bg-brand text-white' : 'btn-secondary opacity-50 cursor-not-allowed'} btn-sm"><i class="fa-solid fa-play"></i><span>Run</span></button>
      ${running ? '<button data-batch-dist-cancel class="btn btn-secondary btn-sm"><i class="fa-solid fa-stop"></i><span>Cancel</span></button>' : ''}
    </div>${planHtml}${progHtml}
  </section>`;
}

// ── Distribute item filters: a SEARCHABLE PICKER, not a name to remember ─────────────────────────
//  Owner 2026-08-20: "nobody will remember names". The filters used to be free-text boxes, which
//  meant the operator had to know that a Fracture Case is spelled "Fracture Case" and that a
//  Katowice sticker carries its year. The names now come out of the SOURCE POOL itself — the same
//  cached inventories the plan packs from — so the list can only ever offer things that are really
//  there. Typing still works, and a typed value matching nothing can still be added on purpose: the
//  backend matches SUBSTRINGS, so one "Karambit" entry covers every Karambit in the fleet.

/** Distinct item names in the given accounts that a distribute run could actually hand out.
 *  Mirrors planDistribute's pool gate (tradable, unlocked, not listed, priced) so the picker never
 *  offers something the plan would skip anyway. Cache-only, exactly like the plan. */
function distItemCandidates(usernames, game) {
  const byName = new Map();
  for (const u of usernames) {
    const inv = invForGame(u, game);
    if (!inv) continue;
    for (const it of inv.items) {
      if (!it.tradable || it.tradeLockExpiry || it.category === 'listed' || it.price == null) continue;
      const ex = byName.get(it.marketHashName);
      if (ex) { ex.count += it.quantity; ex.bots.add(u); }
      else byName.set(it.marketHashName, { name: it.marketHashName, count: it.quantity, price: it.price, bots: new Set([u]) });
    }
  }
  return [...byName.values()].sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
}

/** PURE: what the open dropdown shows for `query`.
 *
 *  A candidate drops out once an existing pick ALREADY COVERS it. Picks are substring matchers, not
 *  exact names, so after adding "Karambit" every individual Karambit is already handled — offering
 *  them again would invite redundant picks and, worse, suggest they were somehow not covered.
 *  Removing a chip brings them straight back, which is what makes the effect of a filter visible.
 *
 *  A query matching no remaining candidate is offered as a CUSTOM entry rather than dead-ending —
 *  that is the substring reach the free-text boxes had, and losing it would make the picker weaker
 *  than what it replaced. */
function distPickerRows(candidates, query, chosen) {
  const q = String(query || '').trim().toLowerCase();
  const picks = (chosen || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const covered = (name) => picks.some((p) => name.includes(p));
  const rows = (candidates || [])
    .filter((c) => !covered(c.name.toLowerCase()))
    .filter((c) => !q || c.name.toLowerCase().includes(q));
  // Offered whenever the typed text is not already an exact candidate or an existing pick, so an
  // operator can filter on a FAMILY ("Karambit", "Souvenir") that no single item is named after.
  const exact = (candidates || []).some((c) => c.name.toLowerCase() === q);
  const custom = q && !exact && !picks.includes(q) ? String(query).trim() : null;
  return { rows, custom };
}

/** The distinct item names the filters LEFT eligible, straight off the plan. Collapsed by default:
 *  on a real fleet this is hundreds of names, and the operator only opens it to check that a filter
 *  did what they meant — or to copy an exact name back into one. */
function distPoolNamesHtml(pl) {
  const names = Array.isArray(pl.poolNames) ? pl.poolNames : [];
  if (!names.length) return '';
  const d = state.batch.dist;
  const total = names.reduce((s, n) => s + n.count, 0);
  const head = `<button data-dist-pool-toggle class="t10 text-slate-500 hover:text-slate-300 mt-1"><i class="fa-solid fa-chevron-${d.showPool ? 'down' : 'right'} mr-1"></i>${fmtCount(total)} item(s) across ${fmtCount(names.length)} distinct name(s) are eligible</button>`;
  if (!d.showPool) return head;
  const rows = names.slice(0, 300).map((n) => `<div class="flex justify-between gap-3 py-0.5">
      <span class="truncate text-slate-400" title="${escapeAttr(n.name)}">${escapeHtml(n.name)}</span>
      <span class="font-mono text-slate-500 shrink-0">×${fmtCount(n.count)} · ${fmtCentsCompact(n.netCents)}</span>
    </div>`).join('');
  const more = names.length > 300 ? `<div class="t10 text-slate-600 pt-1">…and ${fmtCount(names.length - 300)} more name(s).</div>` : '';
  return `${head}<div class="mt-1 max-h-40 overflow-y-auto t10 rounded-lg border border-slate-800 bg-slate-950/60 p-2">${rows}${more}</div>`;
}



/** Which game a Distribute run moves items from.
 *
 *  Distribute is single-game by construction: one plan carries one appId, because one trade offer
 *  is built for one app/context. It used to read `state.game` — the Inventories tab's toggle, which
 *  setNav HIDES on the Batch screen. So a fleet whose operator was last looking at CS2 could only
 *  ever distribute CS2, with no control anywhere on the page to say otherwise, and the item picker
 *  offered nothing but CS2 names (owner 2026-08-20).
 *
 *  `null` means "whatever the Inventories tab was last on", so nothing changes for someone who never
 *  touches the control; picking either chip pins it for this panel. */
function distGame() { return state.batch.dist.game || state.game; }

/** The CS2/TF2 choice, as the two chips the global filter already uses. */
function distGameToggle() {
  const cur = distGame();
  const chip = (g, label) => `<button data-dist-game="${g}" class="chip" aria-pressed="${cur === g}"><i class="fa-solid ${cur === g ? 'fa-circle-dot' : 'fa-circle'} t10"></i>${label}</button>`;
  return `<div class="flex items-center gap-2 flex-wrap mb-3">
    <span class="t11 text-slate-500">Move items from:</span>${chip('cs2', 'CS2')}${chip('tf2', 'TF2')}
    <span class="t10 text-slate-600">— the source pool, the item filters and the offers all follow this.</span>
  </div>`;
}

/** Switching game resets everything downstream of it: a previewed plan belongs to the old game, and
 *  the picked filters are names out of the OLD game's catalogue — "Fracture Case" against a TF2 pool
 *  matches nothing and would silently plan an empty run. Better to clear them than to carry over
 *  filters that quietly exclude everything. */
function distSetGame(game) {
  const d = state.batch.dist;
  if (distGame() === game) return;
  d.game = game;
  d.plan = null;
  d.include = []; d.exclude = [];
  d.picker = null; d.pickerSearch = '';
  paintBatchKeepScroll();
}

/** One filter field: the picked names as removable chips, a search box, and — while this field is the
 *  open one — the candidate list under it. Two of these are rendered (include + exclude) and only one
 *  can be open at a time, so the dropdown never has to float over the other. */
function distFilterPicker(kind, label, hint, sources, game) {
  const d = state.batch.dist;
  const chosen = d[kind] || [];
  const open = d.picker === kind;
  const chips = chosen.length
    ? `<div class="flex flex-wrap gap-1 mb-1.5">${chosen.map((n) => `
        <span class="chip" style="cursor:default" title="${escapeAttr(n)}">
          <span class="truncate" style="max-width:14rem">${escapeHtml(n)}</span>
          <button data-dist-chip-kind="${kind}" data-dist-chip="${escapeAttr(n)}" title="Remove this filter" class="ml-1 text-slate-500 hover:text-red-400"><i class="fa-solid fa-xmark"></i></button>
        </span>`).join('')}</div>`
    : '';

  let list = '';
  if (open) {
    const { rows, custom } = distPickerRows(distItemCandidates(sources, game), d.pickerSearch, chosen);
    // The free-text escape hatch sits BELOW the real items, never above them: with it on top, typing
    // "karam" and clicking the first row gave you the fuzzy family filter when you meant the knife.
    const customRow = custom
      ? `<button data-dist-pick-kind="${kind}" data-dist-pick="${escapeAttr(custom)}" class="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-800/60 border-t border-slate-800">
           <i class="fa-solid fa-plus t10 text-brand"></i>
           <span class="t11 text-slate-300 truncate">Use “<b>${escapeHtml(custom)}</b>” — matches any item whose name contains it</span></button>`
      : '';
    // The count and value are what make a name meaningful at a glance: "Fracture Case ×412 · €0.28"
    // tells the operator both what they are about to hold back and how much of it there is.
    const itemRows = rows.slice(0, 200).map((c) => `
      <button data-dist-pick-kind="${kind}" data-dist-pick="${escapeAttr(c.name)}" class="w-full flex items-center justify-between gap-3 px-2 py-1.5 text-left hover:bg-slate-800/60">
        <span class="t11 text-slate-300 truncate" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</span>
        <span class="t10 font-mono text-slate-500 shrink-0">×${fmtCount(c.count)} · ${fmtCentsCompact(c.price)}</span>
      </button>`).join('');
    const more = rows.length > 200 ? `<div class="t10 text-slate-600 px-2 py-1">…and ${fmtCount(rows.length - 200)} more — keep typing to narrow it down.</div>` : '';
    // Name the GAME in the empty state. "No sendable items match" is misleading when the real cause
    // is that this game's inventories were never refreshed — which is the normal state for TF2 on a
    // fleet that mostly trades CS2, and looks identical to "you own nothing".
    const g = game === 'tf2' ? 'TF2' : 'CS2';
    const cached = sources.some((u) => invForGame(u, game));
    const why = !sources.length ? 'Pick a source pool first — the list comes from those accounts’ inventories.'
      : !cached ? `No ${g} inventories cached for these accounts. Refresh them on the ${g} tab in Inventories first.`
        : `No sendable ${g} items match.`;
    const empty = !itemRows && !customRow
      ? `<div class="t11 text-slate-600 px-2 py-3 text-center">${escapeHtml(why)}</div>`
      : '';
    list = `<div data-scope-scroll="pick-${kind}" class="mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950">${itemRows}${more}${customRow}${empty}</div>`;
  }

  return `<div class="block t11 text-slate-400">
    <div class="mb-1">${escapeHtml(label)} <span class="text-slate-600">— ${escapeHtml(hint)}</span></div>
    ${chips}
    <div class="relative">
      <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 t11 text-slate-600"></i>
      <input data-dist-pick-search="${kind}" type="text" autocomplete="off" spellcheck="false"
        placeholder="${chosen.length ? 'Add another item…' : 'Search items, or type any word…'}"
        value="${escapeAttr(open ? (d.pickerSearch || '') : '')}" class="${ACC_IN}" style="padding-left:2rem">
      ${open ? '<button data-dist-pick-close class="absolute right-2 top-1/2 -translate-y-1/2 t11 text-slate-500 hover:text-slate-300 px-1" title="Close the list"><i class="fa-solid fa-xmark"></i></button>' : ''}
    </div>
    ${list}
  </div>`;
}


/** Adds one name to a filter. The search box CLEARS but the list stays open — picking several items
 *  in a row is the normal case, and re-opening the dropdown each time would be miserable. */
function distPickerAdd(kind, name) {
  const d = state.batch.dist;
  const list = d[kind] || (d[kind] = []);
  const clean = String(name || '').trim();
  if (clean && !list.some((n) => n.toLowerCase() === clean.toLowerCase())) list.push(clean);
  d.picker = kind;
  d.pickerSearch = '';
  d.plan = null;                 // the previewed plan was built under the OLD filters — never leave it on screen
  repaintBatchKeepingPickerFocus(kind);
}

/** Removes one name from a filter. */
function distPickerRemove(kind, name) {
  const d = state.batch.dist;
  d[kind] = (d[kind] || []).filter((n) => n !== name);
  d.plan = null;                 // same reason as above: the plan no longer reflects the filters
  paintBatchKeepScroll();
}

/** Repaint, then put the caret back in the picker's search box. paintBatch() replaces the whole
 *  body, so without this every keystroke would drop focus after one character. */
function repaintBatchKeepingPickerFocus(kind) {
  paintBatchKeepScroll();
  const box = el.batchBody && el.batchBody.querySelector(`[data-dist-pick-search="${kind}"]`);
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}

async function batchDistPreview() {
  const d = state.batch.dist;
  d.picker = null; d.pickerSearch = '';    // the filters are settled — get the dropdown out of the way
  const targets = batchScopeUsernames();
  if (!targets.length) { toast('Pick a scope first — the accounts that RECEIVE items', 'warn'); return; }
  const sources = batchScopeUsernames(d.sel);
  if (!sources.length) { toast('Pick a source pool — envs, folders or single accounts', 'warn'); return; }
  const cents = distToCents(d.amount);
  if (!cents) { toast('Enter a net amount per target', 'warn'); return; }
  try {
    d.plan = await api('/api/inventory/distribute/preview', { method: 'POST', body: JSON.stringify({
      sources, targets, amountNetCents: cents,
      minItemNetCents: distToCents(d.minItem) || 0, game: distGame(),
      includeNames: d.include, excludeNames: d.exclude,
    }) });
    paintBatch();
  } catch (e) { toast(e.message || 'Preview failed', 'error'); }
}

async function batchDistRun() {
  const d = state.batch.dist; if (!d.plan) return;
  const targets = batchScopeUsernames();
  const sources = batchScopeUsernames(d.sel);
  const gateThreshold = state.currency === 'EUR' ? 20000 * state.usdToEur : 20000;   // ~$200 buyer value
  const gate = d.plan.totalBuyerCents >= gateThreshold;
  if (!(await ssimConfirm({ title: 'Distribute items', body: `Send <b>${fmtCentsCompact(d.plan.totalBuyerCents)}</b> of <b>${distGame() === 'tf2' ? 'TF2' : 'CS2'}</b> market value as <b>${d.plan.tradeCount}</b> trade offer(s) to <b>${targets.length}</b> account(s)?<br><br>This moves <b>real items</b>. Trades run serially (~1–2s each).`, confirmLabel: 'Distribute', confirmIcon: 'fa-paper-plane', tone: 'spend', typedWord: gate ? 'DISTRIBUTE' : null }))) return;
  try {
    // The SAME filters the previewed plan was built from — the run re-plans server-side, so sending
    // anything less here would quietly hand out items the operator had just excluded.
    d.status = await api('/api/inventory/distribute', { method: 'POST', body: JSON.stringify({
      sources, targets, amountNetCents: distToCents(d.amount),
      minItemNetCents: distToCents(d.minItem) || 0, game: distGame(),
      includeNames: d.include, excludeNames: d.exclude,
    }) });
    toast('Distribution started', 'success'); pollBatchDist();
  } catch (e) { toast(e.message || 'Could not start', 'error'); }
  paintBatch();
}

function pollBatchDist() {
  const d = state.batch.dist;
  if (d.timer) clearInterval(d.timer);
  d.timer = setInterval(async () => {
    try {
      const s = await api('/api/inventory/distribute/status');
      d.status = s;
      if (!s.running) {
        clearInterval(d.timer); d.timer = null;
        toast(`Distribution done: ${s.confirmed || 0} confirmed · ${s.sent || 0} sent · ${(s.failed || []).length} failed`, (s.failed || []).length ? 'warn' : 'success');
      }
      if (state.nav === 'batch') paintBatch();
    } catch { /* transient — keep polling */ }
  }, 1500);
}

async function batchDistCancel() {
  try { state.batch.dist.status = await api('/api/inventory/distribute/cancel', { method: 'POST' }); paintBatch(); }
  catch (e) { toast(e.message || 'Cancel failed', 'error'); }
}

// Placeholder body used until each module's own wave lands. Purely cosmetic; no data, no network.
function stubModule(section, bodyId, label) {
  const body = document.getElementById(bodyId);
  if (body && !body.dataset.mounted) {
    body.innerHTML =
      `<div class="empty py-20"><div class="empty-icon"><i class="fa-solid fa-screwdriver-wrench"></i></div>` +
      `<p class="empty-title">${label} — coming in a later wave</p>` +
      `<p class="empty-sub">The navigation backbone is live; this module's content ships in its own section.</p></div>`;
  }
}

function renderMain() {
  if (state.screen !== 'inventory') return;
  renderBreadcrumb();
  // H-FE-001: the cold TF2 fetch failed → show a distinct error+Retry panel, NOT an empty inventory. A failed
  // load must never masquerade as a legitimate empty state (S4/S13 UI-truth class). Cleared on a successful load.
  if (state.game === 'tf2' && !state.tf2Loaded && state.tf2LoadError) { renderTf2LoadError(); return; }
  el.globalFilter.classList.toggle('hidden', state.invMode !== 'global');
  // The worth/wallet curve lives in the env-master + global-master views, for BOTH games
  // (the curve tracks the ACTIVE game's worth — TF2 items are priced against appid 440).
  const showHistory = (state.invMode === 'global' || state.invMode === 'env-master');
  el.historyWrap.classList.toggle('hidden', !showHistory);
  if (showHistory) loadHistory(state.invMode === 'global' ? 'global' : state.activeEnv);
  setStatLabels('Items', 'Trade-Locked');               // default; folder-master overrides
  // Buy is per-account/env — in the cross-environment Global Master it can never resolve a
  // buyer, so the button hides there (owner 2026-07-09). Every other view shows it again.
  el.btnBuyMarket?.classList.toggle('hidden', state.invMode === 'global');
  el.gcCatTabs?.classList.add('hidden');                // category pills only for full-fetched inventories (renderTable re-shows)
  el.facetBar?.classList.add('hidden');                 // TBL-03: facet chips re-shown by renderTable when a table renders
  el.ordersWrap?.classList.add('hidden');               // Active-Orders view re-shown by whichever view owns the tab
  stopOrdersPoll();                                     // a scan poll must not outlive the paint that started it
  if (state.invMode === 'global')     return renderGlobalMaster();
  if (state.invMode === 'env-master') return renderEnvMaster();
  if (state.invMode === 'folder')     return renderFolderMaster();
  if (state.invMode === 'selection')  return renderSelectionMaster();
  return renderAccountView();
}

/** H-FE-001: the TF2 cache failed its first fetch → render a distinct error panel with a Retry button in place of
 *  the (empty) inventory body, so a failed load is never mistaken for a genuinely empty fleet. Retry re-runs the
 *  same /api/inventory-tf2 load; on success loadTf2Inventories clears tf2LoadError and renderMain paints the real view. */
function renderTf2LoadError() {
  // Hide every inventory surface so only the error panel shows (mirrors renderNoAccount's teardown).
  el.itemsWrap?.classList.add('hidden');
  el.emptyState?.classList.add('hidden');
  el.invLoading?.classList.add('hidden');
  el.ordersWrap?.classList.add('hidden');
  el.gcCatTabs?.classList.add('hidden');
  el.facetBar?.classList.add('hidden');
  el.globalFilter?.classList.add('hidden');
  el.historyWrap?.classList.add('hidden');
  el.mainHeader.innerHTML = `
    <div class="h-full flex flex-col items-center justify-center text-center py-16">
      <div class="w-20 h-20 rounded-2xl bg-slate-900 border border-rose-900/60 flex items-center justify-center mb-5">
        <i class="fa-solid fa-triangle-exclamation text-3xl text-rose-400"></i>
      </div>
      <p class="text-slate-200 font-semibold">Couldn't load TF2 inventories</p>
      <p class="text-slate-500 text-sm mt-1 max-w-md">${escapeHtml(state.tf2LoadError || 'The TF2 inventory fetch failed.')}</p>
      <button id="btn-tf2-retry"
        class="mt-5 px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-light text-white text-sm font-bold transition inline-flex items-center gap-2">
        <i class="fa-solid fa-rotate"></i><span>Retry</span></button>
    </div>`;
  const rb = $('btn-tf2-retry');
  if (rb) rb.addEventListener('click', async () => {
    rb.disabled = true; rb.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i><span>Retrying…</span>';
    await loadTf2Inventories();
    renderMain();   // success → clears the panel and paints the real view; failure → re-renders this panel
  });
}

function setStatLabels(itemsLabel, lockedLabel, showLockWarn = false) {
  if (el.statItemsLabel) el.statItemsLabel.textContent = itemsLabel;
  if (el.statLockedLabel) el.statLockedLabel.textContent = lockedLabel;
  // The "not refreshed yet – trade-locked/listed items may be missing" warning belongs
  // ONLY to a single account view that hasn't had a (complete) refresh yet (where Refresh
  // is the actual fix). It must never show on the aggregated Bots/Master cards (where the
  // card is even relabelled to "Bots"), nor once an account holds the complete inventory.
  if (el.statLockedWarn) el.statLockedWarn.classList.toggle('hidden', !showLockWarn);
}

// ════════════════════════════════════════════════════════════════════════════
//  Value history chart (worth + wallet curve, one point per refresh)
// ════════════════════════════════════════════════════════════════════════════

const HISTORY_TTL_MS = 10_000; // short cache so search/sort re-renders don't refetch
const historyCache = new Map(); // seriesId → { ts, points }

/** Fetches (cached) history for a series + the ACTIVE game, and renders the chart. The
 *  cache key + request carry the game so the CS2 and TF2 curves never collide. */
async function loadHistory(seriesId) {
  const game = state.game;
  // F3b: in global-master the curve follows the ENV SELECTION — aggregate the selected envs'
  // series (sorted ids in the cache key so toggling a env refetches). Env-master is unchanged.
  let cacheKey, fetcher;
  if (state.invMode === 'global') {
    const envIds = [...state.globalEnvs].sort();
    if (envIds.length === 0) { renderHistoryChart([]); return; }
    cacheKey = `${game}:agg:${envIds.join(',')}`;
    fetcher = () => api('/api/history/aggregate', { method: 'POST', body: JSON.stringify({ seriesIds: envIds, game }) });
  } else {
    if (!seriesId) { renderHistoryChart([]); return; }
    cacheKey = `${game}:${seriesId}`;
    fetcher = () => api(`/api/history/${encodeURIComponent(seriesId)}?game=${game}`);
  }
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < HISTORY_TTL_MS) { renderHistoryChart(hit.points); return; }
  try {
    const points = await fetcher();
    historyCache.set(cacheKey, { ts: Date.now(), points });
    // Only draw if the user still looks at the same view+selection AND game (async race guard).
    if (state.game === game && cacheKey === currentHistoryKey()) renderHistoryChart(points);
  } catch {
    renderHistoryChart([]);
  }
}

/** The history cache key for the CURRENT view/selection/game — the async race guard in
 *  loadHistory compares against this so a slow fetch for a now-stale selection never draws. */
function currentHistoryKey() {
  const game = state.game;
  if (state.invMode === 'global') {
    const envIds = [...state.globalEnvs].sort();
    return envIds.length ? `${game}:agg:${envIds.join(',')}` : null;
  }
  return state.activeEnv ? `${game}:${state.activeEnv}` : null;
}

/** Invalidate the caches (called when a refresh completes → new point exists). */
function invalidateHistory() { historyCache.clear(); pfSparkCache.clear(); }

/** Monotone cubic (Fritsch–Carlson) → cubic-Bézier path through `coords` ([x,y] pairs, x STRICTLY
 *  ascending — a time series). Every control point's x is placed inside its own [x_i, x_{i+1}]
 *  segment (at x_i + h/3 and x_{i+1} − h/3), so the rendered x(t) is monotonic by construction: the
 *  line can NEVER curl backward or form a cusp. Fritsch–Carlson tangent limiting keeps the curve from
 *  overshooting beyond neighbouring data points (no y bulge past a local max/min), and tangents are
 *  forced to 0 at local extrema / flats. Control-point Ys are still clamped to [yMin,yMax] so the
 *  smoothed line stays inside the plot band (€0 baseline / top pad) — this preserves the area-fill
 *  contract and is a no-op whenever the data already fits the band. Fewer than 3 points → plain
 *  line segments. Shared by the main dashboard chart (renderHistoryChart) and the card sparkline
 *  (pfSparkline); fixing it here fixes both. */
function smoothLinePath(coords, yMin, yMax) {
  const n = coords.length;
  if (n === 0) return '';
  const f = (v) => v.toFixed(1);
  if (n < 3) return coords.map((c, i) => `${i ? 'L' : 'M'}${f(c[0])},${f(c[1])}`).join('');
  const clampY = (v) => Math.max(yMin, Math.min(yMax, v));

  // Secant slopes between consecutive points. x is a strictly-increasing time axis, but guard a
  // duplicate/zero timestamp (h ≤ ε): treat that step as flat rather than dividing by zero.
  const dx = new Array(n - 1), sec = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const h = coords[i + 1][0] - coords[i][0];
    dx[i] = h;
    sec[i] = h > 1e-6 ? (coords[i + 1][1] - coords[i][1]) / h : 0;
  }

  // Tangents m[i] = dy/dx at each point. Endpoints use the one-sided secant; interior points use the
  // average of the two adjacent secants — except at a local extremum or flat (secants of opposite or
  // zero sign), where the tangent is 0 so the curve turns cleanly without overshooting.
  const m = new Array(n);
  m[0] = sec[0];
  m[n - 1] = sec[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = sec[i - 1] * sec[i] <= 0 ? 0 : (sec[i - 1] + sec[i]) / 2;
  }
  // Fritsch–Carlson: rescale each tangent pair so (α,β) stays inside the monotonicity circle r = 3.
  // This is what guarantees the interpolant never overshoots the data on either side of a point.
  for (let i = 0; i < n - 1; i++) {
    if (sec[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / sec[i], b = m[i + 1] / sec[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * sec[i];
      m[i + 1] = t * b * sec[i];
    }
  }

  // Emit one cubic Bézier per segment. Because both control points sit at x_i + h/3 and x_{i+1} − h/3
  // (strictly inside the segment), x(t) is monotonic ⇒ no backward loop / cusp. Y is clamped to band.
  let d = `M${f(coords[0][0])},${f(coords[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const c1x = coords[i][0] + h / 3;
    const c1y = clampY(coords[i][1] + m[i] * h / 3);
    const c2x = coords[i + 1][0] - h / 3;
    const c2y = clampY(coords[i + 1][1] - m[i + 1] * h / 3);
    d += `C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(coords[i + 1][0])},${f(coords[i + 1][1])}`;
  }
  return d;
}

/**
 * Renders a dependency-free dual-line SVG chart: Items worth (brand purple) and
 * Balance (emerald). Each series is scaled to its own min/max so both curves
 * stay readable regardless of magnitude. Values are USD cents, displayed in the
 * selected currency via fmtCents.
 */
function renderHistoryChart(points, chartEl = el.historyChart, legendEl = el.historyLegend) {
  const pts = Array.isArray(points) ? points.filter((p) => p && typeof p.t === 'number') : [];
  const anyPartial = pts.some((p) => p.partial === true);
  if (pts.length < 2) {
    legendEl.innerHTML = '';
    chartEl.innerHTML = `<p class="text-center text-slate-600 text-xs py-6">Not enough data points yet – the curve grows with the next refresh.</p>`;
    return;
  }

  const W = 880, H = 180, PAD_L = 50, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);

  const x = (t) => PAD_L + ((t - t0) / tSpan) * iw;
  // FIX (v1.0.5): BOTH series share ONE money scale (USD cents) so the two lines
  // are directly comparable on a single money Y-axis. Previously each line was
  // scaled to its own min/max, so a small wallet looked as "tall" as a large item
  // worth – visually meaningless. Now they live on the same scale.
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) for (const v of [p.items || 0, p.wallet || 0]) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1) { hi += 1; lo = Math.max(0, lo - 1); }       // flat line → give it air
  const padV = (hi - lo) * 0.08;
  lo = Math.max(0, lo - padV); hi += padV;                      // money never dips below 0
  const y = (v) => PAD_T + ih - (((v || 0) - lo) / (hi - lo)) * ih;

  // Smooth curves (centripetal Catmull-Rom → Bézier), clamped to the plot band so the
  // money line can never dip below the €0 baseline. areaPath closes over the same path.
  const coordsOf = (key) => pts.map((p) => [x(p.t), y(p[key] || 0)]);
  const itemsPath = smoothLinePath(coordsOf('items'), PAD_T, PAD_T + ih);
  const walletPath = smoothLinePath(coordsOf('wallet'), PAD_T, PAD_T + ih);
  const areaPath = `${itemsPath}L${x(t1).toFixed(1)},${PAD_T + ih}L${x(t0).toFixed(1)},${PAD_T + ih}Z`;

  // English-only UI (invariant 8): the time axis reads in en-GB (24h, DD/MM) — never de-DE.
  // de-DE stays ONLY for EUR *money* formatting (ST-02); it must never leak into a chart axis.
  const fmtTime = (t) => {
    const d = new Date(t);
    const sameDay = new Date(t0).toDateString() === new Date(t1).toDateString();
    return sameDay
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const tMid = t0 + tSpan / 2;

  const grid = [0.25, 0.5, 0.75].map((f) =>
    `<line x1="${PAD_L}" y1="${(PAD_T + ih * f).toFixed(1)}" x2="${W - PAD_R}" y2="${(PAD_T + ih * f).toFixed(1)}" class="hist-grid" stroke-width="1"/>`).join('');
  // Shared money Y-axis labels (top = max, bottom = min) – now meaningful: both lines use this scale.
  const yLabels = [0, 0.5, 1].map((f) =>
    `<text x="2" y="${(PAD_T + ih * f + 3).toFixed(1)}" class="hist-ylabel" font-size="9">${fmtCents(hi - f * (hi - lo))}</text>`).join('');

  const last = pts[pts.length - 1];
  const dot = (cx, cy, klass) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" class="hist-dot ${klass}" stroke-width="1.5"/>`;

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto block" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="hist-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color:rgb(var(--brand-rgb)); stop-opacity:.28"/>
          <stop offset="100%" style="stop-color:rgb(var(--brand-rgb)); stop-opacity:0"/>
        </linearGradient>
      </defs>
      ${grid}
      ${yLabels}
      <path d="${areaPath}" fill="url(#hist-fill)"/>
      <path d="${itemsPath}" fill="none" class="hist-line-items" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${walletPath}" fill="none" class="hist-line-wallet" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="${anyPartial ? '4 3' : 'none'}"/>
      ${dot(x(last.t), y(last.items), 'hist-dot-items')}
      ${dot(x(last.t), y(last.wallet), 'hist-dot-wallet')}
      <text x="${PAD_L}" y="${H - 6}" class="hist-axis" font-size="10">${fmtTime(t0)}</text>
      <text x="${W / 2}" y="${H - 6}" class="hist-axis" font-size="10" text-anchor="middle">${fmtTime(tMid)}</text>
      <text x="${W - PAD_R}" y="${H - 6}" class="hist-axis" font-size="10" text-anchor="end">${fmtTime(t1)}</text>
    </svg>`;

  // Masterpiece legend markers = slim bar swatches matching each SVG line's stroke color
  // (items = --brand-rgb, wallet = --success-rgb, same as .hist-line-* in the shell); the
  // "(incomplete)" pricing-honesty marker (S2/S13) + point count are preserved verbatim.
  legendEl.innerHTML = `
    <span class="flex items-center gap-1.5"><span style="width:9px;height:3px;border-radius:2px;background:rgb(var(--brand-rgb));display:inline-block"></span>
      Items worth <b class="font-mono text-brand-light ml-1">${fmtCents(last.items)}</b></span>
    <span class="flex items-center gap-1.5"><span style="width:9px;height:3px;border-radius:2px;background:rgb(var(--success-rgb));display:inline-block"></span>
      Balance <b class="font-mono text-emerald-400 ml-1">${fmtCents(last.wallet)}</b>${last.partial === true ? ` <span class="text-slate-600" title="Some wallet balances are in a currency that cannot be converted to USD — the balance line undercounts the real total.">(incomplete)</span>` : ''}</span>
    <span class="text-slate-600">${pts.length} points</span>`;
}

// ── Folder-Master: aggregated, SELECTABLE inventory of a whole folder ──────────
function findFolderNode(nodes, id) {
  for (const n of nodes) {
    if (n.folder.id === id) return n;
    const found = findFolderNode(n.children, id);
    if (found) return found;
  }
  return null;
}
function collectFolderAccounts(node) {
  return [...node.accounts, ...node.children.flatMap(collectFolderAccounts)];
}

/** Aggregates EVERY asset across accounts (1:1 with the single views — nothing is hidden),
 *  while tracking per-stack sendability so trade/sell can still only pick tradable assets.
 *    quantity = total owned (display)   ·   sendable = tradable & unlocked count (selectable)
 *    owners   = per-account assetIds, SENDABLE only (the trade/sell source list) */
function aggregateWithOwners(usernames) {
  const map = new Map();
  for (const u of usernames) {
    const inv = invFor(u);
    if (!inv) continue;
    for (const it of inv.items) {
      // Key by marketHashName — the SAME key renderTable + selection use downstream (GC/web
      // always set it; a placeholder like "Item #1348" is unique per def_index, so distinct
      // unresolved items never collide).
      let ex = map.get(it.marketHashName);
      if (!ex) { ex = { ...it, quantity: 0, sendable: 0, lockedCount: 0, accounts: new Set(), owners: [] }; map.set(it.marketHashName, ex); }
      ex.quantity += it.quantity;
      ex.accounts.add(u);
      if (it.tradeLockExpiry) ex.lockedCount += it.quantity; // aggregate lock signal → master row badge (display-only)
      if (it.tradable && !it.tradeLockExpiry) {            // sendable → counts toward trade/sell
        ex.sendable += it.quantity;
        ex.owners.push({ username: u, assetIds: it.assetIds.slice() });
      }
    }
  }
  return [...map.values()];
}

/** Sidebar shortcut: open a folder's master straight on its Active Orders tab (and load it). */
function openFolderOrders(folderId) {
  openFolderMaster(folderId);
  showOrdersTab();
}

function openFolderMaster(folderId) {
  state.invMode = 'folder';
  state.activeFolder = folderId;
  state.activeUsername = null;
  state.gcCat = 'all'; // reset the Items/Active-Orders tab when switching folder (never auto-scan on open)
  state.search = ''; state.sort = null; clearSelection();
  el.searchInput.value = '';
  updateSidebar();
  renderMain();
}

function renderFolderMaster() {
  const node = findFolderNode(state.tree.folders, state.activeFolder);
  if (!node) { selectEnvMaster(); return; }
  const usernames = collectFolderAccounts(node).map((a) => a.username);
  const agg = aggregateWithOwners(usernames);
  state.aggItems = agg; state._aggIndex = new Map(agg.map((i) => [i.marketHashName, i]));   // TBL-02: O(1) lookup index
  const totalSendable = agg.reduce((s, i) => s + (i.sendable || 0), 0);

  // Master headers follow the masterpiece pattern (V4): icon-less title + .pill pill--brand scope
  // badge + .btn <variant> btn-sm actions. Every id/handler hook is byte-identical to legacy.
  el.mainHeader.innerHTML = `
    <div class="min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-2xl font-bold text-white truncate">${escapeHtml(node.folder.name)}</h2>
        <span class="pill pill--brand">Folder-Master</span>
      </div>
      <p class="text-sm text-slate-500 mt-1">${usernames.length} account(s) · aggregated 1:1 with the single views</p>
    </div>
    <div class="flex items-center gap-2 flex-wrap justify-end">
      <button id="btn-folder-massbuy" title="Mass Buy: max out a purchase of one item across every account in this folder" class="btn btn-buy btn-sm"><i class="fa-solid fa-cart-arrow-down"></i><span>Mass Buy</span></button>
      <button id="btn-folder-orders" title="Active market orders (sell listings + buy orders) across every account in this folder" class="btn btn-secondary btn-sm"><i class="fa-solid fa-receipt"></i><span>Active Orders</span></button>
      <button id="btn-folder-bans" title="Check every account in this folder for Steam bans" class="btn btn-secondary btn-sm"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-refresh-folder" class="btn btn-secondary btn-sm"><i class="fa-solid fa-rotate"></i><span>Refresh folder</span></button>
    </div>`;
  const rf = $('btn-refresh-folder');
  if (rf) rf.addEventListener('click', () => refreshFolder(usernames));
  const mb = $('btn-folder-massbuy');
  if (mb) mb.addEventListener('click', () => openFolderBuy(node.folder.name, usernames));
  const fb = $('btn-folder-bans');
  if (fb) fb.addEventListener('click', () => openBanChecker(usernames, node.folder.name));
  const fo = $('btn-folder-orders');
  if (fo) fo.addEventListener('click', showOrdersTab);

  el.btnLoad.classList.add('hidden');
  el.statBar.classList.remove('hidden'); el.statBar.classList.add('flex');
  setStatLabels('Sendable items', 'Bots');
  setCountStat(el.statItems, totalSendable);
  setCountStat(el.statLocked, usernames.length);
  const folderValueCents = worthCentsForAccounts(usernames); // one worth source (C19)
  let folderWalletUsd = 0, folderWalletAccts = 0;
  for (const u of usernames) { const wu = walletToUsd(walletOf(u)); if (wu != null) { folderWalletUsd += wu; folderWalletAccts++; } }
  setMoneyStats(folderValueCents, folderWalletAccts ? folderWalletUsd : null);

  // Items / Active Orders tabs — the same pair the single-account view has, so the folder's
  // live market orders are one click from its aggregated inventory.
  if (renderMasterOrdersTab(agg)) return;

  if (agg.length === 0) {
    el.toolbar.classList.add('hidden');
    el.itemsWrap.classList.add('hidden'); el.emptyState.classList.remove('hidden');
    el.emptyState.querySelector('p').textContent = 'No tradable items in cache';
    el.emptyState.querySelector('p:last-child').textContent = 'Click "Refresh folder" to load the bot inventories.';
    return;
  }
  el.toolbar.classList.remove('hidden');
  renderTable(agg, { master: true, selectable: true });
}

// ── Multi-select master (hand-picked accounts via sidebar checkboxes) ─────────────
/** Accounts currently checkbox-picked, in stable allAccounts order (drops any that no
 *  longer exist). This is the scope for the selection master + its Mass Buy/Sell/Trade. */
function selectedUsernames() {
  const set = state.selectedAccounts;
  return state.allAccounts.filter((a) => set.has(a.username)).map((a) => a.username);
}

function renderSelectionMaster() {
  const usernames = selectedUsernames();
  if (usernames.length === 0) { selectEnvMaster(); return; }   // selection emptied → fall back
  const agg = aggregateWithOwners(usernames);
  state.aggItems = agg; state._aggIndex = new Map(agg.map((i) => [i.marketHashName, i]));   // TBL-02: O(1) lookup index
  const totalSendable = agg.reduce((s, i) => s + (i.sendable || 0), 0);

  el.mainHeader.innerHTML = `
    <div class="min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-2xl font-bold text-white truncate">Multi-Select</h2>
        <span class="pill pill--brand">${usernames.length} account(s)</span>
      </div>
      <p class="text-sm text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
        <span>Hand-picked accounts · aggregated 1:1 with the single views</span>
        <span class="text-slate-700">·</span>
        <button id="sel-all" class="text-2xs text-brand hover:text-brand-light font-semibold transition">Select all</button>
        <button id="sel-clear-all" class="text-2xs text-slate-400 hover:text-white font-semibold transition">Clear</button>
      </p>
    </div>
    <div class="flex items-center gap-2 flex-wrap justify-end">
      <button id="btn-sel-massbuy" title="Mass Buy: max out a purchase of one item across every selected account" class="btn btn-buy btn-sm"><i class="fa-solid fa-cart-arrow-down"></i><span>Mass Buy</span></button>
      <button id="btn-sel-orders" title="Active market orders (sell listings + buy orders) across every selected account" class="btn btn-secondary btn-sm"><i class="fa-solid fa-receipt"></i><span>Active Orders</span></button>
      <button id="btn-sel-refresh" class="btn btn-secondary btn-sm"><i class="fa-solid fa-rotate"></i><span>Refresh selected</span></button>
      <button id="btn-sel-move" title="Move every selected account into a folder / environment" class="btn btn-secondary btn-sm"><i class="fa-solid fa-folder-tree"></i><span>Move Selected</span></button>
      <button id="btn-sel-bans" title="Check every selected account for Steam bans" class="btn btn-secondary btn-sm"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-sel-delete" title="Remove every selected account from SSIM (maFiles are kept)" class="btn btn-danger btn-sm"><i class="fa-solid fa-trash-can"></i><span>Delete Selected</span></button>
    </div>`;
  $('btn-sel-refresh')?.addEventListener('click', () => refreshFolder(usernames));
  $('btn-sel-massbuy')?.addEventListener('click', () => openFolderBuy(`${usernames.length} selected account(s)`, usernames));
  $('btn-sel-move')?.addEventListener('click', () => openMoveModal(usernames));
  $('btn-sel-bans')?.addEventListener('click', () => openBanChecker(usernames, `${usernames.length} selected`));
  $('btn-sel-orders')?.addEventListener('click', showOrdersTab);
  $('btn-sel-delete')?.addEventListener('click', () => batchDeleteAccounts(usernames));
  $('sel-all')?.addEventListener('click', selectAllAccounts);
  $('sel-clear-all')?.addEventListener('click', clearSelectionAndRevert);

  el.btnLoad.classList.add('hidden');
  el.statBar.classList.remove('hidden'); el.statBar.classList.add('flex');
  setStatLabels('Sendable items', 'Bots');
  setCountStat(el.statItems, totalSendable);
  setCountStat(el.statLocked, usernames.length);
  const valueCents = worthCentsForAccounts(usernames); // one worth source (C19)
  let walletUsd = 0, walletAccts = 0;
  for (const u of usernames) { const wu = walletToUsd(walletOf(u)); if (wu != null) { walletUsd += wu; walletAccts++; } }
  setMoneyStats(valueCents, walletAccts ? walletUsd : null);

  // Items / Active Orders tabs, exactly as in the folder master.
  if (renderMasterOrdersTab(agg)) return;

  if (agg.length === 0) {
    el.toolbar.classList.add('hidden');
    el.itemsWrap.classList.add('hidden'); el.emptyState.classList.remove('hidden');
    el.emptyState.querySelector('p').textContent = 'No tradable items in cache';
    el.emptyState.querySelector('p:last-child').textContent = 'Click "Refresh selected" to load the bot inventories.';
    return;
  }
  el.toolbar.classList.remove('hidden');
  renderTable(agg, { master: true, selectable: true });
}

/**
 * Shared Items / Active Orders tab bar for the two MULTI-account masters (folder + selection).
 * Returns true when the Active-Orders tab owns the body (the caller then renders nothing else).
 * The item-table surfaces are torn down first so the two tabs can never paint on top of each other.
 */
function renderMasterOrdersTab(agg) {
  renderAccountTabs(agg, state.gcCat === 'orders' ? 'orders' : 'all', { categorized: false });
  if (state.gcCat !== 'orders') { el.ordersWrap?.classList.add('hidden'); return false; }
  hideItemsSurfaces();
  renderOrdersView();
  return true;
}

/** Hides every item-table surface so the Active Orders view is the only thing in the body. */
function hideItemsSurfaces() {
  el.toolbar?.classList.add('hidden');
  el.itemsWrap?.classList.add('hidden');
  el.emptyState?.classList.add('hidden');
  el.facetBar?.classList.add('hidden');
}

/** "Active Orders" header button on a master view: switch to the tab AND load it (an explicit
 *  click is the one place a multi-account live scan may start on its own). */
function showOrdersTab() {
  state.gcCat = 'orders';
  state.orders.autoStart = true;
  state.orders.rows = null;
  renderMain();
}

// ── Account view ───────────────────────────────────────────────────────────────
function renderAccountView() {
  const username = state.activeUsername;
  if (!username) { showPlaceholder('Select an account on the left.'); return; }
  const acc = state.allAccounts.find((a) => a.username === username);
  const inv = invFor(username);

  // Full vs Limited (LTD) tier pill — Login imports as "Limited" only (invariant 9); Attach-maFile
  // is the sole Limited→Full path. Kept as a read-only status pill next to the network pill.
  const tierPill = acc?.tier === 'limited'
    ? '<span class="pill pill--ltd" title="Limited — attach a maFile to upgrade to Full">Limited</span>'
    : '<span class="pill pill--success">Full</span>';
  el.mainHeader.innerHTML = `
    <div class="min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-2xl font-bold text-white truncate">${escapeHtml(acc?.displayName || username)}</h2>
        ${acc?.network?.type === 'proxy'
          ? '<span class="pill pill--proxy"><i class="fa-solid fa-shield-halved"></i>Proxy</span>'
          : '<span class="pill pill--local"><i class="fa-solid fa-network-wired"></i>Local IP</span>'}
        ${tierPill}
      </div>
      <p class="text-sm text-slate-500 mt-1 font-mono truncate">${escapeHtml(username)}</p>
    </div>
    <div class="flex flex-col items-end gap-2">
      <div class="flex items-center gap-2 flex-wrap justify-end">
        ${renderTradeLink(username)}
        <button id="btn-account-bans" title="Check this account for Steam bans" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
        <button id="btn-account-logs" title="View this account's recent activity log" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-clock-rotate-left"></i><span>Logs</span></button>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <button id="btn-tradeups" title="Find profitable trade-up contracts from this account's skins" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-arrow-trend-up text-amber-300"></i><span>Trade-Ups</span></button>
        <button id="btn-caskets" title="Manage this account's storage units (caskets)" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-box-archive text-sky-300"></i><span>Storage</span></button>
        <button id="btn-trade-offers" title="Manage this account's sent &amp; received trade offers" class="btn btn-primary btn-sm">
          <i class="fa-solid fa-right-left"></i><span>Trade Offers</span></button>
        <button id="btn-csfloat" title="Manage this account on CSFloat (listings, market, trades)" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-water text-brand-light"></i><span>CSFloat</span></button>
        <button id="btn-sda" title="Steam Guard code + pending mobile confirmations for this account" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-mobile-screen-button text-emerald-300"></i><span>SDA</span></button>
        <button id="btn-clean-browser" title="Open a browser with this account logged in, routed through its linked proxy" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-window-restore text-violet-300"></i><span>Browser</span>
          <i class="fa-solid fa-circle-info text-2xs text-slate-400 hover:text-slate-200" title="Opens a browser with this account already logged in, through its linked proxy — an isolated, ephemeral session (closing the window discards it)."></i></button>
      </div></div>`;
  bindTradeLink(username);
  const bansBtn = $('btn-account-bans');
  if (bansBtn) bansBtn.addEventListener('click', () => checkAccountBans(username));
  const logsBtn = $('btn-account-logs');
  if (logsBtn) logsBtn.addEventListener('click', () => openAccountLogs(username));
  const offersBtn = $('btn-trade-offers');
  if (offersBtn) offersBtn.addEventListener('click', () => openTradeOffers());
  const tuBtn = $('btn-tradeups');
  if (tuBtn) tuBtn.addEventListener('click', () => openTradeUpModal(username));
  const ckBtn = $('btn-caskets');
  if (ckBtn) ckBtn.addEventListener('click', () => openCasketModal(username));
  const cfBtn = $('btn-csfloat');
  if (cfBtn) cfBtn.addEventListener('click', () => openCsFloat(username));
  const sdaBtn = $('btn-sda');
  if (sdaBtn) sdaBtn.addEventListener('click', () => openSda(username));
  const cbBtn = $('btn-clean-browser');
  if (cbBtn) cbBtn.addEventListener('click', () => openCleanBrowser(cbBtn, username));

  el.btnLoad.classList.remove('hidden');
  el.btnLoad.disabled = false; // reset any leftover loading state from a previous refresh
  el.btnLoad.innerHTML = '<i class="fa-solid fa-rotate"></i><span>Refresh</span>';
  el.statBar.classList.remove('hidden'); el.statBar.classList.add('flex');

  const tf2 = state.game === 'tf2';
  // Show the "not refreshed yet – trade-locked/listed items may be missing" warning ONLY
  // here, and only while this CS2 account doesn't yet hold the complete inventory (a
  // Refresh makes it complete: source becomes 'gc', the full-fetch marker).
  const webMissesLocks = !tf2 && !!inv && inv.source !== 'gc';
  setStatLabels(tf2 ? 'TF2 Items' : 'Items', tf2 ? 'TF2 Keys' : 'Trade-Locked', webMissesLocks);

  // GC-sourced CS2 inventories carry per-item categories → category pills; otherwise
  // a plain "Items" pill. Either way the "Active Orders" tab is always available.
  const categorized = !tf2 && !!inv && inv.source === 'gc';
  let active = state.gcCat || 'all';
  if (!categorized && active !== 'orders') active = 'all'; // no category pills without GC data
  renderAccountTabs(inv ? inv.items : [], active, { categorized });

  // Always reflect the inventory stats (valid in every tab); '—' when nothing cached.
  if (inv) {
    setCountStat(el.statItems, inv.totalItems);
    setCountStat(el.statLocked, tf2 ? countTf2Keys(inv.items) : inv.items.filter((i) => i.tradeLockExpiry).length);
    // Value is shown for BOTH games — TF2 items are priced against the TF2 market (appid 440),
    // so inv.totalValueUsd is the correct worth in whichever game is active. The account IS
    // refreshed here (inv exists), so an empty/no Steam wallet shows 0 — never '—'.
    const wu = walletToUsd(walletOf(username));
    setMoneyStats(inv.totalValueUsd ?? null, wu != null ? wu : 0);
  } else {
    el.statItems.textContent = '—'; el.statLocked.textContent = '—';
    setMoneyStats(null, null);
  }

  // ── Active Orders tab → live sell-listings + buy-orders view ────────────────
  if (active === 'orders') {
    hideItemsSurfaces();
    renderOrdersView();
    return;
  }
  el.ordersWrap?.classList.add('hidden');

  if (inv) {
    el.toolbar.classList.remove('hidden');
    // GC-sourced inventories carry per-item categories → render the strict 3-bucket view.
    // Selectable in BOTH games now — the send path is app-agnostic (carries the item's appid),
    // so TF2 (440) items can be picked + sent just like CS2 (730). (Bug 1.)
    renderTable(inv.items, { selectable: true, categorized });
  } else {
    el.toolbar.classList.add('hidden');
    el.itemsWrap.classList.add('hidden'); el.emptyState.classList.remove('hidden');
    el.emptyState.querySelector('p').textContent = tf2 ? 'No TF2 inventory cached yet' : 'No inventory in cache yet';
    el.emptyState.querySelector('p:last-child').textContent = 'Click "Refresh" to load it live.';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Active Orders view (live sell listings + buy orders, with per-order cancel)
//
//  SCOPES: ONE account (the account view's tab) or MANY — a whole folder's subtree, or a
//  hand-picked multi-selection. The scope is derived from the current view, never stored,
//  so it can't drift from what the user is looking at.
//    · one account  → a single GET (cheap; the tab loads it immediately, as it always did)
//    · many accounts → the DETACHED backend scan (/api/market/orders-scan), polled with a row
//      cursor and painted account-by-account as rows land. Detached because a few hundred
//      login-bound reads run far past the client's 120s request budget (same reason as the
//      ban checker), and cursor-paged so a 1.5s poll never re-sends rows we already have.
//  A multi-account scan is NEVER auto-started by an incidental re-render (ticking another
//  sidebar checkbox re-renders the Selection Master): it starts on an explicit tab click /
//  Refresh only, and a re-render of the SAME scope repaints the rows already in hand.
// ════════════════════════════════════════════════════════════════════════════

/** Which game Active Orders is showing. Defaults to the Inventories tab's game, but can be pinned
 *  here — the buy modal has its OWN game selector, so the order you just placed is not necessarily
 *  in the game this tab happens to be on. */
function ordersGame() { return state.orders.game || state.game; }

/** The CS2/TF2 choice, as the two chips the Distribute panel already uses. */
function ordersGameToggle() {
  const cur = ordersGame();
  const chip = (g, label) => `<button data-orders-game="${g}" class="chip" aria-pressed="${cur === g}"><i class="fa-solid ${cur === g ? 'fa-circle-dot' : 'fa-circle'} t10"></i>${label}</button>`;
  return `<span class="flex items-center gap-1.5">${chip('cs2', 'CS2')}${chip('tf2', 'TF2')}</span>`;
}

/** Switching game asks Steam a DIFFERENT question, so the rows in hand are about the other game and
 *  cannot be re-used: drop them and re-run the scope's fetch/scan. */
function ordersSetGame(game) {
  if (ordersGame() === game) return;
  state.orders.game = game;
  state.orders.key  = '';
  state.orders.rows = null;
  stopOrdersPoll();
  renderOrdersView();
}

/** The account(s) whose orders the tab shows, derived from the CURRENT view. */
function ordersScope() {
  const appId = ordersGame() === 'tf2' ? 440 : 730;
  if (state.invMode === 'folder') {
    const node = findFolderNode(state.tree.folders, state.activeFolder);
    const usernames = node ? collectFolderAccounts(node).map((a) => a.username) : [];
    return { mode: 'folder', usernames, appId, label: node ? node.folder.name : 'Folder' };
  }
  if (state.invMode === 'selection') {
    const usernames = selectedUsernames();
    return { mode: 'selection', usernames, appId, label: `${usernames.length} selected account(s)` };
  }
  const u = state.activeUsername;
  const acc = state.allAccounts.find((a) => a.username === u);
  return { mode: 'account', usernames: u ? [u] : [], appId, label: (acc && acc.displayName) || u || '' };
}

/** Scope identity: same key ⇒ same question, so a re-render repaints the rows already fetched
 *  instead of hitting Steam again. A different key ⇒ the cached rows are about other accounts. */
function ordersScopeKey(sc) { return `${sc.mode}|${sc.appId}|${[...sc.usernames].sort().join(',')}`; }

/** Display name for an owner tag (falls back to the login name). */
function ordersOwnerName(username) {
  const acc = state.allAccounts.find((a) => a.username === username);
  return (acc && acc.displayName) || username;
}

/** Empty row-set: the shape every paint/append works against. */
function emptyOrdersData() {
  // buyUnread: accounts whose buy orders Steam did not report this pass. Kept separate from `errors`
  // because the fetch SUCCEEDED — the answer just did not include buy orders, and an empty list that
  // might be wrong has to say so rather than read as an authoritative zero.
  return { buy: [], sell: [], errors: [], buyUnread: [], partial: false, scanned: 0, total: 0, running: false, cancelled: false };
}

function stopOrdersPoll() { clearTimeout(state.orders.timer); state.orders.timer = null; }

/** Renders the Active Orders tab for the current view's scope. Called by the account /
 *  folder / selection renderers when their "Active Orders" pill is the active tab. */
function renderOrdersView() {
  if (!el.ordersWrap) return;
  const sc = ordersScope();
  const key = ordersScopeKey(sc);
  const auto = state.orders.autoStart;
  state.orders.autoStart = false;
  stopOrdersPoll();
  const token = ++state.orders.run;   // invalidates every in-flight fetch/poll of a previous paint
  el.ordersWrap.classList.remove('hidden');

  if (sc.usernames.length === 0) {
    el.ordersWrap.innerHTML = ordersShellHtml(sc, emptyOrdersData(), 'empty-scope');
    bindOrdersControls();
    return;
  }
  if (sc.mode === 'account') { loadOrdersSingle(sc, token); return; }

  // Multi-account: repaint what we already fetched for THIS scope; otherwise scan (explicit
  // action only) or offer the manual "Load" button so a checkbox tick can't storm the fleet.
  if (state.orders.key === key && state.orders.rows) {
    paintOrders(sc, state.orders.rows);
    // The scan for THIS scope is still running (the repaint was triggered by something else, e.g.
    // a sidebar refresh) — resume polling under the new token, or the view would freeze mid-scan.
    if (state.orders.rows.running) pollOrdersScan(sc, token);
    return;
  }
  state.orders.key = key;
  state.orders.rows = null;
  if (auto) startOrdersScan(sc, token);
  else {
    el.ordersWrap.innerHTML = ordersShellHtml(sc, emptyOrdersData(), 'idle');
    bindOrdersControls();
  }
}

// ── Single account: one live GET (unchanged behaviour) ────────────────────────
async function loadOrdersSingle(sc, token) {
  const username = sc.usernames[0];
  state.orders.key = ordersScopeKey(sc);
  state.orders.rows = null;
  el.ordersWrap.innerHTML = ordersLoadingHtml(`Loading active orders live from Steam…`);
  let res;
  try {
    res = await api(`/api/market/orders/${encodeURIComponent(username)}?appId=${sc.appId}`);
  } catch (err) {
    if (token !== state.orders.run) return;              // the user moved on mid-fetch
    const data = emptyOrdersData();
    data.errors = [{ username, error: err.message }];
    data.total = 1; data.scanned = 1;
    state.orders.rows = data;
    paintOrders(sc, data);
    return;
  }
  if (token !== state.orders.run) return;
  const data = emptyOrdersData();
  data.buy  = (res.buyOrders  || []).map((o) => ({ ...o, username }));
  // An empty Buy Orders list means nothing on its own — the backend tells us whether Steam actually
  // ANSWERED the question this pass. Without this an unread account looks identical to an empty one.
  data.buyUnread = res.buyOrdersRead === false ? [username] : [];
  data.sell = (res.sellOrders || []).map((o) => ({ ...o, username }));
  data.partial = !!res.partial;
  data.total = 1; data.scanned = 1;
  state.orders.rows = data;
  paintOrders(sc, data);
}

// ── Many accounts: start the detached scan, then poll it with a row cursor ─────
async function startOrdersScan(sc, token) {
  const data = emptyOrdersData();
  data.total = sc.usernames.length;
  data.running = true;
  state.orders.key = ordersScopeKey(sc);
  state.orders.rows = data;
  state.orders.cursor = 0;
  paintOrders(sc, data);
  try {
    await api('/api/market/orders-scan', {
      method: 'POST', body: JSON.stringify({ usernames: sc.usernames, appId: sc.appId }),
    });
  } catch (err) {
    if (token !== state.orders.run) return;
    // 409 = another scan is already running (single-flight); say so plainly instead of a dead view.
    if (err.status === 409) toast(err.message || 'An Active Orders scan is already running', 'warn');
    data.running = false;
    data.errors = [{ username: '', error: err.message }];
    paintOrders(sc, data);
    return;
  }
  if (token !== state.orders.run) return;
  resetPoller('orders'); resetPoller('ordersErr');
  pollOrdersScan(sc, token);
}

/** Polls the scan every 1.5s, appending each newly-finished account's rows.
 *  A transient status-fetch error retries (bounded by the shared stall guard) rather than
 *  killing the poll while the backend keeps scanning. */
function pollOrdersScan(sc, token) {
  stopOrdersPoll();
  state.orders.timer = setTimeout(async () => {
    state.orders.timer = null;              // this tick has fired; only a reschedule re-arms it
    if (token !== state.orders.run) return;
    let job;
    try { job = await api(`/api/market/orders-scan-status?since=${state.orders.cursor}`); resetPoller('ordersErr'); }
    catch (err) {
      if (token !== state.orders.run) return;
      if (pollerStalled('ordersErr', 0)) {
        resetPoller('ordersErr');
        const data = state.orders.rows || emptyOrdersData();
        data.running = false;
        data.errors = [...data.errors, { username: '', error: err.message || 'Lost contact with the scan' }];
        paintOrders(sc, data);
        return;
      }
      pollOrdersScan(sc, token); return;
    }
    if (token !== state.orders.run) return;
    const data = state.orders.rows || emptyOrdersData();
    if (Number.isFinite(job.nextIndex)) state.orders.cursor = job.nextIndex;
    appendScanBatch(sc, data, job.accounts || []);
    data.scanned = (job.progress && job.progress.done) || data.scanned;
    data.total = (job.progress && job.progress.total) || data.total;
    data.running = !!job.running;
    data.cancelled = !!job.cancelled;
    updateOrdersProgress(sc, data);

    if (!job.running) {
      resetPoller('orders');
      // A crashed job (not a per-account failure) is surfaced as its own row.
      if (job.error) data.errors = [...data.errors, { username: '', error: job.error }];
      paintOrders(sc, data);
      return;
    }
    if (pollerStalled('orders', data.scanned)) {
      resetPoller('orders');
      data.running = false;
      data.errors = [...data.errors, { username: '', error: 'The scan appears stuck (no progress) — stopping the live updater. Check the server.' }];
      paintOrders(sc, data);
      return;
    }
    pollOrdersScan(sc, token);
  }, 1500);
}

/** Folds one poll batch (whole accounts) into the row-set AND the live DOM — appending only
 *  the new rows, so a 500-bot scan never re-renders thousands of existing ones. */
function appendScanBatch(sc, data, accounts) {
  if (!accounts.length) return;
  const newBuy = [], newSell = [];
  for (const acc of accounts) {
    if (acc.error) { data.errors.push({ username: acc.username, error: acc.error }); continue; }
    if (acc.partial) data.partial = true;
    for (const o of (acc.buyOrders  || [])) newBuy.push({ ...o, username: acc.username });
    if (acc.buyOrdersRead === false && !data.buyUnread.includes(acc.username)) data.buyUnread.push(acc.username);
    for (const o of (acc.sellOrders || [])) newSell.push({ ...o, username: acc.username });
  }
  data.buy.push(...newBuy);
  data.sell.push(...newSell);
  appendOrderRows('orders-buy-list',  newBuy,  buyOrderRow,  sc);
  appendOrderRows('orders-sell-list', newSell, sellOrderRow, sc);
  updateOrdersCounts();
  renderOrdersErrors(data);
  applyOrdersSearch();   // rows landing while a filter is typed must obey that filter
}

function appendOrderRows(listId, rows, rowHtml, sc) {
  const list = $(listId);
  if (!list || !rows.length) return;
  const placeholder = list.querySelector('[data-orders-empty]');
  if (placeholder) placeholder.remove();
  list.insertAdjacentHTML('beforeend', rows.map((o) => rowHtml(o, sc)).join(''));
}

// ── Rendering ────────────────────────────────────────────────────────────────

function ordersLoadingHtml(text) {
  return `<div class="flex items-center justify-center py-16 text-center">
    <i class="fa-solid fa-spinner cs2-spin text-2xl text-brand mr-3"></i>
    <span class="text-slate-300">${escapeHtml(text)}</span></div>`;
}

/** The whole view: toolbar + (multi) progress + error strip + the two order columns.
 *  `phase` is 'idle' (multi scope awaiting an explicit load), 'empty-scope', or '' (rows). */
function ordersShellHtml(sc, data, phase = '') {
  const multi = sc.mode !== 'account';
  const scanning = !!data.running;
  const banner = data.partial
    ? `<div class="mb-3 px-4 py-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation shrink-0"></i><span>Order list may be incomplete (Steam/proxy error during fetch) — refresh to retry.</span></div>`
    : '';
  const section = (title, icon, color, listId, countId, rows, emptyTxt) => `
    <div class="surface overflow-hidden">
      <div class="panel-head">
        <i class="fa-solid ${icon}" style="color:${color}"></i>
        <span class="panel-title">${title} <span id="${countId}" class="font-mono opacity-70 text-slate-500">${rows.length}</span></span>
      </div>
      <div id="${listId}" class="divide-y divide-slate-800/60">${
        rows.length
          ? rows.map((o) => (listId === 'orders-buy-list' ? buyOrderRow(o, sc) : sellOrderRow(o, sc))).join('')
          : `<div data-orders-empty class="px-4 py-8 text-center text-slate-600 text-sm">${escapeHtml(emptyTxt)}</div>`
      }</div>
    </div>`;

  const scopePill = multi
    ? `<span class="pill pill--brand" title="${escapeAttr(sc.usernames.join(', '))}">${escapeHtml(sc.label)}</span>`
    : '';
  // Multi-scope actions: Stop while scanning, Refresh (= rescan) otherwise.
  const loadBtn = phase === 'idle'
    ? `<button id="orders-refresh" class="btn btn-sm btn-primary"><i class="fa-solid fa-bolt"></i><span>Load orders (${sc.usernames.length} account${sc.usernames.length === 1 ? '' : 's'})</span></button>`
    : scanning
      ? `<button id="orders-stop" class="btn btn-sm btn-secondary" style="color:rgb(var(--danger-rgb))"><i class="fa-solid fa-stop"></i><span>Stop scan</span></button>`
      : `<button id="orders-refresh" class="btn btn-sm btn-secondary"><i class="fa-solid fa-rotate"></i><span>Refresh</span></button>`;

  return `
    ${banner}
    <div class="surface mb-4"><div class="panel-head justify-between flex-wrap gap-2">
      <div class="flex items-center gap-2 flex-wrap">
        <i class="fa-solid fa-receipt text-brand"></i>
        <span class="panel-title" style="font-size:var(--fs-13)">Active market orders</span>
        ${ordersGameToggle()}
        ${scopePill}
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <div class="relative"><i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i><input id="orders-search" type="text" placeholder="${escapeAttr(multi ? 'Search item / account…' : 'Search item…')}" class="field pl-8 py-1.5 t12 w-48" /></div>
        <button id="orders-cancel-selected" disabled class="btn btn-sm btn-danger"><i class="fa-solid fa-xmark"></i><span>Cancel selected (<span id="orders-sel-count">0</span>)</span></button>
        <button id="orders-cancel-all" class="btn btn-sm btn-secondary" style="color:rgb(var(--danger-rgb))"><i class="fa-solid fa-trash"></i><span>Cancel all</span></button>
        ${loadBtn}
      </div>
    </div>
    ${multi ? `<div id="orders-progress" class="px-4 py-2 border-t border-slate-800/60 t12 text-slate-400">${ordersProgressHtml(sc, data, phase)}</div>` : ''}
    </div>
    <div id="orders-errors">${ordersUnreadHtml(data)}${ordersErrorsHtml(data)}</div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      ${section('Active Buy Orders', 'fa-cart-arrow-down', 'rgb(var(--success-rgb))', 'orders-buy-list', 'orders-buy-count', data.buy, phase === 'idle' ? 'Not loaded yet.' : ((data.buyUnread || []).length ? 'Steam did not report this account’s buy orders this pass — this list is UNKNOWN, not empty. Try again in a moment.' : 'No active buy orders.'))}
      ${section('Active Sell Orders', 'fa-tag', 'rgb(var(--listed-rgb))', 'orders-sell-list', 'orders-sell-count', data.sell, phase === 'idle' ? 'Not loaded yet.' : 'No active sell orders.')}
    </div>`;
}

/** The multi-scope progress line: honest about how much of the scope has actually been read. */
function ordersProgressHtml(sc, data, phase = '') {
  const n = sc.usernames.length;
  if (phase === 'empty-scope') return 'No accounts in this scope.';
  if (phase === 'idle') {
    return `<i class="fa-solid fa-circle-info mr-1.5 text-slate-500"></i>${n} account(s) in scope — orders are read live from Steam, one session per bot.`;
  }
  const failed = data.errors.filter((e) => e.username).length;
  const head = data.running
    ? `<i class="fa-solid fa-spinner cs2-spin mr-1.5 text-brand"></i>Scanning ${data.scanned} of ${data.total} account(s)…`
    : data.cancelled
      ? `<i class="fa-solid fa-circle-stop mr-1.5 text-amber-400"></i>Scan stopped after ${data.scanned} of ${data.total} account(s)`
      : `<i class="fa-solid fa-circle-check mr-1.5 text-emerald-400"></i>${data.scanned} of ${data.total} account(s) scanned`;
  return `${head} <span class="text-slate-600">·</span> ${data.buy.length} buy <span class="text-slate-600">·</span> ${data.sell.length} sell` +
    (failed ? ` <span class="text-slate-600">·</span> <span class="text-rose-300">${failed} failed</span>` : '');
}

/** Failures are never swallowed: an account we could not read has UNKNOWN orders, which is not
 *  the same as "no orders", so it is named here instead of quietly missing from the columns. */
/** Accounts whose fetch SUCCEEDED but whose buy orders Steam never reported. Amber, not red: this is
 *  not a failure, it is an unanswered question — and it must not read as "no buy orders", which is
 *  what an empty section silently claimed before. */
function ordersUnreadHtml(data) {
  const who = data.buyUnread || [];
  if (!who.length) return '';
  const names = who.slice(0, 8).map((u) => escapeHtml(u)).join(', ') + (who.length > 8 ? ` +${who.length - 8} more` : '');
  return `<div class="mb-4 px-4 py-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10">
    <div class="flex items-center gap-2 text-amber-200 text-xs font-semibold mb-1"><i class="fa-solid fa-circle-question"></i>Buy orders UNKNOWN for ${fmtCount(who.length)} account(s)</div>
    <div class="t11 text-amber-300/80">Steam answered without reporting buy orders for ${names}. Any buy orders they hold are missing from the list below — this is not the same as having none.</div></div>`;
}

function ordersErrorsHtml(data) {
  if (!data.errors.length) return '';
  const accts = data.errors.filter((e) => e.username).length;
  const head = accts
    ? `${accts} account(s) could not be read — their orders are NOT in the list below`
    : 'The Active Orders scan reported an error';
  const rows = data.errors.map((e) =>
    `<div class="flex items-start gap-2 t11"><span class="font-mono text-rose-200 shrink-0">${escapeHtml(e.username || 'scan')}</span><span class="text-rose-300/80 min-w-0">${escapeHtml(e.error)}</span></div>`).join('');
  return `<div class="mb-4 px-4 py-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10">
    <div class="flex items-center gap-2 text-rose-200 text-xs font-semibold mb-1.5"><i class="fa-solid fa-triangle-exclamation"></i>${escapeHtml(head)}</div>
    <div class="space-y-1 max-h-32 overflow-y-auto">${rows}</div></div>`;
}

/** Full (re)paint from a row-set — used on first render, on completion and on a cached re-render. */
function paintOrders(sc, data) {
  el.ordersWrap.innerHTML = ordersShellHtml(sc, data);
  bindOrdersControls();
}
function updateOrdersProgress(sc, data) {
  const p = $('orders-progress');
  if (p) p.innerHTML = ordersProgressHtml(sc, data);
}
function renderOrdersErrors(data) {
  const box = $('orders-errors');
  if (box) box.innerHTML = ordersErrorsHtml(data);
}
function updateOrdersCounts() {
  for (const [listId, countId] of [['orders-buy-list', 'orders-buy-count'], ['orders-sell-list', 'orders-sell-count']]) {
    const list = $(listId), count = $(countId);
    if (!list || !count) continue;
    const n = list.querySelectorAll('.order-row').length;
    count.textContent = String(n);
    if (n === 0 && !list.querySelector('[data-orders-empty]')) {
      list.innerHTML = '<div data-orders-empty class="px-4 py-8 text-center text-slate-600 text-sm">No active orders.</div>';
    }
  }
}

function orderIcon(o) {
  return o.iconUrl
    ? `<img src="${escapeAttr(safeIconUrl(o.iconUrl))}" alt="" loading="lazy" class="w-10 h-8 object-contain shrink-0" onerror="this.style.display='none'" />`
    : '<div class="w-10 h-8 shrink-0"></div>';
}
function cancelBtn() {
  // .order-cancel hook preserved (the delegated click handler + bulk cancel depend on it); inner is
  // '<i fa-xmark/><span>Cancel</span>' — MUST match the restore string in bulkCancelOrders' busy().
  return `<button title="Cancel this order on the Steam market" class="order-cancel btn btn-sm btn-secondary shrink-0" style="color:rgb(var(--danger-rgb))"><i class="fa-solid fa-xmark"></i><span>Cancel</span></button>`;
}
function orderCheck() {
  return '<input type="checkbox" class="order-check accent-violet-500 w-4 h-4 shrink-0" />';
}
/** Owner tag — shown only in a multi-account scope, where "which bot?" is the whole point. */
function orderOwnerTag(o, sc) {
  if (sc.mode === 'account') return '';
  return `<span class="pill pill--neutral shrink-0" title="${escapeAttr(o.username)}"><i class="fa-solid fa-user text-3xs"></i>${escapeHtml(ordersOwnerName(o.username))}</span>`;
}
/** Common row attrs: the cancel path reads kind + id + OWNER off the row, which is what makes a
 *  cross-account bulk cancel possible (each row carries the account it belongs to). */
function orderRowAttrs(o, kind, id, sc) {
  const search = [o.name || '', sc.mode === 'account' ? '' : o.username, sc.mode === 'account' ? '' : ordersOwnerName(o.username)]
    .join(' ').toLowerCase();
  return `class="order-row flex items-center gap-3 px-4 py-2.5" data-order-kind="${kind}" data-order-id="${escapeAttr(id)}"` +
    ` data-order-user="${escapeAttr(o.username || '')}" data-order-name="${escapeAttr(search)}"`;
}
function buyOrderRow(o, sc) {
  const qtyTxt = o.quantity && o.quantity !== o.quantityRemaining
    ? `${o.quantityRemaining} / ${o.quantity}` : `${o.quantityRemaining || o.quantity || 0}`;
  return `<div ${orderRowAttrs(o, 'buy', o.buyOrderId, sc)}>
    ${orderCheck()}
    ${orderIcon(o)}
    <div class="min-w-0 flex-1"><p class="t13 text-slate-200 truncate font-semibold" title="${escapeAttr(o.name)}">${escapeHtml(o.name)}</p>
      <p class="t10 text-slate-500 font-mono flex items-center gap-1.5 flex-wrap">${orderOwnerTag(o, sc)}<span>#${escapeHtml(o.buyOrderId)}</span></p></div>
    <div class="text-right shrink-0 mr-1"><p class="t13 font-mono text-slate-200">${fmtMoneyMinor(o.pricePerItemMinor, o.currency)}</p>
      <p class="t10 text-slate-500">qty ${escapeHtml(qtyTxt)}</p></div>
    ${cancelBtn()}</div>`;
}
function sellOrderRow(o, sc) {
  return `<div ${orderRowAttrs(o, 'sell', o.listingId, sc)}>
    ${orderCheck()}
    ${orderIcon(o)}
    <div class="min-w-0 flex-1"><p class="t13 text-slate-200 truncate font-semibold" title="${escapeAttr(o.name)}">${escapeHtml(o.name)}</p>
      <p class="t10 text-slate-500 font-mono flex items-center gap-1.5 flex-wrap">${orderOwnerTag(o, sc)}<span>#${escapeHtml(o.listingId)}</span></p></div>
    <div class="text-right shrink-0 mr-1"><p class="t13 font-mono text-slate-200">${fmtMoneyMinor(o.pricePerItemMinor, o.currency)}</p>
      <p class="t10 text-slate-500">qty ${o.quantity || 1}</p></div>
    ${cancelBtn()}</div>`;
}

// ── Controls ─────────────────────────────────────────────────────────────────

/** Wires the toolbar + DELEGATED row handlers. Delegation is load-bearing for the scan: rows are
 *  appended batch-by-batch as accounts land, and a delegated listener covers them without rebinding. */
function bindOrdersControls() {
  const refresh = $('orders-refresh');
  if (refresh) refresh.addEventListener('click', () => { state.orders.autoStart = true; state.orders.rows = null; renderOrdersView(); });
  const stop = $('orders-stop');
  if (stop) stop.addEventListener('click', () => stopOrdersScan(stop));

  el.ordersWrap.onclick = (e) => {
    const btn = e.target.closest('.order-cancel');
    if (btn) { cancelSingleOrder(btn); return; }
  };
  el.ordersWrap.onchange = (e) => {
    if (e.target.closest('.order-check')) updateOrdersSelCount();
  };

  const search = $('orders-search');
  if (search) search.addEventListener('input', applyOrdersSearch);

  // Cancel selected / Cancel all (all = the currently-VISIBLE set, so you can search "AK-47"
  // then Cancel all to clear just those — across every account in scope).
  const selBtn = $('orders-cancel-selected');
  if (selBtn) selBtn.addEventListener('click', () => bulkCancelOrders(checkedOrderRows()));
  const allBtn = $('orders-cancel-all');
  if (allBtn) allBtn.addEventListener('click', () => bulkCancelOrders(visibleOrderRows()));

  applyOrdersSearch();
  updateOrdersSelCount();
}

/** Filters rows by item name (and, in a multi-account scope, by account); hidden rows are
 *  also unchecked so they can never be swept up by "Cancel selected". */
function applyOrdersSearch() {
  const search = $('orders-search');
  const q = search ? search.value.trim().toLowerCase() : '';
  el.ordersWrap.querySelectorAll('.order-row').forEach((row) => {
    const match = !q || (row.dataset.orderName || '').includes(q);
    row.style.display = match ? '' : 'none';
    if (!match) { const cb = row.querySelector('.order-check'); if (cb) cb.checked = false; }
  });
  updateOrdersSelCount();
}

async function stopOrdersScan(btn) {
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i><span>Stopping…</span>';
  try { await api('/api/market/orders-scan-cancel', { method: 'POST' }); toast('Scan stopping — accounts already read are kept', 'info'); }
  catch (err) { toast(`Could not stop the scan: ${err.message}`, 'error'); btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-stop"></i><span>Stop scan</span>'; }
}

function checkedOrderRows() {
  return [...el.ordersWrap.querySelectorAll('.order-row')]
    .filter((r) => r.style.display !== 'none' && r.querySelector('.order-check')?.checked);
}
function visibleOrderRows() {
  return [...el.ordersWrap.querySelectorAll('.order-row')]
    .filter((r) => r.style.display !== 'none' && r.dataset.orderId);
}
function updateOrdersSelCount() {
  const n = checkedOrderRows().length;
  const c = $('orders-sel-count'); if (c) c.textContent = String(n);
  const b = $('orders-cancel-selected'); if (b) b.disabled = n === 0;
}

/** How many cancels ride in ONE request. Bounded so a fleet-wide cancel can't exceed the client's
 *  120s budget (the backend paces each account's writes), and so rows clear progressively. */
const ORDERS_CANCEL_CHUNK = 20;

/** Cancels a set of rows that may span MANY accounts, in paced chunks through the batch endpoint
 *  (each row carries its own owner, so one sweep can clear a whole folder's orders). */
async function bulkCancelOrders(rows) {
  const targets = rows.filter((r) => r.dataset.orderId && r.dataset.orderUser);
  if (!targets.length) { toast('No orders to cancel', 'warn'); return; }
  const owners = new Set(targets.map((r) => r.dataset.orderUser));
  if (!(await ssimConfirm({
    title: 'Cancel orders', tone: 'danger', confirmLabel: `Cancel ${targets.length} order(s)`, confirmIcon: 'fa-xmark',
    body: `Cancel <b class="text-slate-100">${targets.length}</b> order(s) on the Steam market` +
      (owners.size > 1 ? ` across <b class="text-slate-100">${owners.size}</b> account(s)` : '') + '?',
  }))) return;

  const busy = (row, on) => {
    const btn = row.querySelector('.order-cancel');
    if (!btn) return;
    btn.disabled = on;
    btn.innerHTML = on ? '<i class="fa-solid fa-spinner cs2-spin"></i>' : '<i class="fa-solid fa-xmark"></i><span>Cancel</span>';
  };
  for (const row of targets) busy(row, true);

  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i += ORDERS_CANCEL_CHUNK) {
    const chunk = targets.slice(i, i + ORDERS_CANCEL_CHUNK);
    const items = chunk.map((r) => ({ username: r.dataset.orderUser, kind: r.dataset.orderKind, id: r.dataset.orderId }));
    let res;
    try {
      res = await api('/api/market/cancel-orders', { method: 'POST', body: JSON.stringify({ items }) });
    } catch (err) {
      fail += chunk.length;
      for (const row of chunk) busy(row, false);
      toast(`Cancel failed: ${err.message}`, 'error');
      continue;   // a failed chunk must not abort the rest of the sweep
    }
    // Match results back to their rows by (owner, kind, id) — the identity a row is keyed on.
    const byKey = new Map((res.results || []).map((r) => [`${r.username.toLowerCase()}|${r.kind}|${r.id}`, r]));
    for (const row of chunk) {
      const r = byKey.get(`${row.dataset.orderUser.toLowerCase()}|${row.dataset.orderKind}|${row.dataset.orderId}`);
      if (r && r.ok) { ok++; dropOrderRow(row); }
      else { fail++; busy(row, false); }
    }
  }
  toast(`Cancelled ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'success');
  updateOrdersSelCount();
}

/** Per-row Cancel button (its own confirm), routed through that row's OWN account. */
async function cancelSingleOrder(btn) {
  const row = btn.closest('.order-row');
  if (!row) return;
  const { orderKind: kind, orderId: id, orderUser: username } = row.dataset;
  if (!id || !username) return;
  if (!(await ssimConfirm({
    title: 'Cancel order', tone: 'danger', confirmLabel: 'Cancel order', confirmIcon: 'fa-xmark',
    body: `Cancel this order on the Steam market (<span class="font-mono text-slate-100">${escapeHtml(ordersOwnerName(username))}</span>)?`,
  }))) return;
  const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>';
  const endpoint = kind === 'buy' ? '/api/market/cancel-buy-order' : '/api/market/cancel-listing';
  const idBody = kind === 'buy' ? { buyOrderId: id } : { listingId: id };
  try {
    await api(endpoint, { method: 'POST', body: JSON.stringify({ username, ...idBody }) });
    toast('Order cancelled', 'success');
    dropOrderRow(row);
  } catch (err) {
    toast(`Cancel failed: ${err.message}`, 'error');
    btn.disabled = false; btn.innerHTML = old;
  }
}

/** Removes a cancelled order's row from the DOM *and* from the cached row-set, so a re-render
 *  (e.g. ticking another account) can't resurrect an order that no longer exists. */
function dropOrderRow(row) {
  const { orderKind: kind, orderId: id, orderUser: username } = row.dataset;
  const data = state.orders.rows;
  if (data) {
    const list = kind === 'buy' ? data.buy : data.sell;
    const idx = list.findIndex((o) => (kind === 'buy' ? o.buyOrderId : o.listingId) === id && o.username === username);
    if (idx >= 0) list.splice(idx, 1);
  }
  row.remove();
  updateOrdersCounts();
  updateOrdersSelCount();
}

// ════════════════════════════════════════════════════════════════════════════
//  Global Trade-Offers manager (sent + received, two-sided, batch actions)
// ════════════════════════════════════════════════════════════════════════════

let offersUsernames = [];                 // the account(s) whose offers the modal shows
let offersData = { sent: [], received: [] }; // flattened, owner-tagged offers (the modal's source of truth)
let offersError = '';                      // load-failure message to show in empty panes

/** Opens the manager for the CURRENTLY-SELECTED account only (per-account feature). */
async function openTradeOffers() {
  const username = state.activeUsername;
  if (!username) { toast('Select an account first', 'warn'); return; }
  const acc = state.allAccounts.find((a) => a.username === username);
  if (el.offersScope) el.offersScope.textContent = acc?.displayName || username;
  if (el.offersSearch) el.offersSearch.value = '';
  el.offersOverlay.classList.remove('hidden');   // → FB-04 onModalOpen
  await loadOffers([username]);
}
function closeTradeOffers() { el.offersOverlay.classList.add('hidden'); }

/** Fetches sent + received offers across `usernames`, flattens + sorts, renders both sides. */
async function loadOffers(usernames) {
  offersUsernames = usernames;
  const loading = `<div class="flex items-center justify-center py-16 text-center"><i class="fa-solid fa-spinner cs2-spin text-2xl text-brand mr-3"></i><span class="text-slate-300">Loading offers live from Steam…</span></div>`;
  el.offersSentList.innerHTML = loading;
  el.offersRecvList.innerHTML = loading;
  el.offersSentCount.textContent = ''; el.offersRecvCount.textContent = '';
  resetSelAll();

  let data;
  try {
    data = await api('/api/trade/offers', { method: 'POST', body: JSON.stringify({ usernames }) });
  } catch (err) {
    const errHtml = `<div class="px-4 py-10 text-center text-rose-300"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${escapeHtml(err.message)}</div>`;
    el.offersSentList.innerHTML = errHtml; el.offersRecvList.innerHTML = errHtml;
    return;
  }
  if (el.offersOverlay.classList.contains('hidden')) return;   // closed mid-fetch

  const sent = [], received = [];
  for (const acc of (data.accounts || [])) {
    for (const o of (acc.sent || []))     { o.username = acc.username; sent.push(o); }
    for (const o of (acc.received || [])) { o.username = acc.username; received.push(o); }
  }
  // Active offers first, then newest-first by last update.
  const byNewest = (a, b) =>
    (Number(!a.active) - Number(!b.active)) ||
    ((Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0));
  sent.sort(byNewest); received.sort(byNewest);
  offersData = { sent, received };

  // Surface load failures (e.g. the bot is offline / Steam has no API access) right in
  // the panes rather than leaving misleading empty states.
  const errs = (data.accounts || []).filter((a) => a.error);
  offersError = errs.length ? errs.map((a) => `${a.username}: ${a.error}`).join(' · ') : '';
  renderOffers();
  if (errs.length) toast(errs.length === 1 ? errs[0].error : `${errs.length} account(s) could not be loaded`, 'warn');
}

function resetSelAll() {
  for (const cb of [el.offersSentSelAll, el.offersRecvSelAll]) {
    if (cb) { cb.checked = false; cb.indeterminate = false; }
  }
}

// ── ETradeOfferState → status badge ────────────────────────────────────────────
// State badge → masterpiece .pill variant class (consumed as `pill ${cls}` in offersRowHtml).
function offerStateBadge(o) {
  if (o.active) {
    if (o.state === 11) return { label: 'In escrow',     cls: 'pill--warn' };
    if (o.state === 9)  return { label: 'Needs confirm',  cls: 'pill--warn' };
    return { label: 'Active', cls: 'pill--listed' };
  }
  if (o.state === 3)               return { label: 'Accepted', cls: 'pill--success' };
  if (o.state === 7)               return { label: 'Declined', cls: 'pill--danger' };
  if (o.state === 6 || o.state === 10) return { label: 'Cancelled', cls: 'pill--neutral' };
  if (o.state === 5)               return { label: 'Expired',  cls: 'pill--neutral' };
  if (o.state === 4)               return { label: 'Countered',cls: 'pill--neutral' };
  return { label: o.stateName || 'History', cls: 'pill--neutral' };
}

/** Coloured headline value: sent shows −value of items GIVEN (red), received shows
 *  +value of items RECEIVED (green). Empty when that side has no priced items. */
function offerHeadlineValue(o, side) {
  const cents = side === 'sent' ? o.valueGiveCents : o.valueReceiveCents;
  if (cents == null) return '';
  const sign = side === 'sent' ? '−' : '+';
  const cls = side === 'sent' ? 'text-rose-400' : 'text-emerald-400';
  return `<span class="font-mono font-bold ${cls}">${sign}${escapeHtml(fmtCents(cents))}</span>`;
}

/** One side's items: a count pill + up to a handful of real icons (bare items, whose
 *  descriptions Steam didn't return, are skipped rather than drawn as empty boxes). */
function offerSideThumbs(items, tint) {
  if (!items || !items.length) return '<span class="text-2xs text-slate-600 italic">nothing</span>';
  const total = items.length;
  const withIcon = items.filter((i) => i.iconUrl);
  const MAX = 5;
  const shown = withIcon.slice(0, MAX);
  const thumbs = shown.map((it) =>
    `<img src="${escapeAttr(safeIconUrl(it.iconUrl))}" title="${escapeAttr(it.name)}" loading="lazy" class="w-7 h-7 object-contain rounded bg-slate-950/60 border ${tint} shrink-0" onerror="this.style.visibility='hidden'">`).join('');
  const more = total - shown.length;
  const countPill = `<span class="text-2xs font-mono font-bold text-slate-200 px-1.5 py-0.5 rounded bg-slate-800 shrink-0" title="${total} item${total === 1 ? '' : 's'}">${total}</span>`;
  return `<div class="flex items-center gap-1">${countPill}${thumbs}${more > 0 ? `<span class="text-2xs text-slate-500 shrink-0">+${more}</span>` : ''}</div>`;
}

/** "To <partner>" (sent) / "From <partner>" (received) — persona name when resolved,
 *  else the raw SteamID64. Links to the partner's Steam profile. */
function offerPartnerLabel(o, side) {
  const who = side === 'sent' ? 'To' : 'From';
  const name = o.partnerName || o.partnerSteamId || 'Unknown';
  const showId = o.partnerName && o.partnerSteamId; // show id as a subtle suffix only when we have a real name
  return `<span class="flex items-center gap-1.5 min-w-0">
    <i class="fa-solid ${side === 'sent' ? 'fa-paper-plane text-rose-400/70' : 'fa-inbox text-emerald-400/70'} text-2xs shrink-0"></i>
    <span class="text-2xs text-slate-500 shrink-0">${who}</span>
    <a href="https://steamcommunity.com/profiles/${escapeAttr(o.partnerSteamId)}" target="_blank" rel="noopener" class="text-xs font-semibold text-slate-100 hover:text-brand-light truncate max-w-[11rem]" title="${escapeAttr(o.partnerSteamId)}">${escapeHtml(name)}</a>
    ${showId ? `<span class="text-2xs font-mono text-slate-600 truncate hidden sm:inline">${escapeHtml(o.partnerSteamId)}</span>` : ''}
  </span>`;
}

function offerRowActions(side) {
  // .offer-act + data-offer-action hooks preserved (onSingleOfferAction wiring); DS buttons.
  if (side === 'sent') {
    return `<button data-offer-action="cancel" class="offer-act btn btn-sm btn-secondary" style="color:rgb(var(--danger-rgb))"><i class="fa-solid fa-xmark"></i>Cancel</button>`;
  }
  return `<div class="flex gap-1.5">
    <button data-offer-action="accept" class="offer-act btn btn-sm bg-emerald-600 text-white"><i class="fa-solid fa-check"></i>Accept</button>
    <button data-offer-action="decline" class="offer-act btn btn-sm btn-secondary" style="color:rgb(var(--danger-rgb))"><i class="fa-solid fa-xmark"></i>Decline</button>
  </div>`;
}

function offersRowHtml(o, side) {
  const badge = offerStateBadge(o);
  const searchText = [o.partnerSteamId, o.partnerName || '',
    ...o.itemsToGive.map((i) => i.name), ...o.itemsToReceive.map((i) => i.name)].join(' ').toLowerCase();
  const when = o.updatedAt || o.createdAt;
  const whenTxt = when ? new Date(when).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const headline = offerHeadlineValue(o, side);
  const check = o.active
    ? `<input type="checkbox" class="offer-check accent-violet-500 w-4 h-4 shrink-0 mt-1" />`
    : '<span class="w-4 shrink-0"></span>';
  return `<div class="offer-row flex gap-3 px-4 py-3 hover:bg-slate-800/30 transition" data-username="${escapeAttr(o.username)}" data-offer-id="${escapeAttr(o.offerId)}" data-active="${o.active ? '1' : '0'}" data-search="${escapeAttr(searchText)}">
    ${check}
    <div class="min-w-0 flex-1 space-y-2">
      <div class="flex items-center gap-2 flex-wrap">
        ${offerPartnerLabel(o, side)}
        <span class="pill ${badge.cls}">${escapeHtml(badge.label)}</span>
        ${whenTxt ? `<span class="text-2xs text-slate-600 ml-auto whitespace-nowrap">${escapeHtml(whenTxt)}</span>` : ''}
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        ${offerSideThumbs(o.itemsToGive, 'border-rose-500/30')}
        <i class="fa-solid fa-arrow-right-long text-slate-600 text-xs shrink-0"></i>
        ${offerSideThumbs(o.itemsToReceive, 'border-emerald-500/30')}
      </div>
      ${o.message ? `<div class="text-2xs text-slate-500 italic truncate" title="${escapeAttr(o.message)}">&ldquo;${escapeHtml(o.message)}&rdquo;</div>` : ''}
    </div>
    <div class="shrink-0 flex flex-col items-end justify-between gap-2">
      <div class="text-sm whitespace-nowrap">${headline || '<span class="text-2xs text-slate-600">—</span>'}</div>
      ${o.active ? offerRowActions(side) : ''}
    </div>
  </div>`;
}

function emptyOffers(side) {
  if (offersError) {
    return `<div class="px-4 py-12 text-center text-rose-300 text-sm"><i class="fa-solid fa-triangle-exclamation text-2xl mb-2 block opacity-60"></i>${escapeHtml(offersError)}</div>`;
  }
  return `<div class="px-4 py-12 text-center text-slate-600 text-sm"><i class="fa-solid ${side === 'sent' ? 'fa-paper-plane' : 'fa-inbox'} text-2xl mb-2 block opacity-40"></i>No ${side} offers.</div>`;
}

function renderOffers() {
  const fill = (list, side, listEl, countEl) => {
    const active = list.filter((o) => o.active).length;
    countEl.textContent = `${active} active · ${list.length} total`;
    listEl.innerHTML = list.length ? list.map((o) => offersRowHtml(o, side)).join('') : emptyOffers(side);
  };
  fill(offersData.sent, 'sent', el.offersSentList, el.offersSentCount);
  fill(offersData.received, 'received', el.offersRecvList, el.offersRecvCount);
  bindOfferRowEvents();
  applyOffersSearch();
}

function bindOfferRowEvents() {
  el.offersOverlay.querySelectorAll('.offer-act').forEach((b) => b.addEventListener('click', onSingleOfferAction));
  el.offersOverlay.querySelectorAll('.offer-check').forEach((cb) => cb.addEventListener('change', updateOffersSelCounts));
}

const OFFER_VERB = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' };
const OFFER_LABEL = { accept: 'Accept', decline: 'Decline', cancel: 'Cancel' };

async function onSingleOfferAction(e) {
  const btn = e.currentTarget;
  const row = btn.closest('.offer-row');
  if (!row) return;
  const action = btn.dataset.offerAction;
  const { username, offerId } = row.dataset;
  const tone = action === 'accept' ? 'spend' : 'danger';
  if (!(await ssimConfirm({
    title: `${OFFER_LABEL[action]} offer`, tone, confirmLabel: `${OFFER_LABEL[action]} offer`,
    confirmIcon: action === 'accept' ? 'fa-check' : 'fa-xmark',
    body: `${OFFER_LABEL[action]} trade offer <span class="font-mono text-slate-100">#${escapeHtml(offerId)}</span>?`,
  }))) return;
  setRowBusy(row, true);
  try {
    const res = await api('/api/trade/offer-action', { method: 'POST', body: JSON.stringify({ username, offerId, action }) });
    // 'unconfirmed' = the accept committed on Steam but its 2FA confirmation failed; the offer is
    // done (remove the row) yet awaits a manual mobile confirmation — not a plain success.
    if (res && res.status === 'unconfirmed') toast('Offer accepted — awaiting mobile confirmation', 'warn');
    else toast(`Offer ${OFFER_VERB[action]}`, 'success');
    removeOfferRow(row);
  } catch (err) {
    toast(`${OFFER_LABEL[action]} failed: ${err.message}`, 'error');
    setRowBusy(row, false);
  }
}

/** Batch accept/decline/cancel a set of rows. The backend caps concurrency at 2. */
async function batchOffers(rows, action) {
  if (!rows.length) { toast('No offers selected', 'warn'); return; }
  const tone = action === 'accept' ? 'spend' : 'danger';
  if (!(await ssimConfirm({
    title: `${OFFER_LABEL[action]} ${rows.length} offer(s)`, tone,
    confirmLabel: `${OFFER_LABEL[action]} ${rows.length}`, confirmIcon: action === 'accept' ? 'fa-check' : 'fa-xmark',
    body: `${OFFER_LABEL[action]} <b class="text-slate-100">${rows.length}</b> trade offer(s)?`,
  }))) return;

  const items = rows.map((r) => ({ username: r.dataset.username, offerId: r.dataset.offerId, action }));
  rows.forEach((r) => setRowBusy(r, true));
  let data;
  try {
    data = await api('/api/trade/offers-batch', { method: 'POST', body: JSON.stringify({ items }) });
  } catch (err) {
    toast(`Batch failed: ${err.message}`, 'error');
    rows.forEach((r) => setRowBusy(r, false));
    return;
  }
  const byKey = new Map((data.results || []).map((r) => [`${String(r.username).toLowerCase()}|${r.offerId}`, r]));
  // 'unconfirmed' rows COMMITTED on Steam (ok:true) but their 2FA confirmation failed — they are
  // no longer actionable (a re-run hits an already-accepted offer), so remove them like a success
  // and surface the awaiting-mobile-confirmation count separately rather than as a failure.
  let unconfirmed = 0;
  for (const r of rows) {
    const res = byKey.get(`${r.dataset.username.toLowerCase()}|${r.dataset.offerId}`);
    if (res && res.ok) { if (res.status === 'unconfirmed') unconfirmed++; removeOfferRow(r); }
    else setRowBusy(r, false);
  }
  const parts = [`${data.ok} ok`];
  if (unconfirmed) parts.push(`${unconfirmed} await mobile confirmation`);
  if (data.fail)   parts.push(`${data.fail} failed`);
  toast(`${OFFER_LABEL[action]}: ${parts.join(', ')}`, data.fail ? 'warn' : (unconfirmed ? 'warn' : 'success'));
  updateOffersSelCounts();
}

function setRowBusy(row, busy) {
  row.style.opacity = busy ? '0.5' : '';
  row.style.pointerEvents = busy ? 'none' : '';
  row.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
}

/** Removes a row from the DOM AND from offersData, refreshing counts + empty state. */
function removeOfferRow(row) {
  const inSent = !!row.closest('#offers-sent-list');
  const arr = inSent ? offersData.sent : offersData.received;
  const idx = arr.findIndex((o) => o.username === row.dataset.username && o.offerId === row.dataset.offerId);
  if (idx >= 0) arr.splice(idx, 1);
  const listEl = inSent ? el.offersSentList : el.offersRecvList;
  const countEl = inSent ? el.offersSentCount : el.offersRecvCount;
  row.remove();
  const active = arr.filter((o) => o.active).length;
  countEl.textContent = `${active} active · ${arr.length} total`;
  if (!arr.length) listEl.innerHTML = emptyOffers(inSent ? 'sent' : 'received');
  updateOffersSelCounts();
}

// ── multi-select helpers ────────────────────────────────────────────────────────
function offerRowsIn(listEl) { return [...listEl.querySelectorAll('.offer-row')]; }
function visibleActiveOfferRows(listEl) {
  return offerRowsIn(listEl).filter((r) => r.style.display !== 'none' && r.dataset.active === '1');
}
function checkedOfferRows(listEl) {
  return visibleActiveOfferRows(listEl).filter((r) => r.querySelector('.offer-check')?.checked);
}
function toggleOffersSelAll(listEl, checked) {
  visibleActiveOfferRows(listEl).forEach((r) => { const cb = r.querySelector('.offer-check'); if (cb) cb.checked = checked; });
  updateOffersSelCounts();
}
function syncOffersSelAll(listEl, selAllEl) {
  if (!selAllEl) return;
  const active = visibleActiveOfferRows(listEl);
  const checked = active.filter((r) => r.querySelector('.offer-check')?.checked);
  selAllEl.checked = active.length > 0 && checked.length === active.length;
  selAllEl.indeterminate = checked.length > 0 && checked.length < active.length;
}
function updateOffersSelCounts() {
  const s = checkedOfferRows(el.offersSentList).length;
  const r = checkedOfferRows(el.offersRecvList).length;
  if (el.offersSentSelCount) el.offersSentSelCount.textContent = String(s);
  if (el.offersRecvSelCount) el.offersRecvSelCount.textContent = String(r);
  if (el.offersSentCancelSel)  el.offersSentCancelSel.disabled = s === 0;
  if (el.offersRecvAcceptSel)  el.offersRecvAcceptSel.disabled = r === 0;
  if (el.offersRecvDeclineSel) el.offersRecvDeclineSel.disabled = r === 0;
  syncOffersSelAll(el.offersSentList, el.offersSentSelAll);
  syncOffersSelAll(el.offersRecvList, el.offersRecvSelAll);
}

/** Filters BOTH sides by partner SteamID / bot name / item names; unchecks hidden rows. */
function applyOffersSearch() {
  const q = (el.offersSearch?.value || '').trim().toLowerCase();
  el.offersOverlay.querySelectorAll('.offer-row').forEach((r) => {
    const match = !q || (r.dataset.search || '').includes(q);
    r.style.display = match ? '' : 'none';
    if (!match) { const cb = r.querySelector('.offer-check'); if (cb) cb.checked = false; }
  });
  updateOffersSelCounts();
}

/** One-time wiring of the static modal controls (close / refresh / search / batch). */
function bindOffersControls() {
  if (el.offersClose)   el.offersClose.addEventListener('click', closeTradeOffers);
  if (el.offersRefresh) el.offersRefresh.addEventListener('click', () => { if (offersUsernames.length) loadOffers(offersUsernames); });
  if (el.offersSearch)  el.offersSearch.addEventListener('input', applyOffersSearch);
  if (el.offersSentSelAll) el.offersSentSelAll.addEventListener('change', () => toggleOffersSelAll(el.offersSentList, el.offersSentSelAll.checked));
  if (el.offersRecvSelAll) el.offersRecvSelAll.addEventListener('change', () => toggleOffersSelAll(el.offersRecvList, el.offersRecvSelAll.checked));
  if (el.offersSentCancelSel)  el.offersSentCancelSel.addEventListener('click',  () => batchOffers(checkedOfferRows(el.offersSentList), 'cancel'));
  if (el.offersSentCancelAll)  el.offersSentCancelAll.addEventListener('click',  () => batchOffers(visibleActiveOfferRows(el.offersSentList), 'cancel'));
  if (el.offersRecvAcceptSel)  el.offersRecvAcceptSel.addEventListener('click',  () => batchOffers(checkedOfferRows(el.offersRecvList), 'accept'));
  if (el.offersRecvDeclineSel) el.offersRecvDeclineSel.addEventListener('click', () => batchOffers(checkedOfferRows(el.offersRecvList), 'decline'));
  if (el.offersRecvAcceptAll)  el.offersRecvAcceptAll.addEventListener('click',  () => batchOffers(visibleActiveOfferRows(el.offersRecvList), 'accept'));
  if (el.offersRecvDeclineAll) el.offersRecvDeclineAll.addEventListener('click', () => batchOffers(visibleActiveOfferRows(el.offersRecvList), 'decline'));
}

// ── Aggregated views (env-master + global-master) ──────────────────────────────
function aggregate(usernames) {
  const map = new Map();
  let totalItems = 0, lockedStacks = 0, loaded = 0, valueCents = 0, walletUsd = 0, walletAccounts = 0;
  for (const u of usernames) {
    const inv = invFor(u);
    if (!inv) continue;
    loaded++;
    valueCents += inv.totalValueUsd || 0;
    const wu = walletToUsd(walletOf(u));   // global wallet (game-independent)
    if (wu != null) { walletUsd += wu; walletAccounts++; }
    for (const it of inv.items) {
      totalItems += it.quantity;
      // Count locked ITEMS (quantity), not stacks — every surface (dashboard, portfolios,
      // env tiles, stat bar) now reads the same number for the same fleet.
      if (it.tradeLockExpiry) lockedStacks += it.quantity || 1;
      const ex = map.get(it.marketHashName);
      if (ex) { ex.quantity += it.quantity; ex.accounts.add(u); if (it.tradeLockExpiry) ex.lockedCount += it.quantity; }
      else map.set(it.marketHashName, { ...it, accounts: new Set([u]), lockedCount: it.tradeLockExpiry ? it.quantity : 0 });
    }
  }
  return { items: [...map.values()], totalItems, lockedStacks, accountCount: loaded, valueCents, walletUsd, walletAccounts };
}

function renderAggregate(usernames, headerHtml, opts = {}) {
  el.mainHeader.innerHTML = headerHtml;
  el.btnLoad.classList.add('hidden');
  el.statBar.classList.remove('hidden'); el.statBar.classList.add('flex');
  const agg = aggregate(usernames);

  const tf2 = state.game === 'tf2';
  setStatLabels(tf2 ? 'TF2 Items' : 'Items', tf2 ? 'TF2 Keys' : 'Trade-Locked');
  setCountStat(el.statItems, agg.totalItems);
  setCountStat(el.statLocked, tf2 ? countTf2Keys(agg.items) : agg.lockedStacks);
  // Worth is summed for BOTH games (aggregate() reads totalValueUsd of whichever game's cache
  // invFor() returns — TF2 items are priced against appid 440), so TF2 is no longer ignored.
  setMoneyStats(agg.accountCount ? agg.valueCents : null, agg.walletAccounts ? agg.walletUsd : null);

  if (agg.items.length === 0) {
    el.toolbar.classList.add('hidden');
    el.itemsWrap.classList.add('hidden'); el.emptyState.classList.remove('hidden');
    el.emptyState.querySelector('p').textContent = agg.accountCount === 0
      ? (tf2 ? 'No TF2 inventories cached' : 'No inventories in cache') : 'No items';
    el.emptyState.querySelector('p:last-child').textContent = 'Click "Refresh all" to load inventories.';
    return;
  }
  el.toolbar.classList.remove('hidden');
  if (opts.selectable) {
    // Selectable master (env + Global): re-aggregate WITH per-owner assetIds so mass sell / send
    // selected can fan out across every owning account — same machinery as the folder master.
    const own = aggregateWithOwners(usernames);
    state.aggItems = own;
    state._aggIndex = new Map(own.map((i) => [i.marketHashName, i]));   // TBL-02: O(1) lookup index
    renderTable(own, { master: true, selectable: true });
  } else {
    renderTable(agg.items, { master: true });
  }
}

function renderEnvMaster() {
  const env = state.environments.find((e) => e.id === state.activeEnv);
  const usernames = envAccounts().map((a) => a.username);
  // SELECTABLE since 1.5.1 (owner): the environment master is the natural place to move stock out
  // of a whole environment, so it aggregates WITH per-owner assetIds and shares the folder master's
  // selection bar — Send selected / Sell selected fan out across every owning account.
  renderAggregate(usernames, `
    <div class="min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-2xl font-bold text-white truncate">${escapeHtml(env?.name || 'Environment')}</h2>
        <span class="pill pill--brand">Portfolio</span>
      </div>
      <p class="text-sm text-slate-500 mt-1">${usernames.length} account(s) in this environment · select items to send or mass-sell</p>
    </div>
    <div class="flex items-center gap-2 flex-wrap justify-end">
      <button id="btn-env-bans" title="Check every account in this environment for Steam bans" class="btn btn-secondary btn-sm"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
    </div>`, { selectable: true });
  const eb = $('btn-env-bans');
  if (eb) eb.addEventListener('click', () => openBanChecker(usernames, env?.name || 'Environment'));
}

function renderGlobalMaster() {
  renderGlobalFilter();
  const usernames = state.allAccounts.filter((a) => state.globalEnvs.has(a.environmentId)).map((a) => a.username);
  // Selectable across ALL environments (owner 2026-07-09): selection → mass sell on market /
  // send selected (internal or external) exactly like the folder master, fleet-wide.
  renderAggregate(usernames, `
    <div class="min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-2xl font-bold text-white truncate">Global Master</h2>
        <span class="pill pill--brand">Cross-environment</span>
      </div>
      <p class="text-sm text-slate-500 mt-1">${state.globalEnvs.size} of ${state.environments.length} environments aggregated · select items to mass-sell or send</p>
    </div>
    <div class="flex items-center gap-2 flex-wrap justify-end">
      <button id="btn-global-bans" title="Check every aggregated account for Steam bans" class="btn btn-secondary btn-sm"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-refresh-global" class="btn btn-secondary btn-sm"><i class="fa-solid fa-rotate"></i><span>Refresh all</span></button>
    </div>`, { selectable: true });
  const b = $('btn-refresh-global');
  if (b) b.addEventListener('click', refreshAll);
  const gb = $('btn-global-bans');
  if (gb) gb.addEventListener('click', () => openBanChecker(usernames, `Global · ${state.globalEnvs.size} environment(s)`));
}

function renderGlobalFilter() {
  // Aggregate-environments toggles → masterpiece .chip aria-pressed control inside a .surface strip.
  // data-genv hook preserved verbatim; renderMain still owns #global-filter show/hide.
  el.globalFilter.innerHTML = `
    <div class="surface p-3 flex items-center gap-2 flex-wrap">
      <span class="t11 text-slate-500 mr-1">Aggregate:</span>${state.environments.map((e) => {
      const on = state.globalEnvs.has(e.id);
      const count = state.allAccounts.filter((a) => a.environmentId === e.id).length;
      return `<button data-genv="${escapeAttr(e.id)}" class="chip" aria-pressed="${on}"><i class="fa-solid ${on ? 'fa-square-check' : 'fa-square'}"></i>${escapeHtml(e.name)} <span class="font-mono opacity-70">${count}</span></button>`;
    }).join('')}</div>`;
  el.globalFilter.querySelectorAll('[data-genv]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.genv;
    if (state.globalEnvs.has(id)) state.globalEnvs.delete(id); else state.globalEnvs.add(id);
    renderMain();
  }));
}

function showPlaceholder(msg) {
  el.statBar.classList.add('hidden'); el.toolbar.classList.add('hidden');
  el.itemsWrap.classList.add('hidden'); el.emptyState.classList.remove('hidden');
  el.emptyState.querySelector('p').textContent = 'No account selected';
  el.mainHeader.innerHTML = `<div><h2 class="text-2xl font-bold text-white">No account selected</h2><p class="text-sm text-slate-500 mt-1">${escapeHtml(msg || '')}</p></div>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Feature 2 – Trade link
// ════════════════════════════════════════════════════════════════════════════

function renderTradeLink(username) {
  const url = state.tradeUrls[username];
  if (!url) {
    return `<button data-tl-fetch="${escapeAttr(username)}" class="btn btn-secondary btn-sm">
      <i class="fa-solid fa-link"></i><span>Get trade link</span></button>`;
  }
  return `
    <div class="inline-flex items-center gap-2 align-middle">
      <code class="text-2xs text-slate-400 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 max-w-[280px] truncate" title="${escapeAttr(url)}">${escapeHtml(url)}</code>
      <button data-tl-copy="${escapeAttr(username)}" title="Copy trade link" class="btn btn-secondary btn-sm"><i class="fa-solid fa-copy"></i><span>Copy</span></button>
    </div>`;
}
function bindTradeLink(username) {
  const f = el.mainHeader.querySelector('[data-tl-fetch]');
  if (f) f.addEventListener('click', () => fetchTradeLink(username, f));
  const c = el.mainHeader.querySelector('[data-tl-copy]');
  if (c) c.addEventListener('click', () => copyTradeLink(username));
}
async function fetchTradeLink(username, btn) {
  setButtonLoading(btn, true, 'Loading…');
  try {
    const { tradeUrl, manual } = await api(`/api/accounts/${encodeURIComponent(username)}/trade-url`);
    state.tradeUrls[username] = tradeUrl;
    await copyToClipboard(tradeUrl);
    toast(`Trade link fetched & copied${manual ? ' (manual)' : ''}`, 'success');
    renderMain();
  } catch (err) {
    toast(`Trade link failed: ${err.message}`, 'error');
    setButtonLoading(btn, false, 'Get trade link', 'fa-link');
  }
}
async function copyTradeLink(username) {
  const url = state.tradeUrls[username];
  if (!url) return;
  await copyToClipboard(url);
  toast('Trade link copied', 'success');
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* noop */ }
    document.body.removeChild(ta);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Item table + selection (Feature 4)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Renders the single-account tab bar. For a GC inventory these are the category
 * pills (All / Owned Items / Trade-Locked / Listed on Market) with per-bucket
 * counts; for a web/TF2 inventory it collapses to one "Items" pill. In ALL cases
 * a separate "Active Orders" tab is appended – the entry point to the live
 * sell-listings / buy-orders view. Clicking a pill sets the active tab + re-renders.
 */
function renderAccountTabs(items, active, opts = {}) {
  if (!el.gcCatTabs) return;
  const categorized = !!opts.categorized;
  const pills = [];
  if (categorized) {
    // The fallback is 'untradable', NOT 'tradable': an item whose category we don't know is not something
    // to advertise as freely tradable. (It also stops an unknown key from making a count NaN.)
    const counts = { all: 0, tradable: 0, tradelocked: 0, untradable: 0, listed: 0 };
    for (const i of items || []) {
      const q = i.quantity || 1; counts.all += q;
      const k = itemStatusKey(i);
      if (counts[k] === undefined) counts.untradable += q; else counts[k] += q;  // unknown key ⇒ never NaN
    }
    pills.push(
      { key: 'all',         label: 'All',              count: counts.all,         icon: 'fa-layer-group', variant: '' },
      { key: 'tradable',    label: 'Owned Items',      count: counts.tradable,     icon: 'fa-box',         variant: 'chip--success' },
      { key: 'tradelocked', label: 'Trade-Locked',     count: counts.tradelocked,  icon: 'fa-lock',        variant: 'chip--warn' },
      { key: 'untradable',  label: 'Not Tradable',     count: counts.untradable,   icon: 'fa-ban',         variant: '' },
      { key: 'listed',      label: 'Listed on Market', count: counts.listed,       icon: 'fa-tag',         variant: 'chip--listed' },
    );
  } else {
    pills.push({ key: 'all', label: 'Items', count: null, icon: '', variant: '' });
  }
  const ordersOn = active === 'orders';
  el.gcCatTabs.classList.remove('hidden');
  el.gcCatTabs.innerHTML =
    pills.map((t) => {
      const on = t.key === active;
      const cnt = t.count != null ? `<span class="font-mono opacity-70">${t.count}</span>` : '';
      const ic = t.icon ? `<i class="fa-solid ${t.icon}"></i>` : '';
      return `<button data-cat="${t.key}" class="chip ${t.variant}" aria-pressed="${on}">${ic}${t.label}${cnt}</button>`;
    }).join('')
    + '<span class="mx-1 w-px self-stretch bg-slate-700/70" aria-hidden="true"></span>'
    + `<button data-cat="orders" title="Active market orders (sell listings + buy orders)" class="chip chip--buy" aria-pressed="${ordersOn}"><i class="fa-solid fa-receipt"></i>Active Orders</button>`;
  el.gcCatTabs.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    state.gcCat = b.dataset.cat;
    // Clicking the pill is the EXPLICIT ask that lets a multi-account scope go live to Steam
    // (a re-render alone never may — see state.orders.autoStart).
    if (b.dataset.cat === 'orders') { state.orders.autoStart = true; state.orders.rows = null; }
    renderMain();
  }));
}

// ── TBL-02: windowed rendering for the FLAT item list (the ~10k Global Master case) ──
// Renders ONLY the visible rows (+ buffer) between two spacer <tr>s, recomputed on scroll.
// Cuts the 10k-stack view from ~140k DOM nodes / ~0.8s to a few hundred nodes / ~ms. The
// categorized single-account view (bounded) stays full-render. Selection is DATA-driven
// (state._tableRows) so select-all covers rows not currently in the DOM.
const WIN = { onScroll: null, container: null };
function scrollSection() { return document.querySelector('#screen-inventory section.overflow-y-auto'); }
function unmountWindow() {
  if (WIN.container && WIN.onScroll) WIN.container.removeEventListener('scroll', WIN.onScroll);
  WIN.onScroll = null; WIN.container = null; state._win = null;
}
function mountWindowedRows(items, ctx, cols) {
  unmountWindow();
  const container = scrollSection();
  if (!container) { el.itemsBody.innerHTML = items.map((i) => renderItemRow(i, ctx)).join(''); return; }
  const BUFFER = 10;
  const w = { items, ctx, cols, rowH: 52, first: -1, last: -1, measured: false };
  state._win = w;
  function paint() {
    if (el.itemsWrap.classList.contains('hidden')) return;
    const n = items.length;
    const crect = container.getBoundingClientRect();
    const top = el.itemsBody.getBoundingClientRect().top - crect.top + container.scrollTop; // tbody offset within content (scroll-invariant)
    const viewTop = Math.max(0, container.scrollTop - top);
    let first = Math.max(0, Math.floor(viewTop / w.rowH) - BUFFER);
    let last = Math.min(n, Math.ceil((viewTop + container.clientHeight) / w.rowH) + BUFFER);
    if (first === w.first && last === w.last) return;
    w.first = first; w.last = last;
    const topPad = first * w.rowH, botPad = (n - last) * w.rowH;
    let html = topPad > 0 ? `<tr aria-hidden="true"><td colspan="${cols}" style="height:${topPad}px;padding:0;border:0"></td></tr>` : '';
    for (let i = first; i < last; i++) html += renderItemRow(items[i], ctx);
    html += botPad > 0 ? `<tr aria-hidden="true"><td colspan="${cols}" style="height:${botPad}px;padding:0;border:0"></td></tr>` : '';
    el.itemsBody.innerHTML = html;
    if (!w.measured) {                              // correct the estimated row height from a real row
      const tr = [...el.itemsBody.children].find((r) => !r.getAttribute('aria-hidden'));
      w.measured = true;
      if (tr && tr.offsetHeight > 10 && Math.abs(tr.offsetHeight - w.rowH) > 2) { w.rowH = tr.offsetHeight; w.first = w.last = -1; paint(); }
    }
  }
  w.paint = paint;
  WIN.onScroll = () => paint(); WIN.container = container;
  container.addEventListener('scroll', WIN.onScroll, { passive: true });
  paint();
}

/** PERF-01: module-level row renderer (was a closure inside renderTable) so a single
 *  selection toggle can re-render JUST its <tr> instead of the whole table. ctx carries
 *  the per-render flags { master, selectable, showLockBadge }. */
function renderItemRow(item, ctx) {
  const { master, selectable, showLockBadge } = ctx;
  const keyOf = (it) => (master ? it.marketHashName : it.assetId);
  const color = itemColor(item);
  // Leading .rar accent bar (CS2 rarity item-data color, exempt from the brand palette) + the
  // real icon-with-lock + rarity-colored name. The bar stretches the row via align-self:stretch.
  // (The backend name already carries any "StatTrak™" prefix, so it is not re-added here.)
  const nameCell = `
      <td>
        <div class="flex items-center gap-2.5">
          <span class="rar" style="background:${color}" aria-hidden="true"></span>
          ${iconWithLock(item, 'item-icon w-12 h-9 object-contain', showLockBadge)}
          <span class="font-semibold" style="color:${color}">${escapeHtml(item.name)}</span>${master ? masterLockBadge(item) : ''}</div></td>`;

  // Selection cell: account view checks per-stack tradability. A MASTER row is shown 1:1
  // (incl. non-sendable items) but only its SENDABLE portion (item.sendable) is selectable.
  const maxSel = master ? (item.sendable || 0) : item.quantity;
  let checkCell = '', sel, checked = false;
  if (selectable) {
    const key = keyOf(item);
    sel = state.selection[key];
    checked = sel != null;
    const canSelect = master ? (maxSel > 0) : (item.tradable && !item.tradeLockExpiry);
    checkCell = `<td class="w-8">
        ${canSelect
          ? `<input type="checkbox" class="sel-check accent-violet-500 w-4 h-4 cursor-pointer align-middle" data-sel="${escapeAttr(key)}" ${checked ? 'checked' : ''} />`
          : `<span title="not tradable / trade-locked" class="text-slate-700"><i class="fa-solid fa-lock text-3xs"></i></span>`}</td>`;
  }
  const qtyCell = (selectable && checked && maxSel > 1)
    ? `<td><input type="number" class="sel-qty w-16 px-2 py-1 rounded bg-slate-950 border border-brand/50 text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-brand" data-sel="${escapeAttr(keyOf(item))}" data-max="${maxSel}" value="${sel}" min="1" max="${maxSel}" /></td>`
    : `<td>${qtyBadge(item.quantity)}</td>`;

  if (master) {
    return `<tr class="${checked ? 'is-selected' : ''}">
        ${checkCell}${nameCell}${qtyCell}
        <td><span class="text-xs font-mono text-slate-400">${item.accounts.size}</span></td>
        <td>${rarityBadge(item, color)}</td>
        <td class="pr-4 text-right">${valueCell(item)}</td></tr>`;
  }
  return `<tr class="${checked ? 'is-selected' : ''}">
      ${checkCell}${nameCell}${qtyCell}
      <td class="text-slate-400">${item.exterior ? escapeHtml(item.exterior) : '<span class="text-slate-600">—</span>'}</td>
      <td>${rarityBadge(item, color)}</td>
      <td class="text-right">${valueCell(item)}</td>
      <td class="pr-4 text-right">${statusCell(item)}</td></tr>`;
}

// ── TBL-03: faceted filter chips (status / rarity / value) ──────────────────────────
// Compose with search, persist PER VIEW, build on the GC buckets (P3), and operate on the
// DATA so the TBL-02 windowed list simply re-mounts on the filtered set.
function facetViewKey() { return `${state.invMode}:${state.activeEnv || 'g'}:${state.activeUsername || state.activeFolder || 'master'}`; }
function currentFacets() {
  state.facetsByView = state.facetsByView || {};
  const k = facetViewKey();
  return (state.facetsByView[k] ||= { status: [], rarity: [], maxCents: null });
}
/** Canonical status bucket for an item — the GC category when present, else DERIVED from the raw flags.
 *  The derivation is the twin of bucketOf (src/core/MarketModel.ts) and must stay faithful to it: a TF2
 *  record has no category at all, so this is the only classifier those 162 items ever see. The final term
 *  is 'untradable' (was 'tradelocked'): a Storage Unit is not held, it is inert. */
function itemStatusKey(i) { return i.category || (i.tradeLockExpiry ? 'tradelocked' : (i.tradable ? 'tradable' : 'untradable')); }
function applyFacets(arr) {
  const f = currentFacets();
  let out = arr;
  if (f.status.length) out = out.filter((i) => f.status.includes(itemStatusKey(i)));
  if (f.rarity.length) out = out.filter((i) => f.rarity.includes(i.rarity));
  if (f.maxCents != null) out = out.filter((i) => i.price != null && i.price < f.maxCents);
  return out;
}
function facetCount() { const f = currentFacets(); return f.status.length + f.rarity.length + (f.maxCents != null ? 1 : 0); }
function toggleFacetValue(kind, val) {
  const list = currentFacets()[kind];
  const idx = list.indexOf(val);
  if (idx >= 0) list.splice(idx, 1); else list.push(val);
  renderMain();
}
function clearFacets() { const f = currentFacets(); f.status = []; f.rarity = []; f.maxCents = null; renderMain(); }
/** Builds the facet chip bar from the items present + the active facet state (DS-03 chips). */
function renderFacetBar(items, opts = {}) {
  const bar = el.facetBar; if (!bar) return;
  const f = currentFacets();
  const STATUSES = [
    { key: 'tradable', label: 'Tradable', cls: 'chip--success' },
    { key: 'tradelocked', label: 'Trade-Locked', cls: 'chip--warn' },
    { key: 'untradable', label: 'Not Tradable', cls: '' },
    { key: 'listed', label: 'Listed', cls: 'chip--listed' },
  ];
  const present = new Set(items.map(itemStatusKey));
  // Status facets only in flat views — in the categorized GC view the bucket PILLS own status (P3).
  const statusChips = opts.categorized ? '' : STATUSES.filter((s) => present.has(s.key)).map((s) =>
    `<button type="button" class="chip ${s.cls}" data-facet="status" data-val="${s.key}" aria-pressed="${f.status.includes(s.key)}">${s.label}</button>`).join('');
  const rarities = [...new Set(items.map((i) => i.rarity).filter(Boolean))].sort((a, b) => rarityWeight(b) - rarityWeight(a));
  const rarityChips = rarities.map((r) =>
    `<button type="button" class="chip chip--neutral" data-facet="rarity" data-val="${escapeAttr(r)}" aria-pressed="${f.rarity.includes(r)}">${escapeHtml(r)}</button>`).join('');
  const sym = state.currency === 'EUR' ? '€' : '$';
  const valVal = f.maxCents != null ? (state.currency === 'EUR' ? f.maxCents / 100 * state.usdToEur : f.maxCents / 100).toFixed(2) : '';
  const sep = '<span class="w-px h-4 bg-slate-700 mx-1" aria-hidden="true"></span>';
  bar.innerHTML =
    `<span class="text-2xs uppercase tracking-wider text-slate-400 mr-1">Filter</span>` +
    statusChips +
    (rarityChips ? (statusChips ? sep : '') + rarityChips : '') +
    sep +
    `<span class="inline-flex items-center gap-1 text-2xs text-slate-400">≤ ${sym}
      <input id="facet-value" type="number" step="0.01" min="0" inputmode="decimal" value="${valVal}" placeholder="value"
        class="w-20 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand/50" /></span>` +
    (facetCount() ? `<button type="button" id="facet-clear" class="text-2xs text-slate-400 hover:text-white transition ml-1"><i class="fa-solid fa-xmark mr-1"></i>Clear (${facetCount()})</button>` : '');
  bar.classList.remove('hidden');
  bar.querySelectorAll('[data-facet]').forEach((b) => b.addEventListener('click', () => toggleFacetValue(b.dataset.facet, b.dataset.val)));
  const vi = $('facet-value');
  if (vi) vi.addEventListener('change', () => {
    const major = parseFloat(String(vi.value).replace(',', '.').trim());
    currentFacets().maxCents = (Number.isFinite(major) && major > 0) ? (state.currency === 'EUR' ? major / state.usdToEur : major) * 100 : null;
    renderMain();
  });
  $('facet-clear')?.addEventListener('click', clearFacets);
}

function renderTable(items, opts = {}) {
  unmountWindow();   // TBL-02: clear any prior windowed scroll listener; the flat path re-mounts below
  const master = !!opts.master;
  // App-agnostic selection: the active game tab (CS2 730 / TF2 440) decides which app's items
  // are selectable, and the send path carries that app id — so TF2 keys are selectable + sendable
  // too, not just CS2. (Bug 1; market SELL stays CS2-only and is gated in updateSelectionBar.)
  const selectable = !!opts.selectable;
  // Phase 2 (A): the "select under value" control is only useful where rows are selectable.
  if (el.valueFilter) { el.valueFilter.classList.toggle('hidden', !selectable); el.valueFilter.classList.toggle('flex', selectable); }
  // Selectable MASTER (folder) keys by marketHashName; selectable account by assetId.
  const keyOf = (item) => (master ? item.marketHashName : item.assetId);
  // Show the amber trade-lock countdown badge on an item's icon whenever locked items sit
  // in a FLAT list (TF2, or a not-yet-fully-refreshed CS2 view) so they're obvious at a
  // glance. In the categorized CS2 view items are already grouped under a "Trade-Locked"
  // header, so there the badge is reserved for that tab to avoid clutter. Never in the
  // aggregated Bots/Master lists.
  const showLockBadge = !master && (!opts.categorized || (state.gcCat || 'all') === 'tradelocked');

  if (!items.length) {
    el.facetBar?.classList.add('hidden');
    el.emptyState.classList.remove('hidden'); el.itemsWrap.classList.add('hidden');
    el.emptyState.querySelector('p').textContent = 'No items.';
    return;
  }
  el.emptyState.classList.add('hidden'); el.itemsWrap.classList.remove('hidden');
  renderFacetBar(items, { categorized: opts.categorized && !master });   // TBL-03

  const checkCol = selectable ? thCheck() : '';
  el.itemsHead.innerHTML = master
    ? checkCol + thSort('Item', 'name', selectable ? 'pl-2 pr-2' : 'pl-3 pr-2') + thSort('Qty', 'quantity') + thSort('Accounts', 'accounts') + thSort('Rarity', 'rarity') + thSort('Value', 'value', 'text-right pr-4')
    : checkCol + thSort('Item', 'name', 'pl-2 pr-2') + thSort('Qty', 'quantity') + thPlain('Exterior') + thSort('Rarity', 'rarity') + thSort('Value', 'value', 'text-right') + thSort('Status', 'status', 'text-right pr-4');
  // PERF-01: header sort is handled by ONE delegated listener (see setupDelegation), not re-bound per render.

  const needle = state.search.trim().toLowerCase();
  // Coerce name fields: a corrupt/legacy cached row lacking name/marketHashName would otherwise
  // throw here and break the whole table + search (the stores accept any JSON). (S30)
  let filtered = applyFacets(items.filter((i) => !needle || (i.name || '').toLowerCase().includes(needle) || (i.marketHashName || '').toLowerCase().includes(needle)));

  if (state.sort) {
    const { key, dir } = state.sort;
    filtered.sort((a, b) => { const c = compareItems(a, b, key); return dir === 'asc' ? c : -c; });
  } else {
    filtered.sort((a, b) => {
      if (!master) { const al = a.tradeLockExpiry ? 1 : 0, bl = b.tradeLockExpiry ? 1 : 0; if (al !== bl) return bl - al; }
      return (b.quantity || 1) - (a.quantity || 1);
    });
  }

  el.searchEmpty.classList.toggle('hidden', filtered.length > 0);

  // PERF-01: rows render via the module-level renderItemRow so a single selection
  // toggle can re-render just one <tr>. This wrapper binds the current render context.
  const rowHtml = (item) => renderItemRow(item, { master, selectable, showLockBadge });

  // GC view: a filter-pill bar + the three strictly-separated buckets. Selecting a
  // pill shows only that bucket; "All" shows all three with section headers.
  let shown = filtered;
  if (opts.categorized && !master) {
    const cols = (selectable ? 1 : 0) + 6;
    const active = state.gcCat || 'all';
    // Every state needs a group, or its rows match no section and silently DISAPPEAR from the table.
    const GROUPS = [
      { key: 'tradable',    label: 'Owned · freely tradable', color: 'rgb(var(--success-rgb))', icon: 'fa-circle-check' },
      { key: 'tradelocked', label: 'Trade-Locked',            color: 'rgb(var(--warn-rgb))', icon: 'fa-lock' },
      { key: 'untradable',  label: 'Not tradable',            color: 'rgb(148 163 184)', icon: 'fa-ban' },
      { key: 'listed',      label: 'Listed on Steam Market',  color: 'rgb(var(--listed-rgb))', icon: 'fa-tag' },
    ];
    if (active !== 'all') shown = filtered.filter((i) => itemStatusKey(i) === active);
    const visible = active === 'all' ? GROUPS : GROUPS.filter((g) => g.key === active);
    el.itemsBody.innerHTML = visible.map((g) => {
      const rows = filtered.filter((i) => itemStatusKey(i) === g.key);
      if (!rows.length) {
        return active === 'all' ? '' : `<tr><td colspan="${cols}" class="py-10 text-center text-slate-600">No items in this category.</td></tr>`;
      }
      const qty = rows.reduce((n, i) => n + (i.quantity || 1), 0);
      // In "All" each section gets a labelled header; in a single-category view the pill labels it.
      const header = active === 'all'
        ? `<tr class="bg-slate-900/70 border-y border-slate-800"><td colspan="${cols}" class="py-2 px-3">
            <span class="text-xs font-bold uppercase tracking-wider" style="color:${g.color}"><i class="fa-solid ${g.icon} mr-2"></i>${g.label}</span>
            <span class="ml-2 text-2xs font-mono text-slate-500">${qty} item${qty !== 1 ? 's' : ''}</span></td></tr>`
        : '';
      return header + rows.map(rowHtml).join('');
    }).join('');
  } else {
    // TBL-02: window the flat list (Global / folder / selection / flat-account) — the 10k case.
    mountWindowedRows(filtered, { master, selectable, showLockBadge }, (selectable ? 1 : 0) + (master ? 5 : 6));
  }

  if (selectable) {
    // PERF-01: stash the render context + a key→item map so a targeted selection toggle
    // can re-render a single <tr>. Selection events are delegated (see setupDelegation).
    state._tableCtx = { master, selectable, showLockBadge };
    const canSel = (i) => master ? (i.sendable || 0) > 0 : (i.tradable && !i.tradeLockExpiry);
    state._tableRows = new Map(filtered.filter(canSel).map((i) => [master ? i.marketHashName : i.assetId, i]));
    refreshSelectAllState();
  } else { state._tableCtx = null; state._tableRows = null; }
  updateSelectionBar();
}

function qtyBadge(q) {
  return q > 1
    ? `<span class="text-xs font-bold px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 font-mono">×${q}</span>`
    : '<span class="text-slate-600 font-mono text-xs">×1</span>';
}
function valueCell(item) {
  if (item.price === undefined) return '<span class="text-slate-600" title="Price loading…">…</span>';
  if (item.price === null)      return '<span class="text-slate-600" title="no market price">—</span>';
  // The stack value is the primary figure — render it as its OWN right-aligned block so every
  // row's value lines up in a clean column under the VALUE header. The per-unit price sits BELOW
  // it (also right-aligned, monospace) instead of trailing inline, which used to push the main
  // values out of alignment by the varying width of the "(…/ea.)" suffix. (owner report 2026-07-08)
  const unit = item.quantity > 1
    ? `<span class="block text-3xs text-slate-600 font-mono leading-tight mt-0.5">${fmtCents(item.price)}/ea.</span>`
    : '';
  return `<span class="block text-slate-200 font-mono">${fmtCents(stackValueCents(item))}</span>${unit}`;
}
function rarityBadge(item, color) {
  return `<span class="text-xs px-2 py-0.5 rounded-full font-medium" style="color:${color}; background:${color}1a; border:1px solid ${color}40">${escapeHtml(item.rarity)}</span>`;
}
/**
 * Backend sentinel for "locked, but Steam served no parseable unlock date"
 * (TRADE_LOCK_DATE_UNKNOWN = 2099-01-01 in InventoryManager). Detected by threshold so it
 * also catches sentinel dates already persisted in cached inventories. Rendering it as a
 * real countdown produced the "26473 days, 11 h" absurdity (owner report 2026-07-09).
 */
const TRADE_LOCK_UNKNOWN_MS = Date.UTC(2098, 0, 1);
function lockDateUnknown(date) {
  const t = new Date(date).getTime();
  return Number.isFinite(t) && t >= TRADE_LOCK_UNKNOWN_MS;
}
/** Human, compact unlock countdown, e.g. "3 days, 14 h" / "5 h, 12 min" / "8 min". */
function lockCountdown(date) {
  if (lockDateUnknown(date)) return 'an unknown time (Steam gave no readable date)';
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'unlocked now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} ${d === 1 ? 'day' : 'days'}, ${h} h`;
  if (h > 0) return `${h} h, ${m} min`;
  return `${Math.max(1, m)} min`;
}
/** Compact lock badge text for the icon overlay: "7D" / "14H" / "32M" / "?" (null if free). */
function lockBadge(date) {
  if (lockDateUnknown(date)) return '?';
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return d + 'D';
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return h + 'H';
  return Math.max(1, Math.floor(ms / 60000)) + 'M';
}
/** Item icon with a small amber trade-lock badge overlaid on the top-left corner.
 *  `showLock` is false in the Master view (aggregated) – the lock badge belongs
 *  strictly to the per-account inventory view. */
function iconWithLock(item, imgClass, showLock = true) {
  if (!item.iconUrl) return '';
  const badge = (showLock && item.tradeLockExpiry) ? lockBadge(item.tradeLockExpiry) : null;
  const badgeHtml = badge
    ? `<span class="absolute -top-1.5 -left-1.5 px-1 py-px rounded-md text-4xs font-extrabold leading-none bg-amber-500 text-slate-950 shadow ring-1 ring-amber-300/50" title="Trade-Locked: unlocks in ${escapeAttr(lockCountdown(item.tradeLockExpiry))}">${escapeHtml(badge)}</span>`
    : '';
  return `<div class="relative shrink-0">
      <img src="${escapeAttr(safeIconUrl(item.iconUrl))}" alt="" loading="lazy" class="${imgClass}" onerror="this.style.display='none'" />
      ${badgeHtml}
    </div>`;
}
/** Aggregate trade-lock badge for a MASTER/aggregated row (one row = the same item grouped across many
 *  accounts). Surfaces how many of the grouped copies are trade-locked: "Locked" when ALL are locked,
 *  "N locked" for a PARTIAL lock (some copies still freely sendable). Reads item.lockedCount, populated
 *  by aggregate()/aggregateWithOwners(). DISPLAY-ONLY — selection + send/sell still fan out strictly over
 *  item.owners[].assetIds (tradable AND unlocked copies only), so a locked copy can never be dispatched. */
function masterLockBadge(item) {
  const locked = item.lockedCount || 0;
  if (locked <= 0) return '';
  const all = locked >= (item.quantity || 0);
  const label = all ? 'Locked' : `${locked} locked`;
  const title = all ? 'All copies are trade-locked' : `${locked} of ${item.quantity} copies trade-locked (the rest are not trade-locked)`;
  return `<span title="${escapeAttr(title)}" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-3xs font-bold whitespace-nowrap ${all ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40' : 'bg-amber-500/10 text-amber-300/90 ring-1 ring-amber-500/25'}"><i class="fa-solid fa-lock text-4xs"></i>${label}</span>`;
}
/** The four item states, mirroring bucketOf (src/core/MarketModel.ts) — the ONE classifier.
 *  Branch order must match it: listed → held → tradable → untradable. Everything after the
 *  'listed' short-circuit DERIVES from the raw flags rather than reading `category`, because TF2
 *  records carry no category at all (tagCategories only runs for source==='gc'). */
function statusCell(item) {
  if (item.category === 'listed') {
    return `<span title="On sale on the Steam Community Market" class="inline-flex items-center gap-1.5 text-sky-400 text-xs font-medium"><i class="fa-solid fa-tag"></i> Listed</span>`;
  }
  if (item.tradeLockExpiry) {
    if (lockDateUnknown(item.tradeLockExpiry)) {
      return `<span title="Trade-locked — Steam did not provide a readable unlock date; re-checked on every refresh" class="inline-flex items-center gap-1.5 text-amber-400 text-xs font-medium"><i class="fa-solid fa-lock"></i> Locked <span class="text-amber-400/60">(date unknown)</span></span>`;
    }
    const d = new Date(item.tradeLockExpiry);
    const abs = isNaN(d) ? '' : d.toLocaleString();
    return `<span title="Unlocks on ${escapeAttr(abs)}" class="inline-flex items-center gap-1.5 text-amber-400 text-xs font-medium"><i class="fa-solid fa-lock"></i> ${escapeHtml(lockCountdown(d))}</span>`;
  }
  if (item.tradable) return `<span class="inline-flex items-center gap-1.5 text-emerald-400 text-xs font-medium"><i class="fa-solid fa-circle-check"></i> Tradable</span>`;
  // PERMANENTLY untradable (Storage Unit, Veteran Coin, badge, music kit, untradable crate). This used to
  // render as a red "Locked" — implying a countdown that will never arrive.
  return `<span title="This item can never be traded — it has no unlock date" class="inline-flex items-center gap-1.5 text-slate-400 text-xs font-medium"><i class="fa-solid fa-ban"></i> Not tradable</span>`;
}

function thSort(label, key, extra = '') {
  const active = state.sort && state.sort.key === key;
  const arrow = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : '';
  // The arrow lives in a FIXED-WIDTH slot that is always present (empty when unsorted), so
  // toggling asc/desc/none never shifts the column label — the header no longer "moves on its
  // own" when you change the sort direction. (owner report 2026-07-08)
  return `<th data-sort="${key}" class="cursor-pointer select-none hover:text-slate-200 transition ${extra}">${label}<span class="inline-block w-2.5 ml-1 text-center text-brand">${arrow}</span></th>`;
}
function thPlain(label, extra = '') { return `<th class="${extra}">${label}</th>`; }
function thCheck() { return `<th class="w-8"><input type="checkbox" id="select-all" title="Select all tradable" class="accent-violet-500 w-4 h-4 cursor-pointer align-middle" /></th>`; }
function onHeaderSort(key) {
  if (state.sort && state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
  renderMain();
}

// ── selection (mode-aware: account = assetId, folder = marketHashName) ────────────
function currentItems() { const inv = invFor(state.activeUsername); return inv ? inv.items : []; }
function findStack(assetId) { return currentItems().find((i) => i.assetId === assetId); }
function clearSelection() { state.selection = {}; }
/** True in the aggregated multi-owner views — the folder master, the sidebar multi-select
 *  scope, the ENVIRONMENT master AND the Global Master — where the item table keys by
 *  marketHashName and Mass Sell/Trade fan out across many owner accounts (env-master: the
 *  environment's accounts; global: across ALL environments).
 *
 *  'env-master' joined this set in 1.5.1 (owner: "send items from Environment Master"). It was
 *  the one master view that aggregated READ-ONLY, so sending from a whole environment meant
 *  first putting its accounts in a folder — or hand-picking them one by one in the sidebar. */
function aggMode() { return state.invMode === 'folder' || state.invMode === 'selection' || state.invMode === 'global' || state.invMode === 'env-master'; }
/** TBL-02: O(1) aggregated-item lookup by marketHashName (was a linear aggItems.find per
 *  selected key → O(rows²) at scale). Returns the same item object as before. */
function aggItemByName(mhn) { return state._aggIndex ? state._aggIndex.get(mhn) : (state.aggItems || []).find((i) => i.marketHashName === mhn); }
/** Clears the sidebar account multi-selection (the checkbox scope). */
function clearAccountSelection() { state.selectedAccounts.clear(); }

/** Max SELECTABLE quantity for a key. In a master (aggregate) view only the SENDABLE
 *  portion can be traded/sold, even though the row may display a larger total quantity. */
function selMaxQty(key) {
  if (aggMode()) { const it = aggItemByName(key); return it ? (it.sendable ?? it.quantity) : 1; }
  const it = findStack(key); return it ? it.quantity : 1;
}
function setSelectQty(key, value, max) {
  let q = parseInt(value, 10);
  if (!Number.isFinite(q) || q < 1) q = 1;
  if (q > max) q = max;
  state.selection[key] = q;
  el.itemsBody.querySelectorAll('.sel-qty').forEach((inp) => { if (inp.dataset.sel === key) inp.value = q; });
  updateSelectionBar();
}

// ── PERF-01: targeted selection updates ─────────────────────────────────────────
// Re-render ONLY the affected <tr>(s) instead of the whole table, so toggling a checkbox
// in a 10k-row Global Master never rebuilds the list or loses scroll position. The render
// context + a key→item map are stashed by renderTable.
function renderRowInPlace(tr, key) {
  const item = state._tableRows && state._tableRows.get(key);
  if (tr && item && state._tableCtx) tr.outerHTML = renderItemRow(item, state._tableCtx);
}
function refreshSelectAllState() {
  const all = $('select-all');
  if (!all) return;
  const keys = state._tableRows ? [...state._tableRows.keys()] : [];   // TBL-02: DATA-driven (covers windowed-off rows)
  all.checked = keys.length > 0 && keys.every((k) => state.selection[k] != null);
}
function onSelToggle(cb) {
  const key = cb.dataset.sel;
  if (cb.checked) state.selection[key] = selMaxQty(key); else delete state.selection[key];
  renderRowInPlace(cb.closest('tr'), key);   // single-row patch (scroll + sibling rows untouched)
  refreshSelectAllState();
  updateSelectionBar();
  syncStickyOffsets();                        // the selection bar may have appeared → re-measure
}
function onSelectAll(checked) {
  // TBL-02: operate on the DATA (all selectable rows), not just the rows in the DOM window.
  // Read max-qty straight from the stashed item — selMaxQty() does a linear search that would
  // be O(rows²) across thousands of stacks (folder/selection master select-all).
  if (state._tableRows) {
    const master = state._tableCtx && state._tableCtx.master;
    for (const [key, item] of state._tableRows) {
      if (checked) state.selection[key] = master ? (item.sendable ?? item.quantity) : item.quantity;
      else delete state.selection[key];
    }
  }
  if (state._win) { state._win.first = state._win.last = -1; state._win.paint(); }   // windowed: repaint visible slice
  else {
    el.itemsBody.querySelectorAll('tr').forEach((tr) => { const m = tr.querySelector('.sel-check, .sel-qty'); if (m) renderRowInPlace(tr, m.dataset.sel); });
  }
  refreshSelectAllState();
  updateSelectionBar();
  syncStickyOffsets();
}
// Delegated dispatchers (attached ONCE in setupDelegation, not per render).
function onItemsBodyChange(e) {
  const cb = e.target.closest('.sel-check');
  if (cb) return onSelToggle(cb);
  const qty = e.target.closest('.sel-qty');
  if (qty) return setSelectQty(qty.dataset.sel, qty.value, Number(qty.dataset.max));
}
function onItemsHeadClick(e) {
  const th = e.target.closest('[data-sort]');
  if (th) onHeaderSort(th.dataset.sort);
}
function onItemsHeadChange(e) {
  if (e.target.closest('#select-all')) onSelectAll(e.target.checked);
}

/** Account view → concrete assetIds from the one active account (single send). */
function selectedAssetIds() {
  const ids = [];
  for (const [assetId, qty] of Object.entries(state.selection)) {
    const stack = findStack(assetId);
    if (!stack) continue;
    ids.push(...stack.assetIds.slice(0, Math.min(qty, stack.assetIds.length)));
  }
  return ids;
}
/** Folder view → concrete {username, assetId} refs across many owners (mass send). */
function selectedItemRefs() {
  const refs = [];
  for (const [mhn, qty] of Object.entries(state.selection)) {
    const item = aggItemByName(mhn);
    if (!item) continue;
    let remaining = qty;
    for (const owner of item.owners) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, owner.assetIds.length);
      for (let i = 0; i < take; i++) refs.push({ username: owner.username, assetId: owner.assetIds[i] });
      remaining -= take;
    }
  }
  return refs;
}
function selectedCount() { return aggMode() ? selectedItemRefs().length : selectedAssetIds().length; }

function updateSelectionBar() {
  if (state.invMode !== 'account' && !aggMode()) { hideSelectionBar(); return; }
  const n = selectedCount();
  if (n === 0) { hideSelectionBar(); return; }
  el.selectionBar.classList.remove('hidden'); el.selectionBar.classList.add('flex');
  // SEND and market SELL both work for CS2 AND TF2 now: the sell modal pins the active game's appId
  // (730/440) and threads it through pricing + market/sellitem + already-listed detection, so a TF2
  // listing goes to the TF2 market at TF2 prices. (Bug 2 — TF2 selling enabled 2026-07-08.)
  if (el.btnSellSel) el.btnSellSel.classList.remove('hidden');
  const unit = aggMode()
    ? `${new Set(selectedItemRefs().map((r) => r.username)).size} Bot(s)`
    : `${Object.keys(state.selection).length} Stack(s)`;
  el.selectionCount.textContent = `${n} Item(s) · ${unit}`;
}
function hideSelectionBar() { el.selectionBar.classList.add('hidden'); el.selectionBar.classList.remove('flex'); }

/**
 * Phase 2 (A): bulk-select every selectable item whose UNIT value is below the typed
 * threshold (interpreted in the currently-displayed currency). Works in the account
 * view (assetId keys) and in every aggregated master (marketHashName keys); the control
 * is hidden wherever rows are not selectable. Items without a known price are
 * skipped — we never auto-select something we can't value.
 */
function selectUnderValue() {
  const maxMajor = parseFloat(String(el.valueFilterInput.value ?? '').replace(',', '.').trim());
  if (!Number.isFinite(maxMajor) || maxMajor <= 0) { toast('Enter a value, e.g. 1.50', 'warn'); return; }
  // item.price is USD cents → convert the typed (display-currency) threshold to USD cents.
  const thrUsdCents = (state.currency === 'EUR' ? maxMajor / state.usdToEur : maxMajor) * 100;

  let items, keyOf, canSel;
  if (aggMode())                        { items = state.aggItems || [];                    keyOf = (i) => i.marketHashName; canSel = () => true; }
  else if (state.invMode === 'account') { items = invFor(state.activeUsername)?.items || []; keyOf = (i) => i.assetId;        canSel = (i) => i.tradable && !i.tradeLockExpiry; }
  else { toast('Open an account or folder view to select items', 'warn'); return; }

  let n = 0;
  for (const it of items) {
    if (!canSel(it) || it.price == null) continue;   // skip locked/untradable + unpriced
    if (it.price < thrUsdCents) { state.selection[keyOf(it)] = selMaxQty(keyOf(it)); n++; }
  }
  renderMain();
  const sym = state.currency === 'EUR' ? '€' : '$';
  toast(n ? `Selected ${n} item(s) under ${sym}${maxMajor.toFixed(2)}` : `No items under ${sym}${maxMajor.toFixed(2)}`, n ? 'success' : 'info');
}

// ════════════════════════════════════════════════════════════════════════════
//  Actions: account selection + inventory refresh
// ════════════════════════════════════════════════════════════════════════════

function selectAccount(username) {
  state.invMode = 'account';
  state.activeUsername = username;
  state.gcCat = 'all'; // reset the category/Active-Orders tab when switching accounts
  state.search = ''; state.sort = null; clearSelection();
  el.searchInput.value = '';
  updateSidebar();
  renderMain();
}

/** Live-pull loading state: shows a centered spinner in the items area. */
// ── FB-03: structure-aware skeletons (replace bare spinners on load / refresh) ──────
/** Skeleton rows mirroring the items-table geometry (icon + name + qty + badge + values). */
function tableSkeletonRows(n = 9) {
  let rows = '';
  for (let i = 0; i < n; i++) {
    const nameW = 110 + (i * 37) % 130;
    rows += `<tr class="border-b border-slate-800/60">
      <td class="py-2.5 pl-3 pr-2"><div class="flex items-center gap-3"><span class="skel" style="width:48px;height:34px"></span><span class="skel" style="width:${nameW}px;height:13px"></span></div></td>
      <td class="py-2.5 px-2"><span class="skel" style="width:30px;height:13px"></span></td>
      <td class="py-2.5 px-2"><span class="skel" style="width:64px;height:13px"></span></td>
      <td class="py-2.5 px-2"><span class="skel" style="width:74px;height:18px;border-radius:9999px"></span></td>
      <td class="py-2.5 px-2 text-right"><span class="skel" style="width:56px;height:13px"></span></td>
      <td class="py-2.5 px-2 pr-4 text-right"><span class="skel" style="width:64px;height:13px"></span></td>
    </tr>`;
  }
  return rows;
}
/** Dashboard env-tile skeletons for the initial data load. */
function renderDashboardSkeleton() {
  if (!el.envTiles) return;
  el.envEmpty?.classList.add('hidden');
  let html = '';
  for (let i = 0; i < 6; i++) {
    html += `<div class="env-tile">
      <div class="env-tile__glow"></div>
      <div class="flex items-center gap-3 mb-3">
        <span class="skel shrink-0" style="width:36px;height:36px;border-radius:.75rem"></span>
        <div class="min-w-0 flex-1"><span class="skel block" style="width:60%;height:16px"></span><span class="skel block mt-1.5" style="width:80%;height:10px"></span></div>
        <span class="skel shrink-0" style="width:64px;height:20px;border-radius:9999px"></span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <span class="skel block" style="height:46px;border-radius:10px"></span>
        <span class="skel block" style="height:46px;border-radius:10px"></span>
        <span class="skel block" style="height:46px;border-radius:10px"></span>
        <span class="skel block" style="height:46px;border-radius:10px"></span>
      </div>
      <div class="mt-3 flex items-center justify-between">
        <span class="skel block" style="width:88px;height:10px"></span>
        <span class="skel block" style="width:96px;height:28px;border-radius:.5rem"></span>
      </div>
    </div>`;
  }
  el.envTiles.innerHTML = html;
}
function showInvLoading(on) {
  if (!el.itemsWrap) return;
  el.invLoading?.classList.add('hidden');        // FB-03: retire the bare centered spinner
  el.invLoading?.classList.remove('flex');
  if (on) {
    el.emptyState.classList.add('hidden');
    el.ordersWrap?.classList.add('hidden');
    el.toolbar?.classList.add('hidden');
    unmountWindow();                             // the skeleton is not a windowed list
    el.itemsHead.innerHTML = '';                 // skeleton has no sortable header
    el.itemsBody.innerHTML = tableSkeletonRows(9);
    el.itemsWrap.classList.remove('hidden');
  } else if (el.itemsBody.querySelector('.skel')) {
    renderMain();                                // load failed before a real render → redraw what we have
  }
}

async function refreshAccount() {
  const u = state.activeUsername;
  if (!u) return;
  setButtonLoading(el.btnLoad, true, 'Refreshing…');
  showInvLoading(true);
  try {
    if (state.game === 'tf2') {
      const inv = await api(`/api/inventory-tf2/${encodeURIComponent(u)}?refresh=1`);
      storeTf2Inv(inv);
      clearSelection();
      renderMain();
      toast(`TF2 inventory refreshed: ${inv.totalItems} items, ${countTf2Keys(inv.items)} keys`, 'success');
    } else {
      const inv = await api(`/api/inventory/${encodeURIComponent(u)}?refresh=1`);
      storeCs2Inv(inv);
      invalidateHistory(); // single refresh also adds a curve point
      clearSelection();
      renderMain();
      // The single Refresh is the complete fetch (owned + trade-locked + listed) → show all three.
      const sum = (cat) => inv.items.filter((i) => i.category === cat).reduce((n, i) => n + (i.quantity || 1), 0);
      toast(`Inventory refreshed: ${inv.totalItems} items · ${sum('tradelocked')} locked · ${sum('listed')} listed`, 'success');
    }
    // The backend refreshed BOTH games on the same session — pull the OTHER game's now-fresh cached
    // record too, so switching tabs shows it without another fetch and the shared wallet carries the
    // same refresh timestamp for both games.
    try {
      const other = state.game === 'tf2'
        ? await api(`/api/inventory/${encodeURIComponent(u)}`)
        : await api(`/api/inventory-tf2/${encodeURIComponent(u)}`);
      if (state.game === 'tf2') storeCs2Inv(other); else storeTf2Inv(other);
    } catch (_) { /* best-effort — the other tab lazily refetches on switch anyway */ }
    // The refresh enriched from the cache and queued the missing/stale prices for a background fill;
    // watch that fill and re-pull so the new item prices + totals appear WITHOUT a restart. (PRICE-REFRESH)
    void watchPriceFill(refreshActiveViewFromCache);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    showInvLoading(false);
    setButtonLoading(el.btnLoad, false, 'Refresh', 'fa-rotate');
    patchSidebarBalances(); // PERF-01: reflect the updated wallet balance in place (no list rebuild / scroll loss)
  }
}

// ── Refresh-All (worker pool + progress polling) ──────────────────────────────
async function startInventoryRefresh(body) {
  try {
    await api('/api/inventory/refresh-all', { method: 'POST', body: JSON.stringify(body) });
    el.refreshProgress.classList.remove('hidden');
    el.refreshLabel.textContent = 'Refreshing…'; // neutral until the first poll knows the count (then: >1 → "Refreshes…")
    el.refreshBar.style.width = '0%';
    resetEndBtn(el.refreshEnd); // fresh run → re-enable the End task button
    hideRefreshFailures(); // a new run invalidates the previous failure list
    resetPoller('refresh'); // start a clean stall window for this run (#27)
    pollRefresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}
// ── Failed-account panel: shows WHICH account failed and WHY ─────────────────
function showRefreshFailures(failed) {
  state.lastFailedUsernames = failed.map((f) => f.username);
  el.refreshFailedList.innerHTML = failed.map((f) => `
    <li class="leading-snug">
      <span class="font-semibold text-slate-200">${escapeHtml(f.username)}</span>
      <span class="text-slate-400"> – ${escapeHtml(shortError(f.error))}</span>
    </li>`).join('') + `
    <li class="pt-1.5">
      <button id="refresh-failed-retry" type="button"
        class="w-full px-2 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 t11 font-bold transition flex items-center justify-center gap-1.5">
        <i class="fa-solid fa-rotate-right"></i><span>Retry ${failed.length > 1 ? `these ${failed.length} accounts` : 'this account'}</span>
      </button>
    </li>`;
  // Re-run the refresh for EXACTLY the failed accounts (server validates each username).
  // startInventoryRefresh hides this panel on start and re-shows it if any fail again.
  $('refresh-failed-retry')?.addEventListener('click', () => {
    const usernames = state.lastFailedUsernames || [];
    if (usernames.length) startInventoryRefresh({ usernames, game: state.game });
  });
  el.refreshFailed.classList.remove('hidden');
}
function hideRefreshFailures() {
  el.refreshFailed.classList.add('hidden');
  el.refreshFailedList.innerHTML = '';
}
/** Trims backend error chains to a readable one-liner for the panel. */
function shortError(msg) {
  const s = String(msg ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 138) + '…' : s;
}
function refreshAll() {
  let body;
  if (state.invMode === 'global') {
    // F3a: refresh ONLY the accounts in the SELECTED environments (state.globalEnvs),
    // not the whole farm. All envs selected → all of them; a 2-env selection → only those.
    // Send an explicit username list (the backend validates each against known accounts).
    const usernames = state.allAccounts
      .filter((a) => a.enabled && state.globalEnvs.has(a.environmentId))
      .map((a) => a.username);
    if (usernames.length === 0) { toast('No accounts in the selected environment(s) to refresh', 'warn'); return; }
    body = { usernames };
  } else {
    body = { environmentId: state.activeEnv };
  }
  startInventoryRefresh({ ...body, game: state.game });
}
function refreshFolder(usernames) {
  startInventoryRefresh({ usernames, game: state.game });
}
function pollRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    try {
      const job = await api('/api/inventory/refresh-status');
      resetPoller('refreshErr'); // S17: a good poll clears the error-retry window
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      el.refreshBar.style.width = pct + '%';
      el.refreshCount.textContent = `${job.done}/${job.total}`;
      // Owner wording: one account reads "Refreshing…", a multi-account run reads "Refreshes…"
      // (the counter next to it then reads as "3/12 refreshes done").
      el.refreshLabel.textContent = job.cancelling ? 'Cancelling…'
        : (job.running ? (job.total > 1 ? 'Refreshes…' : 'Refreshing…') : 'Done');
      if (job.running) {
        if (!job.cancelling && pollerStalled('refresh', job.done)) {
          toast('Refresh appears stuck (no progress) – stopping the live updater. Check the server.', 'warn');
          el.refreshProgress.classList.add('hidden'); resetPoller('refresh'); return;
        }
        pollRefresh(); return;
      }
      resetPoller('refresh');

      // Every bulk refresh fetches BOTH games per account (one login/throttle slot) — re-pull BOTH
      // caches so whichever tab is open shows fresh items and the shared wallet has one timestamp.
      const [invMap, tf2Map] = await Promise.all([api('/api/inventory'), api('/api/inventory-tf2')]);
      state.inventories = {};
      for (const k of Object.keys(invMap || {})) storeCs2Inv(invMap[k]);
      state.tf2Inventories = {};
      for (const k of Object.keys(tf2Map || {})) storeTf2Inv(tf2Map[k]);
      state.tf2Loaded = true;
      state.tf2LoadError = null;   // H-FE-001: a successful TF2 refresh heals any prior load-error panel
      invalidateHistory(); // a fresh curve point exists now → refetch on render
      renderMain();
      renderSidebar(); // refresh-all may have updated wallet balances → update the sidebar
      // refresh-all enriched from the cache + queued the missing/stale prices for a background fill;
      // watch it and re-pull so prices + per-account/portfolio totals update live, no restart. (PRICE-REFRESH)
      void watchPriceFill(refreshActiveViewFromCache);
      const failed = Array.isArray(job.failed) ? job.failed : [];
      const rverb = job.cancelled ? 'ended' : 'complete';
      if (failed.length) {
        // Name the culprits: panel lists every failed account with its reason.
        showRefreshFailures(failed);
        const names = failed.slice(0, 3).map((f) => f.username).join(', ');
        const more = failed.length > 3 ? ` +${failed.length - 3}` : '';
        toast(`Refresh ${rverb}: ${job.done}/${job.total} – failed: ${names}${more}`, 'warn');
      } else {
        toast(`Refresh ${rverb}: ${job.done}/${job.total}`, job.cancelled ? 'warn' : 'success');
      }
      setTimeout(() => el.refreshProgress.classList.add('hidden'), 2500);
    } catch (err) {
      // S17: a transient status-fetch error must not permanently kill the poller while the job keeps
      // running server-side (its completion re-pull would then never fire, leaving a stale view). Bounded
      // retry, mirroring the fbuy poller: keep polling until POLL_STALL_MS of CONTINUOUS errors, then give up.
      if (!pollerStalled('refreshErr', 0)) { pollRefresh(); return; }
      resetPoller('refreshErr');
      toast(err.message || 'Lost contact with the refresh job – stopping the live updater.', 'error');
      el.refreshProgress.classList.add('hidden');
    }
  }, 800);
}

// ── edit account (Problem 3: per-account proxy override + details) ──
async function openEditAccount(username) {
  const acc = state.allAccounts.find((a) => a.username === username);
  if (!acc) { toast('Account not found', 'error'); return; }
  state.editUsername = username;
  el.editLabel.textContent = acc.username;
  el.editDisplayName.value = acc.displayName || '';
  el.editPassword.value = '';
  el.editMafile.value = '';
  el.editOverlay.classList.remove('hidden');
  // Proxy is now managed declaratively in the Proxies module (rules), not per-account here.
}
function closeEditAccount() { el.editOverlay.classList.add('hidden'); state.editUsername = null; }
async function deleteEditAccount() {
  const username = state.editUsername;
  if (!username) return;
  if (!(await ssimConfirm({
    title: 'Remove account', tone: 'danger', confirmLabel: 'Remove account', confirmIcon: 'fa-trash-can',
    body: `Remove <b class="text-slate-100">${escapeHtml(username)}</b> from SSIM?<br>It is logged out and its inventory cache cleared. The maFile is kept — re-add it any time via “Import bots”.`,
  }))) return;

  setButtonLoading(el.editDelete, true, 'Deleting…');
  try {
    await api(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' });
    closeEditAccount();
    // The deleted account may be the one currently shown → fall back to the env master.
    if (state.invMode === 'account' && state.activeUsername === username) selectEnvMaster();
    await refreshEnv();
    toast(`Account "${username}" removed`, 'success');
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  } finally {
    setButtonLoading(el.editDelete, false, 'Delete account', 'fa-trash-can');
  }
}
async function submitEditAccount(ev) {
  ev.preventDefault();
  const username = state.editUsername;
  if (!username) return;

  const body = { displayName: el.editDisplayName.value.trim() }; // always sent (allows clearing)
  // Proxy is managed in the Proxies module now — not sent from here.
  const pw = el.editPassword.value; if (pw) body.password = pw;
  const ma = el.editMafile.value.trim(); if (ma) body.maFilePath = ma;

  setButtonLoading(el.editSubmit, true, 'Saving…');
  try {
    await api(`/api/accounts/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify(body) });
    closeEditAccount();
    await refreshEnv();   // reload tree + accounts → sidebar reflects the change
    // Re-pull the cached inventory so the account view is consistent after the save.
    try {
      const inv = await api(`/api/inventory/${encodeURIComponent(username)}`);
      storeCs2Inv(inv);
      renderMain();
    } catch { /* no cached inventory yet – fine */ }
    toast('Account saved', 'success');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    setButtonLoading(el.editSubmit, false, 'Save', 'fa-check');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Modals: add-account, environment, folder, move, trade, bulk-import
// ════════════════════════════════════════════════════════════════════════════

// ── add account ──
function openAddAccount(envId) {
  el.addForm.reset();
  el.addEnv.innerHTML = state.environments.map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  // Preselect the caller's environment (Accounts-tree row) or fall back to the active Inventories env.
  const pre = (typeof envId === 'string' && envId) ? envId : state.activeEnv;
  if (pre) el.addEnv.value = pre;
  el.modalOverlay.classList.remove('hidden');
}
function closeAddAccount() { el.modalOverlay.classList.add('hidden'); }
async function submitAddAccount(ev) {
  ev.preventDefault();
  const fd = new FormData(el.addForm);
  const proxy = String(fd.get('proxy') || '').trim();
  const body = {
    username: String(fd.get('username') || '').trim(),
    password: String(fd.get('password') || ''),
    maFilePath: String(fd.get('maFilePath') || '').trim(),
    environmentId: String(fd.get('environmentId') || ''),
    proxy: proxy || undefined,
  };
  el.modalSubmit.disabled = true;
  try {
    const acc = await api('/api/accounts', { method: 'POST', body: JSON.stringify(body) });
    closeAddAccount();
    toast(`Account "${acc.username}" added`, 'success');
    await reloadAll();
    if (state.nav === 'accounts') renderAccountsModule();
    else if (state.screen === 'inventory' && state.activeEnv === acc.environmentId) { await refreshEnv(); selectAccount(acc.username); }
    else if (state.screen === 'dashboard') renderDashboard();
  } catch (err) { toast(err.message, 'error'); }
  finally { el.modalSubmit.disabled = false; }
}

// ── account login (Feature 1: QR / credentials import → Limited tier) ──
const LOGIN = { method: 'qr', sessionId: null, credSessionId: null, phase: 'creds', poll: null };

function openLogin() {
  el.loginEnv.innerHTML = state.environments.map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  if (state.activeEnv) el.loginEnv.value = state.activeEnv;
  resetLoginCred();
  el.loginOverlay.classList.remove('hidden');
  switchLoginTab('qr');
}

function closeLogin() {
  stopLoginPoll();
  cancelLoginSession(LOGIN.sessionId); LOGIN.sessionId = null;
  cancelLoginSession(LOGIN.credSessionId); LOGIN.credSessionId = null;
  el.loginOverlay.classList.add('hidden');
}

function cancelLoginSession(id) {
  if (id) api(`/api/accounts/login/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => {});
}

function onLoginClick(e) {
  const tab = e.target.closest('[data-login-tab]');
  if (tab) return switchLoginTab(tab.getAttribute('data-login-tab'));
  if (e.target.closest('[data-login-retry]')) return startQr();
}

function switchLoginTab(method) {
  LOGIN.method = method;
  document.querySelectorAll('#login-overlay .login-tab').forEach((b) => {
    const on = b.getAttribute('data-login-tab') === method;
    b.classList.toggle('bg-brand', on); b.classList.toggle('text-white', on);
    b.classList.toggle('bg-slate-800', !on); b.classList.toggle('text-slate-400', !on);
  });
  el.loginPaneQr.classList.toggle('hidden', method !== 'qr');
  el.loginCredForm.classList.toggle('hidden', method !== 'credentials');
  if (method === 'qr') { cancelLoginSession(LOGIN.credSessionId); LOGIN.credSessionId = null; startQr(); }
  else { stopLoginPoll(); cancelLoginSession(LOGIN.sessionId); LOGIN.sessionId = null; resetLoginCred(); }
}

// QR sub-flow
async function startQr() {
  stopLoginPoll();
  hideQrOverlay();
  el.loginQrImg.removeAttribute('src');
  renderQrStatus('waiting');
  try {
    const st = await api('/api/accounts/login/qr/start', { method: 'POST', body: JSON.stringify({ environmentId: el.loginEnv.value }) });
    LOGIN.sessionId = st.sessionId;
    if (st.qrDataUrl) el.loginQrImg.src = st.qrDataUrl;
    applyLoginStatus(st);
    if (!isTerminalLogin(st.state)) startLoginPoll(st.sessionId, applyLoginStatus);
  } catch (err) {
    showQrOverlay(`<i class="fa-solid fa-triangle-exclamation text-rose-400 text-2xl mb-2"></i><p class="text-rose-300 text-sm font-semibold mb-3">${escapeHtml(err.message)}</p><button data-login-retry class="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-dark text-white text-xs font-bold">Try again</button>`);
  }
}

function applyLoginStatus(st) {
  renderQrStatus(st.state);
  if (st.state === 'imported') { stopLoginPoll(); onLoginImported(st); }
  else if (st.state === 'expired') { stopLoginPoll(); showQrOverlay(`<i class="fa-solid fa-clock-rotate-left text-amber-400 text-2xl mb-2"></i><p class="text-amber-300 text-sm font-semibold mb-3">QR code expired</p><button data-login-retry class="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-dark text-white text-xs font-bold">New code</button>`); }
  else if (st.state === 'error') { stopLoginPoll(); showQrOverlay(`<i class="fa-solid fa-triangle-exclamation text-rose-400 text-2xl mb-2"></i><p class="text-rose-300 text-sm font-semibold mb-3">${escapeHtml(st.error || 'Login failed')}</p><button data-login-retry class="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-dark text-white text-xs font-bold">Try again</button>`); }
}

function renderQrStatus(stateName) {
  const steps = [['waiting', 'Waiting', 'fa-hourglass-half'], ['scanned', 'Scanned', 'fa-mobile-screen-button'], ['approved', 'Approved', 'fa-circle-check'], ['imported', 'Done', 'fa-flag-checkered']];
  const order = ['waiting', 'scanned', 'approved', 'imported'];
  const idx = order.indexOf(isTerminalLogin(stateName) && stateName !== 'imported' ? 'waiting' : stateName);
  el.loginQrStatus.innerHTML = steps.map(([key, label, icon], i) => {
    const done = i < idx, cur = i === idx;
    const cls = cur ? 'pill--brand' : done ? 'pill--success' : 'pill--neutral';
    const ic = (cur && key !== 'imported') ? 'fa-spinner cs2-spin' : icon;
    return `<span class="pill ${cls}"><i class="fa-solid ${ic}"></i>${label}</span>`;
  }).join('');
}

function showQrOverlay(html) { el.loginQrOverlay.innerHTML = html; el.loginQrOverlay.classList.remove('hidden'); }
function hideQrOverlay() { el.loginQrOverlay.classList.add('hidden'); el.loginQrOverlay.innerHTML = ''; }

// Credentials sub-flow
function resetLoginCred() {
  LOGIN.phase = 'creds';
  if (el.loginCredForm.reset) el.loginCredForm.reset();
  el.loginGuard.classList.add('hidden');
  el.loginCredMsg.classList.add('hidden');
  el.loginCredSubmitLabel.textContent = 'Log in';
}

async function submitLoginCredentials(ev) {
  ev.preventDefault();
  el.loginCredSubmit.disabled = true;
  try {
    if (LOGIN.phase === 'guard') {
      const st = await api(`/api/accounts/login/${encodeURIComponent(LOGIN.credSessionId)}/guard`, { method: 'POST', body: JSON.stringify({ code: el.loginGuardInput.value.trim() }) });
      applyCredStatus(st);
    } else {
      const fd = new FormData(el.loginCredForm);
      const body = { username: String(fd.get('username') || '').trim(), password: String(fd.get('password') || ''), environmentId: el.loginEnv.value };
      const st = await api('/api/accounts/login/credentials', { method: 'POST', body: JSON.stringify(body) });
      LOGIN.credSessionId = st.sessionId;
      applyCredStatus(st);
      if (!isTerminalLogin(st.state)) startLoginPoll(st.sessionId, applyCredStatus);
    }
  } catch (err) {
    showCredMsg(err.message, 'error');
  } finally { el.loginCredSubmit.disabled = false; }
}

function applyCredStatus(st) {
  if (st.state === 'guard') {
    LOGIN.phase = 'guard';
    el.loginGuard.classList.remove('hidden');
    el.loginGuardLabel.textContent = st.guardType === 'EmailCode'
      ? `Email Steam Guard code${st.guardDetail ? ` (sent to …@${st.guardDetail})` : ''}`
      : 'Steam Guard mobile code';
    el.loginCredSubmitLabel.textContent = 'Verify code';
    el.loginGuardInput.focus();
    showCredMsg('Enter your Steam Guard code, or just approve the login in your Steam Mobile app.', 'info');
    if (!LOGIN.poll && LOGIN.credSessionId) startLoginPoll(LOGIN.credSessionId, applyCredStatus);
  } else if (st.state === 'imported') {
    stopLoginPoll(); onLoginImported(st);
  } else if (st.state === 'error') {
    stopLoginPoll(); showCredMsg(st.error || 'Login failed', 'error');
  } else if (st.state === 'expired') {
    stopLoginPoll(); showCredMsg('Login attempt expired — try again.', 'error');
  } else {
    showCredMsg('Waiting for approval…', 'info');
  }
}

function showCredMsg(msg, tone) {
  el.loginCredMsg.className = `t10 ${tone === 'error' ? 'text-rose-300' : tone === 'info' ? 'text-slate-400' : 'text-emerald-300'}`;
  el.loginCredMsg.textContent = msg;
  el.loginCredMsg.classList.remove('hidden');
}

// Shared poll/helpers
function isTerminalLogin(s) { return s === 'imported' || s === 'expired' || s === 'error'; }
function startLoginPoll(sessionId, onStatus) {
  stopLoginPoll();
  LOGIN.poll = setInterval(async () => {
    try { onStatus(await api(`/api/accounts/login/${encodeURIComponent(sessionId)}/status`)); }
    catch { /* transient / 404 — keep polling until terminal or the modal closes */ }
  }, 1500);
}
function stopLoginPoll() { if (LOGIN.poll) { clearInterval(LOGIN.poll); LOGIN.poll = null; } }

async function onLoginImported(st) {
  toast(`Account "${st.username}" ${st.isUpdate ? 'updated' : 'imported'} as Limited`, 'success');
  closeLogin();
  await reloadAll();
  if (state.nav === 'accounts') return renderAccountsModule();
  if (state.screen === 'inventory') renderSidebar();
  try { selectAccount(st.username); } catch { /* not in the active env view — it still appears in the sidebar */ }
}

// ── attach maFile → upgrade Limited to Full (Feature 1) ──
function openAttachMaFile(username) {
  el.attachForm.reset();
  el.attachUsername.textContent = username;
  el.attachForm.dataset.username = username;
  el.attachOverlay.classList.remove('hidden');
}
function closeAttach() { el.attachOverlay.classList.add('hidden'); }
async function submitAttach(ev) {
  ev.preventDefault();
  const username = el.attachForm.dataset.username;
  const maFilePath = String(new FormData(el.attachForm).get('maFilePath') || '').trim();
  el.attachSubmit.disabled = true;
  try {
    const acc = await api(`/api/accounts/${encodeURIComponent(username)}/attach-mafile`, { method: 'POST', body: JSON.stringify({ maFilePath }) });
    closeAttach();
    toast(`"${acc.username}" upgraded to Full`, 'success');
    await reloadAll();
    if (state.screen === 'inventory') renderSidebar();
  } catch (err) { toast(err.message, 'error'); }
  finally { el.attachSubmit.disabled = false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  CSFloat workspace (Feature 2) — per-account marketplace control.
//  Documented core tabs (Dashboard / My Listings / Market / Settings) are always
//  shown; Buy Orders / Trades / Inventory appear only when experimental is ON.
//  All renderers extract fields defensively (undocumented response shapes).
// ════════════════════════════════════════════════════════════════════════════
const CSF = {
  username: null, tab: 'dashboard', experimental: false, key: { configured: false },
  market: { cursor: null, items: [], query: {}, loading: false },
  // Inventory + My Listings each keep their own rows, selection and filter so switching
  // tabs doesn't silently discard a 200-item selection you just made.
  // `manual` holds prices the operator typed on a row, in cents, keyed by asset/listing id.
  // It lives in state rather than the DOM because selecting a row re-renders the table — a
  // typed price kept only in the input would vanish the moment you ticked its checkbox.
  inv: { items: [], sel: new Set(), search: '', manual: {} },
  lst: { items: [], sel: new Set(), search: '', manual: {} },
  /** Sales awaiting delivery. `sel` holds CSFloat TRADE ids (what /deliver takes); `delivered` is
   *  the server's durable record of what this install already sent, so a delivered sale can be
   *  marked instead of offering a Send button that could only refuse. */
  trd: { rows: [], sel: new Set(), search: '', delivered: new Set(), auto: false },
  /** CSFloat's lowest buy-now ask per name (one bulk request, cached server-side).
   *  `asked` = names already requested, so a name with no CSFloat listing isn't re-fetched forever. */
  prices: { map: {}, asked: new Set(), fetchedAt: 0, stale: false, loading: false },
  /** Auto-pricing strategy shared by both tabs. */
  strategy: { mode: 'undercut', pct: 2 },
  bulkTimer: null,
  deliverTimer: null,
};
/** CSFloat's documented per-page cap; asking for more is rejected upstream. */
const CSF_PAGE_LIMIT = 50;
const csfUsd = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function csfApi(path, opts) { return api('/api/csfloat/' + encodeURIComponent(CSF.username) + path, opts); }
// CSFloat item images: build the Steam economy URL from a hash, or accept a full URL — but ALWAYS
// pass the result through the icon-host allow-list (#29), so a drifted/hostile CSFloat icon_url
// can't point <img src> at an attacker host and beacon the operator's real/proxy IP.
function csfImg(hash) {
  if (!hash) return '';
  const url = /^https?:/.test(hash) ? hash : 'https://community.akamai.steamstatic.com/economy/image/' + hash;
  return safeIconUrl(url);
}
function csfSkeleton(rows = 5) { return `<div class="space-y-2">${Array.from({ length: rows }, () => '<div class="h-14 rounded-lg bg-slate-800/50 animate-pulse"></div>').join('')}</div>`; }
function csfError(msg) { return `<div class="empty"><div class="empty-icon text-warn"><i class="fa-solid fa-triangle-exclamation"></i></div><div class="empty-title">${escapeHtml(msg)}</div><button data-csf="retry" class="btn btn-secondary btn-sm mt-4"><i class="fa-solid fa-rotate-right"></i>Retry</button></div>`; }
function csfEmpty(icon, msg) { return `<div class="empty"><div class="empty-icon"><i class="fa-solid ${icon}"></i></div><div class="empty-title">${escapeHtml(msg)}</div></div>`; }
function csfArr(res) { if (Array.isArray(res)) return res; const r = res || {}; return r.data || r.listings || r.orders || r.trades || r.results || r.items || []; }
function csfMsg(eln, text, tone) { if (!eln) return; eln.className = `t10 mt-2 ${tone === 'error' ? 'text-rose-300' : tone === 'ok' ? 'text-emerald-300' : 'text-slate-400'}`; eln.textContent = text; eln.classList.remove('hidden'); }
/** Item name off a CSFloat listing/inventory row (shapes differ across the endpoints). */
function csfName(row) {
  const item = (row && (row.item || row.contract?.item)) || row || {};
  return item.market_hash_name || item.full_item_name || item.item_name || '';
}
/** CSFloat's current lowest buy-now ask for a name, or null when we have no catalog entry. */
function csfLowest(name) { const c = CSF.prices.map[name]; return typeof c === 'number' ? c : null; }

/**
 * The price the current strategy suggests for a name, in cents, or null when unknown.
 *
 * NOTE this is a NAME-level suggestion: CSFloat's catalog gives the lowest ask per
 * market_hash_name, which ignores float. A 0.0001 Factory New and a 0.069 Factory New share
 * one suggestion, so the per-row price stays editable and the UI says so.
 */
function csfSuggestPrice(name) {
  const low = csfLowest(name);
  if (low == null) return null;
  const pct = Number(CSF.strategy.pct) || 0;
  const mode = CSF.strategy.mode;
  let cents = mode === 'match' ? low
    : mode === 'over' ? low * (1 + pct / 100)
    : low * (1 - pct / 100);                       // 'undercut'
  cents = Math.round(cents);
  return Math.max(3, cents);                       // CSFloat's floor is $0.03
}

/**
 * The reprice suggestion for an EXISTING listing, or null when it should be left alone.
 *
 * Critical difference from csfSuggestPrice: the catalog's lowest ask INCLUDES our own listing.
 * If we are already at (or under) the lowest, "undercut the lowest by 2%" means undercutting
 * OURSELVES — click it a few times and the stall walks its own prices to the floor. So a
 * listing that already holds the lowest price is reported as "nothing to do", not repriced.
 */
function csfSuggestReprice(listing) {
  const name = csfName(listing);
  const low = csfLowest(name);
  if (low == null) return null;
  const current = listing.price ?? 0;
  if (CSF.strategy.mode !== 'over' && current <= low) return null; // already lowest → never chase ourselves down
  const want = csfSuggestPrice(name);
  if (want == null || want === current) return null;
  return want;
}

/**
 * Loads CSFloat's lowest ask for `names`, MERGING into the catalog we already hold.
 *
 * `asked` tracks what we've requested so a name CSFloat has no listing for (absent from the
 * response, so it stays undefined in the map) isn't re-requested on every tab switch. Merging
 * matters because the two tabs show different name sets: gating on "have we ever fetched?"
 * left the second tab's items permanently unpriced.
 */
async function csfLoadPrices(names, force) {
  const wanted = [...new Set((names || []).filter(Boolean))]
    .filter((n) => force || !CSF.prices.asked.has(n));
  if (!wanted.length) return;
  CSF.prices.loading = true;
  try {
    const r = await csfApi('/price-list', { method: 'POST', body: JSON.stringify({ names: wanted }) });
    Object.assign(CSF.prices.map, r.prices || {});
    for (const n of wanted) CSF.prices.asked.add(n);
    CSF.prices.fetchedAt = r.fetchedAt || Date.now();
    CSF.prices.stale = !!r.stale;
  } catch (err) {
    toast(`Could not load CSFloat prices: ${err.message}`, 'error');
  } finally {
    CSF.prices.loading = false;
  }
}

/** Shared strategy control + selection actions, rendered above the Inventory and Listings tables. */
function csfStrategyBar(scope, selCount, actionsHtml) {
  const s = CSF.strategy;
  const opt = (v, label) => `<option value="${v}" ${s.mode === v ? 'selected' : ''}>${label}</option>`;
  const age = CSF.prices.fetchedAt ? `${Math.max(0, Math.round((Date.now() - CSF.prices.fetchedAt) / 1000))}s ago` : 'not loaded';
  return `<div class="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-slate-800">
    <div class="flex-1 min-w-[150px]"><label class="field-label">Filter</label>
      <input data-csf-search="${scope}" value="${escapeAttr(scope === 'inv' ? CSF.inv.search : CSF.lst.search)}" placeholder="Filter items…" class="field !py-1.5"/></div>
    <div><label class="field-label">Price</label>
      <select data-csf-mode class="field !w-auto !py-1.5">${opt('undercut', 'Undercut lowest')}${opt('match', 'Match lowest')}${opt('over', 'Above lowest')}</select></div>
    <div><label class="field-label">%</label>
      <input data-csf-pct type="number" step="0.5" min="0" max="90" value="${escapeAttr(String(s.pct))}" ${s.mode === 'match' ? 'disabled' : ''} class="field !w-20 !py-1.5"/></div>
    <button data-csf="loadprices" class="btn btn-secondary btn-sm" title="Fetch CSFloat's lowest ask for every item shown (one request)">
      <i class="fa-solid fa-tags"></i>${CSF.prices.loading ? 'Loading…' : 'Refresh prices'}</button>
    <span class="t10 ${CSF.prices.stale ? 'text-amber-400' : 'text-slate-500'}" title="${CSF.prices.stale ? 'CSFloat did not answer — these are the last good prices' : ''}">${CSF.prices.stale ? 'stale · ' : ''}${age}</span>
    <span class="ml-auto"></span>
    <button data-csf="selall" data-scope="${scope}" class="btn btn-ghost btn-sm">Select all</button>
    <button data-csf="selnone" data-scope="${scope}" class="btn btn-ghost btn-sm">Clear</button>
    ${actionsHtml}
  </div>
  <p class="t10 text-slate-500 -mt-1 mb-3">Suggestions come from CSFloat's lowest ask <b>per item name</b> — they don't account for float, so review anything rare before listing.${selCount ? ` <span class="text-brand-light">${selCount} selected.</span>` : ''}</p>`;
}

async function openCsFloat(username) {
  CSF.username = username; CSF.tab = 'dashboard'; CSF.market = { cursor: null, items: [], query: {}, loading: false };
  // Everything below is per-account: a stall, a selection and a price catalog from the PREVIOUS
  // account must never leak into this one (listing the wrong bot's items is unrecoverable).
  CSF.inv = { items: [], sel: new Set(), search: '', manual: {} };
  CSF.lst = { items: [], sel: new Set(), search: '', manual: {} };
  CSF.prices = { map: {}, asked: new Set(), fetchedAt: 0, stale: false, loading: false };
  CSF.trd = { rows: [], sel: new Set(), search: '', delivered: new Set(), auto: false };
  clearTimeout(CSF.bulkTimer); CSF.bulkTimer = null;
  clearTimeout(CSF.deliverTimer); CSF.deliverTimer = null;
  el.csfloatAccount.textContent = username;
  el.csfloatOverlay.classList.remove('hidden');
  el.csfloatTabs.innerHTML = ''; el.csfloatBody.innerHTML = csfSkeleton();
  try {
    const [cfg, key] = await Promise.all([
      api('/api/csfloat/config').catch(() => ({ experimental: false })),
      csfApi('/key').catch(() => ({ configured: false })),
    ]);
    CSF.experimental = !!cfg.experimental; CSF.key = key || { configured: false };
  } catch { CSF.experimental = false; CSF.key = { configured: false }; }
  csfRenderTabs();
  csfSwitchTab(CSF.key.configured ? 'dashboard' : 'settings');
  // A bulk job survives the modal being closed, so pick a still-running one back up rather
  // than leaving the operator with no sign that 200 listings are mid-flight.
  try {
    const j = await api('/api/csfloat/bulk-status');
    if (j && j.running && j.username === username) csfPollBulk();
  } catch { /* status is a convenience here — never block opening the workspace */ }
  // Same for a delivery run — it sends real Steam offers, so reopening the workspace mid-run must
  // show it rather than look idle while items are leaving the account.
  try {
    const d = await api('/api/csfloat/deliver-status');
    if (d && d.running && d.username === username) csfPollDeliver();
  } catch { /* convenience only */ }
}
function closeCsFloat() {
  // H-FE-010: stop the bulk-progress poller on close (the job itself keeps running server-side
  // and its result is picked up again on reopen — only the polling stops).
  clearTimeout(CSF.bulkTimer); CSF.bulkTimer = null;
  clearTimeout(CSF.deliverTimer); CSF.deliverTimer = null;
  el.csfloatOverlay.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════════════════════
//  SDA Overview (Phase 6 Feature B): Steam Guard OTP (auto-rolling + copy) + live
//  mobile confirmations (approve single / multi / all). The backend owns the
//  canonical OTP + getConfirmations/respond; this panel only renders + refreshes
//  from truth (no optimistic-only state). Acts on EXACTLY the selected account.
// ════════════════════════════════════════════════════════════════════════════
const SDA = { username: null, otpTimer: null, barTimer: null, rlTimer: null, code: '·····', confs: [], open: false, otpErr: false };
const SDA_OTP_RETRY_MS = 5000;

async function openSda(username) {
  SDA.username = username; SDA.open = true; SDA.code = '·····';
  if (el.sdaAccount) el.sdaAccount.textContent = username;
  if (el.sdaOtp) el.sdaOtp.textContent = '·····';
  if (el.sdaOverlay) el.sdaOverlay.classList.remove('hidden');
  startSdaOtp(username);
  await refreshSdaConfirmations();
}

function closeSda() {
  SDA.open = false;
  if (SDA.otpTimer) { clearTimeout(SDA.otpTimer); SDA.otpTimer = null; }
  if (SDA.barTimer) { clearInterval(SDA.barTimer); SDA.barTimer = null; }
  if (SDA.rlTimer) { clearInterval(SDA.rlTimer); SDA.rlTimer = null; }
  if (el.sdaOverlay) el.sdaOverlay.classList.add('hidden');
}

// OTP: fetch the current code + ms-remaining, display, animate the bar, re-fetch at expiry.
// The shared_secret stays server-side; we only ever receive the 5-char code.
async function startSdaOtp(username) {
  if (SDA.otpTimer) { clearTimeout(SDA.otpTimer); SDA.otpTimer = null; }
  if (SDA.barTimer) { clearInterval(SDA.barTimer); SDA.barTimer = null; }
  try {
    const { code, msRemaining } = await api(`/api/accounts/${encodeURIComponent(username)}/otp`);
    if (!SDA.open || SDA.username !== username) return;
    SDA.otpErr = false;
    SDA.code = code;
    if (el.sdaOtp) el.sdaOtp.textContent = code;
    const total = 30000;
    const remaining = Math.max(500, Number(msRemaining) || 0);
    const start = Date.now();
    if (el.sdaOtpBar) el.sdaOtpBar.style.width = `${Math.round((remaining / total) * 100)}%`;
    SDA.barTimer = setInterval(() => {
      const left = remaining - (Date.now() - start);
      if (el.sdaOtpBar) el.sdaOtpBar.style.width = `${Math.max(0, Math.round((left / total) * 100))}%`;
      if (left <= 0 && SDA.barTimer) { clearInterval(SDA.barTimer); SDA.barTimer = null; }
    }, 200);
    // Re-fetch the FRESH code a hair past the boundary so the displayed value is never stale.
    SDA.otpTimer = setTimeout(() => { if (SDA.open && SDA.username === username) startSdaOtp(username); }, remaining + 300);
  } catch (e) {
    if (!SDA.open || SDA.username !== username) return;
    if (el.sdaOtp) el.sdaOtp.textContent = '—';
    if (el.sdaOtpBar) el.sdaOtpBar.style.width = '0%';
    // Toast once per error streak (not every retry) so a transient blip isn't a toast storm.
    if (!SDA.otpErr) { SDA.otpErr = true; toast(e.message || 'could not load Steam Guard code', 'error'); }
    // A single transient failure must NOT kill the auto-roll forever (S17 class): schedule a
    // bounded, guarded retry so the display self-recovers once the backend returns. The guard
    // stops the retry the moment the modal closes or the account changes (mirrors the success path).
    SDA.otpTimer = setTimeout(() => { if (SDA.open && SDA.username === username) startSdaOtp(username); }, SDA_OTP_RETRY_MS);
  }
}

async function copySdaOtp() {
  // Copy the code CURRENTLY displayed (read live from the DOM) so a click at the 30s
  // boundary copies the fresh value, never a stale one.
  const code = ((el.sdaOtp && el.sdaOtp.textContent) || SDA.code || '').trim();
  if (!code || code === '·····' || code === '—') return;
  try { await navigator.clipboard.writeText(code); } catch { /* clipboard may be blocked */ }
  if (el.sdaOtpCopyLabel) {
    const prev = el.sdaOtpCopyLabel.textContent;
    el.sdaOtpCopyLabel.textContent = 'Copied';
    setTimeout(() => { if (el.sdaOtpCopyLabel) el.sdaOtpCopyLabel.textContent = prev || 'Copy'; }, 1200);
  }
}

async function refreshSdaConfirmations() {
  const username = SDA.username;
  if (!el.sdaConfBody) return;
  if (SDA.rlTimer) { clearInterval(SDA.rlTimer); SDA.rlTimer = null; }
  el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-slate-500 text-sm"><i class="fa-solid fa-spinner cs2-spin mr-2"></i>Loading confirmations…</div>`;
  try {
    const { confirmations } = await api(`/api/accounts/${encodeURIComponent(username)}/confirmations`);
    if (!SDA.open || SDA.username !== username) return;
    SDA.confs = Array.isArray(confirmations) ? confirmations : [];
    renderSdaConfirmations();
  } catch (e) {
    if (!SDA.open || SDA.username !== username) return;
    // Steam rate-limits this ACCOUNT's mobile-confirmation endpoint (mobileconf is authenticated, so the
    // limit follows the account, not just the exit IP). A "Refresh" click can't beat it — the window has to
    // elapse. Say so, count it down, and retry once on its own.
    if (e.status === 429) { renderSdaRateLimited(username, Math.max(5, Number(e.data && e.data.retryAfterSeconds) || 60)); return; }
    const msg = escapeHtml(e.message || 'failed to load confirmations');
    el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-rose-300 text-sm"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${msg}<div class="mt-3"><button id="sda-conf-retry" class="btn btn-secondary btn-sm">Refresh</button></div></div>`;
    const r = $('sda-conf-retry'); if (r) r.addEventListener('click', refreshSdaConfirmations);
  }
}

/**
 * Steam's per-account confirmation rate-limit. Show a live countdown to when a check is next ALLOWED,
 * then STOP — do NOT auto-retry. (2026-07-10: the old unattended auto-retry re-probed the moment the
 * window reopened, which keeps Steam's per-account limit armed so the account never clears. Re-checking
 * is what sustains the lock; leaving it alone is what heals it.) The operator can force one check with
 * "Retry now" once the countdown ends; the backend gate still refuses a network getlist until its own
 * (escalating) cooldown elapses, so mashing the button can't re-arm Steam.
 */
function renderSdaRateLimited(username, seconds) {
  let left = seconds;
  const paint = () => {
    if (!el.sdaConfBody) return;
    const ready = left <= 0;
    el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-amber-300 text-sm">
        <i class="fa-solid fa-hourglass-half mr-2"></i>Steam has temporarily limited how often this account's confirmations can be checked.
        <div class="t12 text-slate-500 mt-1">It clears on its own once the account is left alone — checking too often keeps the limit active, so automatic checks are paused.</div>
        <div class="t13 text-slate-300 mt-2">${ready ? 'You can check again now.' : `Next check available in <b>${left}s</b>…`}</div>
        <div class="mt-3"><button id="sda-conf-retry" class="btn btn-secondary btn-sm"${ready ? '' : ' disabled'}>Retry now</button></div>
      </div>`;
    const r = $('sda-conf-retry'); if (r && ready) r.addEventListener('click', refreshSdaConfirmations);
  };
  paint();
  if (SDA.rlTimer) clearInterval(SDA.rlTimer);
  SDA.rlTimer = setInterval(() => {
    if (!SDA.open || SDA.username !== username) { clearInterval(SDA.rlTimer); SDA.rlTimer = null; return; }
    left -= 1;
    // Settle to a MANUAL state at zero — never auto-fetch (that was the re-arming loop).
    if (left <= 0) { clearInterval(SDA.rlTimer); SDA.rlTimer = null; paint(); return; }
    paint();
  }, 1000);
}

function renderSdaConfirmations() {
  if (el.sdaConfCount) el.sdaConfCount.textContent = SDA.confs.length ? `(${SDA.confs.length})` : '';
  if (!SDA.confs.length) {
    el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-slate-600 t13">No pending confirmations.</div>`;
    updateSdaSelCount(); return;
  }
  const typeIcon = (t) => (t === 'trade' ? 'fa-right-left' : t === 'market' ? 'fa-tag' : 'fa-shield-halved');
  el.sdaConfBody.innerHTML = SDA.confs.map((c) => `
    <div class="flex items-center gap-3 px-4 py-2.5" data-conf-id="${escapeAttr(c.id)}">
      <input type="checkbox" class="sda-conf-check accent-emerald-500 w-4 h-4 shrink-0" />
      ${c.iconUrl ? `<img src="${escapeAttr(safeIconUrl(c.iconUrl))}" alt="" loading="lazy" class="w-9 h-7 object-contain shrink-0" onerror="this.style.display='none'" />` : `<i class="fa-solid ${typeIcon(c.typeName)} text-slate-500 w-9 text-center shrink-0"></i>`}
      <div class="min-w-0 flex-1">
        <div class="t13 text-slate-200 font-semibold truncate" title="${escapeAttr(c.title)}">${escapeHtml(c.title)}</div>
        <div class="t11 text-slate-500 truncate">${escapeHtml(c.typeName)}${c.sending ? ' · gives ' + escapeHtml(c.sending) : ''}${c.receiving ? ' · gets ' + escapeHtml(c.receiving) : ''}</div>
      </div>
      <button data-conf-approve="${escapeAttr(c.id)}" class="btn btn-sm bg-emerald-600 text-white shrink-0"><i class="fa-solid fa-check"></i><span>Approve</span></button>
    </div>`).join('');
  el.sdaConfBody.querySelectorAll('.sda-conf-check').forEach((cb) => cb.addEventListener('change', updateSdaSelCount));
  el.sdaConfBody.querySelectorAll('[data-conf-approve]').forEach((b) => b.addEventListener('click', () => respondSda([b.dataset.confApprove], true)));
  updateSdaSelCount();
}

function selectedSdaIds() {
  return [...el.sdaConfBody.querySelectorAll('.sda-conf-check')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.closest('[data-conf-id]') && cb.closest('[data-conf-id]').dataset.confId)
    .filter(Boolean);
}
function updateSdaSelCount() {
  const n = selectedSdaIds().length;
  if (el.sdaConfSelCount) el.sdaConfSelCount.textContent = String(n);
  if (el.sdaConfApproveSel) el.sdaConfApproveSel.disabled = n === 0;
}

async function respondSda(ids, accept, all = false) {
  const username = SDA.username;
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(username)}/confirmations/respond`, { method: 'POST', body: JSON.stringify({ ids, accept, all }) });
    const failed = (r.failed || []).length;
    toast(`${accept ? 'Approved' : 'Denied'} ${r.done || 0} confirmation(s)${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'success');
  } catch (e) {
    toast(e.message || 'confirmation action failed', 'error');
  }
  await refreshSdaConfirmations(); // ALWAYS re-fetch from the canonical source
}

// ── Clean browser (Phase 6 Feature A): isolated, proxied, ephemeral session ──
async function openCleanBrowser(btn, username) {
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i><span>Opening…</span>';
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(username)}/open-browser`, { method: 'POST', body: '{}' });
    for (const w of (r.warnings || [])) toast(w, 'info');
    toast(`Opened ${username} in a browser${r.proxy ? ` (proxy ${r.proxy}${r.proxyAuth ? ', authed' : ''})` : ' (LOCAL IP)'}`, 'success');
  } catch (e) {
    toast(e.message || 'could not open browser', 'error');
    for (const w of ((e.data && e.data.warnings) || [])) toast(w, 'info');
  } finally {
    btn.disabled = false;
    btn.innerHTML = prev;
  }
}

function csfRenderTabs() {
  const core = [['dashboard', 'Dashboard', 'fa-gauge'], ['listings', 'My Listings', 'fa-tags'], ['market', 'Market', 'fa-store']];
  const exp = [['buyorders', 'Buy Orders', 'fa-hand-holding-dollar'], ['trades', 'Sales &amp; Delivery', 'fa-paper-plane'], ['inventory', 'Inventory', 'fa-boxes-stacked']];
  const tabs = [...core, ...(CSF.experimental ? exp : []), ['settings', 'Settings', 'fa-gear']];
  el.csfloatTabs.innerHTML = tabs.map(([id, label, icon]) => {
    const on = CSF.tab === id;
    return `<button data-csf-tab="${id}" class="chip" aria-pressed="${on}"><i class="fa-solid ${icon}"></i>${label}</button>`;
  }).join('');
}

function csfSwitchTab(tab) {
  CSF.tab = tab; csfRenderTabs();
  if (tab !== 'settings' && !CSF.key.configured) return csfNeedKey();
  ({ dashboard: csfLoadDashboard, listings: csfLoadListings, market: csfRenderMarket, buyorders: csfLoadBuyOrders, trades: csfLoadTrades, inventory: csfLoadInventory, settings: csfRenderSettings }[tab] || csfRenderSettings)();
}

function csfNeedKey() {
  el.csfloatBody.innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-key"></i></div><div class="empty-title">No CSFloat API key for this account</div><div class="empty-sub mb-4">Add your key to manage this account on CSFloat.</div><button data-csf="gosettings" class="btn btn-primary btn-sm"><i class="fa-solid fa-gear"></i>Open Settings</button></div>`;
}

// ── Dashboard ──
async function csfLoadDashboard() {
  el.csfloatBody.innerHTML = csfSkeleton(3);
  try {
    const me = await csfApi('/me');
    const bal = me.balance ?? (me.user && me.user.balance) ?? me.pending_balance ?? 0;
    const name = me.username || (me.user && me.user.username) || me.steam_id || (me.user && me.user.steam_id) || CSF.username;
    // Cache the stall on the dashboard too, so the Listings tab opens instantly and the
    // headline numbers below come from the SAME snapshot the tab will show.
    let listingCount = '—', listedValue = null, count = 0;
    try {
      const rows = csfArr(await csfApi(`/listings?limit=${CSF_PAGE_LIMIT}`));
      CSF.lst.items = rows;
      count = rows.length;
      listedValue = rows.reduce((n, l) => n + (l.price ?? 0), 0);
      // A full page means there may be more — say "50+" rather than implying that IS the whole stall.
      listingCount = count >= CSF_PAGE_LIMIT ? `${CSF_PAGE_LIMIT}+` : String(count);
    } catch { /* leave as — */ }
    el.csfloatBody.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
        ${csfStat('Balance', csfUsd(bal), 'fa-wallet', 'text-emerald-400')}
        ${csfStat('Active listings', listingCount, 'fa-tags', 'text-brand-light')}
        ${csfStat('Listed value', listedValue == null ? '—' : csfUsd(listedValue), 'fa-sack-dollar', 'text-teal-300')}
        ${csfStat('Account', escapeHtml(String(name)), 'fa-user', 'text-slate-300')}
      </div>
      <div class="flex gap-2 flex-wrap">
        <button data-csf-tab="market" class="btn btn-secondary btn-sm"><i class="fa-solid fa-store mr-1.5"></i>Browse market</button>
        <button data-csf-tab="listings" class="btn btn-secondary btn-sm"><i class="fa-solid fa-tags mr-1.5"></i>My listings${count ? ` (${listingCount})` : ''}</button>
        ${CSF.experimental ? '<button data-csf-tab="inventory" class="btn btn-primary btn-sm"><i class="fa-solid fa-boxes-stacked mr-1.5"></i>List items in bulk</button>' : ''}
      </div>`;
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}
function csfStat(label, value, icon, color) {
  return `<div class="stat-card"><p class="stat-label">${label}</p><p class="stat-value ${color} truncate"><i class="fa-solid ${icon} mr-1.5 t13"></i>${value}</p></div>`;
}

// ── My Listings — multi-select, live undercut comparison, bulk delist/reprice ──
async function csfLoadListings(keepSelection) {
  el.csfloatBody.innerHTML = csfSkeleton();
  try {
    const items = csfArr(await csfApi(`/listings?limit=${CSF_PAGE_LIMIT}`));
    CSF.lst.items = items;
    if (!keepSelection) CSF.lst.sel = new Set();
    // Warm the lowest-ask catalog for exactly the names on screen so the position column
    // ("lowest" / "$1.20 above") is meaningful the moment the tab opens. Only the names we
    // haven't asked for yet actually hit the network.
    await csfLoadPrices(items.map(csfName));
    csfRenderListings();
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}

function csfVisibleListings() {
  const q = CSF.lst.search.trim().toLowerCase();
  return q ? CSF.lst.items.filter((l) => csfName(l).toLowerCase().includes(q)) : CSF.lst.items;
}

function csfRenderListings() {
  const visible = csfVisibleListings();
  const selected = visible.filter((l) => CSF.lst.sel.has(String(l.id || l.listing_id || '')));
  // How many of the SELECTED listings would actually move — a listing already holding the
  // lowest price is deliberately excluded (see csfSuggestReprice), so the button must not
  // promise to reprice 40 when only 12 will change.
  const repriceable = selected.filter((l) => csfSuggestReprice(l) != null).length;
  const actions = `
    <button data-csf="bulkreprice" ${repriceable ? '' : 'disabled'} class="btn btn-primary btn-sm ${repriceable ? '' : 'opacity-40 cursor-not-allowed'}" title="${repriceable ? 'Move the selected listings to the suggested price' : 'Nothing to reprice — the selected listings already hold the lowest ask'}">
      <i class="fa-solid fa-arrows-down-to-line"></i>Reprice (${repriceable})</button>
    <button data-csf="bulkdelist" ${selected.length ? '' : 'disabled'} class="btn btn-danger btn-sm ${selected.length ? '' : 'opacity-40 cursor-not-allowed'}">
      <i class="fa-solid fa-xmark"></i>Delist (${selected.length})</button>`;
  el.csfloatBody.innerHTML = csfStrategyBar('lst', selected.length, actions)
    + (visible.length
      ? `<div class="space-y-1.5">${visible.map(csfListingRow).join('')}</div>`
      : (CSF.lst.items.length ? csfEmpty('fa-filter', 'No listing matches that filter.') : csfEmpty('fa-tags', 'No active listings on CSFloat.')));
}

function csfListingRow(l) {
  const item = l.item || {}; const id = String(l.id || l.listing_id || '');
  const name = csfName(l) || 'Unknown item';
  const price = l.price ?? 0;
  const fl = item.float_value != null ? Number(item.float_value).toFixed(4) : '';
  const low = csfLowest(name);
  const want = csfSuggestReprice(l);
  const sel = CSF.lst.sel.has(id);
  // Position vs. the rest of the market, so it's obvious at a glance what is and isn't selling.
  const pos = low == null
    ? '<span class="t10 text-slate-600">no market data</span>'
    : price <= low
      ? '<span class="pill pill--success t10">lowest</span>'
      : `<span class="pill pill--warn t10" title="Cheapest on CSFloat: ${csfUsd(low)}">${csfUsd(price - low)} above</span>`;
  return `<div class="csf-row flex items-center gap-2.5 rounded-xl bg-slate-950/50 border ${sel ? 'border-brand/50 ring-1 ring-brand/40' : 'border-slate-800'} px-3 py-2">
    <input type="checkbox" data-csf-lst="${escapeAttr(id)}" ${sel ? 'checked' : ''} class="accent-brand w-4 h-4 shrink-0">
    ${item.icon_url ? `<img src="${escapeAttr(csfImg(item.icon_url))}" alt="" loading="lazy" class="w-10 h-10 object-contain shrink-0"/>` : '<i class="fa-solid fa-image text-slate-700 w-10 text-center shrink-0"></i>'}
    <div class="min-w-0 flex-1"><p class="t13 text-slate-200 truncate" title="${escapeAttr(name)}">${escapeHtml(name)}</p>
      <p class="t10 text-slate-500 font-mono">${fl ? `float ${fl}` : ''}${low != null ? `${fl ? ' · ' : ''}lowest ${csfUsd(low)}` : ''}</p></div>
    <div class="shrink-0 w-24 text-right">${pos}</div>
    <div class="shrink-0 w-20 text-right t10 font-mono ${want != null ? 'text-brand-light' : 'text-slate-700'}" title="${want != null ? 'Suggested new price' : 'No change suggested'}">${want != null ? '→ ' + csfUsd(want) : '—'}</div>
    <input type="number" step="0.01" min="0.03" value="${CSF.lst.manual[id] != null ? (CSF.lst.manual[id] / 100).toFixed(2) : ''}" placeholder="${(price / 100).toFixed(2)}" class="csf-price field !w-24 !py-1.5 text-right shrink-0" />
    <button data-csf="editprice" data-id="${escapeAttr(id)}" title="Update to the typed price" class="btn btn-icon-sm btn-secondary shrink-0"><i class="fa-solid fa-pen"></i></button>
    <button data-csf="delist" data-id="${escapeAttr(id)}" title="Delist" class="btn btn-icon-sm btn-danger shrink-0"><i class="fa-solid fa-xmark"></i></button>
    <span class="t13 font-bold text-emerald-400 font-mono w-20 text-right shrink-0">${csfUsd(price)}</span></div>`;
}

// ── Market ──
function csfRenderMarket() {
  el.csfloatBody.innerHTML = `
    <form id="csf-market-form" class="flex flex-wrap items-end gap-2 mb-4">
      <div class="flex-1 min-w-[180px]"><label class="field-label">Search</label>
        <input name="market_hash_name" placeholder="e.g. AK-47 | Redline" class="field" /></div>
      <div><label class="field-label">Min $</label><input name="min" type="number" step="0.01" class="field !w-24" /></div>
      <div><label class="field-label">Max $</label><input name="max" type="number" step="0.01" class="field !w-24" /></div>
      <div><label class="field-label">Sort</label>
        <select name="sort_by" class="field !w-auto">
          <option value="best_deal">Best deal</option><option value="lowest_price">Lowest price</option><option value="highest_price">Highest price</option><option value="most_recent">Most recent</option><option value="lowest_float">Lowest float</option><option value="highest_float">Highest float</option></select></div>
      <button type="submit" class="btn btn-primary"><i class="fa-solid fa-magnifying-glass"></i>Search</button>
    </form>
    <div id="csf-market-results">${CSF.market.items.length ? '' : csfEmpty('fa-store', 'Search the CSFloat marketplace above.')}</div>`;
  if (CSF.market.items.length) csfRenderMarketResults();
}
async function csfDoMarketSearch(reset) {
  const form = $('csf-market-form'); if (!form) return;
  if (reset) {
    const fd = new FormData(form);
    CSF.market.cursor = null; CSF.market.items = [];
    CSF.market.query = {
      market_hash_name: String(fd.get('market_hash_name') || '').trim() || undefined,
      min_price: fd.get('min') ? Math.round(Number(fd.get('min')) * 100) : undefined,
      max_price: fd.get('max') ? Math.round(Number(fd.get('max')) * 100) : undefined,
      sort_by: String(fd.get('sort_by') || 'best_deal'),
    };
  }
  const results = $('csf-market-results'); if (reset && results) results.innerHTML = csfSkeleton();
  CSF.market.loading = true;
  try {
    const q = { ...CSF.market.query, limit: 24 }; if (CSF.market.cursor) q.cursor = CSF.market.cursor;
    const pairs = Object.entries(q).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]);
    const res = await csfApi('/listings/search?' + new URLSearchParams(pairs).toString());
    CSF.market.cursor = res.cursor || null;
    CSF.market.items = reset ? csfArr(res) : CSF.market.items.concat(csfArr(res));
    csfRenderMarketResults();
  } catch (err) { if (results) results.innerHTML = csfError(err.message); }
  finally { CSF.market.loading = false; }
}
function csfRenderMarketResults() {
  const results = $('csf-market-results'); if (!results) return;
  if (!CSF.market.items.length) { results.innerHTML = csfEmpty('fa-store', 'No listings match — try a different search.'); return; }
  results.innerHTML = `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${CSF.market.items.map(csfMarketCard).join('')}</div>
    ${CSF.market.cursor ? '<div class="text-center mt-4"><button data-csf="marketmore" class="btn btn-secondary btn-sm">Load more</button></div>' : ''}`;
}
function csfMarketCard(l) {
  const item = l.item || {}; const id = l.id || ''; const price = l.price ?? 0;
  const name = item.market_hash_name || 'Unknown item';
  const fl = item.float_value != null ? Number(item.float_value).toFixed(4) : ''; const wear = item.wear_name || '';
  return `<div class="rounded-xl bg-slate-950/50 border border-slate-800 p-3 flex flex-col">
    <div class="flex items-center justify-center h-24 mb-2">${item.icon_url ? `<img src="${escapeAttr(csfImg(item.icon_url))}" alt="" class="max-h-24 object-contain"/>` : '<i class="fa-solid fa-image text-slate-700 text-2xl"></i>'}</div>
    <p class="t13 text-slate-200 truncate" title="${escapeAttr(name)}">${escapeHtml(name)}</p>
    <p class="t10 text-slate-500 mb-2 truncate">${escapeHtml(wear)}${fl ? ` · ${fl}` : ''}</p>
    <div class="mt-auto flex items-center justify-between">
      <span class="t14 font-bold text-emerald-400 font-mono">${csfUsd(price)}</span>
      <button data-csf="buy" data-id="${escapeAttr(id)}" data-price="${price}" data-name="${escapeAttr(name)}" class="btn btn-buy btn-sm"><i class="fa-solid fa-cart-shopping"></i>Buy</button>
    </div></div>`;
}

// ── Buy Orders (experimental) ──
async function csfLoadBuyOrders() {
  el.csfloatBody.innerHTML = csfSkeleton(3);
  try {
    const orders = csfArr(await csfApi('/buy-orders?limit=50'));
    el.csfloatBody.innerHTML = `
      <form id="csf-bo-form" class="flex flex-wrap items-end gap-2 mb-5 pb-5 border-b border-slate-800">
        <div class="relative flex-1 min-w-[200px]">
          <label class="block text-2xs text-slate-500 mb-1">Item</label>
          <input name="market_hash_name" id="csf-bo-name" autocomplete="off" required placeholder="Search CS2 items…" class="field"/>
          <div id="csf-bo-results" class="hidden absolute left-0 right-0 mt-1 z-20 max-h-64 overflow-y-auto rounded-lg bg-slate-900 border border-slate-700 shadow-2xl"></div>
        </div>
        <div><label class="block text-2xs text-slate-500 mb-1">Max $</label><input name="max_price" type="number" step="0.01" required class="field !w-24"/></div>
        <div><label class="block text-2xs text-slate-500 mb-1">Qty</label><input name="quantity" type="number" min="1" value="1" required class="field !w-20"/></div>
        <button type="submit" class="px-4 py-2 rounded-lg bg-brand hover:bg-brand-dark text-white text-sm font-bold">Place order</button>
      </form>
      ${orders.length ? `<div class="space-y-2">${orders.map(csfBuyOrderRow).join('')}</div>` : csfEmpty('fa-hand-holding-dollar', 'No active buy orders.')}`;
    csfWireBoSearch();
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}

/** Search-as-you-type for the buy-order item field (mirrors the mass-buy search): hits the
 *  Steam market search, shows a result dropdown, click fills the exact market_hash_name. */
function csfWireBoSearch() {
  const input = $('csf-bo-name'); const box = $('csf-bo-results');
  if (!input || !box) return;
  const hide = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  input.addEventListener('input', () => {
    clearTimeout(CSF.boSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    CSF.boSearchTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/market/search?q=${encodeURIComponent(q)}&appId=730`);
        if (input.value.trim() !== q) return;                 // a newer query is in flight
        const list = (r.results || []).slice(0, 20);
        if (!list.length) { hide(); return; }
        // Steam market search only supplies the canonical CS2 item NAME here (names are identical
        // across Steam/CSFloat) — we deliberately do NOT surface its Steam price inside CSFloat.
        box.innerHTML = list.map((it, i) => `
          <button type="button" data-i="${i}" class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-brand/20 transition">
            ${it.iconUrl ? `<img src="${escapeAttr(safeIconUrl(it.iconUrl))}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'"/>` : ''}
            <span class="block min-w-0 flex-1 text-sm text-slate-200 truncate">${escapeHtml(it.name || it.marketHashName)}</span>
          </button>`).join('');
        box.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
          input.value = list[Number(b.dataset.i)].marketHashName; hide(); input.focus();
        }));
        box.classList.remove('hidden');
      } catch { hide(); }
    }, 300);
  });
  input.addEventListener('blur', () => setTimeout(hide, 200));
}
function csfBuyOrderRow(o) {
  const id = o.id || ''; const name = o.market_hash_name || o.expression || (o.item && o.item.market_hash_name) || 'Buy order';
  const price = o.max_price ?? o.price ?? 0; const qty = o.quantity ?? o.qty ?? 1;
  return `<div class="flex items-center gap-3 rounded-xl bg-slate-950/50 border border-slate-800 px-3 py-2">
    <div class="min-w-0 flex-1"><p class="t13 text-slate-200 truncate">${escapeHtml(String(name))}</p><p class="t10 text-slate-500">qty ${escapeHtml(String(qty))}</p></div>
    <span class="t13 font-bold text-emerald-400 font-mono">${csfUsd(price)}</span>
    <button data-csf="delorder" data-id="${escapeAttr(id)}" class="btn btn-icon-sm btn-danger"><i class="fa-solid fa-xmark"></i></button></div>`;
}

// ── Sales (experimental) — the delivery dashboard ────────────────────────────
//
// This tab used to be the auto-accept ON/OFF switch plus one flat row per trade showing a name and
// a price. Two things were wrong with that (owner report 2026-08-12): the toggle was the ONLY way to
// deliver — a sale that arrived before you flipped it just sat there — and a buyer who bought seven
// of the same skin produced seven identical rows with nothing to tie them together.
//
// So: sales are grouped by BUYER, identical skins inside a buyer are stacked with a ×N, and every
// level (row, buyer, whole selection) has its own Send button. The toggle stays for hands-off
// running; it is no longer the only lever.

/**
 * Normalizes one row of CSFloat's UNDOCUMENTED /me/trades payload.
 *
 * Every field is looked up through a chain of plausible names and degrades to null rather than to a
 * wrong value — a mis-parsed buyer or asset is what ships an item to the wrong place, so anything
 * that does not resolve is simply not shown (and the server refuses to deliver it: it validates the
 * steamID/trade-URL/asset independently before creating an offer).
 */
/**
 * An id field as a string — but NEVER from a JSON number too large to survive JSON.parse.
 *
 * A steamID64 (~7.66e16) is above Number.MAX_SAFE_INTEGER, so if CSFloat ever transports one as a
 * number its low digits are already lost by the time this runs. The server discards such a value
 * outright (it would mis-deliver the item); stringifying the corruption here would show a Send
 * button that the server can only ever refuse.
 */
function csfIdStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : '';
  return '';
}

function csfTrade(t) {
  const contract = (t && (t.contract || t.listing)) || {};
  const item = contract.item || t.item || {};
  const buyer = t.buyer || t.buyer_user || {};
  const price = contract.price ?? t.price ?? t.total_price ?? 0;
  const created = Date.parse(t.created_at || contract.created_at || t.accepted_at || '') || 0;
  return {
    id:        csfIdStr(t.id) || csfIdStr(t.trade_id),
    state:     String(t.state || t.status || ''),
    name:      csfName(t) || item.item_name || 'Item',
    icon:      item.icon_url || '',
    float:     typeof item.float_value === 'number' ? item.float_value : null,
    wear:      item.wear_name || '',
    stattrak:  !!item.is_stattrak,
    souvenir:  !!item.is_souvenir,
    priceCents: Number(price) || 0,
    buyerName: buyer.username || buyer.name || '',
    buyerId:   csfIdStr(t.buyer_id) || csfIdStr(buyer.steam_id) || csfIdStr(buyer.steamid),
    buyerAvatar: buyer.avatar || '',
    assetId:   csfIdStr(item.asset_id) || csfIdStr(item.assetid) || csfIdStr(contract.asset_id),
    tradeUrl:  t.trade_url || buyer.trade_url || t.buyer_trade_url || '',
    offerId:   String(t.trade_offer_id || (t.steam_offer && t.steam_offer.id) || ''),
    createdAt: created,
    raw:       t,
  };
}

/** Sale states that mean it is over — mirrors `terminalState` in CsFloatAutoAcceptWorker.ts.
 *  Keep the two in step: this one greys the button, that one is the gate that actually holds. */
function csfFinishedState(state) {
  const s = String(state || '').trim();
  return /complet|verified|delivered|cancel|fail|expire|refund|dispute/i.test(s) ? s : '';
}

/** Can SSIM send this one? Mirrors the server's pre-send validation so the UI never offers a
 *  button whose only possible outcome is "skipped". */
function csfDeliverable(r) {
  if (CSF.trd.delivered.has(r.id)) return 'Already delivered by SSIM';
  if (!r.id) return 'CSFloat sent no trade id for this sale';
  const done = csfFinishedState(r.state);
  if (done) return `CSFloat calls this sale "${done}" — it is finished, nothing to deliver`;
  if (!r.assetId) return 'CSFloat sent no asset id for this sale';
  if (!r.tradeUrl && !r.buyerId) return "CSFloat sent no buyer trade URL or steamID — SSIM will not send to an unverified destination";
  return '';   // deliverable
}

async function csfLoadTrades() {
  el.csfloatBody.innerHTML = csfSkeleton(3);
  try {
    // Do NOT coerce a failed /auto-accept fetch to a fake OFF (that made a transient error
    // indistinguishable from genuinely off, and fed the next PUT a fabricated default). Let a
    // failure fall to the tab's error surface (csfError) below, exactly like the other CSF tabs.
    const [auto, tradesRes] = await Promise.all([ csfApi('/auto-accept'), csfApi('/trades?limit=50') ]);
    CSF.trd.rows = csfArr(tradesRes).map(csfTrade);
    CSF.trd.delivered = new Set(((tradesRes && tradesRes.ssim && tradesRes.ssim.delivered) || []).map(String));
    CSF.trd.auto = !!auto.enabled;
    // Drop selections for sales that are gone (delivered elsewhere, cancelled) so a stale tick
    // can't be submitted on the next click.
    const live = new Set(CSF.trd.rows.map((r) => r.id));
    CSF.trd.sel = new Set([...CSF.trd.sel].filter((id) => live.has(id)));
    csfRenderTrades();
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}

function csfVisibleTrades() {
  const q = CSF.trd.search.trim().toLowerCase();
  if (!q) return CSF.trd.rows;
  return CSF.trd.rows.filter((r) => r.name.toLowerCase().includes(q) || r.buyerName.toLowerCase().includes(q) || r.buyerId.includes(q));
}

/** Buyer → stacks of identical items. One buyer card per person, one row per distinct skin. */
function csfGroupTrades(rows) {
  const byBuyer = new Map();
  for (const r of rows) {
    const key = r.buyerId || r.buyerName || '—';
    let g = byBuyer.get(key);
    if (!g) { g = { key, name: r.buyerName, steamId: r.buyerId, avatar: r.buyerAvatar, rows: [], stacks: new Map(), cents: 0, newest: 0 }; byBuyer.set(key, g); }
    g.rows.push(r);
    g.cents += r.priceCents;
    g.newest = Math.max(g.newest, r.createdAt);
    // Stack on the NAME: "7× AK-47 | Redline" is the thing the operator is looking at. Floats and
    // per-unit prices still differ inside a stack, so both are summarised on the row.
    const sk = r.name;
    const s = g.stacks.get(sk) || { name: r.name, icon: r.icon, rows: [] };
    s.rows.push(r);
    g.stacks.set(sk, s);
  }
  return [...byBuyer.values()].sort((a, b) => b.newest - a.newest);
}

function csfStateBadge(state) {
  const s = String(state || '').toLowerCase();
  const tone = /verif|accept|complete|success/.test(s) ? 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/30'
    : /fail|cancel|expire|error/.test(s) ? 'text-rose-400 bg-rose-500/10 ring-rose-500/30'
    : 'text-amber-400 bg-amber-500/10 ring-amber-500/30';
  return s ? `<span class="t10 px-1.5 py-0.5 rounded ring-1 ${tone}">${escapeHtml(s)}</span>` : '';
}

function csfRenderTrades() {
  const visible = csfVisibleTrades();
  const groups = csfGroupTrades(visible);
  const acc = state.allAccounts.find((a) => a.username === CSF.username);
  const limited = !!(acc && acc.canConfirm === false);
  const auto = CSF.trd.auto;

  const selected = CSF.trd.rows.filter((r) => CSF.trd.sel.has(r.id));
  const sendable = selected.filter((r) => !csfDeliverable(r));
  const selCents = sendable.reduce((n, r) => n + r.priceCents, 0);
  const pending = CSF.trd.rows.filter((r) => !csfDeliverable(r));
  const pendCents = pending.reduce((n, r) => n + r.priceCents, 0);

  const stat = (label, value, tone) => `<div class="px-3 py-2 rounded-xl bg-slate-950/50 border border-slate-800">
    <p class="t10 text-slate-500">${label}</p><p class="t14 font-bold ${tone || 'text-slate-200'} font-mono">${value}</p></div>`;

  el.csfloatBody.innerHTML = `
    <div class="surface flex items-center justify-between gap-4 px-4 py-3 mb-3">
      <div><p class="text-sm font-bold text-slate-200">Auto-accept sales</p>
        <p class="text-2xs text-slate-500 max-w-md">${limited
          ? "Unavailable — this account's maFile has no identity_secret to confirm the Steam delivery. Attach a maFile with one to enable."
          : 'Deliver every new sale automatically (checked every 45s). You can always send by hand below — the toggle is not required.'}</p></div>
      <button data-csf="autoaccept" data-enabled="${auto ? '1' : '0'}" ${limited ? 'disabled' : ''} class="btn btn-sm ${auto ? 'btn-primary' : 'btn-secondary'} ${limited ? 'opacity-40 cursor-not-allowed' : ''}">${auto ? '<i class="fa-solid fa-check mr-1"></i>ON' : 'OFF'}</button>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
      ${stat('Sales', String(CSF.trd.rows.length))}
      ${stat('Awaiting delivery', String(pending.length), pending.length ? 'text-amber-400' : 'text-slate-200')}
      ${stat('Value to send', csfUsd(pendCents), 'text-emerald-400')}
      ${stat('Buyers', String(groups.length))}
    </div>

    <div class="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-slate-800">
      <div class="flex-1 min-w-[150px]"><label class="field-label">Filter</label>
        <input data-csf-search="trd" value="${escapeAttr(CSF.trd.search)}" placeholder="Filter by item or buyer…" class="field !py-1.5"/></div>
      <button data-csf="refreshtrades" class="btn btn-secondary btn-sm"><i class="fa-solid fa-rotate-right"></i>Refresh</button>
      <span class="ml-auto"></span>
      <button data-csf="selall" data-scope="trd" class="btn btn-ghost btn-sm">Select all</button>
      <button data-csf="selnone" data-scope="trd" class="btn btn-ghost btn-sm">Clear</button>
      <button data-csf="deliver" data-ids="${escapeAttr(sendable.map((r) => r.id).join(','))}" ${sendable.length ? '' : 'disabled'}
        class="btn btn-primary btn-sm ${sendable.length ? '' : 'opacity-40 cursor-not-allowed'}"
        title="${sendable.length ? 'Send and 2FA-confirm the Steam offer for each selected sale' : 'Tick the sales you want to deliver'}">
        <i class="fa-solid fa-paper-plane"></i>Send ${sendable.length}${sendable.length ? ` · ${csfUsd(selCents)}` : ''}</button>
    </div>
    ${selected.length > sendable.length ? `<p class="t10 text-amber-400 -mt-1 mb-3">${selected.length - sendable.length} selected sale(s) can't be sent — see the reason on the row.</p>` : ''}

    ${groups.length ? `<div class="space-y-3">${groups.map(csfBuyerCard).join('')}</div>` : (CSF.trd.rows.length ? csfEmpty('fa-filter', 'No sale matches that filter.') : csfEmpty('fa-right-left', 'No sales yet.'))}
    ${CSF.trd.rows.length ? `<details class="mt-4"><summary class="t10 text-slate-600 cursor-pointer hover:text-slate-400">Raw CSFloat payload (first sale) — for diagnosing a missing field</summary>
      <pre class="mt-2 p-3 rounded-lg bg-slate-950 border border-slate-800 t10 text-slate-400 overflow-x-auto max-h-64">${escapeHtml(JSON.stringify(CSF.trd.rows[0].raw, null, 2))}</pre></details>` : ''}`;
}

function csfBuyerCard(g) {
  // Checkboxes tick only what can actually be SENT: ticking a buyer whose one item is already
  // delivered would otherwise put a sale in the selection that the run can only skip.
  const sendableIds = g.rows.filter((r) => !csfDeliverable(r)).map((r) => r.id);
  const allSel = sendableIds.length && sendableIds.every((id) => CSF.trd.sel.has(id));
  const label = g.name || (g.steamId ? `Buyer ${g.steamId}` : 'Unknown buyer');
  return `<div class="rounded-xl bg-slate-950/40 border border-slate-800 overflow-hidden">
    <div class="flex items-center gap-3 px-3 py-2.5 bg-slate-900/40 border-b border-slate-800">
      <input type="checkbox" data-csf-trd-group="${escapeAttr(sendableIds.join(','))}" ${allSel ? 'checked' : ''} ${sendableIds.length ? '' : 'disabled'} class="accent-brand w-4 h-4 shrink-0">
      ${g.avatar ? `<img src="${escapeAttr(safeIconUrl(g.avatar))}" alt="" loading="lazy" class="w-7 h-7 rounded-full shrink-0"/>` : '<i class="fa-solid fa-user text-slate-600 w-7 text-center shrink-0"></i>'}
      <div class="min-w-0 flex-1">
        <p class="t13 font-semibold text-slate-100 truncate">${escapeHtml(label)}</p>
        <p class="t10 text-slate-500 font-mono truncate">${escapeHtml(g.steamId || '—')}${g.newest ? ` · ${escapeHtml(dashAgo(g.newest))}` : ''}</p>
      </div>
      <div class="text-right shrink-0">
        <p class="t13 font-bold text-emerald-400 font-mono">${csfUsd(g.cents)}</p>
        <p class="t10 text-slate-500">${g.rows.length} item${g.rows.length === 1 ? '' : 's'}</p>
      </div>
      <button data-csf="deliver" data-ids="${escapeAttr(sendableIds.join(','))}" ${sendableIds.length ? '' : 'disabled'}
        class="btn btn-sm ${sendableIds.length ? 'btn-primary' : 'btn-secondary opacity-40 cursor-not-allowed'} shrink-0">
        <i class="fa-solid fa-paper-plane"></i>Send all${sendableIds.length ? ` (${sendableIds.length})` : ''}</button>
    </div>
    <div class="divide-y divide-slate-800/70">${[...g.stacks.values()].map(csfTradeStackRow).join('')}</div>
  </div>`;
}

/** One distinct skin inside a buyer card — "×7" instead of seven identical rows. */
function csfTradeStackRow(s) {
  const rows = s.rows;
  const sendableIds = rows.filter((r) => !csfDeliverable(r)).map((r) => r.id);
  const blocked = rows.map(csfDeliverable).filter(Boolean);
  const allSel = sendableIds.length && sendableIds.every((id) => CSF.trd.sel.has(id));
  const cents = rows.reduce((n, r) => n + r.priceCents, 0);
  const unit = rows.map((r) => r.priceCents);
  const lo = Math.min(...unit), hi = Math.max(...unit);
  const floats = rows.map((r) => r.float).filter((f) => f != null);
  const wear = rows[0].wear;
  // Every distinct state in the stack (a buyer's seven copies can be at different stages).
  const states = [...new Set(rows.map((r) => r.state).filter(Boolean))];
  const deliveredCount = rows.filter((r) => CSF.trd.delivered.has(r.id)).length;
  return `<div class="flex items-center gap-2.5 px-3 py-2">
    <input type="checkbox" data-csf-trd-group="${escapeAttr(sendableIds.join(','))}" ${allSel ? 'checked' : ''} ${sendableIds.length ? '' : 'disabled'} class="accent-brand w-4 h-4 shrink-0">
    ${s.icon ? `<img src="${escapeAttr(csfImg(s.icon))}" alt="" loading="lazy" class="w-10 h-10 object-contain shrink-0"/>` : '<i class="fa-solid fa-image text-slate-700 w-10 text-center shrink-0"></i>'}
    <div class="min-w-0 flex-1">
      <p class="t13 text-slate-200 truncate" title="${escapeAttr(s.name)}">${rows.length > 1 ? `<span class="text-brand-light font-bold">${rows.length}×</span> ` : ''}${escapeHtml(s.name)}</p>
      <p class="t10 text-slate-500 font-mono truncate">
        ${wear ? escapeHtml(wear) : ''}${floats.length ? ` · float ${floats.map((f) => f.toFixed(4)).join(', ')}` : ''}
        ${states.length ? ' · ' + states.map(csfStateBadge).join(' ') : ''}
        ${deliveredCount ? `<span class="text-emerald-400"> · ${deliveredCount} delivered</span>` : ''}
      </p>
      ${blocked.length ? `<p class="t10 text-amber-400 truncate" title="${escapeAttr(blocked[0])}">${escapeHtml(blocked[0])}${blocked.length > 1 ? ` (+${blocked.length - 1} more)` : ''}</p>` : ''}
    </div>
    <div class="shrink-0 w-24 text-right t10 font-mono text-slate-500" title="Price per item">${lo === hi ? csfUsd(lo) : `${csfUsd(lo)}–${csfUsd(hi)}`}${rows.length > 1 ? ' ea.' : ''}</div>
    <div class="shrink-0 w-24 text-right t13 font-bold text-emerald-400 font-mono">${csfUsd(cents)}</div>
    <button data-csf="deliver" data-ids="${escapeAttr(sendableIds.join(','))}" ${sendableIds.length ? '' : 'disabled'}
      class="btn btn-sm ${sendableIds.length ? 'btn-secondary' : 'btn-secondary opacity-40 cursor-not-allowed'} shrink-0">Send${sendableIds.length > 1 ? ` ${sendableIds.length}` : ''}</button>
  </div>`;
}

/**
 * Sends the chosen sales. This creates REAL, 2FA-confirmed Steam offers that hand over the items,
 * so it confirms first and names exactly what leaves the account — the same bar the single-item
 * List button clears.
 */
async function csfDeliverTrades(ids) {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return toast('Nothing to send', 'error');
  const rows = CSF.trd.rows.filter((r) => wanted.includes(r.id));
  const cents = rows.reduce((n, r) => n + r.priceCents, 0);
  const buyers = new Set(rows.map((r) => r.buyerName || r.buyerId || '?'));
  const preview = rows.slice(0, 6).map((r) => `<li>${escapeHtml(r.name)} → <span class="text-slate-400">${escapeHtml(r.buyerName || r.buyerId || 'buyer')}</span></li>`).join('');
  const ok = await ssimConfirm({
    title: 'Deliver CSFloat sales',
    tone: 'brand',
    confirmLabel: `Send ${rows.length}`,
    confirmIcon: 'fa-paper-plane',
    body: `Send <b class="text-slate-100">${rows.length} item(s)</b> worth <b class="text-emerald-300">${csfUsd(cents)}</b> to <b class="text-slate-100">${buyers.size} buyer(s)</b> from <b class="text-slate-100">${escapeHtml(CSF.username)}</b>?`
      + `<ul class="mt-2 space-y-0.5 text-2xs text-slate-300 list-disc list-inside">${preview}${rows.length > 6 ? `<li class="text-slate-500">…and ${rows.length - 6} more</li>` : ''}</ul>`
      + '<p class="mt-2 text-2xs text-amber-300">Each one becomes a real Steam offer, confirmed with this account\'s maFile. Delivered sales are never re-sent.</p>',
  });
  if (!ok) return;
  try {
    await csfApi('/deliver', { method: 'POST', body: JSON.stringify({ tradeIds: wanted }) });
    CSF.trd.sel = new Set();
    csfPollDeliver();
  } catch (err) { toast(err.message, 'error'); }
}

/** Live progress for a manual delivery run — mirrors the bulk-job bar. */
function csfPollDeliver() {
  clearTimeout(CSF.deliverTimer);
  const tick = async () => {
    if (!el.csfloatOverlay || el.csfloatOverlay.classList.contains('hidden')) { CSF.deliverTimer = null; return; }
    let j;
    try { j = await api('/api/csfloat/deliver-status'); }
    catch { CSF.deliverTimer = setTimeout(tick, 2000); return; }   // transient — keep watching
    let bar = document.getElementById('csf-deliver-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'csf-deliver-bar';
      bar.className = 'surface px-4 py-2.5 mb-3';
      el.csfloatBody.prepend(bar);
    }
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    const bad = (j.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped' || r.status === 'unconfirmed');
    bar.innerHTML = `<div class="flex items-center gap-3">
        <span class="t12 text-slate-200 font-semibold">Delivering ${j.done}/${j.total}</span>
        <span class="t10 text-emerald-400">${j.sent} sent</span>
        ${j.unconfirmed ? `<span class="t10 text-amber-400">${j.unconfirmed} unconfirmed</span>` : ''}
        ${j.failed ? `<span class="t10 text-rose-400">${j.failed} failed</span>` : ''}
        ${j.skipped ? `<span class="t10 text-slate-400">${j.skipped} skipped</span>` : ''}
        <span class="t10 text-slate-500 truncate flex-1">${escapeHtml(j.current || '')}</span>
        ${j.running ? '<button data-csf="delivercancel" class="btn btn-danger btn-sm !py-0.5">Cancel</button>' : ''}
      </div>
      <div class="h-1.5 mt-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full rounded-full bg-brand transition-all" style="width:${pct}%"></div></div>
      ${bad.length ? `<div class="mt-2 max-h-32 overflow-y-auto space-y-0.5">${bad.slice(0, 25).map((r) => `<div class="t10 ${r.status === 'failed' ? 'text-rose-300' : r.status === 'unconfirmed' ? 'text-amber-300' : 'text-slate-400'} truncate" title="${escapeAttr(r.error || '')}">${escapeHtml(r.name || r.tradeId)}: ${escapeHtml(r.error || r.status)}</div>`).join('')}</div>` : ''}`;
    if (j.running) { CSF.deliverTimer = setTimeout(tick, 900); return; }
    CSF.deliverTimer = null;
    if (j.error) toast(j.error, 'error');
    else toast(`Delivered ${j.sent}/${j.total}${j.unconfirmed ? ` · ${j.unconfirmed} need manual 2FA` : ''}${j.failed ? ` · ${j.failed} failed` : ''}${j.cancelled ? ' (cancelled)' : ''}`, j.failed ? 'warn' : 'success');
    // The sale list is now stale — some rows are delivered and must come back marked as such.
    if (CSF.tab === 'trades') await csfLoadTrades();
  };
  tick();
}

// ── Inventory (experimental) — multi-select + auto-priced bulk listing ──
async function csfLoadInventory(keepSelection) {
  el.csfloatBody.innerHTML = csfSkeleton();
  try {
    const items = csfArr(await csfApi('/inventory'));
    CSF.inv.items = items;
    if (!keepSelection) CSF.inv.sel = new Set();
    await csfLoadPrices(items.map(csfName));
    csfRenderInventory();
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}

/** Asset id off an inventory row (the endpoint nests it inconsistently). */
function csfAsset(it) {
  const item = (it && it.item) || it || {};
  return String(item.asset_id || item.assetid || it.asset_id || it.assetid || '');
}

function csfVisibleInventory() {
  const q = CSF.inv.search.trim().toLowerCase();
  const rows = CSF.inv.items.filter((it) => csfAsset(it));  // unlistable without an asset id
  return q ? rows.filter((it) => csfName(it).toLowerCase().includes(q)) : rows;
}

/** The price an inventory row would actually list at: what was typed, else the suggestion. */
function csfInvPrice(it) { return CSF.inv.manual[csfAsset(it)] ?? csfSuggestPrice(csfName(it)); }

function csfRenderInventory() {
  const visible = csfVisibleInventory();
  const selected = visible.filter((it) => CSF.inv.sel.has(csfAsset(it)));
  // Only rows we can actually price are listable in bulk; the rest need a manual price.
  const priced = selected.filter((it) => csfInvPrice(it) != null);
  const totalCents = priced.reduce((n, it) => n + csfInvPrice(it), 0);
  const actions = `
    <button data-csf="bulklist" ${priced.length ? '' : 'disabled'} class="btn btn-primary btn-sm ${priced.length ? '' : 'opacity-40 cursor-not-allowed'}" title="${priced.length ? 'List every selected item at its suggested price' : 'Load prices first, or type a price on the rows you want to list'}">
      <i class="fa-solid fa-tags"></i>List ${priced.length}${priced.length ? ` · ${csfUsd(totalCents)}` : ''}</button>`;
  el.csfloatBody.innerHTML = csfStrategyBar('inv', selected.length, actions)
    + (visible.length
      ? `<div class="space-y-1.5">${visible.map(csfInvRow).join('')}</div>`
      : (CSF.inv.items.length ? csfEmpty('fa-filter', 'No item matches that filter.') : csfEmpty('fa-boxes-stacked', 'No tradable CS2 items found on CSFloat.')));
}

function csfInvRow(it) {
  const item = it.item || it;
  const asset = csfAsset(it);
  const name = csfName(it) || 'Item';
  const fl = item.float_value != null ? Number(item.float_value).toFixed(4) : '';
  const low = csfLowest(name);
  const want = csfSuggestPrice(name);
  const sel = CSF.inv.sel.has(asset);
  return `<div class="csf-row flex items-center gap-2.5 rounded-xl bg-slate-950/50 border ${sel ? 'border-brand/50 ring-1 ring-brand/40' : 'border-slate-800'} px-3 py-2">
    <input type="checkbox" data-csf-inv="${escapeAttr(asset)}" ${sel ? 'checked' : ''} class="accent-brand w-4 h-4 shrink-0">
    ${item.icon_url ? `<img src="${escapeAttr(csfImg(item.icon_url))}" alt="" loading="lazy" class="w-10 h-10 object-contain shrink-0"/>` : '<i class="fa-solid fa-image text-slate-700 w-10 text-center shrink-0"></i>'}
    <div class="min-w-0 flex-1"><p class="t13 text-slate-200 truncate" title="${escapeAttr(name)}">${escapeHtml(name)}</p>
      <p class="t10 text-slate-500 font-mono">${fl ? `float ${fl}` : ''}</p></div>
    <div class="shrink-0 w-24 text-right t10 font-mono ${low == null ? 'text-slate-700' : 'text-slate-400'}" title="CSFloat's lowest ask for this name">${low == null ? 'no data' : csfUsd(low)}</div>
    <div class="shrink-0 w-20 text-right t12 font-mono ${want == null ? 'text-slate-700' : 'text-brand-light'}" title="Suggested list price">${want == null ? '—' : csfUsd(want)}</div>
    <input type="number" step="0.01" min="0.03" value="${CSF.inv.manual[asset] != null ? (CSF.inv.manual[asset] / 100).toFixed(2) : ''}" placeholder="${want == null ? 'price $' : (want / 100).toFixed(2)}" class="csf-price field !w-24 !py-1.5 text-right shrink-0" />
    <button data-csf="listasset" data-asset="${escapeAttr(asset)}" class="btn btn-sm btn-primary shrink-0">List</button></div>`;
}

// ── Settings ──
function csfRenderSettings() {
  const k = CSF.key || { configured: false };
  el.csfloatBody.innerHTML = `
    <div class="max-w-lg space-y-5">
      <div>
        <h4 class="t14 font-bold text-slate-200 mb-1">CSFloat API key</h4>
        <p class="t10 text-slate-500 mb-3">Generate a key at <span class="text-brand-light">csfloat.com/profile → Developer</span>. Stored encrypted per-account in your vault; never shown again.</p>
        <form id="csf-key-form" class="flex gap-2">
          <input name="apiKey" type="password" autocomplete="off" placeholder="${k.configured ? 'configured (ending …' + escapeHtml(k.tail || '') + ') — paste to replace' : 'paste your CSFloat API key'}" class="field flex-1"/>
          <button type="submit" class="btn btn-primary">Save</button>
          ${k.configured ? '<button type="button" data-csf="clearkey" class="btn btn-danger">Clear</button>' : ''}
        </form>
        <p id="csf-key-msg" class="hidden t10 mt-2"></p>
      </div>
      <div class="surface px-4 py-3 flex items-center justify-between gap-3">
        <div><p class="t14 font-bold text-slate-200">Experimental features</p><p class="t10 text-slate-500">Buy Orders, Trades &amp; Inventory tabs + auto-accept. These use undocumented CSFloat endpoints that may change.</p></div>
        <button data-csf="experimental" class="btn btn-sm shrink-0 ${CSF.experimental ? 'btn-primary' : 'btn-secondary'}">${CSF.experimental ? 'ON' : 'OFF'}</button>
      </div>
    </div>`;
}

// ── delegation ──
function onCsfTabClick(e) { const b = e.target.closest('[data-csf-tab]'); if (b) csfSwitchTab(b.getAttribute('data-csf-tab')); }
function onCsfBodyClick(e) {
  const tabBtn = e.target.closest('[data-csf-tab]'); if (tabBtn) return csfSwitchTab(tabBtn.getAttribute('data-csf-tab'));
  // Row selection (checkboxes fire click before change; handled here so one delegated
  // listener covers a 300-row table instead of 300 individual listeners).
  const invCb = e.target.closest('[data-csf-inv]');
  if (invCb) { toggleSet(CSF.inv.sel, invCb.getAttribute('data-csf-inv'), invCb.checked); return csfRenderInventory(); }
  const lstCb = e.target.closest('[data-csf-lst]');
  if (lstCb) { toggleSet(CSF.lst.sel, lstCb.getAttribute('data-csf-lst'), lstCb.checked); return csfRenderListings(); }
  // One checkbox covers a whole stack (a buyer's 7 identical skins) or a whole buyer card, so the
  // selection is per TRADE id underneath — that is what /deliver takes.
  const trdCb = e.target.closest('[data-csf-trd-group]');
  if (trdCb) {
    for (const id of trdCb.getAttribute('data-csf-trd-group').split(',').filter(Boolean)) toggleSet(CSF.trd.sel, id, trdCb.checked);
    return csfRenderTrades();
  }

  const b = e.target.closest('[data-csf]'); if (!b) return;
  const act = b.getAttribute('data-csf');
  if (act === 'retry') return csfSwitchTab(CSF.tab);
  if (act === 'gosettings') return csfSwitchTab('settings');
  if (act === 'marketmore') return csfDoMarketSearch(false);
  if (act === 'clearkey') return csfClearKey();
  if (act === 'experimental') return csfToggleExperimental();
  if (act === 'autoaccept') return csfToggleAutoAccept(b);
  if (act === 'delist') return csfDelist(b.getAttribute('data-id'));
  if (act === 'delorder') return csfDeleteBuyOrder(b.getAttribute('data-id'));
  if (act === 'editprice') return csfEditPrice(b);
  if (act === 'buy') return csfBuy(b.getAttribute('data-id'), Number(b.getAttribute('data-price')), b.getAttribute('data-name'));
  if (act === 'listasset') return csfListAsset(b);
  if (act === 'loadprices') return csfRefreshPrices();
  if (act === 'selall') return csfSelectAll(b.getAttribute('data-scope'), true);
  if (act === 'selnone') return csfSelectAll(b.getAttribute('data-scope'), false);
  if (act === 'bulklist') return csfBulkList();
  if (act === 'bulkdelist') return csfBulkDelist();
  if (act === 'bulkreprice') return csfBulkReprice();
  if (act === 'bulkcancel') return api('/api/csfloat/bulk-cancel', { method: 'POST' }).catch(() => {});
  if (act === 'deliver') return csfDeliverTrades((b.getAttribute('data-ids') || '').split(',').filter(Boolean));
  if (act === 'delivercancel') return api('/api/csfloat/deliver-cancel', { method: 'POST' }).catch(() => {});
  if (act === 'refreshtrades') return csfLoadTrades();
}
function toggleSet(set, key, on) { if (on) set.add(key); else set.delete(key); }

/** Select-all / clear applies to the CURRENTLY FILTERED rows, never the hidden ones —
 *  filtering to "Case" then hitting Select all must not also pick the 200 items you filtered out. */
function csfSelectAll(scope, on) {
  if (scope === 'inv') {
    if (!on) CSF.inv.sel = new Set();
    else for (const it of csfVisibleInventory()) CSF.inv.sel.add(csfAsset(it));
    return csfRenderInventory();
  }
  if (scope === 'trd') {
    if (!on) CSF.trd.sel = new Set();
    // Only what can actually be sent: ticking rows that are already delivered or missing a buyer
    // would put a count on the Send button that the run can never meet.
    else for (const r of csfVisibleTrades()) { if (!csfDeliverable(r)) CSF.trd.sel.add(r.id); }
    return csfRenderTrades();
  }
  if (!on) CSF.lst.sel = new Set();
  else for (const l of csfVisibleListings()) CSF.lst.sel.add(String(l.id || l.listing_id || ''));
  csfRenderListings();
}

/** Re-renders whichever selectable tab is open. */
function csfRepaintTab() { (CSF.tab === 'inventory' ? csfRenderInventory : CSF.tab === 'trades' ? csfRenderTrades : csfRenderListings)(); }

async function csfRefreshPrices() {
  const names = (CSF.tab === 'inventory' ? CSF.inv.items : CSF.lst.items).map(csfName);
  CSF.prices.loading = true;
  csfRepaintTab();
  await csfLoadPrices(names, true);   // explicit click → re-ask even for names we already have
  csfRepaintTab();
}
/**
 * Strategy-bar inputs (filter / pricing mode / percent). These re-render the whole table, so
 * the focused field and caret are restored afterwards — otherwise typing a filter would lose
 * focus after the first keystroke.
 */
function onCsfBodyInput(e) {
  const t = e.target;
  const scopeEl = t.closest && t.closest('[data-csf-search]');
  const isMode = t.hasAttribute && t.hasAttribute('data-csf-mode');
  const isPct = t.hasAttribute && t.hasAttribute('data-csf-pct');
  // A per-row price: remember it, but do NOT re-render — that would fight the operator's typing.
  if (t.classList && t.classList.contains('csf-price')) {
    const row = t.closest('.csf-row');
    const key = row && (row.querySelector('[data-csf-inv]')?.getAttribute('data-csf-inv')
      || row.querySelector('[data-csf-lst]')?.getAttribute('data-csf-lst'));
    if (!key) return;
    const store = row.querySelector('[data-csf-inv]') ? CSF.inv.manual : CSF.lst.manual;
    const dollars = t.value === '' ? NaN : Number(t.value);
    if (Number.isFinite(dollars) && dollars >= 0.03) store[key] = Math.round(dollars * 100);
    else delete store[key];
    return;
  }
  if (!scopeEl && !isMode && !isPct) return;
  if (scopeEl) {
    const scope = scopeEl.getAttribute('data-csf-search');
    if (scope === 'inv') CSF.inv.search = t.value;
    else if (scope === 'trd') CSF.trd.search = t.value;
    else CSF.lst.search = t.value;
  }
  if (isMode) CSF.strategy.mode = t.value;
  if (isPct) CSF.strategy.pct = Math.max(0, Math.min(90, Number(t.value) || 0));
  const sel = t.selectionStart;
  csfRepaintTab();
  // Re-find the same control in the freshly rendered table and put the caret back.
  const again = el.csfloatBody.querySelector(
    scopeEl ? `[data-csf-search="${scopeEl.getAttribute('data-csf-search')}"]` : isMode ? '[data-csf-mode]' : '[data-csf-pct]');
  if (again) { again.focus(); if (sel != null && again.setSelectionRange) { try { again.setSelectionRange(sel, sel); } catch { /* number inputs reject this */ } } }
}

function onCsfBodySubmit(e) {
  if (e.target.id === 'csf-key-form') { e.preventDefault(); return csfSaveKey(e.target); }
  if (e.target.id === 'csf-market-form') { e.preventDefault(); return csfDoMarketSearch(true); }
  if (e.target.id === 'csf-bo-form') { e.preventDefault(); return csfCreateBuyOrder(e.target); }
}

// ── actions ──
async function csfSaveKey(form) {
  const apiKey = String(new FormData(form).get('apiKey') || '').trim();
  const msg = $('csf-key-msg');
  if (!apiKey) return csfMsg(msg, 'Enter a key first.', 'error');
  csfMsg(msg, 'Validating…', 'info');
  try {
    const r = await csfApi('/key', { method: 'PUT', body: JSON.stringify({ apiKey }) });
    CSF.key = { configured: true, tail: r.tail };
    csfMsg(msg, r.warning || 'Key saved & validated.', r.warning ? 'info' : 'ok');
    setTimeout(() => csfSwitchTab('dashboard'), 700);
  } catch (err) { csfMsg(msg, err.message, 'error'); }
}
async function csfClearKey() {
  if (!(await ssimConfirm({ title: 'Clear API key', body: 'Remove this account\'s CSFloat API key?', tone: 'danger', confirmLabel: 'Clear', confirmIcon: 'fa-xmark' }))) return;
  try { await csfApi('/key', { method: 'DELETE' }); CSF.key = { configured: false }; toast('CSFloat key cleared', 'success'); csfSwitchTab('settings'); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfToggleExperimental() {
  try { const r = await api('/api/csfloat/config', { method: 'PUT', body: JSON.stringify({ experimental: !CSF.experimental }) }); CSF.experimental = !!r.experimental; csfRenderTabs(); csfSwitchTab('settings'); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfToggleAutoAccept(btn) {
  // Derive the current state from data-enabled, which is set only on a successful /auto-accept
  // fetch (csfLoadTrades) — never from button text, which could reflect a fabricated default.
  const cur = btn.getAttribute('data-enabled') === '1';
  try { const r = await csfApi('/auto-accept', { method: 'PUT', body: JSON.stringify({ enabled: !cur }) }); toast(`Auto-accept ${r.enabled ? 'enabled' : 'disabled'}`, 'success'); csfSwitchTab('trades'); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfDelist(id) {
  if (!id || !(await ssimConfirm({ title: 'Delist', body: 'Remove this listing from CSFloat?', tone: 'danger', confirmLabel: 'Delist', confirmIcon: 'fa-xmark' }))) return;
  try { await csfApi('/listings/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Listing removed', 'success'); csfLoadListings(true); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfEditPrice(btn) {
  const id = btn.getAttribute('data-id');
  const cents = CSF.lst.manual[id];
  if (cents == null) return toast('Enter a new price first', 'error');
  try {
    await csfApi('/listings/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ price: cents }) });
    delete CSF.lst.manual[id];
    toast('Price updated', 'success');
    csfLoadListings(true);   // keep the selection — you're usually editing a few in a row
  } catch (err) { toast(err.message, 'error'); }
}
async function csfBuy(id, priceCents, name) {
  if (!id) return;
  if (!(await ssimConfirm({ title: 'Buy on CSFloat', tone: 'spend', confirmLabel: `Buy for ${csfUsd(priceCents)}`, confirmIcon: 'fa-cart-shopping', body: `Buy <b class="text-slate-100">${escapeHtml(name || 'this item')}</b> for <b class="text-teal-300">${csfUsd(priceCents)}</b> from your CSFloat balance?` }))) return;
  try { await csfApi('/buy', { method: 'POST', body: JSON.stringify({ listingId: id, totalPrice: priceCents }) }); toast('Purchase sent', 'success'); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfCreateBuyOrder(form) {
  const fd = new FormData(form);
  const body = { market_hash_name: String(fd.get('market_hash_name') || '').trim(), max_price: Math.round(Number(fd.get('max_price')) * 100), quantity: Math.round(Number(fd.get('quantity')) || 1) };
  if (!body.market_hash_name || !body.max_price) return toast('Name and max price are required', 'error');
  try { await csfApi('/buy-orders', { method: 'POST', body: JSON.stringify(body) }); toast('Buy order placed', 'success'); csfLoadBuyOrders(); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfDeleteBuyOrder(id) {
  if (!id || !(await ssimConfirm({ title: 'Cancel buy order', body: 'Cancel this buy order?', tone: 'danger', confirmLabel: 'Cancel order', confirmIcon: 'fa-xmark' }))) return;
  try { await csfApi('/buy-orders/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Buy order cancelled', 'success'); csfLoadBuyOrders(); }
  catch (err) { toast(err.message, 'error'); }
}
// ── bulk operations ──
async function csfBulkList() {
  // A typed price on a row ALWAYS wins over the suggestion — that's the escape hatch for the
  // float-blind name-level suggestion, so it must not be silently overwritten by the strategy.
  const items = [];
  for (const it of csfVisibleInventory()) {
    const asset = csfAsset(it);
    if (!CSF.inv.sel.has(asset)) continue;
    const name = csfName(it);
    const cents = CSF.inv.manual[asset] ?? csfSuggestPrice(name);
    if (cents == null) continue;                       // no price and none typed → skip, never guess
    items.push({ assetId: asset, priceCents: cents, name });
  }
  if (!items.length) return toast('Nothing to list — load prices or type one on the rows you want', 'warn');
  const total = items.reduce((n, i) => n + i.priceCents, 0);
  const preview = items.slice(0, 10).map((i) => `<div class="flex gap-2 t12"><span class="text-slate-200 truncate flex-1">${escapeHtml(i.name || i.assetId)}</span><span class="font-mono text-emerald-300 shrink-0">${csfUsd(i.priceCents)}</span></div>`).join('');
  const ok = await ssimConfirm({
    title: `List ${items.length} item(s) on CSFloat?`,
    tone: 'brand', confirmLabel: `List for ${csfUsd(total)}`, confirmIcon: 'fa-tags',
    body: `Create <b class="text-slate-100">${items.length}</b> buy-now listing(s) on <b>${escapeHtml(CSF.username)}</b>, totalling <b class="text-emerald-300">${csfUsd(total)}</b>:`
      + `<div class="mt-2 max-h-52 overflow-y-auto space-y-0.5 text-left">${preview}</div>`
      + (items.length > 10 ? `<div class="t10 text-slate-500 mt-1">…and ${items.length - 10} more</div>` : ''),
  });
  if (!ok) return;
  try { await csfApi('/bulk-list', { method: 'POST', body: JSON.stringify({ items }) }); csfPollBulk(); }
  catch (err) { toast(err.message, 'error'); }
}

async function csfBulkDelist() {
  const chosen = csfVisibleListings().filter((l) => CSF.lst.sel.has(String(l.id || l.listing_id || '')));
  if (!chosen.length) return toast('Select listing(s) to delist', 'warn');
  const names = {};
  for (const l of chosen) names[String(l.id || l.listing_id || '')] = csfName(l);
  const ok = await ssimConfirm({
    title: `Delist ${chosen.length} listing(s)?`, tone: 'danger', confirmLabel: 'Delist', confirmIcon: 'fa-xmark',
    body: `Remove <b class="text-slate-100">${chosen.length}</b> listing(s) from CSFloat. The items return to your inventory — this is reversible (you can re-list them).`,
  });
  if (!ok) return;
  try {
    await csfApi('/bulk-delist', { method: 'POST', body: JSON.stringify({ listingIds: Object.keys(names), names }) });
    csfPollBulk();
  } catch (err) { toast(err.message, 'error'); }
}

async function csfBulkReprice() {
  const items = [];
  for (const l of csfVisibleListings()) {
    const id = String(l.id || l.listing_id || '');
    if (!CSF.lst.sel.has(id)) continue;
    const want = csfSuggestReprice(l);
    if (want == null) continue;                       // already lowest, or no market data
    items.push({ listingId: id, priceCents: want, name: csfName(l), from: l.price ?? 0 });
  }
  if (!items.length) return toast('Nothing to reprice — the selected listings already hold the lowest ask', 'warn');
  const delta = items.reduce((n, i) => n + (i.priceCents - i.from), 0);
  const preview = items.slice(0, 10).map((i) => `<div class="flex gap-2 t12"><span class="text-slate-200 truncate flex-1">${escapeHtml(i.name)}</span><span class="font-mono text-slate-500 shrink-0">${csfUsd(i.from)} → </span><span class="font-mono text-brand-light shrink-0">${csfUsd(i.priceCents)}</span></div>`).join('');
  const ok = await ssimConfirm({
    title: `Reprice ${items.length} listing(s)?`, tone: 'brand', confirmLabel: 'Reprice', confirmIcon: 'fa-arrows-down-to-line',
    body: `Move <b class="text-slate-100">${items.length}</b> listing(s) to the ${CSF.strategy.mode === 'match' ? 'lowest ask' : CSF.strategy.mode === 'over' ? `lowest ask +${CSF.strategy.pct}%` : `lowest ask −${CSF.strategy.pct}%`}, `
      + `a total change of <b class="${delta < 0 ? 'text-amber-300' : 'text-emerald-300'}">${delta < 0 ? '−' : '+'}${csfUsd(Math.abs(delta))}</b>:`
      + `<div class="mt-2 max-h-52 overflow-y-auto space-y-0.5 text-left">${preview}</div>`
      + (items.length > 10 ? `<div class="t10 text-slate-500 mt-1">…and ${items.length - 10} more</div>` : ''),
  });
  if (!ok) return;
  try {
    await csfApi('/bulk-reprice', { method: 'POST', body: JSON.stringify({ items: items.map(({ listingId, priceCents, name }) => ({ listingId, priceCents, name })) }) });
    csfPollBulk();
  } catch (err) { toast(err.message, 'error'); }
}

/** Live progress for a running bulk job, pinned above the table. */
function csfPollBulk() {
  clearTimeout(CSF.bulkTimer);
  const label = { list: 'Listing', delist: 'Delisting', reprice: 'Repricing' };
  const tick = async () => {
    // The workspace modal may have been closed mid-job — stop polling, the job runs on regardless.
    if (!el.csfloatOverlay || el.csfloatOverlay.classList.contains('hidden')) { CSF.bulkTimer = null; return; }
    let j;
    try { j = await api('/api/csfloat/bulk-status'); }
    catch { CSF.bulkTimer = setTimeout(tick, 2000); return; }   // transient — keep watching
    let bar = document.getElementById('csf-bulk-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'csf-bulk-bar';
      bar.className = 'surface px-4 py-2.5 mb-3';
      el.csfloatBody.prepend(bar);
    }
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    bar.innerHTML = `<div class="flex items-center gap-3">
        <span class="t12 text-slate-200 font-semibold">${label[j.kind] || 'Working'} ${j.done}/${j.total}</span>
        <span class="t10 text-emerald-400">${j.ok} ok</span>
        ${j.failed ? `<span class="t10 text-rose-400">${j.failed} failed</span>` : ''}
        <span class="t10 text-slate-500 truncate flex-1">${escapeHtml(j.current || '')}</span>
        ${j.running ? '<button data-csf="bulkcancel" class="btn btn-danger btn-sm !py-0.5">Cancel</button>' : ''}
      </div>
      <div class="h-1.5 mt-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full rounded-full bg-brand transition-all" style="width:${pct}%"></div></div>
      ${j.failures && j.failures.length ? `<div class="mt-2 max-h-24 overflow-y-auto space-y-0.5">${j.failures.slice(0, 20).map(f => `<div class="t10 text-rose-300 truncate">${escapeHtml(f.name || f.ref)}: ${escapeHtml(f.error)}</div>`).join('')}</div>` : ''}`;
    if (j.running) { CSF.bulkTimer = setTimeout(tick, 900); return; }
    CSF.bulkTimer = null;
    if (j.error) toast(j.error, 'error');
    else toast(`${label[j.kind] || 'Done'}: ${j.ok} ok${j.failed ? `, ${j.failed} failed` : ''}${j.cancelled ? ' (cancelled)' : ''}`, j.failed ? 'warn' : 'success');
    // Re-read from CSFloat — the local rows are now wrong on both tabs whichever job ran.
    CSF.inv.sel = new Set(); CSF.lst.sel = new Set();
    if (CSF.tab === 'listings') await csfLoadListings();
    else if (CSF.tab === 'inventory') await csfLoadInventory();
  };
  tick();
}

async function csfListAsset(btn) {
  const asset = btn.getAttribute('data-asset');
  if (!asset) return toast('Missing asset id', 'error');
  // Typed price wins; otherwise fall back to the strategy suggestion shown on the row, so the
  // single-item List button lists at exactly the price the row is displaying.
  const item = CSF.inv.items.find((it) => csfAsset(it) === asset);
  const cents = CSF.inv.manual[asset] ?? (item ? csfSuggestPrice(csfName(item)) : null);
  if (cents == null) return toast('Enter a price first (or load CSFloat prices)', 'error');
  if (!(await ssimConfirm({ title: 'List on CSFloat', tone: 'brand', confirmLabel: `List for ${csfUsd(cents)}`, confirmIcon: 'fa-tag', body: `Create a CSFloat listing for <b class="text-slate-100">${escapeHtml(item ? csfName(item) : asset)}</b> at <b class="text-brand-light">${csfUsd(cents)}</b>?` }))) return;
  try {
    await csfApi('/listings', { method: 'POST', body: JSON.stringify({ asset_id: asset, price: cents, type: 'buy_now' }) });
    delete CSF.inv.manual[asset];
    toast('Listing created', 'success');
    csfLoadInventory(true);
  } catch (err) { toast(err.message, 'error'); }
}

// ── new / edit environment ──
async function openEnvModal(mode = 'create', id = null) {
  el.envForm.reset();
  if (mode === 'edit') {
    const env = state.environments.find((e) => e.id === id);
    state.envModal = { mode: 'edit', id };
    el.envModalTitle.innerHTML = '<i class="fa-solid fa-pen text-brand mr-2"></i>Edit environment';
    el.envSubmitLabel.textContent = 'Save';
    el.envNameInput.value = env ? env.name : '';
  } else {
    state.envModal = { mode: 'create' };
    el.envModalTitle.innerHTML = '<i class="fa-solid fa-layer-group text-brand mr-2"></i>New environment';
    el.envSubmitLabel.textContent = 'Create';
  }
  el.envOverlay.classList.remove('hidden');
  el.envNameInput.focus();
}
function closeEnvModal() { state.envModal = null; el.envOverlay.classList.add('hidden'); }
async function submitEnv(ev) {
  ev.preventDefault();
  const m = state.envModal || { mode: 'create' };
  const name = el.envNameInput.value.trim();
  if (!name) return;
  try {
    if (m.mode === 'edit') {
      await api(`/api/environments/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast('Environment updated', 'success');
    } else {
      await api('/api/environments', { method: 'POST', body: JSON.stringify({ name }) });
      toast(`Environment "${name}" created`, 'success');
    }
    closeEnvModal();
    await reloadAll();
    if (state.nav === 'accounts') renderAccountsModule();
    else if (state.screen === 'inventory' && state.activeEnv) { updateSidebar(); renderMain(); }
    else renderDashboard();
  } catch (err) { toast(err.message, 'error'); }
}
/**
 * Delete an environment. Lives in the Accounts module (owner 2026-08-25) — the same place
 * environments are created.
 *
 * An EMPTY environment deletes on a plain confirm, as before. A NON-EMPTY one now deletes too
 * (it used to be refused outright), taking its accounts with it — so it gets the heavier gate:
 * the exact account count, an explicit list of what is destroyed, and a typed "DELETE". The
 * accounts are removed from SSIM and their secrets purged from the vault; nothing happens to the
 * Steam accounts themselves.
 */
async function deleteEnvironment(id) {
  const env = state.environments.find((e) => e.id === id);
  if (!env) return toast('Environment not found', 'error');
  const name = env.name;
  const accs = state.allAccounts.filter((a) => a.environmentId === id);
  const cascade = accs.length > 0;

  // Name a few of the accounts outright — "12 accounts" is abstract, seeing @bot_04 in the list is not.
  const sample = accs.slice(0, 6).map((a) => `<span class="font-mono">@${escapeHtml(a.username)}</span>`).join(', ');
  const more = accs.length > 6 ? ` <span class="text-slate-500">and ${fmtCount(accs.length - 6)} more</span>` : '';

  const body = cascade
    ? `Delete environment <b class="text-slate-100">${escapeHtml(name)}</b> <b class="text-danger">and all ${fmtCount(accs.length)} account(s) in it</b>?<br><br>
       <span class="t12 text-slate-400">${sample}${more}</span><br><br>
       <span class="text-slate-500">For each account this removes it from SSIM, logs out its session, drops its cached inventories, and purges its password, refresh token, CSFloat key and proxy from the vault. Its folders and proxy rules go too.</span><br><br>
       <b class="text-danger">This cannot be undone.</b> <span class="text-slate-500">The Steam accounts themselves are not touched — but SSIM will no longer have their credentials.</span>`
    : `Delete environment <b class="text-slate-100">${escapeHtml(name)}</b>?<br><span class="text-slate-500">It holds no accounts.</span>`;

  if (!(await ssimConfirm({
    title: cascade ? 'Delete environment and its accounts' : 'Delete environment',
    tone: 'danger', confirmLabel: cascade ? `Delete ${fmtCount(accs.length)} account(s)` : 'Delete', confirmIcon: 'fa-trash',
    body,
    typedWord: cascade ? 'DELETE' : null,
  }))) return;

  try {
    await api(`/api/environments/${encodeURIComponent(id)}${cascade ? '?cascade=1' : ''}`, { method: 'DELETE' });
    toast(cascade ? `Environment "${name}" and ${accs.length} account(s) deleted` : `Environment "${name}" deleted`, 'success');
    // Drop every local reference to the environment before repainting, so no view is left pointing
    // at something the server no longer has. Deleting the environment you are standing in is the
    // normal case (the header's Delete button), not an edge case.
    state.globalEnvs.delete(id);
    if (state.accEnv === id) { state.accEnv = null; state.accountsUser = null; state.accSel.clear(); }
    // The Inventories module keeps its own drill-down state. Reset it the same way its own
    // "back to all inventories" path does, rather than hand-poking state.screen — otherwise
    // returning to Inventories re-enters a deleted environment.
    // state.tree is dereferenced unguarded (renderNodes, findFolderNode) — reset it to its EMPTY
    // shape, never null.
    if (state.activeEnv === id) { state.invMode = 'account'; state.activeEnv = null; state.activeUsername = null; state.tree = { folders: [], accounts: [] }; }
    invalidateStructureCaches();
    await reloadAll();
    if (state.nav === 'accounts') renderAccountsModule();
    else if (state.nav === 'inventories') enterInventories();
    else renderDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

// ── folder create / rename ──
function openFolderModal(action) {
  state.folderModal = action;
  const creating = action.mode === 'create';
  el.folderTitle.innerHTML = creating
    ? '<i class="fa-solid fa-folder-plus text-brand mr-2"></i>New folder'
    : '<i class="fa-solid fa-pen text-brand mr-2"></i>Rename folder';
  el.folderName.value = creating ? '' : (action.name || '');
  el.folderOverlay.classList.remove('hidden');
  el.folderName.focus();
}
function closeFolderModal() { state.folderModal = null; el.folderOverlay.classList.add('hidden'); }
async function submitFolder(ev) {
  ev.preventDefault();
  const action = state.folderModal;
  if (!action) return;
  const name = el.folderName.value.trim();
  if (!name) return;
  try {
    if (action.mode === 'create') {
      // environmentId travels with the action (Accounts-tree adds) — state.activeEnv only backs
      // the legacy Inventories path, where the modal always opens inside an environment.
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ name, environmentId: action.environmentId ?? state.activeEnv, parentId: action.parentId ?? null }) });
      if (action.parentId) { state.collapsed.delete(action.parentId); saveCollapsed(); state.accTree.expanded.add(action.parentId); }
      toast(`Folder "${name}" created`, 'success');
    } else {
      await api(`/api/folders/${encodeURIComponent(action.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast('Folder renamed', 'success');
    }
    closeFolderModal();
    invalidateStructureCaches();
    if (state.nav === 'accounts') renderAccountsModule();
    else if (state.activeEnv) await refreshEnv();
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteFolder(id, name) {
  if (!(await ssimConfirm({
    title: 'Delete folder', tone: 'danger', confirmLabel: 'Delete folder', confirmIcon: 'fa-trash',
    body: `Delete folder <b class="text-slate-100">${escapeHtml(name)}</b>?<br><span class="text-slate-500">Subfolders and accounts move to the parent folder.</span>`,
  }))) return;
  try {
    await api(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.collapsed.delete(id); saveCollapsed();
    toast(`Folder "${name}" deleted`, 'success');
    await refreshEnv();
  } catch (err) { toast(err.message, 'error'); }
}

/** Moves a folder one step up/down among its siblings, then reloads the tree. */
async function reorderFolder(id, direction) {
  try {
    await api(`/api/folders/${encodeURIComponent(id)}/reorder`, {
      method: 'POST', body: JSON.stringify({ direction }),
    });
    await refreshEnv();
  } catch (err) { toast(err.message, 'error'); }
}

// ── move account (folder + environment) — single username OR an array (batch multi-select) ──
async function openMoveModal(usernameOrList) {
  const list = Array.isArray(usernameOrList) ? usernameOrList : [usernameOrList];
  if (list.length === 0) { toast('No accounts selected', 'warn'); return; }
  state.moveUsernames = list;
  state.moveUsername  = list.length === 1 ? list[0] : null; // back-compat for any single-path callers
  const single = list.length === 1 ? state.allAccounts.find((a) => a.username === list[0]) : null;
  el.moveLabel.textContent = single
    ? `Move "${single.displayName || single.username}":`
    : `Move ${list.length} selected account(s):`;
  el.moveEnv.innerHTML = state.environments.map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  // Preselect: the single account's env → the Inventories active env → the Accounts module's env.
  el.moveEnv.value = single?.environmentId || state.activeEnv || state.accEnv || (state.environments[0]?.id ?? '');
  // For a batch the source folder is ambiguous → start at root; for a single account preselect its folder.
  await populateMoveFolders(el.moveEnv.value, single?.folderId);
  el.moveOverlay.classList.remove('hidden');
}
function closeMoveModal() { state.moveUsername = null; state.moveUsernames = null; el.moveOverlay.classList.add('hidden'); }
async function populateMoveFolders(envId, selectedFolderId) {
  let opts = [];
  try {
    const tree = await api(`/api/environments/${encodeURIComponent(envId)}/tree`);
    const walk = (nodes, d) => { for (const n of nodes) { opts.push({ id: n.folder.id, name: n.folder.name, depth: d }); walk(n.children, d + 1); } };
    walk(tree.folders, 0);
  } catch { opts = []; }
  el.moveFolder.innerHTML = `<option value="">— Root —</option>` + opts.map((o) => `<option value="${escapeAttr(o.id)}">${'&nbsp;&nbsp;'.repeat(o.depth)}${escapeHtml(o.name)}</option>`).join('');
  if (selectedFolderId) el.moveFolder.value = selectedFolderId;
}
async function submitMove(ev) {
  ev.preventDefault();
  const usernames = state.moveUsernames || (state.moveUsername ? [state.moveUsername] : []);
  if (usernames.length === 0) return;
  const environmentId = el.moveEnv.value;
  const folderId = el.moveFolder.value || null;
  try {
    // Same per-account move route the single menu uses, applied to each selected account.
    const results = await Promise.allSettled(usernames.map((u) =>
      api(`/api/accounts/${encodeURIComponent(u)}/move`, { method: 'POST', body: JSON.stringify({ folderId, environmentId }) })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    const moved  = results.length - failed;
    if (folderId) { state.collapsed.delete(folderId); saveCollapsed(); }
    closeMoveModal();
    if (failed) toast(`${moved} moved, ${failed} failed`, moved ? 'warn' : 'error');
    else        toast(usernames.length === 1 ? 'Account moved' : `${moved} accounts moved`, 'success');
    await reloadAll();
    if (state.nav === 'accounts') { state.accSel.clear(); renderAccountsModule(); }
    else if (state.activeEnv) await refreshEnv();
  } catch (err) { toast(err.message, 'error'); }
}

/** Batch-delete every selected account (mirrors the single-account "Remove account" flow,
 *  same DELETE route, looped). maFiles are kept — re-add via "Import bots". */
async function batchDeleteAccounts(usernames) {
  if (!usernames || usernames.length === 0) { toast('No accounts selected', 'warn'); return; }
  if (!(await ssimConfirm({
    title: 'Remove accounts', tone: 'danger', confirmLabel: `Remove ${usernames.length} account(s)`, confirmIcon: 'fa-trash-can',
    body: `Remove <b class="text-slate-100">${usernames.length}</b> selected account(s) from SSIM?<br>They are logged out and their inventory caches cleared. The maFiles are kept — re-add them any time via “Import bots”.`,
  }))) return;

  try {
    const results = await Promise.allSettled(usernames.map((u) =>
      api(`/api/accounts/${encodeURIComponent(u)}`, { method: 'DELETE' })));
    const failed  = results.filter((r) => r.status === 'rejected').length;
    const removed = results.length - failed;
    // The selection scope just shrank to zero → clear it and fall back to the env master.
    clearAccountSelection();
    if (state.invMode === 'account' && usernames.includes(state.activeUsername)) selectEnvMaster();
    await reloadAll();
    if (state.activeEnv) await refreshEnv();
    if (failed) toast(`${removed} removed, ${failed} failed`, removed ? 'warn' : 'error');
    else        toast(`${removed} account(s) removed`, 'success');
  } catch (err) { toast(`Delete failed: ${err.message}`, 'error'); }
}

// ════════════════════════════════════════════════════════════════════════════
//  Ban Checker — account / folder / multi-select scope
//  Scans the given accounts for every Steam ban type, renders a summary + a
//  collapsible accordion per category, and lets the operator bulk-move an entire
//  category into a folder (reusing the strict folder Move modal / move route).
// ════════════════════════════════════════════════════════════════════════════

// Category display order + styling. Literal class strings (Tailwind-JIT safe, like toasts).
const BAN_CATS = [
  { key: 'clean',     label: 'Clean',                  icon: 'fa-circle-check',         text: 'text-emerald-400', pill: 'success', acc: 'border-slate-800 bg-slate-950/40',        movable: false },
  { key: 'vac',       label: 'VAC Banned',             icon: 'fa-ban',                  text: 'text-rose-400',    pill: 'danger',  acc: 'border-rose-800/40 bg-rose-900/10',       movable: true  },
  { key: 'game',      label: 'Game Banned',            icon: 'fa-gamepad',              text: 'text-orange-400',  pill: 'warn',    acc: 'border-orange-800/40 bg-orange-900/10',   movable: true  },
  { key: 'community', label: 'Community Banned',       icon: 'fa-comment-slash',        text: 'text-amber-400',   pill: 'neutral', acc: 'border-amber-800/40 bg-amber-900/10',     movable: true  },
  { key: 'economy',   label: 'Economy / Trade Banned', icon: 'fa-handshake-slash',      text: 'text-fuchsia-400', pill: 'danger',  acc: 'border-fuchsia-800/40 bg-fuchsia-900/10', movable: true  },
  { key: 'error',     label: 'Lookup Failed',          icon: 'fa-triangle-exclamation', text: 'text-slate-400',   pill: 'listed',  acc: 'border-sky-800/40 bg-sky-900/10',         movable: false },
];

/** Opens the Ban Checker for a set of accounts and renders the result modal.
 *  H-TRD-033: a cold whole-fleet check can run past the client's 120s request budget, so we START a
 *  detached backend job (202) then POLL /api/bans/status until it delivers a result — the modal shows
 *  advancing progress and completes even when the run exceeds two minutes, and a second start while one
 *  is running gets the 409 toast instead of piling a concurrent run on top. */
async function openBanChecker(usernames, scopeLabel) {
  const list = [...new Set((usernames || []).filter(Boolean))];
  if (list.length === 0) { toast('No accounts to check', 'warn'); return; }
  state.banResult = null;
  clearTimeout(state.banTimer);
  el.banScope.textContent = scopeLabel ? `· ${scopeLabel}` : `· ${list.length} account(s)`;
  el.banSummary.innerHTML = `<div class="text-sm text-slate-400 flex items-center gap-2"><i class="fa-solid fa-spinner cs2-spin"></i>Starting ban check for ${list.length} account(s)…</div>`;
  el.banBody.innerHTML = '';
  el.banOverlay.classList.remove('hidden');   // → FB-04 onModalOpen
  try {
    await api('/api/bans/check', { method: 'POST', body: JSON.stringify({ usernames: list }) });
  } catch (err) {
    // A 409 (already running) is an expected single-flight rejection — surface it plainly and toast.
    if (err.status === 409) toast(err.message || 'A ban check is already running', 'warn');
    el.banSummary.innerHTML = `<div class="text-sm text-rose-400"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>${escapeHtml(err.message)}</div>`;
    return;
  }
  resetPoller('ban'); resetPoller('banErr'); // clean stall windows for this run (#27)
  pollBanCheck();
}

/** Polls the detached ban-check job every 1.5s, rendering live progress until a result/error arrives.
 *  S17: a transient status-fetch error retries (bounded) rather than killing the poll while the job runs. */
function pollBanCheck() {
  clearTimeout(state.banTimer);
  state.banTimer = setTimeout(async () => {
    let job;
    try { job = await api('/api/bans/status'); resetPoller('banErr'); }
    catch (err) {
      // Bound the error-retry loop: stop after POLL_STALL_MS of continuous status errors (S17).
      if (pollerStalled('banErr', 0)) {
        resetPoller('banErr');
        el.banSummary.innerHTML = `<div class="text-sm text-rose-400"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>${escapeHtml(err.message || 'Lost contact with the ban check')}</div>`;
        return;
      }
      state.banTimer = setTimeout(pollBanCheck, 1500); return;
    }
    if (job.result) { resetPoller('ban'); state.banResult = job.result; renderBanResult(job.result); return; }
    if (!job.running && job.error) {
      resetPoller('ban');
      el.banSummary.innerHTML = `<div class="text-sm text-rose-400"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>${escapeHtml(job.error)}</div>`;
      return;
    }
    // Still running — show which phase we're in and advance the stall guard on any counter movement.
    const p = job.progress || {};
    const done = (p.resolved || 0) + (p.keysAcquired || 0) + (p.checked || 0);
    if (pollerStalled('ban', done)) {
      resetPoller('ban');
      el.banSummary.innerHTML = `<div class="text-sm text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>The ban check appears stuck (no progress) — stopping the live updater. Check the server.</div>`;
      return;
    }
    const total = p.total || 0;
    const label = (p.checked || 0) > 0
      ? `Checked ${p.checked} of ${total}…`
      : (p.keysAcquired || 0) > 0
        ? `Acquiring keys… (${p.keysAcquired} ready)`
        : `Resolving SteamIDs… (${p.resolved || 0} of ${total})`;
    el.banSummary.innerHTML = `<div class="text-sm text-slate-400 flex items-center gap-2"><i class="fa-solid fa-spinner cs2-spin"></i>${escapeHtml(label)}</div>`;
    pollBanCheck();
  }, 1500);
}

function closeBan() { state.banResult = null; clearTimeout(state.banTimer); el.banOverlay.classList.add('hidden'); }

/** Account-level trigger (single account from the sidebar row). */
function checkAccountBans(username) {
  const acc = state.allAccounts.find((a) => a.username === username);
  openBanChecker([username], acc?.displayName || username);
}

/** Folder-level trigger: every account in the folder's subtree. */
function checkFolderBans(folderId) {
  const node = findFolderNode(state.tree.folders, folderId);
  if (!node) { toast('Folder not found', 'warn'); return; }
  const usernames = collectFolderAccounts(node).map((a) => a.username);
  openBanChecker(usernames, node.folder.name);
}

/** Groups the result by category (an account can appear in several ban buckets). */
function groupBanAccounts(res) {
  const groups = { clean: [], vac: [], game: [], community: [], economy: [], error: [] };
  for (const a of res.accounts || []) {
    if (a.error) { groups.error.push(a); continue; }
    for (const c of a.categories || []) if (groups[c]) groups[c].push(a);
  }
  return groups;
}

function renderBanResult(res) {
  const groups = groupBanAccounts(res);
  const t = res.totals || {};

  // Summary header: one chip per category with its count (errors only shown when present).
  el.banSummary.innerHTML = `
    <div class="flex flex-wrap items-center gap-2">
      <span class="t10 uppercase tracking-wide text-slate-500 font-semibold mr-1">${t.total || 0} checked</span>
      ${BAN_CATS.filter((c) => c.key !== 'error' || (t.error || 0) > 0).map((c) => `
        <span class="pill pill--${c.pill}">
          <i class="fa-solid ${c.icon}"></i>${escapeHtml(c.label)}
          <span class="font-mono">${(groups[c.key] || []).length}</span>
        </span>`).join('')}
    </div>`;

  // Accordions: one per non-empty category (Clean + each ban type + errors).
  const sections = BAN_CATS
    .filter((c) => (groups[c.key] || []).length > 0)
    .map((c) => banAccordion(c, groups[c.key]))
    .join('');
  el.banBody.innerHTML = sections || `<p class="t13 text-slate-500 px-2 py-4 text-center">No accounts to display.</p>`;
}

function banAccordion(cat, accounts) {
  const moveBtn = cat.movable
    ? `<button data-ban-move="${escapeAttr(cat.key)}" title="Move every account in this category into a folder"
         class="btn btn-sm btn-secondary ml-auto shrink-0"><i class="fa-solid fa-folder-tree"></i>Move this Category</button>`
    : '';
  const rows = accounts.map((a) => banAccountRow(a, cat.key)).join('');
  return `
    <div class="rounded-xl border ${cat.acc} overflow-hidden">
      <div data-ban-toggle="${escapeAttr(cat.key)}" class="flex items-center gap-2.5 px-4 py-3 cursor-pointer select-none">
        <i class="fa-solid fa-chevron-right ban-caret t10 text-slate-500 transition-transform"></i>
        <i class="fa-solid ${cat.icon} ${cat.text}"></i>
        <span class="t14 font-semibold ${cat.text}">${escapeHtml(cat.label)}</span>
        <span class="pill pill--${cat.pill} font-mono">${accounts.length}</span>
        ${moveBtn}
      </div>
      <div class="ban-acc-body hidden border-t border-slate-800/60 divide-y divide-slate-800/60">${rows}</div>
    </div>`;
}

/** Small coloured tags describing one account's specific bans. */
function banTags(a) {
  if (a.error) return `<span class="pill pill--listed">${escapeHtml(a.error)}</span>`;
  const tags = [];
  if (a.vacBanned)       tags.push(`<span class="pill pill--danger">VAC${a.vacCount > 1 ? ` ×${a.vacCount}` : ''}</span>`);
  if (a.gameBanned)      tags.push(`<span class="pill pill--warn">Game${a.gameCount > 1 ? ` ×${a.gameCount}` : ''}</span>`);
  if (a.communityBanned) tags.push(`<span class="pill pill--neutral">Community</span>`);
  if (a.economyBan && a.economyBan !== 'none') tags.push(`<span class="pill pill--danger">Trade: ${escapeHtml(a.economyBan)}</span>`);
  if (!tags.length) tags.push(`<span class="pill pill--success">No bans</span>`);
  if (typeof a.daysSinceLastBan === 'number' && a.daysSinceLastBan > 0 && !a.error)
    tags.push(`<span class="t10 text-slate-500">${a.daysSinceLastBan}d since last ban</span>`);
  return tags.join(' ');
}

function banAccountRow(a, catKey) {
  const name = a.displayName && a.displayName !== a.username ? `${a.displayName}` : a.username;
  return `
    <div class="flex items-center justify-between gap-3 px-4 py-2">
      <span class="min-w-0 flex-1 t13 text-slate-300 truncate">${escapeHtml(name)}${a.steamId ? ` <span class="t10 font-mono text-slate-600">${escapeHtml(a.steamId)}</span>` : ''}</span>
      <span class="flex items-center gap-1.5 flex-wrap justify-end shrink-0">${banTags(a)}</span>
    </div>`;
}

/** Delegated clicks inside the ban modal: category toggle + "Move this Category". */
function onBanBodyClick(e) {
  const moveBtn = e.target.closest('[data-ban-move]');
  if (moveBtn) {
    const key = moveBtn.dataset.banMove;
    const groups = state.banResult ? groupBanAccounts(state.banResult) : null;
    const usernames = groups ? (groups[key] || []).map((a) => a.username) : [];
    if (usernames.length === 0) { toast('No accounts in this category', 'warn'); return; }
    // Reuse the exact folder Move modal + strict per-account move route. It layers above
    // this (z-40 > z-30); this modal stays open so several categories can be quarantined.
    openMoveModal(usernames);
    return;
  }
  const header = e.target.closest('[data-ban-toggle]');
  if (header) {
    const body = header.parentElement.querySelector('.ban-acc-body');
    const caret = header.querySelector('.ban-caret');
    if (body) body.classList.toggle('hidden');
    if (caret) caret.classList.toggle('rotate-90', body && !body.classList.contains('hidden'));
  }
}

// ── send-trade (single account OR folder mass-send) ──
async function openTradeModal() {
  const isFolder = aggMode();
  const refs = isFolder ? selectedItemRefs() : null;
  const count = isFolder ? refs.length : selectedAssetIds().length;
  if (count === 0) { toast('No items selected', 'warn'); return; }

  el.tradeSummary.textContent = `${count} Item(s)`;
  if (isFolder) {
    const bots = new Set(refs.map((r) => r.username)).size;
    el.tradeFrom.textContent = `${bots} Bot(s): (${selectionBotNames(refs)})`;
  } else {
    el.tradeFrom.textContent = state.activeUsername;
  }

  // Reset target picker. Default environment = the source account's env (else active env / first).
  state.tradeTarget = null;
  const fromAcc = state.allAccounts.find((a) => a.username === state.activeUsername);
  const defaultEnv = (isFolder ? state.activeEnv : fromAcc?.environmentId) || state.activeEnv
    || (state.environments[0] && state.environments[0].id) || '';
  el.tradeEnv.innerHTML = state.environments
    .map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  if (defaultEnv) el.tradeEnv.value = defaultEnv;
  el.tradeSearch.value = '';

  el.tradeForm.querySelector('input[name="target"][value="internal"]').checked = true;
  el.tradeTargetUrl.value = '';
  updateTradeTargetVisibility();
  el.tradeOverlay.classList.remove('hidden');
  await populateTradeFolders();   // depends on env; resets folder → builds recipient list
}
function closeTradeModal() { el.tradeOverlay.classList.add('hidden'); }
function tradeTargetMode() { const r = el.tradeForm.querySelector('input[name="target"]:checked'); return r ? r.value : 'internal'; }
function updateTradeTargetVisibility() {
  const internal = tradeTargetMode() === 'internal';
  el.tradeInternal.classList.toggle('hidden', !internal);
  el.tradeExternal.classList.toggle('hidden', internal);
}

// ── target picker: environment → folder → recipient (Feature 2) ──
/** Fetches the selected env's folder tree → flat dropdown, then rebuilds the recipient list. */
async function populateTradeFolders() {
  const opts = [];
  state.tradeFolderName = {};
  try {
    const tree = await api(`/api/environments/${encodeURIComponent(el.tradeEnv.value)}/tree`);
    const walk = (nodes, d) => { for (const n of nodes) { opts.push({ id: n.folder.id, name: n.folder.name, depth: d }); state.tradeFolderName[n.folder.id] = n.folder.name; walk(n.children, d + 1); } };
    walk(tree.folders || [], 0);
  } catch { /* env may have no folders – fine */ }
  el.tradeFolder.innerHTML =
    `<option value="all">All folders</option>` +
    `<option value="__root__">— no folder —</option>` +
    opts.map((o) => `<option value="${escapeAttr(o.id)}">${'  '.repeat(o.depth)}${escapeHtml(o.name)}</option>`).join('');
  buildRecipientList();
}

/** Filters state.allAccounts by env + folder + search and renders the clickable recipient list. */
function buildRecipientList() {
  const envId  = el.tradeEnv.value;
  const folder = el.tradeFolder.value;
  const q      = el.tradeSearch.value.trim().toLowerCase();
  const isFolder = aggMode();

  let list = state.allAccounts.filter((a) => a.environmentId === envId);
  if (!isFolder) list = list.filter((a) => a.username !== state.activeUsername); // can't send to self
  if (folder === '__root__') list = list.filter((a) => !a.folderId);
  else if (folder !== 'all')  list = list.filter((a) => a.folderId === folder);
  if (q) list = list.filter((a) => `${a.username} ${a.displayName || ''}`.toLowerCase().includes(q));

  // Drop a stale selection that fell out of the current filter.
  if (state.tradeTarget && !list.some((a) => a.username === state.tradeTarget)) state.tradeTarget = null;

  el.tradeListEmpty.classList.toggle('hidden', list.length > 0);
  el.tradeList.classList.toggle('hidden', list.length === 0);
  el.tradeList.innerHTML = list.map(recipientRow).join('');
  el.tradeList.querySelectorAll('[data-recip]').forEach((r) =>
    r.addEventListener('click', () => { state.tradeTarget = r.dataset.recip; buildRecipientList(); }));

  const selName = state.tradeTarget;
  el.tradeListCount.textContent = selName
    ? `Selected: ${selName}`
    : `${list.length} account(s) · click to select`;
}

function recipientRow(a) {
  const sel = state.tradeTarget === a.username;
  const folderName = a.folderId && state.tradeFolderName[a.folderId] ? state.tradeFolderName[a.folderId] : 'no folder';
  return `<button type="button" data-recip="${escapeAttr(a.username)}"
    class="w-full flex items-center gap-2.5 px-3 py-2 text-left transition ${sel ? 'bg-brand/15 ring-1 ring-inset ring-brand/50' : 'hover:bg-slate-800/60'}">
    <span class="avatar shrink-0" style="width:2rem;height:2rem">
      <i class="fa-solid fa-user ${sel ? 'text-brand' : 'text-slate-500'}"></i></span>
    <span class="flex-1 min-w-0">
      <span class="block t13 truncate ${sel ? 'text-brand font-semibold' : 'text-slate-200'}">${escapeHtml(a.displayName || a.username)}</span>
      <span class="block t10 text-slate-500 truncate"><i class="fa-solid fa-folder mr-1"></i>${escapeHtml(folderName)}</span>
    </span>
    ${sel ? '<i class="fa-solid fa-check text-brand text-sm shrink-0"></i>' : ''}</button>`;
}

/** Reads the chosen target from the modal → { toUsername } | { tradeUrl } | null. */
function readTradeTarget() {
  if (tradeTargetMode() === 'internal') {
    const to = state.tradeTarget;
    if (!to) { toast('No target account selected', 'warn'); return null; }
    return { toUsername: to };
  }
  const url = el.tradeTargetUrl.value.trim();
  if (!url) { toast('No trade link', 'warn'); return null; }
  return { tradeUrl: url };
}

async function submitTrade(ev) {
  ev.preventDefault();
  if (aggMode()) return submitMassTrade();

  const from = state.activeUsername;
  const assetIds = selectedAssetIds();
  if (!from || assetIds.length === 0) return;
  const target = readTradeTarget();
  if (!target) return;

  setButtonLoading(el.tradeSubmit, true, 'Sending…');
  try {
    const res = await api('/api/trade/send', { method: 'POST', body: JSON.stringify({ from, assetIds, appId: currentAppId(), contextId: '2', ...target }) });
    closeTradeModal(); clearSelection();
    if (res.status === 'unconfirmed') {
      // Offer EXISTS on Steam but 2FA confirmation failed — confirm it manually, and do
      // NOT resend (a resend = a SECOND real-asset offer). #28.
      toast(`Offer #${res.offerId} SENT but NOT 2FA-confirmed — confirm it manually in Steam, do NOT resend`, 'warn');
    } else {
      const label = res.status === 'confirmed' ? 'sent & 2FA-confirmed' : 'sent';
      toast(`Trade #${res.offerId} ${label} → ${res.to}`, 'success');
    }
    renderMain();
    // The sent items must stop showing as owned/tradable/sellable, or the operator could
    // re-send/re-sell them (W). Steam needs a few seconds to actually move them (the backend's
    // own post-trade refresh waits ~8s too), so re-pull the affected accounts after that window
    // to reflect the new truth without a manual refresh. (INV-E1.)
    const affected = target.toUsername ? [from, target.toUsername] : [from];
    setTimeout(() => { try { startInventoryRefresh({ usernames: affected, game: state.game }); } catch (_) { /* best-effort */ } }, 9000);
  } catch (err) {
    // Money-safety (#28): a send that failed AFTER dispatch may still have placed an
    // offer. If the backend flagged verifyBeforeRetry, refresh the sender and warn
    // against a blind resend rather than presenting a clean retry.
    if (err.data?.verifyBeforeRetry) {
      toast(`Send may have placed an offer (${err.message}) — verify the sender's outgoing offers before retrying`, 'error');
      if (from) startInventoryRefresh({ usernames: [from] });
    } else {
      toast(`Trade failed: ${err.message}`, 'error');
    }
  }
  finally { setButtonLoading(el.tradeSubmit, false, 'Send & confirm', 'fa-paper-plane'); }
}

// ── v2.1: mass-send (folder → storage) ──
async function submitMassTrade() {
  const items = selectedItemRefs();
  if (items.length === 0) return;
  const target = readTradeTarget();
  if (!target) return;

  setButtonLoading(el.tradeSubmit, true, 'Starting…');
  try {
    const job = await api('/api/trade/mass-send', { method: 'POST', body: JSON.stringify({ items, appId: currentAppId(), contextId: '2', ...target }) });
    closeTradeModal(); clearSelection(); renderMain();
    showMassProgress(job);
    resetPoller('mass'); // clean stall window for this run (#27)
    pollMass();
    toast(`Mass trade started: ${job.bots} bot(s), ${job.totalItems} items`, 'success');
  } catch (err) {
    toast(`Mass trade failed: ${err.message}`, 'error');
  } finally {
    setButtonLoading(el.tradeSubmit, false, 'Send & confirm', 'fa-paper-plane');
  }
}
function showMassProgress(job) {
  el.massProgress.classList.remove('hidden');
  el.massBar.style.width = '0%';
  el.massCount.textContent = `0/${job.bots}`;
  el.massDetail.textContent = 'Processing queue (max. 2 at a time)…';
  resetEndBtn(el.massEnd); // fresh run → re-enable the End task button
}
// ── "End Task": confirmed, co-operative cancel of a running mass action ──
// The confirm step is MANDATORY (no instant kill). On confirm we POST the cancel
// endpoint, which sets a server-side flag; the running job winds down cleanly
// (the in-flight account finishes, the rest are skipped). The existing poller then
// reports the job as done as usual.
function resetEndBtn(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-stop"></i><span>End task</span>';
}
async function endTask({ label, endpoint, button }) {
  if (!(await ssimConfirm({
    title: 'End task?',
    tone: 'danger',
    confirmLabel: 'End task',
    confirmIcon: 'fa-stop',
    body: `Are you sure you want to end <b class="text-slate-100">${escapeHtml(label)}</b>?<br>`
        + `<span class="text-slate-400">The account already in progress finishes; the remaining accounts are skipped.</span>`,
  }))) return;
  if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i><span>Stopping…</span>'; }
  try {
    await api(endpoint, { method: 'POST' });
    toast(`Stopping ${label} — remaining accounts will be skipped.`, 'warn');
  } catch (err) {
    toast(`Could not end task: ${err.message}`, 'error');
    resetEndBtn(button);
  }
}

/** Surfaces parsed mass-trade failure reasons (Steam's actual errors) as persistent
 *  error toasts — identical reasons are grouped so one full inventory + many accounts
 *  reads as a single clear warning rather than dozens of duplicate toasts. */
function surfaceTradeFailures(failed) {
  const groups = new Map(); // reason → [usernames]
  for (const f of failed || []) {
    const reason = String(f.error || 'Unknown error');
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(f.username);
  }
  const reasons = [...groups.entries()];
  reasons.slice(0, 4).forEach(([reason, users]) => {
    const who = users.length <= 3 ? users.join(', ') : `${users.slice(0, 3).join(', ')} +${users.length - 3} more`;
    toast(`${reason} — ${who}`, 'error');
  });
  if (reasons.length > 4) toast(`+${reasons.length - 4} more distinct failure reason(s) — see server logs`, 'warn');
}

function pollMass() {
  clearTimeout(state.massTimer);
  state.massTimer = setTimeout(async () => {
    try {
      const job = await api('/api/trade/mass-status');
      resetPoller('massErr'); // S17: a good poll clears the error-retry window
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      el.massBar.style.width = pct + '%';
      el.massCount.textContent = `${job.done}/${job.total}`;
      el.massDetail.textContent = job.cancelling
        ? 'Cancelling — finishing the offer in flight, skipping the rest…'
        : `${job.confirmed} confirmed · ${job.failed.length} failed`;
      if (job.running) {
        // While cancelling we keep polling but DON'T trip the stall guard (deliberate halt).
        if (!job.cancelling && pollerStalled('mass', job.done)) {
          toast('Mass trade appears stuck (no progress) – stopping the live updater. Check the server.', 'warn');
          el.massProgress.classList.add('hidden'); resetPoller('mass'); return;
        }
        pollMass(); return;
      }
      resetPoller('mass');

      // LIVE REACTIVITY: re-pull the cache + re-render the active Master/Env/Global view so the
      // moved items + balances reflect immediately (game-aware; also refreshes the account list).
      await refreshActiveViewFromCache();
      // Bubble Steam's ACTUAL failure reasons up to the operator (incl. full-inventory).
      if (job.failed.length) surfaceTradeFailures(job.failed);
      const verb = job.stopReason ? `stopped (${job.stopReason})` : (job.cancelled ? 'ended' : 'done');
      toast(`Mass trade ${verb}: ${job.confirmed} confirmed${job.failed.length ? `, ${job.failed.length} failed` : ''}`, job.failed.length ? 'warn' : 'success');
      setTimeout(() => el.massProgress.classList.add('hidden'), 3500);
    } catch (err) {
      // S17: bounded error-retry — a transient status-fetch error must not kill the poller while the
      // mass-send runs (else the completion re-pull never fires). Give up only after POLL_STALL_MS of errors.
      if (!pollerStalled('massErr', 0)) { pollMass(); return; }
      resetPoller('massErr');
      toast(err.message || 'Lost contact with the mass-send job – stopping the live updater.', 'error');
      el.massProgress.classList.add('hidden');
    }
  }, 1000);
}

// ════════════════════════════════════════════════════════════════════════════
//  v2.3 Feature 4: mass-sell on the Steam Community Market
// ════════════════════════════════════════════════════════════════════════════

/** Flattens the current selection (account or folder) → [{username, assetId, marketHashName}]. */
function selectedSellItems() {
  const out = [];
  if (aggMode()) {
    for (const [mhn, qty] of Object.entries(state.selection)) {
      const item = aggItemByName(mhn);
      if (!item) continue;
      let remaining = qty;
      for (const owner of item.owners) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, owner.assetIds.length);
        for (let i = 0; i < take; i++) out.push({ username: owner.username, assetId: owner.assetIds[i], marketHashName: mhn });
        remaining -= take;
      }
    }
  } else {
    const owner = state.activeUsername;
    for (const [assetId, qty] of Object.entries(state.selection)) {
      const stack = findStack(assetId);
      if (!stack) continue;
      for (const id of stack.assetIds.slice(0, Math.min(qty, stack.assetIds.length))) {
        out.push({ username: owner, assetId: id, marketHashName: stack.marketHashName });
      }
    }
  }
  return out;
}

function sellStrategy() {
  const r = el.sellForm.querySelector('input[name="sellstrategy"]:checked');
  return r ? r.value : 'lowest';
}

/** Reads the custom price field → a MAJOR amount, or null if empty/invalid. It is applied in
 *  each selling bot's OWN wallet currency (the backend scales it by that wallet's decimals),
 *  so it is deliberately NOT pre-converted to cents here — 2.05 means 2.05 PLN on a PLN bot. */
function customSellMajor() {
  const raw = (el.sellCustomPrice.value || '').replace(',', '.').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The wallet currency the sell modal quotes in: the distinct currencies of the selected
 * bots, and the one to price against. A folder selection can span regions, and each bot
 * still LISTS in its own currency — the preview can only show one, so `mixed` lets the
 * modal say so instead of implying every row is in the currency shown.
 */
function sellSelectionCurrency() {
  const items = state.sellItems || [];
  const codes = [];
  for (const u of new Set(items.map((i) => i.username))) {
    const c = walletOf(u)?.currency;
    if (typeof c === 'number' && STEAM_CURRENCIES[c] && !codes.includes(c)) codes.push(c);
  }
  return { code: codes[0], mixed: codes.length > 1, codes };
}

/** Names of the source bots in the current selection (unique, capped for display). */
function selectionBotNames(items) {
  const names = [...new Set(items.map((i) => i.username))];
  if (names.length <= 20) return names.join(', ');
  return names.slice(0, 20).join(', ') + ` … +${names.length - 20} more`;
}

function toggleSellCustomRow() {
  const isCustom = sellStrategy() === 'custom';
  el.sellCustomRow.classList.toggle('hidden', !isCustom);
  if (isCustom) el.sellCustomPrice.focus();
}

/** Re-labels every currency-bearing control in the sell modal for the selection's wallet.
 *  Prices are native now, so a hardcoded "€"/"1 cent" would misdescribe a PLN or JPY bot. */
function renderSellCurrencyLabels() {
  const { code, mixed, codes } = sellSelectionCurrency();
  const c = curInfo(code);
  const sym = currencySymbol(code);
  if (el.sellPriceLabel) el.sellPriceLabel.textContent = code == null ? 'Sale price' : `Sale price (${c.iso})`;
  if (el.sellCustomSymbol) el.sellCustomSymbol.textContent = sym;
  if (el.sellCustomPrice) {
    // A 0-decimal wallet (JPY/KRW/IDR) has no sub-unit — don't offer 0.01 steps it can't use.
    el.sellCustomPrice.step = c.d === 0 ? '1' : '0.01';
    el.sellCustomPrice.min = c.d === 0 ? '1' : '0.01';
    el.sellCustomPrice.placeholder = c.d === 0 ? 'e.g. 150' : 'e.g. 1.50';
  }
  if (el.sellUndercutHint) {
    // The step is ONE minor unit of the bot's own currency — 0,01 PLN, ¥1, … — so name it by
    // formatting that unit rather than saying "1 cent", which is only true for €/$-like wallets.
    const step = code == null ? 'one minor unit' : fmtMoneyMinor(1, code);
    el.sellUndercutHint.textContent = `Undercut the lowest price by the smallest step (${step}) – first in the list.`;
  }
  if (el.sellCurrencyNote) {
    // Two honest states worth surfacing: nothing known (the quote will be an assumption the
    // backend flags), and a mixed-region selection (each bot lists in its OWN currency, so
    // one preview column cannot speak for all of them).
    const isos = codes.map((x) => curInfo(x).iso).join(', ');
    el.sellCurrencyNote.innerHTML = mixed
      ? `<i class="fa-solid fa-circle-info mr-1"></i>This selection spans <b>${escapeHtml(isos)}</b>. Every bot is priced and listed in its <b>own</b> wallet currency; the preview below is shown in <b>${escapeHtml(curInfo(code).iso)}</b> only.`
      : code == null
        ? `<i class="fa-solid fa-circle-info mr-1"></i>No wallet currency is cached for this selection — the preview assumes EUR. Each bot is still priced and listed in its own currency when the sale runs; refresh the account(s) to preview accurately.`
        : '';
    el.sellCurrencyNote.classList.toggle('hidden', !el.sellCurrencyNote.innerHTML);
  }
}

function openSellModal() {
  const items = selectedSellItems();
  if (items.length === 0) { toast('No items selected', 'warn'); return; }
  state.sellItems = items;
  // PIN the game at modal-open (730 CS2 / 440 TF2). preview/retry/submit read THIS, never live
  // state.game — so a tab switch while the modal is open can't quote one game and list another.
  state.sellAppId = currentAppId();
  const bots = new Set(items.map((i) => i.username)).size;
  el.sellSummary.textContent = `${items.length} Item(s)`;
  el.sellFrom.textContent = aggMode()
    ? `${bots} Bot(s): (${selectionBotNames(items)})`
    : state.activeUsername;
  el.sellPreviewResult.classList.add('hidden');
  el.sellPreviewResult.innerHTML = '';
  state.sellPriceMap = null;
  state.sellPriceCurrency = null;
  el.sellForm.querySelector('input[name="sellstrategy"][value="lowest"]').checked = true;
  el.sellCustomPrice.value = '';
  renderSellCurrencyLabels();
  toggleSellCustomRow();
  el.sellOverlay.classList.remove('hidden');
}
function closeSellModal() { el.sellOverlay.classList.add('hidden'); }

/** Body shared by the full preview and the single-item re-query, incl. the currency to
 *  quote in (the backend validates it and falls back on its own if we send nothing). */
function sellPreviewBody(names) {
  const strategy = sellStrategy();
  const body = {
    names, strategy,
    username: (state.sellItems[0] || {}).username,
    appId: state.sellAppId,
    currency: sellSelectionCurrency().code,
  };
  if (strategy === 'custom') {
    const major = customSellMajor();
    if (major == null) return null;
    body.customPriceMajor = major;
  }
  return body;
}

async function previewSell() {
  const items = state.sellItems || [];
  if (!items.length) return;
  const names = [...new Set(items.map((i) => i.marketHashName))];
  const body = sellPreviewBody(names);
  if (!body) { toast(`Please enter a valid custom price (${curInfo(sellSelectionCurrency().code).iso})`, 'warn'); return; }
  setButtonLoading(el.sellPreviewBtn, true, 'Calculating…');
  try {
    const r = await api('/api/market/preview', { method: 'POST', body: JSON.stringify(body) });
    state.sellPriceMap = r.prices;            // name → { netMinor, buyerMinor }
    state.sellPriceCurrency = r;              // { currency, currencyIso, decimals, resolved }
    renderSellPreview();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setButtonLoading(el.sellPreviewBtn, false, 'Calculate prices & proceeds', 'fa-calculator');
  }
}

/** Re-queries the live price for ONE item only (Hotfix B – fast straggler fix). */
async function retryOnePrice(name, btn) {
  const body = sellPreviewBody([name]);
  if (!body) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>'; }
  try {
    const r = await api('/api/market/preview', { method: 'POST', body: JSON.stringify(body) });
    state.sellPriceMap = { ...(state.sellPriceMap || {}), ...r.prices };
    state.sellPriceCurrency = r;
    renderSellPreview();
    const p = r.prices[name] || {};
    if (p.netMinor == null) toast(`"${name}" still has no price – try again`, 'warn');
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>'; }
  }
}

/** Renders the sell-preview table from state.sellPriceMap + state.sellItems. */
function renderSellPreview() {
  const items = state.sellItems || [];
  const map = state.sellPriceMap || {};
  // Every amount below is MINOR units of the currency the backend quoted in — formatted
  // with THAT currency's symbol + decimals, never a hardcoded €.
  const q = state.sellPriceCurrency || {};
  const code = q.currency != null ? q.currency : sellSelectionCurrency().code;
  const fmt = (minor) => fmtMoneyMinor(minor, code);
  const names = [...new Set(items.map((i) => i.marketHashName))];
  let totalBrutto = 0, totalFee = 0, totalNetto = 0, missing = 0;

  const bodyRows = names.map((n) => {
    const p = map[n] || {};
    const cnt = items.filter((i) => i.marketHashName === n).length;
    if (p.netMinor == null || p.buyerMinor == null) {
      missing += cnt;
      return `<tr class="border-t border-slate-800/60">
        <td class="py-1.5 pl-3 pr-2"><span class="text-slate-400">${escapeHtml(n)}</span> <span class="text-slate-600 font-mono">×${cnt}</span></td>
        <td class="py-1.5 px-2 text-right" colspan="2"><span class="pill pill--danger">no price</span></td>
        <td class="py-1.5 pl-2 pr-3 text-right">
          <button type="button" data-reprice="${escapeAttr(n)}" title="Re-query only this item"
            class="btn btn-icon-sm btn-secondary">
            <i class="fa-solid fa-rotate-right"></i></button></td></tr>`;
    }
    const fee = Math.max(0, p.buyerMinor - p.netMinor);
    totalBrutto += p.buyerMinor * cnt;
    totalFee    += fee * cnt;
    totalNetto  += p.netMinor * cnt;
    return `<tr class="border-t border-slate-800/60">
      <td class="py-1.5 pl-3 pr-2"><span class="text-slate-300">${escapeHtml(n)}</span> <span class="text-slate-600 font-mono">×${cnt}</span></td>
      <td class="py-1.5 px-2 text-right font-mono text-slate-300">${fmt(p.buyerMinor)}</td>
      <td class="py-1.5 px-2 text-right font-mono text-amber-400/90">−${fmt(fee)}</td>
      <td class="py-1.5 pl-2 pr-3 text-right font-mono text-emerald-400 font-semibold">${fmt(p.netMinor)}</td></tr>`;
  }).join('');

  el.sellPreviewResult.innerHTML = `
    <table class="w-full t13">
      <thead>
        <tr class="t10 uppercase tracking-wider text-slate-500">
          <th class="py-2 pl-3 pr-2 text-left font-semibold">Item / ea.</th>
          <th class="py-2 px-2 text-right font-semibold">Gross</th>
          <th class="py-2 px-2 text-right font-semibold">Steam fee</th>
          <th class="py-2 pl-2 pr-3 text-right font-semibold">Net</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr class="border-t-2 border-slate-700 font-bold">
          <td class="py-2 pl-3 pr-2 text-slate-200">Total (${items.length - missing} item(s))</td>
          <td class="py-2 px-2 text-right font-mono text-slate-200">${fmt(totalBrutto)}</td>
          <td class="py-2 px-2 text-right font-mono text-amber-400/90">−${fmt(totalFee)}</td>
          <td class="py-2 pl-2 pr-3 text-right font-mono text-emerald-400">${fmt(totalNetto)}</td>
        </tr>
      </tfoot>
    </table>
    ${q.resolved === false ? `<div class="t10 text-amber-400 px-3 py-1.5 border-t border-slate-800"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Quoted in ${escapeHtml(curInfo(code).iso)} as an assumption – no wallet currency is known for this selection. Each bot still prices and lists in its own currency when the sale runs.</div>` : ''}
    ${missing ? `<div class="t10 text-amber-400 px-3 py-1.5 border-t border-slate-800">${missing} item(s) without price – use <i class="fa-solid fa-rotate-right"></i> to re-query individually (otherwise skipped).</div>` : ''}`;
  el.sellPreviewResult.querySelectorAll('[data-reprice]').forEach((b) =>
    b.addEventListener('click', () => retryOnePrice(b.dataset.reprice, b)));
  el.sellPreviewResult.classList.remove('hidden');
}

async function submitSell(ev) {
  ev.preventDefault();
  const items = state.sellItems || [];
  if (!items.length) return;
  const strategy = sellStrategy();
  const body = { items, strategy, appId: state.sellAppId };
  if (strategy === 'custom') {
    // MAJOR units: the backend applies this amount in EACH bot's own wallet currency.
    const major = customSellMajor();
    if (major == null) { toast(`Please enter a valid custom price (${curInfo(sellSelectionCurrency().code).iso})`, 'warn'); return; }
    body.customPriceMajor = major;
  }
  setButtonLoading(el.sellSubmit, true, 'Starting…');
  try {
    const job = await api('/api/market/sell', { method: 'POST', body: JSON.stringify(body) });
    closeSellModal(); clearSelection(); renderMain();
    state.sellSellers = job.sellers || [];
    showSellProgress(job);
    resetPoller('sell'); // clean stall window for this run (#27)
    pollSell();
    toast(`Market sale started: ${job.total} item(s) on ${job.bots} bot(s)`, 'success');
  } catch (err) {
    toast(`Sale failed: ${err.message}`, 'error');
  } finally {
    setButtonLoading(el.sellSubmit, false, 'Sell & confirm', 'fa-tag');
  }
}
function showSellProgress(job) {
  el.sellProgress.classList.remove('hidden');
  el.sellBar.style.width = '0%';
  el.sellCount.textContent = `0/${job.total}`;
  el.sellDetail.textContent = 'Creating listings & confirming via 2FA…';
  resetEndBtn(el.sellEnd); // fresh run → re-enable the End task button
}
function pollSell() {
  clearTimeout(state.sellTimer);
  state.sellTimer = setTimeout(async () => {
    try {
      const job = await api('/api/market/sell-status');
      resetPoller('sellErr'); // S17: a good poll clears the error-retry window
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      el.sellBar.style.width = pct + '%';
      el.sellCount.textContent = `${job.done}/${job.total}`;
      const deferred = (job.deferred || []).length;
      const gone = (job.gone || []).length;
      const parts = [`${job.listed} listed`, `${job.confirmed} confirmed`];
      if (job.recovered) parts.push(`${job.recovered} recovered`);
      if (job.retried) parts.push(`${job.retried} Retries`);
      if (gone) parts.push(`${gone} gone`);
      if (deferred) parts.push(`${deferred} deferred`);
      parts.push(`${job.failed.length} failed`);
      // Live phase + current bot so the operator sees motion, not a frozen bar.
      const phaseLabel = { preflight: 'Connecting', pricing: 'Pricing', listing: 'Listing', confirming: 'Confirming 2FA', done: 'Done' }[job.phase] || '…';
      const head = job.cancelling
        ? '<span class="text-amber-400 font-semibold">Cancelling…</span> finishing the listing in flight'
        : (job.currentBot ? `<span class="text-brand-light font-semibold">${escapeHtml(job.currentBot)}</span> · ${phaseLabel}` : phaseLabel);
      el.sellDetail.innerHTML = `<span class="block text-slate-300 mb-0.5">${head}</span><span class="text-slate-500">${parts.join(' · ')}</span>`;
      if (job.running) {
        if (!job.cancelling && pollerStalled('sell', job.done)) {
          toast('Market sale appears stuck (no progress) – stopping the live updater. Check the server.', 'warn');
          el.sellProgress.classList.add('hidden'); resetPoller('sell'); return;
        }
        pollSell(); return;
      }
      resetPoller('sell');

      const extra = `${job.recovered ? `, ${job.recovered} recovered` : ''}${gone ? `, ${gone} gone (already sold/moved)` : ''}${deferred ? `, ${deferred} deferred (connection – retryable)` : ''}${job.failed.length ? `, ${job.failed.length} failed` : ''}`;
      const tone = (job.failed.length || deferred) ? 'warn' : 'success';
      const verb = job.cancelled ? 'ended' : 'done';
      toast(`Market sale ${verb}: ${job.listed} listed, ${job.confirmed} confirmed${extra}`, tone);
      setTimeout(() => el.sellProgress.classList.add('hidden'), 4500);
      // Listed items only leave the cache after a live refresh, so refresh the sellers
      // (pollRefresh re-renders the active view on completion). Fall back to an immediate cache
      // re-render so the Master/Env/Global view is NEVER left stale, even if the seller set is
      // unknown or a refresh is already running.
      const sellers = state.sellSellers || [];
      if (sellers.length) startInventoryRefresh({ usernames: sellers });
      else refreshActiveViewFromCache();
    } catch (err) {
      // S17: bounded error-retry — a transient status-fetch error must not kill the poller while the
      // mass-sell runs (else the completion re-pull / failure panel never fires). Give up only after
      // POLL_STALL_MS of continuous errors.
      if (!pollerStalled('sellErr', 0)) { pollSell(); return; }
      resetPoller('sellErr');
      toast(err.message || 'Lost contact with the mass-sell job – stopping the live updater.', 'error');
      el.sellProgress.classList.add('hidden');
    }
  }, 1000);
}

// ── bulk import ──
async function openBulkImport() {
  el.bulkEnv.innerHTML = state.environments.map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  if (state.activeEnv) el.bulkEnv.value = state.activeEnv;
  el.bulkSelectAll.checked = false;
  el.bulkCsvStatus.classList.add('hidden');
  el.bulkVaultStatus.classList.add('hidden');
  el.bulkVaultPw.value = '';
  await populateBulkFolders();
  await loadBulkList();
  selectImportMethod('mafiles'); // default to the classic method (loads the maFile list)
  el.bulkOverlay.classList.remove('hidden');
}
function closeBulk() { el.bulkOverlay.classList.add('hidden'); }

/** Shows the chosen import method's panel + highlights its button. */
function selectImportMethod(method) {
  document.querySelectorAll('.import-panel').forEach((p) => p.classList.add('hidden'));
  const panel = document.getElementById(`method-${method}`);
  if (panel) panel.classList.remove('hidden');
  document.querySelectorAll('.import-method').forEach((b) => {
    const active = b.dataset.method === method;
    b.classList.toggle('border-brand', active);
    b.classList.toggle('bg-brand/10', active);
    b.classList.toggle('text-white', active);
  });
}

/** "Import SSIM Vault": merge another device's vault.enc into this vault (only new bots). */
async function onBulkVaultImport() {
  const files = el.bulkVaultFile.files ? Array.from(el.bulkVaultFile.files) : [];
  const password = el.bulkVaultPw.value;
  const status = el.bulkVaultStatus;
  const show = (msg, tone) => { status.className = `text-2xs ${tone || 'text-slate-400'}`; status.textContent = msg; status.classList.remove('hidden'); };
  // Sort the selected file(s) into the vault.enc (required) and accounts.json (optional, for
  // folder structure). Robust to selection order and to selecting only one of the two.
  const vaultFile = files.find((f) => /\.enc$/i.test(f.name)) || files.find((f) => !/\.json$/i.test(f.name));
  const acctFile  = files.find((f) => /accounts\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
  if (!vaultFile) { show('Select the vault.enc file (optionally also accounts.json).', 'text-amber-400'); return; }
  if (!password) { show('Enter the source vault password.', 'text-amber-400'); return; }
  const btn = el.bulkVaultImport; const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i> Importing…';
  try {
    const vault = await vaultFile.text();
    const accountsJson = acctFile ? await acctFile.text() : undefined;
    const environmentId = el.bulkEnv.value;
    const folderId = el.bulkFolder.value || null;
    const r = await api('/api/import/vault', { method: 'POST', body: JSON.stringify({ vault, accountsJson, password, environmentId, folderId }) });
    show(`Imported ${r.imported} new, ${r.skipped} skipped${acctFile ? ' · folders recreated' : ''}.`, r.imported ? 'text-emerald-400' : 'text-amber-400');
    toast(`Vault import: ${r.imported} added, ${r.skipped} skipped`, r.imported ? 'success' : 'info');
    if (r.imported) { closeBulk(); await reloadAll(); if (state.nav === 'accounts') renderAccountsModule(); else if (state.screen === 'inventory' && state.activeEnv) await refreshEnv(); else renderDashboard(); }
  } catch (err) {
    show(err.message, 'text-rose-400');
    toast(`Vault import failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = old;
    el.bulkVaultPw.value = '';
  }
}
async function populateBulkFolders() {
  let opts = [];
  try {
    const tree = await api(`/api/environments/${encodeURIComponent(el.bulkEnv.value)}/tree`);
    const walk = (nodes, d) => { for (const n of nodes) { opts.push({ id: n.folder.id, name: n.folder.name, depth: d }); walk(n.children, d + 1); } };
    walk(tree.folders, 0);
  } catch { opts = []; }
  el.bulkFolder.innerHTML = `<option value="">— Root —</option>` + opts.map((o) => `<option value="${escapeAttr(o.id)}">${'&nbsp;&nbsp;'.repeat(o.depth)}${escapeHtml(o.name)}</option>`).join('');
}
async function loadBulkList() {
  let list = [];
  try { list = await api('/api/mafiles/unlinked'); } catch (err) { toast(err.message, 'error'); }
  if (!list.length) {
    el.bulkList.innerHTML = `<p class="text-center text-slate-600 py-8 t13">No new maFiles in <code class="text-slate-500">mafiles/</code></p>`;
    el.bulkSubmit.disabled = true;
    return;
  }
  el.bulkList.innerHTML = list.map((f) => `
    <label class="flex items-center gap-3 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 ${f.hasPassword ? 'cursor-pointer hover:border-slate-700' : 'opacity-60'}">
      <input type="checkbox" class="bulk-check accent-violet-500 w-4 h-4" data-file="${escapeAttr(f.file)}" data-haspw="${f.hasPassword ? '1' : '0'}" ${f.hasPassword ? '' : 'disabled'} />
      <div class="flex-1 min-w-0">
        <p class="t13 font-semibold text-slate-200 truncate">${escapeHtml(f.accountName)}</p>
        <p class="t10 text-slate-500 truncate font-mono">${escapeHtml(f.file)}</p></div>
      ${f.hasPassword
        ? '<span class="pill pill--success shrink-0"><i class="fa-solid fa-check mr-1"></i>Password</span>'
        : '<span class="pill pill--danger shrink-0"><i class="fa-solid fa-xmark mr-1"></i>no password</span>'}
    </label>`).join('');
  el.bulkList.querySelectorAll('.bulk-check').forEach((cb) => cb.addEventListener('change', updateBulkSubmit));
  updateBulkSubmit();
}
function selectedBulkFiles() { return [...el.bulkList.querySelectorAll('.bulk-check:checked')].map((c) => c.dataset.file); }
function updateBulkSubmit() {
  const n = selectedBulkFiles().length;
  el.bulkSubmitLabel.textContent = n ? `Import (${n})` : 'Import';
  el.bulkSubmit.disabled = n === 0;
}
function onBulkSelectAll() {
  const on = el.bulkSelectAll.checked;
  el.bulkList.querySelectorAll('.bulk-check').forEach((cb) => { if (cb.dataset.haspw === '1') cb.checked = on; });
  updateBulkSubmit();
}
async function submitBulk() {
  const files = selectedBulkFiles();
  if (!files.length) return;
  const environmentId = el.bulkEnv.value;
  const folderId = el.bulkFolder.value || null;
  el.bulkSubmit.disabled = true;
  try {
    const res = await api('/api/mafiles/import', { method: 'POST', body: JSON.stringify({ files, environmentId, folderId }) });
    if (res.vault) {
      toast(`${res.imported} bot(s) imported into the vault${res.migrated ? `, ${res.migrated} migrated` : ''}`, res.imported ? 'success' : 'info');
      // H-ACC-078: never let a ticked file no-op silently — surface why each skipped file failed.
      if (Array.isArray(res.reasons) && res.reasons.length) {
        const first = res.reasons.slice(0, 5).map((r) => `${r.file}: ${r.reason}`).join('; ');
        toast(`${res.reasons.length} file(s) could not be imported — ${first}${res.reasons.length > 5 ? '…' : ''}`, 'warn');
      }
    } else {
      const skipMsg = res.skipped.length ? `, ${res.skipped.length} skipped` : '';
      toast(`${res.added.length} bot(s) imported${skipMsg}`, res.added.length ? 'success' : 'warn');
    }
    closeBulk();
    await reloadAll();
    if (state.nav === 'accounts') renderAccountsModule();
    else if (state.screen === 'inventory' && state.activeEnv) await refreshEnv(); else renderDashboard();
  } catch (err) { toast(err.message, 'error'); el.bulkSubmit.disabled = false; }
}

/** Reads a chosen CSV (username,password,shared_secret,identity_secret) and merges it into the vault. */
async function onBulkCsv(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const status = el.bulkCsvStatus;
  const show = (msg, tone) => { status.className = `text-2xs mt-2 ${tone || 'text-slate-400'}`; status.textContent = msg; status.classList.remove('hidden'); };
  show(`Reading ${file.name}…`);
  try {
    const csv = await file.text();
    const environmentId = el.bulkEnv.value;
    const folderId = el.bulkFolder.value || null;
    const r = await api('/api/import/csv', { method: 'POST', body: JSON.stringify({ csv, environmentId, folderId }) });
    show(`Imported ${r.imported} new, ${r.skipped} skipped.`, r.imported ? 'text-emerald-400' : 'text-amber-400');
    toast(`CSV import: ${r.imported} added, ${r.skipped} skipped`, r.imported ? 'success' : 'info');
    // H-ACC-078: parser-dropped rows are lost input — name the first few so the operator can fix them.
    if (Array.isArray(r.rejected) && r.rejected.length) {
      const first = r.rejected.slice(0, 5).map((x) => `line ${x.line}: ${x.reason}`).join('; ');
      toast(`${r.rejected.length} row(s) could not be imported — ${first}${r.rejected.length > 5 ? '…' : ''}`, 'warn');
    }
    if (r.imported) { closeBulk(); await reloadAll(); if (state.nav === 'accounts') renderAccountsModule(); else if (state.screen === 'inventory' && state.activeEnv) await refreshEnv(); else renderDashboard(); }
  } catch (err) {
    show(err.message, 'text-rose-400');
    toast(`CSV import failed: ${err.message}`, 'error');
  } finally {
    ev.target.value = ''; // allow re-selecting the same file
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Toolbar + utilities
// ════════════════════════════════════════════════════════════════════════════

function onSearch(e) { state.search = e.target.value; renderMain(); }

function setButtonLoading(btn, loading, text, icon) {
  btn.disabled = loading;
  const iconHtml = loading ? '<i class="fa-solid fa-spinner cs2-spin"></i>' : `<i class="fa-solid ${icon}"></i>`;
  btn.innerHTML = `${iconHtml}<span>${text}</span>`;
}

// FB-02: toasts now stack; per-toast auto-dismiss timers live in showOneToast.
// ── Market BUY modal (v1.0.2) ──────────────────────────────────────────────
/** Wallet of an account by username. The Steam wallet is a GLOBAL account property —
 *  NOT per-game — so it must never change when toggling CS2 ⇄ TF2. Prefer the remembered
 *  global wallet; otherwise fall back to whichever game's cache actually carries one
 *  (NOT just the active game's: the active cache may lack a wallet while the other has it). */
function walletOf(u) {
  if (!u) return undefined;
  const lc = u.toLowerCase();
  // Prefer the globally-remembered NEWEST wallet (same value in CS2 + TF2); fall back to either
  // game's cached wallet only when nothing has been remembered yet.
  const remembered = state.wallets[lc];
  if (remembered && remembered.wallet) return remembered.wallet;
  return state.inventories[u]?.wallet || state.inventories[lc]?.wallet
    || state.tf2Inventories[u]?.wallet || state.tf2Inventories[lc]?.wallet
    || undefined;
}
/** Currency code of the chosen buy account, or undefined when unknown. We do NOT
 *  default to EUR: a wrong currency/scale would misprice a real-money order. */
function buyCurrencyCode() {
  const u = el.buyAccount.value.trim();
  // Prefer the freshly-fetched live wallet for the selected account; else local state.
  if (state.buyWallet && state.buyWallet.username === u && state.buyWallet.currency != null) return state.buyWallet.currency;
  return walletOf(u)?.currency;
}
function openBuyModal() {
  const accounts = (state.allAccounts || []).filter((a) => a && a.username);
  if (accounts.length === 0) { toast('No accounts available', 'warn'); return; }
  const hasActive = !!state.activeUsername && accounts.some((a) => a.username === state.activeUsername);
  // Searchable datalist: type to filter hundreds of bots (native autocomplete).
  el.buyAccountList.innerHTML = accounts
    .map((a) => `<option value="${escapeAttr(a.username)}">${escapeHtml(a.displayName && a.displayName !== a.username ? a.displayName : '')}</option>`)
    .join('');
  // Pre-select the bot in focus (Buy from a single-account view); else empty → search.
  el.buyAccount.value = hasActive ? state.activeUsername : '';
  el.buyGame.value = state.game === 'tf2' ? '440' : '730';
  el.buyQty.value = '1';
  el.buyPrice.value = '';
  el.buyName.value = ''; // starts empty (no hardcoded item) – user types/searches
  el.buyResult.classList.add('hidden');
  el.buyResult.innerHTML = '';
  hideBuySearch();
  updateBuyWallet();
  el.buyOverlay.classList.remove('hidden');
}
function closeBuyModal() { el.buyOverlay.classList.add('hidden'); hideBuySearch(); }
function renderBuyWallet(w) {
  const code = buyCurrencyCode();
  el.buyCur.textContent = code != null ? `(${curInfo(code).iso})` : '(currency unknown)';
  el.buyWallet.textContent = w ? `Balance: ${fmtWallet(w)}` : 'Balance unknown – "Refresh" the account first (buying disabled)';
  recomputeBuyTotal();
}
// On account selection: show the local value instantly, then pull the FRESHEST
// balance from the backend (live session > cache) so it's never a stale number.
async function updateBuyWallet() {
  const username = el.buyAccount.value.trim();
  state.buyWallet = null;                  // clear any stale per-account value
  renderBuyWallet(walletOf(username));      // instant: whatever we already have
  if (!username) return;
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(username)}/wallet`);
    if (el.buyAccount.value.trim() !== username) return; // selection moved on
    state.buyWallet = r.wallet ? { username, currency: r.wallet.currency, balance: r.wallet.balance } : null;
    if (r.wallet) state.wallets[username.toLowerCase()] = { wallet: { currency: r.wallet.currency, balance: r.wallet.balance }, ts: Date.now() };
    renderBuyWallet(r.wallet);
  } catch { /* keep the local value on error */ }
}
/**
 * Pulls the EXACT, up-to-date wallet (live session > cache) for `username` from
 * the backend, updates state.buyWallet + the modal's balance line, and returns
 * the wallet ({ currency, balance }) or null. Used by the pre-buy funds check
 * and the "Max" button so both act on real-time funds, never a stale number.
 * Throws on a network/API error so the caller can abort the action.
 */
async function refreshBuyWallet(username) {
  const r = await api(`/api/accounts/${encodeURIComponent(username)}/wallet`);
  state.buyWallet = r.wallet ? { username, currency: r.wallet.currency, balance: r.wallet.balance } : null;
  if (r.wallet) state.wallets[username.toLowerCase()] = { wallet: { currency: r.wallet.currency, balance: r.wallet.balance }, ts: Date.now() };
  renderBuyWallet(r.wallet);
  return r.wallet || null;
}
function recomputeBuyTotal() {
  const code = buyCurrencyCode();
  const qty = Math.max(1, parseInt(el.buyQty.value, 10) || 1);
  el.buyQtyEcho.textContent = String(qty);
  if (code == null) { el.buyTotal.textContent = '—'; return; }
  const minor = parseMajorToMinor(el.buyPrice.value, code);
  el.buyTotal.textContent = minor != null ? fmtMoneyMinor(minor * qty, code) : '—';
}
/**
 * "Spend entire balance" (Max): fetch the EXACT current wallet balance, work out
 * how many of the item it can buy at the entered price, and fill the quantity
 * field. Capped at the quantity input's per-order max. Needs an account + a price.
 */
async function fillMaxBuyQty() {
  const username = el.buyAccount.value.trim();
  if (!username) { toast('Please select an account first', 'warn'); return; }
  const btn = el.buyMax; const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>';
  try {
    let wallet;
    try { wallet = await refreshBuyWallet(username); }      // exact, up-to-date balance
    catch (e) { toast(`Could not fetch balance: ${e.message}`, 'error'); return; }
    if (!wallet || wallet.currency == null) { toast('Wallet balance unknown – "Refresh" the account first', 'warn'); return; }
    const code = wallet.currency;
    const priceMinor = parseMajorToMinor(el.buyPrice.value, code);
    if (priceMinor == null) { toast('Enter a price per item first (or fetch the market price)', 'warn'); return; }
    const balanceMinor = walletMinor(wallet);
    if (balanceMinor == null || balanceMinor < priceMinor) {
      toast(`Balance ${fmtWallet(wallet)} can't afford one at ${fmtMoneyMinor(priceMinor, code)}`, 'warn');
      return;
    }
    const affordable = Math.floor(balanceMinor / priceMinor);
    const cap = parseInt(el.buyQty.max, 10) || 100;         // respect the per-order quantity cap
    const qty = Math.max(1, Math.min(affordable, cap));
    el.buyQty.value = String(qty);
    recomputeBuyTotal();
    toast(
      affordable > cap
        ? `Capped at ${cap}/order (balance affords ${affordable}× at ${fmtMoneyMinor(priceMinor, code)})`
        : `Max ${qty}× ≈ ${fmtMoneyMinor(priceMinor * qty, code)} of ${fmtWallet(wallet)}`,
      'info',
    );
  } finally {
    btn.disabled = false; btn.innerHTML = old;
  }
}
/** Live-fetch the lowest market ask for the typed item and fill the price field. */
async function fetchBuyPrice() {
  const username = el.buyAccount.value.trim();
  const name = el.buyName.value.trim();
  const appId = el.buyGame.value === '440' ? 440 : 730;
  if (!username) { toast('Please select an account first', 'warn'); return; }
  if (!name) { toast('Please enter an item name first', 'warn'); return; }
  const btn = el.buyPriceFetch; const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>';
  try {
    const q = new URLSearchParams({ username, marketHashName: name, appId: String(appId) });
    const r = await api('/api/market/buy-price?' + q.toString());
    if (r.lowestMinor == null) { toast('No market price found', 'warn'); return; }
    el.buyPrice.value = (r.lowestMinor / Math.pow(10, r.decimals)).toFixed(r.decimals).replace('.', ',');
    recomputeBuyTotal();
    toast(`Lowest offer: ${fmtMoneyMinor(r.lowestMinor, r.currency)}`, 'info');
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}
// ── Buy-modal live item search (Steam Market autocomplete) ──────────────────
function hideBuySearch() { el.buyNameResults.classList.add('hidden'); el.buyNameResults.innerHTML = ''; }
function renderBuySearch(list) {
  if (!list || !list.length) { hideBuySearch(); return; }
  el.buyNameResults.innerHTML = list.map((it, i) => `
    <button type="button" data-i="${i}" class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-brand/15 transition">
      ${it.iconUrl ? `<img src="${escapeAttr(safeIconUrl(it.iconUrl))}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'" />` : ''}
      <span class="min-w-0 flex-1">
        <span class="block t13 text-slate-200 truncate">${escapeHtml(it.name || it.marketHashName)}</span>
        ${it.priceText ? `<span class="block t10 text-slate-500">from ${escapeHtml(it.priceText)}</span>` : ''}
      </span>
    </button>`).join('');
  el.buyNameResults.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
    const it = list[Number(b.dataset.i)];
    el.buyName.value = it.marketHashName;
    hideBuySearch();
    el.buyName.focus();
  }));
  el.buyNameResults.classList.remove('hidden');
}
async function searchBuyItems() {
  const q = el.buyName.value.trim();
  if (q.length < 2) { hideBuySearch(); return; }
  const appId = el.buyGame.value === '440' ? 440 : 730;
  try {
    const r = await api(`/api/market/search?q=${encodeURIComponent(q)}&appId=${appId}`);
    if (el.buyName.value.trim() !== q) return; // a newer query is already in flight
    renderBuySearch((r.results || []).slice(0, 20));
  } catch { hideBuySearch(); }
}
async function submitBuy(ev) {
  ev.preventDefault();
  const username = el.buyAccount.value;
  const name = el.buyName.value.trim();
  const appId = el.buyGame.value === '440' ? 440 : 730;
  const qty = Math.max(1, Math.min(100, parseInt(el.buyQty.value, 10) || 0));
  const code = buyCurrencyCode();
  if (!username) { toast('Please select an account', 'warn'); return; }
  if (!name) { toast('Please enter an item name', 'warn'); return; }
  if (!qty) { toast('Invalid quantity', 'warn'); return; }
  if (code == null) { toast('Wallet currency unknown – "Refresh" the account first', 'warn'); return; }
  const pricePerItemMinor = parseMajorToMinor(el.buyPrice.value, code);
  if (pricePerItemMinor == null) { toast('Please enter a valid price', 'warn'); return; }
  el.buyResult.classList.add('hidden');
  setButtonLoading(el.buySubmit, true, 'Checking balance…');
  try {
    // ── Pre-action funds check (Point 2): never spend without confirming funds ─
    // Critical real-money action → fetch the EXACT up-to-date wallet right now
    // (not the value cached at account-select) and refuse if it can't cover the
    // order. The backend independently re-verifies on its own fresh refresh;
    // this gives instant feedback and avoids firing a doomed purchase request.
    let liveWallet;
    try {
      liveWallet = await refreshBuyWallet(username);
    } catch (e) {
      toast(`Could not verify balance – purchase aborted: ${e.message}`, 'error');
      return;
    }
    const liveCode = liveWallet ? liveWallet.currency : null;
    if (liveCode == null) { toast('Wallet balance unknown – "Refresh" the account first', 'warn'); return; }
    const balanceMinor = walletMinor(liveWallet);
    const totalMinor = pricePerItemMinor * qty;
    if (balanceMinor == null || balanceMinor < totalMinor) {
      toast(`Insufficient balance: ${fmtWallet(liveWallet)} available, ${fmtMoneyMinor(totalMinor, liveCode)} needed`, 'error');
      return;
    }

    setButtonLoading(el.buySubmit, true, 'Buying…');
    const r = await api('/api/market/buy', {
      method: 'POST',
      body: JSON.stringify({ username, marketHashName: name, appId, pricePerItemMinor, quantity: qty }),
    });
    const ok = Number(r.filled) > 0; // #46: coerce defensively — a missing/odd shape must not read as truthy
    el.buyResult.className = `px-3 py-2.5 rounded-lg border text-xs ${ok ? 'bg-emerald-900/20 border-emerald-700/40 text-emerald-300' : 'bg-slate-950 border-slate-800 text-slate-300'}`;
    el.buyResult.innerHTML =
      `<i class="fa-solid ${ok ? 'fa-circle-check' : 'fa-circle-info'} mr-1.5"></i>${escapeHtml(r.message)}` +
      `<div class="text-slate-500 mt-1">Order ${escapeHtml(r.buyOrderId || '—')} · ${r.confirmed ? 'confirmed' : 'unconfirmed'} · Total ${fmtMoneyMinor(r.priceTotalMinor, r.currency)}</div>`;
    el.buyResult.classList.remove('hidden');
    toast(ok ? `Bought: ${r.filled}× ${name}` : `Buy order placed: ${name}`, ok ? 'success' : 'info');
    // Reflect the new items: refresh just this buyer for the bought game.
    startInventoryRefresh({ usernames: [username], game: appId === 440 ? 'tf2' : 'cs2' });
  } catch (err) {
    // Money-safety (#28): a failed buy POST may STILL have reached Steam (timeout/5xx)
    // and placed the order. Don't imply a clean retry — refresh this buyer so the
    // operator can SEE whether it went through, and tell them to verify before re-buying.
    toast(`Buy failed: ${err.message} — verify this account's inventory/orders before retrying`, 'error');
    startInventoryRefresh({ usernames: [username], game: appId === 440 ? 'tf2' : 'cs2' });
  } finally {
    setButtonLoading(el.buySubmit, false, 'Buy & confirm', 'fa-cart-shopping');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Folder-level Mass Buy ("Buy across folders")
// ════════════════════════════════════════════════════════════════════════════

function openFolderBuy(folderName, usernames) {
  const accts = (usernames || []).filter(Boolean);
  if (accts.length === 0) { toast('No accounts in this folder', 'warn'); return; }
  state.fbuy = { folderName, usernames: accts };
  el.fbuySummary.innerHTML = `<i class="fa-solid fa-folder-open text-brand mr-1"></i><b>${escapeHtml(folderName)}</b> · ${accts.length} account(s). Each bot's balance is refreshed live first, then maxed out at your price.`;
  el.fbuyGame.value = state.game === 'tf2' ? '440' : '730';
  el.fbuyName.value = '';
  el.fbuyPrice.value = '';
  hideFbuySearch();
  el.fbuyProgress.classList.add('hidden');
  el.fbuyResults.classList.add('hidden'); el.fbuyResults.innerHTML = '';
  setButtonLoading(el.fbuySubmit, false, 'Start mass buy', 'fa-cart-arrow-down');
  el.fbuyOverlay.classList.remove('hidden');
}
function closeFolderBuy() { clearTimeout(state.fbuyTimer); el.fbuyOverlay.classList.add('hidden'); hideFbuySearch(); }
function hideFbuySearch() { el.fbuyNameResults.classList.add('hidden'); el.fbuyNameResults.innerHTML = ''; }
function renderFbuySearch(list) {
  if (!list || !list.length) { hideFbuySearch(); return; }
  el.fbuyNameResults.innerHTML = list.map((it, i) => `
    <button type="button" data-i="${i}" class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-brand/15 transition">
      ${it.iconUrl ? `<img src="${escapeAttr(safeIconUrl(it.iconUrl))}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'" />` : ''}
      <span class="min-w-0 flex-1">
        <span class="block t13 text-slate-200 truncate">${escapeHtml(it.name || it.marketHashName)}</span>
        ${it.priceText ? `<span class="block t10 text-slate-500">from ${escapeHtml(it.priceText)}</span>` : ''}
      </span>
    </button>`).join('');
  el.fbuyNameResults.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
    el.fbuyName.value = list[Number(b.dataset.i)].marketHashName; hideFbuySearch(); el.fbuyName.focus();
  }));
  el.fbuyNameResults.classList.remove('hidden');
}
async function searchFbuyItems() {
  const q = el.fbuyName.value.trim();
  if (q.length < 2) { hideFbuySearch(); return; }
  const appId = el.fbuyGame.value === '440' ? 440 : 730;
  try {
    const r = await api(`/api/market/search?q=${encodeURIComponent(q)}&appId=${appId}`);
    if (el.fbuyName.value.trim() !== q) return; // a newer query is already in flight
    renderFbuySearch((r.results || []).slice(0, 20));
  } catch { hideFbuySearch(); }
}
/** Pre-fills the price from the lowest market ask, fetched via a representative
 *  account in the folder (assumes a region-homogeneous folder – it's only a hint). */
async function fetchFbuyPrice() {
  const name = el.fbuyName.value.trim();
  const appId = el.fbuyGame.value === '440' ? 440 : 730;
  const rep = state.fbuy?.usernames?.[0];
  if (!rep) { toast('No account in folder', 'warn'); return; }
  if (!name) { toast('Please enter an item name first', 'warn'); return; }
  const btn = el.fbuyPriceFetch; const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>';
  try {
    const q = new URLSearchParams({ username: rep, marketHashName: name, appId: String(appId) });
    const r = await api('/api/market/buy-price?' + q.toString());
    if (r.lowestMinor == null) { toast('No market price found', 'warn'); return; }
    el.fbuyPrice.value = (r.lowestMinor / Math.pow(10, r.decimals)).toFixed(r.decimals).replace('.', ',');
    toast(`Lowest offer: ${fmtMoneyMinor(r.lowestMinor, r.currency)}`, 'info');
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}
async function submitFolderBuy(ev) {
  ev.preventDefault();
  const ctx = state.fbuy;
  if (!ctx || !ctx.usernames?.length) { toast('No folder selected', 'warn'); return; }
  const name = el.fbuyName.value.trim();
  const appId = el.fbuyGame.value === '440' ? 440 : 730;
  const priceMajor = parseFloat(String(el.fbuyPrice.value).replace(',', '.').trim());
  if (!name) { toast('Please enter an item name', 'warn'); return; }
  if (!Number.isFinite(priceMajor) || priceMajor <= 0) { toast('Please enter a valid price per item', 'warn'); return; }
  // Real-money action across many accounts → explicit confirm.
  if (!(await ssimConfirm({
    title: 'Mass Buy — real money', tone: 'spend', confirmLabel: 'Start mass buy', confirmIcon: 'fa-cart-arrow-down',
    body: `Buy <b class="text-slate-100">${escapeHtml(name)}</b> across <b class="text-slate-100">${ctx.usernames.length}</b> account(s).<br>Each balance is refreshed live, then every bot is <b>maxed out</b> at <b class="text-slate-100">${escapeHtml(String(priceMajor))}</b> (its own wallet currency).<br><span class="text-amber-400 font-semibold">Real money. Irreversible.</span>`,
  }))) return;

  setButtonLoading(el.fbuySubmit, true, 'Refreshing balances…');
  el.fbuyResults.classList.add('hidden'); el.fbuyResults.innerHTML = '';
  try {
    await api('/api/market/folder-buy', { method: 'POST', body: JSON.stringify({
      usernames: ctx.usernames, marketHashName: name, appId, pricePerItemMajor: priceMajor }) });
    el.fbuyProgress.classList.remove('hidden');
    el.fbuyBar.style.width = '0%';
    resetEndBtn(el.fbuyEnd); // fresh run → re-enable the End task button
    resetPoller('fbuy'); resetPoller('fbuyErr'); // clean stall windows for this run (#27)
    pollFolderBuy();
  } catch (err) {
    toast(`Mass buy failed: ${err.message}`, 'error');
    setButtonLoading(el.fbuySubmit, false, 'Start mass buy', 'fa-cart-arrow-down');
  }
}
function pollFolderBuy() {
  clearTimeout(state.fbuyTimer);
  state.fbuyTimer = setTimeout(async () => {
    let job;
    try { job = await api('/api/market/folder-buy-status'); resetPoller('fbuyErr'); }
    catch {
      // Bound the error-retry loop: stop after POLL_STALL_MS of continuous status errors
      // rather than polling a dead job forever.
      if (pollerStalled('fbuyErr', 0)) {
        toast('Lost contact with the mass-buy job – stopping the live updater.', 'warn');
        el.fbuyProgress.classList.add('hidden'); resetPoller('fbuyErr');
        setButtonLoading(el.fbuySubmit, false, 'Start mass buy', 'fa-cart-arrow-down'); return;
      }
      state.fbuyTimer = setTimeout(pollFolderBuy, 1200); return;
    }
    const total = job.total || 0;
    if (job.phase === 'refreshing') {
      el.fbuyPhase.textContent = job.cancelling ? 'Cancelling…' : 'Refreshing balances…';
      el.fbuyCount.textContent = `${job.refreshed}/${total}`;
      el.fbuyBar.style.width = (total ? Math.round((job.refreshed / total) * 100) : 0) + '%';
    } else {
      el.fbuyPhase.textContent = job.cancelling ? 'Cancelling — finishing the order in flight…' : (job.running ? 'Placing buy orders…' : 'Done');
      el.fbuyCount.textContent = `${job.processed}/${total}`;
      el.fbuyBar.style.width = (total ? Math.round((job.processed / total) * 100) : 0) + '%';
    }
    if (job.running) {
      if (!job.cancelling && pollerStalled('fbuy', (job.processed || 0) + (job.refreshed || 0))) {
        toast('Mass buy appears stuck (no progress) – stopping the live updater. Check the server.', 'warn');
        el.fbuyProgress.classList.add('hidden'); resetPoller('fbuy');
        setButtonLoading(el.fbuySubmit, false, 'Start mass buy', 'fa-cart-arrow-down'); return;
      }
      pollFolderBuy(); return;
    }
    resetPoller('fbuy');

    renderFolderBuyResults(job);
    setButtonLoading(el.fbuySubmit, false, 'Start mass buy', 'fa-cart-arrow-down');
    toast(`Mass buy ${job.cancelled ? 'ended' : 'done'}: ${job.placed} order(s), ${job.filled} item(s) filled, ${job.skipped} skipped, ${job.failed} failed`,
      job.failed ? 'warn' : 'success');
    // LIVE REACTIVITY: the buy already balance-refreshed every account server-side, so re-pull
    // the cache + re-render the active Master/Env/Global view immediately (new balances/items)
    // instead of waiting on a manual click or a slow re-login refresh.
    refreshActiveViewFromCache();
  }, 900);
}
function renderFolderBuyResults(job) {
  const rows = (job.results || []).slice().sort((a, b) => (b.filled - a.filled) || (b.plannedQty - a.plannedQty));
  const styleOf = (s) => ({ bought: 'text-emerald-300', placed: 'text-teal-300', skipped: 'text-slate-400', failed: 'text-rose-300', 'refresh-failed': 'text-rose-300' }[s] || 'text-slate-300');
  const pillOf  = (s) => ({ bought: 'pill--success', placed: 'pill--listed', skipped: 'pill--neutral', failed: 'pill--danger', 'refresh-failed': 'pill--danger' }[s] || 'pill--neutral');
  const iconOf  = (s) => ({ bought: 'fa-circle-check', placed: 'fa-circle-check', skipped: 'fa-circle-minus', failed: 'fa-circle-xmark', 'refresh-failed': 'fa-triangle-exclamation' }[s] || 'fa-circle-info');
  el.fbuyResults.innerHTML = rows.map((r) => {
    const qty = r.filled > 0 ? `${r.filled}×` : (r.plannedQty ? `0/${r.plannedQty}` : '—');
    return `<div class="flex items-center gap-2 px-3 py-2">
      <i class="fa-solid ${iconOf(r.status)} ${styleOf(r.status)} shrink-0"></i>
      <span class="t13 font-semibold text-slate-200 truncate" style="max-width:9rem" title="${escapeAttr(r.username)}">${escapeHtml(r.username)}</span>
      <span class="pill ${pillOf(r.status)} font-mono shrink-0">${escapeHtml(qty)}</span>
      <span class="t10 text-slate-500 truncate flex-1" title="${escapeAttr(r.message)}">${escapeHtml(r.message)}</span>
    </div>`;
  }).join('') || '<div class="px-3 py-6 text-center text-slate-600">No accounts processed.</div>';
  el.fbuyResults.classList.remove('hidden');
}

// ── FB-02: stacking toasts. Up to TOAST_MAX visible (rest queued); errors PERSIST until
// dismissed, everything else auto-dismisses. Optional inline Undo via opts.undo. The old
// (message, type) signature is unchanged, so every existing call site keeps working. ──
const TOAST_MAX = 3;
const TOAST_QUEUE_CAP = 50;        // S22: never let the pending queue grow without bound
const ERROR_TOAST_TTL_MS = 20000;  // S22: errors auto-dismiss after a LONG ttl (not never) so 3 stuck
                                   // error toasts can no longer permanently mute every later notification
const toastQueue = [];
let toastShown = 0;
const activeToastKeys = new Set();  // S22: de-dup — "type|message" currently queued or visible
function toast(message, type = 'info', opts = {}) {
  const key = `${type}|${message}`;
  // S22: collapse duplicates — an error burst must not fill all 3 slots (and the queue) with the same
  // message. A currently-queued/visible identical toast is not re-added (it reappears once it clears).
  if (activeToastKeys.has(key)) return;
  // S22: cap the pending queue so a flood can't grow it unbounded → drop the OLDEST pending toast.
  while (toastQueue.length >= TOAST_QUEUE_CAP) {
    const dropped = toastQueue.shift();
    if (dropped) activeToastKeys.delete(`${dropped.type}|${dropped.message}`);
  }
  activeToastKeys.add(key);
  toastQueue.push({ message, type, opts, key });
  drainToasts();
}
function drainToasts() {
  while (toastShown < TOAST_MAX && toastQueue.length) {
    const { message, type, opts, key } = toastQueue.shift();
    showOneToast(message, type, opts, key);
  }
}
function showOneToast(message, type, opts, key) {
  toastShown++;
  const tone = { success: 'bg-emerald-600', error: 'bg-rose-600', warn: 'bg-amber-500', info: 'bg-slate-700' }[type] || 'bg-slate-700';
  const icon = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' }[type] || 'fa-circle-info';
  const t = document.createElement('div');
  t.className = `pointer-events-auto w-max max-w-sm px-4 py-3 rounded-lg shadow-xl text-sm font-medium text-white flex items-center gap-2.5 fade-in ${tone}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const undoBtn = (typeof opts.undo === 'function')
    ? `<button data-toast-undo class="ml-1 shrink-0 px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white text-xs font-bold transition">Undo</button>` : '';
  t.innerHTML = `<i class="fa-solid ${icon} shrink-0"></i><span class="flex-1 min-w-0 break-words">${escapeHtml(message)}</span>${undoBtn}<button data-toast-close aria-label="Dismiss" class="shrink-0 text-white/70 hover:text-white transition px-1"><i class="fa-solid fa-xmark"></i></button>`;
  let closed = false, timer = null;
  const close = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); t.remove(); toastShown--; if (key) activeToastKeys.delete(key); drainToasts(); };
  t.querySelector('[data-toast-close]').addEventListener('click', close);
  const undoEl = t.querySelector('[data-toast-undo]');
  if (undoEl) undoEl.addEventListener('click', () => { try { opts.undo(); } catch { /* undo failed */ } close(); });
  el.toastStack.appendChild(t);
  // S22: errors now auto-dismiss after a LONG ttl instead of never — so three unread error toasts can't
  // permanently occupy all slots and silently mute every later (buy/sell/trade) notification.
  timer = setTimeout(close, opts.duration || (type === 'error' ? ERROR_TOAST_TTL_MS : 4000));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/** Allow-list for item-icon hosts (#29): only Steam's CDNs may be loaded as an <img src>,
 *  so a malicious/compromised market response can't point src at an attacker host and
 *  beacon the bot's real/proxy IP. A rejected URL yields '' (placeholder, no request). */
const ALLOWED_ICON_HOSTS = /(^|\.)(steamstatic\.com|akamaihd\.net|steamcommunity\.com)$/i;
function safeIconUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url, location.origin);
    return (u.protocol === 'https:' && ALLOWED_ICON_HOSTS.test(u.hostname)) ? u.href : '';
  } catch { return ''; }
}

/** Stall guard for self-rescheduling pollers (#27): true once `done` has not advanced
 *  for POLL_STALL_MS while the job still reports running — i.e. a wedged backend job —
 *  so the UI stops polling forever and stops lying about progress. */
const POLL_STALL_MS = 180000; // 3 min of zero progress → give up
function pollerStalled(key, done) {
  const s = (state._pollStall ||= {});
  const now = Date.now();
  const rec = s[key] || (s[key] = { last: done, at: now });
  if (done > rec.last) { rec.last = done; rec.at = now; return false; }
  return now - rec.at > POLL_STALL_MS;
}
function resetPoller(key) { if (state._pollStall) delete state._pollStall[key]; }

// Vault unlock is handled at the CLI on boot (the server only starts once the vault is
// unlocked or plaintext mode is chosen), so the dashboard needs no in-browser unlock.

// ════════════════════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════════════════════

/** TBL-01: the items table's <thead> is sticky at top:var(--ssim-stick-top). That
 *  offset is the live height of the (also-sticky) toolbar, so the pinned column
 *  headers always sit flush beneath it. The toolbar grows when the selection bar
 *  appears, so we OBSERVE its size rather than measuring once. */
function syncStickyOffsets() {
  const tb = el.toolbar;
  const h = (tb && !tb.classList.contains('hidden')) ? tb.offsetHeight : 0;
  document.documentElement.style.setProperty('--ssim-stick-top', h + 'px');
}
function setupStickyHeader() {
  syncStickyOffsets();
  if (typeof ResizeObserver !== 'undefined' && el.toolbar) {
    new ResizeObserver(syncStickyOffsets).observe(el.toolbar);
  }
  window.addEventListener('resize', syncStickyOffsets);
}

// ════════════════════════════════════════════════════════════════════════════
//  FB-04: modal infrastructure (Esc / focus-trap / return-focus / scroll-lock)
//  Layered OVER the existing show/hide-via-`.hidden` modals through a class
//  MutationObserver — no per-modal open/close fn is modified. Esc routes through
//  each modal's REAL close fn (with its cleanup) via this registry.
// ════════════════════════════════════════════════════════════════════════════
const OVERLAY_CLOSERS = new Map([
  ['modal-overlay', closeAddAccount], ['env-overlay', closeEnvModal], ['folder-overlay', closeFolderModal],
  ['move-overlay', closeMoveModal], ['ban-overlay', closeBan], ['edit-overlay', closeEditAccount], ['trade-overlay', closeTradeModal],
  ['sell-overlay', closeSellModal], ['buy-overlay', closeBuyModal], ['fbuy-overlay', closeFolderBuy],
  ['bulk-overlay', closeBulk], ['logs-overlay', closeLogs], ['offers-overlay', closeTradeOffers],
  ['login-overlay', closeLogin], ['attach-overlay', closeAttach], ['csfloat-overlay', closeCsFloat],
  ['sda-overlay', closeSda],
  ['confirm-overlay', () => closeConfirm(false)],   // FB-01: Esc / registry-close = safe cancel (no-op)
]);
const FB04 = { stack: [], triggers: new WeakMap(), lastTrigger: null };
// H-FE-010: teardown hooks run when a modal reaches onModalClose (any close path — X, backdrop,
// Esc). The lazily-built Trade-Up/Casket overlays self-reschedule status pollers; without a close
// hook those timers keep firing status fetches + DOM writes into a hidden overlay after close.
// Keyed by overlay id; runs exactly on hide.
const MODAL_TEARDOWNS = new Map();
function modalOverlays() { return Array.from(document.querySelectorAll('[id$="-overlay"]')); }
function topOpenOverlay() {
  const open = modalOverlays().filter((o) => !o.classList.contains('hidden'));
  if (!open.length) return null;
  for (let i = FB04.stack.length - 1; i >= 0; i--) if (open.includes(FB04.stack[i])) return FB04.stack[i];
  return open[open.length - 1];
}
function modalFocusables(container) {
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((n) => n.offsetParent !== null);
}
function onModalOpen(overlay) {
  // The OBSERVER fires after the open fn already moved focus INTO the modal, so capture the
  // element that was focused just BEFORE it opened (tracked continuously below) as the trigger.
  FB04.triggers.set(overlay, FB04.lastTrigger);
  FB04.stack.push(overlay);
  document.documentElement.style.overflow = 'hidden';   // scroll-lock while any modal is open
  setTimeout(() => {                                     // autofocus AFTER the open fn populates
    if (overlay.classList.contains('hidden')) return;
    const panel = overlay.firstElementChild || overlay;
    if (panel.contains(document.activeElement)) return; // an open fn already set focus — respect it
    const f = modalFocusables(panel);
    const firstField = f.find((n) => /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) && n.type !== 'checkbox' && n.type !== 'radio');
    (firstField || f[0])?.focus();
  }, 30);
}
/** FB-04 hardening: a trigger is safe to restore focus to only if it's still in the DOM,
 *  enabled, visible, and focusable — otherwise we leave focus on <body> (safe default). */
function isRestorable(node) {
  return !!node && document.contains(node) && !node.disabled
    && (node.offsetParent !== null || node === document.body)
    && typeof node.focus === 'function';
}
function onModalClose(overlay) {
  MODAL_TEARDOWNS.get(overlay.id)?.();   // H-FE-010: stop any per-modal poller before draining state
  const i = FB04.stack.indexOf(overlay);
  if (i >= 0) FB04.stack.splice(i, 1);
  const trigger = FB04.triggers.get(overlay);
  FB04.triggers.delete(overlay);
  if (FB04.stack.length === 0) document.documentElement.style.overflow = '';
  // Defer one macrotask: hiding the modal auto-blurs the focused field to <body>; restoring
  // now would be overridden by that. (A macrotask also fires when paint/rAF is throttled.)
  setTimeout(() => {
    if (topOpenOverlay()) return;                 // a nested modal is still open → leave focus to it
    if (isRestorable(trigger)) { try { trigger.focus(); } catch { /* fall through to safe default */ } }
    // safe default: do nothing — focus stays on <body> rather than a hidden element
  }, 0);
}
// Wire a modal overlay's hidden↔shown class toggles to the FB-04 open/close lifecycle. Applied to
// every static overlay at boot AND to lazily-built feature overlays (Trade-Up/Casket) at creation,
// so their close reliably reaches onModalClose and never strands the scroll-lock (H-FE-009).
function observeOverlay(overlay) {
  new MutationObserver(() => {
    const hidden = overlay.classList.contains('hidden');
    const tracked = FB04.stack.includes(overlay);
    if (!hidden && !tracked) onModalOpen(overlay);
    else if (hidden && tracked) onModalClose(overlay);
  }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

function setupModalInfra() {
  // FB-04 hardening: track the last element focused OUTSIDE any modal → the trigger to
  // restore focus to on close. focusin (capture) is PRIMARY and covers keyboard opens
  // (Tab→Enter); pointerdown (capture) is the fallback for mouse opens, resolving the
  // clicked control even when the click lands on an inner icon/span.
  const outsideModal = (n) => n && n.closest && !n.closest('[id$="-overlay"]');
  document.addEventListener('focusin', (e) => { if (outsideModal(e.target)) FB04.lastTrigger = e.target; }, true);
  document.addEventListener('pointerdown', (e) => {
    const t = e.target && e.target.closest && e.target.closest('button, a, [role="button"], input, select, textarea, [tabindex]');
    if (outsideModal(t)) FB04.lastTrigger = t;
  }, true);
  modalOverlays().forEach(observeOverlay);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Tab') return;
    const top = topOpenOverlay();
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      const close = OVERLAY_CLOSERS.get(top.id);
      if (close) close(); else top.classList.add('hidden');
      return;
    }
    // Tab focus-trap inside the top-most modal
    const f = modalFocusables(top.firstElementChild || top);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  FB-01: styled, async consequence dialog — replaces native confirm() on every
//  money / asset / destructive path. Resolves a boolean; the gated action runs
//  ONLY on resolve(true) (H1). One decision per dialog (H2). Dismiss = false (H3).
// ════════════════════════════════════════════════════════════════════════════
let _confirmState = null;
function closeConfirm(val) { if (_confirmState) _confirmState.finish(val); }
function ssimConfirm(opts = {}) {
  const { title = 'Confirm', body = '', confirmLabel = 'Confirm', confirmIcon = 'fa-check', tone = 'danger', typedWord = null } = opts;
  return new Promise((resolve) => {
    const ov = $('confirm-overlay'), ok = $('confirm-ok'), cancel = $('confirm-cancel');
    const typedWrap = $('confirm-typed-wrap'), typedInput = $('confirm-typed-input');
    let settled = false, onType = null;
    function cleanup() {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      ov.removeEventListener('click', onBackdrop);
      if (onType) typedInput.removeEventListener('input', onType);
    }
    function finish(val) {
      if (settled) return;                 // H2: idempotent — exactly one decision per dialog
      settled = true; _confirmState = null;
      cleanup();
      ov.classList.add('hidden');          // → FB-04 onModalClose (scroll unlock + focus restore)
      resolve(val);
    }
    const onOk = () => { if (!ok.disabled) finish(true); };            // H1: true ONLY via the confirm button
    const onCancel = () => finish(false);                              // H3
    const onBackdrop = (e) => { if (e.target === ov) finish(false); }; // H3
    _confirmState = { finish };
    $('confirm-title').textContent = title;
    $('confirm-body').innerHTML = body;    // callers escapeHtml all dynamic values
    // Tone → DS .btn variant (presentation only; the money-confirm LOGIC below is untouched).
    const tones = {
      danger: { wrap: 'bg-danger/15 text-danger', icon: 'fa-triangle-exclamation', btn: 'btn-danger' },
      spend:  { wrap: 'bg-buy/15 text-buy',        icon: 'fa-circle-exclamation',    btn: 'btn-buy' },
      brand:  { wrap: 'bg-brand/15 text-brand',    icon: 'fa-circle-info',           btn: 'btn-primary' },
    };
    const t = tones[tone] || tones.danger;
    const iconEl = $('confirm-icon');
    iconEl.className = `w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${t.wrap}`;
    iconEl.innerHTML = `<i class="fa-solid ${opts.iconClass || t.icon}"></i>`;
    ok.className = `btn ${t.btn} flex-1 disabled:opacity-50 disabled:cursor-not-allowed`;
    ok.innerHTML = `<i class="fa-solid ${confirmIcon}"></i><span>${escapeHtml(confirmLabel)}</span>`;
    if (typedWord) {                        // typed-confirm gate for the largest spends
      typedWrap.classList.remove('hidden');
      $('confirm-typed-word').textContent = typedWord;
      typedInput.value = ''; ok.disabled = true;
      onType = () => { ok.disabled = typedInput.value.trim() !== typedWord; };
      typedInput.addEventListener('input', onType);
    } else {
      typedWrap.classList.add('hidden'); ok.disabled = false;
    }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    ov.addEventListener('click', onBackdrop);
    ov.classList.remove('hidden');         // → FB-04 onModalOpen (scroll lock + focus trap)
    // DEFENSIVE FOCUS: Cancel (or the typed field) — NEVER the confirm/destructive button.
    setTimeout(() => { (typedWord ? typedInput : cancel).focus(); }, 45);
  });
}

/** User-resizable sidebar: drag the #sidebar-resizer handle to set the left panel's width.
 *  Persists the chosen width (ssim.sidebarWidth) like other prefs; absent → the w-72 default. */
function setupSidebarResize() {
  const aside  = $('app-sidebar');
  const handle = $('sidebar-resizer');
  if (!aside || !handle) return;

  const MIN = 220, MAX = 560;
  const clamp = (w) => Math.max(MIN, Math.min(MAX, w));

  // Restore a previously chosen width; if none saved, leave the w-72 default untouched.
  const saved = parseInt(localStorage.getItem('ssim.sidebarWidth') || '', 10);
  if (Number.isFinite(saved)) aside.style.width = clamp(saved) + 'px';

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    aside.style.width = clamp(e.clientX - aside.getBoundingClientRect().left) + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing-x');
    localStorage.setItem('ssim.sidebarWidth', String(parseInt(aside.style.width, 10)));
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add('resizing-x');   // global col-resize cursor + no text selection
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  // Double-click resets to the built-in default width.
  handle.addEventListener('dblclick', () => {
    aside.style.width = '';
    localStorage.removeItem('ssim.sidebarWidth');
  });
}

function bindStaticEvents() {
  // Top-level nav rail (W1_10) — single delegated handler, mirrors onSidebarClick.
  el.navRail.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (b) setNav(b.dataset.nav);
  });
  el.btnBackDashboard.addEventListener('click', showDashboard);
  el.btnGlobalMaster.addEventListener('click', showGlobalMaster);
  el.btnEnvMaster.addEventListener('click', selectEnvMaster);
  // Add-account / add-folder buttons moved into the Accounts module (IA refactor 2026-07-09) —
  // their tree rows open the same modals via onAccountsClick delegation.
  el.btnRefreshAll.addEventListener('click', refreshAll);
  el.refreshFailedClose.addEventListener('click', hideRefreshFailures);
  // "End Task" buttons — each confirms first, then co-operatively cancels the live job.
  el.refreshEnd.addEventListener('click', () => endTask({ label: 'this refresh', endpoint: '/api/inventory/refresh-cancel', button: el.refreshEnd }));
  el.massEnd.addEventListener('click', () => endTask({ label: 'this mass trade', endpoint: '/api/trade/mass-cancel', button: el.massEnd }));
  el.sellEnd.addEventListener('click', () => endTask({ label: 'this market sale', endpoint: '/api/market/sell-cancel', button: el.sellEnd }));
  el.fbuyEnd.addEventListener('click', () => endTask({ label: 'this mass buy', endpoint: '/api/market/folder-buy-cancel', button: el.fbuyEnd }));
  el.btnGameCs2.addEventListener('click', () => void setGame('cs2'));
  el.btnGameTf2.addEventListener('click', () => void setGame('tf2'));
  el.btnLoad.addEventListener('click', refreshAccount);
  el.searchInput.addEventListener('input', onSearch);
  // Phase 2: value-filter (A) + account search/quick-filter (B+C)
  el.valueFilterBtn.addEventListener('click', selectUnderValue);
  el.valueFilterInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); selectUnderValue(); } });
  el.accountSearch.addEventListener('input', (e) => { state.accountSearch = e.target.value; renderSidebar(); });
  el.accountFilter.addEventListener('change', (e) => { state.accountFilter = e.target.value; renderSidebar(); });
  el.accountSort.addEventListener('change', (e) => { state.accountSort = e.target.value; renderSidebar(); });
  // account logs modal (Phase 4)
  el.logsClose.addEventListener('click', closeLogs);
  // trade-offers manager
  bindOffersControls();
  // UX: no backdrop-click close — modals close via X / Cancel / Esc only (prevents accidental loss).

  // add-account
  el.modalClose.addEventListener('click', closeAddAccount);
  el.modalCancel.addEventListener('click', closeAddAccount);
  el.addForm.addEventListener('submit', submitAddAccount);
  // account login (Feature 1)
  if (el.btnAccountLogin) el.btnAccountLogin.addEventListener('click', openLogin);
  if (el.loginClose) el.loginClose.addEventListener('click', closeLogin);
  if (el.loginOverlay) el.loginOverlay.addEventListener('click', onLoginClick);
  if (el.loginCredForm) el.loginCredForm.addEventListener('submit', submitLoginCredentials);
  if (el.loginEnv) el.loginEnv.addEventListener('change', () => { if (LOGIN.method === 'qr' && !el.loginOverlay.classList.contains('hidden')) startQr(); });
  // attach maFile → Full (Feature 1)
  if (el.attachClose) el.attachClose.addEventListener('click', closeAttach);
  if (el.attachCancel) el.attachCancel.addEventListener('click', closeAttach);
  if (el.attachForm) el.attachForm.addEventListener('submit', submitAttach);
  // CSFloat workspace (Feature 2)
  if (el.csfloatClose) el.csfloatClose.addEventListener('click', closeCsFloat);
  // SDA overview (Phase 6) wiring
  if (el.sdaClose) el.sdaClose.addEventListener('click', closeSda);
  if (el.sdaOtpCopy) el.sdaOtpCopy.addEventListener('click', copySdaOtp);
  if (el.sdaConfRefresh) el.sdaConfRefresh.addEventListener('click', refreshSdaConfirmations);
  if (el.sdaConfApproveAll) el.sdaConfApproveAll.addEventListener('click', () => respondSda([], true, true));
  if (el.sdaConfApproveSel) el.sdaConfApproveSel.addEventListener('click', () => { const ids = selectedSdaIds(); if (ids.length) respondSda(ids, true); });
  if (el.csfloatTabs) el.csfloatTabs.addEventListener('click', onCsfTabClick);
  if (el.csfloatBody) el.csfloatBody.addEventListener('click', onCsfBodyClick);
  if (el.csfloatBody) el.csfloatBody.addEventListener('submit', onCsfBodySubmit);
  if (el.csfloatBody) el.csfloatBody.addEventListener('input', onCsfBodyInput);
  if (el.csfloatBody) el.csfloatBody.addEventListener('change', onCsfBodyInput);
  // environment
  el.envClose.addEventListener('click', closeEnvModal);
  el.envCancel.addEventListener('click', closeEnvModal);
  el.envForm.addEventListener('submit', submitEnv);
  // folder
  el.folderClose.addEventListener('click', closeFolderModal);
  el.folderCancel.addEventListener('click', closeFolderModal);
  el.folderForm.addEventListener('submit', submitFolder);
  // move
  el.moveClose.addEventListener('click', closeMoveModal);
  el.moveCancel.addEventListener('click', closeMoveModal);
  el.moveForm.addEventListener('submit', submitMove);
  el.moveEnv.addEventListener('change', () => populateMoveFolders(el.moveEnv.value, null));
  // ban checker
  el.banClose.addEventListener('click', closeBan);
  el.banBody.addEventListener('click', onBanBodyClick);
  // edit account
  el.editClose.addEventListener('click', closeEditAccount);
  el.editCancel.addEventListener('click', closeEditAccount);
  el.editForm.addEventListener('submit', submitEditAccount);
  el.editDelete.addEventListener('click', deleteEditAccount);
  // trade
  el.btnClearSel.addEventListener('click', () => { clearSelection(); renderMain(); });
  el.btnSendSel.addEventListener('click', openTradeModal);
  el.tradeClose.addEventListener('click', closeTradeModal);
  el.tradeCancel.addEventListener('click', closeTradeModal);
  el.tradeForm.addEventListener('submit', submitTrade);
  el.tradeForm.querySelectorAll('input[name="target"]').forEach((r) => r.addEventListener('change', updateTradeTargetVisibility));
  // market sell
  el.btnSellSel.addEventListener('click', openSellModal);
  el.sellClose.addEventListener('click', closeSellModal);
  el.sellCancel.addEventListener('click', closeSellModal);
  el.sellForm.addEventListener('submit', submitSell);
  el.sellPreviewBtn.addEventListener('click', previewSell);
  // toggle the custom-price field + recompute the preview when the strategy changes
  el.sellForm.querySelectorAll('input[name="sellstrategy"]').forEach((r) => r.addEventListener('change', () => {
    toggleSellCustomRow();
    if (!el.sellPreviewResult.classList.contains('hidden')) previewSell();
  }));
  // re-price live as the custom amount is typed (only while a preview is shown)
  el.sellCustomPrice.addEventListener('input', () => {
    if (sellStrategy() === 'custom' && !el.sellPreviewResult.classList.contains('hidden')) previewSell();
  });
  // market buy
  if (el.btnBuyMarket) el.btnBuyMarket.addEventListener('click', openBuyModal);
  el.buyClose.addEventListener('click', closeBuyModal);
  el.buyCancel.addEventListener('click', closeBuyModal);
  el.buyForm.addEventListener('submit', submitBuy);
  el.buyAccount.addEventListener('change', updateBuyWallet);
  el.buyAccount.addEventListener('input', updateBuyWallet);
  el.buyPriceFetch.addEventListener('click', fetchBuyPrice);
  el.buyName.addEventListener('input', () => { clearTimeout(state.buySearchTimer); state.buySearchTimer = setTimeout(searchBuyItems, 350); });
  el.buyName.addEventListener('blur', () => setTimeout(hideBuySearch, 200));
  el.buyQty.addEventListener('input', recomputeBuyTotal);
  el.buyPrice.addEventListener('input', recomputeBuyTotal);
  if (el.buyMax) el.buyMax.addEventListener('click', fillMaxBuyQty);
  // folder mass-buy (the trigger button is created in renderFolderMaster)
  if (el.fbuyClose)  el.fbuyClose.addEventListener('click', closeFolderBuy);
  if (el.fbuyCancel) el.fbuyCancel.addEventListener('click', closeFolderBuy);
  if (el.fbuyForm)   el.fbuyForm.addEventListener('submit', submitFolderBuy);
  if (el.fbuyPriceFetch) el.fbuyPriceFetch.addEventListener('click', fetchFbuyPrice);
  if (el.fbuyName) {
    el.fbuyName.addEventListener('input', () => { clearTimeout(state.fbuySearchTimer); state.fbuySearchTimer = setTimeout(searchFbuyItems, 350); });
    el.fbuyName.addEventListener('blur', () => setTimeout(hideFbuySearch, 200));
  }
  // Feature 3 (masterpiece parity, ds:1936-1937): the split control TOGGLES directly on
  // click — src flips Steam↔CSFloat (server-validated; falls back to Steam with a toast
  // when no CSFloat key exists), cur flips EUR↔USD. The previous popover menus rendered
  // inside the pill's overflow-hidden box and were clipped invisible, so both buttons
  // read as completely dead (owner report 2026-07-08).
  if (el.srcBtn) el.srcBtn.addEventListener('click', () => setPriceSource(state.priceSource === 'csfloat' ? 'steam' : 'csfloat'));
  if (el.curBtn) el.curBtn.addEventListener('click', () => setCurrency(state.currency === 'EUR' ? 'USD' : 'EUR'));
  el.tradeEnv.addEventListener('change', () => { void populateTradeFolders(); });
  el.tradeFolder.addEventListener('change', buildRecipientList);
  el.tradeSearch.addEventListener('input', buildRecipientList);
  // bulk import
  el.bulkClose.addEventListener('click', closeBulk);
  el.bulkCancel.addEventListener('click', closeBulk);
  el.bulkSubmit.addEventListener('click', submitBulk);
  el.bulkEnv.addEventListener('change', populateBulkFolders);
  el.bulkSelectAll.addEventListener('change', onBulkSelectAll);
  el.bulkCsv.addEventListener('change', onBulkCsv);
  el.bulkVaultImport.addEventListener('click', onBulkVaultImport);
  document.querySelectorAll('.import-method').forEach((b) => b.addEventListener('click', () => selectImportMethod(b.dataset.method)));
}

/**
 * Hard license gate (client-guard). The dashboard must NOT render or operate
 * unless the backend confirms this device is licensed. On boot we probe
 * /api/system/status; anything other than {licensed:true} — the activation portal
 * answering with licensed:false, a 403 LICENSE_MISSING, a non-JSON body, or no
 * answer at all — sends us straight to the activation screen. The server also
 * physically refuses to serve the dashboard while unlicensed, so this is the
 * second line of defence (e.g. a stale tab left open from a prior session).
 */
/** An AbortSignal that fires after `ms` (feature-detected; falls back to a manual controller). Used to
 *  bound fetches so a backend that ACCEPTS but never ANSWERS can't hang the caller forever. (S23/S32) */
function timeoutSignal(ms) {
  try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms); } catch (_) { /* fall through */ }
  const c = new AbortController();
  setTimeout(() => { try { c.abort(); } catch (_) { /* noop */ } }, ms);
  return c.signal;
}

async function ensureLicensed() {
  let res, data;
  try {
    // S23: bound the probe — a backend that accepts but never answers used to hang init() forever, so the
    // ssim-locked overlay never lifted (a permanently blank window).
    res = await fetch('/api/system/status', { cache: 'no-store', signal: timeoutSignal(8000) });
    data = await res.json().catch(() => null);
  } catch (_) {
    // Unreachable / timed out / non-JSON → NOT necessarily unlicensed. Do NOT redirect: in sidecar mode
    // `/` is this same dashboard, so replace('/') was a reload loop (that also churned the session, S1).
    // Show a visible retry screen that auto-recovers when the backend answers. (S23)
    showBackendUnreachableScreen();
    return false;
  }
  if (res.ok && data && data.licensed === true) {
    // Footer version reflects the ACTUAL backend version (from pkg.version), so it can never go
    // stale like a hardcoded literal — and self-corrects after an auto-update swaps the backend.
    if (data.version) { const f = document.getElementById('footer-status'); if (f) f.textContent = 'v' + data.version; }
    return true;
  }
  // Distinguish an EXPLICIT "activation needed" (the portal answering licensed:false, or a 403
  // LICENSE_MISSING) — go to the activation screen — from an AMBIGUOUS 5xx/half-up backend, which is
  // treated as unreachable (retry screen) rather than looped. (S23)
  if (res.status === 403 || (data && data.licensed === false)) {
    window.location.replace('/'); // → activation screen (license.html)
    return false;
  }
  showBackendUnreachableScreen();
  return false;
}

/** S23: a visible "backend unreachable" screen shown INSTEAD of an automatic reload loop. It gently
 *  re-probes and reloads ONCE the backend confirms it is licensed (a deliberate, non-looping recovery),
 *  and offers a manual Retry. */
function showBackendUnreachableScreen() {
  if (document.getElementById('backend-unreachable')) return; // render once
  const node = document.createElement('div');
  node.id = 'backend-unreachable';
  node.className = 'fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 text-center px-6 bg-[#0a0a0f] text-slate-200';
  node.innerHTML = '<div style="font-size:18px;font-weight:600">Can’t reach SSIM’s backend</div>'
    + '<div style="opacity:.75;max-width:28rem">SSIM is starting or its backend is busy. Your saved data is safe. '
    + 'This will retry automatically; you can also retry now.</div>'
    + '<button id="backend-retry" class="px-4 py-2 rounded-lg bg-brand text-white text-sm font-semibold">Retry</button>';
  document.body.appendChild(node);
  const btn = document.getElementById('backend-retry');
  if (btn) btn.addEventListener('click', () => location.reload());
  const probe = async () => {
    if (!document.getElementById('backend-unreachable')) return; // dismissed
    try {
      const r = await fetch('/api/system/status', { cache: 'no-store', signal: timeoutSignal(6000) });
      const d = await r.json().catch(() => null);
      if (r.ok && d && d.licensed === true) { location.reload(); return; } // backend up → re-init cleanly (once)
    } catch (_) { /* still down */ }
    setTimeout(probe, 3000);
  };
  setTimeout(probe, 3000);
}

// ════════════════════════════════════════════════════════════════════════════
//  Feature 1 — Automated Max-Profit Trade-Ups (single-account modal)
//  Feature 2 — Storage Unit (Casket) management (single-account modal)
//  Built dynamically (self-contained); GC execution is gated server-side, so the
//  UI clearly shows when it is disabled and never pretends an item was moved.
// ════════════════════════════════════════════════════════════════════════════

/** Generic modal shell (matches the ban/move overlays). Returns the overlay element. */
function ensureFeatureOverlay(id, title, icon, widthClass) {
  let ov = document.getElementById(id);
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = id;
  ov.className = 'hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4';
  ov.innerHTML = `<div class="w-full ${widthClass || 'max-w-4xl'} max-h-[88vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden fade-in">
    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
      <h3 class="t16 font-bold text-white"><i class="fa-solid ${icon} text-brand mr-2"></i>${title}<span data-scope class="text-slate-500 font-mono t14 font-normal ml-2"></span></h3>
      <button data-close aria-label="Close" class="modal-x"><i class="fa-solid fa-xmark text-lg"></i></button>
    </div>
    <div data-toolbar class="px-6 py-3 border-b border-slate-800 shrink-0 flex items-center gap-3 flex-wrap"></div>
    <div data-body class="overflow-y-auto grow"></div>
    <div data-foot class="px-6 py-2.5 border-t border-slate-800 shrink-0 t10 text-slate-500"></div>
  </div>`;
  document.body.appendChild(ov);
  observeOverlay(ov); // route hidden↔shown through the FB-04 lifecycle (H-FE-009: no stranded scroll-lock)
  const close = () => ov.classList.add('hidden');
  ov.querySelector('[data-close]').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  return ov;
}

// ── Trade-Ups ────────────────────────────────────────────────────────────────
// `candidates` holds EVERY computable contract (we always fetch all=true); `tab` splits the view into
// 'profit' (profitCents > 0 — the old default) and 'all' (everything), each with multiselect + select-all.
const tuState = { username: null, candidates: [], selected: new Set(), tab: 'profit', execTimer: null };
function tuVisible() { return tuState.tab === 'profit' ? tuState.candidates.filter((c) => c.profitCents > 0) : tuState.candidates; }
// H-FE-010: closing the Trade-Up overlay stops its execute-status poller (otherwise it keeps
// firing /api/tradeup/execute-status + writing the hidden foot until the job reports running:false).
MODAL_TEARDOWNS.set('tradeup-overlay', () => { clearTimeout(tuState.execTimer); tuState.execTimer = null; });

async function openTradeUpModal(username) {
  const ov = ensureFeatureOverlay('tradeup-overlay', 'Trade-Ups', 'fa-arrow-trend-up', 'max-w-5xl');
  tuState.username = username; tuState.candidates = []; tuState.selected = new Set(); tuState.tab = 'profit';
  ov.querySelector('[data-scope]').textContent = `· ${username}`;
  ov.querySelector('[data-body]').innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-arrow-trend-up"></i></div><div class="empty-title">Scan this account for trade-up contracts.</div><div class="empty-sub">Reads the inventory and computes every possible contract from its skins — profitable ones highlighted.</div></div>`;
  ov.querySelector('[data-foot]').textContent = '';
  renderTuToolbar();
  ov.classList.remove('hidden'); // observeOverlay (H-FE-009) fires onModalOpen off the class mutation
}

function renderTuToolbar() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const tb = ov.querySelector('[data-toolbar]');
  const have = tuState.candidates.length;
  const profitN = tuState.candidates.filter((c) => c.profitCents > 0).length;
  const tabBtn = (id, label) => `<button data-tu-tab="${id}" class="px-3 py-1.5 rounded-lg t12 border ${tuState.tab === id ? 'border-brand text-brand bg-brand/10' : 'border-slate-700 text-slate-400 hover:text-slate-200'}">${label}</button>`;
  tb.innerHTML =
    `<button data-tu-scan class="btn btn-primary btn-sm"><i class="fa-solid fa-magnifying-glass-dollar"></i>Scan trade-ups</button>` +
    `<button data-tu-auto class="btn btn-danger btn-sm" title="Keep planning and crafting until this account has nothing left to trade up"><i class="fa-solid fa-wand-magic-sparkles"></i>Trade up everything</button>` +
    (have ? `
      <div class="flex gap-1.5 ml-1">${tabBtn('profit', `Profitable (${profitN})`)}${tabBtn('all', `All trade-ups (${tuState.candidates.length})`)}</div>
      <button data-tu-all class="btn btn-secondary btn-sm">Select all${tuState.tab === 'all' ? '' : ' profitable'}</button>
      <button data-tu-none class="btn btn-ghost btn-sm">Clear</button>
      <span class="ml-auto"></span>
      <button data-tu-start class="btn btn-danger btn-sm"><i class="fa-solid fa-bolt"></i>Execute (${tuState.selected.size})</button>` : '');
  tb.querySelector('[data-tu-scan]')?.addEventListener('click', tuScan);
  tb.querySelector('[data-tu-auto]')?.addEventListener('click', tuAuto);
  tb.querySelectorAll('[data-tu-tab]').forEach((b) => b.addEventListener('click', () => { tuState.tab = b.dataset.tuTab; renderTuList(); renderTuToolbar(); }));
  tb.querySelector('[data-tu-none]')?.addEventListener('click', () => { tuState.selected.clear(); renderTuList(); renderTuToolbar(); });
  // Select-all applies to the CURRENTLY VISIBLE tab (all vs profitable-only), and picks a
  // NON-OVERLAPPING run: contracts consume their inputs, so selecting two candidates that share
  // an asset is not executable — the backend refuses the whole batch with "asset is used by more
  // than one selected contract". Candidates are ranked best-first, so greedy keeps the best of
  // each overlapping cluster instead of making the operator deselect duplicates by hand.
  tb.querySelector('[data-tu-all]')?.addEventListener('click', () => {
    tuState.selected = new Set(tuPickDisjoint(tuVisible()).map(c => c.id));
    renderTuList(); renderTuToolbar();
  });
  tb.querySelector('[data-tu-start]')?.addEventListener('click', tuStart);
}

/** Largest run of candidates sharing no input asset, best first (mirrors the backend picker). */
function tuPickDisjoint(candidates) {
  const used = new Set();
  const out = [];
  for (const c of candidates) {
    const ids = (c.inputs || []).map(i => i.assetId).filter(Boolean);
    if (ids.length !== 10 || ids.some(id => used.has(id))) continue;
    ids.forEach(id => used.add(id));
    out.push(c);
  }
  return out;
}

async function tuScan() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const body = ov.querySelector('[data-body]');
  body.innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-spinner cs2-spin"></i></div><div class="empty-title">Refreshing inventory & computing trade-ups…</div></div>`;
  try {
    // Always fetch ALL contracts — the tabs split profitable vs all client-side (one scan, two views).
    const res = await api('/api/tradeup/candidates', { method: 'POST', body: JSON.stringify({ username: tuState.username, all: true }) });
    tuState.candidates = res.candidates || [];
    tuState.selected = new Set(tuState.candidates.filter(c => c.profitCents > 0).map(c => c.id)); // profitable auto-selected
    const profitN = tuState.candidates.filter(c => c.profitCents > 0).length;
    ov.querySelector('[data-foot]').innerHTML = [
      `${tuState.candidates.length} contract(s) · ${profitN} profitable · ${res.eligibleInputs} eligible input(s)`,
      ...(res.warnings || []).map(escapeHtml),
    ].join(' · ');
    renderTuList(); renderTuToolbar();
  } catch (err) {
    body.innerHTML = `<div class="empty"><div class="empty-icon text-danger"><i class="fa-solid fa-circle-exclamation"></i></div><div class="empty-title text-danger">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderTuList() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const body = ov.querySelector('[data-body]');
  if (!tuState.candidates.length) {
    body.innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-arrow-trend-up"></i></div><div class="empty-title">No trade-up contracts from this account's skins.</div><div class="empty-sub">Need at least 10 skins of one rarity + StatTrak status.</div></div>`;
    return;
  }
  const visible = tuVisible();
  if (!visible.length) {
    body.innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-arrow-trend-up"></i></div><div class="empty-title">No positive-profit trade-ups from this account's skins.</div><div class="empty-sub">Switch to <b>All trade-ups</b> to see every possible contract.</div></div>`;
    return;
  }
  const selCls = 'ring-1 ring-brand/60 border-brand/50 shadow-glow';
  body.innerHTML = `<div class="space-y-2 px-5 py-4">` + visible.map((c) => {
    const sel = tuState.selected.has(c.id);
    const inputsByName = {};
    for (const i of c.inputs) inputsByName[i.baseName] = (inputsByName[i.baseName] || 0) + 1;
    const inputsTxt = Object.entries(inputsByName).map(([n, q]) => `${q}× ${escapeHtml(n)}`).join(', ');
    const outsTxt = c.outcomes.map(o =>
      `<span class="pill pill--neutral"><span class="text-slate-200">${escapeHtml(o.name)}</span><span class="text-slate-500">${escapeHtml(o.wear)}</span><span class="text-listed font-semibold">${(o.probability * 100).toFixed(1)}%</span><span class="font-mono ${o.priceCents == null ? 'text-slate-600' : 'text-slate-300'}">${o.priceCents == null ? '—' : fmtCents(o.priceCents)}</span></span>`).join('');
    const profit = c.profitCents > 0;
    const executable = c.inputs.every(i => i.assetId);
    return `<label class="surface p-3.5 flex gap-3 items-start cursor-pointer transition ${sel ? selCls : 'hover:border-brand/40'}">
      <input type="checkbox" data-tu-id="${escapeAttr(c.id)}" ${sel ? 'checked' : ''} class="mt-1 accent-brand w-4 h-4 shrink-0">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="t13 font-bold text-white">${escapeHtml(c.rarityLabel)} <i class="fa-solid fa-arrow-right-long text-brand-light t10 mx-0.5"></i> ${escapeHtml(c.outputRarityLabel)}</span>
          <span class="pill pill--neutral">${escapeHtml(c.collectionLabel)}</span>
          <span class="pill pill--neutral">avg float ${c.avgFloat.toFixed(3)}</span>
          ${c.fullyPriced ? '' : '<span class="pill pill--warn" title="Some prices still loading">~est prices</span>'}
          ${executable ? '' : '<span class="pill pill--danger" title="Missing asset ids — cannot execute">no asset ids</span>'}
        </div>
        <div class="t10 text-slate-500 mt-1.5 truncate" title="${escapeAttr(inputsTxt)}">Inputs: ${inputsTxt}</div>
        <div class="flex flex-wrap gap-1.5 mt-2">${outsTxt}</div>
      </div>
      <div class="text-right shrink-0 pl-3 border-l border-slate-800 self-stretch flex flex-col justify-center">
        <div class="t16 font-bold ${profit ? 'text-success' : 'text-danger'} leading-none">${profit ? '+' : '−'}${fmtCents(Math.abs(c.profitCents))}</div>
        <div class="t10 text-slate-500 font-mono mt-1.5">cost ${fmtCents(c.costCents)}</div>
        <div class="t10 text-slate-500 font-mono">EV ${fmtCents(c.evCents)}</div>
      </div></label>`;
  }).join('') + `</div>`;
  body.querySelectorAll('[data-tu-id]').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.tuId;
    const lbl = cb.closest('label');
    if (cb.checked) { tuState.selected.add(id); lbl?.classList.remove('hover:border-brand/40'); lbl?.classList.add(...selCls.split(' ')); }
    else { tuState.selected.delete(id); lbl?.classList.remove(...selCls.split(' ')); lbl?.classList.add('hover:border-brand/40'); }
    renderTuToolbar();
  }));
}

async function tuStart() {
  const chosen = tuState.candidates.filter(c => tuState.selected.has(c.id) && c.inputs.every(i => i.assetId));
  if (!chosen.length) { toast('Select at least one executable contract (with asset ids)', 'warn'); return; }
  const contracts = chosen.map(c => ({
    inputAssetIds: c.inputs.map(i => i.assetId), rarityId: c.rarityId, stattrak: !!c.stattrak,
    // Carried for the run summary, so it can report what the run actually cost.
    costCents: c.costCents, unpricedInputs: c.inputs.filter(i => i.priceCents == null).length,
  }));
  const cost = chosen.reduce((n, c) => n + (c.costCents || 0), 0);
  const ev = chosen.reduce((n, c) => n + (c.evCents || 0), 0);
  const ok = await ssimConfirm({
    title: 'Execute trade-ups?',
    body: `Execute <b class="text-slate-100">${chosen.length}</b> trade-up(s) on <b class="text-slate-100">${escapeHtml(tuState.username)}</b>?`
      + `<div class="mt-2 flex justify-center gap-5 t12"><span class="text-slate-400">input <b class="text-slate-100 font-mono">${fmtCents(cost)}</b></span>`
      + `<span class="text-slate-400">expected <b class="${ev >= cost ? 'text-success' : 'text-danger'} font-mono">${fmtCents(ev)}</b></span></div>`
      + `<div class="mt-2"><span class="text-rose-400 font-semibold">Each destroys 10 real items. IRREVERSIBLE.</span></div>`,
    confirmLabel: 'Execute', confirmIcon: 'fa-bolt', tone: 'danger',
  });
  if (!ok) return;
  try {
    await api('/api/tradeup/execute', { method: 'POST', body: JSON.stringify({ username: tuState.username, contracts }) });
    tuPollExec();
  } catch (err) { toast(err.message, 'error'); }
}

/**
 * "Trade up everything": hand the account to the backend planner, which loops
 * plan → craft → settle → re-plan until nothing is left. One click, then walk away.
 *
 * The scope choice lives INSIDE the confirm dialog because it changes what gets destroyed:
 * profitable-only (default) crafts positive-EV contracts, while "every possible contract"
 * also crafts the ones that lose money. Both are legitimate; neither should be a silent default.
 */
async function tuAuto() {
  const ok = await ssimConfirm({
    title: 'Trade up everything?',
    body: `SSIM will repeatedly scan <b class="text-slate-100">${escapeHtml(tuState.username)}</b> and craft every contract it can, `
      + `re-reading the inventory after each batch so the items it just created get traded up too.`
      + `<br><span class="text-rose-400 font-semibold">Each contract destroys 10 real items. IRREVERSIBLE.</span>`
      + `<label class="flex items-start gap-2 mt-3 p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 cursor-pointer text-left">
           <input type="checkbox" id="tu-auto-all" class="mt-0.5 accent-rose-500 w-4 h-4 shrink-0">
           <span class="t12 text-slate-300">Also craft <b>unprofitable</b> contracts<br>
             <span class="t10 text-slate-500">Off: only positive-EV contracts (recommended). On: literally every possible trade-up, including ones that destroy value.</span></span>
         </label>`,
    confirmLabel: 'Start', confirmIcon: 'fa-wand-magic-sparkles', tone: 'danger',
  });
  if (!ok) return;
  // Read the scope straight after the dialog resolves — finish() only hides the overlay, so the
  // checkbox is still in the DOM and nothing else has run that could replace the confirm body.
  const allEl = document.getElementById('tu-auto-all');
  const profitableOnly = !(allEl && allEl.checked);
  try {
    await api('/api/tradeup/auto', { method: 'POST', body: JSON.stringify({ username: tuState.username, profitableOnly }) });
    toast(profitableOnly ? 'Auto trade-up started (profitable contracts)' : 'Auto trade-up started (every possible contract)', 'success');
    tuPollExec();
  } catch (err) { toast(err.message, 'error'); }
}

/**
 * Post-run summary: what the run consumed, what it actually produced, and the difference.
 *
 * `output` is the REAL result — the items the GC reported creating, read back and priced — not the
 * pre-craft expected value. Where that could not be established the panel says "unknown" rather than
 * showing a 0, and an incomplete input/output total is labelled as a floor.
 */
function renderTuSummary(j, crafted) {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const input = j.inputCents || 0;
  const known = j.outputResolved === true && typeof j.outputCents === 'number';
  const output = typeof j.outputCents === 'number' ? j.outputCents : null;
  const delta = output == null ? null : output - input;
  const items = (j.outputs || []).slice();
  // Group identical outputs so 30 crafts read as a short list, not 30 lines.
  const byName = new Map();
  for (const o of items) {
    const k = o.name || 'Unknown';
    const e = byName.get(k) || { name: k, n: 0, cents: 0, priced: 0 };
    e.n++; if (typeof o.priceCents === 'number') { e.cents += o.priceCents; e.priced++; }
    byName.set(k, e);
  }
  const rows = [...byName.values()].sort((a, b) => b.cents - a.cents).map(e =>
    `<div class="flex items-center gap-2 t12 py-0.5">
       <span class="text-slate-500 font-mono w-8 shrink-0">${e.n}×</span>
       <span class="text-slate-200 truncate flex-1">${escapeHtml(e.name)}</span>
       <span class="font-mono shrink-0 ${e.priced ? 'text-slate-300' : 'text-slate-600'}">${e.priced ? fmtCents(e.cents) : 'unpriced'}</span>
     </div>`).join('');
  const stat = (label, value, cls) =>
    `<div class="text-center px-3"><div class="t10 uppercase tracking-wide text-slate-500">${label}</div><div class="t16 font-bold font-mono ${cls || 'text-slate-100'}">${value}</div></div>`;

  ov.querySelector('[data-body]').innerHTML = `
    <div class="px-5 py-5">
      <div class="surface p-4">
        <div class="flex items-center gap-2 mb-3">
          <i class="fa-solid fa-clipboard-check text-brand"></i>
          <span class="t14 font-bold text-slate-100">Trade-up summary</span>
          <span class="t11 text-slate-500">${crafted} contract(s) · ${escapeHtml(tuState.username)}</span>
        </div>
        <div class="flex items-center justify-center gap-2 py-2">
          ${stat('Input', fmtCents(input), 'text-danger')}
          <i class="fa-solid fa-arrow-right-long text-slate-600"></i>
          ${stat('Output', output == null ? 'unknown' : fmtCents(output), 'text-success')}
          <span class="w-px h-8 bg-slate-800 mx-1"></span>
          ${stat('Result', delta == null ? '—' : `${delta >= 0 ? '+' : '−'}${fmtCents(Math.abs(delta))}`, delta == null ? 'text-slate-500' : delta >= 0 ? 'text-success' : 'text-danger')}
        </div>
        ${j.unpricedInputs ? `<p class="t10 text-slate-500 text-center">${j.unpricedInputs} input(s) had no market price — the input total is a floor.</p>` : ''}
        ${output != null && !known ? '<p class="t10 text-amber-400 text-center">Some outputs could not be priced — the output total is a floor.</p>' : ''}
        ${output == null ? '<p class="t10 text-amber-400 text-center">The crafted items could not be read back, so the output value is unknown. The crafts themselves succeeded — check the account in-game.</p>' : ''}
        ${rows ? `<div class="mt-3 pt-3 border-t border-slate-800 max-h-56 overflow-y-auto">${rows}</div>` : ''}
        <div class="mt-3 flex justify-center"><button data-tu-scan class="btn btn-secondary btn-sm"><i class="fa-solid fa-magnifying-glass-dollar"></i>Scan again</button></div>
      </div>
    </div>`;
  ov.querySelector('[data-tu-scan]')?.addEventListener('click', tuScan);
  tuState.candidates = []; tuState.selected = new Set();   // the inventory changed underneath them
  renderTuToolbar();
}

/** The commonest failure reason of a finished trade-up run, for the toast. */
function tuFirstReason(j) { return ((j.failureReasons || [])[0] || {}).error || ''; }

/**
 * The run's failure reasons, commonest first, plus any submitted-but-unconfirmed contracts.
 *
 * The stop line has always pointed at "the failures" — and nothing ever rendered them, in either the
 * auto or the selected-contracts path, while the auto planner additionally wipes `results` at the top
 * of every round. That is how a 63-contract run reported "63 failed" and named no cause at all
 * (owner report 2026-08-12). `failureReasons` is the server-side tally that survives both.
 */
function tuFailureBreakdown(j) {
  const reasons = j.failureReasons || [];
  const unconfirmed = j.totalUnconfirmed || 0;
  if (!reasons.length && !unconfirmed) return '';
  const rows = reasons.map(r => `<li class="flex gap-2"><span class="text-amber-400 font-semibold shrink-0">${r.count}×</span><span>${escapeHtml(r.error)}</span></li>`);
  if (unconfirmed) {
    rows.push(`<li class="flex gap-2"><span class="text-sky-400 font-semibold shrink-0">${unconfirmed}×</span><span>submitted but not confirmed in time — these may well have crafted; verify in-game (never retried, a retry would destroy 10 more items)</span></li>`);
  }
  return `<ul class="mt-2 space-y-1 t10 text-slate-400 text-left">${rows.join('')}</ul>`;
}

function tuPollExec() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const foot = ov.querySelector('[data-foot]');
  clearTimeout(tuState.execTimer);
  resetPoller('tuExecErr'); // S17: start a clean error-retry window for this execution
  const tick = async () => {
    try {
      const j = await api('/api/tradeup/execute-status');
      resetPoller('tuExecErr'); // S17: a good poll clears the error-retry window
      const confirmed = (j.results || []).filter(r => r.confirmed).length;
      let line;
      if (!j.enabled) {
        line = `Execution disabled (${escapeHtml(j.statusReason)}) — nothing was crafted.`;
      } else if (j.auto) {
        // Auto runs many rounds, so the per-round counters alone are misleading ("2/3" three
        // times over). Lead with the cumulative total and name the phase we're actually in.
        const phase = j.phase === 'planning' ? 'scanning the inventory'
          : j.phase === 'settling' ? 'waiting for Steam to catch up'
          : j.phase === 'crafting' ? `crafting ${j.done}/${j.total}`
          : 'finished';
        line = `Auto trade-up · round ${j.round || 1} · ${escapeHtml(phase)} · ${j.totalCrafted || 0} crafted, ${j.totalFailed || 0} failed so far${j.cancelling ? ' · cancelling…' : ''}`;
      } else {
        line = `Executing ${j.done}/${j.total} · submitted ${j.crafted} (${confirmed} confirmed) · failed ${j.failed}${j.cancelling ? ' · cancelling…' : ''}`;
      }
      foot.innerHTML = `<span class="${j.enabled ? 'text-slate-300' : 'text-amber-400'}">${line}</span>` +
        (j.running ? ` <button data-tu-cancel class="ml-2 px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600 text-white">Cancel</button>` : '');
      foot.querySelector('[data-tu-cancel]')?.addEventListener('click', () => api('/api/tradeup/execute-cancel', { method: 'POST' }).catch(() => {}));
      // Auto spends most of its time planning (a full inventory refresh) and settling, so poll it
      // a little slower — 1.2s would just re-render the same phase line dozens of times.
      if (j.running) { tuState.execTimer = setTimeout(tick, j.auto ? 2000 : 1200); }
      else if (j.auto) {
        // Report the stop reason verbatim; "0 crafted" is a real outcome, never dressed up.
        const total = j.totalCrafted || 0;
        if (j.enabled) {
          foot.innerHTML = `<span class="${total ? 'text-slate-300' : 'text-amber-400'}">Auto trade-up finished · ${total} crafted, ${j.totalFailed || 0} failed over ${j.round || 0} round(s) — ${escapeHtml(j.autoStopReason || '')}</span>`
            + tuFailureBreakdown(j);
          toast(total ? `Auto trade-up: ${total} contract(s) crafted` : `Auto trade-up did nothing — ${tuFirstReason(j) || j.autoStopReason || 'no contract was possible'}`, total ? 'success' : 'warn');
          if (total) renderTuSummary(j, total);
        } else {
          toast(j.autoStopReason || j.statusReason || 'trade-up execution is disabled', 'warn');
        }
        // The account's inventory changed underneath every other view — re-pull the shared cache.
        await refreshActiveViewFromCache().catch(() => {});
      }
      else {
        // A finished selected-contracts run needs its reasons too: the old line only toasted an error
        // when execution was DISABLED, so an enabled run where every contract failed said nothing.
        // `done < total` with no cancel means the run gave up on a repeating failure — say so, or the
        // counts look like contracts that silently vanished.
        const gaveUp = !j.cancelled && j.done < j.total ? ' — stopped early, the same failure kept repeating' : '';
        foot.innerHTML = `<span class="${j.crafted ? 'text-slate-300' : 'text-amber-400'}">Finished · ${j.crafted} crafted (${confirmed} confirmed), ${j.failed} failed of ${j.total}${escapeHtml(gaveUp)}</span>`
          + tuFailureBreakdown(j);
        const failMsg = tuFirstReason(j) || (j.results || []).filter(r => r.error)[0]?.error;
        if (!j.enabled || !j.crafted) { if (failMsg) toast(failMsg, 'warn'); }
        else toast(`Trade-ups: ${j.crafted} submitted, ${confirmed} confirmed`, 'success');
        if (j.crafted) { renderTuSummary(j, j.crafted); await refreshActiveViewFromCache().catch(() => {}); }
      }
    } catch {
      // S17: a transient status-fetch error must not permanently kill the poller while the trade-up
      // keeps running server-side — it DESTROYS 10 real items per contract, so a frozen "Executing 2/5"
      // (its completion toast never firing) is the worst place to silently die. Bounded retry, mirroring
      // the refresh/mass/sell/casket pollers: keep polling at the same 1.2s cadence until POLL_STALL_MS
      // of CONTINUOUS errors, then give up with a visible terminal line — shown as status LOST, never as
      // success (do not fabricate a "done"); the operator must verify the irreversible outcome in-game.
      if (!pollerStalled('tuExecErr', 0)) { tuState.execTimer = setTimeout(tick, 1200); return; }
      resetPoller('tuExecErr');
      if (foot) foot.innerHTML = '<span class="text-amber-400">Lost contact with the job — status stopped; verify in-game.</span>';
    }
  };
  tick();
}

// ── Storage Units (caskets) ──────────────────────────────────────────────────
const ckState = { username: null, caskets: [], casketId: null, contents: [], invSel: new Set(), unitSel: new Set(), search: '', unitSearch: '', expanded: new Set(), error: null, moveTimer: null };
// H-FE-010: closing the Storage-Unit overlay stops its move-status poller (a long casket move would
// otherwise poll /api/casket/move-status + write the hidden foot for minutes after close).
MODAL_TEARDOWNS.set('casket-overlay', () => { clearTimeout(ckState.moveTimer); ckState.moveTimer = null; });

async function openCasketModal(username) {
  const ov = ensureFeatureOverlay('casket-overlay', 'Storage Units', 'fa-box-archive', 'max-w-5xl');
  Object.assign(ckState, { username, caskets: [], casketId: null, contents: [], invSel: new Set(), unitSel: new Set(), search: '', unitSearch: '', expanded: new Set(), error: null });
  ov.querySelector('[data-scope]').textContent = `· ${username}`;
  ov.querySelector('[data-toolbar]').innerHTML = `<label class="t10 uppercase tracking-wide text-slate-500 font-semibold">Storage unit</label><select data-ck-unit class="field !w-auto !py-1.5 t13"><option value="">— loading… —</option></select>`;
  ov.querySelector('[data-body]').innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-spinner cs2-spin"></i></div><div class="empty-title">Connecting to the game coordinator…</div></div>`;
  ov.classList.remove('hidden'); // observeOverlay (H-FE-009) fires onModalOpen off the class mutation
  // Load units (needs the GC library; degrades clearly if unavailable — shown in the unit panel).
  try {
    const r = await api(`/api/casket/${encodeURIComponent(username)}/list`);
    ckState.caskets = r.caskets || [];
  } catch (err) {
    ckState.caskets = []; ckState.error = err.message;
  }
  renderCasketUnitSelect();
  if (ckState.caskets.length) { ckState.casketId = ckState.caskets[0].id; await loadCasketContents(); }
  renderCasketPanels();
}

function renderCasketUnitSelect() {
  const ov = document.getElementById('casket-overlay'); if (!ov) return;
  const sel = ov.querySelector('[data-ck-unit]');
  sel.innerHTML = ckState.caskets.length
    ? ckState.caskets.map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)} (${c.count}/1000)</option>`).join('')
    : `<option value="">— no storage units —</option>`;
  if (ckState.casketId) sel.value = ckState.casketId;
  sel.onchange = async () => { ckState.casketId = sel.value; ckState.unitSel = new Set(); ckState.expanded = new Set(); await loadCasketContents(); renderCasketPanels(); };
}

async function loadCasketContents() {
  if (!ckState.casketId) { ckState.contents = []; return; }
  try {
    const r = await api(`/api/casket/${encodeURIComponent(ckState.username)}/contents?casketId=${encodeURIComponent(ckState.casketId)}`);
    ckState.contents = r.items || [];
  } catch { ckState.contents = []; }
}

/**
 * Storage-unit contents grouped into STACKS, the way the inventory side has always shown them.
 * The GC returns one row per asset, so an unstacked unit of 900 items was 900 unreadable rows;
 * identical items now collapse into one "name ×N" row that can be expanded to pick individual
 * floats (which matters — you often want the LOW float one out, not just any of them).
 *
 * Sorted by total value desc, then name, so the expensive things are at the top where you look.
 */
function casketUnitStacks() {
  const q = ckState.unitSearch.trim().toLowerCase();
  const by = new Map();
  for (const it of ckState.contents) {
    const name = it.marketHashName || 'Unknown item';
    if (q && !name.toLowerCase().includes(q)) continue;
    // Same name but a custom name-tag ⇒ a genuinely different item to a human — keep it separate.
    const key = name + (it.customName ? ` ${it.customName}` : '');
    let s = by.get(key);
    if (!s) {
      s = { key, name, customName: it.customName || '', iconUrl: it.iconUrl || '', resolved: it.resolved !== false, priceCents: null, priced: false, items: [] };
      by.set(key, s);
    }
    if (it.priced && s.priceCents == null) { s.priceCents = it.priceCents; s.priced = true; }
    s.items.push(it);
  }
  const stacks = [...by.values()];
  // Within a stack, best float first — that is the one an operator picks out by hand.
  for (const s of stacks) {
    s.items.sort((a, b) => (a.float ?? 1) - (b.float ?? 1));
    s.totalCents = s.priced ? s.priceCents * s.items.length : null;
  }
  stacks.sort((a, b) => (b.totalCents ?? -1) - (a.totalCents ?? -1) || a.name.localeCompare(b.name));
  return stacks;
}

/** Inventory items eligible to deposit (in-inventory, not on the market). One row per stack. */
function casketInvRows() {
  const inv = invFor(ckState.username);
  const items = (inv && inv.items) ? inv.items.filter(i => i.category !== 'listed' && Array.isArray(i.assetIds) && i.assetIds.length) : [];
  const q = ckState.search.trim().toLowerCase();
  return q ? items.filter(i => (i.marketHashName || '').toLowerCase().includes(q)) : items;
}

/**
 * Whether an item can actually be deposited into a CS2 storage unit (casket). The
 * GC rejects a handful of categories, so we gray these out rather than let a deposit
 * fail mid-batch: storage units themselves (can't nest), and Collectibles / Passes /
 * Gifts (coins, medals, pins, badges, operation passes). Type = the localized "Type"
 * tag (see InventoryManager.mapItem). Conservative on purpose — only the known-bad set.
 */
function casketStorable(item) {
  const name = (item.marketHashName || item.name || '').toLowerCase();
  if (name === 'storage unit') return false;
  const t = (item.type || '').toLowerCase();
  if (t === 'collectible' || t === 'pass' || t === 'gift') return false;
  // TRADE-HELD items cannot go in (2026-07-31). Steam's own notice says the item "cannot be consumed,
  // modified, or TRANSFERRED" while held, and a casket deposit is such a transfer — the GC silently
  // discards the request, so the old behaviour was a 15s-per-item wait ending in "unconfirmed".
  if (casketLockReason(item)) return false;
  return true;
}

/** Why this item can't be deposited right now, or '' when it can. Drives the greyed-out row label. */
function casketLockReason(item) {
  const exp = item && item.tradeLockExpiry ? Date.parse(item.tradeLockExpiry) : NaN;
  if (Number.isFinite(exp) && exp > Date.now()) {
    const d = new Date(exp);
    return `trade-locked until ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  // Non-tradable with no readable expiry still can't be transferred into a unit.
  if (item && item.tradable === false) return 'not tradable';
  return '';
}

function renderCasketPanels() {
  const ov = document.getElementById('casket-overlay'); if (!ov) return;
  const invRows = casketInvRows();
  const invCount = invRows.reduce((n, i) => casketStorable(i) ? n + i.assetIds.length : n, 0);
  const unit = ckState.caskets.find(c => c.id === ckState.casketId);
  const invInner = invRows.length ? invRows.map(i => {
    if (!casketStorable(i)) {
      // Name the ACTUAL reason: a trade hold is temporary and the operator wants to know WHEN it lifts,
      // which is very different information from "this type can never be stored".
      const lock = casketLockReason(i);
      const tip = lock
        ? `Steam blocks moving a trade-held item into a storage unit — ${lock}`
        : "This item type can't be stored in a storage unit";
      return `<div class="flex items-center gap-2.5 px-3 py-2 t12 opacity-40 cursor-not-allowed" title="${escapeAttr(tip)}">
        <i class="fa-solid ${lock ? 'fa-lock' : 'fa-ban'} w-3.5 text-slate-600 shrink-0"></i>
        <span class="truncate flex-1 text-slate-300">${escapeHtml(i.name || i.marketHashName)}</span>
        <span class="t10 uppercase tracking-wide text-slate-600 shrink-0">${lock ? escapeHtml(lock) : 'not storable'}</span>
        <span class="text-slate-600 font-mono">×${i.assetIds.length}</span></div>`;
    }
    const sel = ckState.invSel.has(i.marketHashName);
    return `<label class="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/40 cursor-pointer t12">
      <input type="checkbox" data-ck-inv="${escapeAttr(i.marketHashName)}" ${sel ? 'checked' : ''} class="accent-brand w-3.5 h-3.5 shrink-0">
      <span class="truncate flex-1 text-slate-200">${escapeHtml(i.name || i.marketHashName)}</span>
      <span class="text-slate-600 font-mono">×${i.assetIds.length}</span></label>`;
  }).join('') : `<div class="empty !py-10"><div class="empty-icon"><i class="fa-solid fa-box-open"></i></div><div class="empty-title">No depositable items in cache.</div><div class="empty-sub">Refresh the account to populate it.</div></div>`;
  const stacks = casketUnitStacks();
  const unitInner = stacks.length ? stacks.map(s => {
    const ids = s.items.map(i => String(i.id));
    const selN = ids.filter(id => ckState.unitSel.has(id)).length;
    const open = ckState.expanded.has(s.key);
    // Tri-state stack checkbox: all / none / some of the stack's assets are picked.
    const head = `<label class="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/40 cursor-pointer t12">
      <input type="checkbox" data-ck-stack="${escapeAttr(s.key)}" ${selN === ids.length ? 'checked' : ''} class="accent-brand w-3.5 h-3.5 shrink-0">
      ${s.iconUrl ? `<img src="${escapeAttr(safeIconUrl(s.iconUrl))}" alt="" loading="lazy" class="w-7 h-6 object-contain shrink-0" onerror="this.style.display='none'">` : '<i class="fa-solid fa-cube w-7 text-center text-slate-700 shrink-0"></i>'}
      <span class="truncate flex-1 ${s.resolved ? 'text-slate-200' : 'text-slate-500 italic'}">${escapeHtml(s.name)}${s.customName ? ` <span class="text-brand-light">“${escapeHtml(s.customName)}”</span>` : ''}</span>
      ${selN && selN < ids.length ? `<span class="t10 text-brand-light shrink-0">${selN} picked</span>` : ''}
      <span class="t10 font-mono shrink-0 ${s.priced ? 'text-slate-400' : 'text-slate-700'}">${s.priced ? fmtCents(s.totalCents) : '—'}</span>
      <span class="text-slate-500 font-mono shrink-0 w-8 text-right">×${ids.length}</span>
      <button type="button" data-ck-expand="${escapeAttr(s.key)}" class="btn btn-ghost btn-sm !py-0.5 !px-1.5 shrink-0" title="Show individual items (floats)"><i class="fa-solid fa-chevron-${open ? 'up' : 'down'} t10"></i></button></label>`;
    if (!open) return head;
    const rows = s.items.map(it => {
      const id = String(it.id);
      return `<label class="flex items-center gap-2.5 pl-10 pr-3 py-1.5 hover:bg-slate-800/40 cursor-pointer t11 bg-slate-950/40">
        <input type="checkbox" data-ck-unit-item="${escapeAttr(id)}" ${ckState.unitSel.has(id) ? 'checked' : ''} class="accent-brand w-3 h-3 shrink-0">
        <span class="font-mono text-slate-400 shrink-0">${it.float != null ? Number(it.float).toFixed(6) : '—'}</span>
        ${it.wear ? `<span class="t10 text-slate-500 shrink-0">${escapeHtml(it.wear)}</span>` : ''}
        <span class="flex-1"></span>
        ${it.paintSeed != null ? `<span class="t10 text-slate-600 font-mono shrink-0">seed ${it.paintSeed}</span>` : ''}
        <span class="t10 text-slate-700 font-mono shrink-0 truncate max-w-[9rem]" title="${escapeAttr(id)}">${escapeHtml(id)}</span></label>`;
    }).join('');
    return head + rows;
  }).join('') : `<div class="empty !py-10"><div class="empty-icon ${ckState.error ? 'text-warn' : ''}"><i class="fa-solid fa-${ckState.error ? 'triangle-exclamation' : 'box-archive'}"></i></div><div class="empty-title">${ckState.error ? escapeHtml(ckState.error) : (ckState.casketId ? (ckState.unitSearch ? 'No item matches that filter.' : 'Empty storage unit.') : 'No storage unit selected.')}</div>${ckState.error ? '<div class="empty-sub">Storage units need the GC layer (install globaloffensive + set SSIM_GC_VERIFIED=1).</div>' : ''}</div>`;
  // Unit value = only the PRICED items, so a half-loaded price cache can't understate it silently.
  const unitValue = ckState.contents.reduce((n, i) => i.priced ? n + i.priceCents : n, 0);
  const unpricedN = ckState.contents.filter(i => !i.priced).length;

  const pct = unit ? Math.min(100, Math.round((unit.count / 1000) * 100)) : 0;
  const capBar = unit ? `<div class="px-3 pt-2.5"><div class="h-1.5 rounded-full bg-slate-800 overflow-hidden"><div class="h-full rounded-full bg-brand" style="width:${pct}%"></div></div><div class="t10 text-slate-500 mt-1 font-mono">${unit.count} / 1000</div></div>` : '';

  ov.querySelector('[data-body]').innerHTML =
    `<div class="px-5 py-3 flex items-center gap-2 border-b border-slate-800">
       <input data-ck-search value="${escapeAttr(ckState.search)}" placeholder="Filter inventory…" class="field !py-1.5 !w-56 t12">
       <span class="ml-auto"></span>
       <button data-ck-deposit class="btn btn-primary btn-sm">Deposit <i class="fa-solid fa-arrow-right"></i></button>
       <button data-ck-withdraw class="btn btn-secondary btn-sm"><i class="fa-solid fa-arrow-left"></i> Withdraw</button>
     </div>
     <div class="grid grid-cols-2 gap-3 p-3" style="height:46vh">
       <div class="surface flex flex-col min-h-0">
         <div class="panel-head"><span class="panel-title">Inventory</span><span class="t10 text-slate-500">${invCount} item(s)</span><button data-ck-sel="inv" class="btn btn-ghost btn-sm ml-auto !py-1 !px-2">Select all</button></div>
         <div class="overflow-y-auto grow divide-y divide-slate-800/60">${invInner}</div>
       </div>
       <div class="surface flex flex-col min-h-0">
         <div class="panel-head gap-2">
           <span class="panel-title truncate">${unit ? escapeHtml(unit.name) : 'Storage unit'}</span>
           <input data-ck-unit-search value="${escapeAttr(ckState.unitSearch)}" placeholder="Filter unit…" class="field !py-1 !w-32 t11">
           <span class="t10 text-slate-500 shrink-0">${ckState.unitSel.size} selected</span>
           <button data-ck-sel="unit" class="btn btn-ghost btn-sm ml-auto !py-1 !px-2">Select all</button>
         </div>
         ${capBar}
         <div class="overflow-y-auto grow divide-y divide-slate-800/60 ${capBar ? 'mt-1' : ''}">${unitInner}</div>
         ${ckState.contents.length ? `<div class="px-3 py-1.5 border-t border-slate-800 t10 text-slate-500 flex items-center gap-2">
           <span>${stacks.length} stack(s) · ${ckState.contents.length} item(s)</span>
           <span class="ml-auto font-mono text-slate-300">${fmtCents(unitValue)}</span>
           ${unpricedN ? `<span class="text-slate-600" title="Prices for these are still loading — reopen in a moment">+${unpricedN} unpriced</span>` : ''}
         </div>` : ''}
       </div>
     </div>`;

  const body = ov.querySelector('[data-body]');
  body.querySelector('[data-ck-search]')?.addEventListener('input', (e) => { ckState.search = e.target.value; renderCasketPanels(); body.querySelector('[data-ck-search]')?.focus(); });
  body.querySelectorAll('[data-ck-inv]').forEach(cb => cb.addEventListener('change', () => { cb.checked ? ckState.invSel.add(cb.dataset.ckInv) : ckState.invSel.delete(cb.dataset.ckInv); }));
  body.querySelectorAll('[data-ck-unit-item]').forEach(cb => cb.addEventListener('change', () => { cb.checked ? ckState.unitSel.add(cb.dataset.ckUnitItem) : ckState.unitSel.delete(cb.dataset.ckUnitItem); renderCasketPanels(); }));
  // A stack checkbox selects/clears EVERY asset in that stack (the common case: "take all 12 out").
  body.querySelectorAll('[data-ck-stack]').forEach(cb => cb.addEventListener('change', () => {
    const stack = casketUnitStacks().find(s => s.key === cb.dataset.ckStack);
    if (!stack) return;
    for (const it of stack.items) cb.checked ? ckState.unitSel.add(String(it.id)) : ckState.unitSel.delete(String(it.id));
    renderCasketPanels();
  }));
  body.querySelectorAll('[data-ck-expand]').forEach(b => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); // the button sits inside the row's <label>
    const k = b.dataset.ckExpand;
    ckState.expanded.has(k) ? ckState.expanded.delete(k) : ckState.expanded.add(k);
    renderCasketPanels();
  }));
  body.querySelector('[data-ck-unit-search]')?.addEventListener('input', (e) => {
    ckState.unitSearch = e.target.value; renderCasketPanels();
    const f = body.querySelector('[data-ck-unit-search]');
    if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  });
  body.querySelector('[data-ck-sel="inv"]')?.addEventListener('click', () => { casketInvRows().filter(casketStorable).forEach(i => ckState.invSel.add(i.marketHashName)); renderCasketPanels(); });
  // Select-all respects the unit filter — otherwise filtering to "Case" then Select all would
  // silently pick the 900 items you just filtered OUT and withdraw the whole unit.
  body.querySelector('[data-ck-sel="unit"]')?.addEventListener('click', () => { casketUnitStacks().forEach(s => s.items.forEach(i => ckState.unitSel.add(String(i.id)))); renderCasketPanels(); });
  body.querySelector('[data-ck-deposit]')?.addEventListener('click', () => casketMove('deposit'));
  body.querySelector('[data-ck-withdraw]')?.addEventListener('click', () => casketMove('withdraw'));
}

async function casketMove(direction) {
  if (!ckState.casketId) { toast('Select a storage unit first', 'warn'); return; }
  let itemIds;
  // A manifest of what is actually moving — the whole point of naming the contents is that the
  // confirm dialog can say "3× AK-47 | Redline (FT)" instead of "34 item(s)".
  const manifest = new Map();
  if (direction === 'deposit') {
    const rows = casketInvRows().filter(i => ckState.invSel.has(i.marketHashName) && casketStorable(i));
    itemIds = rows.flatMap(i => i.assetIds);
    for (const r of rows) manifest.set(r.name || r.marketHashName, (manifest.get(r.name || r.marketHashName) || 0) + r.assetIds.length);
  } else {
    itemIds = [...ckState.unitSel];
    const sel = new Set(itemIds);
    for (const it of ckState.contents) {
      if (!sel.has(String(it.id))) continue;
      const n = it.marketHashName || 'Unknown item';
      manifest.set(n, (manifest.get(n) || 0) + 1);
    }
  }
  if (!itemIds.length) { toast(`Select item(s) to ${direction}`, 'warn'); return; }
  const lines = [...manifest.entries()].sort((a, b) => b[1] - a[1]);
  const shown = lines.slice(0, 12).map(([n, q]) => `<div class="flex gap-2 t12"><span class="text-slate-500 font-mono w-8 shrink-0">${q}×</span><span class="text-slate-200 truncate">${escapeHtml(n)}</span></div>`).join('');
  const ok = await ssimConfirm({
    title: `${direction === 'deposit' ? 'Deposit' : 'Withdraw'} ${itemIds.length} item(s)?`,
    body: `${direction === 'deposit' ? 'Move into' : 'Take from'} the storage unit on <b class="text-slate-100">${escapeHtml(ckState.username)}</b>:`
      + `<div class="mt-2 max-h-52 overflow-y-auto space-y-0.5 text-left">${shown}</div>`
      + (lines.length > 12 ? `<div class="t10 text-slate-500 mt-1">…and ${lines.length - 12} more item type(s)</div>` : ''),
    confirmLabel: direction === 'deposit' ? 'Deposit' : 'Withdraw', confirmIcon: 'fa-box-archive', tone: 'brand',
  });
  if (!ok) return;
  try {
    await api('/api/casket/move', { method: 'POST', body: JSON.stringify({ username: ckState.username, casketId: ckState.casketId, itemIds, direction }) });
    casketPollMove();
  } catch (err) { toast(err.message, 'error'); }
}

function casketPollMove() {
  const ov = document.getElementById('casket-overlay'); if (!ov) return;
  const foot = ov.querySelector('[data-foot]');
  clearTimeout(ckState.moveTimer);
  resetPoller('casketErr'); // S17: start a clean error-retry window for this move
  const tick = async () => {
    try {
      const j = await api('/api/casket/move-status');
      resetPoller('casketErr'); // S17: a good poll clears the error-retry window
      // An 'aborted' throw (mid-move backstop) carries real partial counters — show them WITH the error,
      // never error-only (that would tell the user a 150-items-deep move did nothing). A 'preflight' throw
      // (done/moved/unconfirmed all 0) still renders error-only.
      const hadProgress = j.done > 0 || j.moved > 0 || j.unconfirmed > 0;
      const counters = `<span class="text-slate-300">${j.direction}: ${j.done}/${j.total} · moved ${j.moved}${j.unconfirmed ? ' · unconfirmed ' + j.unconfirmed : ''} · failed ${j.failed}${j.cancelling ? ' · cancelling…' : ''}</span>`;
      const line = j.error
        ? (hadProgress ? counters + ` <span class="text-amber-400">${escapeHtml(j.error)}</span>` : `<span class="text-amber-400">${escapeHtml(j.error)}</span>`)
        : counters;
      foot.innerHTML = line + (j.running ? ` <button data-ck-cancel class="ml-2 px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600 text-white">Cancel</button>` : '');
      foot.querySelector('[data-ck-cancel]')?.addEventListener('click', () => api('/api/casket/move-cancel', { method: 'POST' }).catch(() => {}));
      if (j.running) { ckState.moveTimer = setTimeout(tick, 1000); }
      else if (j.moved || j.unconfirmed) {
        // Reload the unit's contents on ANY sent move (confirmed OR unconfirmed) so the panel
        // reflects reality — an "unconfirmed" item may well have moved (the SO just didn't echo).
        // This runs even when j.error is set: an 'aborted' (mid-move backstop) throw still moved real
        // items, so we reconcile the panel and surface the error toast alongside the progress toast.
        if (j.error) toast(j.error, 'error');
        // H-TRD-081: a budget-stop (S16 cooperative break) left the rest UNATTEMPTED — say so
        // explicitly (warn tone), never the success-flavoured "N deposited"; a cancel-after-current
        // gets a "Cancelled — " prefix so the toast never reads as a full completion.
        if (j.stoppedReason === 'budget') {
          toast(`Storage: ${j.done}/${j.total} attempted — ${j.total - j.done} not attempted; run the move again to continue`, 'warn');
        } else {
          const prefix = j.stoppedReason === 'cancelled' ? 'Cancelled — ' : '';
          if (j.moved) toast(`${prefix}Storage: ${j.moved} ${j.direction === 'deposit' ? 'deposited' : 'withdrawn'}${j.unconfirmed ? ' (' + j.unconfirmed + ' unconfirmed — verify in-game)' : ''}`, j.unconfirmed ? 'warn' : 'success');
          else toast(`${prefix}Storage: ${j.unconfirmed} sent but unconfirmed — verify in-game`, 'warn');
        }
        // Backend reconciled this account's inventory post-move (H-TRD-084), so re-pull the coalesced
        // /api/inventory cache (reuse the S10 entry point — no new fetch path) BEFORE re-rendering, so
        // the deposit panel drops the moved items in the same modal session (they'd otherwise stay as
        // owned/tradable in the stale cache, inviting a duplicate deposit).
        // Moved assets no longer exist on the side they came from, so a surviving selection would
        // show a phantom "N selected" and could be re-submitted. Drop both sides and re-derive.
        ckState.invSel = new Set(); ckState.unitSel = new Set();
        await loadCasketContents(); await refreshActiveViewFromCache(); renderCasketPanels();
      }
    } catch {
      // S17: a transient status-fetch error must not permanently kill the poller while the move keeps
      // running server-side (its completion re-pull/toast would then never fire, freezing the footer).
      // Bounded retry, mirroring the refresh/mass/sell pollers: keep polling until POLL_STALL_MS of
      // CONTINUOUS errors, then give up with a give-up line (backend reconcile per H-TRD-084 covers the job).
      if (!pollerStalled('casketErr', 0)) { ckState.moveTimer = setTimeout(tick, 2_000); return; }
      resetPoller('casketErr');
      if (foot) foot.innerHTML = '<span class="text-amber-400">status unavailable — the move may still be running; reopen Storage to reload the unit</span>';
    }
  };
  tick();
}

// (The one-shot unlock→dashboard splash lived here; removed 2026-07-08 on owner
//  request — the dashboard appears immediately after the Master Password.)

async function init() {
  if (!(await ensureLicensed())) return;                       // no dashboard without a valid license
  document.documentElement.classList.remove('ssim-locked');    // authorized → reveal the UI
  bindStaticEvents();
  setupSidebarResize();
  setupStickyHeader();
  setupModalInfra();
  setupDelegation();
  updateCurrencyButton();
  updatePriceSourceButton();
  api('/api/pricing/source').then((r) => { if (r && r.effective) { state.priceSource = r.effective; localStorage.setItem('ssim.priceSource', r.effective); updatePriceSourceButton(); } }).catch(() => {});
  // W4_40: probe the paysafecard flag once so the wallet-card action shows only when it's enabled.
  api('/api/steam/paysafe/config').then((r) => { state.paysafeEnabled = !!(r && r.enabled); }).catch(() => {});
  try {
    state.nav = 'inventories';                            // let the skeleton pre-paint the env picker (showScreen is nav-gated)
    showScreen('dashboard'); renderDashboardSkeleton();   // FB-03: skeleton tiles while the first load runs
    await reloadAll();
    renderDashboard();                                    // fill the env picker from loaded data (no screen flip)
    setNav('dashboard');                                  // LAND on the new Dashboard (locked default)
    // The initial /api/inventory load enriches from cache and kicks off a background price fill for
    // any missing/stale prices (server.ts ensureFilled). NONE of the refresh/source-switch paths ran
    // here, so that boot fill was previously never watched — priceless items only appeared after a
    // restart. Watch it now (once; the repriceToken makes it non-overlapping) so prices + the
    // indicator live-update with no reload. (PRICE-BOOT-FILL)
    void watchPriceFill(refreshActiveViewFromCache);
    // Poll system status for the update / breaker / prior-crash surfaces (C3/B3/B1). Additive; once.
    void watchSystemStatus();
    // Activity: session-wide from boot, NOT on entering the Activity view. The rail badge is the
    // whole point — it has to be right the moment a job starts, whatever screen you are on, and
    // it must survive closing the modal that started the job.
    startActivityPoll();
  } catch (err) {
    toast(`Could not load data: ${err.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
