---
phase: 01-verify-pipeline
reviewed: 2026-05-04T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - droplet/github-backup.sh
  - package.json
  - scripts/bootstrap-droplet.ts
  - scripts/create-droplet.ts
  - scripts/destroy-droplet.ts
  - scripts/lib/config.ts
  - scripts/lib/doctl.ts
  - scripts/lib/ssh.ts
  - scripts/smoke-test.ts
  - scripts/verify/phase-1.ts
findings:
  blocker: 1
  warning: 4
  total: 5
status: issues_found
---

# Phase 1: Code Review Report (Re-Review)

**Reviewed:** 2026-05-04T00:00:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Re-review of the 17 prior findings (4 blocker, 13 warning) after 14 atomic fix commits (5ec1c35..e45a7ef). All 17 prior findings are correctly addressed in code:

- **BL-01** (5ec1c35): `gh api` exit captured via direct assignment — non-zero exits the script with code 2. ✓
- **BL-02** (no dedicated commit): closed by BL-01's fix. `gh api --paginate` returns non-zero on partial pagination failures, so capturing the exit closes both holes. ✓
- **BL-03** (01babd7): assertion is now `matches.length >= 1` and parses `matches[matches.length - 1]`. Idempotent. ✓
- **BL-04** (a0c65df): `GITHUB_TOKEN` check hoisted to top of `main()` before `provision()`. ✓
- **WR-01..WR-13**: each addressed by its labelled commit; spot-checked all 13. ✓

Re-review surfaced **5 new findings** introduced or left under-covered by the patch series. One is BLOCKER-class (verify becomes non-deterministic when cron is installed, because the new flock guard's silent-exit path is incompatible with verify's "trigger then assert" model). Four are warnings: incomplete coverage of WR-04/WR-05/WR-11 fixes and a brittle trim in BL-01.

## Blockers

### NR-01: flock silent exit makes verify:phase-1 non-deterministic with cron installed

**File:** `droplet/github-backup.sh:35-40`, `scripts/verify/phase-1.ts:189-191`, `scripts/smoke-test.ts:116-124`
**Issue:** WR-02/WR-09 fix wraps the script body in:

```bash
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "[...] another github-backup.sh instance holds ${LOCK_FILE}; exiting." >&2
  exit 0
fi
```

`exit 0` on lock contention is correct for *cron* (avoids piling up retries). But `verify:phase-1.group3BackupRan` and `smoke-test.triggerBackup` invoke the script *expecting it to run*, and assert against a freshly-emitted `BACKUP_SUMMARY`. When the cron instance (installed by bootstrap, see `install-cron.sh`) is mid-run, the verify-triggered invocation:

1. Acquires nothing, exits 0.
2. Emits **no** new `BACKUP_SUMMARY` line (return is before line 167).
3. Verify reads `tail -n 50 /var/log/github-backup.log` and parses the **previous** run's `BACKUP_SUMMARY` (BL-03 fix even encourages this — "anchor on most recent line").
4. If the previous run was successful, verify reports green though the current trigger never executed.
5. If cron is mid-clone of a new repo, the previous summary may report `mirrored < upstream` (different upstream count) → verify fails for a stale reason that the operator cannot reproduce.

This is the same false-positive class as the original BL-01/BL-02 (silent zero-exit reports green). The cron schedule is installed by bootstrap, so this hazard is live in every fully-provisioned environment.

**Fix options:**

1. Different exit code on lock contention (e.g., `exit 75` — EX_TEMPFAIL), and have the verifier/smoke retry with exponential backoff up to N seconds, or fail loudly.
2. Distinguish the trigger source: pass `--require-lock` from verify/smoke; under that flag, block on `flock 9` (no `-n`) instead of silent-exiting.
3. Have verify trigger the backup via a wrapper that records start/end timestamps, and assert that the new `BACKUP_SUMMARY` line postdates the trigger time. Removes dependence on the lock semantics entirely.

Option 2 is smallest diff:

```bash
if [[ "${REQUIRE_LOCK:-0}" = "1" ]]; then
  flock 9   # block
else
  flock -n 9 || { echo "..." >&2; exit 0; }
fi
```

Verify and smoke set `REQUIRE_LOCK=1` before invoking the remote script.

---

