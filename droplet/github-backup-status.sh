#!/usr/bin/env bash
# droplet/github-backup-status.sh
#
# Phase 2 droplet-side status binary (D-01).
#
# Reads /var/lib/github-backup/last-run.json (written by github-backup.sh),
# parses CRON_SCHEDULE from /opt/github-backups/backup.env, measures disk
# usage with df+du, and emits either a human-readable text report (default)
# or a single JSON object (--json) suitable for piping into jq.
#
# Decisions wired in this binary:
#   D-01 — droplet-side surface
#   D-04 — /var/log/github-backup.log fallback when last-run.json missing
#   D-06 — counts header + failed-repo names always; full list behind --verbose
#   D-07 — per-repo line format: <glyph> <action> <owner>/<repo>
#   D-08 — df + du blocks always shown
#   D-09 — --json emits a single object
#   D-10 — staleness lookup table over CRON_SCHEDULE
#   D-11 — NEVER RAN when state file missing AND log has no summary
#   D-13 — exit codes 0/1/2/3 (clean / failed / stale / never-ran)
#
# Usage:
#   github-backup-status.sh           # default text report
#   github-backup-status.sh -v        # text report + per-repo + per-mirror du
#   github-backup-status.sh --json    # single JSON object
#   github-backup-status.sh -h        # help

set -euo pipefail

# ── Flags ────────────────────────────────────────────────────────────────
FORMAT="text"
VERBOSE=0

usage() {
  cat <<'EOF'
github-backup-status — report state of the most recent backup run.

USAGE:
  github-backup-status.sh [OPTIONS]

OPTIONS:
  --json             Emit a single JSON object instead of the text report.
  -v, --verbose      Include per-repo detail and per-mirror disk usage.
  -h, --help         Show this help and exit 0.

EXIT CODES:
  0  last run succeeded and is not stale
  1  last run had failures (fail > 0 or exit_code != 0)
  2  last run is stale (older than 2× CRON_SCHEDULE interval)
  3  never ran / no recognizable summary in state file or log
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) FORMAT="json"; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done

# ── Paths ─────────────────────────────────────────────────────────────────
STATE_FILE="/var/lib/github-backup/last-run.json"
LOG_FILE="/var/log/github-backup.log"
BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
ENV_FILE="${BACKUP_DIR}/backup.env"

# ── Source backup.env for CRON_SCHEDULE (T-02-05 mitigation) ──────────────
# We only need CRON_SCHEDULE; never reference GITHUB_TOKEN. Unset it
# immediately after sourcing as defense in depth — keeps the secret out
# of `ps e` / accidental log lines while the binary is running.
if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  unset GITHUB_TOKEN || true
fi
CRON_SCHEDULE="${CRON_SCHEDULE:-30 3 * * *}"
CRON_DEFAULTED=0
if [[ -z "${CRON_SCHEDULE_SOURCED:-${CRON_SCHEDULE:-}}" ]]; then
  CRON_DEFAULTED=1
fi

# ── Helpers ──────────────────────────────────────────────────────────────
human_bytes() {
  awk -v b="$1" 'BEGIN {
    split("B K M G T P", u);
    for (i=1; b>=1024 && i<6; i++) b/=1024;
    printf "%.0f%s", b, u[i]
  }'
}

human_seconds() {
  awk -v s="$1" 'BEGIN {
    s = int(s)
    if (s < 60) { printf "%ds", s; exit }
    m = int(s / 60); rs = s % 60
    if (m < 60) {
      if (rs == 0) printf "%dm", m
      else printf "%dm %ds", m, rs
      exit
    }
    h = int(m / 60); rm = m % 60
    if (h < 24) {
      if (rm == 0) printf "%dh", h
      else printf "%dh %dm", h, rm
      exit
    }
    d = int(h / 24); rh = h % 24
    if (rh == 0) printf "%dd", d
    else printf "%dd %dh", d, rh
  }'
}

# Globals populated by data collectors
STATE_SRC="none"
STARTED_AT=""
FINISHED_AT=""
EXIT_CODE=0
TOTAL=0
SUCCESS_COUNT=0
FAIL_COUNT=0
REPOS_JSON="[]"

DISK_FS=""
DISK_SIZE_B=0
DISK_USED_B=0
DISK_PERCENT=0
MIRROR_B=0

STALE_STATE="NEVER_RAN"
EXPECTED_INTERVAL_S=0
AGE_S=0
THRESHOLD_S=0
PARSER_WARNING=0

