---
phase: 01-verify-pipeline
plan: 03
type: execute
wave: 3
depends_on: ["01-01", "01-02"]
files_modified:
  - scripts/smoke-test.ts
  - droplet/github-backup.sh
autonomous: false
requirements:
  - PROV-01
  - PROV-02
  - BACKUP-01
  - BACKUP-02
  - BACKUP-03
  - ACCESS-01
  - TEST-01

must_haves:
  truths:
    - "Operator can run npm run smoke-test against the real personal GitHub user and reach exit 0 with the droplet still alive (D-01, D-04, D-08)"
    - "Operator can run npm run smoke-test -- --fresh to destroy + recreate before running (D-08)"
    - "Operator can run npm run verify:phase-1 after smoke-test and get exit 0"
    - "100% of returned repos mirrored successfully — no partial pass (D-02)"
    - "All five Phase 1 ROADMAP success criteria are demonstrated by the live run"
  artifacts:
    - path: "scripts/smoke-test.ts"
      provides: "End-to-end orchestrator: provision → bootstrap → trigger → ssh-probe → clone-probe (D-04)"
      min_lines: 120
  key_links:
    - from: "scripts/smoke-test.ts"
      to: "scripts/create-droplet.ts + scripts/bootstrap-droplet.ts + scripts/destroy-droplet.ts"
      via: "spawnSync via npm run (or direct main() import)"
      pattern: "(create-droplet|bootstrap-droplet|destroy-droplet)"
    - from: "scripts/smoke-test.ts"
      to: "scripts/lib/ssh.ts"
      via: "import"
      pattern: "from \"\\./lib/ssh\""
---

<objective>
Implement TEST-01 (D-03/D-04/D-05/D-08) and prove all five ROADMAP Phase 1 success criteria against real DigitalOcean infrastructure using the operator's real GitHub user (D-01) at the 100%-pass bar (D-02).

Purpose: turn the drafted-but-unverified codebase into a green-baseline. After this plan ships, every future phase inherits a known-good Phase 1.
Output: scripts/smoke-test.ts + the BACKUP_SUMMARY marker line in droplet/github-backup.sh + a documented green run + verify:phase-1 exit 0.
</objective>

<rationale>
Plan-checker Issue 4 — chose **Option A (smaller bash diff)**: emit `BACKUP_SUMMARY upstream=N mirrored=M failed=F` as the final log line in `droplet/github-backup.sh`. Both smoke-test (step 8) and verify:phase-1 (Group 3) parse this line.

Why not Option B (extract user-vs-org into shared `scripts/lib/github-source.ts` + bash function): would require sourcing TS-derived data into bash, or duplicating the detection in two languages. Option A is one new `log` call (~1 line of bash), no shared-source plumbing.

Bash diff scope: ONE line added (the `log "BACKUP_SUMMARY ..."` call) immediately before the existing `if [[ "${FAIL}" -gt 0 ]]` block. The script's `SUCCESS`/`FAIL`/`TOTAL` counters already exist (lines 97, 106–107, 127, 130, 139, 142). No control-flow change.
</rationale>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/01-verify-pipeline/01-CONTEXT.md
@.planning/phases/01-verify-pipeline/01-01-SUMMARY.md
@.planning/phases/01-verify-pipeline/01-02-SUMMARY.md
@scripts/create-droplet.ts
@scripts/bootstrap-droplet.ts
@scripts/destroy-droplet.ts
@scripts/verify/phase-1.ts
@scripts/lib/ssh.ts
@droplet/github-backup.sh

<interfaces>
<!-- Plan 01-01 wired all three npm scripts already; this plan adds the file
     scripts/smoke-test.ts is registered to. -->
import { sshFlags, runVisible, runCapture, sshRun } from "./lib/ssh";
import { loadConfig, loadDropletInfo, bail } from "./lib/config";
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add BACKUP_SUMMARY marker to github-backup.sh + implement scripts/smoke-test.ts</name>
  <files>droplet/github-backup.sh, scripts/smoke-test.ts</files>
  <action>
**Step 0 — Add BACKUP_SUMMARY marker to `droplet/github-backup.sh` (plan-checker Issue 4 — Option A):**

