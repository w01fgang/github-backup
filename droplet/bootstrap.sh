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

# Phase 6: ensure each declared source has a mirror subdir before
# github-backup.sh runs. Idempotent — mkdir -p is a no-op if the dir
# exists. GITHUB_SOURCES is the authoritative multi-source list (D-04);
# fall back to GITHUB_USER_OR_ORG single-source during the upgrade window.
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

# ── Caddy (reverse proxy + Let's Encrypt) ────────────────────────────────
echo
if command -v caddy &>/dev/null; then
  echo "▸ Caddy already installed ($(caddy version 2>&1 | head -1)), skipping repo setup."
else
  echo "▸ Installing Caddy from the official apt repository…"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg

  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null

  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy

  echo "  ✓ Caddy installed: $(caddy version 2>&1 | head -1)"
fi

# ── Node.js (webhook listener runtime; built-in modules only) ────────────
echo
if command -v node &>/dev/null; then
  echo "▸ Node.js already installed ($(node --version)), skipping."
else
  echo "▸ Installing Node.js (Ubuntu default repo — listener uses only built-in modules)…"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  echo "  ✓ Node.js installed: $(node --version)"
fi

# ── Backup directory ──────────────────────────────────────────────────────
echo
echo "▸ Ensuring backup directory exists: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"
# Owner-only access — this directory will hold mirror repos and the env file
chmod 700 "${BACKUP_DIR}"

# ── State directory for run summaries (read by github-backup-status.sh / npm run status) ─
STATE_DIR="/var/lib/github-backup"
echo "▸ Ensuring state directory exists: ${STATE_DIR}"
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"
echo "  ✓ State directory ready (mode 700, root)"

# ── Mark scripts executable ───────────────────────────────────────────────
echo "▸ Setting script permissions…"
chmod +x "${BACKUP_DIR}/github-backup.sh"
chmod +x "${BACKUP_DIR}/install-cron.sh"
chmod +x "${BACKUP_DIR}/sync-one-repo.sh"
# Phase 6: shared helpers under lib/. github-backup.sh sources them.
if [[ -d "${BACKUP_DIR}/lib" ]]; then
  chmod +x "${BACKUP_DIR}/lib"/*.sh
fi
echo "  ✓ Scripts are executable"

# ── GitHub CLI authentication ─────────────────────────────────────────────
# gh auth login stores the token in /root/.config/gh/hosts.yml.
# The token is also re-exported at runtime by github-backup.sh (from backup.env),
# so backups continue to work even if the stored token needs refreshing.
echo
echo "▸ Authenticating gh CLI…"
# gh auth login --with-token refuses (exit 1) when GITHUB_TOKEN is already
# exported, because the env var takes precedence and login would be a no-op.
# Capture the token first, then run the login inside a subshell that clears
# the env var, so the token is stored in /root/.config/gh/hosts.yml.
_GH_LOGIN_TOKEN="${GITHUB_TOKEN}"
( unset GITHUB_TOKEN; printf '%s' "${_GH_LOGIN_TOKEN}" | gh auth login --with-token )
unset _GH_LOGIN_TOKEN
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

# ── Webhook listener (Phase 3) ────────────────────────────────────────────
echo
echo "▸ Installing webhook listener (Phase 3)…"

# Defensive: confirm the three uploaded files are present.
for f in webhook-listener.js Caddyfile.template github-backup-webhook.service; do
  if [[ ! -f "${BACKUP_DIR}/${f}" ]]; then
    echo "ERROR: ${BACKUP_DIR}/${f} not found. Did bootstrap-droplet.ts upload it?" >&2
    echo "       (See scripts/bootstrap-droplet.ts — the uploader must include non-.sh files for Phase 3.)" >&2
    exit 1
  fi
done

# Validate WEBHOOK_HOSTNAME is set + not the placeholder.
: "${WEBHOOK_HOSTNAME:?WEBHOOK_HOSTNAME must be set in ${ENV_FILE} (config.json field webhookHostname)}"
if [[ "${WEBHOOK_HOSTNAME}" == "__WEBHOOK_HOSTNAME__" ]]; then
  echo "ERROR: WEBHOOK_HOSTNAME equals the template placeholder. Set webhookHostname in config.json." >&2
  exit 1
fi

# Substitute hostname into Caddyfile (overwrite OK — droplet-managed).
echo "  → Writing /etc/caddy/Caddyfile (hostname=${WEBHOOK_HOSTNAME})"
sed "s|__WEBHOOK_HOSTNAME__|${WEBHOOK_HOSTNAME}|g" \
  "${BACKUP_DIR}/Caddyfile.template" > /etc/caddy/Caddyfile

# Install systemd unit (overwrite OK — droplet-managed).
echo "  → Installing /etc/systemd/system/github-backup-webhook.service"
cp "${BACKUP_DIR}/github-backup-webhook.service" /etc/systemd/system/github-backup-webhook.service

# Reload + enable + start (idempotent).
systemctl daemon-reload
systemctl enable --now github-backup-webhook
echo "  ✓ github-backup-webhook.service: $(systemctl is-active github-backup-webhook)"

# Reload Caddy (graceful — picks up the new Caddyfile).
systemctl reload caddy || systemctl restart caddy
echo "  ✓ caddy reloaded with new Caddyfile"

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
