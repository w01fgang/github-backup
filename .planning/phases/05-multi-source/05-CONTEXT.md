# Phase 5: Multi-source - Context

**Gathered:** 2026-05-10
**Status:** Ready for planning

<domain>
## Phase Boundary

One droplet, one operator, N GitHub sources (users and/or orgs). The
backup pipeline iterates every source declared in `config.json`,
mirrors each repo into a source-namespaced subdirectory
(`${BACKUP_DIR}/<source>/<owner>_<repo>.git`), surfaces per-source
results to the Phase 2 status command, and proves the loop end-to-end
via a smoke run against ≥2 distinct sources. Phase 1's existing
single-source path remains valid (back-compat via `githubUserOrOrg`).

This phase does NOT introduce multi-tenancy (one operator only,
per `.planning/PROJECT.md`), per-source schedules, per-source token
scopes, or parallel/concurrent fetch. Sources are processed
sequentially under a single droplet-wide lock — the same lock
contract Phase 1 NR-06 established. The user-vs-org probe duplicated
between `droplet/github-backup.sh` and `scripts/smoke-test.ts`
(flagged by Phase 1 plan-checker MED #4) is consolidated into a
shared helper that both call sites use.

In scope: config schema migration with back-compat; source loop in
`droplet/github-backup.sh`; namespaced mirror layout +
one-shot migration of pre-Phase-5 mirrors; per-source enrichment of
Phase 2's `last-run.json`; status command per-source rendering;
two-source smoke + `verify:phase-5`; restore plumbing updates so
Phase 3's `restoreTestRepo` semantics remain unambiguous.

Out of scope: parallel source fetch, per-source cron schedules,
per-source token scopes, per-source firewall isolation, multi-tenant
SaaS, source-level access control, multi-droplet sharding (v2).

</domain>

<decisions>
## Implementation Decisions

### Config schema migration (D-01..D-04)
- **D-01:** Introduce `githubSources?: string[]` on `Config`. Keep
  `githubUserOrOrg?: string` as deprecated. Exactly one of the two
  must resolve to a non-empty source list, else `loadConfig` bails.
  Both present is accepted but warned (operator likely mid-migration);
  in that case `githubSources` wins and `githubUserOrOrg` is ignored
  with a printed deprecation notice citing the field name.
- **D-02:** `loadConfig` returns a normalized internal field
  `cfg.sources: string[]` (length ≥1, each entry validated against
  `SHELL_SAFE_RE`). When only `githubUserOrOrg` is present, the
  loader auto-promotes it to `[githubUserOrOrg]` so every downstream
  call site sees a uniform array. The on-disk file is NOT rewritten.
- **D-03:** Each source string is validated independently against
  `SHELL_SAFE_RE` (the existing `[A-Za-z0-9._/~@:-]+` allow-list);
  `loadConfig` bails on the first offender naming it. Empty strings
  and duplicates within `githubSources` are bail-fail (duplicates
  would create non-deterministic last-write-wins on namespaced paths
  if a future change drops the namespacing).
- **D-04:** `bootstrap-droplet.ts` writes a new env var
  `GITHUB_SOURCES="src1 src2 src3"` (space-separated, double-quoted,
  shell-safe per D-03) into `backup.env`. The legacy
  `GITHUB_USER_OR_ORG=…` line is also emitted for back-compat
  (set to the first source) so an old `github-backup.sh` on the
  droplet would still run against source #1 if the droplet code
  somehow predates the multi-source loop. New
  `github-backup.sh` reads `GITHUB_SOURCES`; falls back to
  `GITHUB_USER_OR_ORG` as a single-element list if `GITHUB_SOURCES`
  is unset (covers an upgraded local TS + un-upgraded droplet
  during the redeploy window).

### User-vs-org detection (D-05, D-06)
- **D-05:** Extract the user-vs-org probe currently inlined in
  `droplet/github-backup.sh` (lines 97–111) into a shared bash
  helper `droplet/lib/detect-account-type.sh` exposing one function:
  `detect_account_type <slug>` echoing `User|Organization` to stdout
  and returning 0; defaults to `User` on a `gh api` non-200, matching
  current behavior. Both `github-backup.sh` (per-source loop body)
  and any future droplet-side script source the helper. This
  resolves Phase 1 plan-checker MED #4 ("revisit at Phase 5").
- **D-06:** `scripts/smoke-test.ts` does NOT re-implement the probe.
  The smoke script's job ends at "trigger the droplet script and
  parse BACKUP_SUMMARY"; the droplet script is the single source of
  truth for source enumeration. SC#3 (smoke with 2 sources) is
  satisfied by configuring `githubSources` with 2 entries and
  trusting the droplet loop, not by smoke-test re-deriving the list.
  This eliminates the duplicated `gh api` user-vs-org logic
  permanently.

### Mirror layout & migration (D-07..D-09)
- **D-07:** New layout: `${BACKUP_DIR}/<source>/<owner>_<repo>.git`.
  `<source>` is the literal source slug as it appears in
  `githubSources` (already SHELL_SAFE per D-03). Each source gets its
  own subdir; `<owner>_<repo>.git` naming inside the subdir is
  unchanged from Phase 1 (preserves Phase 3's path derivation logic
  byte-for-byte inside a source).
- **D-08:** One-shot migration. On every run of `github-backup.sh`,
  before the source loop starts, scan `${BACKUP_DIR}` for any `*.git`
  directories at the top level (legacy single-source layout). If any
  are found AND `githubSources` is now multi-element OR the operator
  has changed sources, abort with a loud actionable error pointing
  at a new `npm run migrate-mirrors` helper script. If only ONE
  source is configured AND that source matches the legacy
  `GITHUB_USER_OR_ORG` value previously written to `backup.env`,
  auto-migrate by `mv`-ing each top-level `*.git` into
  `<source>/`. This makes the upgrade frictionless for the
  single-source operator (Phase 1 exit state) and fail-loud for the
  ambiguous case.
- **D-09:** New TS helper `scripts/migrate-mirrors.ts` (npm script
  `migrate-mirrors`) for the multi-source case. Operator-driven,
  not auto. Takes `--from <legacy-source>` and SSHes to droplet to
  `mkdir -p <legacy-source>/ && mv *.git <legacy-source>/`. Idempotent
  (skips if no top-level `*.git` directories remain). Leaves the
  D-08 abort path live so a forgotten migration cannot silently
  produce a half-migrated tree.

### Path-collision policy (D-10)
- **D-10:** No cross-source collision detection. The
  `<source>/<owner>_<repo>.git` namespacing makes physical
  collisions impossible. Same-source duplicates (operator lists
  `["sumin", "sumin"]`) are rejected at config load (D-03). The
  operator owning `dotfiles` AND backing up `friend/dotfiles` from
  another source is the explicit motivating case and is now safe
  by construction.

### `last-run.json` schema (D-11, D-12)
- **D-11:** Phase 2's flat schema becomes per-source:
  ```json
  {
    "started_at": "...",
    "finished_at": "...",
    "exit_code": 0,
    "sources": [
      {
        "name": "sumin",
        "started_at": "...",
        "finished_at": "...",
        "exit_code": 0,
        "total": 12,
        "success": 12,
        "fail": 0,
        "repos": [
          { "name": "sumin/dotfiles", "action": "update", "duration_ms": 421 }
        ]
      }
    ],
    "total": 12, "success": 12, "fail": 0
  }
  ```
  Per-source block carries the same fields Phase 2 D-03 defined at
  the top level. Top-level `total` / `success` / `fail` are kept as
  rolled-up sums for back-compat with Phase 2's status output and
  for the simple "did it work" question.
- **D-12:** Atomic write contract from Phase 2 D-03 (temp + rename)
  is preserved; the per-source array is built incrementally in the
  bash loop and emitted in one shot at end-of-run. Per-source blocks
  are appended after each source completes so a partial run leaves a
  diagnostically useful (but flagged-incomplete) JSON file —
  `exit_code` field defaults to a sentinel until the run finishes
  cleanly.

### Status command per-source display (D-13, D-14)
- **D-13:** Default text output adds a per-source counts header above
  the Phase 2 totals header. Format:
  ```
  source        ✓   ✗   total
  sumin         12  0   12
  acme-org       8  1    9
  ─────────────────────────────
  TOTAL         20  1   21
  ```
  Failed-repo names continue to print under the totals as Phase 2
  D-06 specified, prefixed with their source: `acme-org/foo`.
- **D-14:** New `--source <name>` filter flag. When passed, status
  reports only that source's block (counts, repos, disk usage scoped
  to `${BACKUP_DIR}/<source>` via `du -sh`). Disk capacity (`df -h`)
  remains filesystem-wide because `<source>` subdirs share the
  underlying mount. JSON output (Phase 2 D-09) emits the full
  per-source array regardless of `--source` (filter is presentation
  only, not a data filter — keeps the JSON contract stable for any
  future alerting consumer).

