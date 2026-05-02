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

BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
LOG_FILE="${LOG_FILE:-/var/log/github-backup.log}"
ENV_FILE="${BACKUP_DIR}/backup.env"

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

# ── Logging helper ─────────────────────────────────────────────────────────
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

mapfile -t REPOS < <(
  gh api --paginate "${API_ENDPOINT}" \
    --jq '.[].full_name' 2>>"${LOG_FILE}"
)

TOTAL="${#REPOS[@]}"
log "Found ${TOTAL} $([ "${TOTAL}" -eq 1 ] && echo 'repository' || echo 'repositories')."

if [[ "${TOTAL}" -eq 0 ]]; then
  log "Nothing to back up. Exiting."
  exit 0
fi

# ── Mirror each repository ────────────────────────────────────────────────
SUCCESS=0
FAIL=0

for REPO_FULL in "${REPOS[@]}"; do
  # REPO_FULL format: "owner/repo-name"
  OWNER="${REPO_FULL%%/*}"
  NAME="${REPO_FULL##*/}"

  # Flat naming: owner_reponame.git  (avoids subdirectory creation)
  MIRROR_PATH="${BACKUP_DIR}/${OWNER}_${NAME}.git"

  # HTTPS clone URL — authenticated via the gh credential helper
  CLONE_URL="https://github.com/${REPO_FULL}.git"

  if [[ -d "${MIRROR_PATH}" ]]; then
    # ── Update existing mirror ─────────────────────────────────────────
    # `remote update --prune` fetches all remotes and removes refs that
    # no longer exist upstream (deleted branches, tags, etc.)
    log "  [UPDATE] ${REPO_FULL}  →  ${MIRROR_PATH}"
    if git -C "${MIRROR_PATH}" remote update --prune >>"${LOG_FILE}" 2>&1; then
      log "           ✓ Updated"
      (( SUCCESS++ ))
    else
      log "           ✗ Update FAILED (see above for details)"
      (( FAIL++ )) || true   # `|| true` keeps set -e from firing on arithmetic
    fi
  else
    # ── Clone new mirror ───────────────────────────────────────────────
    # --mirror creates a bare repo and sets up refspecs to mirror all refs
    # (branches, tags, notes, etc.) — unlike a regular bare clone.
    log "  [CLONE]  ${REPO_FULL}  →  ${MIRROR_PATH}"
    if git clone --mirror "${CLONE_URL}" "${MIRROR_PATH}" >>"${LOG_FILE}" 2>&1; then
      log "           ✓ Cloned"
      (( SUCCESS++ ))
    else
      log "           ✗ Clone FAILED (see above for details)"
      (( FAIL++ )) || true
    fi
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────
log "════════════════════════════════════════════════════════"
log "Backup finished — success: ${SUCCESS}, failed: ${FAIL}"
log "════════════════════════════════════════════════════════"

log "BACKUP_SUMMARY upstream=${TOTAL} mirrored=${SUCCESS} failed=${FAIL}"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
