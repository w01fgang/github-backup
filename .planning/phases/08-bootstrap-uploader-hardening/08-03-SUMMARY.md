# Phase 8 Plan 03 — README sync tooling + managed sections

**Status:** complete
**Completed:** 2026-05-17
**Requirements satisfied:** MANIFEST-03, FIREWALL-02

## What shipped

- **`scripts/sync-readme-manifest.ts` (new)** — reads `scripts/lib/droplet-manifest.ts`, renders a Markdown table (Path | Purpose | Phase | Tier), replaces content between the `<!-- BEGIN: droplet-manifest -->` / `<!-- END: droplet-manifest -->` markers in README.md. Supports `--check` mode (exits non-zero on staleness without mutating README). Bails with operator-actionable instructions if markers are missing.
- **`README.md`** — two new sections inserted before `## Troubleshooting`:
  - `## Droplet file manifest` — short prose + the managed marker pair. Populated by `npm run sync:readme` with 10 rows.
  - `## Firewall ruleset` — hand-maintained (D-06): inbound + outbound tables + drift-policy paragraph + repair-instruction pointer to `npm run create-droplet`.
- **`package.json`** — `sync:readme` and `check:readme` npm scripts added after the `verify:phase-*` block.

## Key files

- `scripts/sync-readme-manifest.ts` (created)
- `README.md` (modified — Droplet file manifest section + populated table + Firewall ruleset section)
- `package.json` (modified — two new scripts)

## Decisions honoured

- **D-05 (README-GEN):** single TypeScript script, two HTML-comment markers, idempotent.
- **D-06 (README-FIREWALL):** firewall ruleset is hand-maintained; no markers, no codegen.
- **D-07 (README-TRIGGER):** `--check` mode exists for pre-commit + CI in Plan 04.

## Verification

- `npx tsc --noEmit` exits 0.
- First `npm run sync:readme` exits 0 and writes 10 rows.
- Second `npm run sync:readme` reports "already up to date" and leaves `git diff README.md` empty (idempotent).
- `npm run check:readme` exits 0 against the populated section.
- All 5 webhook-trio + lib helper rows verified by `awk` + `grep` against the managed section.

## Self-Check: PASSED

## Deviation from the plan

- None.
