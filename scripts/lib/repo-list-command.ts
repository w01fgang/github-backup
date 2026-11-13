/**
 * scripts/lib/repo-list-command.ts
 *
 * The droplet-side command that lists the full names of a source's repos for
 * phase-7 target discovery. `gh api` returns one page of 100 repos; with
 * `--paginate` it follows every page, so a repo past the first 100 can be
 * chosen as the target.
 */

export function repoListCommand(
  envFile: string,
  endpointLib: string,
  sourceName: string,
  accountType: string
): string {
  return (
    `set -a; source "${envFile}"; set +a; ` +
    `source "${endpointLib}"; ` +
    `gh api --paginate "$(resolve_repo_endpoint ${sourceName} ${accountType})" --jq ".[].full_name"`
  );
}
