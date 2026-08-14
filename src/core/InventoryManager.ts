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
import { STEAM_BROWSER_UA, steamXhrHeadersFor } from '../network/steamHeaders';

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
 * Single-sourced so it stays consistent with the sec-ch-ua Client Hints (both Chrome 124).
 */
const DEFAULT_USER_AGENT = STEAM_BROWSER_UA;

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
          // Chromium fingerprint (Client Hints + Sec-Fetch + browser Accept-Encoding incl. brotli,
          // which axios decodes) so Steam's 2026-07 bot-check doesn't 429 the inventory read. UA-aware:
          // an account with a custom (non-Chrome-124) userAgent gets the Sec-Fetch/Accept set WITHOUT the
          // Chrome-124 Client Hints, so the UA and the hints never contradict. Spread first; the
          // endpoint-specific values below (XHR Accept, en-US, Referer) win on collision.
          ...steamXhrHeadersFor(userAgent),
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
      logger.error(`[${username}] inventory TRUNCATED at the ${MAX_INVENTORY_PAGES}-page cap (${assets.length} assets, total≈${totalCount}) – result is PARTIAL (truncated flag set; the cache guard keeps the fuller record — C12)`);
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
      logger.warn(`[${steamId}] parsed ${items.length} item(s) from ${assets.length} asset(s) – ${orphans} asset(s) had no matching description and were dropped (totals may under-count)`);
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
 * Deterministic sentinel expiry for a trade-lock notice whose DATE could not be
 * parsed. Constant (NOT now+7d) so that stack() identity — keyed on the ISO expiry
 * (InventoryManager.stack ~:252) — and the displayed "locked until" stay stable
 * across refreshes instead of shifting every pass. Re-evaluated each refresh: if
 * Steam later serves a parseable date, the item picks it up. (B-5 / C22.)
 */
export const TRADE_LOCK_DATE_UNKNOWN = new Date('2099-01-01T00:00:00.000Z');

/**
 * Plausibility horizon for a YEAR-LESS hold note (see the fallback in {@link extractHoldDate}).
 * Steam's longest hold is 15 days (trade protection / market hold; CS2's own trade lock is 7), so a
 * year-less date further out than this is never a real hold — it is an EXPIRED note rolled into next
 * year, or an incidental date in an item's flavour text. 30 days leaves generous headroom over Steam's
 * real 15-day maximum while still rejecting the multi-month phantoms.
 */
export const MAX_YEARLESS_HOLD_DAYS = 30;
/**
 * How far into the PAST a year-less hold date may sit and still be read as "this hold just lifted"
 * rather than rolled to next year. The note's clock is resolved on Steam's own timezone (see
 * {@link STEAM_TIME_ZONE}), so this no longer has to absorb an unknown offset — 24h now covers only
 * how long Steam keeps serving the note from its description cache after the hold ends, while
 * staying far short of the months-old notes the horizon guard exists to reject.
 */
export const YEARLESS_PAST_GRACE_MS = 24 * 3600 * 1000;
/**
 * How long a hold note stays authoritative AFTER the instant it states (see the elapsed-note branch
 * in {@link parseTradeLock}). Steam serves item descriptions from a cache, so the note survives the
 * hold it describes by a few minutes; 30 covers that lag and the note's rounding to the whole minute
 * without inventing the multi-hour countdown the end-of-day over-lock used to produce.
 */
export const STALE_HOLD_NOTE_MS = 30 * 60 * 1000;

/**
 * Resolves a trade-lock expiry from Steam's data. The AUTHORITATIVE source is the
 * per-owner "Tradable After <date>" notice (visible only on the OWNER view, which
 * is why the inventory fetch must be authenticated). `cache_expiration` is only a
 * weak fallback: on a freely-tradable item it is just a description-cache TTL
 * (minutes/hours out) and must NOT be mistaken for a trade hold – so we trust it
 * only when the item is actually non-tradable. Returns null when freely tradable.
 */