The script already tracks `SUCCESS` and `FAIL` counters and `TOTAL` (the upstream repo count from `gh api --paginate`). Add ONE log line on the success path, immediately before the existing `if [[ "${FAIL}" -gt 0 ]]; then exit 1; fi` block (around line 152):

```bash
log "BACKUP_SUMMARY upstream=${TOTAL} mirrored=${SUCCESS} failed=${FAIL}"
```

This emits a final-line summary parsed by both smoke-test step 8 and verify:phase-1 Group 3. Source-of-truth for the upstream count stays in bash (one user-vs-org detection, two parsers). No other change to `github-backup.sh` — keep its existing exit logic intact (still exits 1 if `FAIL > 0`, but the marker is logged regardless so the parser sees the failure counts).

**Step 1 onward — Create `scripts/smoke-test.ts` per D-03/D-04/D-05/D-08:**

CLI:

```
tsx scripts/smoke-test.ts [--fresh]
```

Behavior:

1. Parse argv. `--fresh` flag → call `npm run destroy-droplet -- --yes` first (best-effort; ignore non-zero if no droplet existed). Default = persist (D-08).
2. **Provision step (PROV-01, ROADMAP §1):** spawn `npm run create-droplet`. Inherit stdio. Non-zero exit aborts the smoke run with a clear "create-droplet failed" message.
3. Read `.droplet.json` via `loadDropletInfo()` to get `ip`/`id`.
4. **Bootstrap step (PROV-02, BACKUP-03, ROADMAP §2 + §5):** require `process.env.GITHUB_TOKEN` is non-empty; bail otherwise. Spawn `npm run bootstrap-droplet` with the env passed through. Inherit stdio.
5. **Trigger backup remotely (BACKUP-01, BACKUP-02, ROADMAP §3):** `sshRun(ip, user, keyPath, "/opt/github-backups/github-backup.sh")` — wait for completion. Capture exit code. Non-zero aborts.
6. **SSH-probe one mirror:** `runCapture("ssh ... 'ls -1d /opt/github-backups/*.git | head -n1'")` — assert at least one `.git` directory exists. Save the picked repo name.
7. **Clone-probe locally (ACCESS-01, ROADMAP §4):** `mkdtemp` a tmpdir; `git clone <user>@<ip>:/opt/github-backups/<repo>.git <tmpdir>/<repo>` — assert exit 0; assert `git rev-parse HEAD` resolves to a 40-char hex; assert `git for-each-ref | wc -l` > 0. Clean up tmpdir on success only.
8. **100% pass enforcement (D-02) via BACKUP_SUMMARY marker (plan-checker Issue 4 — Option A):** parse the marker line emitted by `droplet/github-backup.sh` (see Step 0 below for the bash diff). After step 5's trigger completes:
   - `runCapture("ssh ... 'tail -n 50 /var/log/github-backup.log'")` → stdout.
   - Match against `/^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$/m`. Bail if no match (the bash diff did not run or did not reach its summary line).
   - Assert `mirrored === upstream && failed === 0`. On divergence, print `SMOKE: FAIL — upstream=<U> mirrored=<M> failed=<F>; see /var/log/github-backup.log on droplet` and exit 1.
   - Cross-check: `runCapture("ssh ... 'ls -1d /opt/github-backups/*.git | wc -l'")` returns a number == `mirrored`.
   - Do NOT re-derive upstream count via `gh api` in TS — that would duplicate the user-vs-org detection at `droplet/github-backup.sh` lines 71–85. The bash script is the source of truth for the count.
9. On all-pass, print "SMOKE: PASS — droplet preserved at <ip>" and exit 0. The droplet is intentionally left alive (D-04, D-08).

Per D-05: reuse the same `config.json` + `GITHUB_TOKEN` env contract. Do NOT introduce a separate test config.

Per CONTEXT.md "Integration Points": you may either spawn the existing entrypoints via `npm run` (simpler, fewer code changes) or refactor them to expose `main()` and import. Recommend `spawnSync('npm', ['run', 'create-droplet'], { stdio: 'inherit' })` — keeps scripts independently runnable, no refactor risk.

