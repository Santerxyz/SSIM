import type { CsFloatService } from './CsFloatService';
import { CsFloatError } from './CsFloatClient';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  CsFloatBulkService — many-at-once CSFloat listing operations.
//
//  The workspace could only ever act on one item per click (type a price, press List,
//  repeat), which is unusable against a real stall. This runs the same verified
//  single-item endpoints in a paced loop with live progress and cancel-after-current,
//  mirroring how CasketService/TradeUpService already model long jobs.
//
//  PACING: every request goes through CsFloatClient's per-API-key RateLimiter
//  (single-flight, ~1.5 req/s) and its 429 backoff, so a 200-item bulk list cannot
//  outrun the key's budget or starve an interactive tab sharing it. We therefore
//  await sequentially and add no pacing of our own — a second layer would just
//  make the same requests slower without making them safer.
//
//  PARTIAL FAILURE IS NORMAL and never fatal: one rejected item (already listed,
//  just traded away, price floor) must not abandon the other 199. Every failure is
//  recorded with the item it belongs to and surfaced; the loop carries on.
// ════════════════════════════════════════════════════════════════════════════

export type CsFloatBulkKind = 'list' | 'delist' | 'reprice';

export interface CsFloatBulkFailure {
  /** asset id (list) or listing id (delist/reprice) — whatever identifies the row in the UI. */
  ref:    string;
  name?:  string;
  error:  string;
}

export interface CsFloatBulkJob {
  running:      boolean;
  cancelling?:  boolean;
  cancelled?:   boolean;
  kind:         CsFloatBulkKind;
  username:     string;
  total:        number;
  done:         number;
  /** Confirmed-successful operations (CSFloat answered 2xx). */
  ok:           number;
  failed:       number;
  /** Item currently in flight, for the progress line. */
  current?:     string;
  failures:     CsFloatBulkFailure[];
  startedAt?:   string;
  finishedAt?:  string;
  /** Set only when the whole job aborted (not a per-item failure). */
  error?:       string;
  cancelRequested?: boolean;
}

export interface BulkListItem   { assetId: string; priceCents: number; name?: string }
export interface BulkRepriceItem { listingId: string; priceCents: number; name?: string }

/** Guard rails on any price we forward to CSFloat, matching the single-item routes. */
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 100_000_000;

const emptyJob = (): CsFloatBulkJob => ({
  running: false, kind: 'list', username: '', total: 0, done: 0, ok: 0, failed: 0, failures: [],
});

export class CsFloatBulkService {
  /** One bulk job at a time (same serialization as the storage-move and trade-up jobs). */
  private job: CsFloatBulkJob = emptyJob();

  constructor(private readonly csfloat: CsFloatService) {}

  status(): CsFloatBulkJob { return { ...this.job, failures: [...this.job.failures] }; }
  busy(): boolean { return this.job.running; }

  cancel(): CsFloatBulkJob {
    if (this.job.running) {
      this.job.cancelRequested = true;
      this.job.cancelling = true;
      logger.info('[csfloat] bulk job cancel requested');
    }
    return this.status();
  }

  /** Creates a buy-now listing for each item. Prices are validated up front so a malformed
   *  batch is refused whole, rather than half-listing at wrong prices and then erroring. */
  startList(username: string, items: BulkListItem[]): CsFloatBulkJob {
    const clean = this.validateStart(username, 'list', items, (i) => i.assetId, (i) => i.priceCents);
    return this.begin(username, 'list', clean.length, async (job) => {
      for (const it of clean) {
        if (job.cancelRequested) break;
        job.current = it.name || it.assetId;
        try {
          await this.csfloat.createListing(username, { asset_id: it.assetId, type: 'buy_now', price: it.priceCents });
          job.ok++;
        } catch (e) {
          job.failed++;
          job.failures.push({ ref: it.assetId, name: it.name, error: describe(e) });
        }
        job.done++;
      }
    });
  }

