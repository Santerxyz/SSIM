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
   * Strict dashboard bucket (computed at read-time, never trusted from disk):
   *   'listed'      – currently on sale on the Steam Community Market (NOT in the
   *                   inventory itself; sourced from the market-listings endpoint)
   *   'tradelocked' – in the inventory but held (tradeLockExpiry in the future)
   *   'tradable'    – in the inventory and freely tradable right now
   */
  category?: 'listed' | 'tradelocked' | 'tradable';
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

/** Supported inventory games. CS2 = appid 730 · TF2 = appid 440 (both context 2). */
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
   * Which refresh produced this record:
   *   'web' – the Steam Community /inventory endpoint (default, fast, but blind to
   *           items the web layer hasn't synced)
   *   'gc'  – the CS2 Game Coordinator (complete: in-game truth incl. trade-locks)
   * Absent in legacy records = 'web'.
   */
  source?:     'web' | 'gc';
  /** Sum of price × quantity over priced items (USD cents). Enriched at read-time. */
  totalValueUsd?: number;
  /** Steam wallet balance in the account's native currency, captured at refresh. */
  wallet?:     { currency: number; balance: number };
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
