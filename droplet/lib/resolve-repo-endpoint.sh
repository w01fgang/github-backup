#!/usr/bin/env bash
# droplet/lib/resolve-repo-endpoint.sh
#
# Canonical resolution of the `gh api` endpoint that lists a source's repos.
# Sourced (not executed) by github-backup.sh; mirrored in TypeScript by
# scripts/lib/repo-endpoint.ts so cron, webhook registration, and the phase
# verifiers all list the same repo set.
#
# `/users/<login>/repos` returns PUBLIC repositories only — GitHub applies
# that restriction even when the token belongs to <login>. A user source
# therefore needs `/user/repos?affiliation=owner`, the only listing endpoint
# that includes the authenticated user's private repositories. Organisation
# sources keep `/orgs/<org>/repos?type=all`, which already honours token
# visibility.
#
# Portability: bash 3.2 (macOS /bin/bash runs the UAT runner) — no `${v,,}`.

# resolve_repo_endpoint <github-slug> <account-type>
# Echoes the endpoint path (query string included). Never fails: an
# unreachable `gh api /user` falls back to the public-only user endpoint,
# matching pre-existing behaviour rather than aborting the caller's `set -e`.
resolve_repo_endpoint() {
  local slug="$1"
  local account_type="$2"

  if [ "${account_type}" = "Organization" ]; then
    printf '/orgs/%s/repos?type=all&per_page=100\n' "${slug}"
    return 0
  fi

  local me
  me=$(gh api /user --jq '.login' 2>/dev/null) || me=""

  if [ -n "${me}" ] && \
     [ "$(printf '%s' "${me}" | tr '[:upper:]' '[:lower:]')" = \
       "$(printf '%s' "${slug}" | tr '[:upper:]' '[:lower:]')" ]; then
    printf '/user/repos?affiliation=owner&per_page=100\n'
  else
    printf '/users/%s/repos?type=all&per_page=100\n' "${slug}"
  fi
}
