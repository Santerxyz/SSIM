SSIM v1.5.1

+ Send items straight from the Environment Master. It was the one aggregated view that was read-only, so moving stock out of a whole environment meant first putting its accounts in a folder. Now it selects and sends (and mass-sells) exactly like the folder and global masters.

+ Freshly imported accounts show up in Batch Jobs immediately. The batch scope tree cached its account list for the lifetime of the window, so newly imported accounts stayed invisible there — and in the Distribute source picker — until a restart.

+ Switching an account between a proxy and the local IP no longer needs a restart. A logged-in session is pinned to the exit it logged in over, and jobs kept reusing those sessions after a rule change. They now notice the change and re-log-in on the next operation, with nothing interrupted mid-flight.

+ Distribute can include or exclude specific items. Both filters are searchable pickers built from the source pool you selected, so you choose from the items those accounts actually hold instead of having to remember how anything is spelled — type to narrow it down, click to add, click the × on a chip to drop it. You can still type a word of your own ("Karambit", "Souvenir") to cover a whole family at once. "Never" beats "only", and the preview shows how many items the filters held back and exactly what is left. Distribute also has its own CS2/TF2 switch now: it used to follow the Inventories tab's game toggle, which isn't shown on the Batch screen, so it could only ever distribute whichever game you happened to be looking at last.

+ Buying Prime no longer leaves items in the Steam cart. SSIM adds Prime to the account's real cart and only then learns from Steam whether the order will go through — and when it did not (a rejected order, a wallet that turned out to be short, a checkout error), the Prime line was left sitting there. The next run then saw a cart holding two Prime lines, was quoted double, and skipped the account as "not enough". Every abandoned attempt now takes its line back out, and a cart Steam refuses to release is reported on the account instead of being discovered a run later.

+ New "Check CS2 Prime ownership" batch job — the read-only twin of Buy CS2 Prime. Run it over a scope and the Buy panel shows how many accounts already have Prime, how many need it, and how many have not been checked. Nothing is charged, and an account whose licences could not be read is reported as exactly that, never as "needs Prime".
