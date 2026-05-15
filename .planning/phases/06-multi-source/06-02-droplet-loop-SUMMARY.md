---
phase: 06-multi-source
plan: 02
status: complete
completed: 2026-05-15
commits:
  - 7715013 feat(06-02): droplet/lib/detect-account-type.sh helper (D-05)
  - c32867b feat(06-02): droplet/lib/filter-repos.sh allow/deny glob filter (REPOS-01)
  - c5af787 feat(06-02): multi-source outer loop in github-backup.sh + namespaced layout
  - 180592a feat(06-02): bootstrap.sh per-source mkdir + lib/ chmod
key_files:
  created:
    - droplet/lib/detect-account-type.sh
    - droplet/lib/filter-repos.sh
  modified:
    - droplet/github-backup.sh
    - droplet/sync-one-repo.sh
    - droplet/bootstrap.sh
---

# Plan 06-02 Summary

## What was built

Droplet-side bash machinery for Phase 6 multi-source + per-repo filtering. 4 commits.

### 1. `droplet/lib/detect-account-type.sh` (D-05)

Extracted user-vs-org `gh api` probe into sourceable helper.
`detect_account_type <slug>` → `User` | `Organization` (defaults to `User` on error).
Resolves Phase 1 plan-checker MED #4 (probe duplicated between github-backup.sh and former smoke-test.ts step 8 — smoke-test usage will follow in plan 03).

### 2. `droplet/lib/filter-repos.sh` (REPOS-01)

`filter_repos <source> <allow_csv> <deny_csv>` reads stdin (full_names), writes stdout (passing full_names).
- ROADMAP SC#4: deny wins on conflict.
- ROADMAP SC#5: empty allow ⇒ all pass.
- Bare pattern (no slash) matches basename; `owner/name` pattern matches full_name.
- Bash `[[ ]]` glob (no extglob), portable across bash 4/5.

All 5 PLAN.md acceptance cases pass. Transcript:

```
[1] all pass (empty allow + empty deny):    sumin/a, sumin/b
[2] deny wins:                               sumin/a (b-archive dropped)
[3] allow restricts (bare pattern):          acme/foo-1 (bar dropped)
[4] owner/name pattern:                      acme/foo-1
[5] conflict — deny wins:                    acme/foo-1 (foo-archive dropped)
```

### 3. `droplet/github-backup.sh` (rewrite — multi-source outer loop)

Lines 1–95 (shebang, env, lockfile, env-file load, log() helper) preserved BYTE-FOR-BYTE per plan instruction.

After log(): source helpers, define `slot()` (matching `envSlot()` from plan 01), then:

- **D-04 fallback** for un-upgraded droplet window (legacy `GITHUB_USER_OR_ORG` synthesised into `GITHUB_SOURCES`).
- **D-08 legacy migration:** top-level `*.git` mirrors auto-relocated under `<legacy-source>/` iff exactly 1 source AND it equals `GITHUB_USER_OR_ORG`. Multi-source upgrade case bails with pointer to `npm run migrate-mirrors`.
- **Outer source loop:** for each source: detect type via helper, fetch via `gh api --paginate`, filter via `filter_repos`, then loop over filtered repos and invoke `${BACKUP_DIR}/sync-one-repo.sh "${SOURCE}" "${OWNER}" "${NAME}"` (Phase 3 D-15 contract preserved).
- **Soft per-source failure:** gh-api error counts one source-level failure and continues to next source instead of killing the whole run.
- **Per-source SUMMARY (D-16):** `BACKUP_SOURCE_SUMMARY source=<n> upstream=K mirrored=M failed=F`.
- **Aggregate SUMMARY:** `BACKUP_SUMMARY upstream=N mirrored=M failed=F` shape preserved EXACTLY (Phase 1 + Phase 2 parsers untouched). Numbers are post-filter (KEPT counts).
- **last-run.json schema preserved** (started_at, finished_at, exit_code, total, success, fail, repos[]). Each `repos[]` entry now also carries `source` field (additive — Phase 2 reader is permissive).
- **Phase 1 NR-06 global flock** on fd 9 untouched — wraps the entire multi-source run as ONE locked unit (D-19).

### 4. `droplet/sync-one-repo.sh` (additive update)

`MIRROR_PATH` namespaced from `${BACKUP_DIR}/${OWNER}_${REPO}.git` to `${BACKUP_DIR}/${SOURCE}/${OWNER}_${REPO}.git` (D-07). Per-repo lock unchanged. Existing `<source>` arg now actually used in the path. Idempotent `mkdir -p ${BACKUP_DIR}/${SOURCE}` added defensively (the per-source dir already exists post-bootstrap, but a fresh source seen first via webhook benefits).

### 5. `droplet/bootstrap.sh` (two additive edits)

