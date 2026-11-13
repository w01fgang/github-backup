/**
 * scripts/lib/log-window.ts
 *
 * Shell commands that read only the part of a droplet log written after a
 * baseline. A run writes several lines per repo, so a fixed `tail -n` window
 * loses the early lines of a run on a large account. A byte offset taken
 * before the run bounds the read to exactly that run.
 */

/** Prints the log size in bytes; prints 0 when the log does not exist. */
export function logSizeCommand(logPath: string): string {
  return `(wc -c < ${logPath}) 2>/dev/null || echo 0`;
}

/** Prints every byte of the log after the first `offset` bytes. */
export function logSinceCommand(logPath: string, offset: number): string {
  return `tail -c +$((${offset} + 1)) ${logPath}`;
}

/**
 * Prints only the BACKUP_SUMMARY and BACKUP_SOURCE_SUMMARY lines of the log
 * after the first `offset` bytes. The filter runs on the droplet, so the
 * output stays small for a run of any size (execSync keeps at most 1 MiB).
 * No match prints nothing and exits 0.
 */
export function summariesSinceCommand(logPath: string, offset: number): string {
  return `${logSinceCommand(logPath, offset)} | grep -a -E "BACKUP_(SOURCE_)?SUMMARY " || true`;
}

/** Parses the output of `logSizeCommand`; unreadable output is offset 0. */
export function parseLogOffset(output: string): number {
  return parseInt(output.trim(), 10) || 0;
}