### Smoke-test for SC#3 (D-15, D-16)
- **D-15:** "Smoke test with 2 sources passes" is satisfied by:
  (a) operator configures `githubSources` with two entries — the
  operator's personal user (already used in Phase 1) plus a tiny
  GitHub org the operator owns or has read access to (Claude does
  NOT pick the second source — operator picks one with ≤ a handful
  of small repos to keep wall time reasonable). Documented in
  `config.example.json` as a comment field; (b) `smoke-test.ts`
  verifies `BACKUP_SUMMARY` and the new per-source SUMMARY lines
  emit one entry per source, and that the SSH-probe finds at
  least one mirror under EACH source's subdir. No code change to
  smoke-test source enumeration — see D-06.
- **D-16:** `github-backup.sh` emits a per-source summary marker
  line in addition to the existing aggregate `BACKUP_SUMMARY`:
  `BACKUP_SOURCE_SUMMARY source=<name> upstream=N mirrored=M failed=F`.
  Smoke-test asserts: count of `BACKUP_SOURCE_SUMMARY` lines (post
  `tStart` per Phase 1 NR-08) equals `githubSources.length`, every
  one has `mirrored == upstream && failed == 0` (the 100% pass bar
  from Phase 1 D-02 applies per-source), and the aggregate
  `BACKUP_SUMMARY` is the sum.

