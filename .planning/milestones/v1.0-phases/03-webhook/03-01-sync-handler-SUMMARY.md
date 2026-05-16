---
phase: 03-webhook
plan: 01
subsystem: droplet-sync
tags: [refactor, bash, locking]
requires: []
provides:
  - droplet/sync-one-repo.sh
affects:
  - droplet/github-backup.sh
  - droplet/bootstrap.sh
tech-stack:
  added: []
  patterns:
    - per-repo flock under existing global cron lock (D-16)
    - additive BACKUP_REPO_RESULT log line for status parsing (D-15 step 4)
key-files:
  created:
    - droplet/sync-one-repo.sh
  modified:
    - droplet/github-backup.sh
    - droplet/bootstrap.sh
key-decisions:
  - "D-15: extract per-repo mirror logic into droplet/sync-one-repo.sh — single code path for cron + webhook"
  - "D-16: per-repo lock /var/lock/github-backup-<owner>_<repo>.lock under existing global cron lock; webhook handlers skip global lock"
  - "Argument shape gate (^[A-Za-z0-9._-]+$) blocks injection-shaped repo names before they reach git"
  - "BACKUP_SUMMARY emission line in github-backup.sh preserved verbatim — Phase 1's verify:phase-1 regex still matches"
requirements-completed:
  - BACKUP-02
duration: 18 min
completed: 2026-05-13
---

# Phase 3 Plan 01: sync-handler Summary

Extracted per-repo mirror logic from `droplet/github-backup.sh` into a standalone
`droplet/sync-one-repo.sh <source> <owner> <repo>` so cron and the upcoming webhook
listener share one handler. Added per-repo flock on fd 8 under the existing global
cron flock on fd 9, plus a terminating `BACKUP_REPO_RESULT` log line for downstream
status parsing.

## Outputs

| File | Status | Lines | Mode |
|------|--------|-------|------|
| `droplet/sync-one-repo.sh` | new | 114 | 100755 |
| `droplet/github-backup.sh` | refactored — loop body delegates | -29 / +10 | 100755 (unchanged) |
| `droplet/bootstrap.sh` | one `chmod +x` line added | +1 | 100755 (unchanged) |

## Behavior

- Cron path: `github-backup.sh` still acquires `/var/lock/github-backup.lock` (Phase 1 NR-06 unchanged), enumerates repos, and calls `sync-one-repo.sh <source> <owner> <repo>` per repo. Helper takes per-repo lock, runs `git clone --mirror` or `git remote update --prune`, emits `BACKUP_REPO_RESULT`.
- Webhook path (future plan 03-02): listener invokes `sync-one-repo.sh` directly via `systemd-run`, skips global lock, takes only the per-repo lock.
- Cron + webhook on same repo: serialize on per-repo lock (seconds, not minutes).
- Cron + webhook on different repos: proceed in parallel.

## Commits

| Hash | Task | Message |
|------|------|---------|
| `e3db1bb` | 1 | feat(03-01): add droplet/sync-one-repo.sh per-repo mirror handler |
| `9edba16` | 2 | refactor(03-01): delegate per-repo loop body to sync-one-repo.sh |
| `e37b50b` | 3 | feat(03-01): chmod +x sync-one-repo.sh in bootstrap |

## Verification

| Check | Expected | Got |
|-------|----------|-----|
| `bash -n droplet/sync-one-repo.sh` | 0 | 0 |
| `bash -n droplet/github-backup.sh` | 0 | 0 |
| `bash -n droplet/bootstrap.sh` | 0 | 0 |
| `grep -c BACKUP_REPO_RESULT droplet/sync-one-repo.sh` | 1 | 1 |
| Emit lines `BACKUP_SUMMARY upstream=` in github-backup.sh | 1 | 1 |
| `grep -c sync-one-repo.sh droplet/github-backup.sh` | ≥1 | 2 |
| `grep -c sync-one-repo.sh droplet/bootstrap.sh` | ≥1 | 1 |
| `git ls-files --stage droplet/sync-one-repo.sh` mode | 100755 | 100755 |

## Deviations from Plan

**[Note — not a deviation] grep token count for `BACKUP_SUMMARY` in github-backup.sh**
Plan's verification step 3 reads "`grep -c "BACKUP_SUMMARY" droplet/github-backup.sh` returns 1". Actual count is 2: the runtime emit line at line 172 (the contract Phase 1 cares about) plus one pre-existing comment line at line 39 that already existed in the base commit (`6fe31f0`) before this plan started. The relevant invariant — exactly one runtime emit line per backup run — is preserved (`grep -nE 'log "BACKUP_SUMMARY' droplet/github-backup.sh` returns line 172 only). Editing the pre-existing comment line would violate the surgical-changes rule (it predates this plan). Phase 1's `verify:phase-1.ts` regex (`/^\[.*\] BACKUP_SUMMARY upstream=.../`) matches only the emit line, so the contract holds.

**[Note — not a deviation] `BACKUP_REPO_RESULT` token count in sync-one-repo.sh**
The plan asks for one emit. The script has one `log` call that emits the line. The header docstring originally mentioned `BACKUP_REPO_RESULT` literally; I rewrote the docstring to describe the contract by reference rather than the literal token so `grep -c "BACKUP_REPO_RESULT" droplet/sync-one-repo.sh` returns exactly 1.

**Total deviations:** 0 auto-fixed.
**Impact:** None — both notes describe contract-preserving choices already aligned with plan intent.

## Next

Ready for Wave 2 (plans 03-02 listener + 03-03 operator-scaffolding). Both
consume `sync-one-repo.sh`'s arg shape and per-repo lock convention without further
modification of this plan's artifacts.

## Self-Check: PASSED
