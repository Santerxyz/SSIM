import axios from 'axios';
import type { ManagedSession } from '../types/session';
import type { CS2Item } from '../types/inventory';
import { logger } from '../utils/logger';
import {
  parseMyListings, mergeParsed, emptyParsed,
  listingsForApp, listedAssetIdsForApp, type MarketListing,
} from './MarketModel';
import { STEAM_BROWSER_UA, STEAM_XHR_HEADERS } from '../network/steamHeaders';

// ════════════════════════════════════════════════════════════════════════════
//  MarketListings – the 3rd dashboard bucket: items CURRENTLY ON SALE on the
//  Steam Community Market. A listed asset CAN still surface in the web inventory
//  (confirmed listings appear in ctx16, pending-confirmation listings are still
//  in ctx2), which is exactly why fetchListedItems returns the `assetIds` superset
//  that the inventory refresh (InventoryService.doRefreshOneViaGc) subtracts from
//  ctx2+ctx16 – so one asset is never double-bucketed. The rows themselves are read
//  from the seller's own listings endpoint. Routed through the account's isolated
//  agent + cookies, same as every other web call.
//
//  Parsing is delegated to the single canonical parser (MarketModel.parseMyListings)
//  so the "Listed" bucket, the "Active Orders" view and the mass-sell pre-flight can
//  never disagree about which assets are on the market (the old field bug). Unlike
//  the previous strict parser, a listing whose asset has no description is KEPT
//  (name → "Unknown"); its asset id still lands in the dedup superset, so it can
//  never simultaneously appear as Owned.
// ════════════════════════════════════════════════════════════════════════════

const CS2_APPID = 730;
const MARKET_UA = STEAM_BROWSER_UA;

export interface ListedItems {
  /** CS2 listed items as dashboard rows (category: 'listed'). */
  items:    CS2Item[];
  /**
   * Canonical CS2 dedup superset: every asset id the market holds for this account.
   * The inventory refresh subtracts this set from ctx2+ctx16 so a listed asset is
   * never also counted as Owned/locked (one asset = one bucket).
   */
  assetIds: Set<string>;
  /**
   * true ⇒ the MAX_PAGES cap was exhausted with more listings still to read, so the
   * listed bucket is INCOMPLETE. Feeds `inv.partial` so the cache is never
   * marked complete when listings past the cap were dropped.
   */
  truncated: boolean;
}

/**
 * Returns the account's active CS2 market listings (rows + dedup superset).
 * Paginated. Throws on any page failure (status, unusable body, or network error);
 * the caller treats a thrown fetch as "listings unread this pass" and carries the
 * cached listed bucket forward — a partial page set is never committed.
 */
export async function fetchListedItems(session: ManagedSession): Promise<ListedItems> {
  const cookies = session.webSession?.cookies ?? [];
  const acc = emptyParsed();
  const PAGE = 100;
  const MAX_PAGES = 30; // up to 3000 listings
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE;
    const url = `https://steamcommunity.com/market/mylistings/render/?query=&start=${start}&count=${PAGE}&norender=1`;
    const r = await axios.get(url, {
      httpsAgent:     session.httpsAgent,
      proxy:          false, // per-account isolation: never an env-var proxy
      timeout:        20_000,
      validateStatus: () => true,
      headers: {
        ...STEAM_XHR_HEADERS, // Chromium fingerprint so Steam's bot-check doesn't 429
        Cookie:       cookies.join('; '),
        'User-Agent': MARKET_UA,
        Accept:       'application/json',
        Referer:      'https://steamcommunity.com/market/',
        Connection:   'close',
      },
    });
    if (r.status !== 200) throw new Error(`market/mylistings HTTP ${r.status} (page ${page})`);
    const d = r.data;
    if (!d || typeof d !== 'object') throw new Error(`market/mylistings: malformed response (page ${page})`);

    // parseMyListings throws on a non-listings body ({"success":false}/shapeless) so a
    // transient market-subsystem hiccup is never mistaken for "no listings" (which would
    // wipe the Listed bucket). any page's throw propagates: the caller's listingsOk guard
    // then carries the cached bucket forward — a partial page set is never committed.
    mergeParsed(acc, parseMyListings(d));

    const total = Number(d.total_count);
    const listings = Array.isArray(d.listings) ? d.listings : [];
    if (listings.length < PAGE) break;                          // last (partial) page
    if (Number.isFinite(total) && start + PAGE >= total) break; // covered all
    // Reached the last allowed page yet neither break fired ⇒ more listings remain past
    // the cap. Flag the bucket INCOMPLETE instead of silently claiming completeness.
    if (page === MAX_PAGES - 1) {
      truncated = true;
      logger.warn(`[${session.account.username}] market/mylistings exceeds ${MAX_PAGES * PAGE} listings – listed bucket INCOMPLETE`);
    }
  }

  const items = listingsForApp(acc, CS2_APPID).map(toListedItem);
  logger.info(`[${session.account.username}] market: ${items.length} listed item(s)`);
  return { items, assetIds: listedAssetIdsForApp(acc, CS2_APPID), truncated };
}

function toListedItem(l: MarketListing): CS2Item {
  return {
    assetId:        l.assetId,
    classId:        l.classId,
    instanceId:     l.instanceId,
    marketHashName: l.marketHashName,
    name:           l.name,
    type:           '',
    rarity:         'Unknown',
    rarityColor:    '#6b7280',
    exterior:       null,
    tradable:       false, // a listed item is held by the market, not freely tradable
    marketable:     true,
    tradeLockExpiry: null,
    quantity:       1,
    assetIds:       [l.assetId],
    iconUrl:        l.iconUrl,
    category:       'listed',
    listingConfirmed: l.confirmed, // false ⇒ awaiting 2FA confirmation (C9 / INV-D4)
  };
}
