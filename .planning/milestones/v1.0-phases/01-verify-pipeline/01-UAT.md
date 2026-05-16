---
status: testing
phase: 01-verify-pipeline
source:
  - 01-01-SUMMARY.md
  - 01-02-SUMMARY.md
  - 01-03-SUMMARY.md
started: 2026-05-16T00:21:21Z
updated: 2026-05-16T00:21:21Z
---

## Current Test

number: 1
name: Cold Start Smoke Test
expected: |
  Kill any running smoke/verify process. Remove `.droplet.json` if present.
  Run `npm run smoke-test` from a clean checkout. The orchestrator provisions a
  new DO droplet, bootstraps it, triggers the first backup, and exits 0. The
  bash side emits a `BACKUP_SUMMARY upstream=N mirrored=N failed=0` log line.
awaiting: user response

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running smoke/verify process. Remove `.droplet.json` if present. Run `npm run smoke-test` from a clean checkout. The orchestrator provisions a new DO droplet, bootstraps it, triggers the first backup, and exits 0. The bash side emits a `BACKUP_SUMMARY upstream=N mirrored=N failed=0` log line.
result: [pending]

### 2. Provision Droplet
expected: `npm run create-droplet` creates a real DigitalOcean droplet, writes `.droplet.json` with the droplet's id + ip + ssh user, and exits 0. The droplet is reachable over SSH using the configured key.
result: [pending]

### 3. Bootstrap Droplet
expected: `npm run bootstrap-droplet` provisions the backup user, installs `github-backup.sh` under `/opt/github-backups/`, and runs the first backup. Requires `GITHUB_TOKEN`. Exits 0; mirrored repos appear as `*.git` directories on the droplet.
result: [pending]

### 4. Verify Phase 1 Harness
expected: `npm run verify:phase-1` runs four D-07 invariant groups against the live droplet and prints ✓ lines for ~15 assertions. Group 3 enforces `mirrored == upstream && failed == 0` (D-02 100% pass bar) plus filesystem cross-check (`ls *.git | wc -l == mirrored`). Exits 0 only when all four groups pass.
result: [pending]

### 5. Real GitHub User/Org Mirrored
expected: After bootstrap, the droplet has mirrored every public repo of the configured GitHub user/org from `config.json`. Repo count on disk matches GitHub's repo count for that account. Each mirror is a bare `*.git` directory.
result: [pending]

### 6. Git Clone Over SSH Works
expected: From the operator's laptop, `git clone backup-user@<droplet-ip>:/opt/github-backups/<repo>.git` succeeds and yields a working tree with HEAD commits matching upstream. SSH auth uses the same key referenced by `config.json`.
result: [pending]

### 7. BACKUP_SUMMARY Marker Contract
expected: Tail `/var/log/github-backup.log` (or wherever the script logs). On every backup run, exactly one line of the form `BACKUP_SUMMARY upstream=<n> mirrored=<n> failed=<n>` appears immediately before the script's exit gate, on both success and failure paths. The line is parseable by the regex consumers in `scripts/verify/phase-1.ts` and `scripts/smoke-test.ts`.
result: [pending]

### 8. Destroy Droplet Safety Gates
expected: `npx tsx scripts/destroy-droplet.ts` with no `.droplet.json` present exits 1 with `Refusing to destroy: .droplet.json not found.`. With `.droplet.json` present and no `--yes` flag, it prompts y/N and refuses on empty/N. With `--yes` it destroys the droplet by id from `.droplet.json` only (never by name lookup).
result: [pending]

## Summary

total: 8
passed: 0
issues: 0
pending: 8
skipped: 0

## Gaps

[none yet]
