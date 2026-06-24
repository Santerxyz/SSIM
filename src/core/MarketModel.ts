// ════════════════════════════════════════════════════════════════════════════
//  MarketModel — the SINGLE source of truth for "what is on the market" and for
//  "which bucket an item belongs to". Pure (no network, no heavy imports) so it is
//  trivially unit-testable and can be imported anywhere.
//
//  Before this module, three independent parsers of market/mylistings/render
//  disagreed on which listings count (the field bug: an item Owned+locked, Listed=0,
//  yet under Active Orders). They are now all derived from `parseMyListings`, which
//  is INCLUSIVE: a listing present in the payload is ALWAYS kept — membership never
//  depends on the item having a usable name/description. Unifying on the inclusive
//  side is deliberate: dropping a metadata-less listing (the old strict rule in
//  MarketListings.ts) hid live listings the operator could not see or cancel, which
//  is strictly worse than the visible inconsistency.
// ════════════════════════════════════════════════════════════════════════════

const IMG_BASE = 'https://community.cloudflare.steamstatic.com/economy/image/';

/** One market SELL listing, canonical shape shared by every consumer. */
export interface MarketListing {
  /** Steam listingid (the cancel/removelisting handle). '' when only pending. */
  listingId:         string;
  assetId:           string;
  classId:           string;
  instanceId:        string;
  appId:             number;
  contextId:         string;
  marketHashName:    string;
  name:              string;
  iconUrl:           string;
  /** What a BUYER pays (seller-net + Steam fee), minor units. 0 when unknown. */
  pricePerItemMinor: number;
  currency:          number;   // Steam ECurrencyCode (0 = unknown)
  quantity:          number;
  /** false ⇒ awaiting mobile confirmation (pending_listings / listings_to_confirm). */
  confirmed:         boolean;
}

export interface ParsedMyListings {
  listings: MarketListing[];
  /**
   * Every asset id the market references on the parsed page(s), grouped by appId.
   * This is the dedup SUPERSET — an asset id present here is on the market and must
   * NEVER be shown as Owned. It is a superset of `listings` (also folds in the raw
   * `assets` map + pending arrays) so nothing can leak back into the Owned bucket.
   */
  assetIdsByApp: Map<number, Set<string>>;
}

function iconUrlOf(desc: any): string {
  const i = desc?.icon_url_large ?? desc?.icon_url ?? '';
  return i ? IMG_BASE + i : '';
}

function addId(map: Map<number, Set<string>>, appId: number, id: string): void {
  if (!appId || !id) return;
  let s = map.get(appId);
  if (!s) { s = new Set<string>(); map.set(appId, s); }
  s.add(id);
}

/**
 * Parse ONE `market/mylistings/render` page payload into the canonical model.
 * INCLUSIVE by design: every listing object with an asset id is kept; a missing
 * description only degrades the name to "Unknown", it never drops the listing.
 */
