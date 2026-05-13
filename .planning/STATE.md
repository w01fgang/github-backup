---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: ready_to_plan
last_updated: "2026-05-13T03:37:31.025Z"
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 19
  completed_plans: 6
  percent: 50
---

# State

**Project**: github-backup
**Version**: v1.0
**Initialized**: 2026-04-29
**Status**: phase-1-executed-unverified

## Current Position

Phase: 04
Plan: Not started

- Milestone: v1
- Phase: 1 (Verify pipeline) — 3 plans coded; NR-01..09 fixes applied from review iter3
- Roadmap reordered 2026-05-11 (Option B): webhook listener moved to Phase 3 to ship core "push → near-instant sync" value earlier; restore → 4, idempotency → 5, multi-source+REPOS-01 → 6

### Phase dir → roadmap-number mapping

Dirs renamed 2026-05-12 (at start of plan-phase 3) to match new roadmap order:

| Dir | Roadmap # | Prior dir name |
|-----|-----------|----------------|
| `01-verify-pipeline` | 1 | (unchanged) |
| `02-monitoring` | 2 | (unchanged) |
| `03-webhook` | 3 | `06-webhook` |
| `04-restore` | 4 | `03-restore` |
| `05-teardown` | 5 | `04-teardown` |
| `06-multi-source` | 6 | `05-multi-source` |

Inner CONTEXT/DISCUSSION files renumbered in lock-step (e.g. `06-CONTEXT.md` → `03-CONTEXT.md`).

## Decisions

(See PROJECT.md → Key Decisions, `.planning/phases/01-verify-pipeline/01-CONTEXT.md`, `.planning/phases/02-monitoring/02-CONTEXT.md`)

Recent additions (2026-05-11):

- Webhook TLS via Caddy + Let's Encrypt; operator provides DNS A record before bootstrap
- Per-repo allow/deny globs (REPOS-01) added to Phase 6
- Root SSH accepted for v1; non-root deferred to v2

## Blockers

(none)

## Pending

- Run smoke-test against real DO droplet + real GitHub user to validate Phase 1 success criteria 1–5 (PROV-01/02, BACKUP-01/02/03, ACCESS-01, TEST-01, TEST-02)
- On smoke-test pass: mark Phase 1 complete; transition to Phase 2 (Monitoring)
- Phase 2 planned 2026-05-12: 02-01 (instrument `github-backup.sh` + `bootstrap.sh` for `last-run.json` writer + `/var/lib/github-backup` mode 700) + 02-02 (`droplet/github-backup-status.sh` reader/formatter, text+JSON, D-10 staleness lookup table) + 02-03 (`scripts/status.ts` local SSH wrapper + npm script) + 02-04 (`scripts/verify/phase-2.ts` + npm script). Waves: 1 = {01, 02} parallel; 2 = {03}; 3 = {04}. last-run.json schema locked in Plan 01 and re-stated in Plans 02 + 04 for self-containment. Webhook amendment from 2026-05-11 explicitly deferred to Phase 3 per CONTEXT.md.
- Phase 3 plan must capture: Caddy reverse-proxy config, LE issuance via ACME, `hostname` + `letsEncryptEmail` config keys, systemd unit for listener, TEST-03 design
- Phase 5 planned 2026-05-12: 05-01 (bootstrap idempotency in `scripts/bootstrap-droplet.ts`) + 05-02 (`scripts/verify/phase-5.ts` + README Lifecycle). Both Wave 1, no file overlap. SC#3 (listener survival) covered by Group 5 probe-gated on `github-backup-webhook.service` install — activates after Phase 3 ships.
- Phase 6 planned 2026-05-12: 06-01 (TS: extend `Config` w/ `githubSources` + `repos.allow/deny`, multi-source `backup.env` writer in `bootstrap-droplet.ts`, upload `droplet/lib/*.sh`, wire `migrate-mirrors` + `verify:phase-6` npm scripts) + 06-02 (bash: extract `droplet/lib/detect-account-type.sh` D-05, new `droplet/lib/filter-repos.sh` glob filter, rewrite `github-backup.sh` outer source loop + REPOS-01 filter + namespaced layout + legacy auto-migration D-08 + per-source `BACKUP_SOURCE_SUMMARY` D-16) + 06-03 (`scripts/migrate-mirrors.ts` D-09, `scripts/verify/phase-6.ts` 5 groups inc. REPOS-01 deny-on-disk + slot-cross-check, smoke-test extension, `config.example.json` 2-source example, README Multi-source section). Waves: 1 = {06-01, 06-02} parallel (no file overlap); 2 = {06-03}. Slot algorithm contract documented in both 06-01 task 2 and 06-02 task 3.
- Cross-phase contract: Phase 3 plan MUST source `droplet/lib/filter-repos.sh` in the webhook handler so REPOS-01 SC#4 (deny wins) applies to webhook-triggered syncs (informational in 06-03 group 6; assertion owned by Phase 3 verify).
- Revisit smoke-test step 8 (`gh api` user-vs-org logic) RESOLVED by Phase 6 plan 06-02 task 1 (`detect-account-type.sh`)

## Plan-checker notes (Phase 1, non-blocking)

5 quality refinements flagged (4 LOW, 1 MED), no blockers. See `.planning/phases/01-verify-pipeline/` plan files. MED issue (#4): smoke-test step 8 duplicates `gh api` user-vs-org logic from `droplet/github-backup.sh` — single-source safe for Phase 1, revisit at Phase 6 (multi-source).
