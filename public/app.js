// ════════════════════════════════════════════════════════════════════════════
//  SSIM — Santer Steam Inventory Manager · Frontend (Vanilla JS)
// ════════════════════════════════════════════════════════════════════════════

const API = '';

const state = {
  screen: 'dashboard',          // 'dashboard' | 'inventory'
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
  editUsername: null,
  editProxyInitial: '',         // raw saved proxy the edit field was pre-filled with (change-detection)
  editUseEnvInitial: true,      // was "Use environment proxy" on when the edit modal opened (change-detection)
  search: '',
  showHidden: false,
  sort: null,
  accountSort: 'default',       // sidebar account order: 'default' | 'balance-desc' | 'balance-asc'
  refreshTimer: null,
  gcCat: 'all', // active GC category filter (all | tradable | tradelocked | listed)
  massTimer: null,
  currency: localStorage.getItem('ssim.currency') || 'EUR',  // 'EUR' | 'USD'
  priceSource: localStorage.getItem('ssim.priceSource') || 'steam', // Feature 3: 'steam' | 'csfloat'
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
  toggleHidden:     $('btn-toggle-hidden'),
  // screens
  screenDashboard:  $('screen-dashboard'),
  screenInventory:  $('screen-inventory'),
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
  srcMenu:         $('src-menu'),
  srcLogo:         $('src-logo'),
  srcLabel:        $('src-label'),
  curBtn:          $('cur-btn'),
  curMenu:         $('cur-menu'),
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
  envProxyInput: $('env-proxy-input'),
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
  editProxy:        $('edit-proxy'),
  editProxyCurrent: $('edit-proxy-current'),
  editUseEnvProxy:  $('edit-use-env-proxy'),
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
function invFor(u) {
  if (!u) return undefined;
  const src = state.game === 'tf2' ? state.tf2Inventories : state.inventories;
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
  if (game === 'tf2' && !state.tf2Loaded) {
    try {
      const invMap = await api('/api/inventory-tf2');
      state.tf2Inventories = {};
      for (const k of Object.keys(invMap || {})) { const inv = invMap[k]; storeTf2Inv(inv); }
      state.tf2Loaded = true;
      // S29: this first TF2 load enriches + queues a server-side price fill for the cold TF2 cache, but
      // nothing watched it (boot/refresh/source-switch all start a watch; this path did not) → TF2 prices
      // stayed "…" until an unrelated trigger. Start the watch so prices + totals fill in live (mirrors init()).
      void watchPriceFill(refreshActiveViewFromCache);
    } catch (err) { toast(err.message, 'error'); }
  }
  renderMain();
}

function updateGameToggle() {
  const on  = 'px-3 py-2.5 text-sm font-bold transition bg-brand text-white';
  const off = 'px-3 py-2.5 text-sm font-bold transition bg-slate-800 text-slate-400 hover:bg-slate-700';
  if (el.btnGameCs2) el.btnGameCs2.className = state.game === 'cs2' ? on : off;
  if (el.btnGameTf2) el.btnGameTf2.className = state.game === 'tf2' ? on : off;
}

async function reloadAll() {
  const [environments, allAccounts, invMap, fx] = await Promise.all([
    api('/api/environments'), api('/api/accounts'), api('/api/inventory'),
    api('/api/exchange-rate').catch(() => ({ usdToEur: state.usdToEur })),
  ]);
  state.environments = environments;
  state.allAccounts = allAccounts;
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
    if (Array.isArray(accountsList)) state.allAccounts = accountsList;
    if (state.game === 'tf2') {
      const invMap = await api('/api/inventory-tf2');
      state.tf2Inventories = {};
      for (const k of Object.keys(invMap || {})) storeTf2Inv(invMap[k]);
      state.tf2Loaded = true;
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
/** EUR cents → "€x,xx" (market-sell prices are already in EUR – no FX conversion). */
function fmtEurCents(cents) {
  if (cents == null || isNaN(cents)) return '—';
  return '€' + (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
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
/** Parse a typed major amount ("2,15"/"2.15") → minor units of currency `code`. */
function parseMajorToMinor(str, code) {
  const c = curInfo(code);
  const v = parseFloat(String(str ?? '').replace(',', '.').trim());
  return Number.isFinite(v) && v > 0 ? Math.round(v * Math.pow(10, c.d)) : null;
}

function setCurrency(cur) {
  state.currency = cur;
  localStorage.setItem('ssim.currency', cur);
  updateCurrencyButton();
  renderMain();
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
function closeSourceMenus() { if (el.srcMenu) el.srcMenu.classList.add('hidden'); if (el.curMenu) el.curMenu.classList.add('hidden'); }
function updatePriceSourceButton() {
  const csf = state.priceSource === 'csfloat';
  if (el.srcLabel) el.srcLabel.textContent = csf ? 'CSFloat' : 'Steam';
  if (el.srcLogo) el.srcLogo.setAttribute('src', csf ? '/assets/logos/csfloat.svg' : '/assets/logos/steam.svg');
}
async function setPriceSource(src) {
  closeSourceMenus();
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
const REPRICE_MIN_REPULL_MS = 10_000;
/** Decide whether the fill-watch should re-pull now: always on drain (queue empty), else only when the
 *  fill advanced AND at least REPRICE_MIN_REPULL_MS has elapsed since the last re-pull. (S10) */
function shouldRepullFill(progressed, busy, msSinceLastRepull, minRepullMs) {
  if (!busy) return true;                                    // queue drained → final re-pull always
  return progressed && msSinceLastRepull >= minRepullMs;     // bounded cadence during an active fill
}

// Mirrors src/pricing/repriceReconciler.ts (priceFillIndicator) — keep in sync. Visible while the
// backend fill runs or names are queued; hidden the moment the queue drains (dismiss-on-complete).
function priceFillIndicator(status) {
  const left = Math.max(0, (status && Number(status.queued)) || 0);
  const done = Math.max(0, (status && Number(status.fetched)) || 0);
  const show = !!(status && (status.running || left > 0));
  return { show, left, done };
}
/** Renders the floating "Fetching prices…" badge from a /api/pricing/status snapshot; hides it on
 *  completion. Additive: a self-created fixed element, no dependency on the frozen DOM contract. */
function renderPriceFillIndicator(status) {
  const { show, left, done } = priceFillIndicator(status);
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
  node.innerHTML = `<i class="fa-solid fa-tag text-brand cs2-spin"></i>`
    + `<span>Fetching prices… <b class="text-white">${left}</b> left · <b class="text-white">${done}</b> done</span>`;
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
  state.allAccounts = allAccounts;
  renderSidebar();
  renderMain();
}

// ════════════════════════════════════════════════════════════════════════════
//  Screen navigation
// ════════════════════════════════════════════════════════════════════════════

function showScreen(name) {
  state.screen = name;
  el.screenDashboard.classList.toggle('hidden', name !== 'dashboard');
  el.screenInventory.classList.toggle('hidden', name !== 'inventory');
  if (name !== 'inventory') unmountWindow();   // TBL-02: drop the windowed scroll listener when leaving the table
  updateSidebar();
}

function updateSidebar() {
  // "in an environment" covers account/env-master/folder modes (global has no env).
  const inEnv = state.screen === 'inventory' && state.invMode !== 'global' && !!state.activeEnv;
  el.sidebarNav.classList.toggle('hidden', state.screen === 'dashboard');
  el.envContext.classList.toggle('hidden', !inEnv);
  el.accountsLabel.classList.toggle('hidden', !inEnv);
  el.accountTools.classList.toggle('hidden', !inEnv);

  if (inEnv) {
    const env = state.environments.find(e => e.id === state.activeEnv);
    el.envName.textContent = env ? env.name : '—';
    el.envProxy.textContent = env ? (env.hasProxy ? env.proxy : 'Local IP (no proxy)') : '';
    el.btnEnvMaster.classList.toggle('ring-1', state.invMode === 'env-master');
    el.btnEnvMaster.classList.toggle('ring-brand', state.invMode === 'env-master');
    el.accountSearch.value = state.accountSearch || '';     // keep the controls in sync with state
    el.accountFilter.value = state.accountFilter || 'all';
    el.accountSort.value = state.accountSort || 'default';
    renderSidebar();
  } else {
    el.accountList.innerHTML = '';
    el.toggleHidden.classList.add('hidden');
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
  el.envTiles.innerHTML = envs.map(envTile).join('');
  el.envTiles.querySelectorAll('[data-env]').forEach((c) =>
    c.addEventListener('click', () => enterEnvironment(c.dataset.env)));
  el.envTiles.querySelectorAll('[data-env-edit]').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openEnvModal('edit', b.dataset.envEdit); }));
  el.envTiles.querySelectorAll('[data-env-del]').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); deleteEnvironment(b.dataset.envDel, b.dataset.name); }));
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

function envTile(env) {
  const count = state.allAccounts.filter((a) => a.environmentId === env.id).length;
  const last = envLastUpdated(env.id);
  return `
    <div data-env="${escapeAttr(env.id)}"
      class="env-tile group relative cursor-pointer rounded-2xl bg-slate-900 border border-slate-800 hover:border-brand/50 p-5">
      <div class="flex items-start justify-between">
        <div class="w-11 h-11 rounded-xl bg-brand/15 flex items-center justify-center">
          <i class="fa-solid fa-layer-group text-brand text-lg"></i>
        </div>
        <span class="text-2xs font-medium px-2 py-0.5 rounded-full ${env.hasProxy
          ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/40'
          : 'bg-slate-800 text-slate-400 border border-slate-700'}">
          <i class="fa-solid ${env.hasProxy ? 'fa-shield-halved' : 'fa-network-wired'} mr-1"></i>${env.hasProxy ? 'Proxy' : 'Local IP'}</span>
      </div>
      <h3 class="text-lg font-bold text-white mt-4 truncate">${escapeHtml(env.name)}</h3>
      <p class="text-2xs text-slate-500 font-mono truncate mt-0.5">${env.hasProxy ? escapeHtml(env.proxy) : 'local IP'}</p>
      <div class="flex items-baseline gap-5 mt-4">
        <div class="flex items-baseline gap-1.5">
          <span class="text-2xl font-bold text-white font-mono leading-none">${fmtCount(count)}</span>
          <span class="text-slate-500 text-xs">Accounts</span>
        </div>
        <div class="text-slate-500 text-xs flex items-center gap-1.5"><i class="fa-regular fa-clock"></i>${last ? formatAgo(last) : 'never loaded'}</div>
      </div>
      <div class="mt-4 pt-3 border-t border-slate-800 flex items-center gap-2">
        <button data-proxy-test="${escapeAttr(env.id)}" title="Test this environment's proxy connection"
          class="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-brand hover:text-white text-slate-300 text-xs font-semibold transition flex items-center gap-1.5 shrink-0">
          <i class="fa-solid fa-tower-broadcast"></i><span>Test proxy</span></button>
        <span id="proxytest-${escapeAttr(env.id)}" class="text-2xs text-slate-500 truncate min-w-0"></span>
      </div>
      <div class="absolute right-3 top-3 opacity-0 group-hover:opacity-100 flex items-center gap-1.5">
        <button data-env-edit="${escapeAttr(env.id)}" title="Edit environment"
          class="w-7 h-7 rounded-md bg-slate-800 text-slate-500 hover:text-brand hover:bg-slate-700 transition flex items-center justify-center">
          <i class="fa-solid fa-pen text-xs"></i></button>
        <button data-env-del="${escapeAttr(env.id)}" data-name="${escapeAttr(env.name)}" title="Delete environment"
          class="w-7 h-7 rounded-md bg-slate-800 text-slate-500 hover:text-rose-400 hover:bg-slate-700 transition flex items-center justify-center">
          <i class="fa-solid fa-trash text-xs"></i></button>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Sidebar tree (environment-scoped)
// ════════════════════════════════════════════════════════════════════════════

function envAccounts() { return state.allAccounts.filter((a) => a.environmentId === state.activeEnv); }
function visibleAccounts() { return state.showHidden ? envAccounts() : envAccounts().filter((a) => !a.hidden); }
function accountVisible(acc) { return state.showHidden || !acc.hidden; }

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
  const header = `
    <div class="folder-header group flex items-center gap-1.5 pr-2 py-1.5 rounded-lg hover:bg-slate-800/50 transition" style="padding-left:${pad}px">
      <button data-toggle="${escapeAttr(id)}" class="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-slate-300 shrink-0">
        <i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} text-3xs"></i></button>
      <i class="fa-solid ${collapsed ? 'fa-folder' : 'fa-folder-open'} text-violet-400/80 text-xs shrink-0"></i>
      <span data-folder="${escapeAttr(id)}" title="Open folder master (aggregated inventory)"
        class="text-sm font-semibold truncate flex-1 cursor-pointer ${state.invMode === 'folder' && state.activeFolder === id ? 'text-brand' : 'text-slate-300 hover:text-white'}">${escapeHtml(name)}</span>
      <span class="text-3xs text-slate-600 font-mono mr-1">${count}</span>
      <button ${isFirst ? 'disabled' : `data-folderup="${escapeAttr(id)}"`} title="Move folder up"
        class="opacity-0 group-hover:opacity-100 transition w-4 text-center ${isFirst ? 'text-slate-700 cursor-default' : 'text-slate-500 hover:text-white'}"><i class="fa-solid fa-angle-up text-2xs"></i></button>
      <button ${isLast ? 'disabled' : `data-folderdown="${escapeAttr(id)}"`} title="Move folder down"
        class="opacity-0 group-hover:opacity-100 transition w-4 text-center ${isLast ? 'text-slate-700 cursor-default' : 'text-slate-500 hover:text-white'}"><i class="fa-solid fa-angle-down text-2xs"></i></button>
      <button data-banfolder="${escapeAttr(id)}" title="Check bans for all accounts in this folder" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-brand transition w-5 text-center"><i class="fa-solid fa-shield-halved text-2xs"></i></button>
      <button data-addsub="${escapeAttr(id)}" title="Create subfolder" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-brand transition w-5 text-center"><i class="fa-solid fa-folder-plus text-2xs"></i></button>
      <button data-rename="${escapeAttr(id)}" data-name="${escapeAttr(name)}" title="Rename" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-white transition w-5 text-center"><i class="fa-solid fa-pen text-2xs"></i></button>
      <button data-delfolder="${escapeAttr(id)}" data-name="${escapeAttr(name)}" title="Delete folder (contents move up)" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition w-5 text-center"><i class="fa-solid fa-trash text-2xs"></i></button>
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
    <div class="account-row group relative flex items-stretch ${selected ? 'bg-brand/5 rounded-lg' : ''}" style="padding-left:${pad}px">
      <label class="acct-check-wrap flex items-center pl-1 pr-1.5 shrink-0 cursor-pointer" title="Select for multi-account actions (Mass Buy/Sell/Trade + master)">
        <input type="checkbox" data-selacct="${escapeAttr(acc.username)}" ${selected ? 'checked' : ''}
          aria-label="Select ${escapeAttr(acc.username)} for multi-account actions"
          class="acct-check w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-brand cursor-pointer ${selected ? '' : 'opacity-40 group-hover:opacity-100'}"></label>
      <button data-username="${escapeAttr(acc.username)}"
        class="account-btn flex-1 min-w-0 text-left pr-3 py-2.5 rounded-lg transition flex items-center gap-3
               ${active ? 'is-active bg-brand/15 ring-1 ring-brand/40' : 'hover:bg-slate-800'} ${acc.hidden ? 'opacity-50' : ''}">
        <div class="w-8 h-8 rounded-md bg-slate-800 flex items-center justify-center shrink-0">
          <i class="fa-solid fa-user text-xs ${active ? 'text-brand' : 'text-slate-500'}"></i></div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <p class="text-sm font-semibold truncate min-w-0 ${active ? 'text-white' : 'text-slate-300'}">
              ${escapeHtml(acc.displayName || acc.username)}</p>
            ${acc.tier === 'limited' ? `<span class="shrink-0 text-3xs font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30" title="Limited — imported without a maFile. Buy orders, market buys &amp; cancels work; sell listings &amp; trade offers need a maFile. Attach one to upgrade to Full.">LTD</span>` : ''}
            <span class="acct-balance ml-auto shrink-0 text-2xs font-mono font-semibold leading-none transition-opacity group-hover:opacity-0 ${known ? 'text-emerald-400/90' : 'text-slate-600'}" title="${known ? 'Wallet balance' : 'Balance not fetched yet — refresh this account'}">${escapeHtml(bal)}</span>
          </div>
          <p class="text-2xs text-slate-500 truncate">${escapeHtml(acc.username)}</p></div>
      </button>
      <div class="acct-actions absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button data-edit="${escapeAttr(acc.username)}" title="Edit account" aria-label="Edit ${escapeAttr(acc.username)}"
          class="edit-btn w-6 h-6 rounded-md bg-slate-900/95 text-slate-400 hover:text-white hover:bg-slate-700 transition flex items-center justify-center"><i class="fa-solid fa-pen text-2xs"></i></button>
        <button data-move="${escapeAttr(acc.username)}" title="Move" aria-label="Move ${escapeAttr(acc.username)}"
          class="move-btn w-6 h-6 rounded-md bg-slate-900/95 text-slate-400 hover:text-white hover:bg-slate-700 transition flex items-center justify-center"><i class="fa-solid fa-folder-tree text-2xs"></i></button>
        <button data-bancheck="${escapeAttr(acc.username)}" title="Check bans" aria-label="Check bans for ${escapeAttr(acc.username)}"
          class="bancheck-btn w-6 h-6 rounded-md bg-slate-900/95 text-slate-400 hover:text-white hover:bg-slate-700 transition flex items-center justify-center"><i class="fa-solid fa-shield-halved text-2xs"></i></button>
        <button data-hide="${escapeAttr(acc.username)}" data-hidden="${acc.hidden ? '1' : '0'}"
          title="${acc.hidden ? 'Show' : 'Hide'}" aria-label="${acc.hidden ? 'Show' : 'Hide'} ${escapeAttr(acc.username)}"
          class="hide-btn w-6 h-6 rounded-md bg-slate-900/95 text-slate-400 hover:text-white hover:bg-slate-700 transition flex items-center justify-center"><i class="fa-solid ${acc.hidden ? 'fa-eye' : 'fa-eye-slash'} text-2xs"></i></button>
        ${acc.tier === 'limited' ? `<button data-attach="${escapeAttr(acc.username)}" title="Attach maFile → upgrade to Full" aria-label="Attach maFile for ${escapeAttr(acc.username)}"
          class="attach-btn w-6 h-6 rounded-md bg-slate-900/95 text-emerald-400 hover:text-white hover:bg-emerald-700 transition flex items-center justify-center"><i class="fa-solid fa-shield-halved text-2xs"></i></button>` : ''}
      </div>
    </div>`;
}

function renderSidebar() {
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
      : `<p class="text-sm text-slate-600 px-3 py-4 text-center">No matching accounts.</p>`;
  } else {
    html = renderNodes(state.tree.folders, 0) + renderAccounts(state.tree.accounts, 0);
  }
  el.accountList.innerHTML = html || `<p class="text-sm text-slate-600 px-3 py-4 text-center">No accounts.</p>`;
  // PERF-01: events are delegated once (setupDelegation) — no per-row re-binding here.

  const hiddenCount = envAccounts().filter((a) => a.hidden).length;
  if (hiddenCount > 0) {
    el.toggleHidden.classList.remove('hidden');
    el.toggleHidden.innerHTML = state.showHidden
      ? `<i class="fa-solid fa-eye-slash mr-1.5"></i>Hide hidden`
      : `<i class="fa-solid fa-eye mr-1.5"></i>Show ${hiddenCount} hidden`;
  } else {
    el.toggleHidden.classList.add('hidden');
    state.showHidden = false;
  }
}

// ── PERF-01: ONE delegated listener per container (attached once in setupDelegation) ──
// replaces the per-row re-binding that ran on every render — eliminating the listener
// churn that made large fleets/inventories jank. Checks run most-specific-first.
function onSidebarClick(e) {
  const t = e.target; let n;
  if ((n = t.closest('[data-toggle]')))     return toggleFolder(n.dataset.toggle);
  if ((n = t.closest('[data-folderup]')))   return reorderFolder(n.dataset.folderup, 'up');
  if ((n = t.closest('[data-folderdown]'))) return reorderFolder(n.dataset.folderdown, 'down');
  if ((n = t.closest('[data-addsub]')))     return openFolderModal({ mode: 'create', parentId: n.dataset.addsub });
  if ((n = t.closest('[data-rename]')))     return openFolderModal({ mode: 'rename', id: n.dataset.rename, name: n.dataset.name });
  if ((n = t.closest('[data-delfolder]')))  return deleteFolder(n.dataset.delfolder, n.dataset.name);
  if ((n = t.closest('[data-banfolder]')))  return checkFolderBans(n.dataset.banfolder);
  if ((n = t.closest('.bancheck-btn')))     return checkAccountBans(n.dataset.bancheck);
  if ((n = t.closest('.attach-btn')))       return openAttachMaFile(n.dataset.attach);
  if ((n = t.closest('.hide-btn')))         return toggleHide(n.dataset.hide, n.dataset.hidden === '1');
  if ((n = t.closest('.move-btn')))         return openMoveModal(n.dataset.move);
  if ((n = t.closest('.edit-btn')))         return openEditAccount(n.dataset.edit);
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
  const seg = [{ label: 'Environments', go: 'dash' }];
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
  bc.innerHTML = seg.map((s, i) => {
    const last = i === seg.length - 1;
    const sep = i > 0 ? '<span class="text-slate-600 mx-1.5" aria-hidden="true">›</span>' : '';
    const cls = last ? 'text-slate-300 font-medium' : 'text-slate-400';
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

function renderMain() {
  if (state.screen !== 'inventory') return;
  renderBreadcrumb();
  el.globalFilter.classList.toggle('hidden', state.invMode !== 'global');
  // The worth/wallet curve lives in the env-master + global-master views, for BOTH games
  // (the curve tracks the ACTIVE game's worth — TF2 items are priced against appid 440).
  const showHistory = (state.invMode === 'global' || state.invMode === 'env-master');
  el.historyWrap.classList.toggle('hidden', !showHistory);
  if (showHistory) loadHistory(state.invMode === 'global' ? 'global' : state.activeEnv);
  setStatLabels('Items', 'Trade-Locked');               // default; folder-master overrides
  el.gcCatTabs?.classList.add('hidden');                // category pills only for full-fetched inventories (renderTable re-shows)
  el.facetBar?.classList.add('hidden');                 // TBL-03: facet chips re-shown by renderTable when a table renders
  el.ordersWrap?.classList.add('hidden');               // Active-Orders view only in account view (renderAccountView re-shows)
  if (state.invMode === 'global')     return renderGlobalMaster();
  if (state.invMode === 'env-master') return renderEnvMaster();
  if (state.invMode === 'folder')     return renderFolderMaster();
  if (state.invMode === 'selection')  return renderSelectionMaster();
  return renderAccountView();
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

/** Invalidate the cache (called when a refresh completes → new point exists). */
function invalidateHistory() { historyCache.clear(); }

/**
 * Renders a dependency-free dual-line SVG chart: Items worth (brand purple) and
 * Balance (emerald). Each series is scaled to its own min/max so both curves
 * stay readable regardless of magnitude. Values are USD cents, displayed in the
 * selected currency via fmtCents.
 */
function renderHistoryChart(points) {
  const pts = Array.isArray(points) ? points.filter((p) => p && typeof p.t === 'number') : [];
  if (pts.length < 2) {
    el.historyLegend.innerHTML = '';
    el.historyChart.innerHTML = `<p class="text-center text-slate-600 text-xs py-6">Not enough data points yet – the curve grows with the next refresh.</p>`;
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

  const linePath = (key, y) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key] || 0).toFixed(1)}`).join('');
  const itemsPath = linePath('items', y);
  const walletPath = linePath('wallet', y);
  const areaPath = `${itemsPath}L${x(t1).toFixed(1)},${PAD_T + ih}L${x(t0).toFixed(1)},${PAD_T + ih}Z`;

  const fmtTime = (t) => {
    const d = new Date(t);
    const sameDay = new Date(t0).toDateString() === new Date(t1).toDateString();
    return sameDay
      ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  };
  const tMid = t0 + tSpan / 2;

  const grid = [0.25, 0.5, 0.75].map((f) =>
    `<line x1="${PAD_L}" y1="${(PAD_T + ih * f).toFixed(1)}" x2="${W - PAD_R}" y2="${(PAD_T + ih * f).toFixed(1)}" class="hist-grid" stroke-width="1"/>`).join('');
  // Shared money Y-axis labels (top = max, bottom = min) – now meaningful: both lines use this scale.
  const yLabels = [0, 0.5, 1].map((f) =>
    `<text x="2" y="${(PAD_T + ih * f + 3).toFixed(1)}" class="hist-ylabel" font-size="9">${fmtCents(hi - f * (hi - lo))}</text>`).join('');

  const last = pts[pts.length - 1];
  const dot = (cx, cy, klass) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" class="hist-dot ${klass}" stroke-width="1.5"/>`;

  el.historyChart.innerHTML = `
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
      <path d="${walletPath}" fill="none" class="hist-line-wallet" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="none"/>
      ${dot(x(last.t), y(last.items), 'hist-dot-items')}
      ${dot(x(last.t), y(last.wallet), 'hist-dot-wallet')}
      <text x="${PAD_L}" y="${H - 6}" class="hist-axis" font-size="10">${fmtTime(t0)}</text>
      <text x="${W / 2}" y="${H - 6}" class="hist-axis" font-size="10" text-anchor="middle">${fmtTime(tMid)}</text>
      <text x="${W - PAD_R}" y="${H - 6}" class="hist-axis" font-size="10" text-anchor="end">${fmtTime(t1)}</text>
    </svg>`;

  el.historyLegend.innerHTML = `
    <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:rgb(var(--brand-rgb))"></span>
      Items worth <b class="text-slate-200">${fmtCents(last.items)}</b></span>
    <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:rgb(var(--success-rgb))"></span>
      Balance <b class="text-slate-200">${fmtCents(last.wallet)}</b></span>
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
      if (!ex) { ex = { ...it, quantity: 0, sendable: 0, accounts: new Set(), owners: [] }; map.set(it.marketHashName, ex); }
      ex.quantity += it.quantity;
      ex.accounts.add(u);
      if (it.tradable && !it.tradeLockExpiry) {            // sendable → counts toward trade/sell
        ex.sendable += it.quantity;
        ex.owners.push({ username: u, assetIds: it.assetIds.slice() });
      }
    }
  }
  return [...map.values()];
}

function openFolderMaster(folderId) {
  state.invMode = 'folder';
  state.activeFolder = folderId;
  state.activeUsername = null;
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

  el.mainHeader.innerHTML = `
    <div>
      <h2 class="text-2xl font-bold text-white flex items-center gap-3">
        <i class="fa-solid fa-folder-open text-brand"></i> ${escapeHtml(node.folder.name)}
        <span class="text-2xs font-medium px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/40">Folder-Master</span>
      </h2>
      <p class="text-sm text-slate-500 mt-1">${usernames.length} account(s) · aggregated 1:1 with the single views</p>
    </div>
    <div class="flex items-stretch gap-2">
      <button id="btn-folder-massbuy" title="Mass Buy: max out a purchase of one item across every account in this folder"
        class="px-4 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-cart-arrow-down"></i><span>Mass Buy</span></button>
      <button id="btn-folder-bans" title="Check every account in this folder for Steam bans"
        class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-refresh-folder" class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-rotate"></i><span>Refresh folder</span></button>
    </div>`;
  const rf = $('btn-refresh-folder');
  if (rf) rf.addEventListener('click', () => refreshFolder(usernames));
  const mb = $('btn-folder-massbuy');
  if (mb) mb.addEventListener('click', () => openFolderBuy(node.folder.name, usernames));
  const fb = $('btn-folder-bans');
  if (fb) fb.addEventListener('click', () => openBanChecker(usernames, node.folder.name));

  el.btnLoad.classList.add('hidden');
  el.statBar.classList.remove('hidden'); el.statBar.classList.add('flex');
  setStatLabels('Sendable items', 'Bots');
  setCountStat(el.statItems, totalSendable);
  setCountStat(el.statLocked, usernames.length);
  const folderValueCents = worthCentsForAccounts(usernames); // one worth source (C19)
  let folderWalletUsd = 0, folderWalletAccts = 0;
  for (const u of usernames) { const wu = walletToUsd(walletOf(u)); if (wu != null) { folderWalletUsd += wu; folderWalletAccts++; } }
  setMoneyStats(folderValueCents, folderWalletAccts ? folderWalletUsd : null);

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
    <div>
      <h2 class="text-2xl font-bold text-white flex items-center gap-3">
        <i class="fa-solid fa-layer-group text-brand"></i> Multi-Select
        <span class="text-2xs font-medium px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/40">${usernames.length} account(s)</span>
      </h2>
      <p class="text-sm text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
        <span>Hand-picked accounts · aggregated 1:1 with the single views</span>
        <span class="text-slate-700">·</span>
        <button id="sel-all" class="text-2xs text-brand hover:text-brand-light font-semibold transition">Select all</button>
        <button id="sel-clear-all" class="text-2xs text-slate-400 hover:text-white font-semibold transition">Clear</button>
      </p>
    </div>
    <div class="flex items-stretch gap-2">
      <button id="btn-sel-massbuy" title="Mass Buy: max out a purchase of one item across every selected account"
        class="px-4 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-cart-arrow-down"></i><span>Mass Buy</span></button>
      <button id="btn-sel-refresh" class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-rotate"></i><span>Refresh selected</span></button>
      <button id="btn-sel-move" title="Move every selected account into a folder / environment"
        class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-folder-tree"></i><span>Move Selected</span></button>
      <button id="btn-sel-bans" title="Check every selected account for Steam bans"
        class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-sel-delete" title="Remove every selected account from SSIM (maFiles are kept)"
        class="px-4 py-2.5 rounded-lg bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-trash-can"></i><span>Delete Selected</span></button>
    </div>`;
  $('btn-sel-refresh')?.addEventListener('click', () => refreshFolder(usernames));
  $('btn-sel-massbuy')?.addEventListener('click', () => openFolderBuy(`${usernames.length} selected account(s)`, usernames));
  $('btn-sel-move')?.addEventListener('click', () => openMoveModal(usernames));
  $('btn-sel-bans')?.addEventListener('click', () => openBanChecker(usernames, `${usernames.length} selected`));
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

// ── Account view ───────────────────────────────────────────────────────────────
function renderAccountView() {
  const username = state.activeUsername;
  if (!username) { showPlaceholder('Select an account on the left.'); return; }
  const acc = state.allAccounts.find((a) => a.username === username);
  const inv = invFor(username);

  el.mainHeader.innerHTML = `
    <div>
      <h2 class="text-2xl font-bold text-white flex items-center gap-3">
        ${escapeHtml(acc?.displayName || username)}
        ${acc?.network?.type === 'proxy'
          ? '<span class="text-2xs font-medium px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-400 border border-emerald-700/40"><i class="fa-solid fa-shield-halved mr-1"></i>Proxy</span>'
          : '<span class="text-2xs font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700"><i class="fa-solid fa-network-wired mr-1"></i>Local IP</span>'}
      </h2>
      <p class="text-sm text-slate-500 mt-1 font-mono">${escapeHtml(username)}</p>
    </div>
    <div class="text-right">
      ${renderTradeLink(username)}
      <button id="btn-account-bans" title="Check this account for Steam bans"
        class="mb-2 mr-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition inline-flex items-center gap-1.5">
        <i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-account-logs" title="View this account's recent activity log"
        class="mb-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition inline-flex items-center gap-1.5">
        <i class="fa-solid fa-clock-rotate-left"></i><span>Logs</span></button>
      <div class="flex justify-end gap-2">
        <button id="btn-tradeups" title="Find profitable trade-up contracts from this account's skins"
          class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-sm font-bold transition inline-flex items-center gap-2">
          <i class="fa-solid fa-arrow-trend-up"></i><span>Trade-Ups</span></button>
        <button id="btn-caskets" title="Manage this account's storage units (caskets)"
          class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 text-sm font-bold transition inline-flex items-center gap-2">
          <i class="fa-solid fa-box-archive"></i><span>Storage</span></button>
        <button id="btn-trade-offers" title="Manage this account's sent &amp; received trade offers"
          class="px-3 py-2 rounded-lg bg-brand hover:bg-brand-dark text-white text-sm font-bold transition inline-flex items-center gap-2">
          <i class="fa-solid fa-right-left"></i><span>Trade Offers</span></button>
        <button id="btn-csfloat" title="Manage this account on CSFloat (listings, market, trades)"
          class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-brand-light text-sm font-bold transition inline-flex items-center gap-2">
          <i class="fa-solid fa-water"></i><span>CSFloat</span></button>
        <button id="btn-sda" title="Steam Guard code + pending mobile confirmations for this account"
          class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 text-sm font-bold transition inline-flex items-center gap-2">
          <i class="fa-solid fa-mobile-screen-button"></i><span>SDA</span></button>
        <button id="btn-clean-browser" title="Open a browser with this account logged in, routed through its linked proxy"
          class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-violet-300 text-sm font-bold transition inline-flex items-center gap-2">
          <i class="fa-solid fa-window-restore"></i><span>Browser</span>
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
    el.toolbar.classList.add('hidden');
    el.itemsWrap.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    renderOrdersView(username, tf2 ? 440 : 730);
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
// ════════════════════════════════════════════════════════════════════════════

/** Fetches and renders the account's open market orders into #orders-wrap. The
 *  view is independent of the inventory cache – orders are always pulled live. */
async function renderOrdersView(username, appId) {
  if (!el.ordersWrap) return;
  el.ordersWrap.classList.remove('hidden');
  el.ordersWrap.innerHTML = `
    <div class="flex items-center justify-center py-16 text-center">
      <i class="fa-solid fa-spinner cs2-spin text-2xl text-teal-400 mr-3"></i>
      <span class="text-slate-300">Loading active orders live from Steam…</span>
    </div>`;
  // Guard: the user may switch account/tab while this live fetch is in flight.
  const stillHere = () => state.invMode === 'account' && state.activeUsername === username && (state.gcCat || 'all') === 'orders';
  let data;
  try {
    data = await api(`/api/market/orders/${encodeURIComponent(username)}?appId=${appId}`);
  } catch (err) {
    if (!stillHere()) return;
    el.ordersWrap.innerHTML = ordersShellHtml(
      `<div class="px-4 py-10 text-center text-rose-300"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${escapeHtml(err.message)}</div>`,
      `<div class="px-4 py-10 text-center text-rose-300">—</div>`);
    bindOrdersControls(username, appId);
    return;
  }
  if (!stillHere()) return;
  el.ordersWrap.innerHTML = ordersHtml(data);
  bindOrdersControls(username, appId);
}

/** Two-section shell (Buy / Sell) with a header + refresh button. */
function ordersShellHtml(buyInner, sellInner, counts = {}) {
  const section = (title, icon, color, countKey, inner) => `
    <div class="rounded-lg border border-slate-800 bg-slate-900/45 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2">
        <i class="fa-solid ${icon}" style="color:${color}"></i>
        <span class="text-xs font-bold uppercase tracking-wider text-slate-300">${title}</span>
        <span class="ml-1 text-2xs font-mono text-slate-500">${counts[countKey] != null ? counts[countKey] : ''}</span>
      </div>
      <div class="divide-y divide-slate-800/60">${inner}</div>
    </div>`;
  return `
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <p class="text-sm text-slate-400 mr-auto"><i class="fa-solid fa-receipt text-teal-400 mr-2"></i>Active market orders</p>
      <input id="orders-search" type="text" placeholder="Search item…" class="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200 w-44 focus:outline-none focus:ring-2 focus:ring-brand/40" />
      <button id="orders-cancel-selected" disabled class="px-3 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-40"><i class="fa-solid fa-xmark"></i><span>Cancel selected (<span id="orders-sel-count">0</span>)</span></button>
      <button id="orders-cancel-all" class="px-3 py-1.5 rounded-lg bg-rose-700/80 hover:bg-rose-600 text-white text-xs font-bold transition flex items-center gap-1.5"><i class="fa-solid fa-trash"></i><span>Cancel all</span></button>
      <button id="orders-refresh" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition flex items-center gap-1.5"><i class="fa-solid fa-rotate"></i><span>Refresh</span></button>
    </div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      ${section('Active Buy Orders', 'fa-cart-arrow-down', 'rgb(var(--success-rgb))', 'buy', buyInner)}
      ${section('Active Sell Orders', 'fa-tag', 'rgb(var(--listed-rgb))', 'sell', sellInner)}
    </div>`;
}

function ordersHtml(data) {
  const buys = Array.isArray(data.buyOrders) ? data.buyOrders : [];
  const sells = Array.isArray(data.sellOrders) ? data.sellOrders : [];
  const emptyRow = (txt) => `<div class="px-4 py-8 text-center text-slate-600 text-sm">${txt}</div>`;
  const buyInner = buys.length ? buys.map(buyOrderRow).join('') : emptyRow('No active buy orders.');
  const sellInner = sells.length ? sells.map(sellOrderRow).join('') : emptyRow('No active sell orders.');
  return ordersShellHtml(buyInner, sellInner, { buy: buys.length, sell: sells.length });
}

function orderIcon(o) {
  return o.iconUrl
    ? `<img src="${escapeAttr(safeIconUrl(o.iconUrl))}" alt="" loading="lazy" class="w-10 h-8 object-contain shrink-0" onerror="this.style.display='none'" />`
    : '<div class="w-10 h-8 shrink-0"></div>';
}
function cancelBtn(attr, id) {
  return `<button ${attr}="${escapeAttr(id)}" title="Cancel this order on the Steam market"
    class="order-cancel shrink-0 px-3 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-bold transition flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i><span>Cancel</span></button>`;
}
function orderCheck() {
  return '<input type="checkbox" class="order-check accent-violet-500 w-4 h-4 shrink-0" />';
}
function buyOrderRow(o) {
  const qtyTxt = o.quantity && o.quantity !== o.quantityRemaining
    ? `${o.quantityRemaining} / ${o.quantity}` : `${o.quantityRemaining || o.quantity || 0}`;
  return `<div class="order-row flex items-center gap-3 px-4 py-2.5" data-order-kind="buy" data-order-id="${escapeAttr(o.buyOrderId)}" data-order-name="${escapeAttr(String(o.name || '').toLowerCase())}">
    ${orderCheck()}
    ${orderIcon(o)}
    <div class="min-w-0 flex-1"><div class="text-sm text-slate-200 truncate" title="${escapeAttr(o.name)}">${escapeHtml(o.name)}</div>
      <div class="text-2xs text-slate-500 font-mono">#${escapeHtml(o.buyOrderId)}</div></div>
    <div class="text-right shrink-0 mr-1"><div class="text-sm font-mono text-slate-200">${fmtMoneyMinor(o.pricePerItemMinor, o.currency)}</div>
      <div class="text-2xs text-slate-500">qty ${escapeHtml(qtyTxt)}</div></div>
    ${cancelBtn('data-cancel-buy', o.buyOrderId)}</div>`;
}
function sellOrderRow(o) {
  return `<div class="order-row flex items-center gap-3 px-4 py-2.5" data-order-kind="sell" data-order-id="${escapeAttr(o.listingId)}" data-order-name="${escapeAttr(String(o.name || '').toLowerCase())}">
    ${orderCheck()}
    ${orderIcon(o)}
    <div class="min-w-0 flex-1"><div class="text-sm text-slate-200 truncate" title="${escapeAttr(o.name)}">${escapeHtml(o.name)}</div>
      <div class="text-2xs text-slate-500 font-mono">#${escapeHtml(o.listingId)}</div></div>
    <div class="text-right shrink-0 mr-1"><div class="text-sm font-mono text-slate-200">${fmtMoneyMinor(o.pricePerItemMinor, o.currency)}</div>
      <div class="text-2xs text-slate-500">qty ${o.quantity || 1}</div></div>
    ${cancelBtn('data-cancel-listing', o.listingId)}</div>`;
}

/** Wires Refresh, every per-row Cancel, the search filter, multi-select, and Cancel selected/all. */
function bindOrdersControls(username, appId) {
  const refresh = $('orders-refresh');
  if (refresh) refresh.addEventListener('click', () => renderOrdersView(username, appId));

  // Per-row cancel (single, with its own confirm).
  el.ordersWrap.querySelectorAll('[data-cancel-listing]').forEach((b) =>
    b.addEventListener('click', () => cancelOrder(username, b, '/api/market/cancel-listing', { listingId: b.dataset.cancelListing })));
  el.ordersWrap.querySelectorAll('[data-cancel-buy]').forEach((b) =>
    b.addEventListener('click', () => cancelOrder(username, b, '/api/market/cancel-buy-order', { buyOrderId: b.dataset.cancelBuy })));

  // Multi-select.
  el.ordersWrap.querySelectorAll('.order-check').forEach((cb) => cb.addEventListener('change', updateOrdersSelCount));

  // Search: filter rows by item name; hidden rows are also unchecked.
  const search = $('orders-search');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    el.ordersWrap.querySelectorAll('.order-row').forEach((row) => {
      const match = !q || (row.dataset.orderName || '').includes(q);
      row.style.display = match ? '' : 'none';
      if (!match) { const cb = row.querySelector('.order-check'); if (cb) cb.checked = false; }
    });
    updateOrdersSelCount();
  });

  // Cancel selected / Cancel all (all = the currently-visible/filtered set, so you can
  // search "AK-47" then Cancel all to clear just those).
  const selBtn = $('orders-cancel-selected');
  if (selBtn) selBtn.addEventListener('click', () => bulkCancelOrders(username, checkedOrderRows()));
  const allBtn = $('orders-cancel-all');
  if (allBtn) allBtn.addEventListener('click', () => bulkCancelOrders(username, visibleOrderRows()));

  updateOrdersSelCount();
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

