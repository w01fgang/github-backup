---
phase: 01-verify-pipeline
plan: 02
subsystem: testing
tags: [verify, ssh, doctl, assertions, d-07, d-02]
requires:
  - phase: 01-verify-pipeline (plan 01)
    provides: "scripts/lib/{ssh,doctl,config}.ts shared helpers + npm script wiring"
provides:
  - "scripts/verify/phase-1.ts — four D-07 assertion groups, fail-fast harness"
  - "Standalone D-02 100% pass-bar lock (mirrored == upstream && failed == 0)"
  - "BACKUP_SUMMARY regex contract on the verify side (bash side owned by plan 01-03 task 1)"
affects:
  - 01-03-smoke-test (smoke runner reuses sibling assertions; D-02 lock now lives in verify, not smoke)
  - all future phases (each must keep verify:phase-1 green to inherit baseline)
tech-stack:
  added: []
  patterns:
    - "Per-phase verify script via local assert(cond,msg) — no test framework"
    - "Fail-fast on first failed invariant; prints ✓/✗ + assertion message only"
    - "BACKUP_SUMMARY marker as cross-language contract (bash emits, TS parses)"
key-files:
  created:
    - scripts/verify/phase-1.ts
  modified: []
key-decisions:
  - "Captured stdout via runCapture wrapper rather than extending sshRun signature — sshRun used by other call sites verbatim, no need to widen its API"
  - "Group 4 clone uses GIT_SSH_COMMAND env var with sshFlags() rather than ssh-config — keeps the same auth contract as every other helper without polluting ~/.ssh/config"
  - "Touched expandHome via `void expandHome` so the import stays explicit even though sshFlags transitively calls it — eases future grep audits"
patterns-established:
  - "verify:phase-N harness: per-phase TS, four-group invariant blocks, hard asserts only"
  - "BACKUP_SUMMARY contract: regex on TS side, single-line emit on bash side (plan 01-03 task 1)"
requirements-completed:
  - PROV-01
  - PROV-02
  - BACKUP-01
  - BACKUP-02
  - BACKUP-03
  - ACCESS-01
  - TEST-02
duration: 8min
completed: 2026-05-01
---

# Phase 01 Plan 02: Verify-script Summary

**TypeScript assertion harness wiring four D-07 invariant groups against a live droplet, with the standalone D-02 100% pass-bar lock parsing the BACKUP_SUMMARY marker.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-01T15:31:00Z
- **Completed:** 2026-05-01T15:39:07Z
- **Tasks:** 1
- **Files modified:** 1 (new)

## Accomplishments

- `npm run verify:phase-1` exits 0 only when all four D-07 groups pass
- Group 3 enforces D-02 standalone: `mirrored == upstream && failed == 0`, plus a filesystem cross-check (`ls *.git | wc -l == mirrored`)
- 15 `assert(...)` calls — well above the plan's ≥8 floor
- Imports come exclusively from `scripts/lib/*` (ssh, doctl, config) — no helper duplication
- Plan's automated gate passes: tsc clean, all five grep gates green

## Task Commits

1. **Task 1: Implement scripts/verify/phase-1.ts assertion harness** — `4c36cd1` (feat)

## Files Created/Modified

- `scripts/verify/phase-1.ts` — 310 lines, 15 asserts. Loads `config.json` + `.droplet.json`, runs the four groups in order, fail-fast.

## D-07 Assertion Coverage

| Group | D-07 ref | Assertions |
|-------|----------|------------|
| 1 — Provision | D-07.1 | `.droplet.json` id valid; `doctl droplet get` status=="active"; firewall present + droplet attached |
| 2 — Bootstrap (SSH) | D-07.2 | `backup.env` mode 600; bootstrap.sh / install-cron.sh / github-backup.sh present + executable; crontab contains `# github-backup-managed`; `gh auth status` exits 0 |
| 3 — Backup-ran (D-02 lock) | D-07.3 | Triggers `github-backup.sh`; tail log has exactly one `BACKUP_SUMMARY` line; `mirrored == upstream && failed == 0`; fs `.git` count == mirrored |
| 4 — Clone-probe | D-07.4 | mkdtemp; `git clone` over SSH from `/opt/github-backups/<repo>.git`; `git rev-parse HEAD` is 40-hex; `for-each-ref` count > 0; tmpdir cleaned on success, retained on failure |

## BACKUP_SUMMARY contract confirmation

The verify script parses lines matching:

```
^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$
```

Plan 01-03 task 1 owns the bash diff that emits this line as the final log entry on a successful backup run inside `droplet/github-backup.sh`. If executed before that bash diff lands, Group 3's match-count assertion will fail with `tail of /var/log/github-backup.log contains exactly one BACKUP_SUMMARY line (got 0)` — that is the intended cross-plan failure mode (verify cannot pass without the contract on both sides).

## Decisions Made

- Captured remote stdout via a local `sshCapture()` helper that mirrors `sshRun`'s single-quote wrapping but routes through `runCapture` — avoids widening `sshRun`'s signature, which existing call sites depend on verbatim.
- Group 4 clone uses `GIT_SSH_COMMAND="ssh ${sshFlags(key)}"` rather than rewriting `~/.ssh/config` — same auth surface as every other helper, zero side-effects on operator's box.

## Deviations from Plan

None — plan executed exactly as written.

The plan's `<interfaces>` block named `sshRun` for Group 2 stat probes but immediately noted "Use `runCapture` instead of `sshRun` so you can read stdout; build the ssh command with `sshFlags`." That guidance was followed, packaged into the local `sshCapture` helper for readability across all four groups.

## Threat Mitigations Applied

| Threat | Mitigation in code |
|--------|--------------------|
| T-01-02-01 (SSH host spoofing) | All ssh invocations go through `sshFlags(key)` — accept-new + BatchMode=yes inherited |
| T-01-02-02 (output leaking secrets) | Asserts print only the message + ✓/✗; `backup.env` is probed for mode/existence only, contents never read |
| T-01-02-03 (clone-probe writing outside tmpdir) | `fs.mkdtempSync(os.tmpdir() + '/gh-backup-verify-')`; cleaned on success via `fs.rmSync`, retained on failure for inspection |
| T-01-02-04 (privilege escalation via github-backup.sh) | accepted — no new surface (verify only invokes what cron would run) |
| T-01-02-05 (BACKUP_SUMMARY spoofing in log) | accepted — log file is droplet-local; marker is correctness contract, not security boundary |

## Issues Encountered

None.

## Sanity Check Performed

- `npx tsc --noEmit -p tsconfig.json` — clean
- Plan's full automated gate (tsc + 5 grep gates) — `OK`
- `npx tsx scripts/verify/phase-1.ts` with no `config.json` — exits 1 with bail message (matches done criterion: "Running against an offline/missing droplet exits non-zero").

## Self-Check: PASSED

- `scripts/verify/phase-1.ts` — FOUND
- commit `4c36cd1` — FOUND
- 15 assert() calls — FOUND (≥8 required)
- `mirrored === upstream && failed === 0` — FOUND
- `from "../lib/{ssh,doctl,config}"` imports — FOUND

## Next Phase Readiness

- Phase 1 verify gate is implementable end-to-end as soon as plan 01-03 task 1's bash diff (BACKUP_SUMMARY emit) and a real droplet are in place.
- Smoke runner (plan 01-03) can reuse the BACKUP_SUMMARY parse pattern; D-02 count-equality lock is now standalone in verify, so smoke does not need to carry it alone.

---
*Phase: 01-verify-pipeline*
*Completed: 2026-05-01*
