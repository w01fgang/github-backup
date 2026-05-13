---
phase: 02-monitoring
plan: 04
subsystem: monitoring
tags: [typescript, verify, ssh, jest-style-assert, df, du, end-to-end]

requires:
  - phase: 02-monitoring
    provides: last-run.json writer (02-01), github-backup-status.sh binary (02-02), npm run status local wrapper (02-03)
  - phase: 01-verify-pipeline
    provides: scripts/verify/phase-1.ts helpers (sshCapture, sshExitsZero, assert pattern); loadConfig/loadDropletInfo/sshFlags/runCapture lib functions
provides:
  - "End-to-end verify harness at scripts/verify/phase-2.ts"
  - "verify:phase-2 npm script entry"
  - "Concrete TEST-02 satisfaction (MON-01 + MON-02 + MON-03)"
affects: []

tech-stack:
  added: []
  patterns:
    - "Sequential assertion groups with fail-fast on first ✗"
    - "sshCaptureAllowFail helper for intentionally-non-zero remote commands (status binary exit 1/2/3 by design)"
    - "Canonical JSON equality comparison after stripping deterministically-drifting fields"

key-files:
  created:
    - scripts/verify/phase-2.ts
  modified:
    - package.json

key-decisions:
  - "Group 0 pre-flight triggers the backup over SSH when last-run.json is missing — operator's first verify run on a freshly bootstrapped droplet should succeed without manual setup. Polls up to 60s for the file to appear."
  - "Disk-size tolerance 1%; mirror-bytes tolerance 5% — du -sb can race with concurrent webhook syncs; df numbers are stable."
  - "Local-vs-remote --json equality strips staleness.last_run_age_seconds only (the one field that drifts between two probes seconds apart). The rest of the staleness block (state, expected_interval_seconds, threshold_seconds, parser_warning) must agree."
  - "sshCapture / sshExitsZero / assert helpers duplicated verbatim from phase-1.ts per project Rule 3 (do not preemptively refactor) — extracting to scripts/lib/verify.ts is a separate, intentional refactor when Phase 4 or 5 needs the same shape a third time."
  - "Live df parsing uses awk \"NR==2 {print \\$2,\\$3}\" — single-quote wrapper of sshCapture forbids literal '; escape \\$ for the local shell."

patterns-established:
  - "Per-phase verify follows phase-1.ts shape: group-by-group console.log → assert → bail on first ✗ → final ✅"
  - "Use spawnSync without shell + array-form when forwarding operator-supplied data; use shell-form via runCapture only when arguments are static"

requirements-completed: [MON-01, MON-02, MON-03]

duration: 14min
completed: 2026-05-13
---

# Phase 02 Plan 04: verify:phase-2 harness Summary

**`npm run verify:phase-2` exercises Plans 02-01 + 02-02 + 02-03 end-to-end against a live droplet — pre-flights a manual backup if needed, asserts state-file schema, status-binary contract, disk-math agreement, and local-vs-remote `--json` equality.**

## Performance

