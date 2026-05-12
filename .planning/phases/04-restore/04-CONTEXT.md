# Phase 3: Restore - Context

**Gathered:** 2026-05-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Operator can recover any single backed-up repo from the droplet to a working local clone with all branches, tags, and refs intact, AND the system has an executable `verify:phase-3` that proves this round-trip works against a configured test repo. README gets a documented, copy-pasteable Restore section that supersedes the existing minimal "Restore a single repo from a mirror" snippet (README §Recovery, lines 264–278).

**Data-flow constraint (locked, project-wide):** Backups are one-way `github.com → droplet mirror`. The droplet is a read-only sink, refreshed by cron. Restore = `droplet → local`. There is NO supported flow for pushing local changes back to the droplet mirror — local changes are not assumed to be sync-tracked by the backup. If the operator wants to "rehydrate" GitHub after a github.com loss, that is a separate manual `local → github.com` push and is documented as a recovery scenario, not an automated path.

**In scope:** restore docs in README; `npm run verify:phase-3` script asserting RM SC#2 + SC#3; whatever wrapper / helper command the planner judges necessary to make restore one-shot ergonomic; new `restoreTestRepo` field in `config.json`.

**Out of scope:** automated push-to-github-after-restore (manual operator step, documented only); restoring multiple users/orgs in one command (Phase 5 territory); restore-from-tarball / cold-storage paths; any encryption/decryption layer.

</domain>

<decisions>
## Implementation Decisions

### Test repo selection (D-01)
- **D-01:** Add a new `restoreTestRepo` field to `config.json` (e.g. `"restoreTestRepo": "sumin/dotfiles"`). `verify:phase-3` and any restore-test smoke step read this field and operate on that single mirror. Reproducible across droplets, predictable wall time, no ambiguity vs "first" or "smallest". Field is OPTIONAL: when unset, `verify:phase-3` exits with a clear "set config.restoreTestRepo to a `<owner>/<repo>` you have a mirror of" message — fail loud, do not silently pick a fallback.

