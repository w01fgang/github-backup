# Phase 10: Live-droplet UAT close-out - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Run every outstanding human-required validation scenario from v1.0 against a live DigitalOcean droplet. Record results. Resolve blocking issues. Mark STATE.md `uat_gap` / `verification_gap` rows resolved. **Mostly NOT code-writing** — this phase ships one new helper (`scripts/uat-runner.ts`) and otherwise runs scenarios, edits result files, and triages failures.

**Scope items (21 scenarios total):**

- **VALID-01 — Phase 01 UAT (8 scenarios)** — `.planning/milestones/v1.0-phases/01-verify-pipeline/01-UAT.md`:
  1. Cold Start Smoke Test (`npm run smoke-test` end-to-end on clean checkout)
  2. Provision Droplet (`npm run create-droplet` + SSH reachability)
  3. Bootstrap Droplet (`npm run bootstrap-droplet` + first backup completes)
  4. Verify Phase 1 Harness (`npm run verify:phase-1` four-group invariants)
  5. Real GitHub User/Org Mirrored (disk repo count == GitHub repo count)
  6. Git Clone Over SSH Works (`git clone backup-user@<ip>:/opt/...`)
  7. BACKUP_SUMMARY Marker Contract (regex consumers parse the line)
  8. Destroy Droplet Safety Gates (`destroy-droplet.ts` confirmation flow)

- **VALID-02 — Phase 03 UAT (6 scenarios)** — `.planning/milestones/v1.0-phases/03-webhook/03-HUMAN-UAT.md`. Phase 03 VERIFICATION.md "Human verification needed" lists the SAME 6 items — closing one closes both:
  1. DNS A record points at droplet
  2. Caddy auto-issues Let's Encrypt cert
  3. `systemctl is-active github-backup-webhook` returns `active`
  4. Signed push triggers mirror within 30s
  5. Bad signature returns 401
  6. Re-bootstrap preserves WEBHOOK_SECRET + restarts listener

- **VALID-03 — Phase 04 UAT (4 scenarios)** — `.planning/milestones/v1.0-phases/04-restore/04-HUMAN-UAT.md`. Phase 04 VERIFICATION.md `human_verification` lists the SAME 4 items:
  1. Live-droplet single-repo restore smoke (`npm run restore -- owner/repo /tmp/...`)
  2. Restored clone refs inspection (`git branch -a && git tag`)
  3. `verify:phase-4` happy path against `restoreTestRepo`
  4. `verify:phase-4` ref-mismatch path (forced)

- **Phase 8 deferred live-validation (3 scenarios)** — carried forward from `08-04-SUMMARY.md` "Not done in this phase":
  9. Live `npm run create-droplet` drift-injection test (delete an outbound canonical rule via doctl, re-run, confirm restore + zero `add-rules` calls on re-run with set already present)
  10. Live `npm run create-droplet` extras-preservation test (add a non-canonical outbound rule, re-run, confirm untouched)
  11. Live `npm run verify:phase-7` regression check on a freshly-bootstrapped droplet (Phase 8 must not break Phase 7 contracts)

**In scope:**
- `scripts/uat-runner.ts` (new) — conservative-automation runner for the scripted scenarios.
- Back-editing each of the 3 original HUMAN-UAT.md files with `result: passed/failed/skipped (date)` + notes per scenario.
- `.planning/phases/10-live-droplet-uat-close-out/10-VERIFICATION.md` — aggregate pass/fail counts + Phase 8 deferral results + STATE.md gap-resolution proof.
- Inline doc/config/env fixes for non-blocking failures.
- New phase entries in ROADMAP.md for any blocking-bug failures.