## Warnings

### NR-02: BL-01 trim only strips one trailing empty mapfile element

**File:** `droplet/github-backup.sh:107-110`
**Issue:**

```bash
mapfile -t REPOS <<< "${REPO_LIST}"
if [[ "${#REPOS[@]}" -gt 0 && -z "${REPOS[-1]:-}" ]]; then
  unset 'REPOS[-1]'
fi
```

Strips exactly one trailing empty entry. `gh api --paginate ... --jq '.[].full_name'` is well-behaved today, but a future API quirk (e.g., a blank line mid-stream, double newline at EOF) leaves a `""` element in the middle or after the trim. The loop body then runs with `REPO_FULL=""`, producing:

- `OWNER=""`, `NAME=""`
- `MIRROR_PATH="${BACKUP_DIR}/_.git"`
- `CLONE_URL="https://github.com/.git"` — git clone fails → `(( FAIL++ ))`

Result: a phantom failure of an empty repo trips the 100%-pass bar without an actionable cause.

**Fix:** Filter all empties:

```bash
mapfile -t REPOS <<< "${REPO_LIST}"
REPOS=("${REPOS[@]}")  # noop, but pairs with the next line semantically
TMP=()
for r in "${REPOS[@]}"; do [[ -n "$r" ]] && TMP+=("$r"); done
REPOS=("${TMP[@]}")
```

Or read from a process-fd-captured exit, then `grep -v '^$'`.

---

### NR-03: WR-05 fix omits cronSchedule from SHELL_SAFE_FIELDS

**File:** `scripts/lib/config.ts:67-74`, `scripts/bootstrap-droplet.ts:61`
**Issue:** WR-05 added `SHELL_SAFE_FIELDS = [dropletName, firewallName, sshUser, sshKeyPath, githubUserOrOrg, backupDir]`. `cronSchedule` is omitted, but it is interpolated into the generated `backup.env`:

```ts
`CRON_SCHEDULE="${cfg.cronSchedule}"`,
```

