#!/usr/bin/env bash
# droplet/github-backup.sh
#
# Mirrors all GitHub repositories for the configured user or organisation.
# Designed to be run on a schedule (via cron) or manually.
#
# Behaviour:
#   - New repos  → git clone --mirror https://github.com/<owner>/<repo>.git
#   - Known repos → git -C <mirror> remote update --prune
#   - Pagination  → gh api --paginate (handles any number of repos)
#   - Logging     → all output timestamped to /var/log/github-backup.log
#
# Configuration is read from ${BACKUP_DIR}/backup.env which is placed there
# by bootstrap.sh. Required variables:
#   GITHUB_TOKEN        — Personal Access Token with repo read scope
#   GITHUB_USER_OR_ORG  — GitHub username or organisation name
#   BACKUP_DIR          — local directory for mirror repos (default /opt/github-backups)
#
# Exit codes:
#   0 — all repos backed up successfully (or nothing to back up)
#   1 — one or more repos failed

set -euo pipefail

# ── Environment (important for cron, which has a minimal $PATH and no $HOME) ──
export HOME="/root"
export PATH="/usr/local/bin:/usr/bin:/bin"
# Tell git never to block waiting for user input — fail instead
export GIT_TERMINAL_PROMPT=0

# ── Single-instance lock (WR-02 / WR-09) ──
# Cron + smoke + verify can race on the same *.git mirrors. flock on a
# fixed path serialises every invocation; -n means "exit cleanly if
# another run holds the lock" so cron does not pile up.
LOCK_FILE="${LOCK_FILE:-/var/lock/github-backup.lock}"
exec 9>"${LOCK_FILE}"
# NR-01: cron uses non-blocking + silent-exit (avoid retry pile-up).
# verify/smoke set REQUIRE_LOCK=1 to block until the lock is free, so
# their "trigger then assert BACKUP_SUMMARY" model never sees a stale
# previous-run summary as if it were the current run.
# NR-06: bound the wait with `flock -w N`. A wedged prior run (mid-clone
# of a 5 GB repo, hung TLS handshake, kernel NFS lock weirdness) would
# otherwise hang verify/smoke for their entire wall-clock budget. exit 75
# (EX_TEMPFAIL) so the caller can surface "previous run wedged" distinctly
# from a real backup failure.
LOCK_WAIT_SECONDS="${LOCK_WAIT_SECONDS:-600}"
if [[ "${REQUIRE_LOCK:-0}" = "1" ]]; then
  if ! flock -w "${LOCK_WAIT_SECONDS}" 9; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] timed out (${LOCK_WAIT_SECONDS}s) waiting for ${LOCK_FILE}; previous run may be wedged" >&2
    exit 75
  fi
elif ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] another github-backup.sh instance holds ${LOCK_FILE}; exiting." >&2
  exit 0
fi

BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
LOG_FILE="${LOG_FILE:-/var/log/github-backup.log}"
ENV_FILE="${BACKUP_DIR}/backup.env"

# ── Run-state instrumentation (Phase 2 D-03/D-05) ──────────────────────────
# STATE_DIR is created by bootstrap.sh with mode 700. last-run.json is the
# canonical "did the last run succeed?" surface read by github-backup-status.sh
# and `npm run status`. Schema and atomic-write contract locked in
# .planning/phases/02-monitoring/02-01-PLAN.md.
STATE_DIR="${STATE_DIR:-/var/lib/github-backup}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPOS_JSON_ROWS=()

# ── Load configuration ─────────────────────────────────────────────────────
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Run bootstrap.sh first." >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

# Validate required variables
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set in ${ENV_FILE}}"
: "${GITHUB_USER_OR_ORG:?GITHUB_USER_OR_ORG must be set in ${ENV_FILE}}"
: "${BACKUP_DIR:?BACKUP_DIR must be set in ${ENV_FILE}}"

# Export so gh and git credential helper can use it
export GITHUB_TOKEN

# --- Logging helper ---------------------------------------------------------
log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  # Write to stdout (captured by cron redirect) and append to log file
  printf '[%s] %s\n' "${ts}" "$*" | tee -a "${LOG_FILE}"
}

# ── Source Phase 6 helpers (D-05 + REPOS-01) ─────────────────────────────
# detect_account_type <slug> → "User" | "Organization" (with default-on-error).
# filter_repos <source> <allow_globs> <deny_globs>: stdin → stdout glob filter.
# shellcheck source=lib/detect-account-type.sh
source "${BACKUP_DIR}/lib/detect-account-type.sh"
# shellcheck source=lib/filter-repos.sh
source "${BACKUP_DIR}/lib/filter-repos.sh"