### Restore implications (D-17, D-18)
- **D-17:** Phase 3's `restoreTestRepo: "sumin/dotfiles"` becomes
  ambiguous when two sources contain a repo with the same
  `<owner>/<repo>` shape. Resolve by changing the field's accepted
  format to `"<source>/<owner>/<repo>"` (3-segment) when
  `githubSources` has length ≥2; the legacy 2-segment form remains
  accepted iff `githubSources` length == 1, in which case the single
  source is auto-prefixed. `verify:phase-3` parses, splits, and
  validates segments. No new field — this keeps Phase 3's
  "fail loud if missing or wrong" contract (D-01 there) and avoids a
  Phase-3 regression.
- **D-18:** README Restore section (Phase 3 D-07) gets a multi-source
  appendix during Phase 5's docs pass: a one-paragraph note that the
  on-droplet path is now `${BACKUP_DIR}/<source>/<owner>_<repo>.git`
  and a note pointing the operator at `npm run migrate-mirrors` if
  they upgrade an existing single-source droplet. Restore commands
  (clone-back over SSH) remain otherwise unchanged — only the path
  gains a `<source>/` segment.

### Cron / lock policy (D-19)
- **D-19:** Single droplet-wide lock at `/var/lock/github-backup.lock`
  is unchanged (Phase 1 NR-06 contract). Sources are iterated
  sequentially inside one cron run because (a) per-source locks add
  zero benefit when one cron line invokes one process, (b) sequential
  iteration bounds memory + git pack-write contention on the s-1vcpu-1gb
  droplet sized in PROJECT.md, (c) parallel multi-source fetch is the
  v2 candidate listed in REQUIREMENTS §v2 ("multi-droplet sharding")
  whose first useful iteration is per-droplet, not per-source-thread.
  Document this choice in `github-backup.sh` header so a future
  reader does not "improve" it by adding background jobs.

