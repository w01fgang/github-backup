---
created: 2026-05-16T02:53:26.145Z
title: Missing sync-one-repo.sh causes backup failure
area: tooling
files:
  - scripts/bootstrap-droplet.ts:289
  - droplet/bootstrap.sh:155
  - droplet/github-backup.sh:280
---

## Problem

`github-backup.sh:280` unconditionally invokes `${BACKUP_DIR}/sync-one-repo.sh "${SOURCE}" "${OWNER}" "${NAME}"` for every repository. The bootstrap flow in `bootstrap-droplet.ts:289-294` only uploads files matching `/\.(sh|js|template|service)$/` from the local `droplet/` directory, and `bootstrap.sh:155` does `chmod +x sync-one-repo.sh`. The file `sync-one-repo.sh` does not exist in the repository.

Result: bootstrap succeeds, but the first backup run fails with "command not found", leaving all mirrors unpopulated.

## Solution

Create `droplet/sync-one-repo.sh` implementing the per-repo clone/update logic that `github-backup.sh` expects (respecting the Phase-3 D-15 contract and per-repo flock on fd 8). Ensure it is executable and uploaded by the existing bootstrap machinery. Add a manifest check in `bootstrap-droplet.ts` so missing required droplet files fail fast before SSH.

TBD: exact implementation details of sync-one-repo.sh (extract from prior planning docs if present).
