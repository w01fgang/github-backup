#!/usr/bin/env bash
# droplet/lib/filter-repos.sh
#
# Allow/deny glob filter for REPOS-01. Reads repo full_names from stdin
# (one per line), writes matching ones to stdout, drops the rest.
#
# Sourced (not executed). The function uses bash's `case` glob matching
# (no extglob, no shopt magic) so behavior matches across bash 4/5.
# Glob meta is the standard set: * ? [..].
#
# ROADMAP SC#4: deny wins on allow/deny conflict.
# ROADMAP SC#5: empty allow list ⇒ all upstream repos pass the allow stage.

# _matches_any <pattern_list_space_separated> <full_name>
# Returns 0 if any pattern matches the full_name, 1 otherwise.
# Patterns may be either bare repo name (no slash → matched against the
# basename after owner/) OR owner/name glob (slash → matched against
# the full_name verbatim). Operators commonly write either; supporting
# both is friendlier than forcing one shape.
_matches_any() {
  local pats="$1"
  local full="$2"
  local name="${full##*/}"
  local p
  for p in ${pats}; do
    [[ -z "${p}" ]] && continue
    if [[ "${p}" == */* ]]; then
      # Pattern includes a slash → match full_name
      # shellcheck disable=SC2053
      [[ "${full}" == ${p} ]] && return 0
    else
      # Bare pattern → match basename only
      # shellcheck disable=SC2053
      [[ "${name}" == ${p} ]] && return 0
    fi
  done
  return 1
}

# filter_repos <source> <allow_globs> <deny_globs>
# stdin: one full_name per line; stdout: passing full_names.
filter_repos() {
  local source="$1"
  local allow="$2"
  local deny="$3"
  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    # 1. Deny wins (ROADMAP SC#4): if any deny pattern matches, drop.
    if [[ -n "${deny}" ]] && _matches_any "${deny}" "${line}"; then
      continue
    fi
    # 2. Empty allow ⇒ pass-through (ROADMAP SC#5).
    if [[ -z "${allow}" ]]; then
      printf '%s\n' "${line}"
      continue
    fi
    # 3. Non-empty allow: must match at least one allow glob.
    if _matches_any "${allow}" "${line}"; then
      printf '%s\n' "${line}"
    fi
  done
}