### Ref-equivalence assertion (D-02)
- **D-02:** **Delegated to research/planner (Claude's discretion within constraints).** RM SC#3 says "identical branches + tags". Pick the strongest standard-tooling assertion that completes in reasonable wall time on the configured test repo. Constraint: comparison is droplet mirror vs restored clone — github.com is NOT the baseline (mirror freshness is a Phase 1/Phase 2 concern, not restore correctness). Acceptable approaches range from `git ls-remote` SHA-by-SHA diff (likely the right default — names + SHAs in one shot, standard git, no temp objects) up to full object-graph hash (`git rev-list --objects --all | sort | sha256sum`) if planner judges it warranted. Pick one and document why.

### Push-back semantics (D-03)
- **D-03:** **Delegated to research/planner (Claude's discretion within constraints).** RM SC#2 says "push a new commit locally". Locked constraint from D-domain: do NOT push back to droplet (not a supported flow); do NOT push back to github.com (would mutate operator's real repo and is a separate disaster-recovery operation). The remaining interpretations: (a) restored working clone can locally commit + push to a brand-new throwaway local bare = proves clone integrity; (b) drop the push assertion entirely if D-02's ref-equivalence already gives full coverage. Planner picks one based on what actually adds signal beyond D-02 — if D-02 already proves the restore is byte-equivalent to the mirror, an additional self-push test may be ceremony. Document the choice and reason in the verify script header.

### Restore operator surface (D-04)
- **D-04:** **Delegated to research/planner (Claude's discretion).** Locked: README Restore section (replacing/upgrading existing §Recovery snippet) + `npm run verify:phase-3` are MANDATORY. Whether to also add a `npm run restore -- <owner>/<repo> <target-dir>` operator helper is planner's call based on whether the manual command sequence is too brittle to leave as copy-paste. If a helper is added, `verify:phase-3` should USE the helper internally (no duplication of the restore dance). `restore-all` bulk command is OUT — defer to Phase 5 multi-source territory or a v2 ask.

### Verify script convention (carried from Phase 1 D-06)
- **D-05:** Implement as `scripts/verify/phase-3.ts`, wired as `npm run verify:phase-3`. TypeScript + tsx, exit 0 on all-pass, non-zero with named failed assertion on first fail (same fail-fast contract as `phase-1.ts`). Reuses `scripts/lib/{config,ssh}.ts` helpers — no new SSH plumbing.

### Restore environment expectations (D-06)
- **D-06:** Restore happens on the operator's local machine (the same machine that ran `create-droplet` / `bootstrap-droplet`). Restore commands assume `git`, `ssh`, and the SSH key referenced by `config.json` `sshKeyPath` are available locally. `verify:phase-3` runs from the project checkout (same as `verify:phase-1`), uses an OS-temp working directory for the restored clone, and cleans up on success. On failure, leave the temp dir and print its path so the operator can inspect.

### Disaster-recovery scenario in README (D-07)
- **D-07:** README Restore section MUST cover two distinct flows, clearly labelled:
  1. **Single-repo recovery** — operator wants a working local clone of one mirrored repo (everyday "I lost my laptop / I want to work offline" use case). Drives the copy-paste commands.
  2. **GitHub is gone / account compromised** — operator needs to know the manual path to push restored mirrors back up to github.com (or to a new git host) using a fresh PAT and a new repo. Explicit caveat: this is a manual, operator-driven recovery — there is no `restore-and-rehydrate` automation in v1, by design.

### Claude's Discretion
- D-02, D-03, D-04 explicitly delegated by operator after constraints were locked. Planner may choose specific paths, flag names, exact assertion form, and whether to introduce a `restore` helper, as long as the locked constraints (data-flow direction, droplet-as-sink, no auto-rehydrate) hold. Reopen any of these only if a constraint conflict surfaces during planning.
- Wall-clock budget for `verify:phase-3` (a slow test repo could push it past Phase 1's implicit speed bar) — planner picks a reasonable cap and documents what "test repo too big" looks like.
- Exact wording / structure of the README Restore section, beyond the two scenarios required by D-07.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Single-operator scope, runtime-only token policy, "fire-and-forget mirror" framing. Restore docs must not contradict the one-way mirror model.
- `.planning/REQUIREMENTS.md` — RESTORE-01 (documented + tested clone-back workflow), RESTORE-02 (refs/branches/tags preserved).
- `.planning/ROADMAP.md` §Phase 3 — Success criteria 1 (README copy-pasteable), 2 (clone-back + push + ref-count compare), 3 (identical branches + tags).

### Phase 1 baseline (depended-on, do not regress)
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` — TypeScript/`tsx` + `npm run` convention (D-03), 100% pass bar (D-02), `verify:phase-N` script convention (D-06/D-07), config+env split (D-05).
- `scripts/verify/phase-1.ts` — Fail-fast assertion style + `assert(cond, msg)` helper to mirror.
- `scripts/smoke-test.ts` — End-to-end orchestration pattern (provision → bootstrap → trigger → probe). Phase 3 verify is local-only (no provision step), but follows the same `runCapture` / `sshFlags` shape.
- `scripts/lib/{config,ssh,doctl}.ts` — Reusable helpers. `loadConfig`, `loadDropletInfo`, `sshFlags`, `sshRun`, `runCapture` all directly reusable. Add `restoreTestRepo` to the `Config` type in `scripts/lib/config.ts`.
- `droplet/github-backup.sh` — Naming convention for mirrors: `${BACKUP_DIR}/${owner}_${repo}.git`. Restore must derive paths the same way; do NOT introduce a separate naming scheme.

### Phase 2 baseline (in-flight, soft-depend)
- `.planning/phases/02-monitoring/02-CONTEXT.md` — Phase 2 introduces `last-run.json` and a `status` command. Phase 3 does NOT depend on Phase 2 — restore correctness is independent of monitoring state. But: README Restore section should not conflict with Phase 2's status output formatting if both ship before v1.

### Existing user-facing docs
- `README.md` §Recovery (lines ~264–278) — current "Restore a single repo from a mirror" snippet. Phase 3 supersedes / extends this section. Keep the URL/anchor stable so any external links still work.
- `README.md` §"Clone a mirrored repo for local development" (lines ~245–263) — overlaps with restore docs. Reconcile or merge during planning so the two sections do not contradict.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lib/ssh.ts` — `sshFlags(keyPath)`, `sshRun(...)`, `runCapture(...)`. Restore verify will SSH-clone from droplet (`git clone <user>@<ip>:/opt/github-backups/<owner>_<repo>.git`), so the same SSH key + flags pattern applies. Local `git clone` over SSH uses the same `-i <keyPath> -o BatchMode=yes` flags `sshFlags` already produces.
- `scripts/lib/config.ts` — `loadConfig`, `loadDropletInfo`, `Config` type, `bail`. Add `restoreTestRepo?: string` to `Config`. Update bail message to point operator at the field if missing for `verify:phase-3`.
- `scripts/verify/phase-1.ts` `assert(cond, msg)` — copy-paste this pattern (or extract to `scripts/lib/assert.ts` if planner judges shared utility worth the refactor; otherwise inline duplication is fine per Phase 1 surgical-changes posture).

### Established Patterns
- **TypeScript + tsx + npm script** for every operator-facing command. Restore (if a helper ships) and verify both follow.
- **Fail-fast verify with named assertions** (Phase 1 D-07 / `phase-1.ts`). `verify:phase-3` mirrors this — bail on first failed assertion with a message naming what failed.
- **Mirror path derivation:** `droplet/github-backup.sh` produces mirrors at `${BACKUP_DIR}/${owner}_${repo}.git` (underscore between owner and repo, `.git` suffix). Restore must use the same derivation. `BACKUP_DIR` is the droplet path from `config.json` `backupDir`.
- **Single-instance lock on droplet** (`/var/lock/github-backup.lock`, NR-06). Restore READS mirrors over SSH (git clone) — does NOT need to acquire the backup lock because git's own pack-objects is read-safe against a `remote update --prune` in progress. But document this in the verify script header so a future reader does not "fix" it by adding a lock acquire.

### Integration Points
- New file: `scripts/verify/phase-3.ts` — `npm run verify:phase-3` entry.
- New file (optional, planner's call per D-04): `scripts/restore.ts` — `npm run restore -- <owner>/<repo> <target>` entry.
- Edit: `scripts/lib/config.ts` — add `restoreTestRepo?: string` to `Config` type.
- Edit: `package.json` — add `"verify:phase-3": "tsx scripts/verify/phase-3.ts"` (and `"restore"` if helper ships).
- Edit: `README.md` — replace/extend §Recovery > "Restore a single repo from a mirror" per D-07 two-scenario structure; reconcile with §"Clone a mirrored repo for local development".
- Edit: `config.json` (project-checked-in copy) — add `restoreTestRepo` field with a sensible example value (e.g. operator's smallest known repo) and a comment / doc note that it's test-only.

</code_context>

<specifics>
## Specific Ideas

- Operator framed Areas 2–4 as "ask relevant agents — do whatever makes sense", with the explicit constraint that we are building a one-way `github → droplet` sync service, NOT a bidirectional sync. Treat that constraint as load-bearing for every implementation decision: restore tooling that even appears to support push-to-droplet creates a wrong mental model and should be avoided.
- Operator offered to provide user stories on demand if the planner needs them to disambiguate the surface (e.g. "single-repo helper or not"). Planner should ASK if blocked — do not invent personas.
- README §Recovery currently coexists with §"Clone a mirrored repo for local development". Both touch restore-shaped use cases. Merging or cross-linking them is a docs-cleanup the planner should explicitly decide on, not a side-effect.

</specifics>

<deferred>
## Deferred Ideas

- **`npm run restore-all` bulk-restore for full disaster recovery.** Belongs to v2 or a multi-source-aware Phase 5 follow-up. Current design assumes single-repo restore is the dominant use case and the operator iterates if they need many.
- **Automated rehydrate-to-github after restore.** Mutates the operator's GitHub account; needs OAuth-scope conversation and confirmation flow that is heavier than v1 supports. Document the manual path in README per D-07 instead.
- **Restore-time integrity scan** (e.g. `git fsck` on the droplet mirror before clone, or on the restored clone). Useful but adds wall-clock and complicates the assertion model. Defer unless ref-equivalence (D-02) catches a class of bugs that motivates adding it.
- **Restore-from-snapshot / cold-storage** (DO snapshot, S3 archive, etc.). Out of v1 single-droplet posture. Capture for a future "off-droplet redundancy" phase if the project ever needs durability beyond the active droplet.
- **Pruning-aware restore** (skip mirrors for repos no longer on github.com). Phase 2 deferred this as a "skipped" semantic; restore inherits the same deferral.

</deferred>

---

*Phase: 03-restore*
*Context gathered: 2026-05-10*
