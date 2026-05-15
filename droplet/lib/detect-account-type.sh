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
