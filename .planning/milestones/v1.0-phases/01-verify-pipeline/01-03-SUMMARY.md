---
phase: 01-verify-pipeline
plan: 03
subsystem: testing
tags: [smoke-test, orchestrator, ssh, backup-summary, d-02, d-04, d-08]
status: partial — Task 1 complete, Task 2 deferred (live-cloud run)
requires:
  - phase: 01-verify-pipeline (plan 01)
    provides: "scripts/lib/{ssh,doctl,config}.ts shared helpers + npm script wiring"
  - phase: 01-verify-pipeline (plan 02)
    provides: "verify:phase-1 BACKUP_SUMMARY parser contract on the verify side"
provides:
  - "scripts/smoke-test.ts end-to-end orchestrator (build-only; live run deferred)"
  - "BACKUP_SUMMARY marker emit on bash side (droplet/github-backup.sh)"
  - "Cross-language BACKUP_SUMMARY contract now closed: bash emits, TS smoke + verify parse"
affects:
  - droplet/github-backup.sh (one log line added, exit logic unchanged)
  - scripts/smoke-test.ts (new)
tech-stack:
  added: []
  patterns:
    - "spawnSync('npm', ['run', ...]) for chaining entrypoints — keeps each script independently runnable"
    - "GIT_SSH_COMMAND env var with sshFlags() for clone-probe — same auth contract as ssh.ts helpers"
    - "BACKUP_SUMMARY single-source-of-truth (bash) parsed by two TS consumers (smoke + verify)"
key-files:
  created:
    - scripts/smoke-test.ts
  modified:
    - droplet/github-backup.sh
key-decisions:
  - "Spawn entrypoints via npm run rather than refactoring create/bootstrap to expose main() — plan body's recommendation; keeps existing scripts independent"
  - "Plan-checker Issue 4 — Option A: BACKUP_SUMMARY marker on success and failure paths (logged before the FAIL>0 exit gate). One bash line added, no control-flow change"
  - "tmpdir cleanup only on success — failed clone-probe leaves the dir for inspection (T-01-07)"
patterns-established:
  - "BACKUP_SUMMARY contract closed end-to-end: bash emits one line, smoke + verify both regex-parse it"
requirements-completed: []
requirements-pending-live-run:
  - PROV-01
  - PROV-02
  - BACKUP-01
  - BACKUP-02
  - BACKUP-03
  - ACCESS-01
  - TEST-01
duration: 2min
completed: 2026-05-02
---

# Phase 01 Plan 03: Smoke-test Summary

**TS end-to-end orchestrator wired (Task 1) plus the bash-side BACKUP_SUMMARY marker. Live-cloud verification (Task 2) intentionally deferred — operator will run `npm run smoke-test` + `npm run verify:phase-1` against real DigitalOcean infrastructure manually. Phase 1 close-out reflects the deferred live run.**

## Performance

- **Duration:** ~2 min (Task 1 only)
- **Started:** 2026-05-02T06:43:33Z
- **Completed:** 2026-05-02T06:45:50Z
- **Tasks completed:** 1 of 2
- **Files created:** 1 (`scripts/smoke-test.ts`, 288 lines)
- **Files modified:** 1 (`droplet/github-backup.sh`, +2 lines)

## What Was Built

### Step 0 — BACKUP_SUMMARY marker on bash side (commit `210dc53`)

One line added to `droplet/github-backup.sh` immediately before the existing
`if [[ "${FAIL}" -gt 0 ]]` exit gate:

```bash
log "BACKUP_SUMMARY upstream=${TOTAL} mirrored=${SUCCESS} failed=${FAIL}"
```

- Emitted on every run (success and failure paths).
- Existing exit-1-on-FAIL>0 logic preserved verbatim.
- `bash -n` syntax check passes.
- Marker line lands at line 152; exit block at line 154.

This closes the BACKUP_SUMMARY cross-language contract: plan 01-02 already
ships the regex consumer in `scripts/verify/phase-1.ts`; the smoke runner
parses the same shape (next step). Single source of truth for upstream
count stays in bash — no `gh api` user-vs-org detection duplicated in TS.

### Step 1 — `scripts/smoke-test.ts` orchestrator (commit `034bd56`)

288-line TS orchestrator implementing D-03/D-04/D-05/D-08:

