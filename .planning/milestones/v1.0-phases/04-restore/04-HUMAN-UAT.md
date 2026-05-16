---
status: partial
phase: 04-restore
source: [04-VERIFICATION.md]
started: 2026-05-13
updated: 2026-05-13
---

## Current Test

[awaiting human testing]

## Tests

### 1. Live-droplet single-repo restore smoke
expected: Operator runs `npm run restore -- <real-owner>/<real-repo> /tmp/restore-smoke` against the live droplet. Exits 0, prints `RESTORE_LOCAL_MIRROR=<abs-path>` as the first stdout line, leaves working clone at `/tmp/restore-smoke` and intermediate bare mirror in `$TMPDIR/github-backup-restore-XXXX/`.
result: [pending]

### 2. Restored clone refs inspection
expected: `git -C /tmp/restore-smoke branch -a && git -C /tmp/restore-smoke tag` shows all branches + tags that the droplet mirror has.
result: [pending]

### 3. verify:phase-4 happy path
expected: With `restoreTestRepo` set in config.json to a small tagged repo, `npm run verify:phase-4` exits 0, prints `✅ verify:phase-4 PASS`, cleans up both `$TMPDIR/github-backup-verify-phase-4-*` and the helper's intermediate `$TMPDIR/github-backup-restore-*` tempdir, all Group 0–3 assertions print `✓`.
result: [pending]

### 4. verify:phase-4 ref-mismatch path
expected: Force a ref mismatch (set `restoreTestRepo` to a repo whose droplet mirror was manually deleted, OR add a stray ref on the droplet mirror via `ssh root@DROPLET 'git -C /opt/github-backups/<owner>_<repo>.git update-ref refs/heads/__test__ HEAD'`). Run `npm run verify:phase-4` — exits 1 with `✗ ref mismatch between droplet mirror and restored bare mirror` message naming counts + first 3 diffs; both temp dirs left on disk with their paths printed.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
