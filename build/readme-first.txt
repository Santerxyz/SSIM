==============================================================
  SSIM - Santer Steam Inventory Manager
  READ ME FIRST   -   Version 1.3.0
==============================================================

Thank you for choosing SSIM. This guide explains how to start
and what every part of the program does. Please read section 1
("Quick Start") before first use.


--------------------------------------------------------------
 0. WHAT IS SSIM?
--------------------------------------------------------------
SSIM is a local control center for managing many Steam accounts
at once: view inventories, track trade-locks, send/trade items,
sell on the Steam Community Market, and place buy orders (single
bot or a whole folder at once) - all from one dashboard in your
browser.

Everything runs LOCALLY on this PC. Nothing leaves your machine
except a single license check. Your account passwords and
.maFile secret keys are never uploaded anywhere.


--------------------------------------------------------------
 1. QUICK START
--------------------------------------------------------------
1) SSIM is a single program: SSIM.exe . Keep it in a folder where
   it can write - on first launch it creates "data", "Vault",
   "mafiles" and "runtime" folders next to itself.

2) Double-click  SSIM.exe .
   The SSIM window opens directly - no console, no separate
   browser tab. (Everything it needs is built in; you never run
   anything else yourself.)

3) First start = activation. Paste your license key when asked
   and click Activate, then set a Master Password for your vault.
   The license key is tied to THIS computer.

4) Add your bots (section 2) and click "Refresh" to pull their
   inventories.

To stop SSIM: close the SSIM window - that quits everything,
including the background service.


--------------------------------------------------------------
 2. ADDING YOUR ACCOUNTS (.maFiles)
--------------------------------------------------------------
- Drop your .maFile files into the "mafiles" folder that sits
  next to SSIM.exe.
- Optional: add an "accounts.txt" in the same folder with one
  "username:password" per line for bulk import.
- In the dashboard click "Import bots", pick the ones you want,
  and import.

Your secret keys (shared_secret / identity_secret) stay on this
PC and are only used locally to log in and confirm trades.


--------------------------------------------------------------
 3. HOW THE DASHBOARD IS ORGANIZED
--------------------------------------------------------------
ENVIRONMENTS
  The home screen shows "Environments" - think of them as farms
  or groups. Create one with "New environment". Each environment
  can have its own (rotating) proxy.

FOLDERS
  Inside an environment you can sort accounts into folders.

ACCOUNTS (left sidebar)
  Open an environment to see its accounts. Click one to load its
  inventory. Above the list you can:
   - Search accounts by name.
   - Quick-filter the list: All accounts / Has items / Empty
     inventory (find or hide empty bots in one click).

VIEW LEVELS
  - Account view ......... one bot's inventory
  - Folder Master ........ aggregated, sendable items of every
                           bot in a folder
  - Environment Master ... totals across one environment
  - Global Master ........ totals across ALL environments


--------------------------------------------------------------
 4. PROXIES
--------------------------------------------------------------
- Set a proxy per environment (used by all its accounts) or per
  account (overrides the environment proxy).
- Paste proxies in ANY common format - SSIM parses them all:
      host:port:user:pass
      host:port@user:pass
      user:pass:host:port
      user:pass@host:port
      http://user:pass@host:port    (or socks5://...)
  HTTP and SOCKS both work. No reformatting needed.
- "Test proxy" checks the exit IP, the COUNTRY and the latency,
  so you can confirm each proxy is alive and where it lands.
- Every account uses its OWN isolated connection - sessions are
  never mixed, so one account can never affect another.


--------------------------------------------------------------
 5. INVENTORY
--------------------------------------------------------------
- "Refresh" pulls the live inventory from Steam (owner view, so
  trade-locked items are detected).
- "Refresh all" refreshes every account.
- Toggle between CS2 and TF2 with the CS2 / TF2 switch
  (the TF2 view counts keys and is read-only).
- Item values come from the Steam Market (cached for speed).
- Change the display currency with the currency button.
- Search items with the search box; click any column header to
  sort.

SELECT ITEMS UNDER A VALUE
  In the toolbar, type a price (e.g. 1.50) into "Select under"
  and click Select - SSIM ticks every item worth less, ready to
  send or sell in one go. Perfect for clearing out cheap skins.

TRADE-LOCKED ITEMS
  Steam only reveals the lock date for items bought directly on
  the Market. For traded items, set the date yourself under
  Edit account -> "Trade-protected until"; SSIM then tracks it
  automatically on future trades.

VALUE HISTORY
  In the master views, each refresh adds a point to the value
  chart - item value and wallet balance over time, now plotted
  on the SAME money scale so you can compare them at a glance.


--------------------------------------------------------------
 6. SENDING / TRADING ITEMS
