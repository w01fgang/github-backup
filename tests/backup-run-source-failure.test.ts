import { test } from "node:test";
import assert from "node:assert/strict";
import { backupRunSkip, runBackup, type BackupRun } from "./helpers/backup-run";

const ROUTES = [
  { match: "api /users/good --jq", stdout: "User\n" },
  { match: "api /users/bad --jq", stdout: "User\n" },
  { match: "api /user --jq", stdout: "someone-else\n" },
  { match: "/users/good/repos", stdout: "good/r1\n" },
  { match: "/users/bad/repos", stderr: "gh: Bad Gateway (HTTP 502)\n", exit: 1 },
];

let cached: BackupRun | undefined;
const goodAndBadRun = (): BackupRun => (cached ??= runBackup(["good", "bad"], ROUTES));

test("a source whose repo list fails counts as one failed unit, so success + fail equals total", { skip: backupRunSkip }, () => {
  const r = goodAndBadRun();
  assert.equal(r.status, 1);
  assert.deepEqual(
    { total: r.lastRun.total, success: r.lastRun.success, fail: r.lastRun.fail },
    { total: 2, success: 1, fail: 1 }
  );
  assert.match(r.log, /BACKUP_SOURCE_SUMMARY source=bad upstream=1 mirrored=0 failed=1$/m);
  assert.match(r.log, /BACKUP_SUMMARY upstream=2 mirrored=1 failed=1$/m);
});

test("a failed source gets one repos[] row, so the status list of failed repos names it", { skip: backupRunSkip }, () => {
  const r = goodAndBadRun();
  assert.equal(r.lastRun.repos.length, r.lastRun.total);
  assert.deepEqual(
    r.lastRun.repos.filter((row) => row.action === "fail"),
    [{ source: "bad", name: "bad (repo list)", action: "fail", duration_ms: 0 }]
  );
});
