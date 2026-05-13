---
phase: 02-monitoring
plan: 02
subsystem: monitoring
tags: [bash, jq, droplet, status-binary, cron-parsing, df, du]

requires:
  - phase: 02-monitoring
    provides: last-run.json schema written by 02-01-PLAN
  - phase: 01-verify-pipeline
    provides: backup.env layout (CRON_SCHEDULE), BACKUP_DIR layout, /var/log/github-backup.log line format
  - phase: 03-webhook
    provides: bootstrap-droplet.ts upload allow-list already includes *.sh — github-backup-status.sh is auto-uploaded; bootstrap.sh chmod loop already covers it
provides:
  - "Droplet-side status binary at /opt/github-backups/github-backup-status.sh"
  - "Text report by default (counts header + failed-repo names always, full per-repo list under --verbose)"
  - "JSON output (--json) — a single jq-parseable object with last_run / disk / staleness / verbose / exit_code blocks"
  - "Staleness lookup table over CRON_SCHEDULE (D-10) — covers @hourly/@daily/@weekly, */N */N, M H literals; defaults to daily with parser_warning on unmatched patterns"
  - "Exit codes per D-13: 0/1/2/3"
affects: ["02-03", "02-04", "06-multi-source"]

tech-stack:
  added: []
  patterns:
    - "Single jq -n invocation for JSON emission (no string concatenation)"
    - "bash regex via [[ =~ BASH_REMATCH ]] for log fallback parsing"
    - "Helpers (human_bytes, human_seconds) as awk one-liners for portability"

key-files:
  created:
    - droplet/github-backup-status.sh
  modified: []

key-decisions:
  - "D-10 staleness math: hand-rolled lookup table covering the common cron patterns; unknown patterns default to 86400 with staleness.parser_warning=true. No cron-parser npm package — droplet has no Node runtime, and operator-realistic schedules fit a 5-case table."
  - "Log fallback (D-04) recovers SUCCESS/FAIL/TOTAL/FINISHED_AT from the 'Backup finished — success: N, failed: M' line via bash regex; STARTED_AT and REPOS_JSON are reported as empty/[] with a '[from log]' marker in the text output."
  - "T-02-05 defense: backup.env is sourced under set -a/+a then GITHUB_TOKEN is unset immediately. Status binary never references the token."
  - "compute_disk gracefully handles BACKUP_DIR=absent (fresh droplet, never bootstrapped): all _B values = 0, no error."
  - "Exit code precedence is NEVER_RAN > STALE > failures > 0 (per D-13). Stale dominates failures because freshness is the prerequisite to investigate failures."

patterns-established:
  - "Output format toggle (text default vs --json) via single FORMAT variable + main() dispatch"
  - "Globals populated by data collectors, consumed by emit_* functions — keeps each function focused on one concern"
  - "Verbose mode is purely additive — never replaces default output"

requirements-completed: [MON-01, MON-02, MON-03]

duration: 11min
completed: 2026-05-13
---

# Phase 02 Plan 02: github-backup-status binary Summary

**Droplet-side status binary wires D-01/D-04/D-06–D-11/D-13 — reads last-run.json (or log fallback), measures disk via df+du, parses CRON_SCHEDULE for staleness, emits text-by-default or `--json`.**

## Performance

