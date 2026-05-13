#!/usr/bin/env bash
# droplet/sync-one-repo.sh
#
# Mirror a single GitHub repo. Invoked by both cron (`github-backup.sh`)
# and the webhook listener (plan 03-02). One code path, two triggers.
#
# Args:   <source> <owner> <repo>
#           <source>  — at v1 always equals <owner>; Phase 6 (multi-source)
#                       will diverge.
#           <owner>   — GitHub user/org login.
#           <repo>    — GitHub repo name.
#
# Env:    GITHUB_TOKEN              required; sourced from backup.env if absent.
#         BACKUP_DIR                default /opt/github-backups.
#         LOG_FILE                  default /var/log/github-backup.log.
#         LOCK_WAIT_SECONDS_REPO    optional; when set, `flock -w N` blocks
#                                   for up to N seconds. Unset = `flock -n`
#                                   (non-blocking; another sync wins).
#
# Lock:   /var/lock/github-backup-<owner>_<repo>.lock on fd 8.
#         Per-repo only — global cron lock is the caller's responsibility.
#
# Output: Standard log lines via tee → ${LOG_FILE}, PLUS one terminating
#         per-repo result line for status-command consumption (D-15 step 4):
#           [<ts>] <RESULT_TAG> source=<s> owner=<o> repo=<r> \
#                              action=<clone|update|fail> duration_ms=<n>
#         (See the log() call near the bottom for the exact RESULT_TAG.)
#
# Exit:   0 on action=clone|update; non-zero on action=fail or arg/env errors.
#
set -euo pipefail

export HOME="/root"
export PATH="/usr/local/bin:/usr/bin:/bin"
export GIT_TERMINAL_PROMPT=0

# ── Arg parse ────────────────────────────────────────────────────────────────
if [[ $# -ne 3 ]]; then
  echo "usage: $0 <source> <owner> <repo>" >&2
  exit 2
fi
SOURCE="$1"; OWNER="$2"; REPO="$3"

ARG_RE='^[A-Za-z0-9._-]+$'
for v in "$SOURCE" "$OWNER" "$REPO"; do
  [[ "$v" =~ $ARG_RE ]] || { echo "ERROR: invalid arg shape: ${v}" >&2; exit 2; }
done

# ── Env ──────────────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
LOG_FILE="${LOG_FILE:-/var/log/github-backup.log}"
ENV_FILE="${BACKUP_DIR}/backup.env"

if [[ -z "${GITHUB_TOKEN:-}" && -f "${ENV_FILE}" ]]; then
  set -a; source "${ENV_FILE}"; set +a
fi
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (env or ${ENV_FILE})}"
export GITHUB_TOKEN

# ── Per-repo lock ────────────────────────────────────────────────────────────
LOCK_FILE="/var/lock/github-backup-${OWNER}_${REPO}.lock"
exec 8>"${LOCK_FILE}"
if [[ -n "${LOCK_WAIT_SECONDS_REPO:-}" ]]; then
  flock -w "${LOCK_WAIT_SECONDS_REPO}" 8 || {
    echo "ERROR: timed out waiting for ${LOCK_FILE}" >&2
    exit 75
  }
else
  flock -n 8 || {
    echo "ERROR: another sync holds ${LOCK_FILE}; skipping ${OWNER}/${REPO}" >&2
    exit 0  # not a failure — just deferred
  }
fi

# ── Log helper (mirrors github-backup.sh log() shape) ────────────────────────
log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "${ts}" "$*" | tee -a "${LOG_FILE}"
}

# ── Mirror dance ─────────────────────────────────────────────────────────────
MIRROR_PATH="${BACKUP_DIR}/${OWNER}_${REPO}.git"
CLONE_URL="https://github.com/${OWNER}/${REPO}.git"

start_ms=$(date +%s%3N)
ACTION="fail"
EXIT_CODE=1

if [[ -d "${MIRROR_PATH}" ]]; then
  log "  [UPDATE] ${OWNER}/${REPO}  →  ${MIRROR_PATH}"
  if git -C "${MIRROR_PATH}" remote update --prune >>"${LOG_FILE}" 2>&1; then
    log "           ✓ Updated"
    ACTION="update"
    EXIT_CODE=0
  else
    log "           ✗ Update FAILED (see above for details)"
  fi
else
  log "  [CLONE]  ${OWNER}/${REPO}  →  ${MIRROR_PATH}"
  if git clone --mirror "${CLONE_URL}" "${MIRROR_PATH}" >>"${LOG_FILE}" 2>&1; then
    log "           ✓ Cloned"
    ACTION="clone"
    EXIT_CODE=0
  else
    log "           ✗ Clone FAILED (see above for details)"
  fi
fi

end_ms=$(date +%s%3N)
duration_ms=$(( end_ms - start_ms ))

log "BACKUP_REPO_RESULT source=${SOURCE} owner=${OWNER} repo=${REPO} action=${ACTION} duration_ms=${duration_ms}"
exit "${EXIT_CODE}"
