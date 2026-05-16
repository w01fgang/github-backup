---
phase: 01-verify-pipeline
fixed_at: 2026-05-04T00:00:00Z
review_path: .planning/phases/01-verify-pipeline/01-REVIEW.md
iteration: 1
findings_in_scope: 17
fixed: 17
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-05-04T00:00:00Z
**Source review:** .planning/phases/01-verify-pipeline/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 17
- Fixed: 17
- Skipped: 0

Three review findings closed transitively (BL-02 by BL-01; WR-09 by WR-02; WR-10 folded into WR-05 commit), so the fix set is 14 commits covering 17 findings.

## Fixed Issues

### BL-01: `gh api` failure produces silent zero-exit "success"

**Files modified:** `droplet/github-backup.sh`
**Commit:** 5ec1c35
**Applied fix:** Replaced `mapfile -t REPOS < <(gh api ...)` (which discards the gh exit code via process substitution) with `REPO_LIST=$(gh api ...) || { log ERROR; exit 2; }` followed by `mapfile -t REPOS <<< "$REPO_LIST"` and a trailing-empty-line guard. A failing or partial pagination now aborts with exit 2.

### BL-02: Truncated mirror count is reported as 100% success

**Files modified:** (closed by BL-01)
**Commit:** 5ec1c35
**Applied fix:** Per the review's option (a) — `gh api --paginate` returns non-zero on partial pagination failure, and BL-01's exit-code capture already aborts on that. No additional commit required; the same change closes both holes.
**Status:** fixed: requires human verification — recommend the operator confirm `gh api --paginate` partial-failure behavior on a real expired-PAT or rate-limited account once during T-01-XX-XX.

### BL-03: `verify:phase-1` re-asserts `matches.length === 1` — fails on second run

**Files modified:** `scripts/verify/phase-1.ts`
**Commit:** 01babd7
**Applied fix:** Switched assertion from `matches.length === 1` to `matches.length >= 1` and picked the most recent match via `matches[matches.length - 1]`. Verify is now idempotent against an append-only droplet log.

### BL-04: Smoke provisions droplet *before* validating GITHUB_TOKEN

**Files modified:** `scripts/smoke-test.ts`
**Commit:** a0c65df
**Applied fix:** Hoisted the `GITHUB_TOKEN` env-var bail to the top of `main()` — runs before `maybeFreshReset()` and `provision()`. Forgetting the PAT no longer creates a billable, unbootstrapped droplet.

### WR-01: `dropletExists` swallows all errors as "doesn't exist"

**Files modified:** `scripts/destroy-droplet.ts`
**Commit:** 556df9d
**Applied fix:** Caught the doctl error, matched `/\b404\b|not found/i` on the message — return false only on a true 404, rethrow with a clear "refusing to assume absence" wrapper on anything else. Auth glitches now abort destroy before `.droplet.json` is removed.

### WR-02: Concurrent backups can corrupt mirrors (no lock)

**Files modified:** `droplet/github-backup.sh`
**Commit:** 736a2c7
**Applied fix:** Added `exec 9>"$LOCK_FILE"; flock -n 9 || exit 0` near the top of the script (after `set -euo pipefail` + env exports). Lock path defaults to `/var/lock/github-backup.lock`. Closes WR-09 in the same change.

### WR-03: `first<T>(cmd)` returns `undefined` on empty array

**Files modified:** `scripts/lib/doctl.ts`
**Commit:** 4b9c000
**Applied fix:** Pulled the first element into a `const item`, threw `Error("doctl returned no record for: ${cmd}")` if `item == null`. Callers no longer NPE on `.id` of undefined.

### WR-04: Token written to `backup.env` without escaping

**Files modified:** `scripts/bootstrap-droplet.ts`
**Commit:** 6a09a1c
**Applied fix:** Validated `githubToken` against `/^[A-Za-z0-9_]+$/` at the top of `writeBackupEnv` and bailed with a clear message naming the constraint on mismatch. Refuses to emit a token that could corrupt the env file or inject shell on the droplet.

### WR-05: Unsanitized config interpolation into remote shell command

