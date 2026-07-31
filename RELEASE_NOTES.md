SSIM v1.4.4

- Storage units work again: depositing items reported "unconfirmed" for every item and
  crawled. Deposits are now confirmed correctly and finish roughly 30x faster.
- Trade-lock countdown no longer invents huge durations (a Storage Unit showing
  "222 days" was an already-expired note being read as next year).
- Sending items now runs 5 at a time instead of one, so mass sends finish much faster.
  The pacing that protects the receiving account is unchanged.
- Environment proxy set through a rule is now shown in the Environment tab instead of
  still reading "Local IP (no proxy)".
- Fixed the empty strip between the toolbar and the item table header when scrolling.

Note: automatic price fetching is still being investigated — this build adds the
logging needed to pin down the cause.