# ── Data collectors ──────────────────────────────────────────────────────
load_state() {
  if [[ -r "$STATE_FILE" ]] && jq -e . "$STATE_FILE" >/dev/null 2>&1; then
    STATE_SRC="json"
    STARTED_AT=$(jq -r '.started_at' "$STATE_FILE")
    FINISHED_AT=$(jq -r '.finished_at' "$STATE_FILE")
    EXIT_CODE=$(jq -r '.exit_code' "$STATE_FILE")
    TOTAL=$(jq -r '.total' "$STATE_FILE")
    SUCCESS_COUNT=$(jq -r '.success' "$STATE_FILE")
    FAIL_COUNT=$(jq -r '.fail' "$STATE_FILE")
    REPOS_JSON=$(jq -c '.repos' "$STATE_FILE")
    return 0
  fi

  # Log fallback (D-04). Scan backwards for the most recent
  # "Backup finished — success: N, failed: M" line.
  if [[ -r "$LOG_FILE" ]]; then
    local line
    line=$(tac "$LOG_FILE" 2>/dev/null | grep -m1 -E '^\[[0-9-]+ [0-9:]+\] Backup finished — success: [0-9]+, failed: [0-9]+$' || true)
    if [[ -n "$line" ]]; then
      if [[ $line =~ ^\[([0-9-]+\ [0-9:]+)\]\ Backup\ finished\ —\ success:\ ([0-9]+),\ failed:\ ([0-9]+)$ ]]; then
        local ts="${BASH_REMATCH[1]}"
        SUCCESS_COUNT="${BASH_REMATCH[2]}"
        FAIL_COUNT="${BASH_REMATCH[3]}"
        TOTAL=$(( SUCCESS_COUNT + FAIL_COUNT ))
        if (( FAIL_COUNT > 0 )); then EXIT_CODE=1; else EXIT_CODE=0; fi
        STARTED_AT=""
        FINISHED_AT=$(date -u -d "$ts" -Iseconds 2>/dev/null || date -u -d "$ts" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$ts")
        REPOS_JSON="[]"
        STATE_SRC="log"
        return 0
      fi
    fi
  fi

  STATE_SRC="none"
}

compute_disk() {
  if [[ -d "$BACKUP_DIR" ]]; then
    read -r DISK_FS DISK_SIZE_B DISK_USED_B DISK_PERCENT < <(
      df -P -B1 "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $1, $2, $3, int($3*100/$2)}'
    ) || true
    MIRROR_B=$(du -sb "$BACKUP_DIR" 2>/dev/null | awk '{print $1}')
    MIRROR_B=${MIRROR_B:-0}
  else
    DISK_FS=""
    DISK_SIZE_B=0
    DISK_USED_B=0
    DISK_PERCENT=0
    MIRROR_B=0
  fi
}

# Lookup table for CRON_SCHEDULE → expected interval seconds (D-10).
# Returns interval on stdout; sets PARSER_WARNING=1 on no-match.
expected_interval() {
  local sched="$1"
  case "$sched" in
    "@hourly")                       echo 3600; return ;;
    "@daily"|"@midnight")            echo 86400; return ;;
    "@weekly")                       echo 604800; return ;;
  esac
  # */N * * * *
  if [[ "$sched" =~ ^\*/([0-9]+)\ \*\ \*\ \*\ \*$ ]]; then
    echo $(( BASH_REMATCH[1] * 60 ))
    return
  fi
  # 0 */N * * *
  if [[ "$sched" =~ ^0\ \*/([0-9]+)\ \*\ \*\ \*$ ]]; then
    echo $(( BASH_REMATCH[1] * 3600 ))
    return
  fi
  # M H * * D — single weekday literal → weekly
  if [[ "$sched" =~ ^[0-9]+\ [0-9]+\ \*\ \*\ [0-9]+$ ]]; then
    echo 604800
    return
  fi
  # M H * * * — daily literal
  if [[ "$sched" =~ ^[0-9]+\ [0-9]+\ \*\ \*\ \*$ ]]; then
    echo 86400
    return
  fi
  # No match → assume daily, flag warning
  PARSER_WARNING=1
  echo 86400
}

compute_staleness() {
  if [[ "$STATE_SRC" == "none" ]]; then
    STALE_STATE="NEVER_RAN"
    EXPECTED_INTERVAL_S=0
    AGE_S=0
    THRESHOLD_S=0
    return
  fi

  EXPECTED_INTERVAL_S=$(expected_interval "$CRON_SCHEDULE")
  THRESHOLD_S=$(( 2 * EXPECTED_INTERVAL_S ))

  local now_s finished_s
  now_s=$(date -u +%s)
  finished_s=$(date -u -d "$FINISHED_AT" +%s 2>/dev/null || echo 0)
  if [[ "$finished_s" -gt 0 ]]; then
    AGE_S=$(( now_s - finished_s ))
  else
    AGE_S=0
  fi

  if (( AGE_S > THRESHOLD_S )); then
    STALE_STATE="STALE"
  else
    STALE_STATE="OK"
  fi
}

final_exit_code() {
  if [[ "$STALE_STATE" == "NEVER_RAN" ]]; then echo 3; return; fi
  if [[ "$STALE_STATE" == "STALE" ]]; then echo 2; return; fi
  if [[ "$EXIT_CODE" -ne 0 || "$FAIL_COUNT" -gt 0 ]]; then echo 1; return; fi
  echo 0
}

