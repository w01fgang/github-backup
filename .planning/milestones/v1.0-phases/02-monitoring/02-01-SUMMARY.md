---
phase: 02-monitoring
plan: 01
subsystem: monitoring
tags: [bash, jq, atomic-write, droplet, instrumentation]

requires:
  - phase: 01-verify-pipeline
    provides: github-backup.sh and bootstrap.sh shipped to droplet; flock guard; BACKUP_SUMMARY log line; tsx/npm script convention
  - phase: 03-webhook
    provides: sync-one-repo.sh per-repo handler (called from this script's loop); bootstrap.sh webhook install block (alongside the new state-dir block)
provides:
  - "/var/lib/github-backup/last-run.json atomic writer on every github-backup.sh run"
  - "Locked last-run.json schema (started_at, finished_at, exit_code, total, success, fail, repos[]) consumed by Plans 02-02, 02-03, 02-04"
  - "State directory /var/lib/github-backup created with mode 700 (root) by bootstrap.sh"
affects: ["02-02", "02-03", "02-04", "06-multi-source"]

tech-stack:
  added: []
  patterns:
    - "Atomic state-file writes: jq -n into temp file + mv -f on same filesystem"
    - "Action-prediction from mirror-path existence (replaces removed inline clone/update branch — sync-one-repo.sh ownership)"

key-files:
  created: []
  modified:
    - droplet/github-backup.sh
    - droplet/bootstrap.sh

key-decisions:
  - "D-03 schema locked: 7 top-level keys (started_at, finished_at, exit_code, total, success, fail, repos[]); repos[].action enum is clone|update|fail (D-12)"
  - "Per-repo action predicted by checking [[ -d BACKUP_DIR/OWNER_REPO.git ]] before invoking sync-one-repo.sh, overridden to 'fail' on non-zero exit. Avoids changing the sync-one-repo.sh interface."
  - "TOTAL=0 path falls through to the writer (was: exit 0). Guarantees every cron run emits a state file."
  - "SUCCESS/FAIL counters moved above the TOTAL=0 check so the writer can reference them unconditionally under set -u."

patterns-established:
  - "State directory provisioning lives in bootstrap.sh next to BACKUP_DIR provisioning, mode 700 root-owned"
  - "EPOCHREALTIME wraps the sync-one-repo.sh invocation for per-repo duration_ms"
  - "jq --arg/--argjson handles all JSON escaping for values originating from gh api output and internal counters"

requirements-completed: [MON-01, MON-02]

duration: 6min
completed: 2026-05-13
---

# Phase 02 Plan 01: Backup-script instrumentation Summary

**`droplet/github-backup.sh` now writes `/var/lib/github-backup/last-run.json` after every run (atomic, schema-locked); `droplet/bootstrap.sh` provisions the state directory at mode 700.**

## Performance

- **Duration:** ~6 min
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Atomic last-run.json writer instrumenting every github-backup.sh run, including the zero-repo path
- Per-repo rows (`name`, `action`, `duration_ms`) populated by predicting the action from the mirror-path that sync-one-repo.sh writes to, then overriding to `fail` on non-zero exit
- State directory `/var/lib/github-backup` provisioned by bootstrap.sh with mode 700, idempotent

## Task Commits

1. **Task 1: Add state directory creation to bootstrap.sh** — `bb5b7b5` (feat)
2. **Task 2: Instrument github-backup.sh to write last-run.json** — `3c84eca` (feat)

## Files Created/Modified

- `droplet/bootstrap.sh` — Adds the `STATE_DIR=/var/lib/github-backup` block (mkdir -p + chmod 700) between the BACKUP_DIR provisioning and the script-permissions section.
- `droplet/github-backup.sh` — Three edits:
  1. Declare `STATE_DIR`, capture `STARTED_AT`, initialise `REPOS_JSON_ROWS=()` near the top.
  2. Replace the per-repo loop body with: pre-check mirror path → `ROW_ACTION=update|clone`; time around sync-one-repo.sh with EPOCHREALTIME; override `ROW_ACTION=fail` on non-zero exit; append a `jq -n` row to `REPOS_JSON_ROWS`.
  3. Replace the `TOTAL=0` early-exit with a fall-through; append the writer block (FINISHED_AT capture, EXIT_CODE compute, `jq -s` aggregate, `jq -n` final object, temp+rename, chmod 640) directly after `BACKUP_SUMMARY upstream=…`.

## Schema (locked — Plans 02-02, 02-03, 02-04 consume verbatim)

```json
{
  "started_at": "ISO-8601 UTC, second precision",
  "finished_at": "ISO-8601 UTC, second precision",
  "exit_code": 0,
  "total": 0,
  "success": 0,
  "fail": 0,
  "repos": [
    { "name": "owner/repo", "action": "clone|update|fail", "duration_ms": 1240 }
  ]
}
```

File mode: 640. Directory mode: 700. Both root-owned.

## Plan Deviations from Written Steps

The plan's Edit 2 described refactoring an inline `if [[ -d "${MIRROR_PATH}" ]]; then … else … fi` block in `github-backup.sh`. **That block no longer exists in the current script** — Phase 3 extracted per-repo work to `droplet/sync-one-repo.sh` (commit `cfbf29c`). The per-repo loop in `github-backup.sh` is now a thin tally over `sync-one-repo.sh` exit codes.

**Adaptation:** Predicted `ROW_ACTION` by checking `[[ -d "${BACKUP_DIR}/${OWNER}_${NAME}.git" ]]` *before* invoking the helper (the mirror path sync-one-repo.sh writes to per sync-one-repo.sh:83). On non-zero exit, override to `fail`. This keeps sync-one-repo.sh's contract unchanged, honours the locked enum (D-12: clone|update|fail), and matches `must_haves.truths` (`Per-repo action recorded as clone|update|fail`).

**Edge case acknowledged but accepted:** sync-one-repo.sh exits 0 when it cannot acquire the per-repo lock (lines 69-72 of sync-one-repo.sh) — in that path, no real sync occurred, but our predicted action ("update" or "clone") gets recorded with a tiny `duration_ms`. This is rare in normal cron runs (per-repo lock is only held during an active sync of the same repo, and the global flock at fd 9 serialises whole runs). Treating it as a real action is preferable to extending sync-one-repo.sh's interface in this plan.

The line numbers in the plan's Edit instructions (57, 148, 188, 191, 193) were stale relative to the current `github-backup.sh`. Edits were made by content-anchored Edit calls, not line numbers; final acceptance criteria all pass.

## Verification

- `bash -n droplet/github-backup.sh` exits 0
- `bash -n droplet/bootstrap.sh` exits 0
- All acceptance-criteria grep checks pass (verified):
  - `STATE_DIR="${STATE_DIR:-/var/lib/github-backup}"` — 1
  - `STARTED_AT=` — 1
  - `FINISHED_AT=` — 1
  - `last-run.json.tmp` — 1
  - `mv -f "${TMP_FILE}" "${STATE_DIR}/last-run.json"` — 1
  - `BACKUP_SUMMARY upstream=` — 1 (preserved)
  - `Backup finished — success:` — 1 (preserved)
  - `ROW_ACTION="update"` / `"clone"` / `"fail"` — 1 each
  - `REPOS_JSON_ROWS+=(` — 1
  - `jq -n` — 2 (per-row builder + final aggregate)
- TOTAL=0 path no longer exits before the writer (grep -A2 'Nothing to back up' shows fall-through comments instead of `exit 0`).

End-to-end (after deploy + cron fire, owned by Plan 02-04):
- `jq -e '.started_at and .finished_at and (.exit_code|type=="number") and (.total|type=="number") and (.success|type=="number") and (.fail|type=="number") and (.repos|type=="array")' /var/lib/github-backup/last-run.json` exits 0
- `npm run verify:phase-1` still passes (BACKUP_SUMMARY contract preserved)

## Issues Encountered

None.

## Self-Check: PASSED

Ready for Plan 02-02 (`droplet/github-backup-status.sh` reader/formatter).
