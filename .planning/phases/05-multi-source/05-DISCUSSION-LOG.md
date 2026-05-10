# Phase 5: Multi-source - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 05-multi-source
**Mode:** Autonomous (operator delegated; no interactive Q&A)
**Areas discussed:** Config schema migration, user-vs-org detection, mirror layout migration, path collisions, last-run.json schema, status display, smoke-test design, restore field format, cron/lock policy

---

## Config schema migration

| Option | Description | Selected |
|--------|-------------|----------|
| Hard rename, drop `githubUserOrOrg` | Single field `githubSources`; old config bails | |
| Both fields, `githubSources` wins, warn on dual presence | Back-compat preserved; loader normalizes to internal `sources: string[]` | ✓ |
| Rewrite config.json on load | Auto-migrate the on-disk file | |

**Decision:** Option 2 (D-01..D-04).
**Notes:** SC#1 explicitly mandates back-compat. PROJECT.md "minimal ops surface" rules out auto-rewriting the operator's config file. Normalizing to a uniform internal `sources: string[]` keeps every downstream call site simple. `bootstrap-droplet.ts` emits BOTH `GITHUB_SOURCES` and a legacy `GITHUB_USER_OR_ORG=` line so a stale droplet script remains operational against source #1.

---

## User-vs-org detection (Phase 1 plan-checker MED #4)

| Option | Description | Selected |
|--------|-------------|----------|
| Per-source `type: user\|org` hint in config | Operator declares each source's type; skip probe | |
| Always try both API paths | No probe; attempt /users then /orgs | |
| Extract probe to shared bash helper, droplet-side only | One source of truth for the probe; smoke-test does NOT re-implement it | ✓ |

**Decision:** Option 3 (D-05, D-06).
**Notes:** The duplicated probe was the actual flag from Phase 1. Centralizing in `droplet/lib/detect-account-type.sh` resolves the duplication permanently. Pushing the probe responsibility down to the droplet (where the token lives) and OUT of `smoke-test.ts` also keeps local tooling network-only-via-SSH, a property `verify:phase-1` already depends on. A `type:` hint would be operator-typeable and noisy for one bug case; "always try both" doubles API calls per source.

---

## Mirror-layout migration from Phase 1 single-source state

| Option | Description | Selected |
|--------|-------------|----------|
| Refuse to start if both layouts coexist | Force operator to migrate manually | |
| Auto-migrate top-level `*.git` into `<source>/` unconditionally | Always relocate on first multi-source run | |
| Auto-migrate iff exactly one source unchanged; else fail loud + offer `migrate-mirrors` helper | Asymmetric: silent in safe case, loud in ambiguous case | ✓ |
| Leave legacy mirrors in place; new layout only for new sources | Two layouts forever | |

**Decision:** Option 3 (D-08, D-09).
**Notes:** The "exactly one source matches the previously-configured `GITHUB_USER_OR_ORG`" case is unambiguous and has only one safe move (relocate); auto-migrating there minimizes operator friction. Every other case (added sources, removed sources, renamed source) could correspond to multiple intents; failing loud and pointing at `npm run migrate-mirrors` makes the operator's intent explicit. Two-layouts-forever (Option 4) was rejected because it permanently complicates Phase 3 path derivation and Phase 2 disk reporting.

---

## Cross-source path collision

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-flight collision detector across sources | Probe API to detect duplicate `<owner>/<repo>` across sources | |
| Namespace by source, no detection needed | `<source>/<owner>_<repo>.git` makes collisions impossible | ✓ |
| Suffix conflicts with source name | `<owner>_<repo>.<source>.git` flat | |

**Decision:** Option 2 (D-10).
**Notes:** Falls out of D-07 (the layout decision) for free. Within-source duplicates (`["sumin","sumin"]`) are rejected at config load (D-03) because they would create non-deterministic last-write-wins if a future change ever drops the namespacing — defense in depth.

---

## `last-run.json` schema for per-source status

| Option | Description | Selected |
|--------|-------------|----------|
| Flat list with `source` field per repo | One repos[] array, each entry tagged | |
| Nested `sources: [{ name, repos: [...], success, fail, ... }]` + rolled-up totals | Per-source block; aggregate top-level | ✓ |
| Separate file per source | `last-run-<source>.json` × N | |

**Decision:** Option 2 (D-11, D-12).
**Notes:** The status command needs both per-source and aggregate views (D-13 default output, D-14 `--source` filter). Nested keeps the per-source block self-contained (own counters, own timestamps) AND preserves Phase 2 D-09's "JSON is a strict superset" promise — flat-with-tag would force every Phase 2 consumer to group-by. Separate files per source breaks atomicity (Phase 2 D-03 temp+rename would now be N separate atomic ops, not one).

---

## Per-source status display

