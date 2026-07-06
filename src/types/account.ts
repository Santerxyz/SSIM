// ─── Account & Config Types ───────────────────────────────────────────────────

export type NetworkType = 'proxy' | 'localip';

/**
 * proxy: full URL  →  "http://user:pass@1.2.3.4:3128"  |  "socks5://1.2.3.4:1080"
 * localip: bind addr  →  "192.168.1.10"
 */
export interface NetworkConfig {
  type:  NetworkType;
  value: string;
}

// ─── Environments (v2.0 – top level) ──────────────────────────────────────────

/**
 * An Environment is the new top-level grouping (e.g. "Deutschland-Farm").
 * It owns ONE global (rotating) proxy string that all of its accounts inherit,
 * plus its own folder/account structure (scoped via environmentId).
 */
export interface Environment {
  id:        string;
  name:      string;
  /** The single global rotating proxy for this environment. Empty = local IP. */
  proxy:     string;
  /** Optional tile accent colour for the dashboard. */
  color?:    string;
  createdAt: string; // ISO 8601
}

export type AccountTier = 'limited' | 'full';

export interface AccountConfig {
  id:          string;
  username:    string;
  password:    string;
  /** Filename inside ./mafiles/  OR  absolute path */
  maFilePath:  string;
  /**
   * RESOLVED network – COMPUTED at read-time by AccountManager (from
   * networkOverride or the environment's proxy) and attached to every account
   * object it returns. NOT persisted. SessionManager/AgentFactory read this, so
   * the trade-isolation chain stays untouched.
   */
  network?:    NetworkConfig;
  /**
   * Optional per-account proxy override. When set it wins over the environment
   * proxy; when absent the account inherits `environment.proxy`. This is what
   * gets persisted (not `network`).
   */
  networkOverride?: NetworkConfig;
  /** Which environment this account belongs to (v2.0). */
  environmentId: string;
  enabled:     boolean;
  displayName?: string;
  /**
   * Cached SteamID64 (the account's permanent, PUBLIC identifier), learned on the first
   * login and written-through here so it's available WITHOUT a login forever after. Lives in
   * accounts.json (non-secret) rather than the encrypted vault. CRITICAL: always a STRING —
   * a maFile's numeric Session.SteamID exceeds Number.MAX_SAFE_INTEGER and rounds, so it must
   * never be the source; session.getSteamID64() is exact.
   */
  steamId?:    string;
  /**
   * ID of the folder this account lives in. `null`/`undefined` = environment root.
   * Folders are stored flat (adjacency list) and scoped to the environment.
   */
  folderId?:   string | null;
  /**
   * Manual Steam trade-URL override. When set it wins over the value fetched
   * live from SteamCommunity (Feature 2: auto + manual override).
   */
  tradeUrl?:   string;
  /**
   * Per-account browser User-Agent for web API calls (inventory etc.).
   * Strictly encapsulated per account; falls back to a default browser UA.
   */
  userAgent?:  string;
  /**
   * Soft-hide flag. A hidden account disappears from the dashboard but its
   * Steam session keeps running in memory (NOT logged out / removed).
   */
  hidden?:     boolean;
  /**
   * Manual trade-protection date (ISO 8601). Steam's new "Trade Protection"
   * (Trade Protection) is NOT exposed via any web inventory API, so the user can
   * set this per account to mark ALL of its items as locked until the given date.
   * When in the future it overrides the per-asset auto-tracking for display.
   * Empty/absent/past = no manual protection. Malformed (unparseable) values are
   * treated as NO protection and logged as a warning at read time — use ISO 8601.
   */
  protectedUntil?: string;
  /**
   * Account capability tier (Feature 1 "Account Login"). 'limited' = imported via
   * QR/credentials with NO maFile → cannot confirm sell listings or trade offers
   * (no identity_secret); 'full' = has a maFile and confirms normally. Absent is
   * treated as 'full' (accounts added the classic way always have a maFile). The
   * RUNTIME source of truth for "can confirm" remains maFile.identity_secret; this
   * is the persisted UI label, set to 'limited' at import and flipped to 'full'
   * when a maFile is attached.
   */
  tier?:       AccountTier;
  addedAt:     string; // ISO 8601
}

// ─── Folders (nested, adjacency-list) ─────────────────────────────────────────

/**
 * A folder node. Folders are stored FLAT as an adjacency list (each node points
 * at its parent) and the tree is computed on demand – this keeps the flat
 * `accounts[]` array and all existing queries untouched.
 */
export interface Folder {
  id:            string;        // uuid
  name:          string;
  parentId:      string | null; // null = environment root level
  environmentId: string;        // which environment this folder belongs to (v2.0)
  createdAt:     string;        // ISO 8601
}

// ─── maFile (Steam Desktop Authenticator format) ──────────────────────────────

export interface MaFile {
  shared_secret:    string;
  /** Absent or '' ⇒ this maFile cannot confirm trades/listings (limited capability); every consumer must truthiness-guard (see accountCapability.canConfirm) */
  identity_secret?: string;
  /** Absent in some third-party exports; drop-zone import requires it (maFiles.ts) */
  account_name?:    string;
  serial_number?:   string;
  revocation_code?: string;
  uri?:             string;
  server_time?:     number;
  token_gid?:       string;
  /**
   * SDA writes these as raw JSON numbers exceeding Number.MAX_SAFE_INTEGER — the numeric form is
   * ALREADY precision-corrupted by JSON.parse and must never be converted to a string or used as an id.
   * Only a `typeof === 'string'` value matching /^7656\d{13}$/ is trustworthy; resolve ids per
   * BanService.resolveSteamId (raw-text regex / filename / live session).
   */
  steamid?:         string | number;
  /**
   * @deprecated dead SDA web-session data — nothing in src/ reads it; parse-time normalization deletes
   * it (H-ACC-073); typed only to describe legacy vault records.
   */
  Session?: {
    SessionID?:        string;
    SteamLogin?:       string;
    SteamLoginSecure?: string;
    WebCookie?:        string;
    OAuthToken?:       string;
    SteamID?:          string | number;
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export interface AccountsDatabase {
  version:      number;
  /** Top-level environments (v2.0 / DB version 3). */
  environments: Environment[];
  /** Flat folder list (adjacency list), each scoped to an environment. */
  folders:      Folder[];
  accounts:     AccountConfig[];
  updatedAt:    string;
}

// ─── Tree view (computed, never persisted) ────────────────────────────────────

export interface TreeNode {
  folder:    Folder;
  children:  TreeNode[];
  accounts:  AccountConfig[];
}

export interface AccountTree {
  /** Top-level folders (parentId === null). */
  folders:  TreeNode[];
  /** Accounts sitting at the root (no folderId). */
  accounts: AccountConfig[];
}
