---
phase: 06-multi-source
plan: 01
status: complete
completed: 2026-05-15
commits:
  - 0575ad6 feat(06-01): multi-source Config + NormalizedSource + allow/deny normalisation
  - cbb18cf feat(06-01): multi-source backup.env writer + droplet/lib upload
  - def7727 feat(06-01): wire migrate-mirrors and verify:phase-6 npm scripts
key_files:
  modified:
    - scripts/lib/config.ts
    - scripts/bootstrap-droplet.ts
    - scripts/verify/phase-3.ts
    - package.json
---

# Plan 06-01 Summary

## What was built

TypeScript foundation for Phase 6 multi-source + per-repo filtering. Three discrete commits, each independently verifiable.

### 1. `scripts/lib/config.ts` — multi-source schema + normalisation

- New exported types: `SourceFilter`, `SourceEntry` (string | object), `NormalizedSource`.
- `Config.githubUserOrOrg` made optional; new `githubSources?: SourceEntry[]` (raw on-disk shape) and `sources: NormalizedSource[]` (always populated post-load).
- `loadConfig()` now collapses both shapes into `cfg.sources`. Validation:
  - Bails when both `githubUserOrOrg` and `githubSources` are missing/empty.
  - Both set → `githubSources` wins with deprecation warning.
  - Per-source: empty/duplicate names rejected; name must pass `SHELL_SAFE_RE`.
  - Per-glob: empty rejected; globs containing `" \` $ \\ \n \r` rejected (injection guard for the bash side that double-quotes them in env lines).
- `githubUserOrOrg` removed from `REQUIRED_FIELDS`; still in `SHELL_SAFE_FIELDS` (validated when present).

### 2. `scripts/bootstrap-droplet.ts` — multi-source `backup.env` + `droplet/lib/` upload

- `writeBackupEnv` keeps Phase 3's `(cfg, githubToken, webhookSecret)` signature (plan PLAN.md showed an outdated 2-arg signature; preserved `webhookSecret` as required by orchestrator's "preserve P3 contract" instruction).
- New env lines emitted:
  - `GITHUB_USER_OR_ORG=<sources[0].name>` — legacy back-compat (D-04). Always written.
  - `GITHUB_SOURCES="src1 src2 ..."` — authoritative multi-source list.
  - `GITHUB_SOURCE_ALLOW_<SLOT>="..."` and `GITHUB_SOURCE_DENY_<SLOT>="..."` per source.
- `envSlot()` algorithm: `name.toUpperCase().replace(/[^A-Z0-9]/g, "_")` — matches the bash `slot()` helper plan 02 will create.
- New `droplet/lib/*.sh` upload step after the existing top-level `.sh` loop. `mkdir -p ${backupDir}/lib` over SSH first; scp each `.sh`. No-op if `droplet/lib/` is empty/absent.

### 3. `package.json` — npm script wiring for plan 03

Added `migrate-mirrors` → `tsx scripts/migrate-mirrors.ts` and `verify:phase-6` → `tsx scripts/verify/phase-6.ts`. Wiring done in plan 01 so plan 03 doesn't have to touch `package.json` (file-disjoint waves).

## Deviations from plan

1. **`writeBackupEnv` signature.** PLAN.md showed `(cfg, githubToken)`. Actual file (post-Phase-3) is `(cfg, githubToken, webhookSecret)`. Preserved 3-arg signature; inserted Phase 6 lines into the existing body without dropping `WEBHOOK_SECRET` / `WEBHOOK_HOSTNAME`. Per orchestrator note: "Phase 3 added webhook secret resolution; Phase 5 just added `--rotate-env` flag... Plan 06-01's rewrite must preserve P5's `--rotate-env` and probe behavior."

2. **`scripts/verify/phase-3.ts` updated.** Not in plan's `files_modified`, but `cfg.githubUserOrOrg` is no longer required (now optional) and Phase 3's verify referenced it directly. Replaced 2 references with `cfg.sources[0].name` / `cfg.sources.some(s => s.name === owner)`. Comment in original code already said "Phase 6 will relax this", so this matches the planned trajectory.

## Verification (this plan)

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | PASS (no new errors after fix) |
| `loadConfig` against existing `config.example.json` | `cfg.sources.length === 1`, name preserved |
| `loadConfig` against 2-source array with `{name, repos:{deny:["foo*"]}}` | `cfg.sources.length === 2`, deny populated |
| `loadConfig` against duplicate-name array | bails with "duplicate source name" |
| `npm run` lists `migrate-mirrors` and `verify:phase-6` | confirmed |

Smoke check transcript:

```
$ tsx -e 'loadConfig()' against 2-source config:
sources: [{"name":"sumin","allow":[],"deny":[]},{"name":"acme-org","allow":[],"deny":["foo*"]}]
PASS multi-source

$ tsx -e 'loadConfig()' against legacy single-source:
sources: [{"name":"sumin","allow":[],"deny":[]}]
PASS legacy back-compat

$ tsx -e 'loadConfig()' against duplicate names:
expected throw: ❌ config.json: duplicate source name "a" in githubSources (D-03)
```

## Cross-plan contracts established

- `cfg.sources: NormalizedSource[]` shape locked. Plan 02 (bash) and plan 03 (verify) consume it via this exact shape.
- `backup.env` shape locked: `GITHUB_SOURCES` line + `GITHUB_SOURCE_{ALLOW,DENY}_<SLOT>` lines. Plan 02's `slot()` bash function MUST produce identical strings to `envSlot()` for any source name. Plan 03 group 5 asserts this cross-plan contract.
- `droplet/lib/*.sh` upload path established. Plan 02 creates `droplet/lib/detect-account-type.sh` and `droplet/lib/filter-repos.sh` and they will be picked up automatically.
- `WEBHOOK_SECRET` / `WEBHOOK_HOSTNAME` still emitted (Phase 3 contract intact).
- Legacy `GITHUB_USER_OR_ORG` line still emitted (Phase 1 droplet-side back-compat intact during the upgrade window).

## Next phase readiness

Plan 06-02 (bash side) can land now in parallel — the `backup.env` shape is fixed, the `droplet/lib/` upload path is wired, and `cfg.sources` is the single source of truth on the TS side.

## Self-Check: PASSED

- All 3 tasks committed individually.
- `tsc --noEmit` clean.
- All acceptance criteria from PLAN.md tasks 1, 2, 3 satisfied.
- Smoke checks (loadConfig: 1-source, 2-source, duplicate-rejection, config.example.json) all pass.
- `npm run` lists both new entries.
- key_files (config.ts, bootstrap-droplet.ts, package.json) all exist on disk.
- `git log --grep="^feat(06-01)"` returns 3 commits as expected.