Which is then sourced on the droplet with `set -a; source backup.env`. A `"`, `$`, or `` ` `` in `cronSchedule` either (a) breaks the env file's `source` step, or (b) injects shell on the droplet during `set -a` evaluation of variables before the explicit env vars get substituted into install-cron.sh. Same threat surface, asymmetric coverage.

**Fix:** Add `cronSchedule` to `SHELL_SAFE_FIELDS` (and consider extending the regex to allow ` ` and `*` and `,` and `/` and `-`, which are valid cron tokens — current regex already covers `*` is not allowed; need `[A-Za-z0-9 *,/_-]+` for cron-shape strings, or a separate cron-shape regex).

```ts
const SHELL_SAFE_FIELDS: (keyof Config)[] = [
  "dropletName", "firewallName", "sshUser", "sshKeyPath",
  "githubUserOrOrg", "backupDir",
];
const CRON_SAFE_RE = /^[0-9*,/ \t-]+$/;
// ... at the bottom of loadConfig:
if (!CRON_SAFE_RE.test(cfg.cronSchedule)) {
  bail(`config.json field "cronSchedule" is not a safe cron expression: ${JSON.stringify(cfg.cronSchedule)}`);
}
```

---

### NR-04: WR-11 sshExitsZero misclassifies signal-killed ssh as remote non-zero

**File:** `scripts/verify/phase-1.ts:83-101`
**Issue:**

```ts
const r = spawnSync(cmd, { shell: true, stdio: "pipe", encoding: "utf8" });
if (r.error) { throw ... }
if (r.status === 255) { throw new Error(`ssh transport failure ...`); }
return r.status === 0;
```

`spawnSync` returns `r.status === null` when the child is killed by a signal (e.g., SIGTERM during CI cleanup, OOM-killed). Neither `r.error` nor `r.status === 255` fires; `r.status === 0` is `false`, so the function returns `false` and the caller reports "remote command failed" — exactly the false-narrative class WR-11 was meant to eliminate.

**Fix:** Treat `r.signal != null` (or `r.status == null`) as a transport-class failure too:

```ts
if (r.signal) {
  throw new Error(`ssh killed by signal ${r.signal}`);
}
if (r.status === null) {
  throw new Error("ssh exited without a status (no signal reported)");
}
if (r.status === 255) { throw ... }
return r.status === 0;
```

---

### NR-05: WR-04 token shape regex rejects valid GitHub fine-grained PATs containing `_` only — but accepts trailing-CR tokens on Windows

**File:** `scripts/bootstrap-droplet.ts:45`
**Issue:** Validation `/^[A-Za-z0-9_]+$/` is reasonable for current PAT shapes (classic `ghp_*`, fine-grained `github_pat_*`). One residual hazard: if the operator pastes the PAT from a Windows-line-ending file via `GITHUB_TOKEN=$(cat token.txt)`, the value contains a trailing `\r` (CR) which the regex correctly rejects with the bail message — operator must trim. That's the intended behavior. **However**, `process.env["GITHUB_TOKEN"]` may also have leading/trailing whitespace from `export GITHUB_TOKEN=" ghp_xxx "` (e.g., copied from a shell history with prefixes). The regex rejects, bail message says "Trim whitespace/newlines and confirm the token shape" — but the script doesn't actually trim before validating, leaving the operator to debug a token they "know is right". Not a security defect; UX papercut.

**Fix:** Trim before validating, and surface the trimmed shape only in error context:

```ts
const githubToken = (process.env["GITHUB_TOKEN"] ?? "").trim();
if (!githubToken) bail("GITHUB_TOKEN is empty after trim.");
if (!/^[A-Za-z0-9_]+$/.test(githubToken)) {
  bail(`GITHUB_TOKEN contains characters outside [A-Za-z0-9_] after trim. Length=${githubToken.length}.`);
}
```

The same hardening should land in `smoke-test.ts:255-262` and `bootstrap()`'s pre-check (currently three separate token-presence checks: `smoke-test.ts:104`, `smoke-test.ts:255`, `bootstrap-droplet.ts:75`). Consolidate.

---

## Verification of Prior Fixes

Each prior finding's fix commit was inspected against the current source. Notes:

| Prior | Commit  | Code anchor                                                | Status                       |
|-------|---------|------------------------------------------------------------|------------------------------|
| BL-01 | 5ec1c35 | `droplet/github-backup.sh:103-110`                         | Fixed                        |
| BL-02 | (BL-01) | (closed by capturing `gh api --paginate` exit)             | Fixed (transitively)         |
| BL-03 | 01babd7 | `scripts/verify/phase-1.ts:200-207`                        | Fixed                        |
| BL-04 | a0c65df | `scripts/smoke-test.ts:255-262`                            | Fixed                        |
| WR-01 | 556df9d | `scripts/destroy-droplet.ts:79-96`                         | Fixed                        |
| WR-02 | 736a2c7 | `droplet/github-backup.sh:35-40`                           | Fixed (introduces NR-01)     |
| WR-03 | 4b9c000 | `scripts/lib/doctl.ts:21-28`                               | Fixed                        |
| WR-04 | 6a09a1c | `scripts/bootstrap-droplet.ts:45-52`                       | Fixed (see NR-05 papercut)   |
| WR-05 | b1edac9 | `scripts/lib/config.ts:67-103`                             | Fixed (see NR-03 gap)        |
| WR-06 | 71ec418 | `scripts/bootstrap-droplet.ts:108-111`                     | Fixed                        |
| WR-07 | 2cfdcdb | `droplet/github-backup.sh:142,145,154,157`                 | Fixed                        |
| WR-08 | af3d3b7 | `scripts/smoke-test.ts:163-205`                            | Fixed                        |
| WR-09 | 736a2c7 | (same as WR-02)                                            | Fixed (introduces NR-01)     |
| WR-10 | b1edac9 | `scripts/lib/config.ts:85-90`                              | Fixed                        |
| WR-11 | 18fdb8f | `scripts/verify/phase-1.ts:83-101`                         | Fixed (see NR-04 edge)       |
| WR-12 | 73a8642 | `droplet/github-backup.sh:66`                              | Fixed (logging-helper band only — other bands still box-draw, but original WR-12 was scoped to the logging band) |
| WR-13 | e45a7ef | `scripts/verify/phase-1.ts:29`                             | Fixed                        |

`tsc --noEmit` passes with no diagnostics.

---

_Reviewed: 2026-05-04T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
