SSIM v1.4.1

New:
- Proxy Rules: assign proxies by account, folder, environment, or globally — most-specific rule wins, no more editing one account at a time
- Batch Jobs: run fleet-wide actions from a single screen with unified live progress and history
- Item Distribution: automatically spread items across accounts up to a target value per account
- Wallet top-up: redeem Steam wallet codes and paysafecard balance directly in SSIM, with double-redeem protection
- Connection resilience: automatic per-proxy CM protocol fallback (TCP -> WebSocket) so more proxy providers connect reliably

Improved:
- Pricing no longer stalls for hours when Steam rate-limits price lookups; it now rides your logged-in sessions and backs off cleanly instead of grinding
- Mass-sell 2FA confirmations are batched into a single request per account
- The confirmations (SDA) panel now backs off gracefully when Steam rate-limits an account, instead of re-checking every minute (which kept the limit active)

Note: Steam had a platform-wide "too many requests" incident on July 9. If confirmations or market pricing look limited right after updating, that is Steam recovering on its side, not SSIM.
