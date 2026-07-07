// ─── Parsed Item Types ─────────────────────────────────────────────────────────

export type ItemRarity =
  | 'Consumer Grade'   | 'Industrial Grade' | 'Mil-Spec Grade'
  | 'Restricted'       | 'Classified'       | 'Covert'
  | 'Extraordinary'    | 'Contraband'       | 'Base Grade'
  | 'High Grade'       | 'Remarkable'       | 'Exotic'
  | 'Distinguished'    | 'Exceptional'      | 'Superior'
  | 'Master'           | 'Unknown';

export type ItemExterior =
  | 'Factory New' | 'Minimal Wear' | 'Field-Tested'
  | 'Well-Worn'   | 'Battle-Scarred';

export interface Sticker {
  slot:       number;
  stickerId:  number;
  name:       string;
  codename:   string;
  material?:  string;
  imageUrl?:  string;
}

export interface CS2Item {
  assetId:         string;
  classId:         string;
  instanceId:      string;
  marketHashName:  string;
  name:            string;
  type:            string;
  rarity:          ItemRarity;
  rarityColor:     string;
  exterior:        ItemExterior | null;
  tradable:        boolean;
  marketable:      boolean;
  /** null  →  no trade lock */
  tradeLockExpiry: Date | null;
  /**
   * Strict dashboard bucket:
   *   'listed'      – currently on sale on the Steam Community Market (NOT in the
   *                   inventory itself; sourced from the market-listings endpoint)
   *   'tradelocked' – in the inventory but held (tradeLockExpiry in the future)
   *   'tradable'    – in the inventory and freely tradable right now
   * Persisted with the record. At read time, `tagCategories` (server.ts) re-derives the
   * tradelocked/tradable split from the FINAL lock state (after the manual-protection
   * overlay) for `source='gc'` records; 'listed' is sticky — it is market-sourced at
   * refresh time and trusted from the cache (including the carry-forward when a listings
   * fetch fails).
   */
  category?: 'listed' | 'tradelocked' | 'tradable';
  /**
   * For a 'listed' item only: false ⇒ the listing is still awaiting mobile (2FA)
   * confirmation on Steam (it came from pending_listings / listings_to_confirm). Lets
   * the dashboard distinguish a confirmed live sale from one created-but-not-yet-
   * confirmed, instead of counting both as simply "listed". (C9 / INV-D4.)
   */
  listingConfirmed?: boolean;
  /**
   * Trade/market restriction period of this item TYPE in days (Steam's
   * `market_tradable_restriction`, typically 7). Metadata only – it does NOT mean
   * the item is currently held. Used by the protection auto-tracker to decide
   * whether a newly-received asset should get a +N-day protection window.
   */
  marketRestriction?: number;
  /** Number of identical, identically-locked items collapsed into this stack. */
  quantity:        number;
  /** Asset IDs of every item in the stack (length === quantity). */
  assetIds:        string[];
  /**
   * Lowest market price in USD cents (per single item). Enriched at read-time
   * from the shared price cache. `null` = no market price; `undefined` = not priced yet.
   */
  price?:          number | null;
  iconUrl:         string;
  inspectLink?:    string;
  stickers?:       Sticker[];
}

/** Supported inventory games. CS2 = appid 730 · TF2 = appid 440. Context 2 is each game's DEFAULT context (quick/forceRefresh reads); CS2 COMPLETENESS = ctx2 + ctx16 + market/mylistings — see InventoryService.doRefreshOneViaGc. */
export type GameId = 'cs2' | 'tf2';

export interface AccountInventory {
  username:    string;
  steamId:     string;
  /** Which game this inventory belongs to. Absent in legacy records = 'cs2'. */
  game?:       GameId;
  items:       CS2Item[];
  totalItems:  number;
  fetchedAt:   Date;
  fromCache:   boolean;
  /**
   * True when this record is known to be INCOMPLETE — the Steam inventory read was
   * truncated at the page cap (very large inventory). The dashboard must not treat a
   * partial record as the authoritative full inventory. (C12 / INV-B9/B10.)
   */
  partial?:    boolean;
  /** Steam's `total_inventory_count` for this read; undefined when Steam did not supply it.
   *  A strict 0 is the AUTHORITATIVE-empty signal used to converge a genuinely-emptied cache. (H-INV-005.) */
  reportedTotal?: number;
  /**
   * Which refresh produced this record:
   *   'web' – the Steam Community /inventory endpoint (default, fast, but blind to
   *           items the web layer hasn't synced)
   *   'gc'  – the CS2 Game Coordinator (complete: in-game truth incl. trade-locks)
   * Absent in legacy records = 'web'.
   */
  source?:     'web' | 'gc';
  /** Sum of price × quantity over priced items (USD cents). Enriched at read-time. */
  totalValueUsd?: number;
  /** Steam wallet balance in the account's native currency, captured at refresh.
   *  UNIT: MAJOR units for 2-decimal currencies (steam-user ÷100 — see src/types/session.ts wallet; 0-decimal unit unverified, B18); convert to minor units ONLY via knownCurrencyInfo (S64). */
  wallet?:     { currency: number; balance: number };
  /**
   * Read-time only — this result is a carried-forward cache record substituted for a suspect
   * (empty/page-cap-shrunk) fresh read. NEVER persisted; fresh-read-dependent consumers (buy
   * verification) must treat it as a failed fresh read. (H-TRD-041.)
   */
  staleReadFallback?: boolean;
}

// ─── Raw Steam API Response ────────────────────────────────────────────────────

export interface RawSteamInventoryResponse {
  assets?:                RawAsset[];
  descriptions?:          RawDescription[];
  total_inventory_count?: number;
  success?:               number;
  error?:                 string;
  more_items?:            number;
  last_assetid?:          string;
  /** Set by InventoryManager.fetchRaw when the read stopped at the page cap while Steam
   *  still had more pages → the asset list is PARTIAL. (C12.) */
  truncated?:             boolean;
}

export interface RawAsset {
  appid:       number;
  contextid:   string;
  assetid:     string;
  classid:     string;
  instanceid:  string;
  amount:      string;
}

export interface RawDescription {
  appid:            number;
  classid:          string;
  instanceid:       string;
  market_name:      string;
  market_hash_name: string;
  name:             string;
  type:             string;
  tradable:         number;
  marketable:       number;
  commodity:        number;
  icon_url:         string;
  icon_url_large?:  string;
  name_color?:      string;
  background_color?: string;
  tags?:            RawTag[];
  descriptions?:    Array<{ type: string; value: string; color?: string }>;
  /** Per-owner text – Steam hides the trade-lock notice ("Tradable After …") here */
  owner_descriptions?: Array<{ type: string; value: string; color?: string }>;
  actions?:         Array<{ link: string; name: string }>;
  /** ISO timestamp at which a trade hold expires (present only while locked) */
  cache_expiration?: string;
  /** Item-TYPE trade-restriction period in days (metadata; not a live lock flag). */
  market_tradable_restriction?:   number;
  /** Item-TYPE market-restriction period in days (metadata; not a live lock flag). */
  market_marketable_restriction?: number;
}

export interface RawTag {
  category:               string;
  internal_name:          string;
  localized_category_name: string;
  localized_tag_name:     string;
  color?:                 string;
}
