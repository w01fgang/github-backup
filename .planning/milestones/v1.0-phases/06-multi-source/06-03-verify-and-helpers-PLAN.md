---
phase: 06-multi-source
plan: 03
type: execute
wave: 2
depends_on: ["06-01", "06-02"]
files_modified:
  - scripts/migrate-mirrors.ts
  - scripts/verify/phase-6.ts
  - scripts/smoke-test.ts
  - config.example.json
  - README.md
autonomous: false
requirements:
  - MULTI-01
  - REPOS-01
  - TEST-01
  - TEST-02

must_haves:
  truths:
    - "Operator can run npm run migrate-mirrors -- --from <legacy-source> to relocate top-level *.git mirrors under <legacy-source>/ on a live droplet; idempotent (skips when nothing to move)"
    - "Operator can run npm run verify:phase-6 against a live droplet with a 2-source config (one source carrying a non-empty deny glob) and exit 0 — proves MULTI-01 + REPOS-01"
    - "verify:phase-6.ts asserts (1) cfg.sources length >= 2 and backup.env GITHUB_SOURCES line matches; (2) per-source mirror dir exists with >=1 *.git for every source; (3) last-run.log final BACKUP_SUMMARY parses and aggregate counts equal the sum of per-source BACKUP_SOURCE_SUMMARY lines; (4) NO mirror exists for any repo in any source's deny list (REPOS-01 SC#4); (5) TS envSlot matches bash slot output for every source name (cross-plan contract from plan 02)"
    - "smoke-test.ts extended with a sibling BACKUP_SOURCE_SUMMARY parser; asserts one per source and aggregate equals their sum"
    - "config.example.json shows the multi-source + repos.allow/deny form with comments documenting back-compat"
    - "README has a Multi-source section: config schema, allow/deny semantics + ROADMAP SC#4 deny-wins note, migrate-mirrors workflow for legacy upgrades"
  artifacts:
    - path: "scripts/migrate-mirrors.ts"
      provides: "Operator-driven legacy single-source → namespaced layout migration over SSH (D-09)"
      min_lines: 70
    - path: "scripts/verify/phase-6.ts"
      provides: "Five-group end-to-end Phase 6 verify per D-20"
      min_lines: 140
  key_links:
    - from: "scripts/verify/phase-6.ts"
      to: "scripts/lib/{ssh,config}.ts"
      via: "import sshFlags, runCapture, loadConfig"
      pattern: "from \"\\./\\.\\./lib/(ssh|config)\""
    - from: "scripts/migrate-mirrors.ts"
      to: "scripts/lib/ssh.ts"
      via: "import sshRun, runCapture"
      pattern: "from \"\\./lib/ssh\""
---

<objective>
Close the Phase 6 loop:
1. Ship `scripts/migrate-mirrors.ts` (D-09) so an operator with a Phase-1-era single-source droplet can move to multi-source without losing mirrors and without the auto-migration ambiguity case (handled in plan 02 task 3).
2. Ship `scripts/verify/phase-6.ts` (D-20) — the executable proof for ROADMAP SC#1–7 minus SC#7 status (status integration is Phase 2's responsibility; this plan asserts the data-shape contract on disk, not the rendering).
3. Extend `scripts/smoke-test.ts` with per-source SUMMARY assertions (D-15/D-16). The existing Phase 1 `BACKUP_SUMMARY` regex stays; we add a sibling regex and additional assertions.
4. Update `config.example.json` with a 2-source example including allow/deny.
5. Add a README "Multi-source + per-repo filtering" section.

This plan depends on plan 01 (TS contract: `cfg.sources`, `envSlot`) and plan 02 (droplet contract: per-source SUMMARY shape, namespaced mirror layout, `slot()` bash function). Both must be merged + bootstrap-droplet re-run before verify:phase-6 can run green.

Output: 2 new TS files, extended smoke-test, updated config example, README section.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/06-multi-source/06-CONTEXT.md
@.planning/phases/06-multi-source/06-01-config-and-env-PLAN.md
@.planning/phases/06-multi-source/06-02-droplet-loop-PLAN.md
@scripts/smoke-test.ts
@scripts/verify/phase-1.ts
@scripts/lib/ssh.ts
@scripts/lib/config.ts
@config.example.json
@README.md

