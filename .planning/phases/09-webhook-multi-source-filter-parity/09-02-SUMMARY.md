---
phase: 09-webhook-multi-source-filter-parity
plan: 02
subsystem: verify
tags: [verify, webhook, multi-source, regression]

requires:
  - phase: 09-webhook-multi-source-filter-parity
    provides: multi-source listener (Plan 09-01) — Group 7 is the regression guard for it
  - phase: 03-webhook
    provides: scripts/verify/phase-3.ts harness + helpers (postWebhook, syntheticPushPayload, sshCapture, signPayload, makeDelivery, assert)
provides:
  - Group 7 multi-source routing assertion in scripts/verify/phase-3.ts
  - VALID-04: verify:phase-3 fails on WEBHOOK-03 regression (single-source listener regression → source[≥1] POST would 404 instead of dispatching)
affects: [Phase 10 live-droplet UAT (Group 7 runs as part of verify:phase-3 against the bootstrapped droplet)]

tech-stack:
  added: []
  patterns:
    - "Per-source synthetic-POST regression group (reuses existing in-file helpers; no new top-level fns)"
    - "Locked skip-message wording for low-source-count configs (D-05)"

key-files:
  created: []
  modified:
    - scripts/verify/phase-3.ts

key-decisions:
  - "D-04: pure synthetic POSTs — no live GitHub round-trip, no cfg.webhookTestRepo dependency"
  - "D-04: per-source loop body order is POST → ssh-read → assert → next iter (last-webhook-event.json overwrites per event)"
  - "D-04: probeRepo = 'verify-phase-3-multi-source-probe' (fixed sentinel, ARG_RE-safe)"
  - "D-05: cfg.sources.length<2 → loud skip line, overall run reports PASS (verify:phase-3 is test-only by design)"
  - "Reuse secret variable already in scope from Group 1 (no second WEBHOOK_SECRET ssh-read)"

patterns-established:
  - "Group ordering: G6 (restart survival) → G7 (multi-source routing) → ✅ all-passed"
  - "Skip-line emits and falls through; never short-circuits with process.exit"

requirements-completed: [VALID-04]

duration: ~8min
completed: 2026-05-17
---

# Phase 09 Plan 02: verify:phase-3 Group 7 (multi-source routing) Summary

**`scripts/verify/phase-3.ts` now POSTs synthetic HMAC-signed pushes for every `cfg.sources[]` entry and asserts each one routes correctly — `verify:phase-3` will fail loudly if WEBHOOK-03 ever regresses.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-17T~11:09:00Z
- **Completed:** 2026-05-17T~11:17:00Z
- **Tasks:** 1 completed
- **Files modified:** 1

## Accomplishments

- Appended Group 7 (Multi-source routing) to `scripts/verify/phase-3.ts` between Group 6's post-restart ping block and the final `✅  All assertions passed.` log line.
- For each `s ∈ cfg.sources`: build synthetic push via existing `syntheticPushPayload(s.name, probeRepo)`, sign with the already-read `secret`, POST to `cfg.webhookHostname` with the canonical GitHub headers, assert `r.status` is `2xx` (any of 200/202/204), then `cat /var/lib/github-backup/last-webhook-event.json` via existing `sshCapture` and assert `ev.source === s.name && ev.owner === s.name`.
- Skip-line wording is byte-identical to the D-05 locked string (with `≥` literal preserved).
- No new top-level helpers, no new imports, no changes to Groups 1-6 or the `main()` signature or the `main().catch(...)` tail.
- Type-check clean: `npx tsc --noEmit --skipLibCheck scripts/verify/phase-3.ts` exits 0.

## Task Commits

1. **Task 1: Append Group 7 (Multi-source routing) to scripts/verify/phase-3.ts** — `f4aa859` (test)

## Files Created/Modified

- `scripts/verify/phase-3.ts` (+40 / -0) — Group 7 block between Group 6 and the final all-passed log.

## Done Criteria Results

All Task 1 done criteria verified post-edit:

| Check | Result |
|-------|--------|
| `npx tsc --noEmit --skipLibCheck scripts/verify/phase-3.ts` exits 0 | PASS |
| `grep -c "Group 7: Multi-source routing"` ≥ 2 | PASS (2) |
| `grep -c "verify-phase-3-multi-source-probe"` == 1 | PASS (1) |
| `grep -c "WEBHOOK-03 multi-source assertion needs"` == 1 | PASS (1) |
| `grep -c "for (const s of cfg.sources)"` == 1 | PASS (1) |
| awk: Group 7 lands before `All assertions passed` | PASS |
| awk: Group 7 lands after Group 6 | PASS |
| Skip-line contains literal `≥` (UTF-8 0xE2 0x89 0xA5) | PASS |

## Deviations from Plan

None. Block inserted verbatim per D-04 + D-05 wording.

## Threat Model Notes

STRIDE register from PLAN.md (T-09-05..T-09-07) dispositions hold:
- T-09-05 (Tampering on synthetic payload): accepted — locally generated + locally HMAC-signed with the droplet's WEBHOOK_SECRET, identical posture to Groups 2-3.
- T-09-06 (Info disclosure on ssh read of last-webhook-event.json): accepted — file contains only routing metadata (owner, repo, delivery_id, timestamps, dispatch exit code); no secrets.
- T-09-07 (Spoofing via sentinel probe repo): accepted — repo is a constant sentinel; downstream sync-one-repo.sh failure to clone is out-of-scope for the routing assertion.

## Next Phase Readiness

- VALID-04 acceptance: type-check + grep + awk gates all pass. Live e2e run of `npm run verify:phase-3` against a bootstrapped droplet is deferred to Phase 10 (live-droplet UAT close-out), per the plan's own caveat.
- When Phase 10 runs `verify:phase-3` against the live droplet AFTER `npm run bootstrap-droplet` pushes the new listener, Group 7 will print `── Group 7: Multi-source routing` followed by per-source `✓` lines (or the D-05 skip line if `cfg.sources.length < 2`).
- If only 1 source is configured at Phase 10 time, the skip line will fire and the overall run still reports PASS — this is intentional (D-05).

## Self-Check: PASSED

- All Task 1 `<done>` criteria re-run post-commit (table above).
- Plan-level `<verification>`: type-check exits 0; static-grep gates all pass.
- `<success_criteria>`: VALID-04 implementation landed; Group 7 between Group 6 and ✅ log; skip-line wording byte-identical; reuses existing helpers; type-check clean.