/** Cancels a list of order rows SEQUENTIALLY (anti-rate-limit) via the per-row endpoints. */
async function bulkCancelOrders(username, rows) {
  if (!rows.length) { toast('No orders to cancel', 'warn'); return; }
  if (!(await ssimConfirm({
    title: 'Cancel orders', tone: 'danger', confirmLabel: `Cancel ${rows.length} order(s)`, confirmIcon: 'fa-xmark',
    body: `Cancel <b class="text-slate-100">${rows.length}</b> order(s) on the Steam market?`,
  }))) return;
  let ok = 0, fail = 0;
  for (const row of rows) {
    const btn = row.querySelector('.order-cancel');
    const kind = row.dataset.orderKind;
    const id = row.dataset.orderId;
    if (!id) continue;
    const endpoint = kind === 'buy' ? '/api/market/cancel-buy-order' : '/api/market/cancel-listing';
    const idBody = kind === 'buy' ? { buyOrderId: id } : { listingId: id };
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>'; }
    try {
      await api(endpoint, { method: 'POST', body: JSON.stringify({ username, ...idBody }) });
      ok++;
      if (btn) removeOrderRow(btn); else row.remove();
    } catch (err) {
      fail++;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-xmark"></i><span>Cancel</span>'; }
    }
  }
  toast(`Cancelled ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'success');
  updateOrdersSelCount();
}

/** Cancels one order via the backend, then removes its row + updates the count. */
async function cancelOrder(username, btn, endpoint, idBody) {
  if (!(await ssimConfirm({
    title: 'Cancel order', tone: 'danger', confirmLabel: 'Cancel order', confirmIcon: 'fa-xmark',
    body: 'Cancel this order on the Steam market?',
  }))) return;
  const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>';
  try {
    await api(endpoint, { method: 'POST', body: JSON.stringify({ username, ...idBody }) });
    toast('Order cancelled', 'success');
    removeOrderRow(btn);
  } catch (err) {
    toast(`Cancel failed: ${err.message}`, 'error');
    btn.disabled = false; btn.innerHTML = old;
  }
}

/** Removes a cancelled order's row and refreshes its section's count/empty state. */
function removeOrderRow(btn) {
  const row = btn.closest('.order-row');
  if (!row) return;
  const list = row.parentElement;            // the divide-y container
  const countSpan = list?.previousElementSibling?.querySelector('span.font-mono');
  row.remove();
  const remaining = list ? list.querySelectorAll('.order-row').length : 0;
  if (countSpan) countSpan.textContent = String(remaining);
  if (list && remaining === 0) {
    list.innerHTML = '<div class="px-4 py-8 text-center text-slate-600 text-sm">No active orders.</div>';
  }
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
function offerStateBadge(o) {
  if (o.active) {
    if (o.state === 11) return { label: 'In escrow',     cls: 'bg-amber-900/40 text-amber-300 border-amber-700/40' };
    if (o.state === 9)  return { label: 'Needs confirm',  cls: 'bg-amber-900/40 text-amber-300 border-amber-700/40' };
    return { label: 'Active', cls: 'bg-sky-900/40 text-sky-300 border-sky-700/40' };
  }
  if (o.state === 3)               return { label: 'Accepted', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40' };
  if (o.state === 7)               return { label: 'Declined', cls: 'bg-rose-900/40 text-rose-300 border-rose-700/40' };
  if (o.state === 6 || o.state === 10) return { label: 'Cancelled', cls: 'bg-slate-800 text-slate-400 border-slate-700' };
  if (o.state === 5)               return { label: 'Expired',  cls: 'bg-slate-800 text-slate-400 border-slate-700' };
  if (o.state === 4)               return { label: 'Countered',cls: 'bg-slate-800 text-slate-400 border-slate-700' };
  return { label: o.stateName || 'History', cls: 'bg-slate-800 text-slate-400 border-slate-700' };
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
  if (side === 'sent') {
    return `<button data-offer-action="cancel" class="offer-act px-2.5 py-1 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-2xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-xmark"></i>Cancel</button>`;
  }
  return `<div class="flex gap-1.5">
    <button data-offer-action="accept" class="offer-act px-2.5 py-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white text-2xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-check"></i>Accept</button>
    <button data-offer-action="decline" class="offer-act px-2.5 py-1 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-2xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-xmark"></i>Decline</button>
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
        <span class="text-2xs font-medium px-1.5 py-0.5 rounded border ${badge.cls}">${escapeHtml(badge.label)}</span>
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
    await api('/api/trade/offer-action', { method: 'POST', body: JSON.stringify({ username, offerId, action }) });
    toast(`Offer ${OFFER_VERB[action]}`, 'success');
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
  for (const r of rows) {
    const res = byKey.get(`${r.dataset.username.toLowerCase()}|${r.dataset.offerId}`);
    if (res && res.ok) removeOfferRow(r); else setRowBusy(r, false);
  }
  toast(`${OFFER_LABEL[action]}: ${data.ok} ok${data.fail ? `, ${data.fail} failed` : ''}`, data.fail ? 'warn' : 'success');
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
      if (it.tradeLockExpiry) lockedStacks++;
      const ex = map.get(it.marketHashName);
      if (ex) { ex.quantity += it.quantity; ex.accounts.add(u); }
      else map.set(it.marketHashName, { ...it, accounts: new Set([u]) });
    }
  }
  return { items: [...map.values()], totalItems, lockedStacks, accountCount: loaded, valueCents, walletUsd, walletAccounts };
}