# ── Output ───────────────────────────────────────────────────────────────
emit_text() {
  if [[ "$STALE_STATE" == "NEVER_RAN" ]]; then
    echo "✗ NEVER RAN — no /var/lib/github-backup/last-run.json and no recognizable summary in /var/log/github-backup.log"
    return
  fi

  local human_age human_interval human_size human_used human_mirror
  human_age=$(human_seconds "$AGE_S")
  human_interval=$(human_seconds "$EXPECTED_INTERVAL_S")
  human_size=$(human_bytes "$DISK_SIZE_B")
  human_used=$(human_bytes "$DISK_USED_B")
  human_mirror=$(human_bytes "$MIRROR_B")

  if [[ "$STALE_STATE" == "STALE" ]]; then
    echo "⚠ STALE — last run ${human_age} ago, expected every ${human_interval}"
  fi

  echo "github-backup status — $(hostname)"
  echo "═══════════════════════════════════════════════"

  local finished_disp from_log_tag=""
  finished_disp=$(date -u -d "$FINISHED_AT" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || echo "$FINISHED_AT")
  if [[ -z "$STARTED_AT" ]]; then
    from_log_tag=" [from log]"
  fi
  printf 'Last run:          %s  (%s ago)%s\n' "$finished_disp" "$human_age" "$from_log_tag"
  printf 'Exit code:         %s\n' "$EXIT_CODE"
  printf 'Repos:             ✓ %s   ✗ %s   total %s\n' "$SUCCESS_COUNT" "$FAIL_COUNT" "$TOTAL"

  if (( FAIL_COUNT > 0 )); then
    echo "Failed repos:"
    if [[ "$REPOS_JSON" == "[]" ]]; then
      echo "  (per-repo detail unavailable — last-run.json missing; log fallback used)"
    else
      jq -r '.[] | select(.action == "fail") | "  ✗ fail  " + .name' <<<"$REPOS_JSON"
    fi
  fi

  printf 'Disk:              %s used / %s  (%s%%)\n' "$human_used" "$human_size" "$DISK_PERCENT"
  printf 'Mirror footprint:  %s  %s\n' "$human_mirror" "$BACKUP_DIR"
  local stale_line="${STALE_STATE} (cron every ${human_interval})"
  if (( PARSER_WARNING == 1 )); then
    stale_line+=" [warning: could not parse CRON_SCHEDULE '${CRON_SCHEDULE}', assumed daily]"
  fi
  printf 'Staleness:         %s\n' "$stale_line"

  if (( VERBOSE == 1 )) && [[ "$REPOS_JSON" != "[]" ]]; then
    echo
    echo "Per-repo detail:"
    jq -r '.[] | (if .action == "fail" then "  ✗ " else "  ✓ " end) + .action + " " + .name' <<<"$REPOS_JSON"
    if [[ -d "$BACKUP_DIR" ]]; then
      local mirror_count
      mirror_count=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name '*.git' 2>/dev/null | wc -l | tr -d ' ')
      if (( mirror_count > 0 )); then
        echo
        echo "Per-mirror disk usage:"
        local d
        for d in "$BACKUP_DIR"/*.git; do
          [[ -d "$d" ]] || continue
          local sz
          sz=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
          printf '  %s  %s\n' "$sz" "$(basename "$d")"
        done
      fi
    fi
  fi
}

emit_json() {
  jq -n \
    --arg state_src "$STATE_SRC" \
    --arg started "$STARTED_AT" \
    --arg finished "$FINISHED_AT" \
    --argjson exit "$EXIT_CODE" \
    --argjson total "$TOTAL" \
    --argjson ok "$SUCCESS_COUNT" \
    --argjson failed "$FAIL_COUNT" \
    --argjson repos "$REPOS_JSON" \
    --arg disk_fs "$DISK_FS" \
    --argjson disk_size "$DISK_SIZE_B" \
    --argjson disk_used "$DISK_USED_B" \
    --argjson disk_pct "$DISK_PERCENT" \
    --argjson mirror "$MIRROR_B" \
    --arg stale_state "$STALE_STATE" \
    --argjson expected "$EXPECTED_INTERVAL_S" \
    --argjson age "$AGE_S" \
    --argjson threshold "$THRESHOLD_S" \
    --argjson parser_warning "$PARSER_WARNING" \
    --argjson verbose "$VERBOSE" \
    --argjson exit_final "$(final_exit_code)" \
    '{
      last_run: (if $state_src == "none" then null else {
        source: $state_src, started_at: $started, finished_at: $finished,
        exit_code: $exit, total: $total, success: $ok, fail: $failed, repos: $repos
      } end),
      disk: { filesystem: $disk_fs, size_bytes: $disk_size, used_bytes: $disk_used,
              percent_used: $disk_pct, mirror_bytes: $mirror },
      staleness: { state: $stale_state, expected_interval_seconds: $expected,
                   last_run_age_seconds: $age, threshold_seconds: $threshold,
                   parser_warning: ($parser_warning == 1) },
      verbose: ($verbose == 1),
      exit_code: $exit_final
    }'
}

main() {
  load_state
  compute_disk
  compute_staleness
  if [[ "$FORMAT" == "json" ]]; then emit_json; else emit_text; fi
  exit "$(final_exit_code)"
}

main
