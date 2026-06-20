import axios from 'axios';
import type { ManagedSession } from '../types/session';
import type { CS2Item } from '../types/inventory';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  MarketListings – the 3rd dashboard bucket: items CURRENTLY ON SALE on the
//  Steam Community Market. These are NOT in the inventory (the market holds them
//  while listed), so neither the web nor the GC inventory fetch can see them –
//  they have to be read from the seller's own listings endpoint. Routed through
//  the account's isolated agent + cookies, same as every other web call.
// ════════════════════════════════════════════════════════════════════════════

const IMG_BASE  = 'https://community.cloudflare.steamstatic.com/economy/image/';
const CS2_APPID = 730;
const CS2_CTX   = '2';
const MARKET_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Returns the account's active CS2 market listings as CS2Items tagged
 * `category: 'listed'`. Paginated; best-effort names/icons from the listing's
 * own asset description. Throws only on a hard failure of the FIRST page (so the
 * caller can treat a dead proxy as a real error); later-page hiccups just stop.
 */
export async function fetchListedItems(session: ManagedSession): Promise<CS2Item[]> {
  const cookies = session.webSession?.cookies ?? [];
  const out: CS2Item[] = [];
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
    if (r.status !== 200) {
      if (page === 0) throw new Error(`market/mylistings HTTP ${r.status}`);
      break;
    }
    const d = r.data;
    if (!d || typeof d !== 'object') break;

    const assetMap = d.assets?.[String(CS2_APPID)]?.[CS2_CTX] ?? {};
    const listings: unknown[] = Array.isArray(d.listings) ? d.listings : [];
    for (const raw of listings) {
      const l = raw as { asset?: { id?: string; assetid?: string } };
      const id = String(l?.asset?.id ?? l?.asset?.assetid ?? '');
      if (!id) continue;
      const desc = assetMap[id];
      if (!desc) continue;
      if (!desc.market_hash_name && !desc.name) continue; // #35: no usable name → not a real listing, skip
      out.push(toListedItem(desc, id));
    }

    const total = Number(d.total_count);
    if (listings.length < PAGE) break;                          // last (partial) page
    if (Number.isFinite(total) && start + PAGE >= total) break; // covered all
  }

  logger.info(`[${session.account.username}] market: ${out.length} listed item(s)`);
  return out;
}

function toListedItem(desc: any, assetId: string): CS2Item {
  const icon = desc.icon_url_large ?? desc.icon_url ?? '';
  return {
    assetId,
    classId:        String(desc.classid ?? ''),
    instanceId:     String(desc.instanceid ?? ''),
    marketHashName: desc.market_hash_name ?? desc.name ?? 'Unknown',
    name:           desc.name ?? desc.market_hash_name ?? 'Unknown',
    type:           desc.type ?? '',
    rarity:         'Unknown',
    rarityColor:    desc.name_color ? `#${desc.name_color}` : '#6b7280',
    exterior:       null,
    tradable:       false, // a listed item is held by the market, not freely tradable
    marketable:     true,
    tradeLockExpiry: null,
    quantity:       1,
    assetIds:       [assetId],
    iconUrl:        icon ? IMG_BASE + icon : '',
    category:       'listed',
  };
}
