---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Production hardening
status: planning
last_updated: "2026-05-16T07:57:38.628Z"
last_activity: 2026-05-16
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# State

**Project**: github-backup
**Version**: v1.0
**Initialized**: 2026-04-29
**Status**: phase-1-executed-unverified

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-05-16 — Milestone v1.1 started

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

## Deferred Items

Items acknowledged and deferred at milestone close on 2026-05-16:

| Category | Item | Status |
|----------|------|--------|
| todo | Missing sync-one-repo.sh causes backup failure | deferred |
| todo | Missing Phase-6 lib helpers break source detection | deferred |
| todo | Webhook listener files optional in uploader but required at runtime | deferred |
| uat_gap | Phase 01: 8 pending UAT scenarios | deferred |
| uat_gap | Phase 03: 6 pending UAT scenarios | deferred |
| uat_gap | Phase 04: 4 pending UAT scenarios | deferred |
| verification_gap | Phase 03: VERIFICATION.md human_needed | deferred |
| verification_gap | Phase 04: VERIFICATION.md human_needed | deferred |

Known deferred items at close: 8 (see above)

## Blockers

(none)

## Pending

- Run smoke-test against real DO droplet + real GitHub user to validate Phase 1 success criteria 1–5 (PROV-01/02, BACKUP-01/02/03, ACCESS-01, TEST-01, TEST-02)
- On smoke-test pass: mark Phase 1 complete; transition to Phase 2 (Monitoring)
- Phase 2 planned 2026-05-12: 02-01 (instrument `github-backup.sh` + `bootstrap.sh` for `last-run.json` writer + `/var/lib/github-backup` mode 700) + 02-02 (`droplet/github-backup-status.sh` reader/formatter, text+JSON, D-10 staleness lookup table) + 02-03 (`scripts/status.ts` local SSH wrapper + npm script) + 02-04 (`scripts/verify/phase-2.ts` + npm script). Waves: 1 = {01, 02} parallel; 2 = {03}; 3 = {04}. last-run.json schema locked in Plan 01 and re-stated in Plans 02 + 04 for self-containment. Webhook amendment from 2026-05-11 explicitly deferred to Phase 3 per CONTEXT.md.
- Phase 3 plan must capture: Caddy reverse-proxy config, LE issuance via ACME, `hostname` + `letsEncryptEmail` config keys, systemd unit for listener, TEST-03 design
- Phase 5 EXECUTED 2026-05-15 (commits 7093794, 332bdcd): 05-01 added `--rotate-env` + ssh probe + conditional upload to `scripts/bootstrap-droplet.ts` (token-gate moved to upload branch, skip-path tolerates unset GITHUB_TOKEN); 05-02 created `scripts/verify/phase-5.ts` (5 groups: pre-conds / preservation / cron-marker / --rotate-env round-trip env-gated / listener-survival probe-gated), wired `npm run verify:phase-5`, added README `## Lifecycle` section. Static gates pass (`npx tsc --noEmit` exit 0; both SUMMARY.md files written). Live-droplet end-to-end verification still owed — operator runs `npm run verify:phase-5` against an existing droplet.
- Phase 6 EXECUTED 2026-05-15: 06-01 (TS multi-source Config + writeBackupEnv + droplet/lib upload + npm scripts) + 06-02 (bash detect-account-type + filter-repos + github-backup.sh outer loop + namespaced sync-one-repo.sh + bootstrap.sh per-source mkdir) + 06-03 (migrate-mirrors.ts + verify/phase-6.ts 5 groups + smoke-test multi-source assertions + config.example.json + README Multi-source section). 13 commits. Static gates: tsc --noEmit clean, bash -n clean on all 5 droplet scripts. Live-droplet end-to-end UAT still owed (npm run verify:phase-6 + npm run smoke-test against a 2-source droplet with one source carrying a non-empty deny glob). Two known holes deferred to Phase 3.x: (1) webhook-listener.js still uses single ALLOWED_SOURCE — multi-source webhook routing not wired (events for source #2 currently 404); (2) webhook-listener.js does NOT source droplet/lib/filter-repos.sh — a push to a denied repo would still trigger a sync (cron path is correctly filtered; webhook path isn't). Phase 6 plan 03 group 6 explicitly defers both to Phase 3 verify.
- Cross-phase contract: Phase 3 plan MUST source `droplet/lib/filter-repos.sh` in the webhook handler so REPOS-01 SC#4 (deny wins) applies to webhook-triggered syncs (informational in 06-03 group 6; assertion owned by Phase 3 verify).
- Phase 3.x follow-ups identified during Phase 6 execution: (a) webhook-listener.js multi-source routing — read GITHUB_SOURCES env list, accept any owner in it (not just GITHUB_USER_OR_ORG); (b) webhook-listener.js sources droplet/lib/filter-repos.sh and applies filter_repos before dispatching sync-one-repo.sh; (c) Phase 3 verify (verify:phase-3.ts) extended to assert both behaviours.
- Revisit smoke-test step 8 (`gh api` user-vs-org logic) RESOLVED by Phase 6 plan 06-02 task 1 (`detect-account-type.sh`)
- Phase 6 deviations: (a) sync-one-repo.sh updated despite not being in plan 06-02 files_modified — D-07 namespaced layout truth required it; (b) verify/phase-3.ts updated for cfg.githubUserOrOrg → cfg.sources[0].name shift (legacy field now optional); both documented in their plan SUMMARYs.

## Accumulated Context

### Pending Todos

- **Missing sync-one-repo.sh** — `github-backup.sh:280` calls it; bootstrap never uploads it. Created 2026-05-16.
- **Missing Phase-6 lib helpers** — `detect-account-type.sh` + `filter-repos.sh` sourced but absent from `droplet/lib/`. Created 2026-05-16.
- **Webhook files optional in uploader** — `bootstrap.sh:202` hard-fails if missing; uploader silently skips. Created 2026-05-16.

## Plan-checker notes (Phase 1, non-blocking)

5 quality refinements flagged (4 LOW, 1 MED), no blockers. See `.planning/phases/01-verify-pipeline/` plan files. MED issue (#4): smoke-test step 8 duplicates `gh api` user-vs-org logic from `droplet/github-backup.sh` — single-source safe for Phase 1, revisit at Phase 6 (multi-source).

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