export function parseTradeLock(desc: RawDescription, allowCacheExpiration = false): Date | null {
  // 1) Authoritative: the "Tradable After …" / "Tradable/Marketable After …" notice
  //    Steam puts in owner_descriptions (multi-language note: matched leniently).
  const pools = [desc.owner_descriptions, desc.descriptions];
  // The fail-safe sentinel is DEFERRED, never returned from inside the loop. An item carries SEVERAL
  // notes, and a dateless one may sit before the one that holds the real expiry (Steam lists the
  // market-listing note first). Returning early on the first dateless note abandoned the scan — the
  // countdown was then replaced by "date unknown" purely because of note ORDER. (2026-07-10)
  let unreadableHold = '';
  /** A SHORT-FORM (year-less) hold whose stated instant has just elapsed — see the note below. */
  let elapsedShortForm: Date | null = null;
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
        // Notice present but its date did not parse → fail SAFE (#34): remember it, keep scanning.
        if (!parsed && !unreadableHold) unreadableHold = v;
        // parsed but in the past → expired hold; keep scanning the other notices.
      }
      // 1b) GLOBAL (language-INDEPENDENT) hold parsing. `owner_descriptions` come back in the
      //     ACCOUNT'S Steam language, NOT the l=english fetch param — so the English/month-name matcher
      //     above misses EVERY non-English farm (owner report 2026-07-08: a German note "⇆ … kann bis
      //     12.7.2026, 14:00:00 …" showed a bare "Locked", no countdown). Two facts make a keyword-free
      //     solution possible for ANY locale: (a) Steam prefixes trade-protection notes with the
      //     language-independent "⇆" marker (U+21C6); (b) the expiry in these auto-generated notes is a
      //     NUMERIC/ISO/CJK/month-name date in virtually every locale. So: treat the note as a candidate
      //     hold when it carries "⇆" OR the item is non-tradable, then extract the date FORMAT-agnostically.
      const hasMarker = v.includes('⇆');
      if (hasMarker || desc.tradable === 0) {
        const d = extractHoldDate(v);
        if (d && d.getTime() > Date.now()) return d; // future hold → locked, with a real countdown
        // A short-form note whose stated instant has already passed (see YEARLESS_PAST_GRACE_MS).
        // Remembered, NOT returned here: it only settles the item once we know no OTHER note carries
        // a genuinely future hold, which always wins. Resolved after the scan.
        if (d && !elapsedShortForm) elapsedShortForm = d;
        // "⇆" alone does NOT prove a trade hold. Steam stamps the SAME marker on the market-listing
        // note — "⇆ This item is listed on the Steam Community Market and cannot be consumed or
        // modified." — which carries no date and is not a hold at all. Treating it as one turned every
        // listed item into "Locked (date unknown)" (741 hits in one live log) and, worse, made a listed
        // item that IS trade-held lose its countdown, because this branch returned before the note with
        // the real date was reached. A genuine hold ALWAYS says WHEN: it contains a date (digits, after
        // digit/bidi normalization) or an explicit "after/until" phrasing. A marker note that states no
        // "when" cannot be a hold, so it contributes no lock date — `desc.tradable` still drives the
        // plain "Locked" badge, and isSellable() independently requires `tradable === true`. (2026-07-10)
        // `desc.tradable === 1` keeps the old fail-closed behaviour for the one case where dropping the
        // sentinel could newly matter: a marker note on an item Steam still calls tradable is
        // self-contradictory, so we keep locking it rather than let isSellable() wave it through.
        if (hasMarker && !d && !unreadableHold && (statesAWhen(v) || desc.tradable === 1)) unreadableHold = v;
      }
    }
  }
  // ── SHORT-FORM NOTE WHOSE INSTANT HAS ELAPSED ─────────────────────────────────────────────────
  // The short note names a clock time but no timezone; that clock is STEAM'S (Pacific — see
  // STEAM_TIME_ZONE), and extractHoldDate now resolves it as such. So reaching here means the hold
  // Steam stated has genuinely passed, while Steam is STILL serving the note.
  //
  // That is a narrow, real window: Steam caches item descriptions, so the note outlives the hold by
  // minutes. It is not a reason to invent a long countdown. The first pass at this case held the item
  // to the END of the named DAY, which is what produced the owner's "14 h, 39 min" on an item Steam
  // said unlocks at 11:00 — the over-lock was covering for the timezone error that is now fixed.
  //
  // So: stay locked for a SHORT, FIXED window past the stated instant (Steam's cache lag + the note's
  // rounding to the minute), then let the note go. The window is derived from the note, not from the
  // clock, so the expiry is stable across refreshes — stack() keys on it (~:252) and a sliding value
  // would re-shuffle every stack on every pass. Once it too has passed, the note carries no live
  // information and `tradable` alone decides, which is the same fail-safe every other path relies on.
  // A fully-elapsed note falls THROUGH rather than returning: another note on the same item may still
  // be an unreadable hold, and that one must keep its fail-closed sentinel.
  if (elapsedShortForm) {
    const settles = new Date(elapsedShortForm.getTime() + STALE_HOLD_NOTE_MS);
    if (settles.getTime() > Date.now()) return settles;
    logger.warn(`trade-lock note still present but its stated instant (${elapsedShortForm.toISOString()}) passed over ${Math.round(STALE_HOLD_NOTE_MS / 60000)} min ago — treating the note as stale; the item's own tradable flag now decides`);
  }
  if (unreadableHold) {
    // Log the FULL note (JSON.stringify exposes hidden bidi/zero-width chars + the trailing text), not a
    // truncated 80-char prefix — the old slice(0,80) cut off exactly where the date begins, so every prior
    // fix flew blind. This reveals the exact date FORMAT so extractHoldDate can be taught it. (2026-07-10)
    logger.warn(`trade-lock notice present but date unparseable (${JSON.stringify(unreadableHold.slice(0, 400))}) [len=${unreadableHold.length}] – treating item as locked (date unknown)`);
    return new Date(TRADE_LOCK_DATE_UNKNOWN); // deterministic sentinel (B-5 / C22)
  }

  // 2) Fallback: cache_expiration, but ONLY when the item is genuinely non-tradable
  //    (otherwise it's a cache TTL, not a hold → would falsely lock tradable items).
  if (allowCacheExpiration && desc.tradable === 0 && desc.cache_expiration) {
    const d = new Date(desc.cache_expiration);
    if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) return d;
  }
  return null;
}

