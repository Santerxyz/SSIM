# ROLLBACK — restore the legacy frontend instantly

The live app frontend is `public/`. The immutable pre-redesign copy is `redesign/legacy_public/`.
If the new frontend is broken and you need the old, working UI back **right now**:

## Fastest (git — you are on branch `redesign/frontend-v2`)
The legacy frontend is intact on the `fix/reliability-remediation` branch (and in every commit before the cutover on this branch). To get the working app back:
```
git checkout fix/reliability-remediation   # the hardened v1.3.5 line, legacy frontend, all tests green
npm run build                              # refresh dist/ from that branch
start.bat                                  # runs the old, working UI
```
Nothing is lost — the redesign stays on `redesign/frontend-v2` to resume later.

## Manual (restore public/ in place, any branch)
```
rm -rf public
cp -r redesign/legacy_public public
npm run build
start.bat
```
`redesign/legacy_public/` is never edited during the redesign, so this always restores the exact pre-redesign UI.

## After a cutover you want to undo
If `public/` was replaced with the new frontend and you want the old one back without switching branches, use the Manual steps above. To also drop the new frontend commits, `git revert` the cutover commit (do not force-reset shared history).

Note: the backend (`src/`, dist/) is unchanged by the redesign, so rolling back the frontend never affects licensing, vault, trading, or data.
