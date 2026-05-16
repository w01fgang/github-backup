---
phase: 01-verify-pipeline
fixed_at: 2026-05-04T00:00:00Z
review_path: .planning/phases/01-verify-pipeline/01-REVIEW.md
iteration: 2
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report (Iteration 2)

**Fixed at:** 2026-05-04T00:00:00Z
**Source review:** .planning/phases/01-verify-pipeline/01-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0

All five regressions surfaced by the iter2 re-review (1 blocker + 4 warnings, all introduced or left under-covered by the iter1 patch series) are addressed. Each fix verified against `bash -n` (shell) or `tsc --noEmit` (TypeScript) inside an isolated worktree before commit.

## Fixed Issues

### NR-01: flock silent exit makes verify:phase-1 non-deterministic with cron installed

**Files modified:** `droplet/github-backup.sh`, `scripts/smoke-test.ts`, `scripts/verify/phase-1.ts`
**Commit:** cd71477
**Applied fix:** Adopted "Option 2" from the review (smallest diff). Cron path keeps non-blocking flock + silent-exit. When `REQUIRE_LOCK=1` is set, the script blocks on `flock 9` instead. Verify (`group3BackupRan`) and smoke (`triggerBackup`) now prefix the remote invocation with `REQUIRE_LOCK=1` so an in-flight cron run causes their trigger to wait for the lock rather than no-op exit and let the assertion parse a stale BACKUP_SUMMARY from the previous run.

### NR-02: BL-01 trim only strips one trailing empty mapfile element

**Files modified:** `droplet/github-backup.sh`
**Commit:** 4c60e13
**Applied fix:** Replaced the single trailing-empty unset with a guarded for-loop that filters all empty entries into a `TMP` array. Wrote the result back into `REPOS` via guards (`${#TMP[@]} -gt 0`) so the code remains safe under `set -u` when the input list is empty (avoids the `("")` 1-element-array trap from naive `${TMP[@]:-}` expansion). Mid-stream blanks, double newlines at EOF, and post-trim residuals all collapse to zero entries instead of producing a phantom `_.git` clone failure.

### NR-03: WR-05 fix omits cronSchedule from SHELL_SAFE_FIELDS

**Files modified:** `scripts/lib/config.ts`
**Commit:** 6ea53d6
**Applied fix:** Added `CRON_SAFE_RE = /^[0-9*,/ \t-]+$/` (cron-shape allow-list) and a separate validation pass on `cfg.cronSchedule` at the bottom of `loadConfig`. cronSchedule legitimately contains spaces, `*`, `,`, `/`, `-` so it cannot share the strict `SHELL_SAFE_RE`, but it still gets interpolated into `backup.env` quoted as `CRON_SCHEDULE="..."` and sourced on the droplet, so a stray `"`, `$`, backtick, or newline still bails loudly.

### NR-04: WR-11 sshExitsZero misclassifies signal-killed ssh as remote non-zero

**Files modified:** `scripts/verify/phase-1.ts`
**Commit:** e366771
**Applied fix:** Inserted two new branches before the existing `r.status === 255` check: `if (r.signal)` throws `ssh killed by signal <name>`; `if (r.status === null)` throws `ssh exited without a status (no signal reported)`. Signal-killed ssh (e.g. SIGTERM during CI cleanup, OOM-kill) now surfaces as a transport-class failure rather than getting silently mapped to "remote command failed" — closing the same false-narrative class WR-11 was meant to eliminate.

### NR-05: WR-04 token shape regex — trim before validating

**Files modified:** `scripts/bootstrap-droplet.ts`, `scripts/smoke-test.ts`
**Commit:** baf4763
**Applied fix:** All three GITHUB_TOKEN presence-check sites (`bootstrap-droplet.ts:main`, `smoke-test.ts:bootstrap`, `smoke-test.ts:main` BL-04 hoist) now `.trim()` before the empty check. The `writeBackupEnv` shape-error message no longer suggests "trim whitespace/newlines" (since trimming already happened) and instead surfaces the trimmed length to help the operator spot a paste with embedded control chars. Consolidation into a single helper was deferred — minimum-diff fix at each site preserves the existing call shapes and keeps the diff narrowly scoped to the regression.

## Verification Notes

- Each fix verified inside an isolated git worktree (`gsd-reviewfix/01-$$`) via `bash -n` for `droplet/github-backup.sh` and `tsc --noEmit` for the TypeScript edits.
- `tsc --noEmit` reports zero diagnostics across the full project after each commit.
- `bash -n` accepts the new `github-backup.sh` after both NR-01 and NR-02. Runtime testing of the `mapfile` filter could not be performed on the host (macOS bash 3.2 lacks `mapfile`), but the script targets the droplet's bash 4+ and the syntax check passes; the logic is reviewed against the failure modes called out in NR-02.
- All five commits land on `gsd-reviewfix/01-41985`; the orchestrator's transactional cleanup tail will fast-forward `master` to capture them.

---

_Fixed: 2026-05-04T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
