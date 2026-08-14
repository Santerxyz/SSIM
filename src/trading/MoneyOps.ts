// ════════════════════════════════════════════════════════════════════════════
//  MoneyOps — a SHARED, cross-service concurrent-op guard for real money/asset
//  operations (trade-send, market-list, offer-accept, trade-up craft, casket
//  move). Each service already has its own
//  in-flight Set, but those only block a concurrent duplicate WITHIN one service —
//  a sell (MarketService) and a send (TradeService) of the same asset could still
//  run at once and both act on it. This shared registry blocks a concurrent op on
//  the same key across services. It is released the moment the op settles, so a
//  legitimate SEQUENTIAL repeat is never blocked (that would need client-side
//  idempotency keys, out of scope here). (D2 / INV-D2.)
//
//  Buy orders are market_hash_name-scoped — no assetId exists until the fill — so
//  the buy path cannot and does not participate.
//
//  Pure module state (no imports) → unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

const inFlight = new Set<string>();

/** Key for an asset-scoped money op.
 *  Deliberately not app/context-scoped: relies on Steam economy assetids being unique across
 *  apps in practice. Do not widen the key unless every claim site derives the extra fields
 *  identically for the same asset — mismatched derivation silently disables the cross-service
 *  match (keys stop colliding). Worst case of the flat key is a spurious cross-game 'busy'
 *  refusal, which is the safe direction. */
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
  /** Synchronous all-or-nothing claim over N keys. Returns false and claims NOTHING if any
   *  key is already held. Duplicates within `keys` never self-collide — the has-scan runs
   *  before any add. Use this (not a scan-then-forEach) so the check-and-act stays atomic. */
  claimAll(keys: string[]): boolean {
    if (keys.some((k) => inFlight.has(k))) return false;
    keys.forEach((k) => inFlight.add(k));
    return true;
  },
  /** Releases a claim (call in a finally once the op has settled). Releasing a key you did
   *  not claim silently drops another op's guard — only ever release keys your own
   *  claim/claimAll returned true for. */
  release(key: string): void {
    inFlight.delete(key);
  },
  /** Releases N claims (call in a finally once the op has settled). Same ownership warning as
   *  release: only ever release keys your own claim/claimAll returned true for. */
  releaseAll(keys: string[]): void {
    keys.forEach((k) => inFlight.delete(k));
  },
  /** True while `key` is claimed. */
  held(key: string): boolean {
    return inFlight.has(key);
  },
};