# Source-name → env slot helper. MUST match bootstrap-droplet.ts envSlot()
# byte-for-byte: uppercase, then replace every non-alphanumeric char with `_`.
# NO trailing-underscore strip (plan 01's envSlot doesn't do it either) — keeps
# both sides trivially equivalent for any input. The `tr -c '...\n'` complement
# class includes newline so the trailing \n from printf is preserved (instead
# of being replaced by `_`).
slot() { local s; s=$(tr '[:lower:]' '[:upper:]' <<< "$1"); printf '%s\n' "${s}" | tr -c 'A-Z0-9\n' '_'; }

# ── Main ──────────────────────────────────────────────────────────────────
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

# ── Outer multi-source loop ──────────────────────────────────────────────
#
# Phase 1 contract preserved end-to-end:
#   - Aggregate BACKUP_SUMMARY upstream=N mirrored=M failed=F at end-of-run.
#   - last-run.json with locked schema (started_at, finished_at, exit_code,
#     total, success, fail, repos[]). repos[] now also carries `source`.
#   - Per-repo work delegated to sync-one-repo.sh (Phase 3 D-15 contract).
#
# Phase 6 additions:
#   - One BACKUP_SOURCE_SUMMARY source=<n> upstream=K mirrored=M failed=F
#     line per source (D-16).
#   - Per-source allow/deny filter (REPOS-01) between gh api and sync.
#   - Mirror layout: ${BACKUP_DIR}/<source>/<owner>_<repo>.git (D-07).
TOTAL=0
SUCCESS=0
FAIL=0

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

  # Per-source mirror dir (idempotent — bootstrap.sh also creates it)
  mkdir -p "${BACKUP_DIR}/${SOURCE}"

  # Detect account type via shared helper (D-05). Defaults to "User" on error.
  ACCOUNT_TYPE=$(detect_account_type "${SOURCE}")
  if [[ "${ACCOUNT_TYPE}" == "Organization" ]]; then
    API_ENDPOINT="/orgs/${SOURCE}/repos?type=all&per_page=100"
    log "  Account type: Organisation"
  else
    API_ENDPOINT="/users/${SOURCE}/repos?type=all&per_page=100"
    log "  Account type: User"
  fi

  # Fetch list. Soft fail: log + count one source-level failure but continue
  # to the next source so a single bad token scope or rate limit doesn't kill
  # the whole multi-source run.
  log "  Fetching repository list…"
  REPO_LIST=$(
    gh api --paginate "${API_ENDPOINT}" --jq '.[].full_name' 2>>"${LOG_FILE}"
  ) || {
    log "  ERROR: gh api failed for ${SOURCE} (exit $?). Skipping source."
    log "  BACKUP_SOURCE_SUMMARY source=${SOURCE} upstream=0 mirrored=0 failed=1"
    FAIL=$(( FAIL + 1 ))
    continue
  }

  mapfile -t RAW <<< "${REPO_LIST}"
  # NR-02: drop ALL empty entries (including the trailing newline mapfile
  # contributes when REPO_LIST is empty). `set -u`-safe.
  TMP=()
  if [[ "${#RAW[@]}" -gt 0 ]]; then
    for r in "${RAW[@]}"; do [[ -n "$r" ]] && TMP+=("$r"); done
  fi
  RAW=()
  if [[ "${#TMP[@]}" -gt 0 ]]; then
    RAW=("${TMP[@]}")
  fi

  UPSTREAM="${#RAW[@]}"
  log "  Upstream: ${UPSTREAM} repo(s) before filter"

  # Apply allow/deny via REPOS-01 helper. Empty allow ⇒ pass-through (SC#5);
  # deny wins on conflict (SC#4). filter_repos is a no-op when both lists
  # are empty.
  FILTERED=()
  if [[ "${UPSTREAM}" -gt 0 ]]; then
    mapfile -t FILTERED < <(printf '%s\n' "${RAW[@]}" | filter_repos "${SOURCE}" "${ALLOW}" "${DENY}")
  fi
  KEPT="${#FILTERED[@]}"
  SKIPPED=$(( UPSTREAM - KEPT ))
  log "  After filter: ${KEPT} repo(s) to mirror (${SKIPPED} skipped by allow/deny)"

  # Per-source counters. The aggregate "100% pass" bar (Phase 1 D-02) applies
  # post-filter: KEPT is operator intent, SKIPPED is intentional, only failed
  # mirroring of a kept repo counts as failure.
  S_SUCCESS=0
  S_FAIL=0

  for REPO_FULL in "${FILTERED[@]}"; do
    OWNER="${REPO_FULL%%/*}"
    NAME="${REPO_FULL##*/}"

    # Predict per-repo action by mirror-path existence BEFORE invoking the
    # helper. sync-one-repo.sh now mirrors to
    # ${BACKUP_DIR}/${SOURCE}/${OWNER}_${REPO}.git (D-07). On non-zero exit
    # we override ROW_ACTION to "fail" below. Schema enum stays clone | update
    # | fail (D-12).
    if [[ -d "${BACKUP_DIR}/${SOURCE}/${OWNER}_${NAME}.git" ]]; then
      ROW_ACTION="update"
    else
      ROW_ACTION="clone"
    fi

    REPO_T0="${EPOCHREALTIME}"

    # Per-repo work delegated to sync-one-repo.sh — same handler the webhook
    # listener calls (D-15). The global flock on fd 9 is RETAINED around the
    # whole multi-source run; sync-one-repo.sh additionally takes a per-repo
    # lock on fd 8 (D-16). Outer wrapper just tallies SUCCESS/FAIL.
    if "${BACKUP_DIR}/sync-one-repo.sh" "${SOURCE}" "${OWNER}" "${NAME}"; then
      S_SUCCESS=$(( S_SUCCESS + 1 ))
    else
      ROW_ACTION="fail"
      S_FAIL=$(( S_FAIL + 1 ))
    fi

    REPO_DUR_MS=$(awk -v t0="$REPO_T0" -v t1="${EPOCHREALTIME}" 'BEGIN { printf "%d", (t1 - t0) * 1000 }')
    REPOS_JSON_ROWS+=( "$(jq -n --arg source "${SOURCE}" --arg name "${REPO_FULL}" --arg action "${ROW_ACTION}" --argjson duration_ms "${REPO_DUR_MS}" '{source:$source, name:$name, action:$action, duration_ms:$duration_ms}')" )
  done

  # Per-source SUMMARY marker (D-16). Same shape as the aggregate so verify +
  # smoke parsers can reuse one regex with an extra `source=` capture.
  log "  BACKUP_SOURCE_SUMMARY source=${SOURCE} upstream=${KEPT} mirrored=${S_SUCCESS} failed=${S_FAIL}"

  TOTAL=$(( TOTAL + KEPT ))
  SUCCESS=$(( SUCCESS + S_SUCCESS ))
  FAIL=$(( FAIL + S_FAIL ))
