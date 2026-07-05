import axios from 'axios';
import type { ManagedSession } from '../types/session';
import type { CS2Item } from '../types/inventory';
import { logger } from '../utils/logger';
import {
  parseMyListings, mergeParsed, emptyParsed,
  listingsForApp, listedAssetIdsForApp, type MarketListing,
} from './MarketModel';

// ════════════════════════════════════════════════════════════════════════════
//  MarketListings – the 3rd dashboard bucket: items CURRENTLY ON SALE on the
//  Steam Community Market. These are NOT in the inventory (the market holds them
//  while listed), so neither the web nor the GC inventory fetch can see them –
//  they have to be read from the seller's own listings endpoint. Routed through
//  the account's isolated agent + cookies, same as every other web call.
//
//  Parsing is delegated to the SINGLE canonical parser (MarketModel.parseMyListings)
//  so the "Listed" bucket, the "Active Orders" view and the mass-sell pre-flight can
//  never disagree about which assets are on the market (the old field bug). Unlike
//  the previous strict parser, a listing whose asset has no description is KEPT
//  (name → "Unknown"); its asset id still lands in the dedup superset, so it can
//  never simultaneously appear as Owned.
// ════════════════════════════════════════════════════════════════════════════

const CS2_APPID = 730;
const MARKET_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface ListedItems {
  /** CS2 listed items as dashboard rows (category: 'listed'). */
  items:    CS2Item[];
  /**
   * Canonical CS2 dedup superset: every asset id the market holds for this account.
   * The inventory refresh subtracts THIS set from ctx2+ctx16 so a listed asset is
   * never also counted as Owned/locked (one asset = one bucket).
   */
  assetIds: Set<string>;
}

/**
 * Returns the account's active CS2 market listings (rows + dedup superset).
 * Paginated. Throws on ANY page failure (status, unusable body, or network error);
 * the caller treats a thrown fetch as "listings unread this pass" and carries the
 * cached listed bucket forward — a partial page set is never committed.
 */
export async function fetchListedItems(session: ManagedSession): Promise<ListedItems> {
  const cookies = session.webSession?.cookies ?? [];
  const acc = emptyParsed();
  const PAGE = 100;
  const MAX_PAGES = 30; // up to 3000 listings

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE;
    const url = `https://steamcommunity.com/market/mylistings/render/?query=&start=${start}&count=${PAGE}&norender=1`;
    const r = await axios.get(url, {
      httpsAgent:     session.httpsAgent,
      proxy:          false, // per-account isolation: never an env-var proxy
      timeout:        20_000,
      validateStatus: () => true,
      headers: {
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
    // wipe the Listed bucket). ANY page's throw propagates: the caller's listingsOk guard
    // then carries the cached bucket forward — a partial page set is never committed.
    mergeParsed(acc, parseMyListings(d));

    const total = Number(d.total_count);
    const listings = Array.isArray(d.listings) ? d.listings : [];
    if (listings.length < PAGE) break;                          // last (partial) page
    if (Number.isFinite(total) && start + PAGE >= total) break; // covered all
  }

  const items = listingsForApp(acc, CS2_APPID).map(toListedItem);
  logger.info(`[${session.account.username}] market: ${items.length} listed item(s)`);
  return { items, assetIds: listedAssetIdsForApp(acc, CS2_APPID) };
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