### Verify script (D-20)
- **D-20:** New `scripts/verify/phase-5.ts`, wired as
  `npm run verify:phase-5`. TS + tsx, fail-fast, reuses Phase 1's
  `assert(cond, msg)` (or extracts to `scripts/lib/assert.ts` if not
  done in Phase 3 — planner's call). Asserts:
  1. `loadConfig` returns `cfg.sources.length >= 2`.
  2. `backup.env` on droplet contains a `GITHUB_SOURCES=` line whose
     space-split list equals `cfg.sources`.
  3. For every source: `${BACKUP_DIR}/<source>/` exists on droplet
     and contains ≥1 `*.git` mirror.
  4. `last-run.json` parses, has a `sources` array of correct length
     and names matching `cfg.sources`, and aggregate counters equal
     the sum of per-source counters.
  5. `npm run status -- --json` exits 0 and emits the per-source
     schema (D-13 / D-14 contract).

### Claude's Discretion
- D-08 auto-migrate vs hard-fail-with-helper edge: chose
  auto-migrate for the strict "single source unchanged" case, fail
  loud everywhere else, on the bounding constraint that Phase 1
  D-02's 100%-pass bar plus PROJECT.md's "minimal ops surface" both
  push toward "no operation that could lose mirrors and no surprise
  rewrites of paths the operator might have scripted against." A
  planner could narrow this further (e.g. require `--migrate` flag
  even in the single-source case) without violating constraints.
- D-13 exact column layout / glyphs / sort order — surface choices
  inside the Phase 2 D-09 contract; planner picks.
- D-15 second source identity — operator picks; smoke does not auto-
  discover.
- D-17 segment delimiter (`/` chosen for `<source>/<owner>/<repo>`)
  vs other separators — `/` is the natural URL-shaped form and
  matches the on-disk `<source>/<owner>_<repo>` pattern; planner can
  refine the parse if a real edge case surfaces.
- Whether `migrate-mirrors` is purely SSH-driven from local or runs
  as a droplet-side bash script invoked via `sshRun` — equivalent
  outcomes, planner picks based on dry-run ergonomics.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Single-operator scope (NOT multi-tenant);
  runtime-only token policy; "fire-and-forget" framing. Multi-source
  is one operator with N GitHub identities, not N operators.
- `.planning/REQUIREMENTS.md` §Multi-Source — MULTI-01 (single droplet
  backs up multiple users/orgs from one config, array of sources).
- `.planning/ROADMAP.md` §Phase 5 — SC#1 (back-compat config), SC#2
  (namespaced layout), SC#3 (2-source smoke), SC#4 (per-source status).

### Phase 1 baseline (depended-on, do not regress)
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` — TS + tsx +
  npm-script convention (D-03), 100% pass bar (D-02), `verify:phase-N`
  fail-fast (D-06/D-07), config+env split (D-05).
  **Plan-checker MED issue #4** explicitly tagged the user-vs-org
  duplication for Phase-5 cleanup — D-05/D-06 here resolve it.
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` NR-06 — single
  droplet-wide lock, preserved by D-19.
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` NR-08 — `tStart`
  filter on `BACKUP_SUMMARY` parse, applied to per-source markers in
  D-16.

### Phase 2 baseline (depended-on per ROADMAP "Depends on Phases 1, 2")
- `.planning/phases/02-monitoring/02-CONTEXT.md` D-03 —
  `last-run.json` schema; D-11 here extends it per-source.
- `.planning/phases/02-monitoring/02-CONTEXT.md` D-06/D-07 — counts
  header + verbose per-repo line format, extended by D-13.
- `.planning/phases/02-monitoring/02-CONTEXT.md` D-08 — disk
  reporting; D-14 scopes per-source via `du -sh <source>/` while
  keeping `df -h` whole-filesystem.
- `.planning/phases/02-monitoring/02-CONTEXT.md` D-09 — JSON output
  superset; D-13/D-14 keeps the JSON schema a strict superset
  (sources array + per-source disk).

### Phase 3 baseline (no regress)
- `.planning/phases/03-restore/03-CONTEXT.md` D-01 — `restoreTestRepo`
  field; D-17 here extends format to `<source>/<owner>/<repo>` when
  `githubSources.length >= 2`, single-source legacy form preserved.
- `.planning/phases/03-restore/03-CONTEXT.md` D-07 — README two-flow
  Restore section; D-18 here adds a multi-source appendix without
  rewriting the two scenarios.
- `.planning/phases/03-restore/03-CONTEXT.md` Code Insights "Mirror
  path derivation" — `${BACKUP_DIR}/${owner}_${repo}.git` becomes
  `${BACKUP_DIR}/<source>/${owner}_${repo}.git`. Restore must use
  the new derivation.

### Existing code
- `droplet/github-backup.sh` — main change: wrap account-type
  detection (lines 97–111) and the repo-list + clone/update loop
  (lines 116–184) inside an outer `for SOURCE in ${GITHUB_SOURCES}`
  loop; emit per-source SUMMARY (D-16); write per-source blocks to
  `last-run.json` (D-11); preserve aggregate `BACKUP_SUMMARY`.
- `droplet/lib/detect-account-type.sh` (NEW) — extracted helper from
  D-05.
- `droplet/install-cron.sh` — unchanged. One cron line, sequential
  loop inside the script (D-19).
- `droplet/bootstrap.sh` — adds `mkdir -p ${BACKUP_DIR}/<source>`
  for each source on bootstrap (idempotent); sources `lib/detect-
  account-type.sh` symlink/copy if needed.
- `scripts/lib/config.ts` — adds `githubSources?: string[]`,
  `sources: string[]` (normalized), validation per D-01..D-03.
- `scripts/bootstrap-droplet.ts` — emits `GITHUB_SOURCES="…"` plus
  legacy `GITHUB_USER_OR_ORG=` per D-04.
- `scripts/smoke-test.ts` — assertions extended per D-15/D-16; NO
  source enumeration logic added (D-06).
- `scripts/verify/phase-5.ts` (NEW) — D-20.
- `scripts/migrate-mirrors.ts` (NEW) — D-09.
- `config.json` / `config.example.json` — example shows
  `githubSources: ["sumin", "some-org"]` with a comment that the old
  `githubUserOrOrg` form is still accepted.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lib/config.ts` `loadConfig` — extend with `sources`
  normalization (D-02), per-source `SHELL_SAFE_RE` validation (D-03);
  preserve the existing bail-loud-on-bad-shape pattern.
- `scripts/lib/ssh.ts` — `sshFlags`, `sshRun`, `runCapture`
  unchanged; `migrate-mirrors.ts` and `verify:phase-5.ts` reuse them
  directly.
- `scripts/verify/phase-1.ts` `assert(cond, msg)` — copy or extract
  to `scripts/lib/assert.ts`. Same fail-fast contract.
- `droplet/github-backup.sh` body (lines 145–184) — clone/update
  loop is reused inside the new per-source loop; the only change
  inside the loop body is the new `MIRROR_PATH` derivation:
  `${BACKUP_DIR}/${SOURCE}/${OWNER}_${NAME}.git`.
- `BACKUP_SUMMARY` regex in `scripts/smoke-test.ts` — extended
  (don't replace) with a sibling `BACKUP_SOURCE_SUMMARY_RE`.

### Established Patterns
- **Bail loudly on bad shape** — `loadConfig` rejects unsafe sources
  per `SHELL_SAFE_RE`; `bootstrap-droplet.ts` rejects bad token
  shape; `github-backup.sh` exits non-zero on any source-list parse
  error. Extends to multi-source: per-source validation, no silent
  fallback to "skip the bad one."
- **TS + tsx + npm script** — every operator command. `migrate-
  mirrors`, `verify:phase-5` follow.
- **Atomic JSON write** — Phase 2 D-03's temp+rename pattern is
  preserved end-of-run for the per-source schema.
- **Single droplet-wide lock** — Phase 1 NR-06 unchanged; multi-
  source iterates inside the lock (D-19).
- **`tStart` timestamp filter** — Phase 1 NR-08 pattern reused for
  per-source SUMMARY lines (D-16).

### Integration Points
- `droplet/github-backup.sh`: wrap detection + repo-list + loop
  inside `for SOURCE in ${GITHUB_SOURCES_ARRAY[@]}`; per-source
  counters; per-source SUMMARY line; aggregate SUMMARY at end;
  per-source blocks in JSON writer (after Phase 2 lands the writer).
- `droplet/bootstrap.sh`: `for SOURCE; do mkdir -p
  "${BACKUP_DIR}/${SOURCE}"; done` step; idempotent.
- `scripts/lib/config.ts`: schema migration; loader-level
  normalization; new validation.
- `scripts/bootstrap-droplet.ts`: `backup.env` writer emits
  `GITHUB_SOURCES` + legacy `GITHUB_USER_OR_ORG`.
- `scripts/status.ts` (Phase 2): per-source block rendering;
  `--source <name>` filter (D-14); no JSON-schema regression.
- `scripts/verify/phase-3.ts` (Phase 3): parse `restoreTestRepo` as
  3-segment when multi-source (D-17); no breakage in single-source
  mode.
- `package.json`: add `"migrate-mirrors": "tsx scripts/migrate-
  mirrors.ts"` and `"verify:phase-5": "tsx scripts/verify/phase-
  5.ts"`.

</code_context>

<specifics>
## Specific Ideas

- The Phase-1-to-Phase-5 upgrade path is the single most operationally
  risky moment in this phase: the operator has real mirrors on disk
  that must end up in `<source>/` subdirs without duplication or
  loss. D-08's "auto-migrate iff exactly one source unchanged, hard-
  fail otherwise + offer migrate-mirrors helper" is deliberately
  asymmetric — silent-and-safe in the boring case, loud-and-explicit
  the moment ambiguity could cost a mirror.
- The per-source SUMMARY marker (D-16) is intentionally a sibling to
  `BACKUP_SUMMARY`, not a replacement, so smoke-test's existing
  Phase-1 assertions (NR-08 timestamp filter, aggregate pass-bar)
  keep working without modification — Phase 5 only ADDS assertions.
- The deprecation of `githubUserOrOrg` is "warn, do not break."
  PROJECT.md's "minimal ops surface" plus the explicit SC#1 back-
  compat requirement together rule out a hard rename. Removal can
  ship in v2 if it ever ships.
- The user-vs-org probe lives on the droplet (`gh api` + token,
  network-bound), not in the local TS scripts. Keeping it droplet-
  side avoids a second `gh api` round trip from local-machine smoke
  runs and keeps the local tooling network-only-via-SSH (a property
  the Phase 1 verify script depends on).

</specifics>

<deferred>
## Deferred Ideas

- **Per-source cron schedules** — single cron line is enough for v1;
  parallel/staggered schedules belong in v2 if a source ever needs
  per-source freshness (huge org vs personal user).
- **Per-source token scopes** — single `GITHUB_TOKEN` covers every
  source the operator can read. Multiple tokens (e.g. one per org
  with fine-grained scopes) require a per-source env-var contract
  and a new secret-handling story; defer until a real motivation
  surfaces.
- **Parallel/concurrent source fetch** — sequential is simpler, safer
  on s-1vcpu-1gb, and matches the "fire-and-forget" framing.
  Parallel inside one droplet is the cheap optimisation; multi-
  droplet sharding (REQUIREMENTS §v2) is the real lever.
- **Source-level access control / audit** — out of single-operator
  scope by design.
- **Removal of `githubUserOrOrg`** — back-compat is locked for v1;
  removal is a v2 breaking change.
- **`restore-all`/bulk restore across sources** — Phase 3 deferred
  this; multi-source layout makes it cheaper to add later but the
  operator's stated need is single-repo restore (Phase 3 D-04).
- **Source-aware pruning of mirrors for repos no longer on github**
  — Phase 2 deferred this as a "skipped" semantic; multi-source
  doesn't change the calculus.

</deferred>

---

*Phase: 05-multi-source*
*Context gathered: 2026-05-10*
