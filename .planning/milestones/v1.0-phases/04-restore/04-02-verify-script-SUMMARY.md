---
phase: 04-restore
plan: 02
status: complete
created: 2026-05-13
---

# Summary — Plan 04-02: Verify Script

## What was built

- `scripts/verify/phase-4.ts` (new, 228 lines): per-phase verification for ROADMAP Phase 4 (Restore). Fail-fast assert-style, mirrors phase-1.ts conventions. Asserts:
  - **Group 0**: `cfg.restoreTestRepo` is set and matches `<owner>/<repo>` slug shape (D-01). Bails loud with hint if unset.
  - **Group 1**: `npm run restore -- <slug> <tmp>` exits 0 (RESTORE-01). Parses inter-plan handshake `RESTORE_LOCAL_MIRROR=<path>` from helper stdout to locate the intermediate bare mirror.
  - **Group 2**: sorted `git for-each-ref --format="%(objectname) %(refname)"` of droplet bare mirror vs local bare mirror is byte-equal (D-02). Failure prints counts + first 3 diffs.
  - **Group 3**: belt-and-braces — restored bare mirror has at least one `refs/heads/*`. If no `refs/tags/*`, prints a yellow warning (NOT a failure) and asks the operator to pick a tagged restoreTestRepo for full RESTORE-02 coverage.
- `package.json`: added `"verify:phase-4": "tsx scripts/verify/phase-4.ts"`.

## Design choices honored

| Decision | Choice |
|---|---|
| D-02 (ref-equivalence) | `for-each-ref` (not `ls-remote`) — both sides are bare mirrors, same namespace, sorted byte-equality is sufficient |
| D-02 (comparison baseline) | Droplet bare mirror vs **intermediate local bare mirror**, NOT vs working clone (namespace shift would always diff). Working clone is just the live RESTORE-01 artifact. |
| D-03 (push-back) | No self-push assertion. for-each-ref equality + git's content-addressable model already proves byte-equivalent objects. |
| D-04 (helper-as-child-process) | spawn `npm run restore --` — exercises the same code path the operator uses (npm wrapper, argv parsing, env). |
| D-06 (failure leaves temp) | On any failure, leaves both `restoreRoot` and the helper's intermediate bare mirror tempdir on disk, prints both paths. On success, removes both. |

## Inter-plan contract (consumed from 04-01)

Helper's first stdout line: `RESTORE_LOCAL_MIRROR=<abs-path>` — parsed via `/^RESTORE_LOCAL_MIRROR=(.+)$/m`. Confirmed present in committed `scripts/restore.ts` (commit a8f6393). No patch needed to 04-01 — contract landed in lock-step.

## Verification (plan §verification)

| Check | Result |
|---|---|
| 1. `npx tsc --noEmit` exit 0 | PASS |
| 2. `npm run verify:phase-4` with no config.json → exit 1, loadConfig bail | PASS (deferred: with config.json + unset restoreTestRepo → Group 0 bail. Code-path verified: Group 0 is the first step after loadConfig.) |
| 3. Live-droplet pass with real restoreTestRepo | DEFERRED to operator smoke (needs live droplet + populated config.json) |
| 4. Force ref mismatch | DEFERRED to operator smoke |
| 5. Force clone failure leaves temp dir | DEFERRED to operator smoke (assertion path verified by code inspection: `r.status !== 0` block prints `restoreRoot` and exits 1 before any cleanup) |
| 6. Live-droplet verify closes Phase 4 lock | DEFERRED — gate is RESTORE-02 itself, fired by operator |

Live-droplet checks (3–6) are the ROADMAP Phase 4 success-criteria gate. Local checks 1–2 cover what is testable without infrastructure.

## Key files created / modified

- `scripts/verify/phase-4.ts` (created, 228 lines)
- `package.json` (modified: +1 npm script)

## Deviations

- Used `git for-each-ref --format="%(objectname) %(refname)"` instead of `git ls-remote` (plan body mentioned both). Both produce equivalent sorted-line output for the bare-vs-bare comparison; `for-each-ref` avoids an extra subprocess round-trip and works without a network on the local side. The droplet side uses for-each-ref too (over ssh) for symmetry.
- Plan body referenced a possible mid-execution patch to 04-01 if the handshake line wasn't already there. It was — committed at a8f6393. No patch needed.
- Cleanup on success removes both the verify tempdir AND the helper's intermediate bare mirror tempdir. Plan was silent on the helper's tempdir; leaving it would accumulate `/tmp/github-backup-restore-*` directories across verify runs. Cleanup is gated on path-shape check (`os.tmpdir()` prefix + `github-backup-restore-` basename) so we cannot accidentally `rm -rf` outside `/tmp`.

## Self-Check: PASSED

2 atomic commits, typecheck clean, smoke-tested where possible without live droplet. Handshake regex matches helper's stdout format. Failure paths leave artifacts on disk per D-06.
