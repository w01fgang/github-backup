---
status: human_needed
phase: 04-restore
verified: 2026-05-13
goal: "Operator can recover any single repo back to a working clone with all branches/tags intact"
requirements:
  - id: RESTORE-01
    status: code-shipped-pending-live-smoke
  - id: RESTORE-02
    status: code-shipped-pending-live-smoke
plans:
  - id: 04-01-restore-helper
    status: complete
  - id: 04-02-verify-script
    status: complete
  - id: 04-03-readme-docs
    status: complete
automated_checks: passed
human_verification:
  - description: "Run `npm run restore -- <real-owner>/<real-repo> /tmp/restore-smoke` against the live droplet"
    expected: "Exits 0, prints 'RESTORE_LOCAL_MIRROR=<abs-path>' as first stdout line, working clone at /tmp/restore-smoke, intermediate bare mirror in $TMPDIR/github-backup-restore-XXXX/"
  - description: "Inspect working clone: `git -C /tmp/restore-smoke branch -a && git -C /tmp/restore-smoke tag`"
    expected: "All branches + tags from droplet mirror present"
  - description: "Set `restoreTestRepo` in config.json to a small tagged repo, run `npm run verify:phase-4`"
    expected: "Exits 0, prints '✅ verify:phase-4 PASS', cleans up temp dirs, all Group 0–3 assertions green"
  - description: "Force a ref mismatch (e.g., set `restoreTestRepo` to a repo whose droplet mirror was manually deleted), run `npm run verify:phase-4`"
    expected: "Exits 1 with 'ref mismatch' message naming counts + first 3 diffs; leaves temp dirs on disk and prints their paths"
---

# Phase 04 (Restore) — Verification

## Phase Goal

> Operator can recover any single repo back to a working clone with all branches/tags intact.

## Requirements traceability

| Requirement | Plan(s) | Local check | Live-droplet check |
|---|---|---|---|
| RESTORE-01 (workflow documented + tested) | 04-01 (helper) + 04-03 (README) | PASS (npm run restore wired, README §Recovery rewritten with two scenarios, argv validation fires correctly) | PENDING (smoke against real droplet + populated config.json) |
| RESTORE-02 (refs preserved) | 04-01 (helper uses `git clone --mirror`) + 04-02 (verify:phase-4 asserts bare-to-bare ref byte-equality) | PASS (typecheck clean, verify script logic sound, handshake regex matches helper output) | PENDING (live-droplet `npm run verify:phase-4` against a configured `restoreTestRepo`) |

## ROADMAP Success Criteria

| SC | Status | Notes |
|---|---|---|
| 1. README has Restore section with copy-pasteable commands | PASS | §Recovery rewritten; `npm run restore -- myorg/myrepo ~/myrepo-recovered` in Scenario 1; `git push --mirror` flow in Scenario 2; `verify:phase-4` documented |
| 2. Restore test: clone-back, push locally, compare ref counts | PENDING (live-droplet) | Per D-03 (CONTEXT decision), self-push assertion was DROPPED — `for-each-ref` sorted byte-equality already proves byte-equivalent refs; self-push adds zero signal. SC#2's "push a new commit locally" interpreted per D-03 as "drop redundant assertion". Documented in verify:phase-4 header. |
| 3. Restored repo has identical branches + tags as mirror | PENDING (live-droplet) | Asserted by `verify:phase-4` Group 2 (bare-to-bare sorted `for-each-ref` diff) + Group 3 (≥1 refs/heads + warning if no refs/tags). Live-droplet run is the gate. |

## Automated checks (this verification run)

| Check | Result |
|---|---|
| `npx tsc --noEmit` exit 0 | PASS |
| `npm run restore` (no args) → exit 1 + usage bail | PASS |
| `npm run restore -- not-a-slug /tmp/x` → exit 1 + slug regex bail | PASS |
| `npm run restore -- foo/bar '/tmp/foo$(echo PWNED)bar'` → exit 1 + shell-injection bail | PASS (added by code-review fix commit 4223c92) |
| `npm run verify:phase-4` with no config.json → exit 1 + loadConfig bail | PASS |
| All 6 grep checks against README.md | PASS |
| Code review (standard depth, 6 files) → 0 critical, 1 warning fixed inline, 2 info notes | PASS (status: fixed-inline) |
| Phase 4 commits land on master, no STATE.md/ROADMAP.md conflicts | PASS |

## Code review summary

See `.planning/phases/04-restore/04-REVIEW.md`. 1 warning (rawTarget shell injection) was Phase-4-introduced; fixed inline. 2 info findings noted (info.ip pre-existing pattern, idiomatic `assert(true, ...)`). Status: `fixed-inline`.

## Plans

All 3 plans `status: complete`, SUMMARY.md present for each:

- [04-01-restore-helper-SUMMARY.md](./04-01-restore-helper-SUMMARY.md) — helper + config plumbing
- [04-02-verify-script-SUMMARY.md](./04-02-verify-script-SUMMARY.md) — verify:phase-4 ref-equivalence lock
- [04-03-readme-docs-SUMMARY.md](./04-03-readme-docs-SUMMARY.md) — README §Recovery two-scenario rewrite

## Conclusion

Status: **human_needed**. All code, docs, and gates green locally. Live-droplet smoke (4 checks listed in frontmatter `human_verification`) is the operator action that closes RESTORE-01 + RESTORE-02. Phase 4 is mostly docs + verification per the ROADMAP note; the work that COULD be automated has been; the remainder is gated on infrastructure the operator owns.
