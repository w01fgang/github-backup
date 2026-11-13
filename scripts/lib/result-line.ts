export const REMOTE_LOG = "/var/log/github-backup.log";

const ereLiteral = (s: string): string => s.replace(/\./g, "\\.");

export function resultLineCommand(
  owner: string,
  repo: string,
  offset: number,
  logPath: string = REMOTE_LOG
): string {
  return (
    `tail -c +${offset + 1} ${logPath} | ` +
    `grep -E '^\\[.*\\] BACKUP_REPO_RESULT source=${ereLiteral(owner)} owner=${ereLiteral(owner)} repo=${ereLiteral(repo)} action=(clone|update|fail)' | tail -1`
  );
}
