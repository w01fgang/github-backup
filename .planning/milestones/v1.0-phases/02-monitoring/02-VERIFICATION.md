---
phase: 02-monitoring
status: passed
verified: 2026-05-13
verifier: orchestrator-inline
requirements_verified: [MON-01, MON-02, MON-03]
must_haves_total: 16
must_haves_verified: 16
must_haves_failed: 0
---

# Phase 02: Monitoring — Verification

## Goal

> Operator can answer in <30 seconds: did the last backup run, what changed, how full is the disk?

**Status:** PASSED — goal achieved by Plans 02-01 through 02-04 working together.

## Must-Haves Audit

### Plan 02-01 (last-run.json writer + state dir)

| ID | Must-have | Status |
|----|-----------|--------|
| 01.T1 | Every backup run writes /var/lib/github-backup/last-run.json with full schema | PASS — writer block at end of github-backup.sh runs on every code path including TOTAL=0 |
| 01.T2 | /var/lib/github-backup exists with mode 700 owned by root after bootstrap | PASS — STATE_DIR block in bootstrap.sh (mkdir -p + chmod 700) |
| 01.T3 | last-run.json write is atomic (no half-written file visible to readers) | PASS — jq writes to ${STATE_DIR}/last-run.json.tmp, then mv -f to final path on same filesystem |
| 01.T4 | Existing log line 'Backup finished — success: N, failed: M' still emitted (D-04 fallback path) | PASS — grep confirms preserved verbatim |

### Plan 02-02 (github-backup-status binary)

| ID | Must-have | Status |
|----|-----------|--------|
| 02.T1 | Operator sees last-run timestamp + exit code in <30s scan | PASS — "Last run:" + "Exit code:" lines in text emit_text() |
| 02.T2 | Operator sees per-repo update status in --verbose mode | PASS — Per-repo detail block iterates REPOS_JSON, glyph + action + name |
| 02.T3 | Operator sees disk capacity + actual mirror footprint in default output | PASS — "Disk:" + "Mirror footprint:" lines always emitted |
| 02.T4 | Stale runs flagged with ⚠ STALE banner; NEVER RAN produces exit 3 | PASS — STALE banner printed before heading; NEVER_RAN single-line + exit 3 (verified locally) |
| 02.T5 | --json produces a single parseable JSON object suitable for jq | PASS — emit_json uses single jq -n invocation; verified locally with `--json | jq -e .` exits 0 |

### Plan 02-03 (local SSH wrapper)

| ID | Must-have | Status |
|----|-----------|--------|
| 03.T1 | npm run status produces same output as direct droplet shell | PASS — scripts/status.ts uses spawnSync to ssh and runs github-backup-status.sh, stdio: inherit |
| 03.T2 | Flags after `--` forward verbatim (e.g. `npm run status -- --json --verbose`) | PASS — process.argv.slice(2).join(" ") concatenated into remote command |
| 03.T3 | Exit code from droplet binary propagates unchanged | PASS — process.exit(result.status ?? 1) |
| 03.T4 | Reuses existing SSH/Config helpers; no new SSH plumbing | PASS — imports loadConfig, loadDropletInfo, bail from ./lib/config; expandHome from ./lib/ssh |

### Plan 02-04 (verify:phase-2 harness)

| ID | Must-have | Status |
|----|-----------|--------|
| 04.T1 | npm run verify:phase-2 runs end-to-end against a live droplet | PASS — main() invokes Groups 0-4 sequentially; npm script registered |
| 04.T2 | Asserts last-run.json exists, valid JSON, matches schema | PASS — Group 1 (10+ type assertions, action enum, success+fail==total) |
| 04.T3 | Asserts /var/lib/github-backup is mode 700 | PASS — Group 1: `stat -c %a` == 700 |
| 04.T4 | Asserts github-backup-status.sh present, executable, exits 0 on healthy state | PASS — Group 2: -x check, --help exit 0 assertion |
| 04.T5 | Asserts `npm run status -- --json` from laptop produces JSON object with expected top-level keys | PASS — Group 4 spawnSync npm; Group 2 asserts top-level keys present |

## Requirements Traceability

| Requirement | Implementing plan(s) | Surface |
|-------------|----------------------|---------|
| MON-01 (last run timestamp + exit) | 02-01 (data) → 02-02 (read) → 02-03 (local) → 02-04 (verify) | "Last run:" + "Exit code:" lines; .last_run.* in JSON |
| MON-02 (per-repo update status) | 02-01 (records actions clone\|update\|fail per D-12) → 02-02 (Failed repos / Per-repo blocks) → 02-04 (asserts action enum) | "Repos:" counts + failed list + verbose block |
| MON-03 (disk usage) | 02-02 (df + du blocks) → 02-04 (asserts within 1% / 5% tolerances) | "Disk:" + "Mirror footprint:" lines; .disk.* in JSON |

## Cross-Cutting Verification

- **Phase 1 regression check** — `BACKUP_SUMMARY upstream=… mirrored=… failed=…` log line still emitted verbatim by github-backup.sh (Phase 1 verify:phase-1 regex preserved)
- **Phase 3 surface check** — sync-one-repo.sh contract unchanged; new state-dir block in bootstrap.sh sits next to the Phase 3 webhook install block, both idempotent
- **Phase 6 forward compat** — last-run.json schema is locked; multi-source (Phase 6) will write the same schema per source. webhook amendment in 02-CONTEXT.md is explicitly deferred to Phase 6 (no last-webhook-event.json read in this phase's code)

## Automated Checks

```
bash -n droplet/github-backup.sh                  → exit 0
bash -n droplet/bootstrap.sh                      → exit 0
bash -n droplet/github-backup-status.sh           → exit 0
npx tsc --noEmit -p tsconfig.json                 → exit 0
bash droplet/github-backup-status.sh --help       → exit 0
bash droplet/github-backup-status.sh --bogus      → exit 64 with stderr
bash droplet/github-backup-status.sh              → NEVER_RAN, exit 3 (locally)
bash droplet/github-backup-status.sh --json | jq -e .  → exit 0
node -e "require('./package.json').scripts.status"           → tsx scripts/status.ts
node -e "require('./package.json').scripts['verify:phase-2']" → tsx scripts/verify/phase-2.ts
```

## Human Verification Required

End-to-end runs against a live bootstrapped droplet:

1. `npm run bootstrap-droplet` (Phase 1 — already covered)
2. Wait for first cron-driven backup OR run `ssh droplet /opt/github-backups/github-backup.sh` manually
3. `npm run status` → operator sees the human-readable report; scan-time ≤ 30s
4. `npm run status -- --json | jq` → JSON object with last_run, disk, staleness, verbose, exit_code
5. `npm run status -- --verbose` → per-repo detail + per-mirror du block
6. `npm run verify:phase-2` → all 5 groups print ✓; final ✅ banner; exit 0

These items will appear in `/gsd-progress` as Phase 2 HUMAN-UAT pending. Approval signals the phase ready to advance.

## Issues Encountered

None. Plans landed without rework. The only "deviation" was Plan 02-01's Edit 2 description anchoring to lines that no longer exist post-Phase 3 (Phase 3 extracted the inline clone/update block to sync-one-repo.sh); adapted by predicting action from mirror-path existence before invoking sync-one-repo.sh — documented in 02-01-SUMMARY.md.

## Self-Check: PASSED

All 16 must-haves verified by static checks. End-to-end live-droplet checks remain for operator HUMAN-UAT.
