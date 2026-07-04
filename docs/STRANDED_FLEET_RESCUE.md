# STRANDED_FLEET_RESCUE.md — manual rescue for clients that can't auto-update

## Why this is needed

Some machines are pinned on an old SSIM version and **cannot auto-update**, because the update's
anti-brick self-test runs inside the OLD client's updater and fails deterministically on that machine —
and the fix for the failure ships *inside the very update it refuses* (`UPDATE_RELIABILITY.md`). No
server publish can reach past that valve. The only remedy is a **one-file manual reinstall**: replace the
exe on disk directly. This bypasses the old self-test entirely (the new exe simply runs; its self-test
only ever gates *future* auto-updates, and v1.3.5 makes those pass).

**Your data is safe.** Accounts, the vault, license, inventories, and logs live in `data\` / `Vault\` /
`logs\` **next to** the exe — NOT inside it. Replacing the exe keeps all of it.

---

## Single-exe install (current fleet) — the normal case

1. **Download** the latest `SSIM.exe` (the owner posts the current link — it is the same file the updater
   would have fetched, i.e. the `url` in `GET /version`).
2. **Fully close SSIM** — close the window; if unsure, end any `SSIM.exe` / `ssim-backend.exe` in Task
   Manager. The exe can't be replaced while it is running.
3. **Find your install folder** — the folder that contains the current `SSIM.exe` (alongside `data\`,
   `Vault\`, `logs\`). If you launch from a shortcut: right-click it → *Open file location*.
4. **Replace the exe** — copy the downloaded `SSIM.exe` **over** the old one (overwrite / *Replace the
   file in the destination*). Do NOT delete `data\` or `Vault\`.
5. **Relaunch** `SSIM.exe`. First launch re-extracts its backend (a one-time ~170 MB write → it may take
   a minute) and comes up on the new version. Confirm the version in the app's footer.

That's it — the machine is now current and will auto-update normally from here.

## Two-file install (older layout) — only if you have a separate `ssim-backend.exe` next to `SSIM.exe`

Some early installs are two files. Same idea:
1. Download BOTH the new `SSIM.exe` and `ssim-backend.exe` (owner provides), close SSIM.
2. In the install folder, overwrite BOTH exes with the new ones (keep `data\` / `Vault\`).
3. Relaunch `SSIM.exe`. (The newer single-exe build makes `ssim-backend.exe` redundant and cleans it up
   on its own after this.)

## If it still won't start

- Make sure SSIM was fully closed before replacing (a running exe silently blocks the overwrite).
- Check `logs\shell.log` and `logs\error.log` in the install folder for the first error, and send those
  + the version you came from to the owner.
- You will NOT lose data by re-downloading and replacing again.

---

## Discord announcement (copy-paste; fill in the link)

> 🔧 **SSIM manual update — 2 minutes, your data is safe**
>
> A few of you are stuck on an older version that can't update itself. Quick one-time fix:
>
> 1. Download the latest SSIM here: **<LINK>**
> 2. **Fully close SSIM** (close the window; check Task Manager for `SSIM.exe` if unsure).
> 3. Open your SSIM folder (the one with `SSIM.exe` + a `data` folder — right-click your shortcut →
>    *Open file location*).
> 4. **Copy the downloaded `SSIM.exe` over the old one** (overwrite). ⚠️ Don't touch the `data` or `Vault`
>    folders — that's your accounts/vault and it stays put.
> 5. Reopen SSIM. First start takes a minute (it unpacks itself), then you're on the latest version and
>    updates work automatically again.
>
> Your accounts, vault and settings are all kept — this only swaps the program file. Ping here if
> anything looks off and we'll sort it. 🙌
