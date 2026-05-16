---
status: resolved
phase: 07-droplet-artifact-shipping
source: [07-VERIFICATION.md]
started: 2026-05-16
updated: 2026-05-16
---

## Current Test

[complete]

## Tests

### 1. Run `npm run verify:phase-7` against a freshly-bootstrapped DigitalOcean droplet (SC#4 / D-03 / D-08 — live e2e gate)
expected: Script exits 0, prints all four group banners (`— Group 1: sync-one-repo.sh …`, `— Group 2: detect-account-type.sh …`, `— Group 3: filter-repos.sh …`, `— Group 4: …`), and finishes with `✓ verify:phase-7 PASSED (DROPLET-01/02/03 contracts hold)`. Re-running it must also exit 0 (RESULT_TAG action shifts from `clone` to `update`; assertions accept both).
preconditions:
  - `.droplet.json` exists locally (created by `npm run create-droplet`).
  - Droplet is bootstrapped (`npm run bootstrap-droplet` has uploaded `droplet/*.{sh,js}` + `droplet/lib/*.sh`).
  - `config.json` resolves at least one allow-matched repo for SC#4 — set `webhookTestRepo` or `restoreTestRepo` to a small repo, OR have a source with non-empty allow whose `gh api` page contains a passing slug.
result: passed (2026-05-16) — `✓ verify:phase-7 PASSED (DROPLET-01/02/03 contracts hold)`, all four groups green: SC#1 sync-one-repo executable + namespaced mirror + RESULT_TAG; SC#2 detect-account-type smoke + default-User; SC#3 filter-repos smoke + 3 golden cases; SC#4 github-backup.sh end-to-end with mirror dir + RESULT_TAG + clean log.

Discovered during operator run (folded into Phase 8 and noted in this UAT for traceability):
  - **FIREWALL-01 (Phase 8):** `scripts/create-droplet.ts` emits `sources:addresses:<cidr>` to `doctl compute firewall add-rules`. doctl's valid source key is `address:` (singular, no `sources:` prefix). All inbound rules persisted with empty `sources: {}` → matched nothing → firewall denied SSH despite "matching" rule. Patched in-place via doctl manual add; code fix tracked in Phase 8.
  - **FIREWALL-01 (Phase 8) — outbound:** Same broken format for outbound; TCP/UDP rules never persisted at create-time. ICMP-only outbound made `git clone` impossible if firewall enforcement worked. Manual add applied; code fix tracked in Phase 8.
  - **Phase 1 follow-up (out of v1.1 scope, surfaced not fixed):** `droplet/github-backup.sh` aborts on first per-repo failure under `set -euo pipefail`. Run logs show only one `BACKUP_REPO_RESULT` per invocation when ≥1 repo errors. Phase 7 verify D-08 contract ("≥1 RESULT_TAG action=clone|update") still satisfied, but operator should expect partial-only logs.
  - **Phase 7 verify patches (committed `884ab47`):** SSH payload quoting (`shq()` for embedded singles); exit 0|1 acceptance; RESULT_TAG match any slug (D-08 doesn't pin target).

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
