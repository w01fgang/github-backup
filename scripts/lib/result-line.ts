export const REMOTE_LOG = "/var/log/github-backup.log";

const ereLiteral = (s: string): string => s.replace(/\./g, "\\.");

export function resultLineCommand(
  source: string,
  owner: string,
  repo: string,
  offset: number,
  logPath: string = REMOTE_LOG
): string {
  return (
    `tail -c +${offset + 1} ${logPath} | ` +
    `grep -E '^\\[.*\\] BACKUP_REPO_RESULT source=${ereLiteral(source)} owner=${ereLiteral(owner)} repo=${ereLiteral(repo)} action=(clone|update|fail)' | tail -1`
  );
}

/**
 * True when `logText` holds a BACKUP_REPO_RESULT line that `source` wrote for
 * `owner`/`repo`. The `source=`, `owner=` and `repo=` fields match as whole
 * tokens and case-sensitively. A line that another source wrote for the same
 * repo does not match.
 */
export function resultLineNames(
  logText: string,
  source: string,
  owner: string,
  repo: string
): boolean {
  return logText.split("\n").some((line) => {
    const tokens = line.split(/\s+/);
    return (
      tokens.includes("BACKUP_REPO_RESULT") &&
      tokens.includes(`source=${source}`) &&
      tokens.includes(`owner=${owner}`) &&
      tokens.includes(`repo=${repo}`)
    );
  });
}
