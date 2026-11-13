/**
 * The cron run names each mirror after the GitHub full_name of the repo,
 * for example Toprent-app_locale-editor.git. A slug in config.json can use
 * another letter case, for example toprent-app/locale-editor. A webhook push
 * with that case makes the listener clone a second mirror. These helpers read
 * the GitHub case on the droplet, so a verify script uses the same name as
 * the cron run.
 */

/** Remote command that prints the GitHub full_name of owner/repo. */
export function fullNameCommand(envFile: string, owner: string, repo: string): string {
  return `set -a; source ${envFile}; set +a; gh api repos/${owner}/${repo} --jq .full_name`;
}

/**
 * Returns the owner and repo in the case of `fullName`. Returns null when
 * `fullName` is not one "owner/repo" slug, or names a repo other than
 * owner/repo without regard to case.
 */
export function canonicalSlug(
  owner: string,
  repo: string,
  fullName: string
): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(fullName.trim());
  if (!m) return null;
  if (m[1].toLowerCase() !== owner.toLowerCase()) return null;
  if (m[2].toLowerCase() !== repo.toLowerCase()) return null;
  return { owner: m[1], repo: m[2] };
}
