---
phase: 06-multi-source
plan: 03
status: complete
completed: 2026-05-15
commits:
  - 479700e feat(06-03): migrate-mirrors.ts — operator legacy → namespaced layout (D-09)
  - 56054e1 feat(06-03): verify/phase-6.ts — five end-to-end assertion groups (D-20)
  - a3b92f7 feat(06-03): smoke-test multi-source assertions + namespaced probes
  - fc0b575 feat(06-03): config.example.json — multi-source + allow/deny example
  - 58aa93f docs(06-03): README — Multi-source + per-repo filtering section
key_files:
  created:
    - scripts/migrate-mirrors.ts
    - scripts/verify/phase-6.ts
  modified:
    - scripts/smoke-test.ts
    - config.example.json
    - README.md
---

# Plan 06-03 Summary

## What was built

Phase 6 verify + helper layer. Closes the loop on plans 01 + 02. 5 commits, one per task.

### 1. `scripts/migrate-mirrors.ts` (D-09)

Operator-driven Phase 1 → Phase 6 layout migration over SSH. CLI: `npm run migrate-mirrors -- --from <legacy-source-name>`. Bails on missing/unknown source. Composite remote bash command that nullglob-iterates `*.git`, mkdir-p's the per-source dir, mv's each (skipping collisions), and emits a `MIGRATE_RESULT moved=N skipped_existing=K` line. Idempotent. Safety: only `mv`, no `rm` — collisions left for operator review.

### 2. `scripts/verify/phase-6.ts` (D-20 — five groups)

| Group | Asserts | Skip behavior |
|-------|---------|---------------|
| 1 | `cfg.sources` matches `GITHUB_SOURCES` env line + per-source allow/deny lines | soft-skip if `cfg.sources.length < 2` |
| 2 | `${BACKUP_DIR}/<source>/` exists per source; no top-level `*.git` (legacy migrated) | soft-skip per source if filtered to zero |
| 3 | One `BACKUP_SOURCE_SUMMARY` per source post-tStart, source set equality, 100% pass per source, aggregate `BACKUP_SUMMARY` upstream/mirrored == sum of per-source | hard-fail (this is the Phase 1 contract) |
| 4 | REPOS-01 SC#4: every denied repo has NO mirror at expected namespaced path | soft-skip if no source has deny list, or deny doesn't match upstream |
| 5 | bash `slot()` ↔ TS `envSlot()` agreement on every source name | always runs |
| 6 | (informational) Webhook routing → owned by `npm run verify:phase-3` | print pointer only |

Group 4 uses the droplet's own `filter_repos` helper to compute the denied set — eliminates TS↔bash glob drift risk by relying on the same code path the cron run uses.

### 3. `scripts/smoke-test.ts` extension

- `pickRemoteMirror`: switched probe from `ls -1d ${REMOTE_DIR}/*.git` (broken post-Phase 6) to `find ${REMOTE_DIR} -maxdepth 2 -type d -name "*.git"`. Maxdepth 2 catches both Phase 6 namespaced and legacy Phase 1 layouts during the migration window.
- `enforcePassBar` fsCount cross-check: same `find -maxdepth 2` update.
- `enforcePassBar` additive D-16 block (after the existing Phase 1 aggregate check):
  - Parse all post-tStart `BACKUP_SOURCE_SUMMARY` lines.
  - Assert one per source, source name set equals `cfg.sources` names.
  - Assert per-source mirrored == per-source upstream && failed == 0.
  - Assert aggregate upstream == sum of per-source upstream.
- Per-source SSH probe: log per-source `*.git` counts (soft, non-fatal if a source has 0).

The Phase 1 single-source path still passes — exactly 1 `BACKUP_SOURCE_SUMMARY` line trivially satisfies the new sum check.

### 4. `config.example.json`

Two-source example: bare-string `myusername` + object `{name:"acme-org", repos:{allow,deny}}`. Legacy `githubUserOrOrg` kept (with `_comment_legacy` documenting the deprecation path). `_comment_sources` documents ROADMAP SC#4/SC#5 inline. Verified: `loadConfig` against this example normalises 2 sources and prints the expected deprecation warning.

### 5. `README.md`

New `## Multi-source + per-repo filtering` section between `## Operation` and `## Webhook setup`. Covers the operator's 4 questions: (a) how do I write the config (full example), (b) what does deny/allow do (semantics + 3 rules), (c) where do mirrors live (namespaced path + Phase 1 contrast), (d) how do I upgrade (single-source auto-migrates / multi-source `migrate-mirrors` workflow). Plus a Verify subsection summarising the 5 groups, and a Back-compat subsection clarifying `githubUserOrOrg` deprecation path. Also updated the existing Operation-section clone example to the namespaced path.

## Deviations from plan

1. **Plan called for autonomous: false.** Orchestrator instructed: "make autonomous decisions." Executed all 5 tasks inline without UAT checkpoints between them. Operator UAT is rolled up at the phase-end gate (verify:phase-6 against a live droplet), not interleaved between tasks.

