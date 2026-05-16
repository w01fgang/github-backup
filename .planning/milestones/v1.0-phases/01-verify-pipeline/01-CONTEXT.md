# Phase 1: Verify pipeline - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Run the existing (drafted-but-unverified) provisioning + droplet scripts end-to-end against a real DigitalOcean droplet using the operator's personal GitHub user, fix bugs uncovered, and lock in two executable verification surfaces (TEST-01 smoke runner + TEST-02 per-phase verify) so future phases inherit a green baseline.

This phase clarifies HOW to verify and assert against the existing code. No new product capability is added. New code in this phase is limited to: (1) a TS smoke runner, (2) per-phase verify wiring, (3) `scripts/destroy-droplet.ts` (pulled forward from Phase 4 to support `--fresh` reset and end-of-phase cleanup), and (4) bug fixes found during the run.

</domain>

<decisions>
## Implementation Decisions

### Smoke-test target
- **D-01:** Test against the operator's real personal GitHub user (`sumin`-owned account). No throwaway org, no repo-count cap. Validates real scale + real auth from day one.
- **D-02:** Phase 1 pass bar = **100% of returned repos must mirror successfully**. Any single clone/update failure blocks phase completion until root-caused and fixed (or repo explicitly excluded with documented reason).

### TEST-01 — end-to-end smoke runner
- **D-03:** Implement as `scripts/smoke-test.ts` (TypeScript, executed via `tsx`). Wired as `npm run smoke-test`. Re-runnable; non-zero exit on any failed assertion.
- **D-04:** Phase 1 smoke scope = **provision → bootstrap → trigger one backup remotely → SSH-probe one mirror → git clone one mirror locally**. Stops at clone-probe. Does NOT include restore-back probe (Phase 3) or destroy-at-end (Phase 4 lifecycle test). Smoke runner can call `destroy-droplet` script via the `--fresh` flag (see D-08), but normal smoke runs leave the droplet alive.
- **D-05:** Smoke runner reuses the same `config.json` + `GITHUB_TOKEN` env var contract as the real scripts — no separate test config. The real backup pipeline IS what's being tested.

### TEST-02 — per-phase executable verify
- **D-06:** Implement as `npm run verify:phase-N` scripts. For Phase 1: `npm run verify:phase-1` runs a TS assertion script (location: `scripts/verify/phase-1.ts` or similar — planner decides path). Future phases each add their own `verify:phase-N`. Exit code = pass/fail.
- **D-07:** Phase 1 verify-script asserts (all four required, no opt-outs):
  1. **Provision**: `.droplet.json` exists locally; `doctl compute droplet get <id>` returns `active`; `doctl compute firewall list` shows the configured firewall attached to the droplet.
  2. **Bootstrap (over SSH)**: `/opt/github-backups/backup.env` exists with mode `600`; `github-backup.sh`, `install-cron.sh`, `bootstrap.sh` present in `/opt/github-backups/` and executable; `crontab -l` on droplet contains the `# github-backup-managed` marker line; `gh auth status` exits 0.
  3. **Backup-ran**: trigger one backup run remotely (`ssh ... /opt/github-backups/github-backup.sh`); `/var/log/github-backup.log` shows ≥1 successful mirror entry; `ls /opt/github-backups/*.git` confirms ≥1 bare-repo directory exists.
  4. **Clone-probe**: `git clone <user>@<droplet-ip>:/opt/github-backups/<owner>_<repo>.git /tmp/<repo>` from local machine succeeds; cloned repo has `HEAD` resolved and `git for-each-ref | wc -l` > 0.

