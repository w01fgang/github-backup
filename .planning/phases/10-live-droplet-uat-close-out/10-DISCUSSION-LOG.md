# Phase 10: Live-droplet UAT close-out - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-17
**Phase:** 10-live-droplet-uat-close-out
**Areas discussed:** Execution model, Result-recording shape, Definition of 'failure resolved', Execution ordering vs prereqs

---

## Execution model

### Q1: How are the UAT scenarios actually executed?

| Option | Description | Selected |
|--------|-------------|----------|
| Operator by-hand (no new tooling) | Operator runs each by hand following existing HUMAN-UAT.md prose; results recorded inline. | |
| uat-runner.ts (auto where possible) | New TS helper auto-runs scripted parts; prints MANUAL: list for human-required items. | ✓ |
| Consolidated 10-UAT.md (prep only) | Single new file with copy-pasteable commands; operator runs offline. | |

**User's choice:** uat-runner.ts.

### Q2: How aggressive should the runner automate?

| Option | Description | Selected |
|--------|-------------|----------|
| Aggressive automation (~16/21 auto) | Runner does everything possible including firewall mutate + destroy-droplet flows. | |
| Conservative automation (no destructive ops) | Pure-script checks only; infrastructure mutations stay manual. | ✓ |
| Skeleton/checklist runner | TODO markers; closer to checklist than automation. | |

**User's choice:** Conservative — safety over speed.
**Notes:** Destructive ops (firewall edits, droplet destruction, re-bootstrap secret-preservation flow) stay in the MANUAL: list to prevent runner accidents in repeated dev runs or future CI invocations.

---

## Result-recording shape

### Q1: Where do UAT results land?

| Option | Description | Selected |
|--------|-------------|----------|
| Back-edit originals + 10-VERIFICATION.md aggregate | Flip `result: [pending]` in each of 3 HUMAN-UAT.md files; add aggregate verification doc. | ✓ |
| Consolidated 10-UAT.md (originals marked superseded) | One new file, history-via-forward-link. | |
| Both: aggregate + back-edit originals | Two writes per scenario. | |

**User's choice:** Back-edit originals + new 10-VERIFICATION.md aggregate.

---

## Definition of 'failure resolved'

### Q1: What does "issue raised and resolved" mean?

| Option | Description | Selected |
|--------|-------------|----------|
| New phase per failure | Every failure spawns a new bug-fix phase. | ✓ (refined) |
| Inline trivial fixes + new phase for code work | Severity-gated. | |
| Capture-as-backlog (close Phase 10 with exceptions) | Push to v1.2 with exception list. | |

**User's choice:** New phase per failure (refined below).

### Q2 (refinement): does 'new phase per failure' apply to every kind of failure?

| Option | Description | Selected |
|--------|-------------|----------|
| Strict: every failure regardless of severity | Including doc typos, env quirks. Worst-case 21 new phases. | |
| Severity-gated: blocking-bug = new phase, else inline | Code regression / security / data loss → new phase. Env / config / doc → inline fix in Phase 10. | ✓ |
| Strict per failure, batched into one bugfix phase | All small failures live under one Phase 11. | |

**User's choice:** Severity-gated.
**Notes:** Blocking-bug definition = code regression, security defect, data loss, or "feature literally doesn't work as documented." Everything else (env, config, doc, transient infra) gets inline fix in Phase 10 + record in 10-VERIFICATION.md.

---

## Execution ordering vs prereqs

### Q1: How should Phase 10 order its execution against the 8/9 prereqs?

| Option | Description | Selected |
|--------|-------------|----------|
| Wait: execute after 8 + 9 fully ship | Plan-phase ships runner now; execute-phase waits. Single end-state validation. | ✓ |
| Wave-by-prereq | Phase 01 scenarios now (independent of 8/9), then 03/04 + Phase 8 deferrals, then Phase 9 scenario. | |
| Tooling now, validation in v1.2 | Defer all execution to v1.2. | |

**User's choice:** Wait until 8 + 9 fully ship.
**Notes:** Phase 8 shipped at `f64b216` during this manager session. Phase 9 plans exist (`5b32ac4` / `3678057`) but execute has not run. Phase 10 execute-phase blocks on `/gsd-execute-phase 9` completing.

---

## Claude's Discretion

- Runner filename + CLI flag shape.
- `tsx` vs built artifact (matches existing `tsx scripts/*.ts` repo pattern).
- MANUAL: list output format.
- `npm run uat` script alias.
- Severity-classification wording in HUMAN-UAT.md result lines.

## Deferred Ideas

- Aggressive automation of destructive ops with `--allow-destructive` flag — future operator request only.
- CI-driven UAT via `.github/workflows/` (would need teardown-after droplet provisioning).
- Automated DNS A record creation (operator's DNS provider may not be DO Networking).
- Reading scenario metadata from HUMAN-UAT.md frontmatter instead of inline `const SCENARIOS`.
- Aggregating Phase 7's discovered-during-operator-run bullets — already folded into Phase 8.