/**
 * Does this note say WHEN a hold expires? A genuine trade-hold note always does — that is its entire
 * purpose: Steam auto-generates it with the expiry embedded, as a date in the account's locale (digits,
 * possibly Arabic-Indic) or, in English, behind an explicit "after"/"until". Steam's OTHER "⇆"-marked
 * note — "⇆ This item is listed on the Steam Community Market and cannot be consumed or modified." —
 * names no moment, in any language.
 *
 * So this is the language-independent test for "is a dateless ⇆ note actually a hold we must fail closed
 * on (#34), or not a hold at all?". Getting it wrong in the permissive direction cannot make a held item
 * look tradable: `desc.tradable` still drives the "Locked" badge and isSellable() requires
 * `tradable === true` before any money path touches the item.
 */
function statesAWhen(v: string): boolean {
  const n = normalizeDigitsAndBidi(v);
  if (/\d/.test(n)) return true;    // any digit ⇒ it names a moment (year / day / clock time)
  return /\b(?:tradable|marketable|protected)\b[^\n]*\b(?:after|until)\b/i.test(n);
}

/** Parses "Dec 25, 2025 (07:00:00) GMT" → Date. */
function parseSteamDate(raw: string): Date | null {
  // Normalize "(07:00:00)" → "07:00:00" so Date can parse it
  const cleaned = raw.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Locale plumbing for extractHoldDate ────────────────────────────────────────

/**
 * Arabic-Indic (٠-٩) and Extended/Persian (۰-۹) digits → ASCII, and strip the invisible
 * bidi-control marks (LRM/RLM/ALM/embedding/isolate) Arabic/Hebrew text embeds between
 * tokens — they sit INSIDE date strings and break `\b`/adjacency in every regex below.
 */
function normalizeDigitsAndBidi(s: string): string {
  return s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[‎‏؜‪-‮⁦-⁩]/g, '');
}

/**
 * Month-word → month-number map for EVERY Steam storefront locale, built from the ICU data
 * Node already ships (full-icu) — no hand-written keyword table (the 8254d12 regression was
 * exactly a hand-coverage gap: worded months in non-Latin scripts — Arabic "يوليو", Russian
 * genitive "июля", Greek "Ιουλίου" — parsed by nothing). `formatToParts` with day+month+year
 * yields the IN-CONTEXT (genitive where the language inflects) form, i.e. the exact token
 * Steam's localized note contains. Tokens that mean different months in different locales
 * (or connector words) are dropped as ambiguous — a lookup miss just means "not a month",
 * so ambiguity degrades to the old behavior, never to a wrong date.
 */
