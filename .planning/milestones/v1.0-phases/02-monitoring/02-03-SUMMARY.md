---
phase: 02-monitoring
plan: 03
subsystem: monitoring
tags: [typescript, ssh, spawn-sync, npm-script, wrapper]

requires:
  - phase: 02-monitoring
    provides: droplet-side github-backup-status.sh binary written by 02-02-PLAN
  - phase: 01-verify-pipeline
    provides: scripts/lib/config.ts (loadConfig, loadDropletInfo, bail) + scripts/lib/ssh.ts (expandHome) + .droplet.json + config.json contract
provides:
  - "Local TypeScript wrapper scripts/status.ts — SSHes to droplet, runs github-backup-status.sh, propagates exit code"
  - "npm run status entry in package.json"
affects: ["02-04", "06-multi-source"]

tech-stack:
  added: []
  patterns:
    - "spawnSync array-form (no shell expansion) for SSH commands with operator-supplied argv"
    - "Argv allow-list regex (ALLOWED_FLAG_RE) for shell-meta defense at the local boundary"

key-files:
  created:
    - scripts/status.ts
  modified:
    - package.json

key-decisions:
  - "Do not reuse sshFlags() helper — it returns a quoted-string fragment intended for the shell form; we use spawnSync array-form. Build the flag array inline (same flags, no quoting issues)."
  - "Allow-list regex is [A-Za-z0-9._=/-]+ — covers every realistic status flag (--json, --verbose, -v, -h, --help) without leaving room for shell-meta."
  - "process.exit(result.status ?? 1) — fall back to 1 only on null status (ssh transport error already bails earlier via result.error branch)."
  - "No CLI help on the local side — `npm run status -- --help` forwards `--help` to the droplet binary, which is the source of truth. One help surface, one place to update."

patterns-established:
  - "Local-side npm script + remote-side bash binary, glued by SSH + argv forwarding (operator chooses surface)"
  - "Allow-list at trust boundary (not deny-list) — same posture as scripts/lib/config.ts SHELL_SAFE check"

requirements-completed: [MON-01, MON-02, MON-03]

duration: 4min
completed: 2026-05-13
---

# Phase 02 Plan 03: Local status wrapper Summary

**`npm run status` from the operator's laptop produces the same output as running `github-backup-status.sh` directly on the droplet; flags after `--` forward verbatim; remote exit code propagates unchanged.**

## Performance

- **Duration:** ~4 min
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 edited)

## Accomplishments

- Single-file local wrapper at `scripts/status.ts` (63 lines, no new dependencies)
- Argv allow-list rejects shell-meta locally with a clear bail message
- npm script registered: `npm run status`, `npm run status -- --json`, etc.
- Remote exit code (0/1/2/3 per D-13) propagates to local shell exit code

## Task Commits

1. **Task 1: Create scripts/status.ts** — `185d7fb` (feat)
2. **Task 2: Register npm script entry** — `7934108` (feat)

## Files Created/Modified

- `scripts/status.ts` (new). Imports `loadConfig`, `loadDropletInfo`, `bail` from `./lib/config`; `expandHome` from `./lib/ssh`. Builds the SSH argv array inline (no `sshFlags()` reuse — array-form spawnSync needs unquoted paths). Allow-list regex defined once at module scope and used twice (declaration + inside the for-of loop).
- `package.json` — single entry added: `"status": "tsx scripts/status.ts"` between `"smoke-test"` and `"verify:phase-1"`.

## Verification

- `npx --yes tsc --noEmit -p tsconfig.json` → exit 0, zero new errors
- `node -e "require('./package.json').scripts.status"` → prints `tsx scripts/status.ts`
- All four pre-existing scripts (create-droplet, bootstrap-droplet, smoke-test, verify:phase-1) still present and unchanged
- File counts: `ALLOWED_FLAG_RE` appears 2× (declaration + loop reference), `process.exit(result.status ?? 1)` appears 1×
- Lines: 63 (within plan's 30-100 sanity range)

End-to-end against a real droplet is owned by Plan 02-04 (`scripts/verify/phase-2.ts` Group 4).

## Plan Deviations from Written Steps

None. The plan's scripts-block reference layout (smoke-test → status → verify:phase-1) was used as the insertion target; existing extra entries (`restore`, `verify:phase-3`, `verify:phase-4`, `register-webhooks`) added by Phases 3/4 are unaffected.

## Issues Encountered

None.

## Self-Check: PASSED

Ready for Plan 02-04 (`scripts/verify/phase-2.ts` + `verify:phase-2` npm script).