### Droplet lifecycle during verify
- **D-08:** **Persistent by default, opt-in `--fresh` for reset.** Smoke runner and verify scripts assume an existing droplet (skip create if `.droplet.json` valid). `npm run smoke-test -- --fresh` (or equivalent flag) destroys + recreates first. Faster iteration; idempotency tested implicitly across runs.
- **D-09:** **Pull `scripts/destroy-droplet.ts` forward into Phase 1** (originally Phase 4 / TEARDOWN-02). Required to back the `--fresh` flag and to clean up at end of Phase 1. Scope guardrail: the Phase 1 destroy script only needs to remove droplet + firewall + delete `.droplet.json` — it does NOT need to verify TEARDOWN-01 idempotent re-bootstrap (still Phase 4).

### Claude's Discretion
- Exact directory layout for `scripts/verify/` vs `scripts/smoke-test.ts` — planner picks structure consistent with existing `scripts/` conventions.
- Whether to introduce a small shared SSH/doctl helper module to avoid copying `runVisible`/`runCapture`/`sshFlags` from `bootstrap-droplet.ts` — refactor opportunity, not a requirement.
- Bug-fix triage: any bug uncovered during the run is in scope for Phase 1 if it blocks success criteria; cosmetic / DX-only issues may be deferred to a follow-up phase.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project anchors
- `.planning/PROJECT.md` — project mission, in/out of scope, key decisions table.
- `.planning/REQUIREMENTS.md` — full requirement list incl. PROV-01/02, BACKUP-01/02/03, ACCESS-01, TEST-01, TEST-02.
- `.planning/ROADMAP.md` §"Phase 1" — goal + 5 success criteria.
- `.planning/STATE.md` — current position.

### Existing code under verification
- `scripts/create-droplet.ts` — provisioning (PROV-01); idempotent droplet + firewall creation; persists `.droplet.json`.
- `scripts/bootstrap-droplet.ts` — bootstrap (PROV-02); generates + uploads `backup.env` mode 600, scp's droplet scripts, runs `bootstrap.sh` remotely.
- `droplet/bootstrap.sh` — installs apt deps + gh CLI, authenticates gh with `GITHUB_TOKEN`, runs `install-cron.sh`.
- `droplet/github-backup.sh` — the actual backup pipeline (BACKUP-01/02); detects user vs org, paginates `gh api`, mirrors via `git clone --mirror` or `git remote update`.
- `droplet/install-cron.sh` — installs the cron line with `# github-backup-managed` marker (idempotent via marker grep-out).
- `config.example.json` — config schema (region, size, sshKeyFingerprint, allowedSSHCidr, githubUserOrOrg, etc.).
- `package.json` — current scripts: `create-droplet`, `bootstrap-droplet`. Phase 1 will add `smoke-test`, `verify:phase-1`, `destroy-droplet`.

### External tooling contracts
- `doctl` CLI — used for droplet + firewall ops; assumed authenticated (`doctl auth init`) on operator machine.
- `gh` CLI — installed on droplet by bootstrap; used by `github-backup.sh` for repo listing + auth.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `bootstrap-droplet.ts` SSH/SCP helpers (`sshFlags`, `sshRun`, `scpFile`, `runVisible`, `runCapture`, `waitForSsh`) — directly reusable by smoke-test runner and verify-phase-1 script. Strong candidate for extraction into `scripts/lib/ssh.ts` if duplication grows.
- `create-droplet.ts` doctl helpers (`doctlJson`, `first`, `publicIp`, `findOrCreateDroplet`, `findOrCreateFirewall`) — reusable for verify asserts that probe droplet/firewall state. Same extraction candidate.
- Config loader pattern (`loadConfig` in both scripts, slightly divergent) — consolidation opportunity but not required for Phase 1 success.
- `.droplet.json` artifact — already the canonical handoff between create and bootstrap; smoke + verify scripts read it the same way.