function renderAggregate(usernames, headerHtml) {
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
  renderTable(agg.items, { master: true });
}

function renderEnvMaster() {
  const env = state.environments.find((e) => e.id === state.activeEnv);
  const usernames = envAccounts().map((a) => a.username);
  renderAggregate(usernames, `
    <div>
      <h2 class="text-2xl font-bold text-white flex items-center gap-3">
        <i class="fa-solid fa-chart-pie text-brand"></i> ${escapeHtml(env?.name || 'Environment')}
        <span class="text-2xs font-medium px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/40">Portfolio</span>
      </h2>
      <p class="text-sm text-slate-500 mt-1">${usernames.length} account(s) in this environment</p>
    </div>
    <div class="flex items-stretch gap-2">
      <button id="btn-env-bans" title="Check every account in this environment for Steam bans"
        class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
    </div>`);
  const eb = $('btn-env-bans');
  if (eb) eb.addEventListener('click', () => openBanChecker(usernames, env?.name || 'Environment'));
}

function renderGlobalMaster() {
  renderGlobalFilter();
  const usernames = state.allAccounts.filter((a) => state.globalEnvs.has(a.environmentId)).map((a) => a.username);
  renderAggregate(usernames, `
    <div>
      <h2 class="text-2xl font-bold text-white flex items-center gap-3">
        <i class="fa-solid fa-globe text-brand"></i> Global Master
        <span class="text-2xs font-medium px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/40">Cross-environment</span>
      </h2>
      <p class="text-sm text-slate-500 mt-1">${state.globalEnvs.size} of ${state.environments.length} environments aggregated</p>
    </div>
    <div class="flex items-stretch gap-2">
      <button id="btn-global-bans" title="Check every aggregated account for Steam bans"
        class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-shield-halved"></i><span>Check Bans</span></button>
      <button id="btn-refresh-global" class="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition flex items-center gap-2"><i class="fa-solid fa-rotate"></i><span>Refresh all</span></button>
    </div>`);
  const b = $('btn-refresh-global');
  if (b) b.addEventListener('click', refreshAll);
  const gb = $('btn-global-bans');
  if (gb) gb.addEventListener('click', () => openBanChecker(usernames, `Global · ${state.globalEnvs.size} environment(s)`));
}

