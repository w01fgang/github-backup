# Phase 4: Teardown / redeploy - Context

**Gathered:** 2026-05-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Two locked outcomes:

1. **Re-running `npm run bootstrap-droplet` against a live, already-bootstrapped droplet is a no-clobber no-op.** Specifically: `backup.env` is preserved (the runtime `GITHUB_TOKEN` is not silently rewritten with the value currently in the operator's shell), the cron entry stays at exactly one `# github-backup-managed` line, and droplet-side scripts are refreshed in place. The script must succeed without error on the second, third, … N-th invocation.

2. **`npm run destroy-droplet` cleanly removes the droplet, the cloud firewall, and the local `.droplet.json`** with no orphans visible in `doctl compute droplet list` / `doctl compute firewall list`. It must refuse to run when `.droplet.json` is missing (T-01-01-01 hazard, already enforced).

**Phase 1 already pulled `scripts/destroy-droplet.ts` forward** under D-08 to support the smoke runner's `--fresh` flag. That script is in place, has the `--yes` non-interactive flag, refuses without `.droplet.json`, distinguishes empty-list from real `doctl` failures (NR-09), and has a working interactive `[y/N]` prompt (T-01-01-02). Phase 4 does **not** rewrite it. Phase 4 verifies it meets SC#2 + SC#3 end-to-end and adds whatever small refinements the `verify:phase-4` assertions surface — nothing more.

The bulk of Phase 4 net-new work is on the **bootstrap-side idempotency** half (SC#1) and on the **`verify:phase-4` proof script** that exercises both halves.

**In scope:**
- Make `bootstrap-droplet.ts` (or `droplet/bootstrap.sh`) idempotent w.r.t. `backup.env` and the cron line on a live droplet
- `scripts/verify/phase-4.ts` + `npm run verify:phase-4` script entry
- Any small destroy-side refinement that surfaces while writing `verify:phase-4` (e.g. tighter post-destroy assertion, missing safety check)
- Documentation: README short paragraph on the lifecycle commands (bootstrap re-run safe, destroy is final)

**Out of scope:**
- A `npm run redeploy` macro (`destroy && create && bootstrap`) — explicitly deferred (D-09); the operator can run the three commands and the smoke runner already does so via `--fresh`
- Any backup-data preservation across destroy (snapshots, S3 archive) — single-droplet posture per PROJECT.md
- Multi-source / multi-config aware teardown — Phase 5 territory
- Time-travel / restore-from-snapshot — out of v1
- Any change to `create-droplet.ts` (already idempotent per PROV-01 and verified in Phase 1)

</domain>

<decisions>
## Implementation Decisions

### Bootstrap idempotency — `backup.env`

- **D-01:** **Skip-if-exists for `backup.env` by default.** When the remote `${BACKUP_DIR}/backup.env` already exists, the bootstrap upload step does NOT overwrite it. The operator's runtime `GITHUB_TOKEN` env var (and `GITHUB_USER_OR_ORG`, `BACKUP_DIR`, `CRON_SCHEDULE` from `config.json`) is preserved as-is on the droplet. Rationale: clobbering `backup.env` on re-run would silently rotate the active GitHub token to whatever's in the current shell — surprising for the "I'm just refreshing droplet scripts after a code change" use case, and a footgun if the operator re-runs bootstrap without exporting the token at all (a literal blank or stale token would land on disk).

- **D-02:** **`--rotate-env` flag forces a fresh `backup.env` upload** (overwrite). Use case: operator deliberately wants to rotate their PAT, or change `cronSchedule` / `githubUserOrOrg` in `config.json` and push the new values. Without this flag, the on-droplet `backup.env` is the source of truth once it exists. The flag MUST require `GITHUB_TOKEN` to be set (same gate as today's first-run bootstrap); refuse loudly if not.

- **D-03:** **First-run detection is by remote-file probe**, not by local state. Bootstrap SSHes once and runs `test -f ${BACKUP_DIR}/backup.env`; the exit code drives the skip-vs-write decision. This works correctly even if the operator's local checkout is fresh (no `.droplet.json` history) but the droplet is in fact already bootstrapped — e.g., a teammate (future-multi-operator scenario, currently theoretical per PROJECT.md single-operator scope) or a re-cloned project tree. Probe failure (SSH transport error, exit 255) MUST bail loudly — do not assume "absent" from a network blip and silently overwrite.

- **D-04:** **When `backup.env` is preserved, log the skip explicitly.** A line like `▸ ${BACKUP_DIR}/backup.env exists on droplet — preserving (use --rotate-env to overwrite)`. Operator must never wonder whether their token survived. The bootstrap output is the only feedback channel; silence here violates Rule 12 (fail loud — equivalent: silent preserve is also misleading if not announced).

### Bootstrap idempotency — cron + scripts

- **D-05:** **Cron line idempotency is already handled** by `droplet/install-cron.sh` lines 48–54: existing `# github-backup-managed` markers are stripped before the new line is appended, so the marker count is invariant at exactly 1. Phase 4 does NOT modify `install-cron.sh`. Phase 4 ASSERTS the invariant in `verify:phase-4` (count `crontab -l | grep -c "${CRON_MARKER}"` must equal 1 both before and after a re-run of bootstrap).

- **D-06:** **`droplet/*.sh` scripts are always re-uploaded** (overwrite). The shell scripts are the operator's mechanism for shipping code changes to the droplet; clobbering them is the intended behavior, not a footgun. `chmod +x` after upload remains as today. No conditional logic needed.

- **D-07:** **`bootstrap.sh` re-run on the droplet stays as-is** — `apt-get update/upgrade/install`, `gh CLI install`, `mkdir -p ${BACKUP_DIR}`, `chmod 700`, `gh auth login --with-token < ${GITHUB_TOKEN}`, `gh auth setup-git`, `touch ${LOG_FILE}`, `install-cron.sh` — every step is already idempotent at the OS level. Re-running it is safe. The one exception is `gh auth login --with-token`: it re-authenticates each time, which is fine because the token in `backup.env` is now stable (D-01), so the auth result is identical run-to-run.

### Destroy script — verification & refinements

- **D-08:** **No semantic changes to `scripts/destroy-droplet.ts` from Phase 4** unless `verify:phase-4` surfaces a real gap. The current implementation (Phase 1, refined through NR-09) already covers SC#2 and SC#3:
  - Refuses without `.droplet.json` (SC#2 negative case)
  - Prompts `[y/N]` interactively, accepts `--yes` for automation
  - Deletes firewall first, then droplet, then `.droplet.json` (no orphan window)
  - Distinguishes "not found" (proceed) from real `doctl` failures (abort) for both droplet and firewall
  - Uses droplet ID, never name, to avoid wrong-droplet hazard (T-01-01-01)
  - Exit 0 on success, exit 1 on any verifiable failure
  Phase 4 may add **one** thing if planner judges it warranted: a final post-destroy assertion (re-list droplet + firewall, confirm gone) inside `destroy-droplet.ts` itself. This duplicates `verify:phase-4`'s post-destroy check but provides immediate end-of-script confidence even when the operator runs destroy alone (without `verify:phase-4`). Planner decides — both options defensible. (See Claude's Discretion below.)

- **D-09:** **No `--force` / "skip-confirm even without `.droplet.json`" mode.** The refusal-without-`.droplet.json` rule is load-bearing safety; there is no scenario in v1 where bypassing it is correct. If the operator has lost `.droplet.json` (e.g., reinstall) they should re-derive it from `doctl compute droplet list` manually rather than have the script guess. Future "rebuild `.droplet.json` from `doctl`" helper is deferred.

- **D-10:** **No mirror-freshness gate on destroy.** Idea floated: refuse to destroy if last successful backup is >24h old (operator would lose un-mirrored github.com state). Rejected for v1: backups are one-way and the github.com side is the source of truth (PROJECT.md), so destroying the mirror does not lose any github.com data — just the local copies, which the operator chose to delete. Adding the gate would conflict with the obvious "I want a clean slate" use case (smoke `--fresh`). Captured in Deferred for revisit if a real loss scenario emerges.

### `verify:phase-4` — assertion design

- **D-11:** **`scripts/verify/phase-4.ts`, wired as `npm run verify:phase-4`, follows the Phase 1 / Phase 3 template** — TypeScript + tsx, `assert(cond, msg)` fail-fast, exit 0 on all-pass, named-assertion exit 1 on first fail. Reuses `scripts/lib/{config,ssh,doctl}.ts` as established in Phase 1 D-06.

- **D-12:** **`verify:phase-4` assertion groups (in order):**
  1. **Pre-conditions:** Droplet alive (`doctl compute droplet get <id>` returns `active`), `backup.env` exists on droplet, exactly 1 `# github-backup-managed` line in `crontab -l`. (Same shape as Phase 1 D-07.2 sanity checks; pulls those forward as the starting state.)
  2. **`backup.env` preservation:** Capture `sha256sum ${BACKUP_DIR}/backup.env` over SSH → `H1`. Re-run `npm run bootstrap-droplet` (no `--rotate-env`). Capture `sha256sum` again → `H2`. Assert `H1 === H2`. Assert remote-side mtime is also unchanged (defense in depth — a future bug that re-writes the same content would still surface as an mtime change and is worth catching). Assert mode is still `600`.
  3. **Cron-marker invariant:** Capture `crontab -l | grep -c "# github-backup-managed"` → `N1`. (Should be 1 from group 1.) After the bootstrap re-run, capture again → `N2`. Assert `N2 === 1` (equality, not just `≥ 1` — the whole point is no duplication). Assert `N1 === N2` for symmetry.
  4. **`--rotate-env` round-trip (optional, env-gated):** If `GITHUB_TOKEN` is present in the verify-script's environment, run `npm run bootstrap-droplet -- --rotate-env`, then assert `sha256sum` of `backup.env` either changed (if the token differs) or stayed the same (if identical) — but in either case, mode is still `600` and the file exists. This proves `--rotate-env` is not destructive in either direction. If `GITHUB_TOKEN` is absent, log "skipping --rotate-env round-trip (GITHUB_TOKEN unset)" and continue — verify must remain runnable without forcing the operator to re-export their token every time.
  5. **Destroy + post-destroy:** Run `npm run destroy-droplet -- --yes`. Assert exit 0. Assert local `.droplet.json` is now absent. Assert `doctl compute droplet list --output json` does not contain a record with the captured droplet id. Assert `doctl compute firewall list --output json` does not contain a record with `name === cfg.firewallName`.
  6. **Refusal when `.droplet.json` missing:** Run `npm run destroy-droplet -- --yes` a second time (now there's no `.droplet.json`). Assert non-zero exit and that the bail message names the missing file. (Negative-path coverage of SC#2.)

- **D-13:** **`verify:phase-4` is destructive and must announce it before doing anything.** Same fail-loud posture as Phase 1's smoke runner: print a one-line summary of what's about to happen (target droplet name + id, what will be destroyed) and require either a `[y/N]` confirmation or a `--yes` flag to proceed. Default is `--yes` is required (no interactive prompt by default), because verify is intended to run in CI-shaped contexts; humans running it locally just pass `--yes`. This matches Phase 1's verify pattern (no interactive prompts in verify scripts). Operator who forgets `--yes` gets a one-line "verify:phase-4 is destructive — pass --yes to proceed" message.

- **D-14:** **`verify:phase-4` assumes a freshly-bootstrapped droplet at start.** It does NOT call `create-droplet` or `bootstrap-droplet` from scratch — it assumes `verify:phase-1` has already passed and the droplet is in the standard post-Phase-1 state. Rationale: keeps the script focused on the Phase 4 invariants (idempotency + clean destroy) rather than re-implementing the full pipeline. Pipeline-level coverage is the smoke runner's job. The script's header comment must call this dependency out explicitly so a future maintainer doesn't try to make it standalone.

### Documentation

- **D-15:** **README short addition under "Lifecycle" (or the existing operator-commands section):** two-paragraph note that (a) `npm run bootstrap-droplet` is safe to re-run; `backup.env` is preserved by default; pass `--rotate-env` to push a fresh token / cron schedule, and (b) `npm run destroy-droplet` is destructive and final, prompts before acting, and refuses without `.droplet.json`. Copy-pasteable, no new section heading required if a natural insertion point exists. Do not duplicate the Phase 3 Restore section's prose style — keep this terse, command-reference shaped.

### Claude's Discretion

- **D-08 sub-decision:** whether to add an inline post-destroy assertion to `destroy-droplet.ts` itself (in addition to the one in `verify:phase-4`). Constraint: must not change destroy's exit-code contract (stays 0 on success), must not slow down the smoke runner's `--fresh` path noticeably (one extra `doctl list` call is fine; anything heavier is not). Planner picks; both "add it" and "leave verify-only" are defensible.
- **D-13 sub-decision:** exact flag name for the destructive-confirm gate (`--yes`, `--destructive`, `--force`, etc.). Planner picks; suggest reusing `--yes` for parity with `destroy-droplet.ts`.
- **D-12 group 4 sub-decision:** whether `verify:phase-4` should also assert that the post-`--rotate-env` `backup.env` is parseable on the droplet (i.e., `bash -n` on a sourced copy, or `gh auth status` still 0 after re-bootstrap). Defensible either way — adds runtime cost but catches a class of "valid token shape but corrupted file" bugs. Planner picks.
- Whether `--rotate-env` is the literal flag name vs `--overwrite-env` / `--force-env` / `--reset-token`. Naming taste; constraint is the flag must clearly signal "I know this overwrites the active token on the droplet". Planner picks.
- Whether to extract the SSH-capture helper duplicated in `phase-1.ts` and `smoke-test.ts` into `scripts/lib/ssh.ts` (a `sshCapture` function) before adding the third copy in `phase-4.ts`, vs accepting one more copy. Planner picks per Phase 1's surgical-changes posture (Rule 3); inline duplication is fine if the planner judges the refactor out of phase scope.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Single-operator scope, runtime-only token policy, fire-and-forget mirror posture. `backup.env` preservation default in D-01 directly serves the runtime-only token rule (operator should not have to re-export GITHUB_TOKEN every time they refresh droplet scripts).
- `.planning/REQUIREMENTS.md` §Lifecycle — TEARDOWN-01 (idempotent re-bootstrap), TEARDOWN-02 (clean destroy).
- `.planning/ROADMAP.md` §Phase 4 — Success criteria 1 (no duplicate cron / no clobbered `backup.env`), 2 (destroy removes droplet + firewall, refuses without `.droplet.json`), 3 (post-destroy `doctl` lists are clean).

### Phase 1 baseline (depended-on, do not regress)
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` — TypeScript/`tsx` + `npm run` convention (D-03), 100% pass bar (D-02), `verify:phase-N` script convention (D-06/D-07), config+env split (D-05). Phase 1 D-08 pulled `destroy-droplet.ts` forward; Phase 4 verifies and refines, does not rewrite.
- `scripts/destroy-droplet.ts` — Already implements SC#2's negative case (refuse without `.droplet.json`), interactive `[y/N]` + `--yes` flag, ID-not-name lookup, NR-09 empty-list-vs-real-failure distinction. Phase 4 must understand this before "adding safety".
- `scripts/bootstrap-droplet.ts` — Currently always-overwrites `backup.env` (line 106 `scpFile`). The change site for D-01 / D-02 / D-03 / D-04. Read `writeBackupEnv` (lines 44–68) for token-shape validation that must remain in place; D-02's `--rotate-env` path reuses it unchanged.
- `scripts/verify/phase-1.ts` — Fail-fast `assert(cond, msg)` shape and group-headers style to mirror in `phase-4.ts`. SSH-capture helper (`sshCapture`) is duplicated there and in `smoke-test.ts`; D-Discretion notes whether to extract for the third copy.
- `scripts/lib/{config,ssh,doctl}.ts` — Reusable helpers. `loadConfig`, `loadDropletInfo`, `sshFlags`, `sshRun`, `runCapture`, `runVisible`, `doctlJson`, `first` all directly reusable. No new types or new helpers required for the locked decisions.
- `droplet/install-cron.sh` lines 34, 48–54 — `# github-backup-managed` marker + grep-strip-then-append pattern is the source of cron idempotency that D-05 leans on. Do not modify.
- `droplet/bootstrap.sh` — Re-runnable as-is (D-07). Read for the `apt`/`gh CLI`/`gh auth login --with-token`/`install-cron.sh` flow so the verify script's pre-condition asserts match what bootstrap actually leaves on the droplet.

### Phase 2 / Phase 3 baselines (in-flight / soft-depend)
- `.planning/phases/02-monitoring/02-CONTEXT.md` — `bootstrap.sh` adds `mkdir -p /var/lib/github-backup` (Phase 2 D-05). Idempotent, already covered by D-07's "OS-level idempotent" claim — no Phase 4 change needed, but the verify script's pre-condition assertions should not assume that directory is absent.
- `.planning/phases/03-restore/03-CONTEXT.md` — Adds `restoreTestRepo` to `Config`. Phase 4 does not interact with restore, but `verify:phase-4` runs after destroy and so must NOT depend on a live droplet existing post-completion (so it cannot, e.g., share state with `verify:phase-3`).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lib/config.ts` `loadConfig`, `loadDropletInfo`, `bail` — direct reuse in `verify/phase-4.ts` and in any `bootstrap-droplet.ts` change. No type changes required for Phase 4.
- `scripts/lib/ssh.ts` `sshFlags`, `sshRun`, `scpFile`, `runVisible`, `runCapture`, `expandHome`, `waitForSsh` — direct reuse. The remote-file probe in D-03 (`test -f ${BACKUP_DIR}/backup.env`) is one `runCapture` of `ssh ... 'test -f ... && echo yes || echo no'` (or `sshExitsZero` pattern from `phase-1.ts` lines 83–113 — borrow it).
- `scripts/lib/doctl.ts` `doctlJson`, `first` — direct reuse for the post-destroy `droplet list` / `firewall list` assertions in D-12 group 5.
- `scripts/destroy-droplet.ts` `findFirewallId`, `dropletExists` — already encode the NR-09-correct semantics for "is this resource gone?" — `verify:phase-4` can either re-implement the simple positive check (list + filter, no special error handling needed because we're not deleting based on the result) or import these helpers if the planner judges them worth extracting. Inline list-and-filter is simpler.
- `scripts/verify/phase-1.ts` `assert(cond, msg)` and `sshCapture(...)` / `sshExitsZero(...)` helpers — copy-paste style established in Phase 1, fine to repeat in `phase-4.ts` per the same surgical-changes posture (or extract — see D-Discretion).

### Established Patterns
- **TypeScript + tsx + npm script** for every operator-facing command. `verify:phase-4` follows.
- **Fail-fast verify with named assertions** (Phase 1 D-07). Group headers (`— Group N: <name> —`) plus per-assertion ✓/✗.
- **`--yes` flag for non-interactive automation paths.** Established by `destroy-droplet.ts`. Reused by `verify:phase-4` (D-13).
- **Marker-line idempotency on the droplet.** `# github-backup-managed` in cron (`install-cron.sh`) is the canonical pattern; D-05 leans on it. If a future need arises for similar idempotency in another file, use the same marker convention rather than inventing a new one.
- **Refuse-with-clear-message over assume-and-act.** Both `loadDropletInfo` (bails when `.droplet.json` missing) and `destroy-droplet.ts` (refuses without `.droplet.json`) follow this. D-09 reaffirms: no `--force` mode that bypasses the missing-`.droplet.json` refusal.
- **`doctl` error-class disambiguation (NR-09).** Distinguishing empty-list / 404 from genuine doctl failure is the existing pattern in `destroy-droplet.ts`. `verify:phase-4`'s post-destroy assertions don't need this (they're list-then-filter, not delete-based), but if the planner adds the inline post-destroy assertion to `destroy-droplet.ts` itself (D-08 discretion), the same pattern must hold.

### Integration Points
- **Edit:** `scripts/bootstrap-droplet.ts` — add SSH probe of `${BACKUP_DIR}/backup.env` before the upload step; conditional skip with explicit log line when present and `--rotate-env` not passed; read `--rotate-env` flag with the same `hasFlag(...)` helper shape as `destroy-droplet.ts`. Token-shape validation in `writeBackupEnv` stays. D-01 / D-02 / D-03 / D-04.
- **New file:** `scripts/verify/phase-4.ts` — six assertion groups per D-12.
- **Edit:** `package.json` — add `"verify:phase-4": "tsx scripts/verify/phase-4.ts"`.
- **Edit (optional, planner discretion D-08):** `scripts/destroy-droplet.ts` — add a final `doctl list` assertion block after the deletes complete.
- **Edit:** `README.md` — short Lifecycle paragraph per D-15.
- **No change:** `droplet/install-cron.sh` (D-05), `droplet/bootstrap.sh` (D-07), `scripts/create-droplet.ts`, `scripts/lib/*` (no new helpers required for the locked decisions).

</code_context>

<specifics>
## Specific Ideas

- The "skip-if-exists with explicit log + opt-in overwrite" pattern (D-01 / D-02 / D-04) is the same shape as how config-management tools (Ansible, Puppet) handle "managed file with operator-overridable content". It is the right default for a single-operator system: the operator is the source of truth for what's currently on the droplet, the local repo is the source of truth for the scripts. `backup.env` is operator-state on the droplet; scripts are local-state pushed to droplet. Different defaults are correct.
- `verify:phase-4` is the ONLY destructive verify in v1 (Phase 1 verify is read-only modulo triggering a backup; Phase 3 verify uses a temp dir; Phases 2 & 5 are read-only). The `--yes` gate in D-13 is therefore not paranoia — it is the only line of defense between "operator runs the wrong verify" and "operator's droplet is gone".
- Re-running bootstrap is the natural "I just edited `droplet/github-backup.sh` and want to push the change" workflow. The skip-`backup.env` default makes that workflow zero-friction (no need to re-export `GITHUB_TOKEN`). This is the dominant use case; the `--rotate-env` path is the rare one.
- `bootstrap-droplet.ts` `writeBackupEnv` already requires `GITHUB_TOKEN`; under D-01 the script must also tolerate `GITHUB_TOKEN` being unset on the skip-path. Planner: gate the `bail("GITHUB_TOKEN environment variable is not set...")` on the upload-vs-skip branch — if we're skipping `backup.env` upload, an unset `GITHUB_TOKEN` is fine and should be silent.

</specifics>

<deferred>
## Deferred Ideas

- **`npm run redeploy` macro** — `destroy && create && bootstrap`. The smoke runner already does this via `--fresh`, and the three commands are short. Adding a macro is sugar, not capability. Revisit if the operator surfaces real friction.
- **Mirror-freshness gate on destroy** (refuse if last successful backup >24h old). Rejected for v1 per D-10. Capture if a real near-miss emerges.
- **`--force` destroy without `.droplet.json`** — explicitly rejected per D-09. Future "rebuild `.droplet.json` from `doctl` discovery" helper would be the right fix if this need is real; not in v1 scope.
- **DigitalOcean snapshot before destroy** — would buy "oops" recovery for the mirrors at the cost of (a) a per-snapshot DO charge, (b) a state-flag in `.droplet.json` to track the snapshot id for cleanup, (c) a separate `restore-from-snapshot` command. Out of v1 single-droplet posture (PROJECT.md). Capture for a hypothetical future "off-droplet redundancy" phase.
- **Re-derive `.droplet.json` from `doctl` discovery** — useful if operator loses local state. Modest scope, but no live operator pain reported. Capture for v2 ops-tooling.
- **Multi-droplet teardown** (Phase 5 territory once `MULTI-01` lands and the implicit assumption "one droplet at a time" no longer holds). Not relevant in v1.
- **Rotation alerting** (`--rotate-env` triggers a Slack/email notice) — explicitly v2 alerting territory per PROJECT.md / Phase 2 deferred.
- **Idempotency telemetry** — emit a structured `BOOTSTRAP_RESULT` line analogous to `BACKUP_SUMMARY` so the future status command can show "last bootstrap was a no-op vs a re-write". Nice-to-have, not load-bearing for SC#1.

</deferred>

---

*Phase: 04-teardown*
*Context gathered: 2026-05-10*