<interfaces>
After plan 01 + 02 land:
- `loadConfig()` returns `cfg.sources: NormalizedSource[]`.
- `backup.env` on droplet carries `GITHUB_SOURCES="<n1> <n2>"` + per-source allow/deny envs.
- `${BACKUP_DIR}/<source>/<owner>_<repo>.git` is the new mirror path.
- `github-backup.sh` emits `BACKUP_SOURCE_SUMMARY source=<n> upstream=K mirrored=M failed=F` per source plus the existing aggregate `BACKUP_SUMMARY upstream=N mirrored=M failed=F` at end-of-run.
- `slot()` (bash, github-backup.sh) and `envSlot()` (TS, bootstrap-droplet.ts) produce identical strings for any source name.

Shared regexes (lift into verify/phase-6.ts):
```typescript
const SOURCE_SUMMARY_RE = /BACKUP_SOURCE_SUMMARY source=(\S+) upstream=(\d+) mirrored=(\d+) failed=(\d+)/g;
const AGG_SUMMARY_RE = /BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)/;
```
</interfaces>

</context>

<tasks>

<task type="auto">
  <name>Task 1: scripts/migrate-mirrors.ts — operator-driven legacy → namespaced migration (D-09)</name>
  <files>scripts/migrate-mirrors.ts</files>
  <action>
CLI:
```
tsx scripts/migrate-mirrors.ts --from <legacy-source-name>
```

Behavior:
1. Parse argv. Bail if `--from <name>` missing or empty.
2. Load `cfg` and `dropletInfo` via existing libs.
3. Assert `cfg.sources.some(s => s.name === legacy)` — refuse to migrate into a source that is not configured (operator typo guard).
4. Over SSH, run a single composite command (single `sshRun` call to keep this atomic-ish per ROADMAP MULTI-01):
   ```bash
   set -euo pipefail
   cd "${BACKUP_DIR}"
   shopt -s nullglob
   TOP=( *.git )
   shopt -u nullglob
   if [[ "${#TOP[@]}" -eq 0 ]]; then
     echo "MIGRATE_RESULT moved=0 skipped_existing=0 (nothing to move)"
     exit 0
   fi
   mkdir -p "${LEGACY}"
   MOVED=0
   SKIP=0
   for d in "${TOP[@]}"; do
     if [[ -d "${LEGACY}/${d}" ]]; then
       echo "  SKIP ${d} (already exists under ${LEGACY}/)" >&2
       SKIP=$(( SKIP + 1 ))
       continue
     fi
     mv "${d}" "${LEGACY}/"
     MOVED=$(( MOVED + 1 ))
   done
   echo "MIGRATE_RESULT moved=${MOVED} skipped_existing=${SKIP}"
   ```
   Build the command server-side via `bash -c '...'` with `LEGACY` and `BACKUP_DIR` interpolated. Both names are SHELL_SAFE per plan 01's validation, so single-quote interpolation is safe.
5. Parse the `MIGRATE_RESULT moved=N skipped_existing=K` line from the captured stdout. Print a summary locally:
   ```
   ✓  migrate-mirrors: moved <N> mirror(s) into ${BACKUP_DIR}/<legacy>/ on <droplet-ip>
      (<K> already-existing entries left in place)
   ```
6. Exit 0 on success. Exit 1 + `bail()` on any error.

**Idempotency**: re-running prints `moved=0 skipped_existing=0 (nothing to move)` once the migration completed.

**Safety**: no `rm`. Only `mv`. If target exists, skip + warn (the destination already has that mirror, leave the legacy copy alone — manual operator review then).

Imports:
```typescript
import { runCapture, sshFlags } from "./lib/ssh";
import { bail, loadConfig, loadDropletInfo } from "./lib/config";
```

(Or use `sshRun` + capture-via-redirect; either works. Existing helpers prefer `runCapture("ssh ... 'cmd'")`.)

**Acceptance:**
- `tsx scripts/migrate-mirrors.ts` (no args) bails with "--from <legacy-source-name> required".
- `tsx scripts/migrate-mirrors.ts --from notinconfig` bails with "source 'notinconfig' not in cfg.githubSources".
- Run against a real droplet that has been Phase-1-bootstrapped (top-level `*.git` mirrors), assert: after the command, all `*.git` dirs are under `${BACKUP_DIR}/<legacy>/`, and the top of `${BACKUP_DIR}` has no `*.git` entries.
- Second run prints "nothing to move", exit 0.
  </action>