function renderGlobalFilter() {
  el.globalFilter.innerHTML = `
    <p class="text-2xs font-semibold uppercase tracking-wider text-slate-400">Aggregate environments</p>
    <div class="flex flex-wrap gap-2 mt-2">${state.environments.map((e) => {
      const on = state.globalEnvs.has(e.id);
      const count = state.allAccounts.filter((a) => a.environmentId === e.id).length;
      return `<button data-genv="${escapeAttr(e.id)}"
        class="px-3 py-1.5 rounded-lg text-sm font-medium border transition ${on ? 'border-brand bg-brand/10 text-brand' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}">
        <i class="fa-solid ${on ? 'fa-square-check' : 'fa-square'} mr-1.5"></i>${escapeHtml(e.name)} <span class="text-xs opacity-70">(${count})</span></button>`;
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
    return `<button data-tl-fetch="${escapeAttr(username)}"
      class="mb-2 mr-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition inline-flex items-center gap-1.5">
      <i class="fa-solid fa-link"></i><span>Get trade link</span></button>`;
  }
  return `
    <div class="mb-2 mr-2 inline-flex items-center gap-2 align-middle">
      <code class="text-2xs text-slate-400 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 max-w-[280px] truncate" title="${escapeAttr(url)}">${escapeHtml(url)}</code>
      <button data-tl-copy="${escapeAttr(username)}" title="Copy trade link"
        class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition inline-flex items-center gap-1.5"><i class="fa-solid fa-copy"></i><span>Copy</span></button>
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
    const counts = { all: 0, tradable: 0, tradelocked: 0, listed: 0 };
    for (const i of items || []) { const q = i.quantity || 1; counts.all += q; counts[i.category || 'tradable'] += q; }
    pills.push(
      { key: 'all',         label: 'All',              count: counts.all },
      { key: 'tradable',    label: 'Owned Items',      count: counts.tradable },
      { key: 'tradelocked', label: 'Trade-Locked',     count: counts.tradelocked },
      { key: 'listed',      label: 'Listed on Market', count: counts.listed },
    );
  } else {
    pills.push({ key: 'all', label: 'Items', count: null });
  }
  const ordersOn = active === 'orders';
  el.gcCatTabs.classList.remove('hidden');
  el.gcCatTabs.innerHTML =
    pills.map((t) => {
      const on = t.key === active;
      const cnt = t.count != null ? `<span class="font-mono ${on ? 'text-white/70' : 'text-slate-500'}">${t.count}</span>` : '';
      return `<button data-cat="${t.key}" class="px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${on ? 'bg-brand text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}">${t.label}${cnt}</button>`;
    }).join('')
    + '<span class="mx-1 w-px self-stretch bg-slate-700/70" aria-hidden="true"></span>'
    + `<button data-cat="orders" title="Active market orders (sell listings + buy orders)" class="px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${ordersOn ? 'bg-teal-600 text-white' : 'bg-slate-800 text-teal-300 hover:bg-slate-700'}"><i class="fa-solid fa-receipt"></i>Active Orders</button>`;
  el.gcCatTabs.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { state.gcCat = b.dataset.cat; renderMain(); }));
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
  const nameCell = `
      <td class="py-2.5 ${selectable ? 'pl-2' : 'pl-3'} pr-2">
        <div class="flex items-center gap-3">
          ${iconWithLock(item, 'item-icon w-12 h-9 object-contain', showLockBadge)}
          <span class="font-semibold" style="color:${color}">${escapeHtml(item.name)}</span></div></td>`;

  // Selection cell: account view checks per-stack tradability. A MASTER row is shown 1:1
  // (incl. non-sendable items) but only its SENDABLE portion (item.sendable) is selectable.
  const maxSel = master ? (item.sendable || 0) : item.quantity;
  let checkCell = '', sel, checked = false;
  if (selectable) {
    const key = keyOf(item);
    sel = state.selection[key];
    checked = sel != null;
    const canSelect = master ? (maxSel > 0) : (item.tradable && !item.tradeLockExpiry);
    checkCell = `<td class="py-2.5 pl-3 pr-1 align-middle">
        ${canSelect
          ? `<input type="checkbox" class="sel-check accent-violet-500 w-4 h-4 cursor-pointer align-middle" data-sel="${escapeAttr(key)}" ${checked ? 'checked' : ''} />`
          : `<span title="not tradable / trade-locked" class="text-slate-700"><i class="fa-solid fa-lock text-3xs"></i></span>`}</td>`;
  }
  const qtyCell = (selectable && checked && maxSel > 1)
    ? `<td class="py-2.5 px-2"><input type="number" class="sel-qty w-16 px-2 py-1 rounded bg-slate-950 border border-brand/50 text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-brand" data-sel="${escapeAttr(keyOf(item))}" data-max="${maxSel}" value="${sel}" min="1" max="${maxSel}" /></td>`
    : `<td class="py-2.5 px-2">${qtyBadge(item.quantity)}</td>`;

  if (master) {
    return `<tr class="border-b border-slate-800/60 hover:bg-slate-900/50 transition ${checked ? 'bg-brand/5' : ''}">
        ${checkCell}${nameCell}${qtyCell}
        <td class="py-2.5 px-2"><span class="text-xs font-mono text-slate-400">${item.accounts.size}</span></td>
        <td class="py-2.5 px-2">${rarityBadge(item, color)}</td>
        <td class="py-2.5 px-2 pr-4 text-right">${valueCell(item)}</td></tr>`;
  }
  return `<tr class="border-b border-slate-800/60 hover:bg-slate-900/50 transition ${checked ? 'bg-brand/5' : ''}">
      ${checkCell}${nameCell}${qtyCell}
      <td class="py-2.5 px-2 text-slate-400">${item.exterior ? escapeHtml(item.exterior) : '<span class="text-slate-600">—</span>'}</td>
      <td class="py-2.5 px-2">${rarityBadge(item, color)}</td>
      <td class="py-2.5 px-2 text-right">${valueCell(item)}</td>
      <td class="py-2.5 px-2 pr-4 text-right">${statusCell(item)}</td></tr>`;
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
/** Canonical status bucket for an item — GC category, else derived (P3-aligned). */
function itemStatusKey(i) { return i.category || (i.tradeLockExpiry ? 'tradelocked' : (i.tradable ? 'tradable' : 'tradelocked')); }
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
    const GROUPS = [
      { key: 'tradable',    label: 'Owned · freely tradable', color: 'rgb(var(--success-rgb))', icon: 'fa-circle-check' },
      { key: 'tradelocked', label: 'Trade-Locked',            color: 'rgb(var(--warn-rgb))', icon: 'fa-lock' },
      { key: 'listed',      label: 'Listed on Steam Market',  color: 'rgb(var(--listed-rgb))', icon: 'fa-tag' },
    ];
    if (active !== 'all') shown = filtered.filter((i) => (i.category || 'tradable') === active);
    const visible = active === 'all' ? GROUPS : GROUPS.filter((g) => g.key === active);
    el.itemsBody.innerHTML = visible.map((g) => {
      const rows = filtered.filter((i) => (i.category || 'tradable') === g.key);
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
  const unit = item.quantity > 1 ? ` <span class="text-3xs text-slate-600">(${fmtCents(item.price)}/ea.)</span>` : '';
  return `<span class="text-slate-200 font-mono">${fmtCents(stackValueCents(item))}</span>${unit}`;
}
function rarityBadge(item, color) {
  return `<span class="text-xs px-2 py-0.5 rounded-full font-medium" style="color:${color}; background:${color}1a; border:1px solid ${color}40">${escapeHtml(item.rarity)}</span>`;
}
/** Human, compact unlock countdown, e.g. "3 days, 14 h" / "5 h, 12 min" / "8 min". */
function lockCountdown(date) {
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'unlocked now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} ${d === 1 ? 'day' : 'days'}, ${h} h`;
  if (h > 0) return `${h} h, ${m} min`;
  return `${Math.max(1, m)} min`;
}
/** Compact lock badge text for the icon overlay: "7D" / "14H" / "32M" (null if free). */
function lockBadge(date) {
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
function statusCell(item) {
  if (item.tradeLockExpiry) {
    const d = new Date(item.tradeLockExpiry);
    const abs = isNaN(d) ? '' : d.toLocaleString();
    return `<span title="Unlocks on ${escapeAttr(abs)}" class="inline-flex items-center gap-1.5 text-amber-400 text-xs font-medium"><i class="fa-solid fa-lock"></i> ${escapeHtml(lockCountdown(d))}</span>`;
  }
  if (item.tradable) return `<span class="inline-flex items-center gap-1.5 text-emerald-400 text-xs font-medium"><i class="fa-solid fa-circle-check"></i> Tradable</span>`;
  return `<span class="inline-flex items-center gap-1.5 text-rose-500 text-xs font-medium"><i class="fa-solid fa-ban"></i> Locked</span>`;
}

function thSort(label, key, extra = '') {
  const active = state.sort && state.sort.key === key;
  const arrow = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : '';
  return `<th data-sort="${key}" class="py-3 px-2 font-semibold cursor-pointer select-none hover:text-slate-200 transition ${extra}">${label}<span class="ml-1 text-brand">${arrow}</span></th>`;
}
function thPlain(label, extra = '') { return `<th class="py-3 px-2 font-semibold ${extra}">${label}</th>`; }
function thCheck() { return `<th class="py-3 pl-3 pr-1 w-8"><input type="checkbox" id="select-all" title="Select all tradable" class="accent-violet-500 w-4 h-4 cursor-pointer align-middle" /></th>`; }
function onHeaderSort(key) {
  if (state.sort && state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
  renderMain();
}

// ── selection (mode-aware: account = assetId, folder = marketHashName) ────────────
function currentItems() { const inv = invFor(state.activeUsername); return inv ? inv.items : []; }
function findStack(assetId) { return currentItems().find((i) => i.assetId === assetId); }
function clearSelection() { state.selection = {}; }
/** True in the aggregated multi-owner views — the folder master AND the sidebar
 *  multi-select scope — where the item table keys by marketHashName and Mass
 *  Buy/Sell/Trade fan out across many owner accounts. */
function aggMode() { return state.invMode === 'folder' || state.invMode === 'selection'; }
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
  // SEND works for both games (app-agnostic). Market SELL stays CS2-only (Steam's
  // market/sellitem path is appid 730), so hide the Sell button in the TF2 view rather than
  // offer an action that would fail. (Bug 1.)
  if (el.btnSellSel) el.btnSellSel.classList.toggle('hidden', state.game === 'tf2');
  const unit = aggMode()
    ? `${new Set(selectedItemRefs().map((r) => r.username)).size} Bot(s)`
    : `${Object.keys(state.selection).length} Stack(s)`;
  el.selectionCount.textContent = `${n} Item(s) · ${unit}`;
}
function hideSelectionBar() { el.selectionBar.classList.add('hidden'); el.selectionBar.classList.remove('flex'); }

/**
 * Phase 2 (A): bulk-select every selectable item whose UNIT value is below the typed
 * threshold (interpreted in the currently-displayed currency). Works in the account
 * view (assetId keys) and the folder master (marketHashName keys); the control is
 * hidden in the non-selectable env/global masters. Items without a known price are
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
    html += `<div class="rounded-2xl bg-slate-900 border border-slate-800 p-5">
      <div class="flex items-start justify-between"><span class="skel" style="width:44px;height:44px;border-radius:.75rem"></span><span class="skel" style="width:64px;height:22px;border-radius:9999px"></span></div>
      <span class="skel block mt-4" style="width:60%;height:18px"></span>
      <span class="skel block mt-2" style="width:80%;height:11px"></span>
      <div class="mt-4 flex gap-4"><span class="skel" style="width:40px;height:24px"></span><span class="skel" style="width:70px;height:14px"></span></div>
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
  el.refreshFailedList.innerHTML = failed.map((f) => `
    <li class="leading-snug">
      <span class="font-semibold text-slate-200">${escapeHtml(f.username)}</span>
      <span class="text-slate-400"> – ${escapeHtml(shortError(f.error))}</span>
    </li>`).join('');
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
      el.refreshLabel.textContent = job.cancelling ? 'Cancelling…' : (job.running ? 'Refreshing…' : 'Done');
      if (job.running) {
        if (!job.cancelling && pollerStalled('refresh', job.done)) {
          toast('Refresh appears stuck (no progress) – stopping the live updater. Check the server.', 'warn');
          el.refreshProgress.classList.add('hidden'); resetPoller('refresh'); return;
        }
        pollRefresh(); return;
      }
      resetPoller('refresh');

      if (job.game === 'tf2') {
        const invMap = await api('/api/inventory-tf2');
        state.tf2Inventories = {};
        for (const k of Object.keys(invMap || {})) { const inv = invMap[k]; storeTf2Inv(inv); }
        state.tf2Loaded = true;
      } else {
        const invMap = await api('/api/inventory');
        state.inventories = {};
        for (const k of Object.keys(invMap || {})) { const inv = invMap[k]; storeCs2Inv(inv); }
        invalidateHistory(); // a fresh curve point exists now → refetch on render
      }
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

// ── Soft-hide ─────────────────────────────────────────────────────────────────
async function toggleHide(username, currentlyHidden) {
  const route = currentlyHidden ? 'unhide' : 'hide';
  try {
    await api(`/api/accounts/${encodeURIComponent(username)}/${route}`, { method: 'POST' });
    await refreshEnv();
    if (!currentlyHidden && state.invMode === 'account' && state.activeUsername === username) selectEnvMaster();
    toast(currentlyHidden ? `"${username}" shown` : `"${username}" hidden`, 'success', { undo: () => toggleHide(username, !currentlyHidden) });
  } catch (err) { toast(err.message, 'error'); }
}

// ── edit account (Problem 3: per-account proxy override + details) ──
async function openEditAccount(username) {
  const acc = state.allAccounts.find((a) => a.username === username);
  if (!acc) { toast('Account not found', 'error'); return; }
  state.editUsername = username;
  el.editLabel.textContent = acc.username;
  el.editDisplayName.value = acc.displayName || '';
  el.editProxy.value = '';
  // Default state: "Use environment proxy" ON (the account inherits the env proxy).
  el.editUseEnvProxy.checked = true;
  state.editProxyInitial = '';
  state.editUseEnvInitial = true;
  syncProxyFieldEnabled();
  el.editPassword.value = '';
  el.editMafile.value = '';
  el.editProxyCurrent.innerHTML = '<span class="text-slate-600">Loading current proxy…</span>';
  el.editOverlay.classList.remove('hidden');

  // Reflect the account's ACTUAL network state once it loads. The proxy field holds
  // the account's OWN override UN-redacted (so "Edit" shows the exact saved string).
  //   has an override  → toggle OFF (custom proxy in field, or empty = forced local IP)
  //   no override      → toggle ON  (uses the environment proxy)
  try {
    const info = await api(`/api/accounts/${encodeURIComponent(username)}/proxy`);
    if (state.editUsername !== username) return;     // a different account was opened meanwhile
    el.editProxy.value = info.proxy || '';
    state.editProxyInitial = info.proxy || '';
    state.editUseEnvInitial = !info.hasOverride;
    el.editUseEnvProxy.checked = !info.hasOverride;
    syncProxyFieldEnabled();
    el.editProxyCurrent.innerHTML = proxySourceHint(info.source);
  } catch (err) {
    if (state.editUsername !== username) return;
    el.editProxyCurrent.innerHTML = `<span class="text-rose-400">Could not load the saved proxy (${escapeHtml(err.message)})</span>`;
  }
}

/** Greys out + disables the proxy field while "Use environment proxy" is ON
 *  (the account inherits the env proxy, so a custom value is irrelevant). */
function syncProxyFieldEnabled() {
  const useEnv = el.editUseEnvProxy.checked;
  el.editProxy.disabled = useEnv;
  el.editProxy.classList.toggle('opacity-40', useEnv);
}

/** Hint line describing where the account's network currently comes from. */
function proxySourceHint(source) {
  if (source === 'override')    return 'Current: <span class="text-emerald-400">own proxy</span> (toggle off + edit below)';
  if (source === 'environment') return 'Current: <span class="text-slate-400">environment proxy</span> (this account has none of its own)';
  return 'Current: <span class="text-amber-400">local proxy</span> (local IP, no proxy)';
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

  // Proxy intent from the "Use environment proxy" toggle (mirrors PATCH semantics):
  //   toggle ON                 → null (inherit the environment proxy)
  //   toggle OFF + value        → that custom proxy
  //   toggle OFF + empty field  → '' (local proxy / local IP)
  // Only sent when the intent actually CHANGED – sending it always would needlessly
  // re-login the account (a proxy change drops the live session).
  const useEnv   = el.editUseEnvProxy.checked;
  const proxyNow = el.editProxy.value.trim();
  const newIntent  = useEnv ? 'env' : (proxyNow ? `proxy:${proxyNow}` : 'local');
  const initIntent = state.editUseEnvInitial ? 'env' : (state.editProxyInitial ? `proxy:${state.editProxyInitial}` : 'local');
  if (newIntent !== initIntent) {
    body.proxy = useEnv ? null : proxyNow;             // null → env; value → proxy; '' → local IP
  }
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
function openAddAccount() {
  el.addForm.reset();
  el.addEnv.innerHTML = state.environments.map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`).join('');
  if (state.activeEnv) el.addEnv.value = state.activeEnv;
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
    if (state.screen === 'inventory' && state.activeEnv === acc.environmentId) { await refreshEnv(); selectAccount(acc.username); }
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
    const cls = cur ? 'bg-brand/20 text-brand-light border-brand/40' : done ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-800/60 text-slate-500 border-slate-700';
    const ic = (cur && key !== 'imported') ? 'fa-spinner cs2-spin' : icon;
    return `<span class="text-3xs font-semibold px-2 py-0.5 rounded-full border ${cls} inline-flex items-center gap-1"><i class="fa-solid ${ic}"></i>${label}</span>`;
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
  el.loginCredMsg.className = `text-2xs ${tone === 'error' ? 'text-rose-300' : tone === 'info' ? 'text-slate-400' : 'text-emerald-300'}`;
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
const CSF = { username: null, tab: 'dashboard', experimental: false, key: { configured: false }, market: { cursor: null, items: [], query: {}, loading: false } };
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
function csfMsg(eln, text, tone) { if (!eln) return; eln.className = `text-2xs mt-2 ${tone === 'error' ? 'text-rose-300' : tone === 'ok' ? 'text-emerald-300' : 'text-slate-400'}`; eln.textContent = text; eln.classList.remove('hidden'); }

async function openCsFloat(username) {
  CSF.username = username; CSF.tab = 'dashboard'; CSF.market = { cursor: null, items: [], query: {}, loading: false };
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
}
function closeCsFloat() { el.csfloatOverlay.classList.add('hidden'); }

// ════════════════════════════════════════════════════════════════════════════
//  SDA Overview (Phase 6 Feature B): Steam Guard OTP (auto-rolling + copy) + live
//  mobile confirmations (approve single / multi / all). The backend owns the
//  canonical OTP + getConfirmations/respond; this panel only renders + refreshes
//  from truth (no optimistic-only state). Acts on EXACTLY the selected account.
// ════════════════════════════════════════════════════════════════════════════
const SDA = { username: null, otpTimer: null, barTimer: null, code: '·····', confs: [], open: false };

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
    if (el.sdaOtp) el.sdaOtp.textContent = '—';
    if (el.sdaOtpBar) el.sdaOtpBar.style.width = '0%';
    toast(e.message || 'could not load Steam Guard code', 'error');
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
  el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-slate-500 text-sm"><i class="fa-solid fa-spinner cs2-spin mr-2"></i>Loading confirmations…</div>`;
  try {
    const { confirmations } = await api(`/api/accounts/${encodeURIComponent(username)}/confirmations`);
    if (!SDA.open || SDA.username !== username) return;
    SDA.confs = Array.isArray(confirmations) ? confirmations : [];
    renderSdaConfirmations();
  } catch (e) {
    if (!SDA.open || SDA.username !== username) return;
    const msg = escapeHtml(e.message || 'failed to load confirmations');
    el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-rose-300 text-sm"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${msg}<div class="mt-3"><button id="sda-conf-retry" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Refresh</button></div></div>`;
    const r = $('sda-conf-retry'); if (r) r.addEventListener('click', refreshSdaConfirmations);
  }
}

function renderSdaConfirmations() {
  if (el.sdaConfCount) el.sdaConfCount.textContent = SDA.confs.length ? `(${SDA.confs.length})` : '';
  if (!SDA.confs.length) {
    el.sdaConfBody.innerHTML = `<div class="px-4 py-8 text-center text-slate-600 text-sm">No pending confirmations.</div>`;
    updateSdaSelCount(); return;
  }
  const typeIcon = (t) => (t === 'trade' ? 'fa-right-left' : t === 'market' ? 'fa-tag' : 'fa-shield-halved');
  el.sdaConfBody.innerHTML = SDA.confs.map((c) => `
    <div class="flex items-center gap-3 px-4 py-2.5" data-conf-id="${escapeAttr(c.id)}">
      <input type="checkbox" class="sda-conf-check accent-emerald-500 w-4 h-4 shrink-0" />
      ${c.iconUrl ? `<img src="${escapeAttr(safeIconUrl(c.iconUrl))}" alt="" loading="lazy" class="w-9 h-7 object-contain shrink-0" onerror="this.style.display='none'" />` : `<i class="fa-solid ${typeIcon(c.typeName)} text-slate-500 w-9 text-center shrink-0"></i>`}
      <div class="min-w-0 flex-1">
        <div class="text-sm text-slate-200 truncate" title="${escapeAttr(c.title)}">${escapeHtml(c.title)}</div>
        <div class="text-2xs text-slate-500">${escapeHtml(c.typeName)}${c.receiving ? ' · ' + escapeHtml(c.receiving) : ''}</div>
      </div>
      <button data-conf-approve="${escapeAttr(c.id)}" class="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 text-white text-xs font-bold transition inline-flex items-center gap-1.5"><i class="fa-solid fa-check"></i><span>Approve</span></button>
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
  const exp = [['buyorders', 'Buy Orders', 'fa-hand-holding-dollar'], ['trades', 'Trades', 'fa-right-left'], ['inventory', 'Inventory', 'fa-boxes-stacked']];
  const tabs = [...core, ...(CSF.experimental ? exp : []), ['settings', 'Settings', 'fa-gear']];
  el.csfloatTabs.innerHTML = tabs.map(([id, label, icon]) => {
    const on = CSF.tab === id;
    return `<button data-csf-tab="${id}" class="px-3 py-2 -mb-px text-sm font-bold transition inline-flex items-center gap-2 border-b-2 ${on ? 'border-brand text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}"><i class="fa-solid ${icon}"></i>${label}</button>`;
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
    let listingCount = '—';
    try { listingCount = String(csfArr(await csfApi('/listings?limit=50')).length); } catch { /* leave as — */ }
    el.csfloatBody.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        ${csfStat('Balance', csfUsd(bal), 'fa-wallet', 'text-emerald-400')}
        ${csfStat('Active listings', listingCount, 'fa-tags', 'text-brand-light')}
        ${csfStat('Account', escapeHtml(String(name)), 'fa-user', 'text-slate-300')}
      </div>
      <div class="flex gap-2">
        <button data-csf-tab="market" class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold"><i class="fa-solid fa-store mr-1.5"></i>Browse market</button>
        <button data-csf-tab="listings" class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold"><i class="fa-solid fa-tags mr-1.5"></i>My listings</button>
      </div>`;
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}
function csfStat(label, value, icon, color) {
  return `<div class="surface px-4 py-3"><p class="text-2xs uppercase tracking-wider text-slate-500 mb-1">${label}</p><p class="text-xl font-bold ${color} truncate"><i class="fa-solid ${icon} mr-1.5 text-sm"></i>${value}</p></div>`;
}

// ── My Listings ──
async function csfLoadListings() {
  el.csfloatBody.innerHTML = csfSkeleton();
  try {
    const items = csfArr(await csfApi('/listings?limit=50'));
    el.csfloatBody.innerHTML = items.length ? `<div class="space-y-2">${items.map(csfListingRow).join('')}</div>` : csfEmpty('fa-tags', 'No active listings on CSFloat.');
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}
function csfListingRow(l) {
  const item = l.item || {}; const id = l.id || l.listing_id || '';
  const name = item.market_hash_name || item.full_item_name || item.item_name || 'Unknown item';
  const price = l.price ?? 0; const fl = item.float_value != null ? Number(item.float_value).toFixed(4) : '';
  return `<div class="csf-row flex items-center gap-3 rounded-lg bg-slate-950/50 border border-slate-800 px-3 py-2">
    ${item.icon_url ? `<img src="${escapeAttr(csfImg(item.icon_url))}" alt="" class="w-10 h-10 object-contain shrink-0"/>` : ''}
    <div class="min-w-0 flex-1"><p class="text-sm text-slate-200 truncate">${escapeHtml(name)}</p>${fl ? `<p class="text-2xs text-slate-500 font-mono">float ${fl}</p>` : ''}</div>
    <input type="number" step="0.01" min="0.03" placeholder="${(price / 100).toFixed(2)}" class="csf-price field !w-24 !py-1.5 text-right" />
    <button data-csf="editprice" data-id="${escapeAttr(id)}" title="Update price" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold"><i class="fa-solid fa-pen"></i></button>
    <button data-csf="delist" data-id="${escapeAttr(id)}" title="Delist" class="px-2.5 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-600 text-white text-xs font-bold"><i class="fa-solid fa-xmark"></i></button>
    <span class="text-sm font-bold text-emerald-400 w-20 text-right">${csfUsd(price)}</span></div>`;
}

// ── Market ──
function csfRenderMarket() {
  el.csfloatBody.innerHTML = `
    <form id="csf-market-form" class="flex flex-wrap items-end gap-2 mb-4">
      <div class="flex-1 min-w-[180px]"><label class="block text-2xs text-slate-500 mb-1">Search</label>
        <input name="market_hash_name" placeholder="e.g. AK-47 | Redline" class="field" /></div>
      <div><label class="block text-2xs text-slate-500 mb-1">Min $</label><input name="min" type="number" step="0.01" class="field !w-24" /></div>
      <div><label class="block text-2xs text-slate-500 mb-1">Max $</label><input name="max" type="number" step="0.01" class="field !w-24" /></div>
      <div><label class="block text-2xs text-slate-500 mb-1">Sort</label>
        <select name="sort_by" class="field !w-auto">
          <option value="best_deal">Best deal</option><option value="lowest_price">Lowest price</option><option value="highest_price">Highest price</option><option value="most_recent">Most recent</option><option value="lowest_float">Lowest float</option><option value="highest_float">Highest float</option></select></div>
      <button type="submit" class="px-4 py-2 rounded-lg bg-brand hover:bg-brand-dark text-white text-sm font-bold"><i class="fa-solid fa-magnifying-glass mr-1.5"></i>Search</button>
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
    ${CSF.market.cursor ? '<div class="text-center mt-4"><button data-csf="marketmore" class="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold">Load more</button></div>' : ''}`;
}
function csfMarketCard(l) {
  const item = l.item || {}; const id = l.id || ''; const price = l.price ?? 0;
  const name = item.market_hash_name || 'Unknown item';
  const fl = item.float_value != null ? Number(item.float_value).toFixed(4) : ''; const wear = item.wear_name || '';
  return `<div class="rounded-xl bg-slate-950/50 border border-slate-800 p-3 flex flex-col">
    <div class="flex items-center justify-center h-24 mb-2">${item.icon_url ? `<img src="${escapeAttr(csfImg(item.icon_url))}" alt="" class="max-h-24 object-contain"/>` : '<i class="fa-solid fa-image text-slate-700 text-2xl"></i>'}</div>
    <p class="text-sm text-slate-200 truncate" title="${escapeAttr(name)}">${escapeHtml(name)}</p>
    <p class="text-2xs text-slate-500 mb-2 truncate">${escapeHtml(wear)}${fl ? ` · ${fl}` : ''}</p>
    <div class="mt-auto flex items-center justify-between">
      <span class="text-base font-bold text-emerald-400">${csfUsd(price)}</span>
      <button data-csf="buy" data-id="${escapeAttr(id)}" data-price="${price}" data-name="${escapeAttr(name)}" class="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold"><i class="fa-solid fa-cart-shopping mr-1"></i>Buy</button>
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
  return `<div class="flex items-center gap-3 rounded-lg bg-slate-950/50 border border-slate-800 px-3 py-2">
    <div class="min-w-0 flex-1"><p class="text-sm text-slate-200 truncate">${escapeHtml(String(name))}</p><p class="text-2xs text-slate-500">qty ${escapeHtml(String(qty))}</p></div>
    <span class="text-sm font-bold text-emerald-400">${csfUsd(price)}</span>
    <button data-csf="delorder" data-id="${escapeAttr(id)}" class="px-2.5 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-600 text-white text-xs font-bold"><i class="fa-solid fa-xmark"></i></button></div>`;
}

// ── Trades (experimental) — incl. the Auto-Accept toggle ──
async function csfLoadTrades() {
  el.csfloatBody.innerHTML = csfSkeleton(3);
  try {
    const [auto, tradesRes] = await Promise.all([ csfApi('/auto-accept').catch(() => ({ enabled: false })), csfApi('/trades?limit=50') ]);
    const trades = csfArr(tradesRes);
    const acc = state.allAccounts.find((a) => a.username === CSF.username);
    const limited = !!(acc && acc.tier === 'limited');
    el.csfloatBody.innerHTML = `
      <div class="surface flex items-center justify-between px-4 py-3 mb-4">
        <div><p class="text-sm font-bold text-slate-200">Auto-accept sales</p><p class="text-2xs text-slate-500 max-w-md">${limited ? 'Unavailable on Limited accounts (no maFile to confirm the Steam delivery).' : 'Auto-send &amp; confirm the Steam trade for each CSFloat sale (reuses your maFile).'}</p></div>
        <button data-csf="autoaccept" ${limited ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-bold ${auto.enabled ? 'bg-brand text-white' : 'bg-slate-700 text-slate-300'} ${limited ? 'opacity-40 cursor-not-allowed' : ''}">${auto.enabled ? '<i class="fa-solid fa-check mr-1"></i>ON' : 'OFF'}</button>
      </div>
      ${trades.length ? `<div class="space-y-2">${trades.map(csfTradeRow).join('')}</div>` : csfEmpty('fa-right-left', 'No trades yet.')}`;
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}
function csfTradeRow(t) {
  const item = (t.contract && t.contract.item) || t.item || {};
  const name = item.market_hash_name || 'Trade'; const st = t.state || t.status || '';
  const price = (t.contract && t.contract.price) ?? t.price ?? 0;
  return `<div class="flex items-center gap-3 rounded-lg bg-slate-950/50 border border-slate-800 px-3 py-2">
    <div class="min-w-0 flex-1"><p class="text-sm text-slate-200 truncate">${escapeHtml(String(name))}</p><p class="text-2xs text-slate-500">${escapeHtml(String(st))}</p></div>
    <span class="text-sm font-bold text-emerald-400">${csfUsd(price)}</span></div>`;
}

// ── Inventory (experimental) — list an item for sale ──
async function csfLoadInventory() {
  el.csfloatBody.innerHTML = csfSkeleton();
  try {
    const items = csfArr(await csfApi('/inventory'));
    el.csfloatBody.innerHTML = items.length
      ? `<p class="text-2xs text-slate-500 mb-3">Set a price and list an item for sale on CSFloat.</p><div class="space-y-2">${items.map(csfInvRow).join('')}</div>`
      : csfEmpty('fa-boxes-stacked', 'No tradable CS2 items found on CSFloat.');
  } catch (err) { el.csfloatBody.innerHTML = csfError(err.message); }
}
function csfInvRow(it) {
  const item = it.item || it; const asset = item.asset_id || item.assetid || it.asset_id || '';
  const name = item.market_hash_name || item.full_item_name || 'Item';
  const fl = item.float_value != null ? Number(item.float_value).toFixed(4) : '';
  return `<div class="csf-row flex items-center gap-3 rounded-lg bg-slate-950/50 border border-slate-800 px-3 py-2">
    ${item.icon_url ? `<img src="${escapeAttr(csfImg(item.icon_url))}" alt="" class="w-10 h-10 object-contain shrink-0"/>` : ''}
    <div class="min-w-0 flex-1"><p class="text-sm text-slate-200 truncate">${escapeHtml(name)}</p>${fl ? `<p class="text-2xs text-slate-500 font-mono">float ${fl}</p>` : ''}</div>
    <input type="number" step="0.01" min="0.03" placeholder="price $" class="csf-price field !w-24 !py-1.5 text-right" />
    <button data-csf="listasset" data-asset="${escapeAttr(asset)}" ${asset ? '' : 'disabled'} class="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-dark text-white text-xs font-bold ${asset ? '' : 'opacity-40'}">List</button></div>`;
}

// ── Settings ──
function csfRenderSettings() {
  const k = CSF.key || { configured: false };
  el.csfloatBody.innerHTML = `
    <div class="max-w-lg space-y-5">
      <div>
        <h4 class="text-sm font-bold text-slate-200 mb-1">CSFloat API key</h4>
        <p class="text-2xs text-slate-500 mb-3">Generate a key at <span class="text-brand-light">csfloat.com/profile → Developer</span>. Stored encrypted per-account in your vault; never shown again.</p>
        <form id="csf-key-form" class="flex gap-2">
          <input name="apiKey" type="password" autocomplete="off" placeholder="${k.configured ? 'configured (ending …' + escapeHtml(k.tail || '') + ') — paste to replace' : 'paste your CSFloat API key'}" class="field flex-1"/>
          <button type="submit" class="px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-dark text-white text-sm font-bold">Save</button>
          ${k.configured ? '<button type="button" data-csf="clearkey" class="px-4 py-2.5 rounded-lg bg-rose-600/80 hover:bg-rose-600 text-white text-sm font-bold">Clear</button>' : ''}
        </form>
        <p id="csf-key-msg" class="hidden text-2xs mt-2"></p>
      </div>
      <div class="surface px-4 py-3 flex items-center justify-between gap-3">
        <div><p class="text-sm font-bold text-slate-200">Experimental features</p><p class="text-2xs text-slate-500">Buy Orders, Trades &amp; Inventory tabs + auto-accept. These use undocumented CSFloat endpoints that may change.</p></div>
        <button data-csf="experimental" class="px-3 py-1.5 rounded-lg text-xs font-bold shrink-0 ${CSF.experimental ? 'bg-brand text-white' : 'bg-slate-700 text-slate-300'}">${CSF.experimental ? 'ON' : 'OFF'}</button>
      </div>
    </div>`;
}

// ── delegation ──
function onCsfTabClick(e) { const b = e.target.closest('[data-csf-tab]'); if (b) csfSwitchTab(b.getAttribute('data-csf-tab')); }
function onCsfBodyClick(e) {
  const tabBtn = e.target.closest('[data-csf-tab]'); if (tabBtn) return csfSwitchTab(tabBtn.getAttribute('data-csf-tab'));
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
  const cur = btn.textContent.includes('ON');
  try { const r = await csfApi('/auto-accept', { method: 'PUT', body: JSON.stringify({ enabled: !cur }) }); toast(`Auto-accept ${r.enabled ? 'enabled' : 'disabled'}`, 'success'); csfSwitchTab('trades'); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfDelist(id) {
  if (!id || !(await ssimConfirm({ title: 'Delist', body: 'Remove this listing from CSFloat?', tone: 'danger', confirmLabel: 'Delist', confirmIcon: 'fa-xmark' }))) return;
  try { await csfApi('/listings/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Listing removed', 'success'); csfLoadListings(); }
  catch (err) { toast(err.message, 'error'); }
}
async function csfEditPrice(btn) {
  const id = btn.getAttribute('data-id'); const row = btn.closest('.csf-row');
  const input = row && row.querySelector('.csf-price'); const dollars = input && Number(input.value);
  if (!dollars || dollars < 0.03) return toast('Enter a new price first', 'error');
  try { await csfApi('/listings/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ price: Math.round(dollars * 100) }) }); toast('Price updated', 'success'); csfLoadListings(); }
  catch (err) { toast(err.message, 'error'); }
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
async function csfListAsset(btn) {
  const asset = btn.getAttribute('data-asset'); const row = btn.closest('.csf-row');
  const input = row && row.querySelector('.csf-price'); const dollars = input && Number(input.value);
  if (!asset) return toast('Missing asset id', 'error');
  if (!dollars || dollars < 0.03) return toast('Enter a price first', 'error');
  if (!(await ssimConfirm({ title: 'List on CSFloat', tone: 'brand', confirmLabel: `List for $${dollars.toFixed(2)}`, confirmIcon: 'fa-tag', body: `Create a CSFloat listing at <b class="text-brand-light">$${dollars.toFixed(2)}</b>?` }))) return;
  try { await csfApi('/listings', { method: 'POST', body: JSON.stringify({ asset_id: asset, price: Math.round(dollars * 100), type: 'buy_now' }) }); toast('Listing created', 'success'); csfLoadInventory(); }
  catch (err) { toast(err.message, 'error'); }
}

// ── new / edit environment ──
async function openEnvModal(mode = 'create', id = null) {
  el.envForm.reset();
  state.envProxyInitial = '';
  if (mode === 'edit') {
    const env = state.environments.find((e) => e.id === id);
    state.envModal = { mode: 'edit', id };
    el.envModalTitle.innerHTML = '<i class="fa-solid fa-pen text-brand mr-2"></i>Edit environment';
    el.envSubmitLabel.textContent = 'Save';
    el.envNameInput.value = env ? env.name : '';
    el.envProxyInput.value = '';
    el.envProxyInput.placeholder = 'Loading current proxy…';
  } else {
    state.envModal = { mode: 'create' };
    el.envModalTitle.innerHTML = '<i class="fa-solid fa-layer-group text-brand mr-2"></i>New environment';
    el.envSubmitLabel.textContent = 'Create';
    el.envProxyInput.placeholder = 'http://user:pass@geo.proxy.com:12321';
  }
  el.envOverlay.classList.remove('hidden');
  el.envNameInput.focus();

  // Edit: reveal the REAL saved proxy so it shows in the field. Clearing it on save
  // then removes it → the environment (and its inheriting accounts) use the local IP.
  if (mode === 'edit') {
    try {
      const info = await api(`/api/environments/${encodeURIComponent(id)}/proxy`);
      if (!state.envModal || state.envModal.id !== id) return;   // a different modal opened meanwhile
      el.envProxyInput.value = info.proxy || '';
      state.envProxyInitial = info.proxy || '';
      el.envProxyInput.placeholder = 'http://user:pass@geo.proxy.com:12321';
    } catch (err) {
      if (!state.envModal || state.envModal.id !== id) return;
      el.envProxyInput.placeholder = 'http://user:pass@geo.proxy.com:12321';
      toast(`Could not load the saved proxy: ${err.message}`, 'error');
    }
  }
}
function closeEnvModal() { state.envModal = null; el.envOverlay.classList.add('hidden'); }
async function submitEnv(ev) {
  ev.preventDefault();
  const m = state.envModal || { mode: 'create' };
  const name = el.envNameInput.value.trim();
  const proxy = el.envProxyInput.value.trim();
  if (!name) return;
  try {
    if (m.mode === 'edit') {
      const body = { name };
      // Proxy change-detection: send only when it actually changed.
      //   cleared (was set, now empty) → '' → environment runs on the local IP
      //   changed to a new value       → set/replace
      //   left untouched               → omit (no change)
      if (proxy !== (state.envProxyInitial || '')) body.proxy = proxy;
      await api(`/api/environments/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Environment updated', 'success');
    } else {
      await api('/api/environments', { method: 'POST', body: JSON.stringify({ name, proxy }) });
      toast(`Environment "${name}" created`, 'success');
    }
    closeEnvModal();
    await reloadAll();
    if (state.screen === 'inventory' && state.activeEnv) { updateSidebar(); renderMain(); }
    else renderDashboard();
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteEnvironment(id, name) {
  if (!(await ssimConfirm({
    title: 'Delete environment', tone: 'danger', confirmLabel: 'Delete', confirmIcon: 'fa-trash',
    body: `Delete environment <b class="text-slate-100">${escapeHtml(name)}</b>?<br><span class="text-slate-500">Only possible when it no longer contains any accounts.</span>`,
  }))) return;
  try {
    await api(`/api/environments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`Environment "${name}" deleted`, 'success');
    state.globalEnvs.delete(id);
    await reloadAll();
    renderDashboard();
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
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ name, environmentId: state.activeEnv, parentId: action.parentId ?? null }) });
      if (action.parentId) { state.collapsed.delete(action.parentId); saveCollapsed(); }
      toast(`Folder "${name}" created`, 'success');
    } else {
      await api(`/api/folders/${encodeURIComponent(action.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast('Folder renamed', 'success');
    }
    closeFolderModal();
    await refreshEnv();
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
  el.moveEnv.value = single?.environmentId || state.activeEnv;
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
    if (state.activeEnv) await refreshEnv();
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
  { key: 'clean',     label: 'Clean',                 icon: 'fa-circle-check',        text: 'text-emerald-400', badge: 'bg-emerald-500/15 text-emerald-300', movable: false },
  { key: 'vac',       label: 'VAC Banned',            icon: 'fa-ban',                 text: 'text-rose-400',    badge: 'bg-rose-500/15 text-rose-300',       movable: true  },
  { key: 'game',      label: 'Game Banned',           icon: 'fa-gamepad',             text: 'text-orange-400',  badge: 'bg-orange-500/15 text-orange-300',   movable: true  },
  { key: 'community', label: 'Community Banned',      icon: 'fa-comment-slash',       text: 'text-amber-400',   badge: 'bg-amber-500/15 text-amber-300',     movable: true  },
  { key: 'economy',   label: 'Economy / Trade Banned', icon: 'fa-handshake-slash',    text: 'text-fuchsia-400', badge: 'bg-fuchsia-500/15 text-fuchsia-300', movable: true  },
  { key: 'error',     label: 'Lookup Failed',         icon: 'fa-triangle-exclamation', text: 'text-slate-400',  badge: 'bg-slate-600/30 text-slate-300',     movable: false },
];

/** Opens the Ban Checker for a set of accounts and renders the result modal. */
async function openBanChecker(usernames, scopeLabel) {
  const list = [...new Set((usernames || []).filter(Boolean))];
  if (list.length === 0) { toast('No accounts to check', 'warn'); return; }
  state.banResult = null;
  el.banScope.textContent = scopeLabel ? `· ${scopeLabel}` : `· ${list.length} account(s)`;
  el.banSummary.innerHTML = `<div class="text-sm text-slate-400 flex items-center gap-2"><i class="fa-solid fa-spinner cs2-spin"></i>Checking ${list.length} account(s) for Steam bans…</div>`;
  el.banBody.innerHTML = '';
  el.banOverlay.classList.remove('hidden');   // → FB-04 onModalOpen
  let res;
  try {
    res = await api('/api/bans/check', { method: 'POST', body: JSON.stringify({ usernames: list }) });
  } catch (err) {
    el.banSummary.innerHTML = `<div class="text-sm text-rose-400"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>${escapeHtml(err.message)}</div>`;
    return;
  }
  state.banResult = res;
  renderBanResult(res);
}

function closeBan() { state.banResult = null; el.banOverlay.classList.add('hidden'); }

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
      <span class="text-2xs uppercase tracking-wide text-slate-500 font-semibold mr-1">${t.total || 0} checked</span>
      ${BAN_CATS.filter((c) => c.key !== 'error' || (t.error || 0) > 0).map((c) => `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${c.badge} text-xs font-semibold">
          <i class="fa-solid ${c.icon} ${c.text}"></i>${escapeHtml(c.label)}
          <span class="font-mono">${(groups[c.key] || []).length}</span>
        </span>`).join('')}
    </div>`;

  // Accordions: one per non-empty category (Clean + each ban type + errors).
  const sections = BAN_CATS
    .filter((c) => (groups[c.key] || []).length > 0)
    .map((c) => banAccordion(c, groups[c.key]))
    .join('');
  el.banBody.innerHTML = sections || `<p class="text-sm text-slate-500 px-2 py-4 text-center">No accounts to display.</p>`;
}

function banAccordion(cat, accounts) {
  const moveBtn = cat.movable
    ? `<button data-ban-move="${escapeAttr(cat.key)}" title="Move every account in this category into a folder"
         class="ml-auto shrink-0 px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-dark text-white text-2xs font-bold transition flex items-center gap-1.5"><i class="fa-solid fa-folder-tree"></i>Move this Category</button>`
    : '';
  const rows = accounts.map((a) => banAccountRow(a, cat.key)).join('');
  return `
    <div class="rounded-lg border border-slate-800 overflow-hidden">
      <div data-ban-toggle="${escapeAttr(cat.key)}" class="flex items-center gap-2.5 px-4 py-2.5 cursor-pointer hover:bg-slate-800/50 transition">
        <i class="fa-solid fa-chevron-right ban-caret text-3xs text-slate-500 transition-transform"></i>
        <i class="fa-solid ${cat.icon} ${cat.text}"></i>
        <span class="font-semibold text-slate-200">${escapeHtml(cat.label)}</span>
        <span class="text-2xs font-mono px-2 py-0.5 rounded-full ${cat.badge}">${accounts.length}</span>
        ${moveBtn}
      </div>
      <div class="ban-acc-body hidden border-t border-slate-800 divide-y divide-slate-800/60">${rows}</div>
    </div>`;
}

/** Small coloured tags describing one account's specific bans. */
function banTags(a) {
  if (a.error) return `<span class="text-2xs text-slate-500">${escapeHtml(a.error)}</span>`;
  const tags = [];
  if (a.vacBanned)       tags.push(`<span class="text-2xs px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">VAC${a.vacCount > 1 ? ` ×${a.vacCount}` : ''}</span>`);
  if (a.gameBanned)      tags.push(`<span class="text-2xs px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300">Game${a.gameCount > 1 ? ` ×${a.gameCount}` : ''}</span>`);
  if (a.communityBanned) tags.push(`<span class="text-2xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">Community</span>`);
  if (a.economyBan && a.economyBan !== 'none') tags.push(`<span class="text-2xs px-1.5 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300">Trade: ${escapeHtml(a.economyBan)}</span>`);
  if (!tags.length) tags.push(`<span class="text-2xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">No bans</span>`);
  if (typeof a.daysSinceLastBan === 'number' && a.daysSinceLastBan > 0 && !a.error)
    tags.push(`<span class="text-2xs text-slate-500">${a.daysSinceLastBan}d since last ban</span>`);
  return tags.join(' ');
}

function banAccountRow(a, catKey) {
  const name = a.displayName && a.displayName !== a.username ? `${a.displayName}` : a.username;
  return `
    <div class="flex items-start gap-3 px-4 py-2.5">
      <i class="fa-solid fa-user text-2xs text-slate-600 mt-1 shrink-0"></i>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-medium text-slate-200 truncate">${escapeHtml(name)}</span>
          ${a.steamId ? `<span class="text-2xs font-mono text-slate-500">${escapeHtml(a.steamId)}</span>` : ''}
        </div>
        <div class="mt-1 flex items-center gap-1.5 flex-wrap">${banTags(a)}</div>
      </div>
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
    <span class="w-6 h-6 rounded bg-slate-800 flex items-center justify-center shrink-0">
      <i class="fa-solid fa-user text-3xs ${sel ? 'text-brand' : 'text-slate-500'}"></i></span>
    <span class="flex-1 min-w-0">
      <span class="block text-sm truncate ${sel ? 'text-brand font-semibold' : 'text-slate-200'}">${escapeHtml(a.displayName || a.username)}</span>
      <span class="block text-3xs text-slate-500 truncate"><i class="fa-solid fa-folder mr-1"></i>${escapeHtml(folderName)}</span>
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
    setTimeout(() => { try { startInventoryRefresh({ usernames: affected }); } catch (_) { /* best-effort */ } }, 9000);
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
      const verb = job.cancelled ? 'ended' : 'done';
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

/** Reads the custom EUR price field → integer cents, or null if empty/invalid. */
function customSellCents() {
  const raw = (el.sellCustomPrice.value || '').replace(',', '.').trim();
  const eur = parseFloat(raw);
  return Number.isFinite(eur) && eur > 0 ? Math.round(eur * 100) : null;
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

function openSellModal() {
  const items = selectedSellItems();
  if (items.length === 0) { toast('No items selected', 'warn'); return; }
  state.sellItems = items;
  const bots = new Set(items.map((i) => i.username)).size;
  el.sellSummary.textContent = `${items.length} Item(s)`;
  el.sellFrom.textContent = aggMode()
    ? `${bots} Bot(s): (${selectionBotNames(items)})`
    : state.activeUsername;
  el.sellPreviewResult.classList.add('hidden');
  el.sellPreviewResult.innerHTML = '';
  state.sellPriceMap = null;
  el.sellForm.querySelector('input[name="sellstrategy"][value="lowest"]').checked = true;
  el.sellCustomPrice.value = '';
  toggleSellCustomRow();
  el.sellOverlay.classList.remove('hidden');
}
function closeSellModal() { el.sellOverlay.classList.add('hidden'); }

async function previewSell() {
  const items = state.sellItems || [];
  if (!items.length) return;
  const strategy = sellStrategy();
  const names = [...new Set(items.map((i) => i.marketHashName))];
  const body = { names, strategy, username: items[0] && items[0].username };
  if (strategy === 'custom') {
    const cents = customSellCents();
    if (cents == null) { toast('Please enter a valid custom price (€)', 'warn'); return; }
    body.customCents = cents;
  }
  setButtonLoading(el.sellPreviewBtn, true, 'Calculating…');
  try {
    const map = await api('/api/market/preview', { method: 'POST', body: JSON.stringify(body) });
    state.sellPriceMap = map;                 // name → { netCents, buyerCents }
    renderSellPreview();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setButtonLoading(el.sellPreviewBtn, false, 'Calculate prices & proceeds', 'fa-calculator');
  }
}

/** Re-queries the live price for ONE item only (Hotfix B – fast straggler fix). */
async function retryOnePrice(name, btn) {
  const strategy = sellStrategy();
  const body = { names: [name], strategy, username: (state.sellItems[0] || {}).username };
  if (strategy === 'custom') { const c = customSellCents(); if (c == null) return; body.customCents = c; }
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner cs2-spin"></i>'; }
  try {
    const map = await api('/api/market/preview', { method: 'POST', body: JSON.stringify(body) });
    state.sellPriceMap = { ...(state.sellPriceMap || {}), ...map };
    renderSellPreview();
    const p = map[name] || {};
    if (p.netCents == null) toast(`"${name}" still has no price – try again`, 'warn');
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>'; }
  }
}

/** Renders the sell-preview table from state.sellPriceMap + state.sellItems. */
function renderSellPreview() {
  const items = state.sellItems || [];
  const map = state.sellPriceMap || {};
  const names = [...new Set(items.map((i) => i.marketHashName))];
  let totalBrutto = 0, totalFee = 0, totalNetto = 0, missing = 0;

  const bodyRows = names.map((n) => {
    const p = map[n] || {};
    const cnt = items.filter((i) => i.marketHashName === n).length;
    if (p.netCents == null || p.buyerCents == null) {
      missing += cnt;
      return `<tr class="border-t border-slate-800/60">
        <td class="py-1.5 pl-3 pr-2"><span class="text-slate-400">${escapeHtml(n)}</span> <span class="text-slate-600 font-mono">×${cnt}</span></td>
        <td class="py-1.5 px-2 text-right text-rose-400" colspan="2">no price</td>
        <td class="py-1.5 pl-2 pr-3 text-right">
          <button type="button" data-reprice="${escapeAttr(n)}" title="Re-query only this item"
            class="px-2 py-1 rounded-md bg-slate-800 hover:bg-emerald-600 hover:text-white text-slate-300 text-2xs font-semibold transition">
            <i class="fa-solid fa-rotate-right"></i></button></td></tr>`;
    }
    const fee = Math.max(0, p.buyerCents - p.netCents);
    totalBrutto += p.buyerCents * cnt;
    totalFee    += fee * cnt;
    totalNetto  += p.netCents * cnt;
    return `<tr class="border-t border-slate-800/60">
      <td class="py-1.5 pl-3 pr-2"><span class="text-slate-300">${escapeHtml(n)}</span> <span class="text-slate-600 font-mono">×${cnt}</span></td>
      <td class="py-1.5 px-2 text-right font-mono text-slate-300">${fmtEurCents(p.buyerCents)}</td>
      <td class="py-1.5 px-2 text-right font-mono text-amber-400/90">−${fmtEurCents(fee)}</td>
      <td class="py-1.5 pl-2 pr-3 text-right font-mono text-emerald-400 font-semibold">${fmtEurCents(p.netCents)}</td></tr>`;
  }).join('');

  el.sellPreviewResult.innerHTML = `
    <table class="w-full text-xs">
      <thead>
        <tr class="text-3xs uppercase tracking-wider text-slate-400">
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
          <td class="py-2 px-2 text-right font-mono text-slate-200">${fmtEurCents(totalBrutto)}</td>
          <td class="py-2 px-2 text-right font-mono text-amber-400/90">−${fmtEurCents(totalFee)}</td>
          <td class="py-2 pl-2 pr-3 text-right font-mono text-emerald-400">${fmtEurCents(totalNetto)}</td>
        </tr>
      </tfoot>
    </table>
    ${missing ? `<div class="text-2xs text-amber-400 px-3 py-1.5 border-t border-slate-800">${missing} item(s) without price – use <i class="fa-solid fa-rotate-right"></i> to re-query individually (otherwise skipped).</div>` : ''}`;
  el.sellPreviewResult.querySelectorAll('[data-reprice]').forEach((b) =>
    b.addEventListener('click', () => retryOnePrice(b.dataset.reprice, b)));
  el.sellPreviewResult.classList.remove('hidden');
}

async function submitSell(ev) {
  ev.preventDefault();
  const items = state.sellItems || [];
  if (!items.length) return;
  const strategy = sellStrategy();
  const body = { items, strategy };
  if (strategy === 'custom') {
    const cents = customSellCents();
    if (cents == null) { toast('Please enter a valid custom price (€)', 'warn'); return; }
    body.customCents = cents;
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
    if (r.imported) { closeBulk(); await reloadAll(); if (state.screen === 'inventory' && state.activeEnv) await refreshEnv(); else renderDashboard(); }
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
    el.bulkList.innerHTML = `<p class="text-center text-slate-600 py-8 text-sm">No new maFiles in <code class="text-slate-500">mafiles/</code></p>`;
    el.bulkSubmit.disabled = true;
    return;
  }
  el.bulkList.innerHTML = list.map((f) => `
    <label class="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 ${f.hasPassword ? 'cursor-pointer hover:border-slate-700' : 'opacity-60'}">
      <input type="checkbox" class="bulk-check accent-violet-500 w-4 h-4" data-file="${escapeAttr(f.file)}" data-haspw="${f.hasPassword ? '1' : '0'}" ${f.hasPassword ? '' : 'disabled'} />
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-slate-200 truncate">${escapeHtml(f.accountName)}</p>
        <p class="text-2xs text-slate-500 truncate font-mono">${escapeHtml(f.file)}</p></div>
      ${f.hasPassword
        ? '<span class="text-2xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-400 border border-emerald-700/40 shrink-0"><i class="fa-solid fa-check mr-1"></i>Password</span>'
        : '<span class="text-2xs px-2 py-0.5 rounded-full bg-rose-900/30 text-rose-400 border border-rose-700/40 shrink-0"><i class="fa-solid fa-xmark mr-1"></i>no password</span>'}
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
    } else {
      const skipMsg = res.skipped.length ? `, ${res.skipped.length} skipped` : '';
      toast(`${res.added.length} bot(s) imported${skipMsg}`, res.added.length ? 'success' : 'warn');
    }
    closeBulk();
    await reloadAll();
    if (state.screen === 'inventory' && state.activeEnv) await refreshEnv(); else renderDashboard();
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
    if (r.imported) { closeBulk(); await reloadAll(); if (state.screen === 'inventory' && state.activeEnv) await refreshEnv(); else renderDashboard(); }
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
function onToggleHidden() { state.showHidden = !state.showHidden; renderSidebar(); }

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
    <button type="button" data-i="${i}" class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-teal-600/20 transition">
      ${it.iconUrl ? `<img src="${escapeAttr(safeIconUrl(it.iconUrl))}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'" />` : ''}
      <span class="min-w-0 flex-1">
        <span class="block text-sm text-slate-200 truncate">${escapeHtml(it.name || it.marketHashName)}</span>
        ${it.priceText ? `<span class="block text-2xs text-slate-500">from ${escapeHtml(it.priceText)}</span>` : ''}
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
    <button type="button" data-i="${i}" class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-teal-600/20 transition">
      ${it.iconUrl ? `<img src="${escapeAttr(safeIconUrl(it.iconUrl))}" class="w-7 h-7 object-contain shrink-0" onerror="this.style.display='none'" />` : ''}
      <span class="min-w-0 flex-1"><span class="block text-sm text-slate-200 truncate">${escapeHtml(it.name || it.marketHashName)}</span>
      ${it.priceText ? `<span class="block text-2xs text-slate-500">from ${escapeHtml(it.priceText)}</span>` : ''}</span>
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
  const iconOf  = (s) => ({ bought: 'fa-circle-check', placed: 'fa-circle-check', skipped: 'fa-circle-minus', failed: 'fa-circle-xmark', 'refresh-failed': 'fa-triangle-exclamation' }[s] || 'fa-circle-info');
  el.fbuyResults.innerHTML = rows.map((r) => {
    const qty = r.filled > 0 ? `${r.filled}×` : (r.plannedQty ? `0/${r.plannedQty}` : '—');
    return `<div class="flex items-center gap-2 px-3 py-2">
      <i class="fa-solid ${iconOf(r.status)} ${styleOf(r.status)} shrink-0"></i>
      <span class="font-semibold text-slate-200 truncate" style="max-width:9rem" title="${escapeAttr(r.username)}">${escapeHtml(r.username)}</span>
      <span class="${styleOf(r.status)} font-mono text-2xs shrink-0">${escapeHtml(qty)}</span>
      <span class="text-slate-500 text-2xs truncate flex-1" title="${escapeAttr(r.message)}">${escapeHtml(r.message)}</span>
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
  modalOverlays().forEach((overlay) => {
    new MutationObserver(() => {
      const hidden = overlay.classList.contains('hidden');
      const tracked = FB04.stack.includes(overlay);
      if (!hidden && !tracked) onModalOpen(overlay);
      else if (hidden && tracked) onModalClose(overlay);
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });
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
    const tones = {
      danger: { wrap: 'bg-danger/15 text-danger', icon: 'fa-triangle-exclamation', btn: 'bg-rose-600 hover:bg-rose-500' },
      spend:  { wrap: 'bg-buy/15 text-buy',        icon: 'fa-circle-exclamation',    btn: 'bg-teal-600 hover:bg-teal-500' },
      brand:  { wrap: 'bg-brand/15 text-brand',    icon: 'fa-circle-info',           btn: 'bg-brand hover:bg-brand-dark' },
    };
    const t = tones[tone] || tones.danger;
    const iconEl = $('confirm-icon');
    iconEl.className = `w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${t.wrap}`;
    iconEl.innerHTML = `<i class="fa-solid ${opts.iconClass || t.icon}"></i>`;
    ok.className = `flex-1 px-4 py-2.5 rounded-lg text-white text-sm font-bold transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${t.btn}`;
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
  el.btnBackDashboard.addEventListener('click', showDashboard);
  el.btnGlobalMaster.addEventListener('click', showGlobalMaster);
  el.btnEnvMaster.addEventListener('click', selectEnvMaster);
  el.btnAddAccount.addEventListener('click', openAddAccount);
  el.btnAddFolder.addEventListener('click', () => openFolderModal({ mode: 'create', parentId: null }));
  el.btnRefreshAll.addEventListener('click', refreshAll);
  el.refreshFailedClose.addEventListener('click', hideRefreshFailures);
  // "End Task" buttons — each confirms first, then co-operatively cancels the live job.
  el.refreshEnd.addEventListener('click', () => endTask({ label: 'this refresh', endpoint: '/api/inventory/refresh-cancel', button: el.refreshEnd }));
  el.massEnd.addEventListener('click', () => endTask({ label: 'this mass trade', endpoint: '/api/trade/mass-cancel', button: el.massEnd }));
  el.sellEnd.addEventListener('click', () => endTask({ label: 'this market sale', endpoint: '/api/market/sell-cancel', button: el.sellEnd }));
  el.fbuyEnd.addEventListener('click', () => endTask({ label: 'this mass buy', endpoint: '/api/market/folder-buy-cancel', button: el.fbuyEnd }));
  el.btnGameCs2.addEventListener('click', () => void setGame('cs2'));
  el.btnGameTf2.addEventListener('click', () => void setGame('tf2'));
  el.btnNewEnv.addEventListener('click', () => openEnvModal('create'));
  el.btnBulkImport.addEventListener('click', openBulkImport);
  el.btnLoad.addEventListener('click', refreshAccount);
  el.searchInput.addEventListener('input', onSearch);
  el.toggleHidden.addEventListener('click', onToggleHidden);
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
  // "Use environment proxy" ON greys out the custom-proxy field (it inherits the env).
  el.editUseEnvProxy.addEventListener('change', syncProxyFieldEnabled);
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
  // Feature 3: price-source + currency split control (replaces the old single toggle)
  if (el.srcBtn) el.srcBtn.addEventListener('click', (e) => { e.stopPropagation(); if (el.curMenu) el.curMenu.classList.add('hidden'); if (el.srcMenu) el.srcMenu.classList.toggle('hidden'); });
  if (el.curBtn) el.curBtn.addEventListener('click', (e) => { e.stopPropagation(); if (el.srcMenu) el.srcMenu.classList.add('hidden'); if (el.curMenu) el.curMenu.classList.toggle('hidden'); });
  if (el.srcMenu) el.srcMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-src]'); if (b) setPriceSource(b.getAttribute('data-src')); });
  if (el.curMenu) el.curMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-cur]'); if (b) { setCurrency(b.getAttribute('data-cur')); closeSourceMenus(); } });
  document.addEventListener('click', closeSourceMenus);
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
  ov.innerHTML = `<div class="w-full ${widthClass || 'max-w-4xl'} max-h-[88vh] modal-card flex flex-col overflow-hidden fade-in">
    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
      <h3 class="text-lg font-bold text-white"><i class="fa-solid ${icon} text-brand mr-2"></i>${title}<span data-scope class="text-slate-500 font-mono text-sm font-normal ml-2"></span></h3>
      <button data-close aria-label="Close" class="modal-x"><i class="fa-solid fa-xmark text-lg"></i></button>
    </div>
    <div data-toolbar class="px-6 py-3 border-b border-slate-800 shrink-0 flex items-center gap-3 flex-wrap"></div>
    <div data-body class="overflow-y-auto grow"></div>
    <div data-foot class="px-6 py-2.5 border-t border-slate-800 shrink-0 text-2xs text-slate-500"></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.classList.add('hidden');
  ov.querySelector('[data-close]').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  return ov;
}

// ── Trade-Ups ────────────────────────────────────────────────────────────────
const tuState = { username: null, candidates: [], selected: new Set(), execTimer: null };

async function openTradeUpModal(username) {
  const ov = ensureFeatureOverlay('tradeup-overlay', 'Trade-Ups', 'fa-arrow-trend-up', 'max-w-5xl');
  tuState.username = username; tuState.candidates = []; tuState.selected = new Set();
  ov.querySelector('[data-scope]').textContent = `· ${username}`;
  ov.querySelector('[data-body]').innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-arrow-trend-up"></i></div><div class="empty-title">Scan this account for profitable trade-up contracts.</div><div class="empty-sub">Reads the inventory and computes positive-EV contracts from its skins.</div></div>`;
  ov.querySelector('[data-foot]').textContent = '';
  renderTuToolbar();
  ov.classList.remove('hidden');
  onModalOpen(ov);
}

function renderTuToolbar() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const tb = ov.querySelector('[data-toolbar]');
  const have = tuState.candidates.length;
  tb.innerHTML =
    `<button data-tu-scan class="btn btn-primary btn-sm"><i class="fa-solid fa-magnifying-glass-dollar"></i>Scan trade-ups</button>` +
    (have ? `<button data-tu-all class="btn btn-secondary btn-sm">Select all</button>
      <button data-tu-none class="btn btn-ghost btn-sm">Clear</button>
      <span class="ml-auto"></span>
      <button data-tu-start class="btn btn-danger btn-sm"><i class="fa-solid fa-bolt"></i>Execute (${tuState.selected.size})</button>` : '');
  tb.querySelector('[data-tu-scan]')?.addEventListener('click', tuScan);
  tb.querySelector('[data-tu-none]')?.addEventListener('click', () => { tuState.selected.clear(); renderTuList(); renderTuToolbar(); });
  tb.querySelector('[data-tu-all]')?.addEventListener('click', () => { tuState.candidates.forEach(c => tuState.selected.add(c.id)); renderTuList(); renderTuToolbar(); });
  tb.querySelector('[data-tu-start]')?.addEventListener('click', tuStart);
}

async function tuScan() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const body = ov.querySelector('[data-body]');
  body.innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-spinner cs2-spin"></i></div><div class="empty-title">Refreshing inventory & computing trade-ups…</div></div>`;
  try {
    const res = await api('/api/tradeup/candidates', { method: 'POST', body: JSON.stringify({ username: tuState.username }) });
    tuState.candidates = res.candidates || [];
    tuState.selected = new Set(tuState.candidates.map(c => c.id)); // all auto-selected
    ov.querySelector('[data-foot]').innerHTML = [
      `${tuState.candidates.length} profitable contract(s) · ${res.eligibleInputs} eligible input(s)`,
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
    body.innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-arrow-trend-up"></i></div><div class="empty-title">No positive-profit trade-ups from this account's skins.</div></div>`;
    return;
  }
  const selCls = 'ring-1 ring-brand/60 border-brand/50 shadow-glow';
  body.innerHTML = `<div class="space-y-2 px-5 py-4">` + tuState.candidates.map((c) => {
    const sel = tuState.selected.has(c.id);
    const inputsByName = {};
    for (const i of c.inputs) inputsByName[i.baseName] = (inputsByName[i.baseName] || 0) + 1;
    const inputsTxt = Object.entries(inputsByName).map(([n, q]) => `${q}× ${escapeHtml(n)}`).join(', ');
    const outsTxt = c.outcomes.map(o =>
      `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-950/60 border border-slate-800 text-2xs"><span class="text-slate-200">${escapeHtml(o.name)}</span><span class="text-slate-500">${escapeHtml(o.wear)}</span><span class="text-listed font-semibold">${(o.probability * 100).toFixed(1)}%</span><span class="font-mono ${o.priceCents == null ? 'text-slate-600' : 'text-slate-300'}">${o.priceCents == null ? '—' : fmtCents(o.priceCents)}</span></span>`).join('');
    const profit = c.profitCents > 0;
    const executable = c.inputs.every(i => i.assetId);
    return `<label class="surface p-3.5 flex gap-3 items-start cursor-pointer transition ${sel ? selCls : 'hover:border-brand/40'}">
      <input type="checkbox" data-tu-id="${escapeAttr(c.id)}" ${sel ? 'checked' : ''} class="mt-1 accent-brand w-4 h-4 shrink-0">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-bold text-white">${escapeHtml(c.rarityLabel)} <i class="fa-solid fa-arrow-right-long text-brand-light text-2xs mx-0.5"></i> ${escapeHtml(c.outputRarityLabel)}</span>
          <span class="pill pill--neutral">${escapeHtml(c.collectionLabel)}</span>
          <span class="pill pill--neutral">avg float ${c.avgFloat.toFixed(3)}</span>
          ${c.fullyPriced ? '' : '<span class="pill pill--warn" title="Some prices still loading">~est prices</span>'}
          ${executable ? '' : '<span class="pill pill--danger" title="Missing asset ids — cannot execute">no asset ids</span>'}
        </div>
        <div class="text-2xs text-slate-500 mt-1.5 truncate" title="${escapeAttr(inputsTxt)}">Inputs: ${inputsTxt}</div>
        <div class="flex flex-wrap gap-1.5 mt-2">${outsTxt}</div>
      </div>
      <div class="text-right shrink-0 pl-3 border-l border-slate-800 self-stretch flex flex-col justify-center">
        <div class="text-lg font-bold ${profit ? 'text-success' : 'text-danger'} leading-none">${profit ? '+' : '−'}${fmtCents(Math.abs(c.profitCents))}</div>
        <div class="text-3xs text-slate-500 font-mono mt-1.5">cost ${fmtCents(c.costCents)}</div>
        <div class="text-3xs text-slate-500 font-mono">EV ${fmtCents(c.evCents)}</div>
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
  const contracts = chosen.map(c => ({ inputAssetIds: c.inputs.map(i => i.assetId), rarityId: c.rarityId, stattrak: !!c.stattrak }));
  const ok = await ssimConfirm({
    title: 'Execute trade-ups?',
    body: `Execute <b class="text-slate-100">${chosen.length}</b> trade-up(s) on <b class="text-slate-100">${escapeHtml(tuState.username)}</b>?`
      + `<br><span class="text-rose-400 font-semibold">Each destroys 10 real items. IRREVERSIBLE.</span>`
      + `<br><span class="text-amber-400">⚠ GC trade-up execution has NOT been live-verified. Run ONE cheap contract first and confirm the output arrives before batching more. To disable execution entirely, relaunch with SSIM_GC_VERIFIED=0.</span>`
      + (chosen.length > 1 ? `<br><span class="text-amber-300">You selected ${chosen.length} — consider starting with just 1 until you've confirmed it works.</span>` : ''),
    confirmLabel: 'Execute', confirmIcon: 'fa-bolt', tone: 'danger',
  });
  if (!ok) return;
  try {
    await api('/api/tradeup/execute', { method: 'POST', body: JSON.stringify({ username: tuState.username, contracts }) });
    tuPollExec();
  } catch (err) { toast(err.message, 'error'); }
}

function tuPollExec() {
  const ov = document.getElementById('tradeup-overlay'); if (!ov) return;
  const foot = ov.querySelector('[data-foot]');
  clearTimeout(tuState.execTimer);
  const tick = async () => {
    try {
      const j = await api('/api/tradeup/execute-status');
      const confirmed = (j.results || []).filter(r => r.confirmed).length;
      const line = j.enabled
        ? `Executing ${j.done}/${j.total} · submitted ${j.crafted} (${confirmed} confirmed) · failed ${j.failed}${j.cancelling ? ' · cancelling…' : ''}`
        : `Execution disabled (${escapeHtml(j.statusReason)}) — nothing was crafted.`;
      foot.innerHTML = `<span class="${j.enabled ? 'text-slate-300' : 'text-amber-400'}">${line}</span>` +
        (j.running ? ` <button data-tu-cancel class="ml-2 px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600 text-white">Cancel</button>` : '');
      foot.querySelector('[data-tu-cancel]')?.addEventListener('click', () => api('/api/tradeup/execute-cancel', { method: 'POST' }).catch(() => {}));
      if (j.running) { tuState.execTimer = setTimeout(tick, 1200); }
      else {
        const failMsg = (j.results || []).filter(r => r.error)[0]?.error;
        if (!j.enabled && failMsg) toast(failMsg, 'warn'); else if (j.crafted) toast(`Trade-ups: ${j.crafted} submitted, ${confirmed} confirmed`, 'success');
      }
    } catch { /* stop polling on error */ }
  };
  tick();
}

// ── Storage Units (caskets) ──────────────────────────────────────────────────
const ckState = { username: null, caskets: [], casketId: null, contents: [], invSel: new Set(), unitSel: new Set(), search: '', error: null, moveTimer: null };

async function openCasketModal(username) {
  const ov = ensureFeatureOverlay('casket-overlay', 'Storage Units', 'fa-box-archive', 'max-w-5xl');
  Object.assign(ckState, { username, caskets: [], casketId: null, contents: [], invSel: new Set(), unitSel: new Set(), search: '', error: null });
  ov.querySelector('[data-scope]').textContent = `· ${username}`;
  ov.querySelector('[data-toolbar]').innerHTML = `<label class="text-2xs uppercase tracking-wide text-slate-500 font-semibold">Storage unit</label><select data-ck-unit class="field !w-auto !py-1.5 text-sm"><option value="">— loading… —</option></select>`;
  ov.querySelector('[data-body]').innerHTML = `<div class="empty"><div class="empty-icon"><i class="fa-solid fa-spinner cs2-spin"></i></div><div class="empty-title">Connecting to the game coordinator…</div></div>`;
  ov.classList.remove('hidden');
  onModalOpen(ov);
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
  sel.onchange = async () => { ckState.casketId = sel.value; ckState.unitSel = new Set(); await loadCasketContents(); renderCasketPanels(); };
}

async function loadCasketContents() {
  if (!ckState.casketId) { ckState.contents = []; return; }
  try {
    const r = await api(`/api/casket/${encodeURIComponent(ckState.username)}/contents?casketId=${encodeURIComponent(ckState.casketId)}`);
    ckState.contents = r.items || [];
  } catch { ckState.contents = []; }
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
  return true;
}

function renderCasketPanels() {
  const ov = document.getElementById('casket-overlay'); if (!ov) return;
  const invRows = casketInvRows();
  const invCount = invRows.reduce((n, i) => casketStorable(i) ? n + i.assetIds.length : n, 0);
  const unit = ckState.caskets.find(c => c.id === ckState.casketId);
  const invInner = invRows.length ? invRows.map(i => {
    if (!casketStorable(i)) {
      return `<div class="flex items-center gap-2.5 px-3 py-2 text-xs opacity-40 cursor-not-allowed" title="This item type can't be stored in a storage unit">
        <i class="fa-solid fa-ban w-3.5 text-slate-600 shrink-0"></i>
        <span class="truncate flex-1 text-slate-300">${escapeHtml(i.name || i.marketHashName)}</span>
        <span class="text-3xs uppercase tracking-wide text-slate-600 shrink-0">not storable</span>
        <span class="text-slate-600 font-mono">×${i.assetIds.length}</span></div>`;
    }
    const sel = ckState.invSel.has(i.marketHashName);
    return `<label class="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/40 cursor-pointer text-xs">
      <input type="checkbox" data-ck-inv="${escapeAttr(i.marketHashName)}" ${sel ? 'checked' : ''} class="accent-brand w-3.5 h-3.5 shrink-0">
      <span class="truncate flex-1 text-slate-200">${escapeHtml(i.name || i.marketHashName)}</span>
      <span class="text-slate-600 font-mono">×${i.assetIds.length}</span></label>`;
  }).join('') : `<div class="empty !py-10"><div class="empty-icon"><i class="fa-solid fa-box-open"></i></div><div class="empty-title">No depositable items in cache.</div><div class="empty-sub">Refresh the account to populate it.</div></div>`;
  const unitInner = ckState.contents.length ? ckState.contents.map(it => {
    const id = String(it.id); const sel = ckState.unitSel.has(id);
    return `<label class="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/40 cursor-pointer text-xs">
      <input type="checkbox" data-ck-unit-item="${escapeAttr(id)}" ${sel ? 'checked' : ''} class="accent-brand w-3.5 h-3.5 shrink-0">
      <span class="truncate flex-1 text-slate-200">${escapeHtml(it.custom_name || ('Item ' + id))}</span>
      <span class="text-slate-600 font-mono">${it.def_index != null ? 'def ' + it.def_index : ''}</span></label>`;
  }).join('') : `<div class="empty !py-10"><div class="empty-icon ${ckState.error ? 'text-warn' : ''}"><i class="fa-solid fa-${ckState.error ? 'triangle-exclamation' : 'box-archive'}"></i></div><div class="empty-title">${ckState.error ? escapeHtml(ckState.error) : (ckState.casketId ? 'Empty storage unit.' : 'No storage unit selected.')}</div>${ckState.error ? '<div class="empty-sub">Storage units need the GC layer (install globaloffensive + set SSIM_GC_VERIFIED=1).</div>' : ''}</div>`;

  const pct = unit ? Math.min(100, Math.round((unit.count / 1000) * 100)) : 0;
  const capBar = unit ? `<div class="px-3 pt-2.5"><div class="h-1.5 rounded-full bg-slate-800 overflow-hidden"><div class="h-full rounded-full bg-brand" style="width:${pct}%"></div></div><div class="text-3xs text-slate-500 mt-1 font-mono">${unit.count} / 1000</div></div>` : '';

  ov.querySelector('[data-body]').innerHTML =
    `<div class="px-5 py-3 flex items-center gap-2 border-b border-slate-800">
       <input data-ck-search value="${escapeAttr(ckState.search)}" placeholder="Filter inventory…" class="field !py-1.5 !w-56 text-xs">
       <span class="ml-auto"></span>
       <button data-ck-deposit class="btn btn-primary btn-sm">Deposit <i class="fa-solid fa-arrow-right"></i></button>
       <button data-ck-withdraw class="btn btn-secondary btn-sm"><i class="fa-solid fa-arrow-left"></i> Withdraw</button>
     </div>
     <div class="grid grid-cols-2 gap-3 p-3" style="height:46vh">
       <div class="surface flex flex-col min-h-0">
         <div class="panel-head"><span class="panel-title">Inventory</span><span class="text-2xs text-slate-500">${invCount} item(s)</span><button data-ck-sel="inv" class="btn btn-ghost btn-sm ml-auto !py-1 !px-2">Select all</button></div>
         <div class="overflow-y-auto grow divide-y divide-slate-800/60">${invInner}</div>
       </div>
       <div class="surface flex flex-col min-h-0">
         <div class="panel-head"><span class="panel-title truncate">${unit ? escapeHtml(unit.name) : 'Storage unit'}</span><span class="text-2xs text-slate-500 shrink-0">${ckState.unitSel.size} selected</span><button data-ck-sel="unit" class="btn btn-ghost btn-sm ml-auto !py-1 !px-2">Select all</button></div>
         ${capBar}
         <div class="overflow-y-auto grow divide-y divide-slate-800/60 ${capBar ? 'mt-1' : ''}">${unitInner}</div>
       </div>
     </div>`;

  const body = ov.querySelector('[data-body]');
  body.querySelector('[data-ck-search]')?.addEventListener('input', (e) => { ckState.search = e.target.value; renderCasketPanels(); body.querySelector('[data-ck-search]')?.focus(); });
  body.querySelectorAll('[data-ck-inv]').forEach(cb => cb.addEventListener('change', () => { cb.checked ? ckState.invSel.add(cb.dataset.ckInv) : ckState.invSel.delete(cb.dataset.ckInv); }));
  body.querySelectorAll('[data-ck-unit-item]').forEach(cb => cb.addEventListener('change', () => { cb.checked ? ckState.unitSel.add(cb.dataset.ckUnitItem) : ckState.unitSel.delete(cb.dataset.ckUnitItem); }));
  body.querySelector('[data-ck-sel="inv"]')?.addEventListener('click', () => { casketInvRows().filter(casketStorable).forEach(i => ckState.invSel.add(i.marketHashName)); renderCasketPanels(); });
  body.querySelector('[data-ck-sel="unit"]')?.addEventListener('click', () => { ckState.contents.forEach(i => ckState.unitSel.add(String(i.id))); renderCasketPanels(); });
  body.querySelector('[data-ck-deposit]')?.addEventListener('click', () => casketMove('deposit'));
  body.querySelector('[data-ck-withdraw]')?.addEventListener('click', () => casketMove('withdraw'));
}

async function casketMove(direction) {
  if (!ckState.casketId) { toast('Select a storage unit first', 'warn'); return; }
  let itemIds;
  if (direction === 'deposit') {
    const rows = casketInvRows().filter(i => ckState.invSel.has(i.marketHashName));
    itemIds = rows.flatMap(i => i.assetIds);
  } else {
    itemIds = [...ckState.unitSel];
  }
  if (!itemIds.length) { toast(`Select item(s) to ${direction}`, 'warn'); return; }
  const ok = await ssimConfirm({
    title: `${direction === 'deposit' ? 'Deposit' : 'Withdraw'} ${itemIds.length} item(s)?`,
    body: `${direction === 'deposit' ? 'Move into' : 'Take from'} the storage unit on <b class="text-slate-100">${escapeHtml(ckState.username)}</b>?`,
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
  const tick = async () => {
    try {
      const j = await api('/api/casket/move-status');
      const line = j.error ? `<span class="text-amber-400">${escapeHtml(j.error)}</span>`
        : `<span class="text-slate-300">${j.direction}: ${j.done}/${j.total} · moved ${j.moved}${j.unconfirmed ? ' · unconfirmed ' + j.unconfirmed : ''} · failed ${j.failed}${j.cancelling ? ' · cancelling…' : ''}</span>`;
      foot.innerHTML = line + (j.running ? ` <button data-ck-cancel class="ml-2 px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600 text-white">Cancel</button>` : '');
      foot.querySelector('[data-ck-cancel]')?.addEventListener('click', () => api('/api/casket/move-cancel', { method: 'POST' }).catch(() => {}));
      if (j.running) { ckState.moveTimer = setTimeout(tick, 1000); }
      else if (!j.error && (j.moved || j.unconfirmed)) {
        // Reload the unit's contents on ANY sent move (confirmed OR unconfirmed) so the panel
        // reflects reality — an "unconfirmed" item may well have moved (the SO just didn't echo).
        if (j.moved) toast(`Storage: ${j.moved} ${j.direction === 'deposit' ? 'deposited' : 'withdrawn'}${j.unconfirmed ? ' (' + j.unconfirmed + ' unconfirmed — verify in-game)' : ''}`, j.unconfirmed ? 'warn' : 'success');
        else toast(`Storage: ${j.unconfirmed} sent but unconfirmed — verify in-game`, 'warn');
        await loadCasketContents(); renderCasketPanels();
      }
    } catch { /* stop on error */ }
  };
  tick();
}

// One-shot startup splash (Feature A): the brand bloom + Santer-mark draw-in, played
// exactly once per session on the unlock→dashboard transition, then removed — handing
// off to the dashboard skeleton rendered underneath. Gated by sessionStorage so soft
// reloads of the dashboard don't replay it; skipped entirely under prefers-reduced-motion.
// Pure CSS (see #ssim-splash in index.html); no backend.
function playStartupSplash() {
  try {
    if (sessionStorage.getItem('ssim-splash-played')) return;  // already shown this session → no replay on soft reloads
    sessionStorage.setItem('ssim-splash-played', '1');
  } catch { /* storage blocked: fall through and just play once for this load */ }

  const splash = document.getElementById('ssim-splash');
  if (!splash) return;
  // Respect reduced motion: skip the flourish so the skeleton shows immediately.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  splash.classList.remove('hidden');
  splash.classList.add('is-playing');

  let removed = false;
  const done = () => { if (removed) return; removed = true; splash.remove(); };
  // The overlay's own fade-out (ssim-splash-out) finishes last (~1.2s); ignore the
  // earlier animationend events bubbling up from the bloom/mark.
  splash.addEventListener('animationend', (e) => { if (e.target === splash) done(); });
  setTimeout(done, 1300);   // safety net if animationend never fires (e.g. animation interrupted)
}

async function init() {
  if (!(await ensureLicensed())) return;                       // no dashboard without a valid license
  document.documentElement.classList.remove('ssim-locked');    // authorized → reveal the UI
  playStartupSplash();                                         // A: brand splash, once per unlock→dashboard transition
  bindStaticEvents();
  setupSidebarResize();
  setupStickyHeader();
  setupModalInfra();
  setupDelegation();
  updateCurrencyButton();
  updatePriceSourceButton();
  api('/api/pricing/source').then((r) => { if (r && r.effective) { state.priceSource = r.effective; localStorage.setItem('ssim.priceSource', r.effective); updatePriceSourceButton(); } }).catch(() => {});
  try {
    showScreen('dashboard'); renderDashboardSkeleton();   // FB-03: skeleton tiles while the first load runs
    await reloadAll();
    showDashboard();
    // The initial /api/inventory load enriches from cache and kicks off a background price fill for
    // any missing/stale prices (server.ts ensureFilled). NONE of the refresh/source-switch paths ran
    // here, so that boot fill was previously never watched — priceless items only appeared after a
    // restart. Watch it now (once; the repriceToken makes it non-overlapping) so prices + the
    // indicator live-update with no reload. (PRICE-BOOT-FILL)
    void watchPriceFill(refreshActiveViewFromCache);
    // Poll system status for the update / breaker / prior-crash surfaces (C3/B3/B1). Additive; once.
    void watchSystemStatus();
  } catch (err) {
    toast(`Could not load data: ${err.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