export function parseMyListings(d: any): ParsedMyListings {
  const out: ParsedMyListings = { listings: [], assetIdsByApp: new Map() };
  if (!d || typeof d !== 'object') return out;
  const assets = d.assets ?? {};

  const toListing = (l: any, confirmed: boolean): MarketListing | null => {
    const asset = l?.asset ?? {};
    const id = String(asset.id ?? asset.assetid ?? '');
    if (!id) return null;                                   // no asset → not a listing
    const appId = Number(asset.appid) || 0;
    const ctx   = String(asset.contextid ?? '');
    const desc  = assets?.[String(appId)]?.[ctx]?.[id] ?? {}; // may be absent → {}
    const price = Number(l?.price) || 0;                    // seller-net (minor units)
    const fee   = Number(l?.fee)   || 0;
    const currency = l?.currencyid != null ? Math.max(0, Number(l.currencyid) - 2000) : 0;
    addId(out.assetIdsByApp, appId, id);
    return {
      listingId:         l?.listingid != null ? String(l.listingid) : '',
      assetId:           id,
      classId:           String(desc.classid ?? ''),
      instanceId:        String(desc.instanceid ?? ''),
      appId,
      contextId:         ctx,
      marketHashName:    desc.market_hash_name ?? desc.name ?? 'Unknown',
      name:              desc.name ?? desc.market_hash_name ?? 'Unknown',
      iconUrl:           iconUrlOf(desc),
      pricePerItemMinor: price + fee,
      currency,
      quantity:          Number(asset.amount) || 1,
      confirmed,
    };
  };

  for (const l of Array.isArray(d.listings) ? d.listings : []) {
    const ml = toListing(l, true);
    if (ml) out.listings.push(ml);
  }
  for (const key of ['pending_listings', 'listings_to_confirm']) {
    for (const l of Array.isArray(d[key]) ? d[key] : []) {
      const ml = toListing(l, false);
      if (ml) out.listings.push(ml);
    }
  }
  // Safety net: any asset id present in the `assets` map is market-held even if no
  // listing object referenced it → keep it in the dedup superset (never Owned).
  for (const appKey of Object.keys(assets)) {
    const appId = Number(appKey) || 0;
    const ctxs  = assets[appKey] ?? {};
    for (const ctx of Object.keys(ctxs)) {
      for (const id of Object.keys(ctxs[ctx] ?? {})) addId(out.assetIdsByApp, appId, String(id));
    }
  }
  return out;
}

/** Merge a freshly-parsed page into a multi-page accumulator. */
export function mergeParsed(acc: ParsedMyListings, page: ParsedMyListings): void {
  acc.listings.push(...page.listings);
  for (const [appId, ids] of page.assetIdsByApp) {
    let s = acc.assetIdsByApp.get(appId);
    if (!s) { s = new Set<string>(); acc.assetIdsByApp.set(appId, s); }
    for (const id of ids) s.add(id);
  }
}

export function emptyParsed(): ParsedMyListings {
  return { listings: [], assetIdsByApp: new Map() };
}

export function listingsForApp(p: ParsedMyListings, appId: number): MarketListing[] {
  return p.listings.filter(l => l.appId === appId);
}

export function listedAssetIdsForApp(p: ParsedMyListings, appId: number): Set<string> {
  return p.assetIdsByApp.get(appId) ?? new Set<string>();
}

// ── Bucket classifier — the ONLY place an owned item's bucket is decided ──────

export type ItemBucket = 'listed' | 'tradelocked' | 'tradable';

export interface BucketInput {
  category?:        string | null;
  tradeLockExpiry?: Date | string | null;
  tradable?:        boolean;
}

/**
 * Decide an item's dashboard bucket from BOTH its trade-lock expiry AND its raw
 * `tradable` flag. A non-tradable item (for ANY reason — held, untradable type,
 * unparsed hold) is never reported as freely "tradable". A pre-set 'listed'
 * category (membership-derived elsewhere) passes through untouched.
 */
export function bucketOf(item: BucketInput, nowMs: number = Date.now()): ItemBucket {
  if (item.category === 'listed') return 'listed';
  const exp = item.tradeLockExpiry ? new Date(item.tradeLockExpiry).getTime() : 0;
  if (exp && exp > nowMs) return 'tradelocked';
  if (item.tradable === false) return 'tradelocked'; // untradable-for-any-reason ≠ tradable
  return 'tradable';
}

// ── Sellable / sendable guard — the ONLY gate on the sell & send paths ────────

/** True iff the item may be listed on the market or sent in a trade right now. */
export function isSellable(item: BucketInput, nowMs: number = Date.now()): boolean {
  const exp = item.tradeLockExpiry ? new Date(item.tradeLockExpiry).getTime() : 0;
  if (exp && exp > nowMs) return false; // trade-locked
  if (item.tradable === false) return false; // not tradable
  return true;
}

/** Throws when the item is trade-locked or non-tradable. */
export function assertSellable(item: BucketInput & { assetId?: string }, nowMs: number = Date.now()): void {
  if (!isSellable(item, nowMs)) {
    throw new Error(`asset ${item.assetId ?? '?'} is trade-locked or not tradable and cannot be listed/sent`);
  }
}
