/**
 * scripts/lib/uat-stale-log.ts
 *
 * p04-02 reads the log that p04-01 writes. When a UAT run includes p04-01,
 * the old log is removed first, so p04-02 reads only this run's p04-01
 * result. A run of p04-02 alone reads the log of the last p04-01 run.
 */

import * as fs from "fs";

export const P04_01_LOG = "/tmp/uat-p04-01.log";

export function removeStaleP0401Log(
  scenarios: ReadonlyArray<{ id: string }>,
  logPath: string = P04_01_LOG
): void {
  if (!scenarios.some((s) => s.id === "p04-01")) return;
  try {
    fs.rmSync(logPath, { force: true });
  } catch (e) {
    console.log(`⚠  cannot remove ${logPath}: ${(e as Error).message}`);
  }
}
