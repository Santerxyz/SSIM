import { MoneyOpJournal } from './MoneyOpJournal';
import { dataDir } from '../utils/paths';

// ── W3_31 — WalletRedeemJournal: money-in dedup for Steam wallet-code redeems ──────
// A MoneyOpJournal on its own file (keyed by sha256(code), op label 'wallet-redeem') so a
// corrupt/locked wallet journal can never degrade buy/send dedup — and vice-versa. Inherits
// the full never-throw / atomic / unreliable-gated / TTL-swept / S15-refusal contract verbatim;
// only the on-disk file differs. A crash between begin() and resolve() leaves a lingering entry
// that refuses the re-fire (needs-verify) until the operator verifies on Steam and retries with force.
export class WalletRedeemJournal extends MoneyOpJournal {
  constructor() {
    super(dataDir('wallet-redeem-journal.json'));   // ttl(24h)/now/enabled inherit MoneyOpJournal defaults
  }
}