- **Duration:** ~11 min
- **Tasks:** 3 (skeleton+flags, data collectors, emit functions)
- **Files modified:** 1 (created)
- **Lines:** 376 (within plan's 150-400 sanity range)

## Accomplishments

- Single-file bash binary at `droplet/github-backup-status.sh`, no new dependencies (uses jq already installed by bootstrap.sh)
- Three flag surfaces: `--json`, `-v|--verbose`, `-h|--help`. Unknown → exit 64. Pure-additive flag semantics.
- D-04 fallback: when last-run.json is missing or invalid, tails the log and reconstructs SUCCESS/FAIL/TOTAL/FINISHED_AT from the canonical summary line; text mode flags the data source with `[from log]`.
- Staleness lookup table covers `@hourly`/`@daily`/`@midnight`/`@weekly`, `*/N * * * *`, `0 */N * * *`, `M H * * D`, `M H * * *`. Unrecognised → 86400 + parser_warning=true.
- Disk block always emits filesystem, size_bytes, used_bytes, percent_used (from `df -P -B1`) and mirror_bytes (from `du -sb`). Fresh-droplet path (no BACKUP_DIR) yields zeros without errors.
- Verbose mode appends per-repo lines (`<glyph> <action> <name>`) and per-mirror `du -sh` block. No-mirrors path is silent.

## Task Commits

1. **Task 1 + 2 + 3 (single commit):** `ac0216d` (feat)

Tasks were merged into a single atomic commit because the file is one coherent script — the plan's task split is a build order, not a deployment unit. All Task-1/2/3 acceptance criteria verified before commit (see Verification below).

## Files Created/Modified

- `droplet/github-backup-status.sh` (new, 376 lines, chmod +x). Sections:
  - Header comment + decision crossref (D-01/D-04/D-06–D-11/D-13)
  - Flag parser (while-case loop)
  - Path constants (STATE_FILE, LOG_FILE, BACKUP_DIR, ENV_FILE)
  - backup.env sourcing with immediate `unset GITHUB_TOKEN` (T-02-05)
  - `human_bytes` / `human_seconds` awk helpers
  - Globals (state, disk, staleness blocks)
  - `load_state` (JSON first; log regex fallback; NEVER_RAN otherwise)
  - `compute_disk` (df -P -B1 + du -sb, graceful on missing BACKUP_DIR)
  - `expected_interval` + `compute_staleness` (D-10 lookup table)
  - `final_exit_code` (D-13 precedence)
  - `emit_text` (banners, heading, last-run line, exit code, repos line, failed list, disk, staleness, verbose blocks)
  - `emit_json` (single `jq -n` invocation)
  - `main` (load → compute → compute → dispatch → exit)

## Upload Contract

`scripts/bootstrap-droplet.ts:217-228` already uploads every `.sh` file in `droplet/`, and the existing `bootstrap.sh` runs `chmod +x ${backupDir}/*.sh` (line 236 of bootstrap-droplet.ts) — `github-backup-status.sh` lands at `/opt/github-backups/github-backup-status.sh` automatically with mode 755. No upload-side change needed.

## Verification

Local checks (all passed before commit):

```
bash -n droplet/github-backup-status.sh                    # syntax OK
grep -c '^load_state()' = 1
grep -c '^compute_disk()' = 1
grep -c '^compute_staleness()' = 1
grep -c '^final_exit_code()' = 1
grep -c '^emit_text()' = 1
grep -c '^emit_json()' = 1
grep -F -c '⚠ STALE —' = 1
grep -F -c '✗ NEVER RAN' = 1
grep -F -c 'last_run: (if $state_src == "none" then null else' = 1
grep -F -c 'exit "$(final_exit_code)"' = 1

bash droplet/github-backup-status.sh --help    → exit 0, prints usage
bash droplet/github-backup-status.sh --bogus   → stderr "Unknown option: --bogus", exit 64
bash droplet/github-backup-status.sh           → "✗ NEVER RAN …", exit 3 (locally, paths absent)
bash droplet/github-backup-status.sh --json | jq -e .   → exit 0 (valid JSON)
```

End-to-end (droplet deploy + cron run + disk math comparison) lives in Plan 02-04 (`scripts/verify/phase-2.ts`).

## Plan Deviations from Written Steps

None substantive. Two minor:

1. The plan suggested mirroring "the pattern in install-cron.sh" for flag parsing — install-cron.sh has no flag parser. Used a standard `while [[ $# -gt 0 ]]; do case "$1" in …; esac; done` loop.
2. Per-mirror `du -sh` block (verbose mode) iterates `${BACKUP_DIR}/*.git` directories. The plan said "every mirror"; sync-one-repo.sh mirrors to `${OWNER}_${REPO}.git` naming, so the glob `*.git` matches all of them.

## Issues Encountered

None.

## Self-Check: PASSED

Ready for Plan 02-03 (`scripts/status.ts` local SSH wrapper).
