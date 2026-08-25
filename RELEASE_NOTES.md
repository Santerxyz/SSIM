SSIM v1.5.3

+ Renaming and deleting an environment moved to Accounts, where environments are created. They are on the environment tiles and in the header once you are inside one. Inventories now only navigates into environments.
+ An environment can finally be deleted together with its accounts. It used to be refused unless you emptied it first. Because it is irreversible, it asks you to type DELETE and lists exactly which accounts go.
+ New "Sign out all devices" on each account — Steam's own account-wide session revocation. It ends every session everywhere, including SSIM's, which then signs back in by itself on the next use.
+ The background price fill is much faster on a proxy setup. It now spreads across your proxies instead of running everything through the first few sessions it found, so with a dozen exits it goes from roughly 50 to roughly 600 items per minute.
+ A rotating proxy is detected automatically and each of its sessions is treated as its own exit, so one rotating proxy is no longer throttled as if it were a single IP.

- Deleting an environment or an account no longer leaves proxy rules pointing at things that are gone.
- The Proxies tab refreshes after an environment or account is deleted, instead of showing rules the server has already removed.
- Deleting an account now drops its CSFloat client, so its API key no longer stays in memory.
