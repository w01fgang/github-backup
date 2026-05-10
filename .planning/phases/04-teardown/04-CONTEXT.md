# Phase 4: Bootstrap idempotency - Context

**Gathered:** 2026-05-10 (rewritten 2026-05-11)
**Status:** Ready for planning

> **2026-05-11 scope cut.** Original Phase 4 was "Teardown / redeploy" covering both bootstrap idempotency AND a clean `destroy-droplet` script. Operator decided automated droplet teardown is out of scope (manual DO-dashboard removal is sufficient at single-operator scale). TEARDOWN-02 was removed from REQUIREMENTS. Phase 4 now covers bootstrap idempotency only. The destroy-related decisions from the original CONTEXT (D-08, D-09, D-10, D-12 group 5/6, D-13's destructive-verify gate) are removed below; the `scripts/destroy-droplet.ts` file has been deleted from the repo and `--fresh` removed from the smoke runner. See PROJECT.md → "No automated droplet teardown" for the project-level decision and `01-CONTEXT.md` "Post-phase amendment 2026-05-11" for the Phase 1 cleanup.

<domain>
## Phase Boundary

**One locked outcome:** Re-running `npm run bootstrap-droplet` against a live, already-bootstrapped droplet is a no-clobber no-op. Specifically:

- `backup.env` is preserved (the runtime `GITHUB_TOKEN` is not silently rewritten with whatever's in the operator's shell)
- The cron entry stays at exactly one `# github-backup-managed` line
- Droplet-side `*.sh` scripts are refreshed in place (intended overwrite — that's how operator ships code changes)
- Once Phase 6 (webhook listener) lands, the listener restarts cleanly across re-bootstraps (systemd unit `Restart=on-failure` + `daemon-reload` only when the unit file changed)

The script must succeed without error on the second, third, … N-th invocation.

**In scope:**
- Make `bootstrap-droplet.ts` (and supporting `droplet/bootstrap.sh` if needed) idempotent w.r.t. `backup.env` and the cron line on a live droplet
- `scripts/verify/phase-4.ts` + `npm run verify:phase-4` proof script (read-only against a live droplet — non-destructive)
- README short paragraph on the lifecycle invariants (bootstrap re-run safe; how to rotate the token deliberately)

**Out of scope:**
- `scripts/destroy-droplet.ts` and any `npm run destroy-droplet` operator command — DELETED 2026-05-11
- A `npm run redeploy` macro — single operator can run the two commands manually
- Multi-source / multi-config aware idempotency — Phase 5 territory; Phase 5 must inherit Phase 4's idempotency contract
- Webhook listener idempotency — Phase 6 owns the systemd unit reload semantics; this phase only commits to "do not regress whatever Phase 6 lands"

</domain>

<decisions>
## Implementation Decisions

### Bootstrap idempotency — `backup.env`

- **D-01:** **Skip-if-exists for `backup.env` by default.** When the remote `${BACKUP_DIR}/backup.env` already exists, the bootstrap upload step does NOT overwrite it. The operator's runtime `GITHUB_TOKEN` env var (and `GITHUB_USER_OR_ORG`, `BACKUP_DIR`, `CRON_SCHEDULE` from `config.json`) is preserved as-is on the droplet. Rationale: clobbering `backup.env` on re-run would silently rotate the active GitHub token to whatever's in the current shell — surprising for the "I'm just refreshing droplet scripts after a code change" use case, and a footgun if the operator re-runs bootstrap without exporting the token at all.

- **D-02:** **`--rotate-env` flag forces a fresh `backup.env` upload** (overwrite). Use case: operator deliberately wants to rotate their PAT, or change `cronSchedule` / `githubUserOrOrg` in `config.json` and push the new values. Without this flag, the on-droplet `backup.env` is the source of truth once it exists. The flag MUST require `GITHUB_TOKEN` to be set; refuse loudly if not.

- **D-03:** **First-run detection is by remote-file probe**, not by local state. Bootstrap SSHes once and runs `test -f ${BACKUP_DIR}/backup.env`; the exit code drives the skip-vs-write decision. This works correctly even if the operator's local checkout is fresh (no `.droplet.json` history) but the droplet is in fact already bootstrapped — e.g., a re-cloned project tree. Probe failure (SSH transport error, exit 255) MUST bail loudly — do not assume "absent" from a network blip and silently overwrite.

- **D-04:** **When `backup.env` is preserved, log the skip explicitly.** A line like `▸ ${BACKUP_DIR}/backup.env exists on droplet — preserving (use --rotate-env to overwrite)`. Operator must never wonder whether their token survived. The bootstrap output is the only feedback channel; silence here violates the fail-loud rule (silent preserve is also misleading if not announced).

### Bootstrap idempotency — cron + scripts

- **D-05:** **Cron line idempotency is already handled** by `droplet/install-cron.sh` lines 48–54: existing `# github-backup-managed` markers are stripped before the new line is appended, so the marker count is invariant at exactly 1. Phase 4 does NOT modify `install-cron.sh`. Phase 4 ASSERTS the invariant in `verify:phase-4` (count `crontab -l | grep -c "${CRON_MARKER}"` must equal 1 both before and after a re-run of bootstrap).

- **D-06:** **`droplet/*.sh` scripts are always re-uploaded** (overwrite). The shell scripts are the operator's mechanism for shipping code changes to the droplet; clobbering them is the intended behavior, not a footgun. `chmod +x` after upload remains as today. No conditional logic needed.

- **D-07:** **`bootstrap.sh` re-run on the droplet stays as-is** — `apt-get update/upgrade/install`, `gh CLI install`, `mkdir -p ${BACKUP_DIR}`, `chmod 700`, `gh auth login --with-token < ${GITHUB_TOKEN}`, `gh auth setup-git`, `touch ${LOG_FILE}`, `install-cron.sh` — every step is already idempotent at the OS level. Re-running it is safe. The one exception is `gh auth login --with-token`: it re-authenticates each time, which is fine because the token in `backup.env` is now stable (D-01), so the auth result is identical run-to-run. **Once Phase 6 lands**, `bootstrap.sh` will additionally `systemctl daemon-reload && systemctl restart github-backup-webhook` — that step is owned by Phase 6's CONTEXT, not added retroactively here.

### `verify:phase-4` — assertion design

- **D-11:** **`scripts/verify/phase-4.ts`, wired as `npm run verify:phase-4`, follows the Phase 1 / Phase 3 template** — TypeScript + tsx, `assert(cond, msg)` fail-fast, exit 0 on all-pass, named-assertion exit 1 on first fail. Reuses `scripts/lib/{config,ssh,doctl}.ts` as established in Phase 1 D-06.

- **D-12:** **`verify:phase-4` assertion groups (in order, all NON-destructive):**
  1. **Pre-conditions:** Droplet alive (`doctl compute droplet get <id>` returns `active`), `backup.env` exists on droplet with mode 600, exactly 1 `# github-backup-managed` line in `crontab -l`. Same shape as Phase 1 D-07.2 sanity checks.
  2. **`backup.env` preservation:** Capture `sha256sum ${BACKUP_DIR}/backup.env` over SSH → `H1`. Re-run `npm run bootstrap-droplet` (no `--rotate-env`). Capture `sha256sum` again → `H2`. Assert `H1 === H2`. Assert remote-side mtime is also unchanged. Assert mode is still `600`.
  3. **Cron-marker invariant:** Capture `crontab -l | grep -c "# github-backup-managed"` → `N1` (should be 1 from group 1). After the bootstrap re-run, capture again → `N2`. Assert `N2 === 1` (equality, not just `≥ 1`).
  4. **`--rotate-env` round-trip (env-gated):** If `GITHUB_TOKEN` is present in the verify-script's environment, run `npm run bootstrap-droplet -- --rotate-env`, then assert `backup.env` exists, mode is still `600`, and the file is parseable (`gh auth status` exits 0 after the re-bootstrap). If `GITHUB_TOKEN` is absent, log "skipping --rotate-env round-trip (GITHUB_TOKEN unset)" and continue.

- **D-14:** **`verify:phase-4` assumes a freshly-bootstrapped droplet at start.** It does NOT call `create-droplet` or `bootstrap-droplet` from scratch — it assumes `verify:phase-1` has already passed and the droplet is in the standard post-Phase-1 state. The script's header comment must call this dependency out explicitly.

- **D-13** ~~(Removed 2026-05-11)~~ — was the destructive-verify `--yes` gate. With the destroy step removed from group 5/6, `verify:phase-4` is now non-destructive (rotate-env path mutates `backup.env` if `GITHUB_TOKEN` is set, but does not destroy infrastructure). No safety gate required. Standard verify ergonomics apply.

### Documentation

- **D-15:** **README short addition under the operator-commands section:** two-paragraph note that (a) `npm run bootstrap-droplet` is safe to re-run; `backup.env` is preserved by default; pass `--rotate-env` to push a fresh token / cron schedule, and (b) when the operator wants to fully tear down, delete the droplet from the DigitalOcean dashboard (and remove `.droplet.json` locally). Copy-pasteable, terse, command-reference shaped.

### Removed (originally in this CONTEXT, dropped 2026-05-11)

- ~~D-08~~ "destroy-droplet.ts refinements" — script deleted from repo
- ~~D-09~~ "no `--force` for destroy" — moot, no destroy
- ~~D-10~~ "no mirror-freshness gate on destroy" — moot, no destroy
- ~~D-12 group 5~~ "destroy + post-destroy assertions" — removed
- ~~D-12 group 6~~ "refusal when `.droplet.json` missing" — removed
- ~~D-13~~ destructive-verify `--yes` gate — superseded above

### Claude's Discretion

- **D-12 group 4 sub-decision:** whether `verify:phase-4` should also run `bash -n` on a sourced copy of `backup.env` after `--rotate-env` (catches "valid token shape but corrupted file" bugs). `gh auth status` already covers most of this. Planner picks.
- Whether `--rotate-env` is the literal flag name vs `--overwrite-env` / `--force-env` / `--reset-token`. Naming taste; constraint is the flag must clearly signal "I know this overwrites the active token on the droplet". Planner picks.
- Whether to extract the SSH-capture helper duplicated in `phase-1.ts` and (formerly) `smoke-test.ts` into `scripts/lib/ssh.ts` (a `sshCapture` function) before adding the third copy in `phase-4.ts`, vs accepting one more copy. Planner picks per Phase 1's surgical-changes posture.
- How Phase 4 interacts with Phase 6 (webhook listener) when both are in flight: if Phase 6 lands BEFORE Phase 4 ships, Phase 4's verify must additionally assert the listener survives a bootstrap re-run (`systemctl is-active github-backup-webhook` before AND after). If Phase 4 lands first, the listener-survival assertion is added in Phase 6.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Single-operator scope, runtime-only token policy, fire-and-forget mirror posture, "no automated droplet teardown" key decision (2026-05-11). `backup.env` preservation default in D-01 directly serves the runtime-only token rule.
- `.planning/REQUIREMENTS.md` §Lifecycle — TEARDOWN-01 only (TEARDOWN-02 removed 2026-05-11).
- `.planning/ROADMAP.md` §Phase 4 — Success criteria 1 (no duplicate cron), 2 (preserves `backup.env`; `--rotate-env` for explicit upload), 3 (listener restart cleanly — Phase 6 dependency).

### Phase 1 baseline (depended-on, do not regress)
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` — TypeScript/`tsx` + `npm run` convention (D-03), 100% pass bar (D-02), `verify:phase-N` script convention (D-06/D-07). **Read the "Post-phase amendment — 2026-05-11" section** at the bottom — it documents the destroy-droplet removal that this Phase 4 inherits.
- `scripts/bootstrap-droplet.ts` — Currently always-overwrites `backup.env`. The change site for D-01 / D-02 / D-03 / D-04. Read `writeBackupEnv` for token-shape validation that must remain in place; D-02's `--rotate-env` path reuses it unchanged.
- `scripts/verify/phase-1.ts` — Fail-fast `assert(cond, msg)` shape and group-headers style to mirror in `phase-4.ts`. SSH-capture helper (`sshCapture`) is duplicated there; D-Discretion notes whether to extract for the second copy.
- `scripts/lib/{config,ssh,doctl}.ts` — Reusable helpers. `loadConfig`, `loadDropletInfo`, `sshFlags`, `sshRun`, `runCapture`, `runVisible`, `doctlJson`, `first` all directly reusable.
- `droplet/install-cron.sh` lines 34, 48–54 — `# github-backup-managed` marker + grep-strip-then-append pattern is the source of cron idempotency that D-05 leans on. Do not modify.
- `droplet/bootstrap.sh` — Re-runnable as-is (D-07).

### Phase 2 / Phase 3 / Phase 5 / Phase 6 baselines (in-flight / soft-depend)
- `.planning/phases/02-monitoring/02-CONTEXT.md` — `bootstrap.sh` adds `mkdir -p /var/lib/github-backup` (Phase 2 D-05). Idempotent; no Phase 4 change needed.
- `.planning/phases/03-restore/03-CONTEXT.md` — Adds `restoreTestRepo` to `Config`. No interaction.
- `.planning/phases/05-multi-source/05-CONTEXT.md` — Phase 5 introduces `githubSources` array. Phase 4's `--rotate-env` path must accept the new config shape; treat the multi-source schema as the canonical config shape for D-02. Phase 5 owns the back-compat layer.
- `.planning/phases/06-webhook/06-CONTEXT.md` (when written) — Phase 6 introduces the systemd-unit + listener. Phase 4's bootstrap-re-run idempotency contract MUST extend to "the listener restarts cleanly without dropping in-flight requests", but the systemd-unit semantics are owned by Phase 6.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lib/config.ts` `loadConfig`, `loadDropletInfo`, `bail` — direct reuse in `verify/phase-4.ts` and any `bootstrap-droplet.ts` change. No type changes required for Phase 4 itself (Phase 5 mutates `Config` shape).
- `scripts/lib/ssh.ts` `sshFlags`, `sshRun`, `scpFile`, `runVisible`, `runCapture`, `expandHome`, `waitForSsh` — direct reuse. The remote-file probe in D-03 (`test -f ${BACKUP_DIR}/backup.env`) is one `runCapture` of `ssh ... 'test -f ... && echo yes || echo no'`.
- `scripts/lib/doctl.ts` `doctlJson`, `first` — direct reuse for the pre-condition droplet-alive assertion in D-12 group 1.
- `scripts/verify/phase-1.ts` `assert(cond, msg)` and `sshCapture(...)` / `sshExitsZero(...)` helpers — copy-paste style established in Phase 1, fine to repeat in `phase-4.ts` (or extract — see D-Discretion).

### Established Patterns
- **TypeScript + tsx + npm script** for every operator-facing command. `verify:phase-4` follows.
- **Fail-fast verify with named assertions** (Phase 1 D-07). Group headers (`— Group N: <name> —`) plus per-assertion ✓/✗.
- **Marker-line idempotency on the droplet.** `# github-backup-managed` in cron (`install-cron.sh`) is the canonical pattern; D-05 leans on it. Phase 6's systemd unit should follow the same convention (clearly-labeled unit name, idempotent install).
- **Refuse-with-clear-message over assume-and-act.** `loadDropletInfo` bails when `.droplet.json` missing. D-03 reaffirms: SSH probe failure must bail, not be silently treated as "absent".

### Integration Points
- **Edit:** `scripts/bootstrap-droplet.ts` — add SSH probe of `${BACKUP_DIR}/backup.env` before the upload step; conditional skip with explicit log line when present and `--rotate-env` not passed; read `--rotate-env` flag (mirror the previous `hasFlag(...)` shape — note `hasFlag` was removed from `smoke-test.ts` in the 2026-05-11 cleanup but the trivial helper can be re-introduced inline). Token-shape validation in `writeBackupEnv` stays.
- **New file:** `scripts/verify/phase-4.ts` — four assertion groups per D-12 (groups 1–4; old groups 5–6 dropped).
- **Edit:** `package.json` — add `"verify:phase-4": "tsx scripts/verify/phase-4.ts"`.
- **Edit:** `README.md` — short Lifecycle paragraph per D-15 (re-run safe; manual teardown via DO dashboard).
- **No change:** `droplet/install-cron.sh` (D-05), `droplet/bootstrap.sh` (D-07; Phase 6 may add to it later), `scripts/create-droplet.ts`, `scripts/lib/*` (no new helpers required for the locked decisions).

</code_context>

<specifics>
## Specific Ideas

- The "skip-if-exists with explicit log + opt-in overwrite" pattern (D-01 / D-02 / D-04) is the same shape as how config-management tools (Ansible, Puppet) handle "managed file with operator-overridable content". Right default for a single-operator system: the operator is the source of truth for what's currently on the droplet, the local repo is the source of truth for the scripts. Different defaults are correct for different artifact classes.
- Re-running bootstrap is the natural "I just edited `droplet/github-backup.sh` and want to push the change" workflow. The skip-`backup.env` default makes that workflow zero-friction (no need to re-export `GITHUB_TOKEN`).
- `bootstrap-droplet.ts` `writeBackupEnv` already requires `GITHUB_TOKEN`; under D-01 the script must also tolerate `GITHUB_TOKEN` being unset on the skip-path. Planner: gate the `bail("GITHUB_TOKEN environment variable is not set...")` on the upload-vs-skip branch — if we're skipping `backup.env` upload, an unset `GITHUB_TOKEN` is fine and should be silent.
- With destroy-droplet removed, `verify:phase-4` is the gentlest verify in the suite: read-only against infrastructure, only mutates `backup.env` if the env-gated `--rotate-env` round-trip runs. Safe to wire into a "run all verifies" macro if one ever exists.

</specifics>

<deferred>
## Deferred Ideas

- **Automated droplet teardown / `npm run destroy-droplet`** — moved to v2 deferred (REQUIREMENTS.md). Operator chose manual DO-dashboard removal at single-operator scale.
- **`npm run redeploy` macro** — `create && bootstrap`. Two commands, low friction. Revisit if the operator surfaces real friction.
- **DigitalOcean snapshot before bootstrap re-run** — would buy "oops" recovery if a future bootstrap regression nuked something. Out of v1 single-droplet posture. Capture for a hypothetical "off-droplet redundancy" phase.
- **Re-derive `.droplet.json` from `doctl` discovery** — useful if operator loses local state. Out of Phase 4 scope; capture for v2 ops-tooling.
- **Multi-droplet bootstrap idempotency** — Phase 5 multi-source covers per-source data layout but not per-droplet sharding. Real multi-droplet is a v2 deferred per PROJECT.md.
- **Rotation alerting** (`--rotate-env` triggers a Slack/email notice) — v2 alerting territory.
- **Idempotency telemetry** — emit a structured `BOOTSTRAP_RESULT` line analogous to `BACKUP_SUMMARY` so the future status command can show "last bootstrap was a no-op vs a re-write". Nice-to-have, not load-bearing for SC#1.

</deferred>

---

*Phase: 04-bootstrap-idempotency*
*Context gathered: 2026-05-10 (rewritten 2026-05-11)*
