# Phase 8 Plan 04 — Pre-commit hook + CI sync-check workflow

**Status:** complete
**Completed:** 2026-05-17
**Requirements satisfied:** MANIFEST-03 (enforcement layer)

## What shipped

- **`scripts/git-hooks/pre-commit` (new)** — native bash hook, mode 100755 committed. Runs `npx --no-install tsx scripts/sync-readme-manifest.ts --check` and rejects the commit with `error: README.md droplet-manifest section is stale; run 'npm run sync:readme' and re-stage` on staleness. Skips silently when `scripts/sync-readme-manifest.ts` is absent (legacy branches).
- **`package.json#scripts.prepare` (new)** — cross-platform `node -e` one-liner that copies `scripts/git-hooks/pre-commit` to `.git/hooks/pre-commit` and `chmod 0o755`s it. No-op when `.git/` is absent. Idempotent — always overwrites.
- **`.github/workflows/sync-check.yml` (new)** — single GitHub Actions workflow Phase 8 introduces. Runs `actions/checkout@v4` + `actions/setup-node@v4` + `npm ci` + `npm run check:readme` on push and PR to master/main. Catches `--no-verify` bypasses.

## Key files

- `scripts/git-hooks/pre-commit` (created, executable bit set)
- `package.json` (modified — prepare script added at top of `scripts` block)
- `.github/workflows/sync-check.yml` (created)

## Decisions honoured

- **D-07 (README-TRIGGER):** pre-commit + CI both enforce the same invariant via `--check`.
- **D-08 (HOOK-TOOL):** native bash hook; `node -e` prepare; zero new dev-deps (no husky, no simple-git-hooks).
- **D-09 (CI-INTRO):** exactly one workflow file shipped; scope expansion deliberate and bounded.

## Verification

- `bash -n scripts/git-hooks/pre-commit` exits 0.
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sync-check.yml'))"` exits 0 (valid YAML).
- `npm run prepare` exits 0 and produces a byte-identical, executable `.git/hooks/pre-commit`.
- **End-to-end smoke test (task 04-03):** mutated `scripts/lib/droplet-manifest.ts` (added a fake optional entry), staged it, attempted `git commit`. Hook fired, the commit was rejected with the exact staleness message, HEAD did not move, working tree restored cleanly.
- Live confirmation: every subsequent commit (`feat(08-04)`, `ci(08-04)`) ran the hook and printed `✓ README.md droplet-manifest section already up to date.` before landing.

## Self-Check: PASSED

## Deviation from the plan

- None.
