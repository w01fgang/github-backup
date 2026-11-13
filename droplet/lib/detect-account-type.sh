#!/usr/bin/env bash
# droplet/lib/detect-account-type.sh
#
# Shared helper extracted from github-backup.sh per Phase 6 D-05
# (resolves Phase 1 plan-checker MED #4 — eliminates the duplicated
# gh api probe between github-backup.sh and former smoke-test.ts step 8).
#
# Sourced (not executed) by github-backup.sh. The function prints the
# account type on stdout and a gh error on stderr; callers capture the type
# via $(detect_account_type "$slug") and check the exit status.
#
# Portability: bash 3.2 (macOS /bin/bash runs the UAT runner).

# detect_account_type <github-slug>
# Echoes "User" or "Organization" and returns 0. An unknown login (gh exits
# with "HTTP 404" on stderr) also echoes "User". Any other gh failure, such
# as a network error or an HTTP 5xx, echoes nothing, copies the gh error to
# stderr and returns 1: a guess of "User" for an organisation lists its
# public repos only.
detect_account_type() {
  local slug="$1"
  local out err_file err rc=0
  err_file=$(mktemp) || return 1
  out=$(gh api "/users/${slug}" --jq '.type' 2>"${err_file}") || rc=$?
  err=$(cat "${err_file}")
  rm -f "${err_file}"
  if [ "${rc}" -eq 0 ]; then
    printf '%s\n' "${out}"
    return 0
  fi
  case "${err}" in
    *"HTTP 404"*) printf 'User\n'; return 0 ;;
  esac
  printf '%s\n' "${err}" >&2
  return 1
}
