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

/** Parses the output of `logSizeCommand`; unreadable output is offset 0. */
export function parseLogOffset(output: string): number {
  return parseInt(output.trim(), 10) || 0;
}
