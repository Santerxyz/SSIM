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
    const timeRaw = Number(o.time);
    out.push({
      id,
      type,
      typeName:  type === 2 ? 'trade' : type === 3 ? 'market' : 'other',
      title:     String(o.title ?? o.headline ?? 'Confirmation'),
      receiving: String(o.receiving ?? ''),
      creator:   String(o.creator ?? o.creatorid ?? ''),
      iconUrl:   typeof o.icon === 'string' ? (o.icon as string) : '',
      timeMs:    Number.isFinite(timeRaw) && timeRaw > 0 ? (timeRaw > 1e12 ? timeRaw : timeRaw * 1000) : 0,
    });
  }
  // Deterministic: newest first, tie-break by id so the order is stable across fetches.
  out.sort((a, b) => (b.timeMs - a.timeMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
