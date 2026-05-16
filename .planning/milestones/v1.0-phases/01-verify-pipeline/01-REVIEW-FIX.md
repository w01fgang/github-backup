---
phase: 01-verify-pipeline
fixed_at: 2026-05-04T00:00:00Z
review_path: .planning/phases/01-verify-pipeline/01-REVIEW.md
iteration: 3
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report (Iteration 3)

**Fixed at:** 2026-05-04T00:00:00Z
**Source review:** .planning/phases/01-verify-pipeline/01-REVIEW.md
**Iteration:** 3

**Summary:**
- Findings in scope: 4 (NR-06..NR-09, all WARNING)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### NR-06: `flock 9` blocking has no timeout

**Files modified:** `droplet/github-backup.sh`
**Commit:** 4d6aea7
**Applied fix:** Replaced unbounded `flock 9` (REQUIRE_LOCK=1 path) with `flock -w "${LOCK_WAIT_SECONDS}" 9`. Default 600s; tunable via env. On timeout: stderr message naming the lock file and `exit 75` (EX_TEMPFAIL) so verify/smoke surface "previous run wedged" distinct from a real backup failure. Cron path (`flock -n 9 || exit 0`) unchanged. `bash -n` clean.

### NR-07: `CRON_SAFE_RE` rejects valid cron extensions

**Files modified:** `scripts/lib/config.ts`
**Commit:** fcd9db4
**Applied fix:** Widened `CRON_SAFE_RE` from `/^[0-9*,/ \t-]+$/` to `/^[A-Za-z0-9@*,/#? \t-]+$/`. Now accepts `@daily`/`@hourly`/`@reboot` nicknames, named months (`JAN`-`DEC`) and days (`MON`-`SUN`), last-day-of-month (`L`), nearest-weekday (`W`), nth-weekday (`#`), and the `?` no-specific-value extension. Injection-relevant chars (`"`, `$`, `` ` ``, `\`, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`, newline) remain blocked. `tsc --noEmit` clean. (Unit test fixture creation deferred — no test harness exists in the project per CONTEXT.md.)

### NR-08: cron-fires-after-trigger race in BACKUP_SUMMARY parse

**Files modified:** `scripts/verify/phase-1.ts`, `scripts/smoke-test.ts`
**Commit:** 47ef355
**Applied fix:** Option 2 from the review (monotonic timestamp anchor):
1. `BACKUP_SUMMARY_RE` extended to capture the `[YYYY-MM-DD HH:MM:SS]` timestamp prefix as group 1; numeric groups shift to 2/3/4.
2. Both `group3BackupRan` (verify) and `triggerBackup` (smoke) capture droplet-local "now" via `ssh ... 'date "+%Y-%m-%d %H:%M:%S"'` *before* triggering.
3. Tail-parse filters matches by `m[1] >= tStart` (lexicographic compare on fixed-width same-tz timestamps is monotonic).
4. Earliest post-tStart match is taken (instead of `matches[length-1]`) — that is our triggered run; later matches would be a cron run that fired after lock release.
5. `triggerBackup` signature changed to return `tStart`; `enforcePassBar` now takes a `tStart: string` arg; `main()` threads it through. `tsc --noEmit` clean.

### NR-09: `findFirewallId` swallows all doctl errors as absent

**Files modified:** `scripts/destroy-droplet.ts`, `scripts/create-droplet.ts`
**Commit:** 64a9ca4
**Applied fix:** Mirrored the WR-01 `dropletExists` shape in `findFirewallId` (destroy-droplet): tolerate the empty-list quirk via `/empty list|no firewalls/i` regex on the error message; rethrow anything else with a "refusing to assume absence" prefix so destroy-droplet aborts before deleting `.droplet.json`. Same hardening applied to the `findOrCreateFirewall` sibling in create-droplet.ts (lower severity per review note — duplicate-create attempt rather than orphan — but kept consistent for clarity). `tsc --noEmit` clean.

## Skipped Issues

None — all four findings were fixed.

---

_Fixed: 2026-05-04T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 3_