**Out of scope:**
- Destructive infrastructure mutations driven by the runner (firewall edits, droplet destruction, repo deletion). These stay manual to prevent CI/runner accidents.
- Aggressive automation of items needing real-human action (DNS A record creation, real GitHub push from operator's local clone, `npm run register-webhooks` interactive token confirmation).
- Re-running the cron sync from scratch (already exercised by Phase 01 #1 smoke test).
- Any v1.2 work — failures captured as new requirements/phases live in v1.2's REQUIREMENTS/ROADMAP, not Phase 10's artifacts.

</domain>

<decisions>
## Implementation Decisions

### Execution model

- **D-01 (EXEC-MODEL):** Build a new TypeScript helper `scripts/uat-runner.ts` that drives the scripted parts of the UAT scenarios. The runner reads a manifest (e.g. inline `const SCENARIOS: Scenario[] = [...]`) of all 21 items, executes each scripted step (shelling out to `npm run smoke-test`, `dig`, signed `curl`, `openssl s_client`, `ssh systemctl is-active`, `verify:phase-3/4/7`, etc.), captures stdout/exit-code, and prints either `✓ <id> passed` or `✗ <id> failed: <reason>`. Scenarios that need a real human print `… MANUAL: <id>: <one-line instruction>` and are recorded as `result: manual` rather than pass/fail. Rejected alternatives: operator-by-hand (too much wall-clock); consolidated-prep-only-10-UAT.md (only marginal time savings vs (a)).
- **D-02 (AUTO-SPLIT):** **Conservative automation.** The runner only automates pure-script checks and read-only assertions. Anything that mutates infrastructure stays in the MANUAL: list, including:
  - Firewall reconcile drift-injection / extras-preservation (operator runs `doctl compute firewall remove-rules …`, then `npm run create-droplet`).
  - Destroy-droplet safety gates (Phase 01 #8 — operator triggers, runner only verifies STDIN flow on a dry-run path if exposed).
  - Re-bootstrap secret preservation (Phase 03 #6 — operator runs the actual second-bootstrap; runner only verifies post-conditions).
  - DNS A record creation, real GitHub push events.
  Rationale: a runner script in CI or run repeatedly during development should never accidentally remove a firewall rule or destroy a droplet. The cost is a slightly longer MANUAL: list (~10/21); the safety win is worth it.

### Result recording

- **D-03 (RECORDING):** **Back-edit each of the 3 original HUMAN-UAT.md files in place** — flip every `result: [pending]` → `result: passed (2026-MM-DD)` or `result: failed: <one-line reason> (2026-MM-DD)` or `result: manual: <operator notes> (2026-MM-DD)`. Each file's `Summary` block (`total: N / passed / issues / pending / skipped`) gets updated to match. **Plus** a new `.planning/phases/10-live-droplet-uat-close-out/10-VERIFICATION.md` that aggregates:
  - Total pass/fail/manual counts across all 21 scenarios.
  - Phase 8 deferred live-validation results (3 items).
  - STATE.md deferred-items table rows that close as a result (5 rows: 3 `uat_gap`, 2 `verification_gap`).
  - Any new phases spawned for blocking-bug failures (links to ROADMAP entries).
  - The exact commit hash of the live-droplet runtime that was validated (Phase 8's commit `f64b216` or later).
- **D-04 (PHASE-7-VERIFY-LOG):** Phase 07-HUMAN-UAT.md already shows `status: resolved` from 2026-05-16; do NOT re-edit it. The Phase 7 regression item from Phase 8's deferral list is a *new* live-validation step recorded only in `10-VERIFICATION.md` (it's not a re-run of Phase 7's original UAT — it's "Phase 8 did not break Phase 7").

### Definition of "failure resolved"

- **D-05 (FAIL-SEVERITY-GATE):** Severity-gated interpretation of ROADMAP SC#1. Two buckets:
  - **Blocking bug** = code regression, security defect, data loss, or "the feature literally does not work as documented" → spawn a NEW phase (e.g. "Phase 11: <fix>") with a fresh CONTEXT/PLAN/EXECUTE cycle. Phase 10 cannot close until the spawned phase closes. Update ROADMAP.md immediately to add the spawned phase. Phase 10's `10-VERIFICATION.md` links each spawned phase by number.
  - **Non-blocking failure** = environment-specific (operator skipped a prereq), doc typo / outdated example, config field missing, transient infra hiccup (DNS propagation, ACME challenge timing) → fix **inline** during Phase 10, commit the fix as part of the phase, record the failure + fix in `10-VERIFICATION.md` §"Inline Fixes". No new phase.
- **D-06 (TRIAGE-RECORDING):** For each failure during runner execution, the operator (or Claude, when triaging) writes a one-line classification (`blocking: <reason>` or `env: <reason>` or `doc: <reason>`) into the relevant HUMAN-UAT.md result line AND into `10-VERIFICATION.md` §"Failure Triage Table". This is the audit trail that proves SC#1's "any failure resolved" — every failure has a row, every row has a resolution (new phase number / inline commit hash).

### Execution ordering vs prereqs

- **D-07 (ORDERING):** Plan-phase ships `scripts/uat-runner.ts` plus the `10-VERIFICATION.md` skeleton **now**. Execute-phase **waits** for Phases 8 + 9 to fully ship (execute completes) before running any UAT scenarios. Phase 8 has shipped (commit `f64b216`); Phase 9 plans exist (commits `5b32ac4` / `3678057`) but execute has not run yet. Phase 10 execute-phase therefore blocks on `/gsd-execute-phase 9` completing. Rejected alternatives:
  - Wave-by-prereq (run Phase 01 scenarios now) — saves wall-clock but produces a stale-result risk: Phase 01 scenarios might pass against Phase 7's droplet state but the actual v1.1 close-out wants them to pass against Phase 9's listener too (re-bootstrap touches everything). Single end-state validation is cleaner.
  - Tooling-now-validation-in-v1.2 — defers the real validation forever and lets v1.1 ship on faith. Rejected.

### Claude's Discretion

- Exact `scripts/uat-runner.ts` filename and CLI flag shape (e.g. `--phase 01|03|04|8-deferred|all`, `--scenario <id>`, `--no-color`, `--ssh-only-checks`).
- Whether the runner uses `tsx`-execution or a built `dist/` artifact (existing repo pattern is `tsx scripts/<file>.ts` — match it).
- Format of the MANUAL: list output (numbered checklist vs YAML vs plain prose).
- Whether to add a `npm run uat` script alias to `package.json`.
- Exact wording of the severity-classification one-liners in HUMAN-UAT.md result lines.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition + requirements

- `.planning/ROADMAP.md` §"Phase 10: Live-droplet UAT close-out" — goal, success criteria, depends-on.
- `.planning/REQUIREMENTS.md` lines 28-30 — VALID-01/02/03 full text.
- `.planning/STATE.md` lines 75-79 — deferred-items table (5 rows targeted at Phase 10).

### Scenario sources (must be read by the runner author + the operator)

- `.planning/milestones/v1.0-phases/01-verify-pipeline/01-UAT.md` — 8 Phase 01 scenarios with `expected:` prose for each.
- `.planning/milestones/v1.0-phases/03-webhook/03-HUMAN-UAT.md` — 6 Phase 03 scenarios.
- `.planning/milestones/v1.0-phases/03-webhook/03-VERIFICATION.md` §"Human verification needed" (lines 117-149) — duplicates the 6 above; closing the HUMAN-UAT file closes both.
- `.planning/milestones/v1.0-phases/04-restore/04-HUMAN-UAT.md` — 4 Phase 04 scenarios.
- `.planning/milestones/v1.0-phases/04-restore/04-VERIFICATION.md` frontmatter `human_verification` block — duplicates the 4 above.
- `.planning/phases/08-bootstrap-uploader-hardening/08-04-SUMMARY.md` (or whichever Phase 8 summary records "Not done in this phase") — the 3 Phase 8 deferred live-validation items.

### Code touched / used by the runner

- `package.json` — existing `tsx scripts/<file>.ts` convention; runner uses same pattern. Possibly add `"uat": "tsx scripts/uat-runner.ts"`.
- `scripts/lib/config.ts` — `loadConfig()`, `loadDropletInfo()`, `bail()` reused. Runner reads `.droplet.json` + `config.json` the same way the other scripts do.
- `scripts/lib/ssh.ts` — `sshFlags`, `runCapture`. Reused for `ssh systemctl is-active` and similar read-only assertions.
- `scripts/verify/phase-{1,3,4,7}.ts` — runner shells out to `npm run verify:phase-N`; does NOT call their TS entry points directly (avoids tight coupling).
- `scripts/smoke-test.ts` — runner shells out to `npm run smoke-test` for Phase 01 #1.

### Files Phase 10 modifies

- `.planning/milestones/v1.0-phases/01-verify-pipeline/01-UAT.md` (back-edit).
- `.planning/milestones/v1.0-phases/03-webhook/03-HUMAN-UAT.md` (back-edit).
- `.planning/milestones/v1.0-phases/04-restore/04-HUMAN-UAT.md` (back-edit).
- `.planning/STATE.md` (mark `uat_gap` × 3 + `verification_gap` × 2 rows resolved).
- `.planning/ROADMAP.md` (Phase 10 row → `[x]`; add any spawned bug-fix phase rows).

### Files Phase 10 creates

- `scripts/uat-runner.ts` (new).
- `.planning/phases/10-live-droplet-uat-close-out/10-VERIFICATION.md` (new — aggregate per D-03).
- `.planning/phases/10-live-droplet-uat-close-out/10-01-SUMMARY.md` and any further plan summaries.

### Files Phase 10 must NOT modify

- `.planning/milestones/v1.0-phases/03-webhook/03-VERIFICATION.md` (treat as historical; redirect via aggregate file).
- `.planning/milestones/v1.0-phases/04-restore/04-VERIFICATION.md` (same).
- `.planning/phases/07-droplet-artifact-shipping/07-HUMAN-UAT.md` (already resolved 2026-05-16).
- Anything inside `.planning/milestones/v1.0-phases/` other than the 3 HUMAN-UAT files above.

No external specs or ADRs — this phase is self-contained inside the repo + the live droplet.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`loadConfig()`, `loadDropletInfo()`, `bail()`** in `scripts/lib/config.ts` — runner reads the same `.droplet.json` + `config.json` as everything else; no new config plumbing.
- **`sshFlags`, `runCapture`** in `scripts/lib/ssh.ts` — read-only assertions via SSH (`systemctl is-active`, `cat /var/log/github-backup.log | grep BACKUP_SUMMARY`, etc.).
- **`spawnSync`** from `node:child_process` — already used in `scripts/bootstrap-droplet.ts` and `webhook-listener.js`; runner uses the same pattern for `npm run *` shell-outs.
- **`fs.readFileSync` + simple line parsing** — runner reads `.planning/milestones/.../*-UAT.md` to programmatically locate the `### <N>. <name>` headings and the `result:` lines for back-edit emission.

### Established Patterns

- **`tsx scripts/<file>.ts` execution** — runner follows this. Optional `"uat": "tsx scripts/uat-runner.ts"` in `package.json`.
- **Standalone-per-phase script** (Phase 7 D-09 carryover) — runner is a single self-contained TS file. Does NOT import from any of `scripts/verify/phase-*.ts` directly; shells out via `npm run verify:phase-N` to keep the boundary clean.
- **Loud skip lines** (Phase 9 D-05 carryover) — same `[skip]` / `MANUAL:` prefix convention for items the runner cannot auto-execute.
- **Severity-classified bullet lines** in `07-HUMAN-UAT.md` line 24-26 — Phase 7 already recorded discovered issues with severity prefix (`FIREWALL-01 (Phase 8):`, `Phase 1 follow-up (out of v1.1 scope, surfaced not fixed):`). Phase 10 uses the same convention in `10-VERIFICATION.md` §"Failure Triage Table".

### Integration Points

- Runner runs entirely from the operator's laptop. It does NOT run on the droplet. Read-only droplet assertions go via SSH.
- Runner output is human-consumed (operator reads the pass/fail/manual lines). It does NOT block CI — Phase 10 is operator-run, not CI-run. The Phase 8 `sync-check.yml` CI workflow continues to enforce README/manifest parity; UAT is separate.
- Manual-bucket scenarios print copy-pasteable commands (e.g. for #4 `signed push triggers mirror within 30s`: print `git -C <local-clone> commit --allow-empty -m 'uat-probe' && git push` for the operator to execute, then ssh-check `last-webhook-event.json` after).

</code_context>

<specifics>
## Specific Ideas

- Runner exit codes: `0` if every scenario is `passed` or `manual: (operator confirms)`; `1` if any `failed` (blocking or otherwise). Operator can re-run after triaging.
- Runner must NOT silently auto-fix anything. Even known-trivial issues (e.g. a missing config field) get reported, not auto-patched.
- `10-VERIFICATION.md` must include the v1.1 ROADMAP row's exact wording for each VALID-* requirement so an outside reader can verify the spec match without chasing files.
- Severity prefix in HUMAN-UAT.md result lines is locked to one of: `blocking: <reason>`, `env: <reason>`, `doc: <reason>`, `infra: <reason>`. Anything else gets normalised by Claude at result-recording time.
- The Phase 8 deferred live-validation items are recorded under a §"Phase 8 deferrals" subsection of 10-VERIFICATION.md, NOT inside the v1.0 HUMAN-UAT files (which are scoped to their own phase work).

</specifics>

<deferred>
## Deferred Ideas

- **Aggressive automation of destructive ops** (firewall mutate, destroy-droplet via runner) — rejected for safety per D-02. Could revisit with an explicit `--allow-destructive` flag + interactive confirmation if a future operator wants one-command UAT.
- **CI-driven UAT** — running `scripts/uat-runner.ts` from `.github/workflows/` against a tear-down-after droplet. Phase 8 ships the first workflow file (sync-check.yml); a future infra phase could add UAT-on-PR if real GitHub-side test repos exist. Out of scope for Phase 10.
- **Automated DNS A record creation** (via `doctl compute domain records create`) — could automate Phase 03 #1 in a future phase. Today the operator owns the DNS provider, which may not be DO Networking.
- **`scripts/uat-runner.ts` reading scenario metadata from the HUMAN-UAT.md frontmatter** instead of inline `const SCENARIOS = [...]` — cleaner separation but more parsing surface. Inline const is fine for 21 scenarios.
- **Aggregating Phase 7's `07-HUMAN-UAT.md` discovered-during-operator-run bullets into 10-VERIFICATION.md** — those are Phase 8 driver items, already folded into Phase 8 plans. Reference, don't re-record.

</deferred>

---

*Phase: 10-live-droplet-uat-close-out*
*Context gathered: 2026-05-17*