</task>

<task type="auto">
  <name>Task 2: scripts/verify/phase-6.ts — five assertion groups (D-20 + REPOS-01)</name>
  <files>scripts/verify/phase-6.ts</files>
  <action>
Pattern after `scripts/verify/phase-1.ts` — fail-fast `assert(cond, msg)`, exit 0 on all-pass, no test framework. Mirror its `sshCapture` / `sshExitsZero` helpers (copy into this file; the Phase-4 D-Discretion idea of factoring out into `scripts/lib/ssh.ts` is deferred — not this plan's scope).

```typescript
#!/usr/bin/env node
/**
 * scripts/verify/phase-6.ts — verify:phase-6
 *
 * Asserts MULTI-01 + REPOS-01 + ROADMAP Phase 6 SC#1..#6 against a live
 * droplet. SC#7 (status integration) is owned by Phase 2's status.ts;
 * this script asserts the on-disk + log-line contract.
 *
 * Usage:
 *   npm run verify:phase-6
 *
 * Prerequisites:
 *   - cfg.sources.length >= 2 (otherwise "skip — single-source config")
 *   - bootstrap-droplet has been re-run after plan 01 + 02 merged
 *   - at least one of cfg.sources should carry a non-empty repos.deny
 *     (to exercise REPOS-01 SC#4 — otherwise the deny-not-mirrored
 *     assertion is vacuously true and we log a soft warning)
 */
```

**Assertion groups (run in order, all fail-fast):**

**Group 1 — config + env contract:**
- `cfg = loadConfig()`. `assert(cfg.sources.length >= 2, "Phase 6 verify requires >= 2 sources; got " + cfg.sources.length)`. If single-source, print "SKIP: configure githubSources with >= 2 entries to verify multi-source" and exit 0.
- `envOut = sshCapture("cat ${backupDir}/backup.env")`. Assert: line matches `^GITHUB_SOURCES="(.*)"$` and the space-split list equals `cfg.sources.map(s => s.name)` in order.
- For each `s` in `cfg.sources`: assert `backup.env` contains a line `GITHUB_SOURCE_ALLOW_${slot}="${s.allow.join(" ")}"` and matching `_DENY_` (slot = local envSlot computed via the same algorithm plan 01 uses; reproduce inline):
  ```typescript
  const envSlot = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  ```

**Group 2 — namespaced mirror layout (D-07):**
- For each source `s` in `cfg.sources`: assert `sshExitsZero("test -d ${backupDir}/${s.name}")`. Capture `ls ${backupDir}/${s.name}` and assert at least one `*.git` entry (if the source's filtered repo list is non-empty; if all of upstream is denied, log a soft note and skip).
- Assert top-level `${backupDir}/*.git` does NOT exist (legacy layout fully migrated). Allow `lib/` (helpers), and any `*.json` / `*.log` files. `find ${backupDir} -maxdepth 1 -type d -name '*.git'` returns empty.

**Group 3 — SUMMARY contract (D-16):**
- Trigger a fresh backup: `sshRun("REQUIRE_LOCK=1 ${backupDir}/github-backup.sh")`. (REQUIRE_LOCK=1 makes flock wait instead of exit-0 if cron is mid-run.)
- Capture the tail of `/var/log/github-backup.log` since the run started (use a `tStart` marker per Phase 1 NR-08: read `date -Iseconds` over SSH BEFORE the run, then `grep` log lines after that timestamp).
- Parse all `BACKUP_SOURCE_SUMMARY source=<s> upstream=<U> mirrored=<M> failed=<F>` lines. Assert:
  - Exactly `cfg.sources.length` such lines (one per source).
  - The `source=` values, as a set, equal the set of `cfg.sources.map(s => s.name)`.
  - For every line: `failed === 0` (Phase 1 D-02 100% pass bar applied per-source).
- Parse the single `BACKUP_SUMMARY upstream=<N> mirrored=<M> failed=<F>` line. Assert:
  - `upstream` equals the sum of per-source `upstream`.
  - `mirrored` equals the sum of per-source `mirrored`.
  - `failed` equals 0 and equals the sum of per-source `failed`.

**Group 4 — REPOS-01 deny enforcement (SC#4 + SC#5):**
- Identify `denySource = cfg.sources.find(s => s.deny.length > 0)`. If none, log:
  ```
  SOFT: no source has a non-empty repos.deny list; REPOS-01 SC#4 not exercised.
        To exercise: set repos.deny=["some-real-repo-pattern"] for one source
        in config.json, re-run bootstrap-droplet, then re-run verify:phase-6.
  ```
  and skip this group with exit code still 0.
- If present:
  - For each glob in `denySource.deny`: query the live upstream `gh api` repo list (over SSH on the droplet to reuse its token) and identify at least one upstream repo that matches the deny glob. If no upstream match exists for any deny pattern, log a soft note and skip (the operator's deny list isn't matching anything live — not a Phase 6 bug).
  - For each upstream repo that DOES match a deny glob: assert the mirror does NOT exist on disk:
    ```
    test ! -e ${backupDir}/${denySource.name}/${owner}_${name}.git
    ```
  - Assert at least one denied repo was upstream-present (i.e. we actually exercised the filter, not vacuous).

**Group 5 — slot() ↔ envSlot() agreement (cross-plan contract guard):**
- For each `s` in `cfg.sources`: run the bash slot algorithm verbatim over SSH (mirror of plan 02's `slot()`):
  ```
  ssh "S=$(tr '[:lower:]' '[:upper:]' <<<'${s.name}'); printf '%s\\n' \"\${S}\" | tr -c 'A-Z0-9\\n' '_'"
  ```
  Capture the single-line result.
- Compare against TS-side `envSlot(s.name)` (algorithm: `name.toUpperCase().replace(/[^A-Z0-9]/g, "_")`). Assert equal.
- The slot algorithms in plan 01 (TS) and plan 02 (bash) MUST stay in sync. This assertion is the canary that catches drift.

**Group 6 — listener / Phase 2 deferred:**
- Phase 6's ROADMAP SC#3 ("webhook listener resolves to correct mirror path") is exercised by Phase 3's webhook verify, not here. Print a one-liner:
  ```
  Phase 3 webhook routing into namespaced paths is verified by npm run verify:phase-3.
  ```
- **Cross-phase handoff note (informational, not asserted here):** REPOS-01 SC#4 ("deny wins on conflict") applies wherever filtering happens. For the webhook path, plan 03 of Phase 3 (or whatever plan creates `droplet/sync-one-repo.sh` / the webhook listener handler) MUST source `droplet/lib/filter-repos.sh` and apply the same `filter_repos <source> "${ALLOW}" "${DENY}"` step before sync — otherwise a denied repo could be mirrored via webhook even though cron skips it. Phase 3's planner is expected to read this Phase 6 context and wire the filter into the listener handler. This assertion is owned by Phase 3 verify, not Phase 6 verify.

**Exit semantics:** all asserts pass → print "✓ Phase 6 verify: PASSED" and `process.exit(0)`. Any assert fail → print message and `process.exit(1)` via `bail()`.

**Acceptance:**
- `tsc --noEmit` clean.
- Against a live droplet with a 2-source config (one source with one realistic deny pattern, e.g. `*.archive` or a specific repo name), exit 0.
- With the deny list deliberately broken (denying a repo that exists on disk in the wrong subdir), exit 1 with a message naming the offending repo.
  </action>
</task>

<task type="auto">
  <name>Task 3: Extend scripts/smoke-test.ts with per-source SUMMARY assertions (D-15/D-16)</name>
  <files>scripts/smoke-test.ts</files>
  <action>
Additive only — do NOT remove or weaken the existing Phase 1 `BACKUP_SUMMARY` assertion. Add a sibling regex + assertions immediately AFTER the existing summary parse step.

```typescript
const SOURCE_SUMMARY_RE = /BACKUP_SOURCE_SUMMARY source=(\S+) upstream=(\d+) mirrored=(\d+) failed=(\d+)/g;

// Phase 6 D-16: BACKUP_SOURCE_SUMMARY appears once per source.
const sourceMatches: RegExpExecArray[] = [];
for (let m: RegExpExecArray | null; (m = SOURCE_SUMMARY_RE.exec(filteredLogTail)); ) {
  sourceMatches.push(m);
}
const expectedSources = cfg.sources.map((s) => s.name);
assert(
  sourceMatches.length === expectedSources.length,
  `expected ${expectedSources.length} BACKUP_SOURCE_SUMMARY line(s), got ${sourceMatches.length}`
);
const observedSourceNames = sourceMatches.map((m) => m[1]).sort();
const expectedSorted = [...expectedSources].sort();
assert(
  JSON.stringify(observedSourceNames) === JSON.stringify(expectedSorted),
  `BACKUP_SOURCE_SUMMARY source= values do not match cfg.sources: got ${JSON.stringify(observedSourceNames)} expected ${JSON.stringify(expectedSorted)}`
);

// Aggregate equals per-source sum (Phase 1 100% pass bar applied per-source).
const aggUpstream = sourceMatches.reduce((a, m) => a + Number(m[2]), 0);
const aggMirrored = sourceMatches.reduce((a, m) => a + Number(m[3]), 0);
const aggFailed = sourceMatches.reduce((a, m) => a + Number(m[4]), 0);
assert(
  aggMirrored === aggUpstream && aggFailed === 0,
  `per-source counts: mirrored=${aggMirrored} upstream=${aggUpstream} failed=${aggFailed} — not 100%-pass`
);

// The existing aggregate BACKUP_SUMMARY (Phase 1) should equal these sums.
// The current code already asserts `summary.mirrored === summary.upstream && summary.failed === 0`;
// add the equality with per-source aggregate as a tighter assertion:
assert(
  summary.upstream === aggUpstream,
  `aggregate upstream ${summary.upstream} != sum of per-source upstream ${aggUpstream}`
);
```

Also: add a per-source SSH probe — for each source, assert at least one `*.git` exists under `${backupDir}/<source>/`. This subsumes the existing top-level probe; keep the existing probe too (it still has value in the single-source back-compat case where the multi-source loop ran with one source).

**Acceptance:**
- Existing single-source smoke (Phase 1 config) still passes — the new assertions kick in only when `cfg.sources.length >= 1`, and a 1-source config sees exactly 1 `BACKUP_SOURCE_SUMMARY` line which trivially passes the sum check.
- 2-source smoke passes when both sources mirror 100% of (filtered) upstream.
  </action>
</task>

<task type="auto">
  <name>Task 4: config.example.json — multi-source + allow/deny example</name>
  <files>config.example.json</files>
  <action>
Update the example to document the new shape. Keep `githubUserOrOrg` present but marked as a comment-style line via a sibling field (JSON doesn't support comments — use a `_comment` key, ignored by `loadConfig`).

```json
{
  "region": "fra1",
  "size": "s-1vcpu-1gb",
  "image": "ubuntu-22-04-x64",
  "dropletName": "github-backup",
  "firewallName": "github-backup-fw",
  "sshKeyFingerprint": "aa:bb:cc:dd:...",
  "sshKeyPath": "~/.ssh/id_ed25519",
  "sshUser": "root",
  "_comment_sources": "Phase 6 multi-source. Each entry: string (name only) or {name, repos:{allow?,deny?}}. Globs use bash case syntax (* ? [..]). Deny wins on conflict. Empty allow = all repos of source.",
  "githubSources": [
    "sumin",
    {
      "name": "acme-org",
      "repos": {
        "allow": ["acme-org/api-*", "acme-org/web-*"],
        "deny":  ["*-archive", "acme-org/internal-secrets"]
      }
    }
  ],
  "_comment_legacy": "githubUserOrOrg is still accepted as legacy single-source. If both fields are set, githubSources wins.",
  "githubUserOrOrg": "sumin",
  "backupDir": "/opt/github-backups",
  "cronSchedule": "0 3 * * *",
  "allowedSSHCidr": "203.0.113.42/32"
}
```

Note for the executor: `loadConfig` will warn about both fields being set; that's the documented behavior (plan 01 task 1). The example uses both intentionally to show the migration path. If `tsc --noEmit` or runtime complains about unknown keys (`_comment_*`), they're plain extras on `Config` — TS `Config` interface allows excess properties at parse time since `JSON.parse` returns `any`.

**Acceptance:**
- `tsx -e "import('./scripts/lib/config').then(m => console.log(m.loadConfig()))"` against this config exits 0 and prints `sources: [{name:"sumin",allow:[],deny:[]}, {name:"acme-org",allow:["acme-org/api-*","acme-org/web-*"],deny:["*-archive","acme-org/internal-secrets"]}]` plus a deprecation warning about both `githubSources` and `githubUserOrOrg`.
  </action>
</task>

<task type="auto">
  <name>Task 5: README.md — Multi-source + per-repo filtering section</name>
  <files>README.md</files>
  <action>
Add a new section AFTER any existing "Configuration" section (or, if README has none yet, after the install/quick-start section). Section title: `## Multi-source + per-repo filtering` (or similar — match existing README heading depth).

Required content:
1. **Config schema** — show a 2-source `githubSources` example with one bare-string source and one filtered source. Reference `config.example.json`.
2. **Allow/deny semantics** — three rules verbatim from ROADMAP SC#4/SC#5:
   - Empty allow list = all repos of source.
   - Non-empty allow = repos must match at least one allow glob.
   - Deny wins on conflict.
   - Globs are bash `case` syntax (`*`, `?`, `[..]`). A bare name like `foo-*` matches the repo basename; a `owner/name` form like `acme/foo-*` matches the full name.
3. **Mirror layout** — `${BACKUP_DIR}/<source>/<owner>_<repo>.git`. Note the change from Phase 1's `${BACKUP_DIR}/<owner>_<repo>.git`. Cite the legacy migration path.
4. **Upgrading from Phase 1 single-source** — `npm run migrate-mirrors -- --from <legacy-source>` workflow:
   - Set `githubSources` in `config.json` to your existing source name(s).
   - Re-run `npm run bootstrap-droplet` (writes new `GITHUB_SOURCES` env, creates per-source subdirs, but does NOT move existing mirrors).
   - Run `npm run migrate-mirrors -- --from <legacy-source>` to move top-level `*.git` mirrors into `<legacy-source>/`.
   - The next cron sweep / webhook event runs against the new layout.
   - Single-source case auto-migrates on the next `github-backup.sh` run (no manual command needed); multi-source upgrade requires `migrate-mirrors` (avoid silent ambiguity).
5. **Verify** — `GITHUB_TOKEN=... npm run verify:phase-6` proves the config + on-disk layout end-to-end.
6. **Back-compat note** — `githubUserOrOrg` is still accepted as a legacy single-source field. Both fields set → `githubSources` wins with a printed deprecation warning. Removal is a v2 breaking change (deferred).

Style: match existing README's tone + code-fence convention (bash and json blocks). Keep section concise — ~60–90 lines of markdown.

**Acceptance:**
- Section parses as valid markdown (no broken code fences).
- All referenced commands exist (`migrate-mirrors`, `verify:phase-6`, `bootstrap-droplet`).
- No claim contradicts ROADMAP SC#1–7 or PROJECT.md.
  </action>
</task>

</tasks>

<verification>

Goal-backward verification (this plan only):

1. `tsc --noEmit` clean on both new TS files.
2. `npm run verify:phase-6` against a live 2-source droplet (one source with a non-empty deny glob hitting at least one real upstream repo) exits 0.
3. `npm run smoke-test` against the same 2-source config exits 0 and the new per-source assertion path is exercised (visible in the log).
4. `npm run migrate-mirrors -- --from <legacy-source>` against a freshly Phase-1-bootstrapped droplet (top-level mirrors) moves them under `<legacy-source>/` and exits 0; second run prints "nothing to move" + exit 0.
5. README's Multi-source section answers the operator's 4 questions: how do I write the config, what does deny/allow do, where do mirrors live, how do I upgrade from single-source.

**Phase 6 acceptance (rolled up across plans 01/02/03):**
- ROADMAP SC#1 (back-compat config) — proven by `loadConfig` against `config.example.json` with both fields set (plan 01 task 1 + plan 03 task 4).
- ROADMAP SC#2 (iterate sources, apply globs, namespaced path) — proven by plan 02 task 3 + plan 03 task 2 group 2/4.
- ROADMAP SC#3 (webhook listener routes correctly) — owned by Phase 3 verify; this plan's task 2 group 6 documents the cross-phase handoff.
- ROADMAP SC#4 (deny wins) — proven by plan 02 task 2 acceptance + plan 03 task 2 group 4.
- ROADMAP SC#5 (empty allow = all) — proven by plan 02 task 2 acceptance.
- ROADMAP SC#6 (2-source smoke) — proven by plan 03 task 3 (smoke-test extension) + task 2.
- ROADMAP SC#7 (per-source status) — Phase 2's status.ts implements; the on-disk contract this plan asserts (per-source SUMMARY shape + namespaced paths) is what status.ts will read.

</verification>