  /** Removes each listing from CSFloat. Reversible (re-list at will), so no extra gate. */
  startDelist(username: string, listingIds: string[], names: Record<string, string> = {}): CsFloatBulkJob {
    const ids = [...new Set((listingIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('no listings selected');
    return this.begin(username, 'delist', ids.length, async (job) => {
      for (const id of ids) {
        if (job.cancelRequested) break;
        job.current = names[id] || id;
        try { await this.csfloat.delist(username, id); job.ok++; }
        catch (e) { job.failed++; job.failures.push({ ref: id, name: names[id], error: describe(e) }); }
        job.done++;
      }
    });
  }

  /** Moves each listing to a new price (the undercut/repricing path). */
  startReprice(username: string, items: BulkRepriceItem[]): CsFloatBulkJob {
    const clean = this.validateStart(username, 'reprice', items, (i) => i.listingId, (i) => i.priceCents);
    return this.begin(username, 'reprice', clean.length, async (job) => {
      for (const it of clean) {
        if (job.cancelRequested) break;
        job.current = it.name || it.listingId;
        try { await this.csfloat.editPrice(username, it.listingId, it.priceCents); job.ok++; }
        catch (e) { job.failed++; job.failures.push({ ref: it.listingId, name: it.name, error: describe(e) }); }
        job.done++;
      }
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Shared up-front validation: refuse the whole batch on a malformed row rather than
   *  discovering it mid-run, by which point real listings already exist at real prices. */
  private validateStart<T>(
    username: string,
    kind: CsFloatBulkKind,
    items: T[],
    refOf: (i: T) => string,
    priceOf: (i: T) => number,
  ): Array<T & { priceCents: number }> {
    if (this.job.running) throw new Error('a CSFloat bulk operation is already running');
    if (!username) throw new Error('username is required');
    if (!Array.isArray(items) || items.length === 0) throw new Error('no items selected');
    const seen = new Set<string>();
    const out: Array<T & { priceCents: number }> = [];
    for (const raw of items) {
      const ref = String(refOf(raw) ?? '').trim();
      if (!ref) throw new Error(`every ${kind === 'list' ? 'item' : 'listing'} needs an id`);
      // A duplicate would double-list one asset / fight itself on a reprice — drop it, don't fail.
      if (seen.has(ref)) continue;
      seen.add(ref);
      const price = Math.round(Number(priceOf(raw)));
      if (!Number.isFinite(price) || price < MIN_PRICE_CENTS || price > MAX_PRICE_CENTS) {
        throw new Error(`invalid price for "${ref}" — must be between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS} cents`);
      }
      out.push({ ...raw, priceCents: price });
    }
    if (!out.length) throw new Error('no items selected');
    return out;
  }

  /** Opens the job, runs `body` detached, and finalizes exactly once however it ends. */
  private begin(username: string, kind: CsFloatBulkKind, total: number, body: (job: CsFloatBulkJob) => Promise<void>): CsFloatBulkJob {
    this.job = {
      running: true, cancelling: false, cancelled: false, cancelRequested: false,
      kind, username, total, done: 0, ok: 0, failed: 0, failures: [], startedAt: new Date().toISOString(),
    };
    const job = this.job; // bind this job so a late write can never land in the NEXT one
    // S33 shape: a fire-and-forget worker that rejects must still release the job, or `running`
    // latches true forever and every later start 409s until restart.
    void body(job)
      .catch((e) => {
        job.error = e instanceof Error ? e.message : String(e);
        logger.warn(`[csfloat] bulk ${kind} for ${username} aborted: ${job.error}`);
      })
      .finally(() => {
        job.running = false;
        job.cancelling = false;
        job.cancelled = job.cancelRequested === true;
        job.current = undefined;
        job.finishedAt = new Date().toISOString();
        logger.info(`[csfloat] bulk ${kind} for ${username}: ${job.ok} ok, ${job.failed} failed of ${job.total}`);
      });
    return this.status();
  }
}

/** CSFloat errors carry a useful message + status; anything else is stringified honestly. */
function describe(e: unknown): string {
  if (e instanceof CsFloatError) return e.status ? `${e.message} (HTTP ${e.status})` : e.message;
  return e instanceof Error ? e.message : String(e);
}
