import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  logSinceCommand,
  summariesSinceCommand,
  logSizeCommand,
  parseLogOffset,
} from "../scripts/lib/log-window";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-window-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function bash(cmd: string): string {
  return execFileSync("bash", ["-c", cmd], { encoding: "utf8" });
}

function logWithRepoLines(repos: number): string {
  const lines = ["[2026-01-01 00:00:00] old run BACKUP_SOURCE_SUMMARY source=old"];
  for (let i = 0; i < repos; i++) lines.push(`[2026-01-02 00:00:00] repo ${i} line`);
  return lines.join("\n") + "\n";
}

test("reads the first source summary of a run that wrote 2000 lines after the baseline", () => {
  const log = path.join(dir, "big.log");
  fs.writeFileSync(log, logWithRepoLines(10));
  const offset = parseLogOffset(bash(logSizeCommand(log)));
  const run =
    "[2026-01-02 01:00:00] BACKUP_SOURCE_SUMMARY source=first upstream=1 mirrored=1 failed=0\n" +
    Array.from({ length: 2000 }, (_, i) => `[2026-01-02 01:00:01] repo ${i}\n`).join("");
  fs.appendFileSync(log, run);
  const since = bash(logSinceCommand(log, offset));
  assert.equal(since, run);
  assert.match(since, /source=first/);
  assert.doesNotMatch(since, /source=old/);
  assert.ok(!bash(`tail -n 500 ${log}`).includes("source=first"));
});

test("treats a missing log as offset 0", () => {
  const log = path.join(dir, "missing.log");
  assert.equal(parseLogOffset(bash(logSizeCommand(log))), 0);
  fs.writeFileSync(log, "first line\n");
  assert.equal(bash(logSinceCommand(log, 0)), "first line\n");
});

test("returns nothing when the log has not grown since the baseline", () => {
  const log = path.join(dir, "same.log");
  fs.writeFileSync(log, "abc\n");
  const offset = parseLogOffset(bash(logSizeCommand(log)));
  assert.equal(bash(logSinceCommand(log, offset)), "");
});

test("parseLogOffset maps unreadable output to 0", () => {
  assert.equal(parseLogOffset("  1234\n"), 1234);
  assert.equal(parseLogOffset(""), 0);
  assert.equal(parseLogOffset("garbage"), 0);
});

test("the summary read returns only the summary lines of a run, so a large run stays under the execSync buffer", () => {
  const log = path.join(dir, "summaries.log");
  fs.writeFileSync(log, "[2026-01-01 00:00:00] BACKUP_SUMMARY upstream=9 mirrored=9 failed=0\n");
  const offset = parseLogOffset(bash(logSizeCommand(log)));
  const first = "[2026-01-02 01:00:00]   BACKUP_SOURCE_SUMMARY source=first upstream=1 mirrored=1 failed=0\n";
  const last = "[2026-01-02 01:09:00] BACKUP_SUMMARY upstream=1 mirrored=1 failed=0\n";
  const noise = Array.from({ length: 20000 }, (_, i) => `[2026-01-02 01:00:01] remote: Counting objects ${i} BACKUP_SUMMARY-like noise\n`).join("");
  fs.appendFileSync(log, first + noise + last);
  assert.equal(bash(summariesSinceCommand(log, offset)), first + last);
});

test("the summary read prints nothing and succeeds when the run wrote no summary", () => {
  const log = path.join(dir, "nosummary.log");
  fs.writeFileSync(log, "[2026-01-02 01:00:00] repo line\n");
  assert.equal(bash(summariesSinceCommand(log, 0)), "");
});

test("the summary read returns summary lines from a window that holds a NUL byte", () => {
  const log = path.join(dir, "binary.log");
  const summary = "[2026-01-02 01:09:00] BACKUP_SUMMARY upstream=1 mirrored=1 failed=0\n";
  fs.writeFileSync(log, Buffer.concat([Buffer.from("[2026-01-02 01:00:00] remote: \u0000\xff bytes\n", "latin1"), Buffer.from(summary)]));
  assert.equal(bash(summariesSinceCommand(log, 0)), summary);
});