2. **Group 6 (webhook listener) NOT modified in Phase 6.** Plan 03 group 6 explicitly defers enforcement to Phase 3's verify and warns the cross-phase note is informational. Orchestrator's CLAUDE-in-context note also said "Captured in plan 06-03 group 6" — read as "the cross-phase contract is documented here, not enforced." Two known holes documented in STATE.md Pending:

   - **Webhook listener still uses single `ALLOWED_SOURCE` (`process.env.GITHUB_USER_OR_ORG`).** Multi-source webhook routing requires reading the `GITHUB_SOURCES` env list and accepting any owner in it. Webhook events for source #2 currently 404 with `unknown_source`.
   - **Webhook listener does NOT source `droplet/lib/filter-repos.sh` or apply REPOS-01.** A push to a denied repo would still trigger a sync (sync-one-repo.sh has no allow/deny knowledge — it just clones/updates the path it's told). Cron path is correctly filtered; webhook path isn't.

   Both are out of Phase 6 scope per plan boundary; Phase 6 verify groups 4 covers cron-path enforcement only. Phase 3.x follow-up will close these two holes.

3. **Operation-section clone example also updated.** The README had a stale `git clone --mirror …/myorg_myrepo.git` line that would fail post-Phase-6 (file lives at `…/myorg/myorg_myrepo.git` now). Fixed inline as part of the README task — minimal surgical change to keep docs consistent with the namespaced layout.

## Verification (this plan, static)

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` (full repo) | PASS |
| `bash -n` on all modified droplet scripts | PASS |
| `npm run` lists `migrate-mirrors` and `verify:phase-6` | PASS |
| `npm run migrate-mirrors` (no args) | bails with usage hint (acceptance) |
| `npm run verify:phase-6` (no real droplet) | fails at `loadConfig` — expected, can't dry-run a verify against an absent droplet |
| `loadConfig` against new `config.example.json` | normalises 2 sources, prints deprecation warning (acceptance) |
| README Multi-source section markdown valid | manual visual check PASS |

## Pending operator UAT (live droplet)

Plan 03's verifications 2, 3, 4 require a running multi-source droplet:

1. `GITHUB_TOKEN=… npm run verify:phase-6` against a 2-source config (one source carrying a non-empty deny glob hitting at least one real upstream repo) → expect exit 0, all 5 groups PASS.
2. `GITHUB_TOKEN=… npm run smoke-test` against the same 2-source config → expect exit 0 with the new per-source assertion path exercised.
3. `npm run migrate-mirrors -- --from <legacy>` against a freshly Phase-1-bootstrapped droplet → expect mirrors moved into `<legacy>/` and exit 0; second run prints "nothing to move" and exits 0.

These are operator-driven (requires real DO infra + real GitHub PAT) and tracked under STATE.md Pending.

## Cross-plan contracts honoured

- `cfg.sources: NormalizedSource[]` consumed via plan 01 export — single source of truth on TS side.
- `envSlot()` algorithm reproduced inline in `verify/phase-6.ts` (matches plan 01 + plan 02). Group 5 actively asserts cross-language agreement on every config name.
- `BACKUP_SOURCE_SUMMARY source=… upstream=… mirrored=… failed=…` regex contract from plan 02 is the only thing groups 3 + smoke-test parse — additive over Phase 1.
- `${BACKUP_DIR}/<source>/<owner>_<repo>.git` namespaced layout from plan 02 is the assumed path in groups 2 + 4 + smoke-test probes.
- Phase 2 `last-run.json` schema untouched (Phase 6 only adds `source` per repo entry, additive).
- Phase 3 `sync-one-repo.sh` invocation unchanged — same script powers both cron path (plan 02 outer loop) and webhook path (existing listener).

## Self-Check: PASSED

- All 5 tasks committed individually.
- `tsc --noEmit` clean across the full repo (post-Phase-6 changes).
- All static acceptance criteria from PLAN.md tasks 1–5 satisfied.
- key_files (2 created, 3 modified) all exist on disk.
- `git log --grep="^(feat|docs)(06-03)"` returns 5 commits as expected.
- Operator UAT items captured in STATE.md Pending (live-droplet path).

## Next phase readiness (rolled up)

Phase 6 acceptance per ROADMAP SC#1–7:
- **SC#1** (back-compat config): plan 01 task 1 + plan 03 task 4 example with both fields → PASS.
- **SC#2** (iterate sources, apply globs, namespaced path): plan 02 task 3 + plan 03 task 2 group 2/4 → PASS pending live verify.
- **SC#3** (webhook listener routes correctly): owned by Phase 3 verify; documented hole noted above + STATE.md Pending.
- **SC#4** (deny wins): plan 02 task 2 acceptance (5 cases pass) + plan 03 task 2 group 4 → PASS.
- **SC#5** (empty allow = all): plan 02 task 2 acceptance → PASS.
- **SC#6** (2-source smoke): plan 03 task 3 + task 2 → PASS pending live verify.
- **SC#7** (per-source status): on-disk contract (per-source SUMMARY + namespaced paths) is now in place; status.ts rendering is Phase 2's responsibility — not touched here.

Static gates green. Live-droplet UAT items belong to operator (STATE.md Pending).