Per CONTEXT.md "Established Patterns": follow `set -euo pipefail` strictness — first failed assertion = `process.exit(1)`.
  </action>
  <verify>
    <automated>bash -c 'set -euo pipefail; npx tsc --noEmit -p tsconfig.json; grep -q "BACKUP_SUMMARY upstream=" droplet/github-backup.sh || { echo "github-backup.sh missing BACKUP_SUMMARY marker line (plan-checker Issue 4 contract)"; exit 1; }; grep -q "BACKUP_SUMMARY" scripts/smoke-test.ts || { echo "smoke-test.ts must parse BACKUP_SUMMARY marker"; exit 1; }; n=$(grep -cE "create-droplet|bootstrap-droplet|github-backup\.sh|git clone|--fresh" scripts/smoke-test.ts); [ "$n" -ge 5 ] || { echo "smoke-test.ts orchestration markers <5 (got $n)"; exit 1; }'</automated>
  </verify>
  <done>
- droplet/github-backup.sh emits exactly one BACKUP_SUMMARY line on every run (success and failure paths)
- scripts/smoke-test.ts exists and type-checks
- Implements --fresh flag (calls destroy-droplet --yes)
- Orchestrates create → bootstrap → trigger → ssh-probe → clone-probe → BACKUP_SUMMARY parse (mirrored == upstream && failed == 0)
- Does NOT re-derive upstream count via gh api in TS (single source of truth: bash)
- Bails if GITHUB_TOKEN missing
- Default run preserves the droplet
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Live end-to-end run against real DigitalOcean + real GitHub user</name>
  <what-built>
