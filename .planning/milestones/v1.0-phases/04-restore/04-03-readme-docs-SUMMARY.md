---
phase: 04-restore
plan: 03
status: complete
created: 2026-05-13
---

# Summary — Plan 04-03: README Docs

## What was built

Replaced README §Recovery (lines 263–278, the inline `git clone --mirror` 3-step recipe) with a two-scenario structure per D-07:

- **§Scenario 1: Single-repo recovery (everyday case)** — points at `npm run restore -- <owner>/<repo> <target>` from plan 04-01. Documents what the helper does, what `origin` ends up pointing at, and how to re-point to github.com.
- **§Scenario 2: GitHub is gone / account compromised** — manual disaster-recovery flow with explicit `git push --mirror https://github.com/new-owner/myrepo.git` to a fresh empty repo. Names `$TMPDIR/github-backup-restore-XXXX/<owner>_<repo>.git` as the source mirror path (matches helper's tempdir naming from plan 04-01).
- **§Verifying restore correctness** — new subsection pointing at `npm run verify:phase-4` + `config.restoreTestRepo`.

Cross-link added to §"Clone a mirrored repo for local development":

> For full disaster recovery (or to produce a portable bare mirror that survives droplet teardown), use the helper described in [Recovery → Scenario 1](#scenario-1-single-repo-recovery-everyday-case) instead.

Reverse cross-link in §Verifying restore correctness points back to §Clone-a-mirrored-repo for the lighter-weight offline-work case.

## Preserved

- `#recovery` anchor (the `## Recovery` heading text is unchanged).
- §"Update the cron schedule without re-running full bootstrap" subsection — was previously inside §Recovery and is operationally adjacent enough to keep there rather than move it to §Operation (smaller diff, headings stable).
- §"Clone a mirrored repo for local development" + §"Clone a bare mirror (re-mirror to another machine)" subsections in §Operation — untouched except for the one-line cross-link note added at the top of the former.

## Verification (plan §verification)

| Check | Result |
|---|---|
| 1. `grep -c "^## Recovery$"` returns 1 | PASS |
| 2. `grep -c "npm run restore"` returns ≥2 | PASS (Scenario 1 + Scenario 2) |
| 3. `grep -c "git push --mirror"` returns 1 | PASS (Scenario 2) |
| 4. `grep -c "^### Scenario [12]"` returns 2 | PASS |
| 5. `grep -c "verify:phase-4"` returns 1 | PASS |
| 6. `grep -c "Clone a mirrored repo for local development"` returns 2 | PASS (heading + cross-link target) |
| 7. `#recovery` anchor preserved | PASS (heading text "## Recovery" unchanged) |
| 8. Manual visual: scenarios read in order, fences balance | PASS |

## Key files modified

- `README.md` (+66 / −6 lines)

## Deviations

1. **Kept §"Update cron schedule" subsection inside §Recovery** rather than moving it to §Operation. Plan's "replace entire §Recovery" instruction would have killed this unrelated subsection. Decision: smaller diff + headings stable wins; the subsection is operationally adjacent to recovery enough to live there.
2. **Scenario 2 step 3 uses `$TMPDIR/github-backup-restore-XXXX/myorg_myrepo.git`** instead of `~/myrepo.git`. The helper writes to OS tempdir (matches plan 04-01 task 2 step 5 — `fs.mkdtempSync(path.join(os.tmpdir(), "github-backup-restore-"))`). Using `~/myrepo.git` would have been wrong; the plan body had it as a minor inconsistency.

## Self-Check: PASSED

1 atomic commit, all 8 verification checks pass, cross-links resolve (anchor case-folded by GitHub's renderer; tested locally via grep), no orphaned headings, fence balance verified.