const STEAM_INTL_LOCALES = [
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'es-419', 'fi', 'fr', 'hu', 'id', 'it',
  'ja', 'ko', 'nl', 'nb', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'vi',
  'zh-CN', 'zh-TW',
];
let MONTH_WORDS: Map<string, number> | null = null;
function monthWordKey(word: string): string { return word.toLowerCase().replace(/\.$/, ''); }
function monthWords(): Map<string, number> {
  if (MONTH_WORDS) return MONTH_WORDS;
  const map = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const loc of STEAM_INTL_LOCALES) {
    for (const width of ['long', 'short'] as const) {
      let fmt: Intl.DateTimeFormat;
      try {
        fmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: width, year: 'numeric', calendar: 'gregory' });
      } catch { continue; } // unknown locale on a slim ICU build → skip; others still cover
      for (let mo = 1; mo <= 12; mo++) {
        const word = fmt.formatToParts(new Date(Date.UTC(2026, mo - 1, 15))).find((p) => p.type === 'month')?.value;
        if (!word || /\d/.test(word)) continue; // numeric-month locales (vi "tháng 7") have no word to map
        const k = monthWordKey(normalizeDigitsAndBidi(word));
        if (!k) continue;
        const prev = map.get(k);
        if (prev !== undefined && prev !== mo) { ambiguous.add(k); continue; }
        map.set(k, mo);
      }
    }
  }
  for (const k of ambiguous) map.delete(k);
  MONTH_WORDS = map;
  return map;
}

/** Thai storefront years can be Buddhist Era (2569 = 2026 CE); map the BE range for 2000-2100 CE. */
function normalizeYear(y: number): number { return y >= 2543 && y <= 2643 ? y - 543 : y; }

// ── Steam's clock ──────────────────────────────────────────────────────────────

/**
 * Valve formats its server-side timestamps in PACIFIC time — the storefront, the market, and the
 * trade-protection notice all share that clock. The notice never states a zone, so the clock in
 * "… until 12 Aug @ 4:00am" is Pacific, NOT ours, and reading it as local time is what put the
 * unlock hours off. Measured twice on the owner's fleet, both at exactly the PDT offset (-7):
 *   • note "11 Aug @ 12:00pm"  ⇄  the same item's Steam tooltip "11/08/2026, 19:00:00"
 *   • note "12 Aug @ 4:00am"   ⇄  the same item's Steam tooltip "12/08/2026, 11:00:00"
 * An IANA zone (not a fixed -7) so the PST/PDT switch is handled for free.
 */
export const STEAM_TIME_ZONE = 'America/Los_Angeles';

/** Formatter used to read an instant's Pacific wall clock. Null if this ICU build lacks the zone. */
const steamZoneFmt: Intl.DateTimeFormat | null = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: STEAM_TIME_ZONE, hourCycle: 'h23', calendar: 'gregory',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return null; } // slim ICU → steamWallClock falls back to local (the pre-fix behaviour)
})();

/** How far Pacific time sits from UTC at `atMs`, in ms (negative — e.g. -7h in PDT). */
function steamZoneOffsetMs(atMs: number): number {
  const parts = steamZoneFmt!.formatToParts(new Date(atMs));
  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second')) - atMs;
}

/**
 * A wall clock READ IN STEAM'S TIMEZONE → the real instant it names.
 *
 * The offset depends on the instant we are solving for, so it is applied and then re-checked: the
 * first guess can land on the far side of a DST boundary, and the second pass settles it. On the
 * two ambiguous hours a DST switch creates, either reading is at most an hour out — irrelevant to
 * a hold measured in days, and the item stays locked either way.
 */
export function steamWallClock(y: number, mo: number, d: number, hh: number, mi: number, ss = 0): number {
  const naive = Date.UTC(y, mo - 1, d, hh, mi, ss);
  if (!steamZoneFmt) return new Date(y, mo - 1, d, hh, mi, ss).getTime(); // no zone data → local
  const first = naive - steamZoneOffsetMs(naive);
  const settled = naive - steamZoneOffsetMs(first);
  return settled;
}