--------------------------------------------------------------
- Tick the items you want and click "Send selected items".
- Send to an internal account (environment -> folder ->
  recipient) or to an external trade link.
- The trade is sent AND auto-confirmed for you via 2FA.
- "Mass-send" moves items across many bots at once with a live
  progress bar.


--------------------------------------------------------------
 7. SELLING & BUYING ON THE MARKET
--------------------------------------------------------------
SELLING
- Select items and click "Sell on market".
- Pick a pricing strategy:
    * Lowest listing price ... sells quickly
    * 1 cent below lowest .... jumps to the front of the list
    * Custom net price ....... your fixed payout per item
- "Calculate prices & proceeds" shows the exact net amount you
  receive BEFORE you list anything.
- Listings are auto-confirmed via 2FA. Market sales are FINAL.
- Trade-locked items are rejected by Steam (this is expected).

BUYING (single bot)
- Click "Buy" in the toolbar to open the buy dialog.
- Pick the bot that buys & pays (searchable - just type its name).
- Choose the game (CS2/TF2) and type the item name; live Steam
  suggestions appear as you type - click one to fill it exactly.
- Set the quantity and price per item, or click "Market price"
  to auto-fill the current lowest offer.
- "Buy & confirm" places the order (auto-confirmed via 2FA).
  At/above the lowest offer it fills instantly; below, it rests
  until a seller matches your price.

MASS BUY (whole folder)
- In a folder's master view, start "Mass Buy across folder".
- Pick the game, search the item, and set a price per item.
- SSIM refreshes EVERY bot's wallet balance live first, then each
  bot buys as much as its balance allows at that price (in its
  own wallet currency). A progress bar and per-bot results show
  exactly how it went.


--------------------------------------------------------------
 7b. TRADE-UPS & STORAGE UNITS  (new in 1.2.0)
--------------------------------------------------------------
Open a single account (account view) to find two new buttons:

TRADE-UPS
  Click "Trade-Ups" -> "Get Trade-Ups" and SSIM scans this bot's
  skins for every profitable trade-up contract (10 inputs -> 1
  output), showing the inputs, each possible output with its
  probability, the cost, expected value and profit. It uses the
  REAL in-game float of each item for an accurate result. Pick
  the contracts you want and run them.
  WARNING: running a trade-up DESTROYS the 10 input items - it is
  irreversible. Test one cheap contract first. To disable trade-up
  execution entirely, set SSIM_GC_VERIFIED=0 before launching.

STORAGE UNITS
  Click "Storage" to manage a bot's storage units (caskets):
  pick a unit, then deposit items from the inventory into it or
  withdraw them back, with a live progress bar. Moves are
  reversible (you can always withdraw what you deposited).

Both features briefly connect this bot to the CS2 game
coordinator only while you use them, then disconnect.


--------------------------------------------------------------
 8. ACTIVE ORDERS
--------------------------------------------------------------
Switch to the "Active Orders" tab to see your pending Market
orders - both sell listings and resting buy orders - and cancel
any of them from one place.


--------------------------------------------------------------
 9. ACCOUNT ACTIVITY LOG
--------------------------------------------------------------
Open any account and click "Logs" to see that bot's recent
activity (logins, trades, market actions, errors) in a popup -
handy for checking what a specific account has been doing.


--------------------------------------------------------------
 10. UPDATES
--------------------------------------------------------------
SSIM keeps itself up to date: on start it checks for a newer
signed version and installs it automatically before launching.
Just keep using it - no manual download needed. The whole app
(window, dashboard and engine) ships INSIDE the single SSIM.exe,
so an update can never leave the interface out of sync with the
program again. (Updates replace SSIM.exe and it relaunches itself.)


--------------------------------------------------------------
 11. TROUBLESHOOTING
--------------------------------------------------------------
- The window doesn't open: install the Microsoft Edge WebView2
  Runtime (it ships with up-to-date Windows 10/11). Get it from
  https://developer.microsoft.com/microsoft-edge/webview2/
- A second SSIM instance is blocked ("SSIM is already running!") -
  the first window keeps running; just use that one.
- An account won't log in: check its password / .maFile and that
  its proxy works (Test proxy). Steam rate-limits rapid logins,
  so wait a moment and try again - SSIM keeps the others running.
- Activation says the device ID (HWID) is invalid after moving to
  a new PC: the license is tied to one machine. Contact support
  to free the seat.
- Closing the SSIM window quits SSIM completely (including the
  background service) - that is the normal way to stop it.


--------------------------------------------------------------
 SUPPORT
--------------------------------------------------------------
Website (all info, guides, contact):  https://ssim.dev
Questions or problems? Reach us here:  <ADD YOUR DISCORD / CONTACT>


==============================================================
 Enjoy SSIM. Happy farming!
==============================================================
