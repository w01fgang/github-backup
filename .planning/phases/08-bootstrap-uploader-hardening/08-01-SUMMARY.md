# Phase 8 Plan 01 — Manifest module + uploader rewrite

**Status:** complete
**Completed:** 2026-05-17
**Requirements satisfied:** MANIFEST-01, MANIFEST-02

## What shipped

- **`scripts/lib/droplet-manifest.ts` (new)** — typed `ManifestEntry` interface plus tiered `required` / `optional` arrays. 10 required entries covering all phase-1/3/6/7 artifacts (bootstrap, github-backup, status, install-cron, sync-one-repo, webhook trio, two lib helpers). Optional list deliberately empty for Phase 8.
- **`scripts/bootstrap-droplet.ts`** — both `readdirSync` glob loops at lines 289-322 removed. New flow:
  1. Pre-flight `fs.existsSync` loop iterating `manifest.required`, bailing with literal `missing required artifact: <path>` on the first miss. Placed BEFORE `waitForSsh` — no SSH/scp is opened when a required file is missing.
  2. Manifest-driven upload loop. `mkdir -p ${backupDir}/${destSubdir}` once per distinct subdir, then `scpFile` each entry.
  3. Optional-tier loop: warn `⚠ optional artifact not shipped: <path>` on miss, scp on hit.

## Key files

- `scripts/lib/droplet-manifest.ts` (created)
- `scripts/bootstrap-droplet.ts` (modified — import line + pre-flight block + upload loops)

## Decisions honoured

- **D-01 (MANIFEST-LOC):** lives in `scripts/lib/droplet-manifest.ts`.
- **D-02 (MANIFEST-SHAPE):** exact `{ path, purpose, phase, destSubdir, chmodExec }` shape.
- **D-03 (UPLOAD-ENUM):** three-step flow, pre-flight before any SSH.
- **D-04 (UPLOAD-BAIL):** fail-fast on first miss, reuse `bail()` from `scripts/lib/config.ts`.

## Verification

- `npx tsc --noEmit` exits 0.
- All static greps from `08-01-PLAN.md` acceptance criteria pass.
- Live behavioural test: `rm droplet/webhook-listener.js && npm run bootstrap-droplet` exited non-zero with `❌ missing required artifact: droplet/webhook-listener.js` on stderr; no `ssh`/`scp` invocation observed.
- File restored after the test; working tree clean.

## Self-Check: PASSED

## Deviation from the plan

- **Pre-flight location.** Plan task 01-02 Edit B described inserting the pre-flight "immediately after the `bail("droplet/ directory not found...")` block (currently around line 282)" with the claim that `scpFile`/`sshRun` are "the first network ops, all below". This is incorrect — the actual file has `waitForSsh` at line 215 and `sshRun` at line 218, both BEFORE line 282. The plan's `must_haves` truth D-03 and CONTEXT D-03 are unambiguous: pre-flight runs **BEFORE any SSH**. I placed the pre-flight immediately after the `console.log("\n📦  Bootstrapping…")` line and BEFORE `waitForSsh`, which is the first network op. The behavioural test (no ssh/scp process when a required file is missing) confirms the contract is met.
- **Comment wording.** Plan acceptance asked for `grep -c "missing required artifact:" === 1`. My initial comment also contained the literal phrase, producing 2 matches. Reworded the comment to "Bail message wording is the contract from ROADMAP Phase 8 SC#2." to satisfy the literal grep.

## Not in scope of this plan

- `verify:phase-7` regression run requires live droplet; deferred to Phase 10 live UAT.