### Established Patterns
- **Idempotency by lookup-then-create**: `findOrCreateDroplet` / `findOrCreateFirewall` and `install-cron.sh`'s marker-line grep are the existing idempotency pattern. Smoke runner with `--fresh` flag should NOT bypass this — `--fresh` calls `destroy` first, then re-runs the existing idempotent paths.
- **Config + env var split**: structural config in `config.json`, secret-only `GITHUB_TOKEN` in env var. Verify and smoke runners must follow the same split.
- **bash scripts use `set -euo pipefail`** — fail-fast posture. Verify asserts should match this strictness (one failed assert = exit 1).
- **TS scripts use `execSync` w/ `stdio: "inherit"` for visible runs and `"pipe"` for capture** — keep this convention for new scripts.

### Integration Points
- New `scripts/destroy-droplet.ts` must read `.droplet.json` (same contract as bootstrap), call `doctl compute firewall delete` then `doctl compute droplet delete`, then unlink `.droplet.json`. Refuse if `.droplet.json` missing (TEARDOWN-02 partial).
- New `scripts/smoke-test.ts` orchestrates the two existing entrypoints (`create-droplet` + `bootstrap-droplet`) as library calls or child processes — planner decides whether to refactor those entrypoints to expose `main()` or just spawn them via `npm run`.
- Verify script's clone-probe must run on the **local machine** (not the droplet) — that's the access path operators actually use. Use `mkdtemp` for the clone target so repeated runs don't collide.

</code_context>

<specifics>
## Specific Ideas

- Operator's personal GitHub user is the test target — full real-scale repo set, no scoping/limit flag.
- Pass bar is binary 100% — surfaces flaky / token-scope / size-limit / archived-repo edge cases early instead of hiding them behind a threshold.
- `--fresh` is the operator's reset button. Default is "reuse what's there" because iterations during verification will be many.

</specifics>

<deferred>
## Deferred Ideas

- **Restore-back probe in smoke runner** — Phase 3 (RESTORE-01/02). Phase 1 smoke stops at clone-probe.
- **Destroy at end of smoke run / full lifecycle test** — Phase 4 (TEARDOWN-01 idempotent re-bootstrap, TEARDOWN-02 full destroy validated as part of lifecycle). Phase 1 ships the destroy *script* but does not gate Phase 1 on full re-bootstrap idempotency.
- **Multi-source iteration in smoke** — Phase 5 (MULTI-01). Smoke runner stays single-source until Phase 5 lands.
- **Monitoring assertions (last-run timestamp, disk usage, per-repo status)** — Phase 2 (MON-01/02/03). Phase 1 verify only asserts "≥1 mirror succeeded", not operator-grade observability.
- **Threshold-based pass bar / failure quarantine** — operator chose strict 100%; if real-world flakes prove this too brittle later, reopen as a process change, not a code change.
- **Per-phase verify framework / harness** — keep `verify:phase-N` as plain TS scripts in Phase 1. If patterns clearly emerge by Phase 3, extract a shared assertion helper then.

</deferred>

---

## Post-phase amendment — 2026-05-11

**Reverses:** D-08 (`scripts/destroy-droplet.ts` pulled forward from Phase 4) and the `--fresh` flag in `scripts/smoke-test.ts`.

**Reason:** Operator decided automated droplet teardown is not worth the surface area at single-operator scale. Manual DO-dashboard removal is the documented teardown path. See PROJECT.md → Out of Scope ("Automated droplet teardown") and Key Decisions ("No automated droplet teardown").

**Changes applied:**
- `scripts/destroy-droplet.ts` deleted from repo
- `destroy-droplet` removed from `package.json` scripts
- `--fresh` handling removed from `scripts/smoke-test.ts` (header docstring + `maybeFreshReset` + `hasFlag` helper)
- Re-provisioning is now: delete droplet from DO dashboard, remove `.droplet.json` locally, re-run `npm run smoke-test`

The rest of Phase 1's decisions (smoke runner, verify:phase-1, BACKUP_SUMMARY contract, lock semantics) are unaffected.

---

*Phase: 1-verify-pipeline*
*Context gathered: 2026-04-30 (amended 2026-05-11)*
