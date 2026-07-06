import axios from 'axios';
import type { ManagedSession } from '../types/session';
import { SessionState } from '../types/session';
import { refreshWebSession } from './SessionManager';
import type {
  AccountInventory,
  CS2Item,
  GameId,
  ItemExterior,
  ItemRarity,
  RawAsset,
  RawDescription,
  RawSteamInventoryResponse,
  RawTag,
  Sticker,
} from '../types/inventory';
import { logger } from '../utils/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Steam appid + inventory context per supported game. */
export const GAMES: Record<GameId, { appId: number; contextId: number; label: string }> = {
  cs2: { appId: 730, contextId: 2, label: 'CS2' },
  tf2: { appId: 440, contextId: 2, label: 'TF2' },
};

const IMG_BASE     = 'https://community.cloudflare.steamstatic.com/economy/image/';
const INVENTORY_COUNT = 2000; // Steam's max page size; large inventories are paginated
const MAX_INVENTORY_PAGES = 25; // hard ceiling (25 × 2000 = 50k items) – safety against loops

/**
 * Default browser-like User-Agent. Steam sits behind Cloudflare, which often
 * rejects requests carrying a non-browser UA with HTTP 400. A realistic UA is
 * therefore mandatory; accounts may override it via AccountConfig.userAgent.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ════════════════════════════════════════════════════════════════════════════
//  InventoryManager – fetch, parse, and price a single account's CS2 inventory
// ════════════════════════════════════════════════════════════════════════════

export class InventoryManager {
  // ── 1) Fetch raw inventory via the account's isolated web session ───────────

  /**
   * Pulls the raw Steam inventory JSON using the per-account web-session cookies
   * and the per-account httpsAgent. Strictly scoped – nothing is shared globally.
   * `game` selects the appid/context (CS2 by default, TF2 supported).
   */
  static async fetchRaw(session: ManagedSession, game: GameId = 'cs2', contextOverride?: number): Promise<RawSteamInventoryResponse> {
    const { appId } = GAMES[game];
    // CS2 trade-locked / listed items live in context 16 (vs the normal context 2);
    // callers pass an override to read them. Defaults to the game's normal context.
    const contextId = contextOverride ?? GAMES[game].contextId;
    if (session.state !== SessionState.LOGGED_IN) {
      throw new Error(`[${session.account.username}] not logged in (state=${session.state})`);
    }
    if (!session.steamId) {
      throw new Error(`[${session.account.username}] missing steamId`);
    }
    if (!session.webSession || session.webSession.cookies.length === 0) {
      throw new Error(`[${session.account.username}] no web session cookies available`);
    }

    const username = session.account.username;

    // 1) Force the SteamID into its 64-bit string form. If steamId is ever an
    //    object (e.g. a SteamID instance) this avoids a "/inventory/[object Object]/…"
    //    URL that Steam would reject with HTTP 400.
    const steamId = resolveSteamId64(session);

    // Per-account User-Agent (strict encapsulation) → default browser UA.
    const userAgent = session.account.userAgent ?? DEFAULT_USER_AGENT;

    // ── Paginated fetch ────────────────────────────────────────────────────────
    // Steam serves large inventories in pages: each response carries up to
    // `count` assets plus `more_items`/`last_assetid` to continue. A farm/storage
    // bot can hold thousands of items, so a single page silently DROPS most of
    // them (and any recently-received, trade-locked items that sit on a later
    // page → they'd look "not in inventory"). We follow the cursor to the end.
    const assets:       RawAsset[]       = [];
    const descByKey     = new Map<string, RawDescription>(); // dedup across pages
    let   startAssetId: string | undefined;
    let   totalCount    = 0;
    let   sawTotal      = false; // did Steam ever send total_inventory_count? (absent ≠ authoritative 0)
    let   hitPageCap    = false; // true if we stopped while Steam still had more pages
    let   midPageFail   = false; // true if a page ≥1 came back unusable / the cursor stalled (partial read)

    for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
      const url =
        `https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}` +
        `?l=english&count=${INVENTORY_COUNT}` +
        (startAssetId ? `&start_assetid=${startAssetId}` : '');

      const doRequest = () => axios.get<RawSteamInventoryResponse>(url, {
        httpsAgent:     session.httpsAgent,
        proxy:          false, // NEVER let an env-var proxy override the per-account agent
        timeout:        15_000, // FAIL FAST: a dead proxy releases the slot in 15s, not 20s+

        validateStatus: () => true,
        headers: {
          // Cookies MUST be joined with "; " into a single header value.
          'Cookie':           session.webSession!.cookies.join('; '),
          'User-Agent':       userAgent,
          'Accept':           'application/json, text/javascript, */*; q=0.01',
          'Accept-Language':  'en-US,en;q=0.9',
          'Referer':          'https://steamcommunity.com/',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      let res = await doRequest();

      // ── Silent cookie renewal (any page) ──────────────────────────────────────
      // If the web call fails for a non-rate-limit reason, the cookies may simply have
      // expired — including MID-PAGINATION on a long fetch (#33), where the old page-0-only
      // guard discarded every page already fetched. Re-issue cookies via webLogOn() on the
      // SAME open connection (no full re-login, no IP hop) and retry THIS page once.
      if (res.status !== 200 && res.status !== 429) {
        logger.warn(`[${username}] inventory call (page ${page}) returned HTTP ${res.status} – refreshing web session and retrying once`);
        // Only the cookie renewal is guarded: on refresh failure we keep the old `res` and fall
        // through to the status checks. The retried request runs OUTSIDE the try so a transport
        // rejection (ETIMEDOUT/ECONNRESET) propagates to the caller and is classified transient
        // by fetchRawRetrying — instead of being swallowed here, leaving `res` on the stale status
        // and throwing a lying "private inventory (HTTP 403)" the S50 retry ladder never retries.
        let refreshed = false;
        try {
          await refreshWebSession(session);
          refreshed = true;
        } catch (refreshErr) {
          logger.warn(`[${username}] silent web-session refresh failed: ${(refreshErr as Error).message}`);
        }
        if (refreshed) res = await doRequest();
      }

      if (res.status === 429) {
        throw new Error(`[${username}] inventory rate-limited (HTTP 429)`);
      }
      if (res.status === 403) {
        throw new Error(`[${username}] inventory private or session invalid (HTTP 403)`);
      }
      if (res.status !== 200) {
        const bodySnippet = describeBody(res.data);
        logger.error(`[${username}] inventory fetch failed (HTTP ${res.status})  body=${bodySnippet}`);
        throw new Error(`[${username}] inventory fetch failed (HTTP ${res.status}): ${bodySnippet}`);
      }

      const body = res.data;

      // S4: distinguish an AUTHORITATIVE empty inventory (Steam answered success with zero assets)
      // from an UNUSABLE page-0 body (null / HTML error page / {success:false} / {success:0} / {}).
      // The old code coerced BOTH into a "successful empty inventory" (success:1), so a transient bad
      // body on ONE context (ctx2 owned vs ctx16 trade-locked/listed) silently dropped that whole
      // context from the MERGED cache while the other context kept rawCount>0 — the item-state
      // divergence, and a weakened send-side trade-lock guard. On page 0 an unusable body now THROWS
      // (a per-account fetch failure the caller records, preserving the cache) instead of committing a
      // phantom-empty context. An authoritative empty (success:1, zero assets) still returns empty.
      const authoritative = !!body && typeof body === 'object' && body.success === 1; // Steam's empty-inventory signal
      if (page === 0 && !authoritative) {
        const snippet = describeBody(body);
        logger.error(`[${username}] inventory page 0 body is NOT an authoritative Steam response (success!=1) – treating as a FETCH FAILURE, not an empty inventory  body=${snippet}`);
        throw new Error(`[${username}] inventory page 0 unusable (not success:1): ${snippet}`);
      }
      if (page > 0 && !authoritative) {
        // Later pages only (page 0 is handled above by the throw): an unusable body (null / HTML /
        // {success:0} / {}) must NOT masquerade as the complete inventory — a break preserves the
        // pages already fetched (#33) but flags the result PARTIAL so the fuller-cache guard fires.
        logger.warn(`[${username}] inventory page ${page} body not authoritative (${describeBody(body)}) – keeping ${assets.length} assets fetched so far, result marked PARTIAL`);
        midPageFail = true;
        break;
      }

      for (const a of body.assets ?? []) assets.push(a);
      for (const d of body.descriptions ?? []) descByKey.set(`${d.classid}_${d.instanceid}`, d);
      if (body.total_inventory_count != null) { totalCount = body.total_inventory_count; sawTotal = true; }

      // Continue only while Steam signals more pages AND advances the cursor.
      if (body.more_items && body.last_assetid && body.last_assetid !== startAssetId) {
        if (page === MAX_INVENTORY_PAGES - 1) { hitPageCap = true; break; } // more pages exist but we hit the cap
        startAssetId = body.last_assetid;
        continue;
      }
      // Reaching here with more_items still truthy means Steam claims more pages but the cursor did
      // not advance (missing / repeated last_assetid) → a stuck cursor. Stop, but flag PARTIAL so the
      // half read does not clobber the fuller cache as authoritative.
      if (body.more_items) {
        logger.warn(`[${username}] inventory pagination cursor stalled after page ${page} (more_items set, last_assetid=${body.last_assetid ?? '<none>'}) – keeping ${assets.length} assets fetched so far, result marked PARTIAL`);
        midPageFail = true;
      }
      break;
    }

    // A genuine page-cap truncation (we stopped while Steam still had more pages) means
    // the persisted inventory is PARTIAL, not authoritative — surface it LOUDLY (#12).
    // totalCount is also a Steam estimate, so a small shortfall without a cap hit is benign.
    if (hitPageCap) {
      logger.error(`[${username}] inventory TRUNCATED at the ${MAX_INVENTORY_PAGES}-page cap (${assets.length} assets, total≈${totalCount}) – result is PARTIAL; trust the GC inventory for this account`);
    } else if (assets.length < totalCount) {
      logger.warn(`[${username}] inventory pagination incomplete: ${assets.length}/${totalCount} assets fetched`);
    }
    logger.info(
      `[${username}] raw inventory: ${assets.length} assets, ` +
      `${descByKey.size} descriptions (total_inventory_count=${totalCount})`,
    );
    // Preserve the distinction between an EXPLICIT total_inventory_count:0 (authoritative empty,
    // used downstream to converge a genuinely-emptied cache) and an OMITTED field (unknown → protect).
    return { assets, descriptions: [...descByKey.values()], total_inventory_count: sawTotal ? totalCount : undefined, success: 1, truncated: hitPageCap || midPageFail };
  }

  // ── 2) Parse raw assets + descriptions → CS2Item[] ──────────────────────────

  static parse(raw: RawSteamInventoryResponse, steamId: string, game: GameId = 'cs2'): CS2Item[] {
    const assets       = raw.assets ?? [];
    const descriptions = raw.descriptions ?? [];

    // Build a description lookup keyed by classid_instanceid
    const descMap = new Map<string, RawDescription>();
    for (const d of descriptions) {
      descMap.set(`${d.classid}_${d.instanceid}`, d);
    }

    const items: CS2Item[] = [];
    let orphans = 0;
    for (const asset of assets) {
      const desc = descMap.get(`${asset.classid}_${asset.instanceid}`);
      if (!desc) { orphans++; continue; } // asset with no matching description – cannot classify
      items.push(InventoryManager.mapItem(asset, desc, steamId, game));
    }
    // Descriptions are deduped by classid_instanceid, so identical items legitimately SHARE
    // one description (e.g. 31 assets / 28 descriptions = 3 duplicate skins) — that is NOT a
    // drop and every asset still maps. A genuine orphan (asset with NO description at all) is
    // rare and DOES vanish from the count, so surface it loudly to keep the totals honest.
    if (orphans > 0) {
      logger.warn(`parsed ${items.length} item(s) from ${assets.length} asset(s) – ${orphans} asset(s) had no matching description and were dropped (totals may under-count)`);
    }
    return items;
  }

  private static mapItem(asset: RawAsset, desc: RawDescription, steamId: string, game: GameId): CS2Item {
    const rarityTag   = findTag(desc.tags, 'Rarity');
    const exteriorTag = findTag(desc.tags, 'Exterior');
    const typeTag     = findTag(desc.tags, 'Type');

    return {
      assetId:         asset.assetid,
      classId:         asset.classid,
      instanceId:      asset.instanceid,
      marketHashName:  desc.market_hash_name,
      name:            desc.name,
      type:            typeTag?.localized_tag_name ?? desc.type ?? 'Unknown',
      rarity:          normalizeRarity(rarityTag?.localized_tag_name),
      rarityColor:     rarityTag?.color ? `#${rarityTag.color}` : (desc.name_color ? `#${desc.name_color}` : '#000000'),
      exterior:        normalizeExterior(exteriorTag?.localized_tag_name),
      tradable:        desc.tradable === 1,
      marketable:      desc.marketable === 1,
      // Trade-lock from Steam's own data: the "Tradable/Marketable After …" notice in
      // owner_descriptions — present in CS2 context 2 (market-bought holds) AND context
      // 16 (trade-received holds). For CS2 we do NOT use the cache_expiration fallback
      // (it's a description-cache TTL, not a real hold → false positives); TF2 keeps it.
      tradeLockExpiry: parseTradeLock(desc, game === 'tf2'),
      marketRestriction: desc.market_tradable_restriction ?? desc.market_marketable_restriction ?? 0,
      quantity:        1,
      assetIds:        [asset.assetid],
      iconUrl:         IMG_BASE + (desc.icon_url_large ?? desc.icon_url),
      inspectLink:     buildInspectLink(desc, asset, steamId),
      stickers:        parseStickers(desc),
    };
  }

  // ── 2b) Stack identical items (same name AND same trade-lock state) ─────────

  /**
   * Collapses duplicate items into stacks. Two items only stack when they share
   * the SAME market_hash_name AND the SAME trade-lock expiry – items locked until
   * different dates must remain separate stacks. Each stack carries quantity and
   * the full list of underlying asset IDs. Accepts both single items and
   * already-stacked inputs (quantity>1) — merging is quantity-aware.
   */
  static stack(items: CS2Item[]): CS2Item[] {
    const stacks = new Map<string, CS2Item>();

    for (const item of items) {
      // Trade-lock timestamp (or 'none') is part of the key → different locks split.
      const lockKey = item.tradeLockExpiry ? item.tradeLockExpiry.toISOString() : 'none';
      // Pending-2FA listings must not collapse into confirmed ones (C9 / INV-D4) —
      // non-listed items have listingConfirmed === undefined → constant 'ok' suffix.
      const stateKey = item.listingConfirmed === false ? 'pending' : 'ok';
      const key = `${item.marketHashName}__${lockKey}__${stateKey}`;

      const existing = stacks.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.assetIds.push(...item.assetIds);
      } else {
        // Clone so we never mutate the caller's input item.
        stacks.set(key, { ...item, assetIds: [...item.assetIds] });
      }
    }

    return [...stacks.values()];
  }

  // ── 3) Integration: fetch + parse + stack ────────────────────────────────────

  /**
   * Fetches the inventory for a logged-in session, parses it (items, trade-locks,
   * rarities) and collapses duplicates into stacks. Fast and self-contained.
   *
   * Trade-locks are taken STRICTLY from Steam's own data (the `tradable` flag and
   * any explicit hold date via parseTradeLock). Items locked until different dates
   * stay in separate stacks; otherwise identical items collapse into one stack.
   */
  static async fetchInventoryOnly(session: ManagedSession, game: GameId = 'cs2'): Promise<AccountInventory> {
    const username = session.account.username;
    const steamId  = resolveSteamId64(session); // normalized 64-bit string

    const raw    = await InventoryManager.fetchRaw(session, game);
    const parsed = InventoryManager.parse(raw, steamId, game);
    const items  = InventoryManager.stack(parsed); // collapse duplicates into stacks

    const realCount = parsed.length; // true item count (before stacking)
    const locked    = items.filter(i => i.tradeLockExpiry).length;
    logger.info(
      `[${username}] parsed ${realCount} ${GAMES[game].label} items → ${items.length} stacks ` +
      `(${locked} locked stacks)`,
    );

    return {
      username,
      steamId,
      game,
      items,
      totalItems: realCount, // reflects the real number of items, not stack count
      fetchedAt:  new Date(),
      fromCache:  false,
      partial:    !!raw.truncated, // honest flag: a page-capped read is incomplete (C12)
      reportedTotal: raw.total_inventory_count, // Steam's own total (undefined when omitted) → authoritative-empty signal (H-INV-005)
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Request helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Normalizes a session's SteamID to its 64-bit string form, regardless of
 * whether it is already a string or a SteamID-like object. Guards against the
 * "[object Object]" URL bug that yields HTTP 400.
 */
function resolveSteamId64(session: ManagedSession): string {
  const raw: unknown = session.steamId;
  if (typeof raw === 'string') return raw;

  // Defensive: a SteamID instance exposes getSteamID64(); otherwise String() it.
  if (raw && typeof (raw as { getSteamID64?: () => string }).getSteamID64 === 'function') {
    return (raw as { getSteamID64: () => string }).getSteamID64();
  }
  // Last resort – fall back to the live client's SteamID.
  const fromClient = session.client.steamID?.getSteamID64();
  return fromClient ?? String(raw);
}

/** Renders a response body (object or string) into a short, loggable snippet. */
function describeBody(data: unknown): string {
  if (data === null || data === undefined) return '<empty>';
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else {
    try { text = JSON.stringify(data); } catch { text = String(data); }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

// ════════════════════════════════════════════════════════════════════════════
//  Parsing helpers
// ════════════════════════════════════════════════════════════════════════════

function findTag(tags: RawTag[] | undefined, category: string): RawTag | undefined {
  return tags?.find(t => t.category === category);
}

function normalizeRarity(value?: string): ItemRarity {
  const KNOWN: ItemRarity[] = [
    'Consumer Grade', 'Industrial Grade', 'Mil-Spec Grade', 'Restricted',
    'Classified', 'Covert', 'Extraordinary', 'Contraband', 'Base Grade',
    'High Grade', 'Remarkable', 'Exotic', 'Distinguished', 'Exceptional',
    'Superior', 'Master',
  ];
  return (value && KNOWN.includes(value as ItemRarity)) ? (value as ItemRarity) : 'Unknown';
}

function normalizeExterior(value?: string): ItemExterior | null {
  const KNOWN: ItemExterior[] = [
    'Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred',
  ];
  return (value && KNOWN.includes(value as ItemExterior)) ? (value as ItemExterior) : null;
}

/**
 * Resolves a trade-lock expiry from Steam's data. The AUTHORITATIVE source is the
 * per-owner "Tradable After <date>" notice (visible only on the OWNER view, which
 * is why the inventory fetch must be authenticated). `cache_expiration` is only a
 * weak fallback: on a freely-tradable item it is just a description-cache TTL
 * (minutes/hours out) and must NOT be mistaken for a trade hold – so we trust it
 * only when the item is actually non-tradable. Returns null when freely tradable.
 */
/**
 * Deterministic sentinel expiry for a trade-lock notice whose DATE could not be
 * parsed. Constant (NOT now+7d) so that stack() identity — keyed on the ISO expiry
 * (InventoryManager.stack ~:252) — and the displayed "locked until" stay stable
 * across refreshes instead of shifting every pass. Re-evaluated each refresh: if
 * Steam later serves a parseable date, the item picks it up. (B-5 / C22.)
 */
export const TRADE_LOCK_DATE_UNKNOWN = new Date('2099-01-01T00:00:00.000Z');

export function parseTradeLock(desc: RawDescription, allowCacheExpiration = false): Date | null {
  // 1) Authoritative: the "Tradable After …" / "Tradable/Marketable After …" notice
  //    Steam puts in owner_descriptions (multi-language note: matched leniently).
  const pools = [desc.owner_descriptions, desc.descriptions];
  for (const pool of pools) {
    if (!pool) continue;
    for (const entry of pool) {
      const v = entry.value ?? '';
      // The hold notice ("… Tradable/Marketable After Mon DD, YYYY (HH:MM:SS) GMT") can be
      // EMBEDDED after other text — in context 16 it follows "⇆ This item is trade-protected
      // …" — so we match the date pattern ANYWHERE. The old /(.+)$/ anchored to end-of-line
      // and silently missed every context-16 hold (they showed up as tradable). #context16
      // Three real-world phrasings: CS2 context-2 market holds say "Tradable/Marketable
      // After <Mon DD, YYYY>"; CS2 context-16 trade-protection says "… transferred UNTIL
      // <Mon DD, YYYY>"; TF2 holds say "Tradable After: <Weekday>, <Month DD, YYYY>" (e.g.
      // "Tradable After: Friday, June 19, 2026") — the optional "(?:[A-Za-z]{3,9},\s+)?"
      // skips that leading weekday so the date still binds to the month. Match either
      // keyword, date anywhere. (TF2 puts the notice in `descriptions`, not owner_descriptions
      // — parseTradeLock already scans both pools.)
      const m = /(?:tradable|marketable|protected)[^\n]*?\b(?:after|until)\b[^A-Za-z0-9]*(?:[A-Za-z]{3,9},\s+)?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})(?:[^A-Za-z0-9]*(\d{1,2}:\d{2}(?::\d{2})?))?/i.exec(v);
      if (m) {
        const parsed = parseSteamDate(`${m[1]}${m[2] ? ' ' + m[2] : ''} GMT`);
        if (parsed && parsed.getTime() > Date.now()) return parsed; // future hold → locked
        // Notice present but its date did not parse → fail SAFE: treat as locked (a 7-day
        // rolling placeholder, re-evaluated each refresh) rather than wrongly tradable (#34).
        if (!parsed) {
          logger.warn(`trade-lock notice present but date unparseable ("${v.slice(0, 60)}") – treating item as locked (date unknown)`);
          return new Date(TRADE_LOCK_DATE_UNKNOWN); // deterministic sentinel (B-5 / C22)
        }
        // parsed but in the past → expired hold; keep scanning the other notices.
      }
    }
  }

  // 2) Fallback: cache_expiration, but ONLY when the item is genuinely non-tradable
  //    (otherwise it's a cache TTL, not a hold → would falsely lock tradable items).
  if (allowCacheExpiration && desc.tradable === 0 && desc.cache_expiration) {
    const d = new Date(desc.cache_expiration);
    if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) return d;
  }
  return null;
}

/** Parses "Dec 25, 2025 (07:00:00) GMT" → Date. */
function parseSteamDate(raw: string): Date | null {
  // Normalize "(07:00:00)" → "07:00:00" so Date can parse it
  const cleaned = raw.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Steam embeds sticker info as HTML inside descriptions, e.g.:
 *   <img ...><img ...><br>Sticker: Crown (Foil), Titan (Holo)
 * We extract names from the "Sticker:" line and any image URLs present.
 */
function parseStickers(desc: RawDescription): Sticker[] | undefined {
  const html = desc.descriptions?.find(d => /sticker/i.test(d.value))?.value;
  if (!html) return undefined;

  const nameMatch = /Sticker:\s*([^<]+)/i.exec(html);
  if (!nameMatch) return undefined;

  const names = nameMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) return undefined;

  const imgUrls = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);

  return names.map((name, idx) => ({
    slot:      idx,
    stickerId: 0, // not exposed via the public inventory endpoint
    name,
    codename:  name.toLowerCase().replace(/\s+/g, '_'),
    imageUrl:  imgUrls[idx],
  }));
}

/** Replaces %assetid% / %owner_steamid% placeholders in an inspect action link. */
function buildInspectLink(desc: RawDescription, asset: RawAsset, steamId: string): string | undefined {
  const action = desc.actions?.find(a => /inspect/i.test(a.name) || a.link.includes('+csgo_econ_action_preview'));
  if (!action) return undefined;
  return action.link
    .replace('%assetid%', asset.assetid)
    .replace('%owner_steamid%', steamId);
}
