/**
 * scripts/lib/mirror-size.ts
 *
 * The droplet-side size query of the backup directory. droplet/github-backup-status.sh
 * reports `du -sbD`; the phase-2 verifier measures the same way, so the two
 * numbers stay comparable when the backup directory is a symlink to a backup
 * volume. `-D` dereferences the starting path only.
 */

export function mirrorSizeCommand(backupDir: string): string {
  return `du -sbD ${backupDir} | awk "{print \\$1}"`;
}
