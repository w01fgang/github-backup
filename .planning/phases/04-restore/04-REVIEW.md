---
status: fixed-inline
phase: 04-restore
depth: standard
files_reviewed: 6
findings:
  critical: 0
  warning: 1
  info: 2
  total: 3
created: 2026-05-13
---

# Code Review — Phase 04 (Restore)

Scope: 6 files changed in phase 4 (commits f2d5cdd^..HEAD):
- `scripts/restore.ts` (created)
- `scripts/verify/phase-4.ts` (created)
- `scripts/lib/config.ts` (modified: +restoreTestRepo field + slug validation)
- `package.json` (modified: +restore + verify:phase-4 scripts)
- `config.example.json` (modified: +restoreTestRepo placeholder)
- `README.md` (modified: §Recovery rewrite)

## Findings

### WR-1 — rawTarget shell injection via command substitution [FIXED inline]

**File:** `scripts/restore.ts` (pre-fix line 60)
**Severity:** Warning (Phase-4-introduced, exploitable but operator-supplied input)

`rawTarget` from argv was passed to `path.resolve()` and then interpolated into:

```ts
const workingCmd = `git clone "${localMirrorPath}" "${workingClonePath}"`;
runVisible(workingCmd);  // execSync(cmd, { stdio: "inherit" })
```

Double quotes around `${workingClonePath}` prevent word-splitting but NOT command substitution. A malicious operator-controlled path like `/tmp/foo$(rm -rf /)bar` would execute the substitution before git clone ran.

Mitigated by the fact that the operator controls argv themselves (not a remote attacker surface), but the codebase's posture from `lib/config.ts` (SHELL_SAFE_FIELDS, CRON_SAFE_RE, RESTORE_TEST_REPO_RE) is "validate every interpolated field" — leaving rawTarget unvalidated was inconsistent with that posture.

**Fix:** Commit 4223c92. Added `TARGET_PATH_SAFE_RE = /^[A-Za-z0-9._/~@:+,= -]+$/` validation gate before `path.resolve()`. Fires before `loadConfig` so the bail is the first thing the operator sees. Smoke-tested with `$(echo PWNED)` payload — bails as expected.

### INFO-1 — info.ip not in SHELL_SAFE_FIELDS [pre-existing, NOT introduced by Phase 4]

**File:** `scripts/restore.ts` line 85, `scripts/verify/phase-4.ts` line 147

`info.ip` from `.droplet.json` is interpolated into ssh/git command lines but is not validated by `loadDropletInfo()`. Phase 1 verify also has this pattern (`phase-1.ts:217`). Risk: very low (operator writes `.droplet.json` themselves via `create-droplet`; not network-derived).

Not fixed in Phase 4 — out of scope per CLAUDE.md Rule 3 (surgical changes). Suggested follow-up: add an IP validation regex to `loadDropletInfo()` so every interpolated field has the same posture. Tracked as a follow-up rather than blocker.

### INFO-2 — assert(true, ...) used as conditional print [style, idiomatic]

**File:** `scripts/verify/phase-4.ts` line 188

```ts
assert(
  true,
  `sorted for-each-ref output byte-equal between droplet mirror and ` +
    `local bare mirror (${remoteSet.size} refs)`
);
```

After the explicit `if (remoteOnly.length > 0 || ...) { ...; process.exit(1); }` block above, the assertion is unreachable in the failure path; it exists only to print the green "✓" line on success. Idiomatic for this codebase (`phase-1.ts` uses the same shape in matched-case branches). Acceptable.

## Conclusion

1 Warning (rawTarget shell injection) was fixed inline. 2 Info findings noted, no action required.

Status: `fixed-inline` (clean after fix commit 4223c92).
