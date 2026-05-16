---
status: partial
phase: 07-droplet-artifact-shipping
source: [07-VERIFICATION.md]
started: 2026-05-16
updated: 2026-05-16
---

## Current Test

[awaiting operator]

## Tests

### 1. Run `npm run verify:phase-7` against a freshly-bootstrapped DigitalOcean droplet (SC#4 / D-03 / D-08 — live e2e gate)
expected: Script exits 0, prints all four group banners (`— Group 1: sync-one-repo.sh …`, `— Group 2: detect-account-type.sh …`, `— Group 3: filter-repos.sh …`, `— Group 4: …`), and finishes with `✓ verify:phase-7 PASSED (DROPLET-01/02/03 contracts hold)`. Re-running it must also exit 0 (RESULT_TAG action shifts from `clone` to `update`; assertions accept both).
preconditions:
  - `.droplet.json` exists locally (created by `npm run create-droplet`).
  - Droplet is bootstrapped (`npm run bootstrap-droplet` has uploaded `droplet/*.{sh,js}` + `droplet/lib/*.sh`).
  - `config.json` resolves at least one allow-matched repo for SC#4 — set `webhookTestRepo` or `restoreTestRepo` to a small repo, OR have a source with non-empty allow whose `gh api` page contains a passing slug.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
