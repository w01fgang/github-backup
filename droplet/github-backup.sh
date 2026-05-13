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

# ── Main ──────────────────────────────────────────────────────────────────
log "════════════════════════════════════════════════════════"
log "GitHub backup started — target: ${GITHUB_USER_OR_ORG}"
log "Backup directory: ${BACKUP_DIR}"
log "════════════════════════════════════════════════════════"

# ── Detect user vs. organisation ─────────────────────────────────────────
# The GitHub API exposes different endpoints for users and organisations.
# We detect the type once so we can pick the right paginated endpoint.
log "Detecting account type for '${GITHUB_USER_OR_ORG}'…"

ACCOUNT_TYPE=$(
  gh api "/users/${GITHUB_USER_OR_ORG}" --jq '.type' 2>/dev/null
) || ACCOUNT_TYPE="User"

if [[ "${ACCOUNT_TYPE}" == "Organization" ]]; then
  # type=all includes public, private, and forked repos
  API_ENDPOINT="/orgs/${GITHUB_USER_OR_ORG}/repos?type=all&per_page=100"
  log "  Account type: Organisation"
else
  # type=all includes public, private, and forked repos
  API_ENDPOINT="/users/${GITHUB_USER_OR_ORG}/repos?type=all&per_page=100"
  log "  Account type: User"
fi

# ── Fetch complete repository list ────────────────────────────────────────
# gh api --paginate follows GitHub's Link: response header automatically,
# fetching every page and concatenating the JSON arrays before jq processes them.
log "Fetching repository list…"

REPO_LIST=$(
  gh api --paginate "${API_ENDPOINT}" --jq '.[].full_name' 2>>"${LOG_FILE}"
) || { log "ERROR: gh api failed (exit $?). Aborting."; exit 2; }
mapfile -t REPOS <<< "${REPO_LIST}"
# NR-02: drop ALL empty entries, not just a trailing one. A blank line
# anywhere in the gh api output (mid-stream or post-trim) would otherwise
# loop with REPO_FULL="" and produce a phantom failure on a "_.git"
# clone target — tripping the 100%-pass bar with no actionable cause.
# Note: under `set -u` we must guard expansions of possibly-empty arrays.
TMP=()
if [[ "${#REPOS[@]}" -gt 0 ]]; then
  for r in "${REPOS[@]}"; do [[ -n "$r" ]] && TMP+=("$r"); done
fi
REPOS=()
if [[ "${#TMP[@]}" -gt 0 ]]; then
  REPOS=("${TMP[@]}")
fi

TOTAL="${#REPOS[@]}"
log "Found ${TOTAL} $([ "${TOTAL}" -eq 1 ] && echo 'repository' || echo 'repositories')."

# Counters initialised before the TOTAL=0 short-circuit so the last-run.json
# writer below can reference them unconditionally under `set -u`.
SUCCESS=0
FAIL=0

if [[ "${TOTAL}" -eq 0 ]]; then
  log "Nothing to back up."
  # Fall through to last-run.json writer — every run MUST emit a state file,
  # including the zero-repo case (operator's "did anything happen?" check).
fi

# ── Mirror each repository ────────────────────────────────────────────────

for REPO_FULL in "${REPOS[@]}"; do
  # REPO_FULL format: "owner/repo-name"
  OWNER="${REPO_FULL%%/*}"
  NAME="${REPO_FULL##*/}"

  # Predict per-repo action by mirror-path existence BEFORE invoking the
  # helper. sync-one-repo.sh mirrors to ${BACKUP_DIR}/${OWNER}_${REPO}.git
  # (sync-one-repo.sh:83). On non-zero exit we override ROW_ACTION to "fail"
  # below. Per D-12 the schema enum is clone | update | fail (no "skipped").
  if [[ -d "${BACKUP_DIR}/${OWNER}_${NAME}.git" ]]; then
    ROW_ACTION="update"
  else
    ROW_ACTION="clone"
  fi

  REPO_T0="${EPOCHREALTIME}"

  # Per-repo work (clone or update + per-repo lock + per-repo result line)
  # is delegated to sync-one-repo.sh — same handler the webhook listener calls
  # (D-15). The global flock at /var/lock/github-backup.lock acquired above on
  # fd 9 is RETAINED around the whole loop (Phase 1 NR-06 unchanged); sync-one-
  # repo.sh additionally takes a per-repo lock on fd 8 (D-16). The wrapper here
  # only tallies SUCCESS/FAIL based on the helper's exit code and keeps the
  # summary line below unchanged.
  if "${BACKUP_DIR}/sync-one-repo.sh" "${GITHUB_USER_OR_ORG}" "${OWNER}" "${NAME}"; then
    (( SUCCESS++ ))
  else
    ROW_ACTION="fail"
    (( FAIL++ ))
  fi

  REPO_DUR_MS=$(awk -v t0="$REPO_T0" -v t1="${EPOCHREALTIME}" 'BEGIN { printf "%d", (t1 - t0) * 1000 }')
  REPOS_JSON_ROWS+=( "$(jq -n --arg name "${REPO_FULL}" --arg action "${ROW_ACTION}" --argjson duration_ms "${REPO_DUR_MS}" '{name:$name, action:$action, duration_ms:$duration_ms}')" )
done

# ── Summary ───────────────────────────────────────────────────────────────
log "════════════════════════════════════════════════════════"
log "Backup finished — success: ${SUCCESS}, failed: ${FAIL}"
log "════════════════════════════════════════════════════════"

log "BACKUP_SUMMARY upstream=${TOTAL} mirrored=${SUCCESS} failed=${FAIL}"

# ── Atomic last-run.json writer (Phase 2 D-03) ─────────────────────────────
# Every run emits /var/lib/github-backup/last-run.json with the locked schema
# (see .planning/phases/02-monitoring/02-01-PLAN.md <schema>). Atomic write
# via temp + rename on the same filesystem prevents readers from seeing a
# half-written file. The TOTAL=0 path lands here too — empty repos[] array,
# success=0 fail=0, exit_code=0.
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
