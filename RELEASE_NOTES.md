SSIM v1.4.5

+ Added native currency support to the Market. Price fetching, sell listings and buy orders now all use the account's OWN Steam wallet currency (PLN, RUB, USD, JPY, ...) instead of Euro. Non-Euro accounts can sell again.

- Fixed non-Euro accounts being blocked from selling with "wallet currency X is not EUR".
- Fixed a price reading bug that could read a price 100x too high on currencies without cents (JPY, KRW, IDR, HUF, CLP, VND).
- Fixed the "No items." message showing above the Items / Active Orders tabs instead of below them.