| Option | Description | Selected |
|--------|-------------|----------|
| Single combined table with `source` column | Rows tagged by source, no per-source totals | |
| Per-source counts header above Phase 2 totals + `--source <name>` filter flag | Aggregate stays the primary view; per-source available on demand | ✓ |
| Separate sectioned output, one section per source | Verbose by default | |

**Decision:** Option 2 (D-13, D-14).
**Notes:** Phase 2 D-09's "<30s scan" budget rules out making the default output verbose. Adding a per-source counts table is a few lines; the `--source` flag lets the operator drill in when one source goes red. JSON output stays unfiltered so a future alerter sees every source regardless of which `--source` the human picks.

---

## Smoke-test for SC#3 ("smoke test with 2 sources passes")

| Option | Description | Selected |
|--------|-------------|----------|
| One source backs up many repos, second backs up few | Stress one + sanity-check second | |
| Each source has its own test repo configured | Per-source `testRepo` field | |
| Configure 2 real sources, droplet loop is single source of truth, smoke asserts per-source SUMMARY | No source-enumeration logic in smoke-test | ✓ |

**Decision:** Option 3 (D-15, D-16).
**Notes:** Falls out of D-06 (no probe duplication in smoke-test). The new `BACKUP_SOURCE_SUMMARY` marker is a sibling to (not replacement for) `BACKUP_SUMMARY`, so existing Phase 1 smoke assertions (NR-08 timestamp filter, aggregate 100%-pass) keep working byte-for-byte. Per-source pass bar (`mirrored == upstream && failed == 0` for EACH source) inherits Phase 1 D-02. Operator picks the second source themselves — Claude does not auto-discover.

---

## Restore field format (`restoreTestRepo`) under multi-source

| Option | Description | Selected |
|--------|-------------|----------|
| New separate `restoreTestSource` field paired with existing `restoreTestRepo` | Two fields, no parsing | |
| Extend format: `<source>/<owner>/<repo>` mandatory in multi-source mode, legacy `<owner>/<repo>` accepted iff single-source | Single field, format adapts | ✓ |
| Drop `restoreTestRepo`; auto-pick first repo from first source | Zero-config | |

**Decision:** Option 2 (D-17).
**Notes:** Phase 3 D-01 explicitly chose "operator names the repo, fail loud if missing" over auto-pick — Option 3 would silently regress that. A second field (Option 1) doubles the operator's typing work and makes it possible to land in a half-configured state (source set, repo unset) Phase 3 already declined. Format extension preserves the single-field "fail loud" contract and keeps the legacy 2-segment form working in single-source mode.

---

## Cron / lock policy under multi-source

| Option | Description | Selected |
|--------|-------------|----------|
| Per-source lock files | `/var/lock/github-backup.<source>.lock` × N | |
| Single droplet-wide lock, sequential iteration | Phase 1 NR-06 unchanged; sources processed in order inside one cron run | ✓ |
| Per-source cron line, per-source lock | Each source gets its own crontab entry | |

**Decision:** Option 2 (D-19).
**Notes:** Per-source locks add zero benefit when one cron line invokes one process (Option 1). Per-source crontab entries (Option 3) introduces N moving parts in `install-cron.sh` and a stale-cron-entry problem on source-list shrinkage that Phase 4 idempotency would have to handle. Sequential iteration on s-1vcpu-1gb (PROJECT.md size pick) bounds memory + git pack contention. Parallel-inside-one-droplet is a v2 nice-to-have; multi-droplet sharding (REQUIREMENTS §v2) is the real performance lever.

---

## Claude's Discretion

The operator delegated this entire phase autonomously. Per the
delegation, every decision above was made by Claude inside the
locked-constraint envelope (PROJECT.md scope, Phase 1 D-02 100%
pass bar, Phase 1 D-06 verify convention, ROADMAP.md SC#1–4,
Phase 3 path-derivation no-regress). Areas where the bounding
constraint left the choice genuinely 50/50 are flagged in
CONTEXT.md `### Claude's Discretion`:

- D-08 auto-migrate scope (could be narrowed to require `--migrate`
  flag even in the unambiguous single-source case).
- D-13 exact column layout / glyphs / sort order.
- D-15 second source identity (operator picks, not Claude).
- D-17 segment delimiter (`/` chosen for natural URL-shape match).
- `migrate-mirrors` execution shape (local TS over SSH vs droplet-
  side bash invoked via SSH).

## Deferred Ideas

Captured in CONTEXT.md `<deferred>` block:
- Per-source cron schedules (v2)
- Per-source token scopes (v2; needs new secret-handling story)
- Parallel/concurrent source fetch (v2; multi-droplet sharding is the
  real lever per REQUIREMENTS §v2)
- Source-level access control / audit (out of single-operator scope)
- Removal of `githubUserOrOrg` (back-compat locked for v1)
- `restore-all` / bulk restore across sources (Phase 3 deferred,
  multi-source doesn't change the calculus)
- Source-aware pruning of deleted-from-github mirrors (Phase 2
  deferred the "skipped" semantic)