Three new scripts (destroy-droplet, smoke-test, verify:phase-1) and shared lib (scripts/lib/*) that orchestrate and assert against the existing provisioning + droplet pipeline.
  </what-built>
  <how-to-verify>
This is the real-infrastructure run. Operator runs locally; Claude does not have DO credentials.

**Pre-flight (operator):**
1. `doctl auth init` is set up; `doctl account get` exits 0.
2. `gh auth status` exits 0 locally (only needed if the operator wants to sanity-check the user/org's repo list before running).
3. `config.json` exists (copy from `config.example.json`) with the operator's real values, especially `githubUserOrOrg = "<operator's github user>"` (D-01).
4. `GITHUB_TOKEN` env var is set in the current shell with `repo` scope.
5. No `.droplet.json` exists yet, OR if one exists, decide whether to reuse (default) or run with `--fresh`.

**Run (operator):**
1. `npm run smoke-test` (first run; this provisions + bootstraps + triggers + clones).
2. Watch output. If it bails partway, fix root cause — Phase 1 explicitly invites bug-fix as in-scope per CONTEXT.md.
3. Re-run until exit 0.
4. `npm run verify:phase-1` — must exit 0.

**Expected outcomes (mapped to ROADMAP Phase 1 success criteria):**
1. ROADMAP §1: `npm run create-droplet` second run is no-op (smoke-test re-run without `--fresh` confirms this implicitly).
2. ROADMAP §2: `crontab -l` on droplet contains `# github-backup-managed` (verify:phase-1 group 2 asserts this).
3. ROADMAP §3: at least one repo mirrored to `/opt/github-backups/<owner>_<repo>.git` (smoke step 6 + verify group 3).
4. ROADMAP §4: `git clone` over SSH succeeds locally (smoke step 7 + verify group 4).
5. ROADMAP §5: `backup.env` mode 600 (verify group 2).
6. D-02: 100% of repos mirrored (smoke step 8).

**Idempotence sanity check:**
1. `npm run smoke-test` again (no `--fresh`). Must pass without re-provisioning.

**On failure during the run:**
- File the bug, fix it (any blocking bug uncovered is in-scope per CONTEXT.md "Claude's Discretion: bug-fix triage rule").
- Cosmetic / DX issues → defer to a follow-up phase (CONTEXT.md).
- Do not relax the 100% pass bar (D-02). Either fix or document an explicit exclusion (e.g. archived repo with deleted-by-author content) per D-02.
  </how-to-verify>
  <resume-signal>
Reply with one of:
- `approved` — both smoke-test and verify:phase-1 exited 0; ROADMAP Phase 1 success criteria 1–5 all confirmed; 100% mirror pass bar met.
- `bug: <description>` — describe the failure and which step it occurred in; agent will work the fix.
- `excluded: <repo> — <reason>` — operator's documented exclusion per D-02 (e.g. archived repo cannot be cloned). Agent records in SUMMARY and re-runs.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| operator-machine → DO API | doctl uses operator's DO token; commands provision/destroy real billable infrastructure |
| operator-machine → droplet (SSH) | smoke-test and verify shell into the droplet as `sshUser` over public internet |
| droplet → github.com | github-backup.sh authenticates with GITHUB_TOKEN to enumerate + clone repos |
| local clone-probe target dir | smoke-test mkdtemps a local directory and `git clone`s into it |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-01 | Spoofing | SSH host identity (operator → droplet) | mitigate | Existing scripts use `StrictHostKeyChecking=accept-new` (sshFlags in scripts/lib/ssh.ts); rejects changed keys on subsequent runs. Smoke + verify reuse the same flags via the shared lib. |
| T-01-02 | Tampering | GITHUB_TOKEN in transit + at rest on droplet | mitigate | Token transferred via SCP over SSH (encrypted); written to `/opt/github-backups/backup.env` mode 600 (BACKUP-03); verify:phase-1 group 2 asserts mode 600 every run. |
| T-01-03 | Information disclosure | Smoke-test logging | mitigate | Smoke-test must NOT echo `process.env.GITHUB_TOKEN` to stdout; reuse `runVisible`/`runCapture` which only spawn child processes — no token interpolation into log lines. Code review item before live run. |
| T-01-04 | Denial of service | Forgotten/leaked droplet billing | mitigate | `--fresh` calls destroy-droplet with `--yes` (idempotent, refuses without .droplet.json); operator can `npm run destroy-droplet` at any time after Phase 1 to stop the billing clock. |
| T-01-05 | Elevation of privilege | DO API token scope | accept | Operator's doctl is authenticated to their own DO account; no privilege boundary inside the account. Single-tenant per PROJECT.md. |
| T-01-06 | Information disclosure | .droplet.json contains droplet ip+id | accept | Not a secret on its own; firewall restricts SSH to operator's CIDR (allowedSSHCidr). Add to .gitignore if not already. |
| T-01-07 | Tampering | Local clone-probe tmpdir collision | mitigate | Use `fs.mkdtempSync(os.tmpdir() + '/gh-backup-smoke-')` — unique per run; cleanup on success only so failures stay inspectable. |
| T-01-08 | Repudiation | Bug-fix audit trail | mitigate | Every blocking bug uncovered during the live run produces a commit; the SUMMARY references commit SHAs (per task 2 done criteria). |
</threat_model>


<verification>
- `npm run smoke-test` exits 0 against real droplet
- `npm run verify:phase-1` exits 0
- `git clone <user>@<ip>:/opt/github-backups/<repo>.git` from local machine resolves
- `crontab -l` on droplet contains `# github-backup-managed`
- `stat -c '%a' /opt/github-backups/backup.env` on droplet returns `600`
- Mirror count == upstream repo count (D-02)
</verification>

<success_criteria>
- All five ROADMAP §"Phase 1: Verify pipeline" success criteria pass
- All four D-07 verify groups pass
- Real personal GitHub user (D-01) backed up at 100% (D-02)
- Droplet remains alive at end of run (D-04)
- `--fresh` flag confirmed working (operator triggers at least once during the iteration cycle, even if the final green run was without `--fresh`)
- All eight Phase 1 requirements (PROV-01/02, BACKUP-01/02/03, ACCESS-01, TEST-01, TEST-02) are now Validated
</success_criteria>

<output>
After completion, create `.planning/phases/01-verify-pipeline/01-03-SUMMARY.md` documenting:
- Mirror count and upstream count from the green run
- Total wall time of the run
- Any bugs uncovered + commits that fixed them (link by SHA)
- Any explicit D-02 exclusions (repo + reason)
- Final droplet IP + id (for the operator's records; not for committing — strip from SUMMARY if .droplet.json is git-ignored)
</output>