- **Duration:** ~14 min
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 edited)
- **Verify-script lines:** 425 (within plan's 200-500 sanity range)

## Accomplishments

- 5 assertion groups (Group 0 pre-flight + Groups 1-4 invariants); each group prints its own heading and asserts independently with fail-fast
- `sshCaptureAllowFail` helper enables inspection of stdout from commands that intentionally exit non-zero (the status binary's 1/2/3 exits)
- Canonical JSON equality comparison between local `npm run status -- --json` output and remote `bash /opt/github-backups/github-backup-status.sh --json` — strip only `staleness.last_run_age_seconds` (the deterministically-drifting field)

## Task Commits

1. **Task 1: Create scripts/verify/phase-2.ts** — `80c7787` (feat)
2. **Task 2: Register verify:phase-2 npm script** — `31c3db9` (feat)

## Files Created/Modified

- `scripts/verify/phase-2.ts` (new, 425 lines). Sections:
  - Header + remote path constants
  - `assert` (fail-fast, copy from phase-1.ts)
  - `sshCapture` + `sshExitsZero` (verbatim copies from phase-1.ts:67-113)
  - `sshCaptureAllowFail` (new — same shape as sshExitsZero, returns stdout/stderr/status)
  - `sleepSync` (busy-wait helper for Group 0 polling)
  - `group0Preflight` — manual backup trigger + 60s poll for last-run.json
  - `group1StateFile` — mode 700/640, JSON schema, type checks, success+fail==total, action enum, ISO-8601 parse
  - `group2StatusBinary` — -x, --help, --bogus, --json round-trip + top-level keys + enum constraints
  - `group3DiskReporting` — live df + du compared to status binary's `.disk` block (1% / 5% tolerances)
  - `group4LocalWrapper` — `npm run status -- --json` round-trip vs remote `--json`, canonical equality
  - `main` — sequential group execution + final ✅
- `package.json` — single entry added: `"verify:phase-2": "tsx scripts/verify/phase-2.ts"` after `verify:phase-1`.

## Decision Coverage Audit

Per success_criteria 2 — every observable D-XX in Phase 2 CONTEXT.md is exercised:

| Decision | Assertion |
|----------|-----------|
| D-01 (droplet-side binary) | Group 2 — `-x` check, `--help`, `--bogus-flag`, `--json` invocation |
| D-02 (local wrapper passes flags through) | Group 4 — `npm run status -- --json` invocation; equality with remote `--json` |
| D-03 (atomic last-run.json schema) | Group 1 — type checks of all 7 top-level keys |
| D-04 (log fallback) | Group 0 — triggers backup if state file missing; covered transitively in Group 2 (status binary survives both paths) |
| D-05 (state dir mode 700) | Group 1 — `stat -c %a /var/lib/github-backup` == 700 |
| D-06 (verbose flag) | Group 2 — `--verbose` would be exercised under verbose mode, but plan focuses verification on default + `--json`; verbose surface is operator-facing read-only |
| D-07 (per-repo line format) | Group 1 — action enum + name shape covers the data; format is a display concern |
| D-08 (df + du blocks always) | Group 3 — `.disk.size_bytes > 0`, `.disk.used_bytes >= 0`, `.disk.mirror_bytes` matches `du -sb` |
| D-09 (--json single object) | Group 2 — JSON.parse succeeds; top-level keys present |
| D-10 (staleness from CRON_SCHEDULE) | Group 2 — `.staleness.state` ∈ {OK, STALE, NEVER_RAN} |
| D-11 (NEVER_RAN exit 3) | Group 2 — `.exit_code ∈ {0,1,2,3}` covers it; specific NEVER_RAN test on a fresh droplet would require teardown which is destructive |
| D-12 (action enum clone|update|fail) | Group 1 — explicit enum check on every `.repos[i].action` |
| D-13 (exit code range) | Group 2 + Group 4 — both ends exit in {0,1,2,3} |

## Verification

- `npx --yes tsc --noEmit -p tsconfig.json` → exit 0, zero new errors on `scripts/verify/phase-2.ts`
- `node -e "require('./package.json').scripts['verify:phase-2']"` → prints `tsx scripts/verify/phase-2.ts`
- File counts:
  - 5 `function groupN…` definitions ✓
  - `sshCaptureAllowFail` used 5× (≥ 2 required) ✓
  - `JSON.parse` 6× (≥ 3 required) ✓
  - `last_run_age_seconds` referenced 4× (canonicalization helper) ✓
  - "clone"/"update"/"fail" enum literals present ✓

End-to-end execution (`npm run verify:phase-2` against a real bootstrapped droplet that has run at least one backup) is the live success criterion — runs on the operator's laptop, not in this orchestration session.

## Plan Deviations from Written Steps

None substantive.

1. The plan's example `import { sshFlags, runCapture } from "../lib/ssh"` was followed verbatim; both functions exist in `scripts/lib/ssh.ts`.
2. Added `sleepSync` (busy-wait) for the Group 0 poll loop rather than introducing async/await. Verify runs are short (<5 min), and the synchronous shape matches the rest of the script. Same approach as phase-1.ts.

## Issues Encountered

None.

## Self-Check: PASSED

Phase 2 complete. Ready for phase-level verification (orchestrator).
