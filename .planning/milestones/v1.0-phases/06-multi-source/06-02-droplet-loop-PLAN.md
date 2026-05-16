---
phase: 06-multi-source
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - droplet/github-backup.sh
  - droplet/bootstrap.sh
  - droplet/lib/detect-account-type.sh
  - droplet/lib/filter-repos.sh
autonomous: true
requirements:
  - MULTI-01
  - REPOS-01
  - BACKUP-01
  - BACKUP-02

must_haves:
  truths:
    - "droplet/lib/detect-account-type.sh exposes detect_account_type <slug> echoing User|Organization (D-05); github-backup.sh sources and calls it instead of inlining the gh api probe (resolves Phase 1 plan-checker MED #4)"
    - "droplet/lib/filter-repos.sh exposes filter_repos <source> <allow_csv> <deny_csv> reading repo full_names from stdin and writing matching ones to stdout; deny wins on conflict (REPOS-01, ROADMAP SC#4); empty allow = all (ROADMAP SC#5)"
    - "github-backup.sh wraps its existing detect+fetch+clone/update body in an outer for SOURCE in $GITHUB_SOURCES loop (D-15 not in scope here; aggregate logic stays in this script for Phase 6 — sync-one-repo.sh extraction is Phase 3 territory)"
    - "Each source's repos are mirrored under ${BACKUP_DIR}/<source>/<owner>_<repo>.git (D-07)"
    - "Per-source allow/deny filtering applied between gh api list and clone/update loop using filter-repos.sh; allow-empty = all (ROADMAP SC#5); deny wins (SC#4)"
    - "One-shot legacy migration (D-08): on entry, if top-level ${BACKUP_DIR}/*.git directories exist AND exactly one source is configured AND that source.name matches the legacy GITHUB_USER_OR_ORG previously written, mv each *.git under <source>/; if ambiguous (multi-source, or different single-source name), abort with a loud error pointing at npm run migrate-mirrors"
    - "Per-source BACKUP_SOURCE_SUMMARY source=<n> upstream=N mirrored=M filed=F log line emitted (D-16, identical shape to Phase 1 BACKUP_SUMMARY)"
    - "Aggregate BACKUP_SUMMARY upstream=N mirrored=M failed=F (sum across sources) remains the final log line — Phase 1 NR-08 + verify-script parsers unchanged"
    - "Falls back to single-source mode when GITHUB_SOURCES is unset (covers an upgraded local TS + un-upgraded droplet during redeploy window) — D-04"
    - "bootstrap.sh creates ${BACKUP_DIR}/<source>/ per source on every run (mkdir -p, idempotent), and chmod+x for the new lib/ helpers"
  artifacts:
    - path: "droplet/lib/detect-account-type.sh"
      provides: "Shared helper extracted from github-backup.sh lines 97–111 — D-05"
      min_lines: 12
    - path: "droplet/lib/filter-repos.sh"
      provides: "Allow/deny glob filter for REPOS-01; reads stdin, writes stdout, deny-wins"
      min_lines: 30
    - path: "droplet/github-backup.sh"
      provides: "Multi-source loop, per-source filtering, namespaced mirror layout, per-source + aggregate SUMMARY lines, legacy migration"
    - path: "droplet/bootstrap.sh"
      provides: "Per-source mkdir, helper script chmod+x"
  key_links:
    - from: "droplet/github-backup.sh"
      to: "droplet/lib/detect-account-type.sh"
      via: "source"
      pattern: "source \\$\\{?BACKUP_DIR.*detect-account-type"
    - from: "droplet/github-backup.sh"
      to: "droplet/lib/filter-repos.sh"
      via: "source"
      pattern: "source \\$\\{?BACKUP_DIR.*filter-repos"
---

