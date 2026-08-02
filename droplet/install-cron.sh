#!/usr/bin/env bash
# droplet/install-cron.sh
#
# Installs (or replaces) the cron job for github-backup.sh.
# Safe to run multiple times — removes any previous github-backup entry
# before adding the new one.
#
# Reads CRON_SCHEDULE from backup.env if present, or uses the default.
# Default schedule: 30 3 * * *  (03:30 UTC every day)
#
# The installed cron line explicitly sets HOME and PATH so that the minimal
# cron environment does not break gh or git lookups.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
ENV_FILE="${BACKUP_DIR}/backup.env"

# Load config (provides CRON_SCHEDULE if set)
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

# Default schedule: daily at 03:30 UTC
CRON_SCHEDULE="${CRON_SCHEDULE:-30 3 * * *}"

BACKUP_SCRIPT="${BACKUP_DIR}/github-backup.sh"
LOG_FILE="/var/log/github-backup.log"

# Unique marker comment so we can find and replace this entry on re-runs
CRON_MARKER="# github-backup-managed"

# ── Build the cron line ───────────────────────────────────────────────────
# We embed HOME and PATH inline so the cron entry is fully self-contained.
# `gh auth git-credential` (used by git for HTTPS auth) reads the gh config
# from $HOME/.config/gh/, so HOME must be correct.
#
# stdout goes to /dev/null, NOT to the log: github-backup.sh and
# sync-one-repo.sh already append every line they emit to ${LOG_FILE}
# themselves (`log()` tees, git output is redirected). Appending stdout here
# too wrote every cron-run line to the log twice. stderr is still captured —
# it is the only channel carrying unexpected diagnostics (`unbound variable`,
# `command not found`) that no writer routes to the log on its own.
CRON_LINE="${CRON_SCHEDULE} HOME=/root PATH=/usr/local/bin:/usr/bin:/bin ${BACKUP_SCRIPT} >/dev/null 2>>${LOG_FILE} ${CRON_MARKER}"

echo "  Schedule : ${CRON_SCHEDULE}"
echo "  Script   : ${BACKUP_SCRIPT}"
echo "  Log      : ${LOG_FILE}"

# ── Install / replace the crontab entry ──────────────────────────────────
# Get existing crontab for root (empty string if none)
EXISTING_CRONTAB=$(crontab -l 2>/dev/null || true)

# Remove any lines that contain our marker (previous installs)
CLEANED_CRONTAB=$(printf '%s\n' "${EXISTING_CRONTAB}" | grep -v "${CRON_MARKER}" || true)

# Write the new crontab (existing entries minus ours, plus the new line)
printf '%s\n%s\n' "${CLEANED_CRONTAB}" "${CRON_LINE}" | crontab -

echo "  ✓ Cron entry installed. Verify with: crontab -l"

# ── Ensure the cron daemon is running ────────────────────────────────────
systemctl enable cron  >/dev/null 2>&1 || true
systemctl start  cron  >/dev/null 2>&1 || true

if systemctl is-active --quiet cron; then
  echo "  ✓ cron daemon is running"
else
  echo "  ⚠ cron daemon may not be running — check: systemctl status cron" >&2
fi
