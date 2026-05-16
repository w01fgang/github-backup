---
created: 2026-05-16T02:53:26.145Z
title: Missing Phase-6 lib helpers break source detection
area: tooling
resolves_phase: 7
files:
  - droplet/github-backup.sh:101
  - droplet/github-backup.sh:103
  - scripts/bootstrap-droplet.ts:305
---

## Problem

`github-backup.sh:101-103` unconditionally sources:
```bash
source "${BACKUP_DIR}/lib/detect-account-type.sh"
source "${BACKUP_DIR}/lib/filter-repos.sh"
```
The upload logic in `bootstrap-droplet.ts:305-321` only creates `${BACKUP_DIR}/lib/` and copies files when a local `droplet/lib/` directory exists and contains `*.sh` files. No such directory or files are present in the repository.

Result: `source` fails, `set -e` aborts the entire backup run, and no repositories are mirrored.

## Solution

Create the two missing helper scripts under `droplet/lib/`:
- `detect-account-type.sh` — given a source slug, outputs "User" or "Organization" (with graceful default to "User").
- `filter-repos.sh` — implements the allow/deny glob semantics described in REPOS-01 / ROADMAP SC#4/SC#5.

Ensure `bootstrap-droplet.ts` uploads them and `bootstrap.sh` marks them executable. Add a pre-flight existence check so bootstrap fails loudly if required droplet artifacts are absent.