<objective>
Land the droplet-side multi-source + per-repo filtering machinery:
1. Extract the inlined user-vs-org `gh api` probe (current github-backup.sh lines 97–111) into `droplet/lib/detect-account-type.sh` (D-05, resolves Phase 1 plan-checker MED #4).
2. Create `droplet/lib/filter-repos.sh` — a stdin→stdout filter implementing the allow/deny glob policy for REPOS-01 (ROADMAP SC#4/SC#5).
3. Rewrite `github-backup.sh` to iterate `GITHUB_SOURCES`, read per-source allow/deny env vars (written by bootstrap-droplet.ts in plan 01), filter the gh-api repo list, mirror into source-namespaced subdirs, emit per-source SUMMARY + a rolled-up aggregate SUMMARY (Phase 1 contract preserved), and handle the one-shot legacy-layout migration for the single-source upgrade case (D-08).
4. Update `bootstrap.sh` to create per-source mirror subdirs and chmod+x the new `lib/` helpers.

Plan 01 owns the TypeScript surface; this plan owns the droplet/bash surface. The two run in parallel (Wave 1) — they share zero files. The CONTRACT they share is the `backup.env` shape (plan 01 produces, this plan consumes): `GITHUB_SOURCES` env var (space-separated names) and `GITHUB_SOURCE_ALLOW_<UPPER>` / `GITHUB_SOURCE_DENY_<UPPER>` (space-separated globs). `<UPPER>` = source name uppercased with non-alnum replaced by `_` — this slot algorithm MUST match plan 01's `envSlot()` exactly.

Output: 2 new bash helpers in `droplet/lib/`, multi-source-aware `github-backup.sh`, per-source `mkdir -p` in `bootstrap.sh`. No TS changes here.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/06-multi-source/06-CONTEXT.md
@droplet/github-backup.sh
@droplet/bootstrap.sh
@droplet/install-cron.sh

<interfaces>
backup.env (produced by plan 01, consumed here):
```
GITHUB_TOKEN=ghp_xxx
GITHUB_USER_OR_ORG=sumin            # legacy first-source fallback
GITHUB_SOURCES="sumin acme-org"
GITHUB_SOURCE_ALLOW_SUMIN=""
GITHUB_SOURCE_DENY_SUMIN=""
GITHUB_SOURCE_ALLOW_ACME_ORG="acme/foo-*"
GITHUB_SOURCE_DENY_ACME_ORG="*-archive"
BACKUP_DIR=/opt/github-backups
CRON_SCHEDULE="0 3 * * *"
```

detect-account-type.sh:
```bash
# Usage: detect_account_type <github-slug>
# Echoes "User" or "Organization" to stdout. Defaults to "User" on any
# gh api error. Returns 0.
detect_account_type() { ... }
```

filter-repos.sh:
```bash
# Usage: filter_repos <source> <allow_globs> <deny_globs>
#   stdin:  one repo full_name per line (e.g. "owner/repo")
#   stdout: matching repo full_names (one per line)
#   allow_globs / deny_globs: space-separated bash glob patterns
#     ("" = empty list)
# Policy:
#   - empty allow ⇒ all upstream repos match the allow stage
#   - non-empty allow ⇒ only repos matching at least one allow glob pass
#   - any deny match ⇒ rejected (deny wins, ROADMAP SC#4)
filter_repos() { ... }
```
</interfaces>

</context>

<tasks>

<task type="auto">
  <name>Task 1: Create droplet/lib/detect-account-type.sh (D-05)</name>
  <files>droplet/lib/detect-account-type.sh</files>
  <action>
Create new file. Header comment cites D-05 and Phase 1 plan-checker MED #4. Contents:

```bash
#!/usr/bin/env bash
# droplet/lib/detect-account-type.sh
#
# Shared helper extracted from github-backup.sh per Phase 6 D-05
# (resolves Phase 1 plan-checker MED #4 — eliminates the duplicated
# gh api probe between github-backup.sh and former smoke-test.ts step 8).
#
# Sourced (not executed) by github-backup.sh. The function is purely
# stdout-emitting; callers capture via $(detect_account_type "$slug").

# detect_account_type <github-slug>
# Echoes "User" or "Organization". Defaults to "User" on any gh api
# non-200 (matches the original inline behavior — || ACCOUNT_TYPE="User").
detect_account_type() {
  local slug="$1"
  local out
  out=$(gh api "/users/${slug}" --jq '.type' 2>/dev/null) || out="User"
  printf '%s\n' "${out}"
}
```

Permissions: chmod 0755 (set by bootstrap.sh).

**Acceptance:**
- File exists; `bash -n droplet/lib/detect-account-type.sh` passes (syntax check).
- Sourcing the file in a fresh bash defines `detect_account_type` as a function.
- Called with a real github user, returns `User`.
- Called with a real github org (e.g. `actions`), returns `Organization`.
- Called with a non-existent slug, returns `User` (default).
  </action>
</task>

<task type="auto">
  <name>Task 2: Create droplet/lib/filter-repos.sh (REPOS-01 glob filter)</name>
  <files>droplet/lib/filter-repos.sh</files>
  <action>
Create new file. Header comment cites ROADMAP SC#4 (deny wins) and SC#5 (empty allow = all).

```bash
#!/usr/bin/env bash
# droplet/lib/filter-repos.sh
#
# Allow/deny glob filter for REPOS-01. Reads repo full_names from stdin
# (one per line), writes matching ones to stdout, drops the rest.
#
# Sourced (not executed). The function uses bash's `case` glob matching
# (no extglob, no shopt magic) so behavior matches across bash 4/5.
# Glob meta is the standard set: * ? [..].
#
# ROADMAP SC#4: deny wins on allow/deny conflict.
# ROADMAP SC#5: empty allow list ⇒ all upstream repos pass the allow stage.

# _matches_any <pattern_list_space_separated> <full_name>
# Returns 0 if any pattern matches the full_name, 1 otherwise.
# Patterns may be either bare repo name (no slash → matched against the
# basename after owner/) OR owner/name glob (slash → matched against
# the full_name verbatim). Operators commonly write either; supporting
# both is friendlier than forcing one shape.
_matches_any() {
  local pats="$1"
  local full="$2"
  local name="${full##*/}"
  local p
  for p in ${pats}; do
    [[ -z "${p}" ]] && continue
    if [[ "${p}" == */* ]]; then
      # Pattern includes a slash → match full_name
      # shellcheck disable=SC2053
      [[ "${full}" == ${p} ]] && return 0
    else
      # Bare pattern → match basename only
      # shellcheck disable=SC2053
      [[ "${name}" == ${p} ]] && return 0
    fi
  done
  return 1
}

# filter_repos <source> <allow_globs> <deny_globs>
# stdin: one full_name per line; stdout: passing full_names.
filter_repos() {
  local source="$1"
  local allow="$2"
  local deny="$3"
  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    # 1. Deny wins (ROADMAP SC#4): if any deny pattern matches, drop.
    if [[ -n "${deny}" ]] && _matches_any "${deny}" "${line}"; then
      continue
    fi
    # 2. Empty allow ⇒ pass-through (ROADMAP SC#5).
    if [[ -z "${allow}" ]]; then
      printf '%s\n' "${line}"
      continue
    fi
    # 3. Non-empty allow: must match at least one allow pattern.
    if _matches_any "${allow}" "${line}"; then
      printf '%s\n' "${line}"
    fi
  done
}
```

Permissions: chmod 0755 (set by bootstrap.sh).

**Acceptance (test interactively before committing):**

```bash
source droplet/lib/filter-repos.sh
# All pass (empty allow + empty deny):
printf 'sumin/a\nsumin/b\n' | filter_repos sumin "" ""
# → sumin/a, sumin/b

# Deny wins:
printf 'sumin/a\nsumin/b-archive\n' | filter_repos sumin "" "*-archive"
# → sumin/a only

# Allow restricts:
printf 'acme/foo-1\nacme/bar\n' | filter_repos acme "foo-*" ""
# → acme/foo-1 only

# Owner/name pattern:
printf 'acme/foo-1\nacme/bar\n' | filter_repos acme "acme/foo-*" ""
# → acme/foo-1 only

# Conflict — deny wins:
printf 'acme/foo-1\nacme/foo-archive\n' | filter_repos acme "foo-*" "*-archive"
# → acme/foo-1 only
```

`bash -n` passes; `shellcheck droplet/lib/filter-repos.sh` may warn on the intentional unquoted `${p}` (glob expansion) — the SC2053 disable comment is already there.
  </action>
</task>

<task type="auto">
  <name>Task 3: Rewrite droplet/github-backup.sh for multi-source + filtering + legacy migration</name>
  <files>droplet/github-backup.sh</files>
  <action>
Replace lines 89 onward (everything after the header logging block) with the new multi-source body. Keep lines 1–88 (shebang, set -euo pipefail, exports, lockfile, env load, log() helper) BYTE-FOR-BYTE unchanged. The exit-status semantics from Phase 1 (FAIL > 0 → exit 1) are preserved.

**Step 0 — Source the helpers (immediately after the existing `log()` definition, before line 89):**

```bash
# Source Phase 6 helpers (resolves the user-vs-org probe + glob filter)
# shellcheck source=lib/detect-account-type.sh
source "${BACKUP_DIR}/lib/detect-account-type.sh"
# shellcheck source=lib/filter-repos.sh
source "${BACKUP_DIR}/lib/filter-repos.sh"
```

**Step 1 — Replace lines 89–142 (the single-source detect+fetch+filter+log section) with a multi-source preamble:**

```bash
log "════════════════════════════════════════════════════════"
log "GitHub backup started"
log "Backup directory: ${BACKUP_DIR}"
log "════════════════════════════════════════════════════════"

# D-04 fallback: GITHUB_SOURCES is the authoritative multi-source list.
# If the env doesn't carry it (upgraded local TS + un-upgraded droplet
# scenario), synthesise it from the legacy GITHUB_USER_OR_ORG so this
# script keeps working as a single-source backup.
if [[ -z "${GITHUB_SOURCES:-}" ]]; then
  if [[ -n "${GITHUB_USER_OR_ORG:-}" ]]; then
    GITHUB_SOURCES="${GITHUB_USER_OR_ORG}"
    log "GITHUB_SOURCES unset; falling back to legacy GITHUB_USER_OR_ORG=${GITHUB_USER_OR_ORG}"
  else
    log "ERROR: neither GITHUB_SOURCES nor GITHUB_USER_OR_ORG is set in backup.env"
    exit 1
  fi
fi

read -r -a SOURCES <<< "${GITHUB_SOURCES}"
if [[ "${#SOURCES[@]}" -eq 0 ]]; then
  log "ERROR: GITHUB_SOURCES parsed to empty list"
  exit 1
fi
log "Sources (${#SOURCES[@]}): ${SOURCES[*]}"

# ─── D-08: legacy single-source layout migration ─────────────────────
#
# Phase 1 stored mirrors at ${BACKUP_DIR}/<owner>_<repo>.git (no source
# segment). Phase 6 moves them to ${BACKUP_DIR}/<source>/<owner>_<repo>.git.
# Auto-migrate iff exactly one source is configured AND it equals the
# legacy GITHUB_USER_OR_ORG line previously written to backup.env. Any
# other case is ambiguous → abort with a pointer to migrate-mirrors.
shopt -s nullglob
LEGACY_TOP=( "${BACKUP_DIR}"/*.git )
shopt -u nullglob
if [[ "${#LEGACY_TOP[@]}" -gt 0 ]]; then
  if [[ "${#SOURCES[@]}" -eq 1 ]] \
     && [[ -n "${GITHUB_USER_OR_ORG:-}" ]] \
     && [[ "${SOURCES[0]}" == "${GITHUB_USER_OR_ORG}" ]]; then
    log "Migrating ${#LEGACY_TOP[@]} legacy mirror(s) into ${BACKUP_DIR}/${SOURCES[0]}/ …"
    mkdir -p "${BACKUP_DIR}/${SOURCES[0]}"
    for dir in "${LEGACY_TOP[@]}"; do
      mv "${dir}" "${BACKUP_DIR}/${SOURCES[0]}/"
    done
    log "  ✓ Migration complete"
  else
    log "ERROR: detected ${#LEGACY_TOP[@]} legacy mirror(s) at top of ${BACKUP_DIR}"
    log "       but cannot auto-migrate (sources=${#SOURCES[@]}, legacy=${GITHUB_USER_OR_ORG:-<unset>})."
    log "       Run \`npm run migrate-mirrors -- --from <legacy-source>\` on your"
    log "       local machine, then re-trigger this backup."
    exit 1
  fi
fi

# Source-name → env slot helper. MUST match bootstrap-droplet.ts envSlot()
# byte-for-byte: uppercase, then replace every non-alphanumeric char with _.
# NO trailing-underscore strip (plan 01 doesn't do it either) — keeps both
# sides trivially equivalent for any input.
slot() { local s; s=$(tr '[:lower:]' '[:upper:]' <<< "$1"); printf '%s\n' "${s}" | tr -c 'A-Z0-9\n' '_'; }
```

`slot()` contract note: `tr -c 'A-Z0-9\n' '_'` complements the class with newline included so the trailing `\n` from `printf` is preserved (instead of being replaced by `_`). Verify with: `slot acme-org` → `ACME_ORG`, `slot sumin.dev` → `SUMIN_DEV`, `slot foo-` → `FOO_` (matches plan 01's `envSlot("foo-") === "FOO_"`).

**Step 2 — Replace lines 145–195 (the single-pass SUCCESS/FAIL counter + clone loop + final SUMMARY) with the multi-source loop:**

```bash
TOTAL_AGG=0
SUCCESS_AGG=0
FAIL_AGG=0

for SOURCE in "${SOURCES[@]}"; do
  log ""
  log "──────────────────────────────────────────"
  log "  Source: ${SOURCE}"
  log "──────────────────────────────────────────"

  # Per-source env var lookup (slot matches bootstrap-droplet.ts envSlot)
  S="$(slot "${SOURCE}")"
  ALLOW_VAR="GITHUB_SOURCE_ALLOW_${S}"
  DENY_VAR="GITHUB_SOURCE_DENY_${S}"
  ALLOW="${!ALLOW_VAR:-}"
  DENY="${!DENY_VAR:-}"
  if [[ -n "${ALLOW}" ]]; then log "  allow: ${ALLOW}"; fi
  if [[ -n "${DENY}"  ]]; then log "  deny:  ${DENY}"; fi

  # Per-source mirror dir (idempotent)
  mkdir -p "${BACKUP_DIR}/${SOURCE}"

  # Detect account type via shared helper (D-05)
  ACCOUNT_TYPE=$(detect_account_type "${SOURCE}")
  if [[ "${ACCOUNT_TYPE}" == "Organization" ]]; then
    API_ENDPOINT="/orgs/${SOURCE}/repos?type=all&per_page=100"
    log "  Account type: Organisation"
  else
    API_ENDPOINT="/users/${SOURCE}/repos?type=all&per_page=100"
    log "  Account type: User"
  fi

  # Fetch list
  log "  Fetching repository list…"
  REPO_LIST=$(
    gh api --paginate "${API_ENDPOINT}" --jq '.[].full_name' 2>>"${LOG_FILE}"
  ) || { log "  ERROR: gh api failed for ${SOURCE}"; FAIL_AGG=$(( FAIL_AGG + 1 )); continue; }

  # Drop empty lines (Phase 1 NR equivalent)
  mapfile -t RAW <<< "${REPO_LIST}"
  TMP=()
  for r in "${RAW[@]}"; do [[ -n "$r" ]] && TMP+=("$r"); done
  RAW=( "${TMP[@]}" )

  UPSTREAM="${#RAW[@]}"
  log "  Upstream: ${UPSTREAM} repo(s) before filter"

  # Apply allow/deny (REPOS-01)
  FILTERED=()
  if [[ "${UPSTREAM}" -gt 0 ]]; then
    mapfile -t FILTERED < <(printf '%s\n' "${RAW[@]}" | filter_repos "${SOURCE}" "${ALLOW}" "${DENY}")
  fi
  KEPT="${#FILTERED[@]}"
  SKIPPED=$(( UPSTREAM - KEPT ))
  log "  After filter: ${KEPT} repo(s) to mirror (${SKIPPED} skipped by allow/deny)"

  # Per-source counters
  S_SUCCESS=0
  S_FAIL=0

  for REPO_FULL in "${FILTERED[@]}"; do
    OWNER="${REPO_FULL%%/*}"
    NAME="${REPO_FULL##*/}"
    MIRROR_PATH="${BACKUP_DIR}/${SOURCE}/${OWNER}_${NAME}.git"
    CLONE_URL="https://github.com/${REPO_FULL}.git"

    if [[ -d "${MIRROR_PATH}" ]]; then
      log "    [UPDATE] ${REPO_FULL} → ${MIRROR_PATH}"
      if git -C "${MIRROR_PATH}" remote update --prune >>"${LOG_FILE}" 2>&1; then
        log "             ✓ Updated"
        S_SUCCESS=$(( S_SUCCESS + 1 ))
      else
        log "             ✗ Update FAILED"
        S_FAIL=$(( S_FAIL + 1 ))
      fi
    else
      log "    [CLONE]  ${REPO_FULL} → ${MIRROR_PATH}"
      if git clone --mirror "${CLONE_URL}" "${MIRROR_PATH}" >>"${LOG_FILE}" 2>&1; then
        log "             ✓ Cloned"
        S_SUCCESS=$(( S_SUCCESS + 1 ))
      else
        log "             ✗ Clone FAILED"
        S_FAIL=$(( S_FAIL + 1 ))
      fi
    fi
  done

  # Per-source SUMMARY marker (D-16). Mirrors Phase 1 BACKUP_SUMMARY shape
  # so smoke + verify parsers can reuse the same regex.
  log "  BACKUP_SOURCE_SUMMARY source=${SOURCE} upstream=${KEPT} mirrored=${S_SUCCESS} failed=${S_FAIL}"

  TOTAL_AGG=$(( TOTAL_AGG + KEPT ))
  SUCCESS_AGG=$(( SUCCESS_AGG + S_SUCCESS ))
  FAIL_AGG=$(( FAIL_AGG + S_FAIL ))
done

log ""
log "════════════════════════════════════════════════════════"
log "Backup finished — success: ${SUCCESS_AGG}, failed: ${FAIL_AGG}"
log "════════════════════════════════════════════════════════"
log "BACKUP_SUMMARY upstream=${TOTAL_AGG} mirrored=${SUCCESS_AGG} failed=${FAIL_AGG}"

if [[ "${FAIL_AGG}" -gt 0 ]]; then
  exit 1
fi
exit 0
```

**Notes for the executor:**
- The Phase 1 `BACKUP_SUMMARY upstream=X mirrored=Y failed=Z` shape is preserved EXACTLY at end-of-run. The numbers are now post-filter (`KEPT` is "repos chosen for mirroring after allow/deny") so a passing 100% bar = all kept repos succeeded. This is the right read: filtered-out repos are operator intent, not failures.
- `BACKUP_SOURCE_SUMMARY` is sibling to `BACKUP_SUMMARY`, not a replacement (D-16, specifics §2).
- `${!VAR:-}` is bash's indirect expansion; works on bash 4+, present on Ubuntu 22.04.
- `mapfile -t FILTERED < <(...)` requires bash 4+. Same shebang as before.
- The global flock semantics (NR-06) are unchanged — the wrapping `flock 9` block at the top of the script still wraps the whole multi-source run as ONE locked unit (D-19).

**Acceptance:**
- `bash -n droplet/github-backup.sh` passes.
- `shellcheck droplet/github-backup.sh` passes or only emits pre-existing warnings (no new errors).
- Dry-run via `tsx scripts/bootstrap-droplet.ts` against a 2-source config + remote `${BACKUP_DIR}/github-backup.sh` triggers a run that mirrors into `<source>/` subdirs and emits per-source + aggregate SUMMARY lines. Plan 03's `verify:phase-6.ts` proves this end-to-end.
  </action>
</task>

<task type="auto">
  <name>Task 4: Update droplet/bootstrap.sh — per-source mkdir + lib helpers</name>
  <files>droplet/bootstrap.sh</files>
  <action>
Two additive edits, both idempotent.

**Edit 1 — After existing `chmod +x` for `github-backup.sh` (around line 102), add `lib/*.sh`:**

```bash
echo "▸ Setting script permissions…"
chmod +x "${BACKUP_DIR}/github-backup.sh"
chmod +x "${BACKUP_DIR}/install-cron.sh"
# Phase 6: shared helpers under lib/. github-backup.sh sources them.
if [[ -d "${BACKUP_DIR}/lib" ]]; then
  chmod +x "${BACKUP_DIR}/lib"/*.sh
fi
echo "  ✓ Scripts are executable"
```

**Edit 2 — Immediately after backup.env is sourced (after the `set +a` block around line 44), add per-source mkdir:**

```bash
# Phase 6: ensure each source has a mirror subdir before github-backup.sh runs.
# Idempotent: mkdir -p is a no-op if the dir exists. GITHUB_SOURCES is set
# by bootstrap-droplet.ts (D-04); fall back to GITHUB_USER_OR_ORG single-source
# during the upgrade window.
if [[ -n "${GITHUB_SOURCES:-}" ]]; then
  read -r -a _BOOT_SOURCES <<< "${GITHUB_SOURCES}"
elif [[ -n "${GITHUB_USER_OR_ORG:-}" ]]; then
  _BOOT_SOURCES=( "${GITHUB_USER_OR_ORG}" )
else
  _BOOT_SOURCES=()
fi
for _s in "${_BOOT_SOURCES[@]}"; do
  mkdir -p "${BACKUP_DIR}/${_s}"
done
unset _BOOT_SOURCES _s
```

Place this AFTER the `chmod 600 "${ENV_FILE}"` line and BEFORE the apt-update block (so a misconfigured env still fails loudly via the existing GITHUB_SOURCES/GITHUB_USER_OR_ORG checks downstream — note: bootstrap.sh itself doesn't validate these, github-backup.sh does on every run).

Also: bootstrap-droplet.ts (plan 01) currently `scpFile`s every `.sh` directly under `droplet/` to `${BACKUP_DIR}/`. The `droplet/lib/` directory needs to land at `${BACKUP_DIR}/lib/`. **This plan also adds a single tar-upload of the lib/ dir to bootstrap-droplet.ts** — wait, plan 01 owns bootstrap-droplet.ts. **Cross-plan touch alert**: bootstrap-droplet.ts is in plan 01's `files_modified`. Plan 01 must also handle the `droplet/lib/` upload. Add that to plan 01 task 2's checklist. (See coordination note in this plan's verification block; plan 01 picks it up via the shared backup.env contract document.)

Actually the cleanest split: bootstrap-droplet.ts's existing `scriptFiles` filter is `endsWith(".sh")` and reads only `dropletDir` top-level files (`readdirSync`). To pick up `droplet/lib/*.sh`, plan 01 must (a) recurse, or (b) add an explicit `lib/` step. Doing this in plan 01 keeps the TS-side upload logic in one plan. The contract note is added to plan 01's task 2 here for visibility.

**Acceptance:**
- `bash -n droplet/bootstrap.sh` passes.
- Running bootstrap twice in a row leaves `${BACKUP_DIR}/<source>/` directories present and untouched (idempotency preserved).
  </action>
</task>

</tasks>

<verification>

Goal-backward verification (this plan only):

1. `bash -n` + `shellcheck` clean on all four modified/created files (or only pre-existing warnings).
2. Sourcing `droplet/lib/filter-repos.sh` + running the 4 acceptance cases (task 2) produces the documented outputs.
3. Sourcing `droplet/lib/detect-account-type.sh` against a real user + real org via local `gh` produces `User` and `Organization` respectively.
4. With a 2-source config (one with deny list, one without), `github-backup.sh` running on a real droplet creates `${BACKUP_DIR}/<src1>/`, `${BACKUP_DIR}/<src2>/`, emits 2 × `BACKUP_SOURCE_SUMMARY` lines + 1 aggregate `BACKUP_SUMMARY`, and skips repos matching the deny list (verified by `ls` showing no mirror dir for any denied repo).

**Cross-plan coordination** (visible to the orchestrator's plan-checker pass):
- Plan 01 task 2 MUST also tar/scp `droplet/lib/*.sh` to `${BACKUP_DIR}/lib/`. If plan 01's bootstrap-droplet.ts upload logic does NOT pick up `droplet/lib/`, the `source` lines at the top of the new `github-backup.sh` fail at runtime. Plan 01's executor — when implementing task 2 — must extend `scriptFiles` enumeration to include `droplet/lib/*.sh` uploaded to `${BACKUP_DIR}/lib/<file>`. Concrete diff hint for plan 01: `readdirSync(dropletDir + "/lib")` for `.sh` files, scp each to `${backupDir}/lib/<basename>`, ensure `sshRun(... "mkdir -p ${backupDir}/lib")` runs once before the lib scp.
- `slot()` algorithm: plan 01 emits env var names via `envSlot()` (TS, `toUpperCase + replace non-alnum with _`), plan 02 reads via bash `slot()` (`tr` pipeline). Both must produce the SAME string for a given source name. The verification step in plan 03 must include `slot acme-org` on droplet vs `envSlot("acme-org")` in TS and assert string equality.

</verification>