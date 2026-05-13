---
phase: 04-restore
plan: 01
status: complete
created: 2026-05-13
---

# Summary — Plan 04-01: Restore Helper

## What was built

- `scripts/lib/config.ts`: added optional `restoreTestRepo?: string` field to `Config` interface + `RESTORE_TEST_REPO_RE` slug validation in `loadConfig` (defence in depth — the helper re-validates, but a malformed value should never reach the shell-interpolated `git clone`).
- `scripts/restore.ts` (new, 112 lines): operator-facing helper. Two-step flow:
  1. `git clone --mirror` from `${cfg.sshUser}@${info.ip}:${cfg.backupDir}/${owner}_${repo}.git` into an OS tempdir bare mirror.
  2. `git clone <local-mirror>` into the operator-specified target dir.
  
  GIT_SSH_COMMAND wraps `sshFlags(cfg.sshKeyPath)` — same SSH posture as `scripts/verify/phase-1.ts`. Working clone origin points at the local bare mirror (not github.com, not the droplet) per D-domain (one-way data flow).
- `config.example.json`: added `restoreTestRepo` placeholder + extended `_readme` to note it is optional.
- `package.json`: added `"restore": "tsx scripts/restore.ts"` after `verify:phase-1`.

## Inter-plan contract (consumed by 04-02)

Helper's FIRST stdout line on success is the machine-readable handshake:

```
RESTORE_LOCAL_MIRROR=<abs-path-of-intermediate-bare-mirror>
```

verify:phase-4 parses this via `^RESTORE_LOCAL_MIRROR=(.+)$` to locate the intermediate bare mirror for ref-equivalence diff (D-02 bare-to-bare comparison).

## Key files created / modified

- `scripts/restore.ts` (created, 112 lines)
- `scripts/lib/config.ts` (modified: +1 interface field, +1 regex, +14 validation)
- `config.example.json` (modified: +1 field, extended _readme)
- `package.json` (modified: +1 npm script)

## Verification (plan §verification checks 1, 2, 4, 5, 6)

| Check | Result |
|---|---|
| 1. `npx tsc --noEmit` exit 0 | PASS |
| 2. `npm run restore` (no args) → exit 1 + usage bail | PASS |
| 3. `npm run restore -- foo/bar /tmp/existing` (deferred — needs live config.json on operator machine) | DEFERRED |
| 4. `npm run restore -- not-a-slug /tmp/x` → exit 1 + slug regex bail | PASS |
| 5. `cat package.json` → `.scripts.restore == "tsx scripts/restore.ts"` | PASS |
| 6. `grep restoreTestRepo scripts/lib/config.ts` shows the field | PASS |

Check 3 is the "target already exists" path — not testable in CI without a real `config.json`. The slug-validation bail (check 4) fires before `loadConfig`, which is the order the plan specified. Verified by code inspection: the `fs.existsSync(workingClonePath)` check sits after `loadConfig()` + `loadDropletInfo()` and before path derivation, with a named bail message.

Check 7 (live-droplet end-to-end) is plan 04-02's `verify:phase-4` lock.

## Deviations

None. All three tasks landed as planned, single commit each. The plan's expected `expandHome` import is kept for parity with sibling scripts even though `sshFlags` does the actual expansion — `void expandHome` line marks the unused-import intent so a future grep does not delete it.

## Self-Check: PASSED

3 atomic commits (one per task), each typechecks, smoke tests pass for all argv-validation paths reachable without a live droplet. Inter-plan contract printed on the correct line, regex anchor matches the form 04-02 will use.