| Step | What | Maps to |
|------|------|---------|
| `--fresh` (optional) | spawn `npm run destroy-droplet -- --yes`; ignore non-zero | D-08 |
| Provision | spawn `npm run create-droplet`; fatal on non-zero | PROV-01, ROADMAP §1 |
| Load state | `loadDropletInfo()` + `loadConfig()` | — |
| Bootstrap | bail if `GITHUB_TOKEN` empty; spawn `npm run bootstrap-droplet` | PROV-02, BACKUP-03, ROADMAP §2 + §5 |
| Trigger backup | `sshRun(ip, user, key, "/opt/github-backups/github-backup.sh")` | BACKUP-01/02, ROADMAP §3 |
| SSH-probe | `ls -1d /opt/github-backups/*.git \| head -n 1` — bail if empty | BACKUP-02 |
| Clone-probe | `mkdtemp` + `GIT_SSH_COMMAND='ssh ...' git clone <user>@<ip>:/path` + assert HEAD is 40-hex + assert ≥1 ref; cleanup on success only | ACCESS-01, ROADMAP §4 |
| BACKUP_SUMMARY parse | tail 50 lines of `/var/log/github-backup.log`, regex `^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$/m`; assert `mirrored===upstream && failed===0` | D-02 |
| Filesystem cross-check | `ls -1d /opt/github-backups/*.git \| wc -l` must equal `mirrored` | D-02 |
| Print PASS, preserve droplet | exit 0 | D-04, D-08 |

**Re-uses existing contract:** same `config.json` + `GITHUB_TOKEN` env as the real scripts (D-05). No separate test config.

**Spawning approach:** `spawnSync('npm', ['run', ...], { stdio: 'inherit', env: process.env })` — plan body's recommended path; keeps each entrypoint independently runnable.

## Verification

| Gate | Result |
|------|--------|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `bash -n droplet/github-backup.sh` | exit 0 |
| `grep -q "BACKUP_SUMMARY upstream=" droplet/github-backup.sh` | OK |
| `grep -q "BACKUP_SUMMARY" scripts/smoke-test.ts` | OK |
| Orchestration markers in smoke-test.ts (`create-droplet\|bootstrap-droplet\|github-backup.sh\|git clone\|--fresh`) | 23 (≥5 floor) |
| Min line count for `scripts/smoke-test.ts` (≥120) | 288 |

## Task 2 — Deferred (Live-cloud Run)

Task 2 of plan 01-03 is `checkpoint:human-verify` requiring real DigitalOcean credentials, real `GITHUB_TOKEN`, and a billable droplet. **Per user direction, this run is deferred to the operator.** Claude did NOT:

- run `npm run smoke-test` against any real droplet,
- prompt for, capture, or transmit any cloud credentials,
- exercise `--fresh` against live infrastructure.

**Operator-owned next steps (manual):**

1. Pre-flight: `doctl auth init` + `gh auth status` + `config.json` populated + `GITHUB_TOKEN` exported in shell.
2. `npm run smoke-test` (and `--fresh` at least once during iteration to confirm the teardown path).
3. `npm run verify:phase-1` after smoke green.
4. Iterate on any uncovered bugs in-scope per CONTEXT.md "Claude's Discretion: bug-fix triage rule".

**Phase 1 verification reflects the deferral:** the eight Phase 1 requirements (PROV-01/02, BACKUP-01/02/03, ACCESS-01, TEST-01, TEST-02) cannot be marked Validated until the operator's live run exits 0. They remain Active. Plan 01-02 (TEST-02 verify harness) and Plan 01-03 Task 1 (TEST-01 build-out) are code-complete; only the live exercise remains.

## Deviations from Plan

None for Task 1 — executed exactly as written.

Task 2 not deviated, **deferred** by user direction. The plan's structure (Task 1 build → Task 2 live verify) is preserved; the live verify step is just executed by the operator instead of by Claude.

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|------------|
| T-01-03 (smoke-test logging GITHUB_TOKEN) | Smoke-test re-uses `runVisible` / `runCapture` / `sshRun` from `scripts/lib/ssh.ts` — no token interpolation into log lines anywhere. Bootstrap is spawned via `spawnSync` which passes env to the child, never echoes it. |
| T-01-07 (clone-probe tmpdir collision / leak) | `fs.mkdtempSync(os.tmpdir() + '/gh-backup-smoke-')` per run; cleanup only on success path. Failures preserve the dir at a printed path for operator inspection. |
| T-01-04 (forgotten droplet billing) | `--fresh` calls `npm run destroy-droplet -- --yes`; default smoke run preserves the droplet (D-04 / D-08) so the operator can teardown explicitly via `npm run destroy-droplet` after Phase 1. |
| T-01-08 (bug-fix audit trail) | Two atomic commits on this plan (one per step); SUMMARY references both SHAs. Any future Task 2 fixes land as additional atomic commits. |

## Self-Check: PASSED

- `scripts/smoke-test.ts` — FOUND
- `droplet/github-backup.sh` carries `BACKUP_SUMMARY upstream=` line — FOUND (line 152)
- commit `210dc53` (BACKUP_SUMMARY marker) — FOUND in `git log --oneline -5`
- commit `034bd56` (smoke-test.ts orchestrator) — FOUND in `git log --oneline -5`
- `npx tsc --noEmit` exit 0 — VERIFIED
- No live cloud calls made — VERIFIED (no `npm run smoke-test`, no `doctl`, no SSH executed)
