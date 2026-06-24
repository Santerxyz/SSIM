// ════════════════════════════════════════════════════════════════════════════
//  MoneyOps — a SHARED, cross-service concurrent-op guard for real money/asset
//  operations (trade-send, market-list, buy). Each service already has its OWN
//  in-flight Set, but those only block a concurrent duplicate WITHIN one service —
//  a sell (MarketService) and a send (TradeService) of the SAME asset could still
//  run at once and both act on it. This shared registry blocks a concurrent op on
//  the same key across services. It is released the moment the op settles, so a
//  legitimate SEQUENTIAL repeat is never blocked (that would need client-side
//  idempotency keys, out of scope here). (D2 / INV-D2.)
//
//  Pure module state (no imports) → unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

const inFlight = new Set<string>();

/** Key for an asset-scoped money op. */
export function assetKey(username: string, assetId: string): string {
  return `${username.toLowerCase()}:${assetId}`;
}

export const MoneyOps = {
  /** Claims `key` for a money op. Returns false if another op already holds it. */
  claim(key: string): boolean {
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    return true;
  },
  /** Releases a claim (call in a finally once the op has settled). */
  release(key: string): void {
    inFlight.delete(key);
  },
  /** True while `key` is claimed. */
  held(key: string): boolean {
    return inFlight.has(key);
  },
};
