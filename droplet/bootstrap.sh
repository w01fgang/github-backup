#!/usr/bin/env bash
# droplet/bootstrap.sh
#
# Bootstraps the GitHub backup system on an Ubuntu droplet.
# Runs as root. Safe to run multiple times (idempotent).
#
# Expects backup.env to be present at ${BACKUP_DIR}/backup.env before
# this script is invoked. bootstrap-droplet.ts uploads it first.
#
# Steps:
#   1. Source backup.env (sets GITHUB_TOKEN, GITHUB_USER_OR_ORG, etc.)
#   2. apt update + upgrade
#   3. Install: git, jq, cron, curl, gpg, ca-certificates
#   4. Install gh CLI from the official GitHub apt repo
#   5. Authenticate gh CLI with the stored token
#   6. Configure git to use gh as a credential helper (HTTPS auth)
#   7. Ensure the backup log file exists
#   8. Run install-cron.sh

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
LOG_FILE="/var/log/github-backup.log"

echo "══════════════════════════════════════════════════════════"
echo "  GitHub Backup — bootstrap starting at $(date -Iseconds)"
echo "══════════════════════════════════════════════════════════"

# ── Load configuration ─────────────────────────────────────────────────────
ENV_FILE="${BACKUP_DIR}/backup.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found." >&2
  echo "       Did bootstrap-droplet.ts upload it before running this script?" >&2
  exit 1
fi

echo
echo "▸ Loading configuration from ${ENV_FILE}…"
# set -a exports every variable defined while active
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

# Lock down the env file — it contains the GitHub token
chmod 600 "${ENV_FILE}"
echo "  ✓ backup.env loaded and secured (mode 600)"

# ── System package updates ─────────────────────────────────────────────────
echo
echo "▸ Updating package lists…"
DEBIAN_FRONTEND=noninteractive apt-get update -qq

echo "▸ Upgrading installed packages…"
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

echo "▸ Installing base packages (git, jq, cron, curl, gpg, ca-certificates)…"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  git \
  jq \
  cron \
  curl \
  gpg \
  ca-certificates

echo "  ✓ Base packages installed"

# ── GitHub CLI ────────────────────────────────────────────────────────────
echo
if command -v gh &>/dev/null; then
  echo "▸ gh CLI already installed ($(gh --version 2>&1 | head -1)), skipping."
else
  echo "▸ Installing gh CLI from the official GitHub apt repository…"

  # Add the GitHub CLI GPG key
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg

  # Add the apt source
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list >/dev/null

  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh

  echo "  ✓ gh CLI installed: $(gh --version 2>&1 | head -1)"
fi

# ── Backup directory ──────────────────────────────────────────────────────
echo
echo "▸ Ensuring backup directory exists: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"
# Owner-only access — this directory will hold mirror repos and the env file
chmod 700 "${BACKUP_DIR}"

# ── Mark scripts executable ───────────────────────────────────────────────
echo "▸ Setting script permissions…"
chmod +x "${BACKUP_DIR}/github-backup.sh"
chmod +x "${BACKUP_DIR}/install-cron.sh"
echo "  ✓ Scripts are executable"

# ── GitHub CLI authentication ─────────────────────────────────────────────
# gh auth login stores the token in /root/.config/gh/hosts.yml.
# The token is also re-exported at runtime by github-backup.sh (from backup.env),
# so backups continue to work even if the stored token needs refreshing.
echo
echo "▸ Authenticating gh CLI…"
echo "${GITHUB_TOKEN}" | gh auth login --with-token
echo "  ✓ gh auth status:"
gh auth status 2>&1 | sed 's/^/    /'

# ── Configure git to use gh as HTTPS credential helper ───────────────────
# gh auth setup-git writes a [credential] section to /root/.gitconfig that
# calls `gh auth git-credential` — which in turn uses GITHUB_TOKEN or the
# stored token to answer git credential requests for github.com.
# This means `git clone https://github.com/...` will authenticate automatically.
echo
echo "▸ Configuring git credential helper (gh auth setup-git)…"
gh auth setup-git
# Prevent git from prompting interactively — fail fast instead
git config --global core.askPass ""
git config --global GIT_TERMINAL_PROMPT 0 2>/dev/null || true
echo "  ✓ git credential helper configured"

# ── Log file ─────────────────────────────────────────────────────────────
echo
echo "▸ Ensuring log file exists: ${LOG_FILE}"
touch "${LOG_FILE}"
chmod 640 "${LOG_FILE}"
echo "  ✓ Log file ready"

# ── Install cron job ──────────────────────────────────────────────────────
echo
echo "▸ Installing backup cron job…"
"${BACKUP_DIR}/install-cron.sh"

echo
echo "══════════════════════════════════════════════════════════"
echo "  Bootstrap complete at $(date -Iseconds)"
echo ""
echo "  Run a manual backup:"
echo "    ${BACKUP_DIR}/github-backup.sh"
echo ""
echo "  Check the log:"
echo "    tail -f ${LOG_FILE}"
echo "══════════════════════════════════════════════════════════"
