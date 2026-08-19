SSIM v1.5.0

+ SSIM is now free and open source under Apache-2.0. No licence key, no activation, no account. Download it, open it, use it. The source is at https://github.com/Santerxyz/SSIM

+ The licence check is gone entirely. SSIM no longer fingerprints your machine, holds a seat, or contacts any server of ours. Your existing licence files are simply ignored.

+ Updates now come from GitHub. They are still checked against a SHA-256 hash and an Ed25519 signature before anything is replaced, exactly as before.

+ Every release is built by GitHub Actions and published with a provenance attestation, so you can verify the file you downloaded was built from the published source.

+ New Activity tab in the sidebar. It shows every job running right now, with progress, runtime and an End task button.

+ The sidebar shows a live count of running jobs from any screen. Jobs keep running when you close their window, and several can run at once.

+ CSFloat sales are now grouped by buyer. Seven of the same skin is one row saying 7x, not seven rows.

+ Sales show floats, price per item, line total, buyer name, steamID, item count and age.

+ You can send sales by hand: one item, one buyer, a multi-select, or all of them. Auto-accept is no longer the only way to deliver.

+ Delivery runs show live progress, can be cancelled between sends, and mark anything already delivered so it can never go out twice.

+ Trade-up runs now list every failure reason with a count when they finish.

- Fixed the wrong unlock time on trade-locked items. Steam writes that note on its own Pacific clock, so an item unlocking at 11:00 showed over fourteen hours left.

- Fixed trade-up runs grinding through every contract when they were all failing the same way. It now stops and names the cause.