- After `chmod 600` on backup.env: parse `GITHUB_SOURCES` (or fall back to `GITHUB_USER_OR_ORG`) → `mkdir -p ${BACKUP_DIR}/<source>/` per source.
- After existing `chmod +x` for top-level scripts: also `chmod +x ${BACKUP_DIR}/lib/*.sh` when the dir exists.
Both idempotent.

## Deviations from plan

1. **`droplet/sync-one-repo.sh` updated.** Not in plan 06-02's `files_modified`. The plan's truth #4 demands namespaced layout `${BACKUP_DIR}/<source>/<owner>_<repo>.git` (D-07), and sync-one-repo.sh is the sole writer of `MIRROR_PATH`. Updating it is the only correct way to satisfy D-07 — the plan implicitly required this without listing the file. Minimal change: 1 line in path constant + 1 defensive mkdir.

2. **Plan-stated line numbers wrong.** PLAN.md task 3 said "Replace lines 89–142" and "Replace lines 145–195" with inline `git clone --mirror` / `git -C ... remote update` calls. Real github-backup.sh delegates per-repo work to `sync-one-repo.sh` (Phase 3 D-15 contract). Inlining the clone/update would have REGRESSED Phase 3's extraction. Preserved the helper invocation; only added the outer source loop + filter step around it.

3. **last-run.json contract preserved (plan didn't mention it).** Phase 2 wrote the atomic last-run.json writer (lines 209–232 of original github-backup.sh) and locked the schema. Plan 06-02 task 3's "replace lines 145–195" would have deleted it. Preserved + extended: `repos[]` entries now carry an additional `source` field (additive, schema-locked fields untouched).

4. **`webhook-listener.js` NOT touched in this plan.** Orchestrator note said webhook listener "needs to source `droplet/lib/filter-repos.sh` and apply REPOS-01 filter so deny rules don't bypass via webhook. Captured in plan 06-03 group 6." Plan 06-03 group 6 is informational — explicitly defers enforcement to **Phase 3's verify**. Multi-source webhook routing (current listener uses single `ALLOWED_SOURCE`) is also out of Phase 6 plan scope. Both are tracked under Pending in STATE.md as Phase 3.x follow-ups (see SUMMARY of Plan 03 for full discussion).

## Verification

| Check | Result |
|-------|--------|
| `bash -n` on all 4 modified/created files | PASS |
| `filter_repos` 5 acceptance cases (PLAN task 2) | PASS (transcript above) |
| `detect_account_type` defines as function when sourced | PASS |
| Phase 1 `BACKUP_SUMMARY upstream=…` regex shape preserved | PASS (verified by reading the new code) |
| `last-run.json` schema-locked fields untouched | PASS (additive `source` only) |
| `sync-one-repo.sh` invocation arg order | PASS (`SOURCE`, `OWNER`, `NAME` matches helper signature) |

`shellcheck` not installed locally — `bash -n` covers syntax. Live droplet end-to-end is plan 03's `verify:phase-6` job.

## Cross-plan contracts honoured

- `cfg.sources[i].name` in TS (plan 01) ↔ `${SOURCES[i]}` array element in bash (this plan). Both come from the same `GITHUB_SOURCES` env line.
- `envSlot(name)` TS ↔ `slot "$name"` bash. Both produce identical strings — plan 03 group 5 will assert this end-to-end.
- `backup.env` shape consumed exactly as plan 01 emits.
- `${BACKUP_DIR}/lib/*.sh` upload path established by plan 01 task 2 — this plan creates the two `.sh` files that get uploaded.
- Phase 1 `BACKUP_SUMMARY` shape preserved (parser regex `BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)` matches unchanged).
- Phase 2 `last-run.json` schema preserved (existing fields untouched; `source` added per repo as a permissive extension).
- Phase 3 `sync-one-repo.sh` per-repo extraction preserved — same script invoked from both cron path (this plan's outer loop) and webhook path (`webhook-listener.js`).

## Next phase readiness

Plan 06-03 (verify + helpers) can now consume:
- `BACKUP_SOURCE_SUMMARY` log line for group 3 assertions.
- `${BACKUP_DIR}/<source>/` namespaced layout for group 2 assertions.
- `slot()` bash function for group 5 cross-language slot agreement test.
- `filter-repos.sh` helper (sourceable from verify-side smoke or unit tests).

## Self-Check: PASSED

- All 4 tasks committed individually.
- `bash -n` clean on all modified/created files.
- All 5 PLAN.md task 2 acceptance cases pass.
- `last-run.json` writer + schema preserved (Phase 2 contract intact).
- `sync-one-repo.sh` invocation preserved (Phase 3 D-15 contract intact).
- Phase 1 NR-06 global flock on fd 9 untouched.
- `BACKUP_SUMMARY` aggregate line shape unchanged (parser-stable).
- key_files (4 modified, 2 created) all exist on disk.
- `git log --grep="^feat(06-02)"` returns 4 commits as expected.
