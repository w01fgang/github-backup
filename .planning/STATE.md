---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Production hardening
status: in-progress
last_updated: "2026-05-17T11:30:00.000Z"
last_activity: 2026-05-17 -- Phase 10 wave 1 (10-01) complete — UAT runner shipped, waves 2 + 3 await live droplet + operator
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 11
  completed_plans: 8
  percent: 72
---

# State

**Project**: github-backup
**Version**: v1.1
**Initialized**: 2026-04-29
**Status**: Phase 10 wave 1 complete; waves 2 + 3 await operator (live droplet)

## Current Position

Phase: 10 — IN PROGRESS (wave 1/3 complete)
Plan: 1 of 3 (10-01 complete; 10-02 + 10-03 are autonomous=false)
Status: Wave 1 shipped scripts/uat-runner.ts + 10-VERIFICATION.md skeleton. Waves 2 + 3 require live DigitalOcean droplet + operator action on 7 manual UAT scenarios + failure triage.
Last activity: 2026-05-17 -- Phase 10 wave 1 (10-01) complete — UAT runner shipped, waves 2 + 3 await live droplet + operator

### Phase 10 wave gate

| Wave | Plan | Autonomous | Status |
|------|------|------------|--------|
| 1 | 10-01 | true | ✓ complete (commits 39299e4, 7a3c9e7) |
| 2 | 10-02 | false | awaiting operator: run `npm run uat` against a live droplet, execute 7 MANUAL scenarios by hand, fill 10-VERIFICATION.md |
| 3 | 10-03 | false | awaiting operator: triage any failures from wave 2 (env/doc/infra inline fix vs blocking → spawn new phase) |

**To resume**: with a live droplet provisioned (`npm run create-droplet && npm run bootstrap-droplet`), an operator runs `/gsd-execute-phase 10 --wave 2` and walks through the manual scenarios. Wave 3 follows once wave 2 records every result in `10-VERIFICATION.md`.

### v1.1 phase map

| Phase | Name | Requirements | Depends on |
|-------|------|--------------|------------|
| 7 | Droplet artifact shipping | DROPLET-01, DROPLET-02, DROPLET-03 | v1.0 closed |
| 8 | Bootstrap uploader hardening | MANIFEST-01, MANIFEST-02, MANIFEST-03 | Phase 7 |
| 9 | Webhook multi-source + filter parity | WEBHOOK-03, WEBHOOK-04, VALID-04 | Phase 7 |
| 10 | Live-droplet UAT close-out | VALID-01, VALID-02, VALID-03 | Phases 7, 8, 9 |

### Phase dir → roadmap-number mapping (v1.0 archive)

Dirs renamed 2026-05-12 (at start of plan-phase 3) to match v1.0 roadmap order:

| Dir | Roadmap # | Prior dir name |
|-----|-----------|----------------|
| `01-verify-pipeline` | 1 | (unchanged) |
| `02-monitoring` | 2 | (unchanged) |
| `03-webhook` | 3 | `06-webhook` |
| `04-restore` | 4 | `03-restore` |
| `05-teardown` | 5 | `04-teardown` |
| `06-multi-source` | 6 | `05-multi-source` |

v1.0 phase artifacts archived under `.planning/milestones/v1.0-phases/`.

## Decisions

(See PROJECT.md → Key Decisions, archived v1.0 phase CONTEXTs under `.planning/milestones/v1.0-phases/`)

v1.1 roadmap decisions (2026-05-16):

- **Phase split rationale (coarse granularity, 4 phases)**: DROPLET-* form a single artifact-shipping wave; MANIFEST-* harden the uploader as a separate concern (different file, different mental model); WEBHOOK-03/04 + VALID-04 belong together because VALID-04 is the regression guard for WEBHOOK-03/04; VALID-01/02/03 are pure human-in-the-loop UAT and gated on all three bug-fix phases shipping.
- **Phase 7 before Phase 9**: WEBHOOK-04 sources `droplet/lib/filter-repos.sh`; that file must land on the droplet (DROPLET-03) before the listener can load it. Hard ordering, not preference.
- **Phase 8 before Phase 9**: not strictly required for compile, but logical — once Phase 7 ships the artifacts, Phase 8 makes them mandatory in the uploader, so by the time Phase 9 ships new droplet files the manifest enforcement catches gaps.
- **Phase 10 last**: live-droplet UAT only makes sense once 7+8+9 are deployable; closing UAT before bug fixes would re-open the same gaps.
- **Phase 7 plan 01 (2026-05-16)**: standalone `scripts/verify/phase-7.ts` reusing `scripts/lib/ssh.ts` + `scripts/lib/config.ts` only — no new SSH wrapper and no shared verify-helpers module (D-01/D-04/D-09). SC#4 e2e gate is operator-run against a freshly-bootstrapped droplet.

## Deferred Items

v1.0 close (2026-05-16) — all targeted by v1.1:

| Category | Item | Status | Resolution phase |
|----------|------|--------|------------------|
| todo | Missing sync-one-repo.sh causes backup failure | targeted | Phase 7 (DROPLET-01) |
| todo | Missing Phase-6 lib helpers break source detection | targeted | Phase 7 (DROPLET-02, DROPLET-03) |
| todo | Webhook listener files optional in uploader but required at runtime | targeted | Phase 8 (MANIFEST-02) |
| uat_gap | Phase 01: 8 pending UAT scenarios | targeted | Phase 10 (VALID-01) |
| uat_gap | Phase 03: 6 pending UAT scenarios | targeted | Phase 10 (VALID-02) |
| uat_gap | Phase 04: 4 pending UAT scenarios | targeted | Phase 10 (VALID-03) |
| verification_gap | Phase 03: VERIFICATION.md human_needed | targeted | Phase 10 (VALID-02) |
| verification_gap | Phase 04: VERIFICATION.md human_needed | targeted | Phase 10 (VALID-03) |

Plus emergent v1.1 reqs not in v1.0 deferred set:

| Category | Item | Status | Resolution phase |
|----------|------|--------|------------------|
| todo | Manifest enforcement in `bootstrap-droplet.ts` | targeted | Phase 8 (MANIFEST-01) |
| todo | README droplet file manifest section | targeted | Phase 8 (MANIFEST-03) |
| todo | `webhook-listener.js` multi-source routing | targeted | Phase 9 (WEBHOOK-03) |
| todo | `webhook-listener.js` deny-wins filter on webhook path | targeted | Phase 9 (WEBHOOK-04) |
| todo | `verify:phase-3` extension for WEBHOOK-03/04 | targeted | Phase 9 (VALID-04) |

## Blockers

(none)

## Pending

- Plan Phase 7 — `/gsd-plan-phase 7`
- Sequence after Phase 7 planning: Phase 8 (manifest hardening) and Phase 9 (webhook multi-source) can be planned independently; both depend on Phase 7 artifacts existing.
- Phase 10 plan should wait until 7/8/9 are at least executed so UAT runs against the fixed system.

## Accumulated Context

### Pending Todos

(All v1.0-close todos now targeted by v1.1 phases — see Deferred Items table above.)

## Operator Next Steps

- `/gsd-plan-phase 7` — decompose Phase 7 (Droplet artifact shipping) into plans.
