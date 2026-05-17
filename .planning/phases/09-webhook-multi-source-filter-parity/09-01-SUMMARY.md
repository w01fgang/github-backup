---
phase: 09-webhook-multi-source-filter-parity
plan: 01
subsystem: webhook
tags: [webhook, multi-source, listener, backup-env]

requires:
  - phase: 06-multi-source
    provides: GITHUB_SOURCES env contract + per-source ALLOW/DENY slot convention
  - phase: 07-droplet-artifact-shipping
    provides: backup.env shipping path + bootstrap-droplet writeBackupEnv contract
  - phase: 08-bootstrap-uploader-hardening
    provides: hardened bootstrap pipeline (Phase 9 listener relies on backup.env being on disk)
provides:
  - droplet/webhook-listener.js accepts events for any owner in GITHUB_SOURCES (no longer 404s on source #2+)
  - parseEnvFile(path) helper for /opt/github-backups/backup.env (in-process, zero new deps)
  - Per-request env re-read so operator-regen of backup.env requires no service restart
  - HTTP 500 + reason=backup_env_unreadable fail-loud posture (D-02)
affects: [verify:phase-3 Group 7 (Plan 09-02), Phase 10 live-droplet UAT]

tech-stack:
  added: []
  patterns:
    - "Per-request env re-read (deliberately diverges from boot-only style; documented in code)"
    - "Set membership over GITHUB_SOURCES.split(/\\s+/) (matches cron-path slot iteration shape)"

key-files:
  created: []
  modified:
    - droplet/webhook-listener.js

key-decisions:
  - "D-01: per-request fs.readFileSync of /opt/github-backups/backup.env — no boot-load + fs.watch glue"
  - "D-02: parse failure OR empty GITHUB_SOURCES → HTTP 500 + reason=backup_env_unreadable (no cached-last-good, no 503)"
  - "D-03: NO filter_repos.sh sourcing on webhook path — per-repo webhook = explicit operator consent (WEBHOOK-04 dropped 2026-05-17)"
  - "Set membership check lands AFTER owner/repo extraction and BEFORE ARG_RE shape guard (preserves established handler order)"
  - "Dispatch argv (SYNC_SCRIPT, owner, owner, repo) byte-identical — source==owner by Phase 6 design"
  - "Startup banner now references env file path, not parsed source list"

patterns-established:
  - "Hand-rolled env parser: 20 lines, handles K=V / K=\"V V\" / # comments / blank lines; no new npm dep"
  - "Per-request fail-loud on env read/parse error (matches webhook-listener.js fail-loud convention)"

requirements-completed: [WEBHOOK-03]

duration: ~18min
completed: 2026-05-17
---

# Phase 09 Plan 01: Multi-source webhook listener Summary

**`droplet/webhook-listener.js` now accepts events for any owner in `GITHUB_SOURCES` via a per-request re-read of `/opt/github-backups/backup.env`; the single-source 404 gate is gone.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-05-17T10:51:38Z
- **Completed:** 2026-05-17T~11:09:00Z
- **Tasks:** 2 completed (Task 1 production edit, Task 2 verify-only)
- **Files modified:** 1

## Accomplishments

- Replaced single-source `owner !== ALLOWED_SOURCE` gate with per-request env re-read + `new Set(GITHUB_SOURCES.split).has(owner)` membership test (WEBHOOK-03 landed).
- Added `parseEnvFile(filePath)` helper (~20 lines) inline — handles `K=V`, `K="V V"`, `#` comments, blank lines. No new npm dependency.
- Removed boot-time `ALLOWED_SOURCE` const, the `GITHUB_USER_OR_ORG` env-var reference, and the boot-time `bail` for it.
- On `parseEnvFile` throw OR empty `GITHUB_SOURCES`: HTTP 500 + structured log line `reason=backup_env_unreadable` (D-02). GitHub retries 5xx with backoff so transient failures self-recover.
- Startup banner now prints `(env=${BACKUP_ENV_PATH})` instead of the removed `(source=${ALLOWED_SOURCE})`.
- Dispatch line `spawnSync("/usr/bin/systemd-run", ["--collect","--no-block", SYNC_SCRIPT, owner, owner, repo], ...)` unchanged in argv shape (source == owner by Phase 6 design).
- Header comment block updated: HTTP-500 documentation now lists `backup.env unreadable OR systemd-run dispatch failure`, env-var section drops `GITHUB_USER_OR_ORG` and adds per-request `GITHUB_SOURCES` note.

## Task Commits

1. **Task 1: Add parseEnvFile helper, refactor boot-time env loading, replace single-source check, update startup banner** — `e86c4c1` (feat)
2. **Task 2: Local synthetic-handler smoke test (no droplet)** — verify-only (no files modified; assertions covered by Task 1 commit's done criteria + post-commit grep run)

## Files Created/Modified

- `droplet/webhook-listener.js` (+64 / -10) — multi-source per-request listener; parseEnvFile helper; D-02 500-on-parse-error path; updated header comment.

## Done Criteria Results

All Task 1 + Task 2 done criteria verified post-commit:

| Check | Result |
|-------|--------|
| `node -c droplet/webhook-listener.js` exits 0 | PASS |
| `grep -c "ALLOWED_SOURCE" droplet/webhook-listener.js` == 0 | PASS (0) |
| `grep -c "GITHUB_USER_OR_ORG" droplet/webhook-listener.js` == 0 | PASS (0) |
| `grep -c "parseEnvFile" droplet/webhook-listener.js` ≥ 2 | PASS (2) |
| `grep -c "backup_env_unreadable" droplet/webhook-listener.js` == 1 | PASS (1) |
| `grep -E "SYNC_SCRIPT, owner, owner, repo"` matches dispatch | PASS |
| `grep -E "env=\${BACKUP_ENV_PATH}"` matches banner | PASS |
| `grep "allowedSources.has(owner)"` matches | PASS |
| awk: env re-read line < ARG_RE line | PASS (env@196, ARG_RE@214) |

## D-03 Explicit Exclusion (Confirmed)

- No `droplet/lib/filter-repos.sh` sourcing was added.
- No per-source allow/deny logic (`GITHUB_SOURCE_ALLOW_*`, `GITHUB_SOURCE_DENY_*`) was added.
- No "denied repo" response path was introduced.
- After Set-membership accepts the request, dispatch proceeds unchanged from pre-Phase-9 code.

## Deviations from Plan

None. Plan landed verbatim with one small in-scope cleanup: the header comment block (lines 1-31) referenced `GITHUB_USER_OR_ORG required (the allowed source for v1)` and `404 — source not in cfg (owner mismatch) OR unknown path` — these were updated to reflect the multi-source rescope so the file is internally consistent. The `done` criterion `grep -c "GITHUB_USER_OR_ORG"` == 0 required this anyway.

## Threat Model Notes

STRIDE register from PLAN.md (T-09-01..T-09-04) all dispositions hold:
- T-09-01 (Tampering on backup.env): accepted — root-owned mode-0600 file, tampering = root compromise.
- T-09-02 (DoS via per-request fs read): accepted — webhook rate-bounded, negligible cost vs HMAC + spawnSync.
- T-09-03 (Info disclosure on 500): mitigated — response body empty; log line is just `{ delivery, reason: "backup_env_unreadable" }`, no file contents / errno / stack.
- T-09-04 (Set-membership bypass): mitigated — native Set with string keys, owner re-checked by ARG_RE before spawnSync argv.

## Next Phase Readiness

- Plan 09-02 (Group 7 of `scripts/verify/phase-3.ts`) is unblocked. It POSTs synthetic HMAC-signed pushes for every `cfg.sources[]` entry and asserts each routes correctly (VALID-04).
- Live droplet still runs the pre-Phase-9 listener bytes; Phase 10 (live-droplet UAT close-out) is where the new listener actually lands on the droplet via `npm run bootstrap-droplet`.

## Self-Check: PASSED

- All `<acceptance_criteria>` from Task 1 + Task 2 re-run post-commit (table above).
- Plan-level `<verification>`: `node -c` exits 0; grep + awk assertions all pass; live behaviour deferred to Plan 02 + Phase 10 per plan's own caveat.
- `<success_criteria>`: WEBHOOK-03 implementation landed; ALLOWED_SOURCE + GITHUB_USER_OR_ORG fully removed; parseEnvFile defined + called; reason=backup_env_unreadable path exists; dispatch argv byte-identical; banner no longer references removed identifier.
