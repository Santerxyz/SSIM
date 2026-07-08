// ════════════════════════════════════════════════════════════════════════════
//  confirmations — a PURE view-shaper for the canonical Steam mobile-confirmation
//  list. It consumes the SAME `community.getConfirmations(...)` output the trade/
//  market confirm path already uses (AccountTrader) — it is NOT a second source or
//  parser. Dedups by confirmation id and orders deterministically (newest first).
// ════════════════════════════════════════════════════════════════════════════

export interface ConfirmationView {
  /** Confirmation id — the handle `respond()` needs. */
  id:        string;
  /** Steam ConfirmationType (2 = trade, 3 = market listing). */
  type:      number;
  typeName:  'trade' | 'market' | 'other';
  title:     string;
  receiving: string;
  /** What the account gives away (trade) / the listing summary (market); '' when none. */
  sending:   string;
  /** Object id (trade-offer id / market-listing id) behind the confirmation. */
  creator:   string;
  iconUrl:   string;
  /** Confirmation creation time (ms epoch); 0 when unknown. */
  timeMs:    number;
}

/** Shape + dedup + order the raw confirmations from `community.getConfirmations`. */
export function shapeConfirmations(raw: unknown): ConfirmationView[] {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ConfirmationView[] = [];
  for (const c of arr) {
    const o = (c ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? '');
    if (!id || seen.has(id)) continue;                 // dedup by confirmation id
    seen.add(id);
    const type = Number(o.type) || 0;
    // Producer-faithful creation time. CConfirmation carries the numeric moment in
    // `timestamp` (Date) and an ISO STRING in `time`; raw getlist JSON may carry a
    // numeric `time`. 0 when unknown.
    let timeMs = 0;
    if (o.timestamp instanceof Date) {
      const t = o.timestamp.getTime();
      if (Number.isFinite(t) && t > 0) timeMs = t;
    } else if (typeof o.time === 'number') {
      const t = o.time;
      if (Number.isFinite(t) && t > 0) timeMs = t > 1e12 ? t : t * 1000;
    } else if (typeof o.time === 'string') {
      const p = Date.parse(o.time);
      if (Number.isFinite(p) && p > 0) timeMs = p;
    }
    out.push({
      id,
      type,
      typeName:  type === 2 ? 'trade' : type === 3 ? 'market' : 'other',
      // fallbacks tolerate the raw mobileconf getlist JSON shape (headline / creator_id)
      title:     String(o.title ?? o.headline ?? 'Confirmation'),
      receiving: String(o.receiving ?? ''),
      sending:   String(o.sending ?? ''),
      creator:   String(o.creator ?? o['creator_id'] ?? ''),
      iconUrl:   typeof o.icon === 'string' ? (o.icon as string) : '',
      timeMs,
    });
  }
  // Deterministic: newest first, tie-break by id so the order is stable across fetches.
  out.sort((a, b) => (b.timeMs - a.timeMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
