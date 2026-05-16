# Phase 1: Verify pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 1-verify-pipeline
**Areas discussed:** Smoke-test target, TEST-01 shape, TEST-02 verify-step shape, Droplet lifecycle during verify

---

## Smoke-test target

### Sub-question 1: GitHub source for first end-to-end run

| Option | Description | Selected |
|--------|-------------|----------|
| Personal user | Use operator's personal GitHub user. Real repos, real scale. | ✓ |
| Throwaway test org | Create throwaway test org/user with 1-3 small repos. Cleanest reset, slowest setup. | |
| Personal user, capped | Personal user but cap to N smallest repos via `--limit` flag. Fastest iteration, requires code mod. | |

**User's choice:** Personal user (no cap).

### Sub-question 2: Phase 1 pass bar

| Option | Description | Selected |
|--------|-------------|----------|
| 100% must succeed | All repos must mirror successfully. Hard pass/fail. | ✓ |
| ≥1 success, log fails | ≥1 repo mirrored + git clone works. Failures logged but don't block phase. | |
| Threshold-based | Define threshold (e.g. ≥90%), investigate failures, decide phase pass after review. | |

**User's choice:** 100% must succeed.

---

## TEST-01 shape

### Sub-question 1: Implementation form

| Option | Description | Selected |
|--------|-------------|----------|
| Manual checklist doc | Markdown checklist operator follows manually. Lowest code, no automation. | |
| TS smoke runner | `scripts/smoke-test.ts` orchestrates create → bootstrap → trigger backup → clone-probe. Re-runnable, exits non-zero on fail. | ✓ |
| Bash smoke runner | `scripts/smoke-test.sh` doing the same. No tsx dep needed for test itself. | |

**User's choice:** TS smoke runner.

### Sub-question 2: Smoke scope

| Option | Description | Selected |
|--------|-------------|----------|
| Through clone-probe only | Provision → bootstrap → trigger one backup → SSH-probe one mirror → git clone probe from local. No destroy in Phase 1. | ✓ |
| Include restore probe | Above plus restore probe (clone-back + ref-count compare). Couples Phase 1 to RESTORE work. | |
| Full lifecycle incl destroy | Above plus destroy at end. Full lifecycle in one run. Couples Phase 1 to teardown work. | |

**User's choice:** Through clone-probe only.

---

## TEST-02 verify-step shape

### Sub-question 1: Verify form

| Option | Description | Selected |
|--------|-------------|----------|
| `npm run verify:phase-N` | Per-phase npm script runs assertion bash/TS that checks files, perms, cron, clone probe. Exit code = pass/fail. | ✓ |
| phase-local `verify.sh` | Per-phase shell file `.planning/phases/NN-*/verify.sh`. Self-contained, no npm wiring. | |
| Roll into TEST-01 runner | Inline asserts inside TEST-01; no separate per-phase verify. One source of truth. | |

**User's choice:** `npm run verify:phase-N`.

### Sub-question 2: Phase-1 assertion coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Provision asserts | `.droplet.json` exists; doctl confirms droplet+firewall present. | ✓ |
| Bootstrap asserts (SSH) | SSH probe: `backup.env` mode 600, scripts in `/opt/github-backups`, crontab line present, `gh auth status` ok. | ✓ |
| Backup-ran asserts | Trigger one backup remotely; log shows ≥1 mirror; `ls /opt/github-backups` confirms `.git` dirs. | ✓ |
| Clone-probe assert | `git clone` over SSH into tmp; verify HEAD + ref count > 0. | ✓ |

**User's choice:** All four (full coverage).

---

## Droplet lifecycle during verify

### Sub-question 1: Lifecycle policy

| Option | Description | Selected |
|--------|-------------|----------|
| Persistent across iterations | Keep droplet alive between iterations. Cheaper iteration, idempotency tested implicitly. | |
| Recreate every run | Destroy + recreate each cycle. Pure idempotent guarantee but slow + costlier. | |
| Persist + opt-in `--fresh` | Persist by default, smoke runner takes `--fresh` flag to destroy first. Best of both. | ✓ |

**User's choice:** Persist + opt-in `--fresh`.

### Sub-question 2: destroy-droplet script timing

| Option | Description | Selected |
|--------|-------------|----------|
| Add destroy script in Phase 1 | Add `scripts/destroy-droplet.ts` now (originally Phase 4). Required for `--fresh` flag and end-of-phase cleanup. | ✓ |
| Defer to Phase 4, doc workaround | Defer destroy to Phase 4. `--fresh` flag falls back to manual `doctl` commands documented in README. | |

**User's choice:** Add destroy script in Phase 1.

**Notes:** Pulls TEARDOWN-02 partially forward into Phase 1. Phase 4 still owns idempotent re-bootstrap (TEARDOWN-01) and the full lifecycle test. CONTEXT.md D-09 captures the scope guardrail.

---

## Claude's Discretion

- Exact directory layout for verify scripts (`scripts/verify/phase-1.ts` vs alternatives) — planner picks consistent with existing `scripts/` conventions.
- Whether to extract a shared SSH/doctl helper module (`scripts/lib/ssh.ts`, `scripts/lib/doctl.ts`) — refactor opportunity, not required for phase pass.
- Bug-fix triage rule: blocking-only in Phase 1, cosmetic/DX deferred to follow-up.

## Deferred Ideas

- Restore-back probe in smoke runner → Phase 3 (RESTORE-01/02).
- Destroy-at-end / full lifecycle test in smoke → Phase 4 (TEARDOWN-01).
- Multi-source iteration in smoke → Phase 5 (MULTI-01).
- Monitoring assertions (last-run timestamp, disk usage, per-repo status) → Phase 2 (MON-01/02/03).
- Threshold-based pass bar / failure quarantine → revisit only if 100% proves brittle in real use.
- Shared verify-assertion harness → defer until patterns emerge by Phase 3.