/**
 * Language-INDEPENDENT trade-hold date extraction (owner request 2026-07-08: "something global").
 * Steam localises the hold note into the account's language, so keyword parsing does not scale to
 * ~28 locales. Scan the note for every date shape Steam emits — numeric (any component order),
 * CJK/Hangul, and worded-month in ANY Steam locale via the ICU-built month map — and return the
 * EARLIEST FUTURE one (the hold expiry). Only called once a note is already known to be a hold
 * (the "⇆" marker or a non-tradable item), so a stray date cannot false-lock a tradable item.
 * A note that STILL doesn't parse falls back to the caller's locked-date-unknown sentinel — that
 * fail-safe is correct; the frontend renders the sentinel as "date unknown", never as a countdown.
 *
 * TIMEZONE: localized numeric/CJK notes carry no zone, so those instants are built in the running
 * host's local zone (a single-operator farm's host ≈ its accounts' zone; any mismatch is at most a
 * TZ offset on a days-long countdown — the goal is a countdown instead of a bare "Locked"). The
 * English month-name form keeps its explicit "… GMT" (Steam states GMT there).
 */
export function extractHoldDate(rawText: string): Date | null {
  const text = normalizeDigitsAndBidi(rawText)
    // Strip English ordinal suffixes so "July 17th, 2026" / "17th July 2026" / "the 17th of July 2026"
    // still bind their day to the month (the worded-month branches below expect a bare "17"). Scoped to
    // en — other Steam locales don't use st/nd/rd/th, so this can never corrupt a non-English date. This
    // is the most likely shape that defeats the otherwise-comprehensive battery on the trade-protection note.
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1');
  const cand: number[] = [];
  const push = (yRaw: number, mo: number, d: number, hh = 0, mi = 0, ss = 0): void => {
    const y = normalizeYear(yRaw);
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return; // reject garbage triples
    const t = new Date(y, mo - 1, d, hh, mi, ss).getTime();
    if (!Number.isNaN(t)) cand.push(t);
  };
  const T = '(?:[\\sT,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?'; // optional " 14:00:00" / "T14:00"
  let m: RegExpExecArray | null;
  // ISO  YYYY-MM-DD
  const iso = new RegExp(`(\\d{4})-(\\d{1,2})-(\\d{1,2})${T}`, 'g');
  while ((m = iso.exec(text))) push(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Year-first numeric  YYYY/M/D · YYYY.M.D  (ja/zh "2026/07/16", hu "2026. 07. 16.")
  const yf = new RegExp(`(\\d{4})\\s*[./]\\s*(\\d{1,2})\\s*[./]\\s*(\\d{1,2})${T}`, 'g');
  while ((m = yf.exec(text))) push(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // CJK  YYYY年MM月DD日 (zh/ja) and Hangul  YYYY년 MM월 DD일 (ko)
  const cjk = new RegExp(`(\\d{4})\\s*[\\u5e74\\ub144]\\s*(\\d{1,2})\\s*[\\u6708\\uc6d4]\\s*(\\d{1,2})\\s*[\\u65e5\\uc77c]${T}`, 'g');
  while ((m = cjk.exec(text))) push(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Dotted  D.M.YYYY  (de / most of EU)
  const dot = new RegExp(`\\b(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${T}`, 'g');
  while ((m = dot.exec(text))) push(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Slashed  D/M/YYYY or M/D/YYYY — disambiguate by the >12 component; ambiguous → D/M (global default)
  const sl = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{4})${T}`, 'g');
  while ((m = sl.exec(text))) {
    const a = +m[1], b = +m[2], y = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
    if (a > 12 && b <= 12) push(y, b, a, hh, mi, ss);        // first >12 ⇒ it's the day → D/M
    else if (b > 12 && a <= 12) push(y, a, b, hh, mi, ss);   // second >12 ⇒ day → M/D
    else push(y, b, a, hh, mi, ss);                          // both ≤12 → D/M (most common worldwide)
  }
  // Vietnamese numeric-word month  "16 tháng 7, 2026"
  const vi = new RegExp(`(\\d{1,2})\\s+th[áa]ng\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})${T}`, 'gi');
  while ((m = vi.exec(text))) push(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Worded month, ANY Steam locale (ICU map): "16 Ιουλίου 2026" / "16 يوليو 2026" / "16 июля 2026 г."
  // Day-first ("16 de julio de 2026") and month-first ("July 16, 2026") shapes; the month-word
  // lookup is the gate, so an unknown word simply doesn't match — no false positives.
  const dayFirst = new RegExp(`(\\d{1,2})\\.?(?:\\s+de|\\s+of)?\\s+([\\p{L}\\p{M}]{2,20})\\.?(?:\\s+de|\\s+of)?\\s+(\\d{4})${T}`, 'gu');
  while ((m = dayFirst.exec(text))) {
    const mo = monthWords().get(monthWordKey(m[2]));
    if (mo) push(+m[3], mo, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  const monthFirst = new RegExp(`([\\p{L}\\p{M}]{2,20})\\.?\\s+(\\d{1,2})\\s*[,،]?\\s*(\\d{4})${T}`, 'gu');
  while ((m = monthFirst.exec(text))) {
    const mo = monthWords().get(monthWordKey(m[1]));
    if (mo) push(+m[3], mo, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  // Year-first worded (hu "2026. július 16.")
  const yearFirstWord = new RegExp(`(\\d{4})\\.?\\s+([\\p{L}\\p{M}]{2,20})\\.?\\s+(\\d{1,2})${T}`, 'gu');
  while ((m = yearFirstWord.exec(text))) {
    const mo = monthWords().get(monthWordKey(m[2]));
    if (mo) push(+m[1], mo, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  // English / month-name  "Mon DD, YYYY (HH:MM:SS) GMT"  (kept explicit-GMT via parseSteamDate)
  const mon = /(?:[A-Za-z]{3,9},\s+)?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})(?:[^A-Za-z0-9]*(\d{1,2}:\d{2}(?::\d{2})?))?/g;
  while ((m = mon.exec(text))) { const d = parseSteamDate(`${m[1]}${m[2] ? ' ' + m[2] : ''} GMT`); if (d) cand.push(d.getTime()); }

  const now = Date.now();
  const future = cand.filter(t => t > now).sort((a, b) => a - b);
  if (future.length) return new Date(future[0]);

  // ── FALLBACK: Steam's trade-protection notice uses a SHORT, YEAR-LESS form ──────────────────────
  // The widened log (2026-07-11) revealed the real format that had shown "date unknown": e.g.
  //   "⇆ This item is trade-protected and cannot be consumed, modified, or transferred until 17 Jul @ 2:00pm"
  // — day-first, NO YEAR, 12-hour time. Every branch above needs a 4-digit year, so none matched. This
  // fallback runs ONLY when nothing year-bearing parsed, so it can never override a real dated note. The
  // year is inferred as the nearest FUTURE occurrence (a trade hold is only days out): push both this-year
  // and next-year and let the future-filter pick. No timezone in the note → local (see § TIMEZONE above).
  const to24 = (h: number, ap?: string): number => {
    if (!ap) return h;                                 // already 24-hour
    return /p/i.test(ap) ? (h === 12 ? 12 : h + 12)    // pm: 12→12, else +12
                         : (h === 12 ? 0 : h);          // am: 12→0
  };
  const yNow = new Date(now).getFullYear();
  // Year-less candidates are kept in their OWN pool, never pushed into `cand`. They are guesses (the year
  // is inferred, not stated), so they must clear the horizon check below — a year-BEARING date states its
  // year and is trusted as-is.
  const ncand: number[] = [];
  const pushNoYear = (mo: number, d: number, hh: number, mi: number): void => {
    for (const y of [yNow, yNow + 1]) {                 // Dec→Jan notes need the roll-over; horizon bounds it
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return; // reject garbage triples (mirrors `push`)
      // STEAM'S CLOCK, not ours (see STEAM_TIME_ZONE). This is the ONLY note shape Valve formats
      // server-side with no zone attached, so it is the only one that has to be re-based; the
      // year-bearing branches above keep their own reading (explicit GMT, or the localized numeric
      // form that Steam renders in the viewer's own zone).
      const t = steamWallClock(y, mo, d, hh, mi);
      if (!Number.isNaN(t)) ncand.push(t);
    }
  };
  // day-first  "17 Jul @ 2:00pm" / "17 July @ 14:00"
  const nyDay = /\b(\d{1,2})\s+([\p{L}\p{M}]{2,20})\.?\s*(?:@\s*)?(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/giu;
  while ((m = nyDay.exec(text))) { const mo = monthWords().get(monthWordKey(m[2])); if (mo) pushNoYear(mo, +m[1], to24(+m[3], m[5]), +m[4]); }
  // month-first  "Jul 17 @ 2:00pm"
  const nyMon = /\b([\p{L}\p{M}]{2,20})\.?\s+(\d{1,2})\s*(?:@\s*)?(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/giu;
  while ((m = nyMon.exec(text))) { const mo = monthWords().get(monthWordKey(m[1])); if (mo) pushNoYear(mo, +m[2], to24(+m[3], m[5]), +m[4]); }

  // HORIZON GUARD (2026-07-31 — owner bug: "Storage Unit tradelocked for 222 days").
  // A year-less note whose date has ALREADY PASSED this year (an EXPIRED hold, e.g. "11 Mar @ 2:00pm" read
  // in July) was rolled to yNow+1 by the future-filter and surfaced as a ~222-day phantom lock. Steam's
  // longest hold is 15 days (trade protection / market hold; CS2's trade lock is 7), so a year-less
  // candidate beyond MAX_YEARLESS_HOLD_DAYS cannot be a real hold — it is either an expired note or an
  // incidental date in flavour text (this fallback also runs on every non-tradable item's descriptions,
  // e.g. Storage Units). Reject it and let `desc.tradable` drive the plain "not tradable" state instead of
  // inventing a countdown. Genuine Dec→Jan roll-overs are days out, so they still pass.
  const horizon = now + MAX_YEARLESS_HOLD_DAYS * 86_400_000;
  const nfuture = ncand.filter(t => t > now && t <= horizon).sort((a, b) => a - b);
  if (nfuture.length) return new Date(nfuture[0]);

  // RELEASE-DAY GRACE (2026-08-11 — owner: "at a specific date it will start saying unknown, mostly
  // if it reached the same day of the release").
  //
  // On the day a hold lifts, Steam's short note names only a clock time — "…until 11 Aug @ 12:00pm".
  // Once that time passes LOCALLY the this-year candidate is no longer `> now`, so the only survivor
  // was the yNow+1 roll-over, which the horizon guard above then (correctly) rejected — leaving null
  // and the "date unparseable" warning, on a note whose date we had in fact read perfectly.
  //
  // A year-less date a few hours in the past is overwhelmingly "this hold is lifting right about now"
  // — Steam's short form only appears near expiry, and its clock is not necessarily in our timezone —
  // never "this hold expires twelve months from now". So accept the RECENT past and report that date.
  // It is a real date Steam gave us, so the item gets a truthful timestamp instead of "unknown"; it is
  // in the past, so nothing treats it as a live lock, and `tradable` alone keeps gating the money
  // paths (isSellable requires tradable === true regardless of this date).
  //
  // The 222-day phantom lock this guard was built for is untouched: a note months in the past falls
  // outside the grace AND its roll-over stays beyond the horizon, so it still resolves to null.
  const recent = ncand.filter(t => t <= now && t >= now - YEARLESS_PAST_GRACE_MS).sort((a, b) => b - a);
  return recent.length ? new Date(recent[0]) : null;
}

/**
 * Steam embeds sticker info as HTML inside descriptions, e.g.:
 *   <img ...><img ...><br>Sticker: Crown (Foil), Titan (Holo)
 * We extract names from the "Sticker:" line and any image URLs present.
 */
export function parseStickers(desc: RawDescription): Sticker[] | undefined {
  const html = desc.descriptions?.find(d => /sticker/i.test(d.value))?.value;
  if (!html) return undefined;

  const nameMatch = /Sticker:\s*([^<]+)/i.exec(html);
  if (!nameMatch) return undefined;

  const names = nameMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) return undefined;

  const imgUrls = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);

  // A real CS2 sticker name can contain commas (e.g. "Don't Worry, I'm Pro"), so the
  // comma split over-produces fragments. The <img> count in the same fragment is the
  // authoritative sticker count: greedily re-join the right-most fragments until the
  // counts agree (a right-greedy merge picks one plausible grouping — it guarantees the
  // correct count, not a perfect split when several names each carry commas).
  if (imgUrls.length > 0 && names.length > imgUrls.length) {
    while (names.length > imgUrls.length) {
      const tail = names.pop()!;
      names[names.length - 1] = `${names[names.length - 1]}, ${tail}`;
    }
  }

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