done

# ── Summary ───────────────────────────────────────────────────────────────
log ""
log "════════════════════════════════════════════════════════"
log "Backup finished — success: ${SUCCESS}, failed: ${FAIL}"
log "════════════════════════════════════════════════════════"

# Phase 1 BACKUP_SUMMARY shape preserved EXACTLY (no new tokens, parser-stable).
# Numbers are post-filter: TOTAL = sum of per-source KEPT (operator intent).
log "BACKUP_SUMMARY upstream=${TOTAL} mirrored=${SUCCESS} failed=${FAIL}"

# ── Atomic last-run.json writer (Phase 2 D-03) ─────────────────────────────
# Locked schema preserved; repos[] entries now carry `source` (Phase 6
# additive — Phase 2 reader treats unknown fields permissively).
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "${FAIL}" -gt 0 ]]; then EXIT_CODE=1; else EXIT_CODE=0; fi

if [[ "${#REPOS_JSON_ROWS[@]}" -gt 0 ]]; then
  REPOS_JSON="$(printf '%s\n' "${REPOS_JSON_ROWS[@]}" | jq -s '.')"
else
  REPOS_JSON="[]"
fi

mkdir -p "${STATE_DIR}"
TMP_FILE="${STATE_DIR}/last-run.json.tmp"
jq -n \
  --arg started "${STARTED_AT}" \
  --arg finished "${FINISHED_AT}" \
  --argjson exit "${EXIT_CODE}" \
  --argjson total "${TOTAL}" \
  --argjson ok "${SUCCESS}" \
  --argjson failed "${FAIL}" \
  --argjson repos "${REPOS_JSON}" \
  '{started_at:$started, finished_at:$finished, exit_code:$exit, total:$total, success:$ok, fail:$failed, repos:$repos}' \
  > "${TMP_FILE}"
mv -f "${TMP_FILE}" "${STATE_DIR}/last-run.json"
chmod 640 "${STATE_DIR}/last-run.json"
log "Wrote ${STATE_DIR}/last-run.json (exit=${EXIT_CODE})"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
