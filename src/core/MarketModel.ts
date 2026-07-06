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
  /** true ⇒ live sell (`listings`) or a server-side hold (`listings_on_hold`);
   *  false ⇒ awaiting mobile confirmation (`pending_listings` / `listings_to_confirm`). */
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
  /**
   * Listing-identity keys already accumulated across pages, so a listing re-fetched
   * after a mid-pagination shift (Steam's newest-first order changes while we page)
   * is merged once, not twice. Lazily built by `mergeParsed` from `listings` when a
   * hand-built accumulator lacks it. Key = listingId || 'asset:'+appId/contextId/assetId.
   */
  seenKeys?: Set<string>;
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
  // A non-listings payload (Steam error body such as {"success":false} — served
  // HTTP 200 on market-subsystem hiccups — or any shapeless JSON) must NOT parse
  // to "successfully empty", which would wipe the Listed bucket. Reject unless the
  // body carries a listings-shaped key. Accept boolean success (market) AND numeric
  // 1 (inventory) — see DEDUP baseline §D. A legit empty account keeps parsing.
  const structural =
    ('listings' in d) || ('assets' in d) || ('total_count' in d) ||
    ('pending_listings' in d) || ('listings_to_confirm' in d);
  if (d.success === false || d.success === 0 || !structural) {
    throw new Error('mylistings: not a listings payload (success=' + String((d as any).success) + ')');
  }
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
    const cid = Number(l?.currencyid); const currency = Number.isFinite(cid) ? Math.max(0, cid - 2000) : 0;
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
  // On-hold listings ARE confirmed sells — Steam is holding the item (device-change
  // window etc.), the hold is server-side, not an awaiting-2FA state. Keep them in the
  // Listed bucket so the operator can see/cancel them; do NOT overload confirmed:false.
  for (const l of Array.isArray(d.listings_on_hold) ? d.listings_on_hold : []) {
    const ml = toListing(l, true);
    if (ml) out.listings.push(ml);
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

/** Listing-identity key: the cancel handle when present, else the asset composite
 *  (unique within app+context — pending listings can have listingId ''). */
function listingKey(l: MarketListing): string {
  return l.listingId || `asset:${l.appId}/${l.contextId}/${l.assetId}`;
}

/**
 * Merge a freshly-parsed page into a multi-page accumulator, deduping by listing
 * identity: multi-page reads are snapshots seconds apart while listings can change
 * (SSIM's own mass-sell adds/removes), so a listing shifted past a page boundary is
 * re-fetched — keeping both copies inflates the Listed stack quantity and worth.
 */
export function mergeParsed(acc: ParsedMyListings, page: ParsedMyListings): void {
  if (!acc.seenKeys) {                             // backfill for hand-built accumulators
    acc.seenKeys = new Set<string>();
    for (const l of acc.listings) acc.seenKeys.add(listingKey(l));
  }
  for (const l of page.listings) {
    const key = listingKey(l);
    if (acc.seenKeys.has(key)) continue;           // already merged from an earlier page
    acc.seenKeys.add(key);
    acc.listings.push(l);
  }
  for (const [appId, ids] of page.assetIdsByApp) {
    let s = acc.assetIdsByApp.get(appId);
    if (!s) { s = new Set<string>(); acc.assetIdsByApp.set(appId, s); }
    for (const id of ids) s.add(id);
  }
}

export function emptyParsed(): ParsedMyListings {
  return { listings: [], assetIdsByApp: new Map(), seenKeys: new Set() };
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
  if (Number.isNaN(exp)) return 'tradelocked'; // unparseable lock date ⇒ fail closed
  if (exp && exp > nowMs) return 'tradelocked';
  if (item.tradable !== true) return 'tradelocked'; // untradable-for-any-reason ≠ tradable
  return 'tradable';
}

// ── Sellable / sendable guard — the ONLY gate on the sell & send paths ────────

/** True iff the item may be listed on the market or sent in a trade right now. */
export function isSellable(item: BucketInput, nowMs: number = Date.now()): boolean {
  const exp = item.tradeLockExpiry ? new Date(item.tradeLockExpiry).getTime() : 0;
  if (Number.isNaN(exp)) return false; // unparseable lock date ⇒ fail closed
  if (exp && exp > nowMs) return false; // trade-locked
  return item.tradable === true; // must be affirmatively tradable
}

/** Throws when the item is trade-locked or non-tradable. */
export function assertSellable(item: BucketInput & { assetId?: string }, nowMs: number = Date.now()): void {
  if (!isSellable(item, nowMs)) {
    throw new Error(`asset ${item.assetId ?? '?'} is trade-locked or not tradable and cannot be listed/sent`);
  }
}