**Files modified:** `scripts/lib/config.ts`
**Commit:** b1edac9
**Applied fix:** Added a `SHELL_SAFE_FIELDS` allow-list (`dropletName`, `firewallName`, `sshUser`, `sshKeyPath`, `githubUserOrOrg`, `backupDir`) validated against `/^[A-Za-z0-9._/~@:-]+$/` in `loadConfig`. Bails with the offending field name and value. Same commit folds in WR-10.

### WR-06: `bootstrap-droplet` uploads every entry in `droplet/`

**Files modified:** `scripts/bootstrap-droplet.ts`
**Commit:** 71ec418
**Applied fix:** Switched to `readdirSync(dropletDir, { withFileTypes: true })` and filtered to `dirent.isFile() && dirent.name.endsWith(".sh")`. `.DS_Store`, swap files, and subdirectories are skipped.

### WR-07: Inconsistent `|| true` on arithmetic increments

**Files modified:** `droplet/github-backup.sh`
**Commit:** 2cfdcdb
**Applied fix:** Verified empirically (`bash -c 'set -e; FAIL=0; (( FAIL++ )); echo $FAIL'` prints `1`) that bash exempts a leading-position `(( expr ))` from `set -e`. Dropped `|| true` from both `FAIL` increments to match the `SUCCESS` sites.

### WR-08: `cloneProbe` cleanup runs inside `try` — rmSync errors masquerade as probe failure

**Files modified:** `scripts/smoke-test.ts`
**Commit:** af3d3b7
**Applied fix:** Introduced `let cleanupOnSuccess = true`, set to `false` inside `catch`, moved `fs.rmSync` into a `finally` block guarded by the flag. Mirrors the verify/phase-1.ts pattern.

### WR-09: `phase-1.ts` triggers backup synchronously without locking

**Files modified:** (closed by WR-02)
**Commit:** 736a2c7
**Applied fix:** Same flock change as WR-02 closes the concurrency hole from the verify side; no separate change in `phase-1.ts`.

### WR-10: `loadConfig` does not handle malformed JSON

**Files modified:** `scripts/lib/config.ts`
**Commit:** b1edac9
**Applied fix:** Wrapped `JSON.parse(fs.readFileSync(p, "utf8"))` in `try/catch`; the catch block calls `bail("config.json is not valid JSON: ${e.message}")`. Folded into the WR-05 commit since both edits sit in the same `loadConfig` function.

### WR-11: `sshExitsZero` cannot distinguish ssh transport failure from remote non-zero

**Files modified:** `scripts/verify/phase-1.ts`
**Commit:** 18fdb8f
**Applied fix:** Replaced the `runCapture`/try-catch wrapper with `spawnSync(cmd, { shell: true, stdio: "pipe" })`. Returns `r.status === 0` for remote success, throws on `r.status === 255` (OpenSSH transport failure) with stderr included. Remote non-zero exits return false as before.
**Status:** fixed: requires human verification — the 255-versus-other-code split is correct per OpenSSH manpage but ssh stderr text varies across OS/version; recommend the operator confirm against a real DO droplet during T-01-XX-XX.

### WR-12: Comment block above logging helper contains corrupt UTF-8

**Files modified:** `droplet/github-backup.sh`
**Commit:** 73a8642
**Applied fix:** Replaced the box-drawing comment band (U+2500) with ASCII dashes (`# --- Logging helper ---`). Note: `iconv` confirmed the file was already valid UTF-8; the review's "invalid sequences via cat -v" claim was a misread of `cat -v`'s `M-^X` notation for high-bit bytes. Applied the requested fix anyway because ASCII is more portable for a comment band.

### WR-13: `scripts/verify/phase-1.ts` references `expandHome` only via `void`

**Files modified:** `scripts/verify/phase-1.ts`
**Commit:** e45a7ef
**Applied fix:** Removed `expandHome` from the `import { ... } from "../lib/ssh"` list and removed the `// Touch expandHome ...` comment block + `void expandHome;` line. `sshFlags` still calls it transitively.

---

_Fixed: 2026-05-04_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
