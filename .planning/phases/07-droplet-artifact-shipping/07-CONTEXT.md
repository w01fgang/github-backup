# Phase 7: Droplet artifact shipping - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove every script that `droplet/github-backup.sh` and `droplet/webhook-listener.js` source-load — `sync-one-repo.sh`, `lib/detect-account-type.sh`, `lib/filter-repos.sh` — exists on the droplet, is executable, and honours its contract end-to-end.

**Reality check from scout (2026-05-16):**

- All three artifacts already EXIST in the repo (added during v1.0: `e3db1bb` Phase 3, `7715013` + `c32867b` Phase 6).
- `scripts/bootstrap-droplet.ts:289-294` uploads `droplet/*.{sh,js,template,service}`.
- `scripts/bootstrap-droplet.ts:305-322` uploads `droplet/lib/*.sh` (Phase 6).
- `droplet/bootstrap.sh:155` `chmod +x sync-one-repo.sh`; `:157-159` `chmod +x lib/*.sh` (guarded by `-d lib`).
- `droplet/github-backup.sh:101-103` source-loads both libs under `set -e`.
- `scripts/verify/phase-6.ts:356-382` already source-loads both libs on droplet inside verify run.

Phase 7 therefore is NOT "create missing files" — it is **prove the contracts hold on a fresh-bootstrapped droplet** (the static-check the 2026-05-16 todos asked for, plus the end-to-end mirror SC#4 that v1.0 deferred).

</domain>

<decisions>
## Implementation Decisions

### Verification surface
- **D-01:** Add a new `scripts/verify/phase-7.ts` (mirrors per-phase pattern in `package.json`). Do NOT extend `verify:phase-6.ts`. Do NOT defer to Phase 10 UAT.
- **D-02:** Wire `verify:phase-7` into `package.json` `scripts` block alongside `verify:phase-1..6`.

### E2E mirror proof target
- **D-03:** SC#4 (cron path mirrors at least one real repo end-to-end) is exercised against the **live DigitalOcean droplet** referenced by `.droplet.json`. No local docker emulation. No manual-operator deferral to Phase 10.
- **D-04:** `verify:phase-7` uses the same SSH primitives as `verify:phase-6` (`scripts/lib/ssh.ts`) — `sshRun`, `sshFlags`, `runCapture`. No new SSH wrapper.

### Contract depth (derived from ROADMAP SC#1-4, locked by Claude per user delegation)
- **D-05 (SC#1, sync-one-repo.sh):** Assert `test -x /opt/github-backups/sync-one-repo.sh`, plus functional assertion that a one-repo invocation produces a `/opt/github-backups/<owner>/<owner>_<repo>.git` directory (D-07 namespaced layout) AND emits the per-repo RESULT_TAG log line (D-15 contract).
- **D-06 (SC#2, detect-account-type.sh):** Source-load smoke under `set -e` (already done in phase-6; replicate here for phase-7 self-containment), plus one functional unit case — `detect_account_type "definitely-not-a-real-slug-xxx"` returns `User` (default-on-non-200 contract).
- **D-07 (SC#3, filter-repos.sh):** Source-load smoke under `set -e`, plus three golden unit cases run on the droplet:
  - empty allow → all lines pass through;
  - deny `*-test` denies `owner/foo-test` even if allow `*` matches (deny wins);
  - allow `tools/*` passes `tools/x`, blocks `other/y`.
- **D-08 (SC#4, e2e):** Pre-arrange one small whitelisted repo in `config.json` (operator-supplied test repo or smallest existing source's smallest repo), then run `github-backup.sh` once on the droplet and assert (a) namespaced mirror dir present, (b) at least one RESULT_TAG `action=clone|update` line, (c) zero `unbound variable` / `command not found` lines in `/var/log/github-backup.log` tail.

### Bootstrap fail-loud (out of scope)
- **D-09:** Do NOT touch `droplet/bootstrap.sh:157-159`'s `if [[ -d lib ]]` guard in Phase 7. Droplet-side fail-loud belongs to Phase 8 (MANIFEST-01 uploader-side pre-flight). Phase 7 surfaces missing-artifact symptoms via the verify script, not bootstrap-time aborts.

### Claude's Discretion
- Contract-depth selection (D-05..D-08) was delegated by the user. Mapping derived directly from ROADMAP `.planning/ROADMAP.md` Phase 7 success criteria SC#1-4. Each SC forces one or more depth tiers; nothing optional.
- Test-repo selection for SC#4 e2e (smallest existing whitelisted repo vs operator-supplied tiny scratch repo) is left to planning — both satisfy SC#4. Planning should pick the cheaper of the two given current `config.json`.

### Folded Todos

Three pending todos folded into Phase 7 scope:

- **`2026-05-16-missing-sync-one-repo-sh-causes-backup-failure`** (resolves_phase: 7) — Original premise (file missing) is now stale; the file exists since `e3db1bb`. Re-scoped to: verify `sync-one-repo.sh` ships, is executable, and honours D-07 + D-15 contracts on a fresh droplet (covered by D-05 + D-08).
- **`2026-05-16-missing-phase-6-lib-helpers-break-source-detection`** (resolves_phase: 7) — Both helpers exist since `7715013` / `c32867b`. Re-scoped to: verify both `lib/*.sh` ship, source-load under `set -e`, and pass golden contract cases (covered by D-06 + D-07).
- **`2026-05-16-webhook-listener-files-optional-in-uploader-but-required-at-runtime`** (frontmatter `resolves_phase: 8`) — Folded into Phase 7 *context only* so planning sees the related bootstrap-uploader gap. Implementation belongs in Phase 8 (MANIFEST-01/02). Phase 7 does NOT modify `scripts/bootstrap-droplet.ts`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope + requirements
- `.planning/ROADMAP.md` §"Phase 7: Droplet artifact shipping" — goal, depends-on, success criteria SC#1-4 (the contract Phase 7 must prove).
- `.planning/REQUIREMENTS.md` DROPLET-01, DROPLET-02, DROPLET-03 — the three requirements this phase closes.
- `.planning/PROJECT.md` §"Current Milestone: v1.1" — the runtime-critical-bug framing.
- `.planning/STATE.md` §"Deferred Items" — v1.0 close set; rows mapped to Phase 7 (DROPLET-01..03).

### Artifacts under test (the contract carriers)
- `droplet/sync-one-repo.sh` — D-07 namespaced layout, `git clone --mirror` for new, `git remote update` for existing, per-repo `flock` fd 8, RESULT_TAG log line. Owns SC#1.
- `droplet/lib/detect-account-type.sh` — slug → `User`|`Organization`, default `User` on non-200. Owns SC#2.
- `droplet/lib/filter-repos.sh` — REPOS-01 allow/deny glob semantics, deny wins, empty allow = all. Owns SC#3.
- `droplet/github-backup.sh:101-103` — source-load sites under `set -e` that SC#2 + SC#3 protect.

### Uploader + bootstrap (read-only context for Phase 7)
- `scripts/bootstrap-droplet.ts:289-294` — `droplet/*.{sh,js,template,service}` upload loop.
- `scripts/bootstrap-droplet.ts:305-322` — `droplet/lib/*.sh` upload loop.
- `droplet/bootstrap.sh:155` — `chmod +x sync-one-repo.sh`.
- `droplet/bootstrap.sh:157-159` — `chmod +x lib/*.sh` (DO NOT modify in Phase 7; Phase 8's MANIFEST-01 owns fail-loud).

### Verification primitives (reuse, don't re-invent)
- `scripts/verify/phase-6.ts:356-382` — existing on-droplet source-load probe for both libs. Reference implementation for Phase 7's source-load smoke.
- `scripts/lib/ssh.ts` — `sshFlags`, `sshRun`, `runCapture`, `waitForSsh`.
- `scripts/lib/config.ts` — `loadConfig`, `loadDropletInfo` (Phase 7 needs both to address the droplet).
- `package.json` §scripts — `verify:phase-1..6` pattern to mirror.

### Prior-phase contracts referenced by SC
- D-07 (namespaced mirror layout `/opt/github-backups/<owner>/<owner>_<repo>.git`) — defined in v1.0 Phase 6.
- D-15 (sync-one-repo.sh per-repo flock + RESULT_TAG) — defined in v1.0 Phase 3.
- REPOS-01 (deny-wins glob semantics) — defined in v1.0 Phase 6.
- Archived plan dirs for the contracts above: `.planning/milestones/v1.0-phases/03-webhook/`, `.planning/milestones/v1.0-phases/06-multi-source/`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lib/ssh.ts` — all SSH/SCP primitives already exist; `verify:phase-7` should import, not re-implement.
- `scripts/lib/config.ts` — `loadConfig` + `loadDropletInfo` give us the droplet IP / SSH user / key + the sources/allow/deny needed to choose a one-repo test target.
- `scripts/verify/phase-6.ts` — battle-tested pattern for "bail on first failed assertion, no test framework, on-droplet bash one-liners via `sshRun`".

### Established Patterns
- Per-phase verify scripts are plain `tsx`, no test framework, no jest/vitest deps. `bail()` from `scripts/lib/config.ts` aborts non-zero with a banner.
- Assertions of on-droplet behaviour use `sshRun(ip, user, key, '<bash one-liner>')` with `bash -lc` so PATH/env mirrors a real shell.
- `set -euo pipefail` is the contract for every `droplet/*.sh` — Phase 7 assertions must run under the same flag set when proving source-loadability.

### Integration Points
- `package.json` `scripts` block — add `"verify:phase-7": "tsx scripts/verify/phase-7.ts"` between `verify:phase-6` and any existing helper script (mirror the alphabetical/numeric pattern already used).
- `.droplet.json` (gitignored) must exist locally for `verify:phase-7` to run — same precondition as `verify:phase-6`.
- `config.json` must have at least one source with at least one allow-matched repo for SC#4 e2e; planning should document the precondition prominently.

</code_context>

<specifics>
## Specific Ideas

- Re-use `verify:phase-6.ts`'s exact `sshRun` / `runCapture` invocation style for consistency; do not introduce a new SSH abstraction.
- Keep `verify:phase-7.ts` self-contained: no shared verify-helpers module. v1.0 verify scripts are each ~300-500 lines and intentionally standalone.
- Source-load smoke pattern from phase-6 (line 356): `bash -c 'set -e; source <path>; echo OK'` — replicate verbatim for Phase 7 self-containment.

</specifics>

<deferred>
## Deferred Ideas

- **Droplet-side fail-loud on missing lib helpers** — discussed but routed to Phase 8 (MANIFEST-01 uploader-side pre-flight). User's explicit choice not to double-up.
- **Local docker ubuntu-22.04 emulation harness** — rejected for SC#4 (would diverge from real droplet env: no systemd, no Caddy). Out of scope for v1.1; revisit only if DO costs become a concern.
- **Shared verify-helpers module** — tempting but rejected to match the standalone-per-phase pattern already established in v1.0. Refactor candidate for v1.2+ if a 7th+ verify script appears.

### Reviewed Todos (not folded)

None — all three matched todos were folded.

</deferred>

---

*Phase: 7-Droplet artifact shipping*
*Context gathered: 2026-05-16*
