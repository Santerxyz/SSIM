import { MoneyOpJournal } from './MoneyOpJournal';
import { dataDir } from '../utils/paths';

// ── W4_41 — GamePurchaseJournal: double-spend dedup for wallet-funded store purchases ──────
// A MoneyOpJournal on its own file (keyed by `${username}:${subId}`, op label 'game-purchase') so a
// corrupt/locked purchase journal can never degrade buy/send or wallet-redeem dedup — and vice-versa.
// Inherits the full never-throw / atomic / unreliable-gated / TTL-swept / S15-refusal contract
// verbatim; only the on-disk file differs.
//
// This matters more here than anywhere else in SSIM: the purchase path is the one money op that fires
// with NO human in the loop, over a whole fleet. begin() is written immediately before
// finalizetransaction — so a crash mid-charge, or a transport-ambiguous commit, leaves a LINGERING
// entry that refuses the re-fire until the operator has checked that account's Steam purchase history.
export class GamePurchaseJournal extends MoneyOpJournal {
  constructor() {
    super(dataDir('game-purchase-journal.json'));   // ttl(24h)/now/enabled inherit MoneyOpJournal defaults
  }
}

/** The op key for one account buying one package. Stable across restarts — that is the whole point. */
export function purchaseOpKey(username: string, subId: number): string {
  return `${username.toLowerCase()}:${subId}`;
}
