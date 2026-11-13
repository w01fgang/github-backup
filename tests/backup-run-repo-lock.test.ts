import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { backupRunSkip, runBackup, syncStub, type BackupRun } from "./helpers/backup-run";

const ROUTES = [
  { match: "api /users/good --jq", stdout: "User\n" },
  { match: "api /user --jq", stdout: "someone-else\n" },
  { match: "/users/good/repos", stdout: "good/r1\n" },
];

const runWithSync = (body: string, mirrorExists = false): BackupRun =>
  runBackup(["good"], ROUTES, (backupDir) => {
    fs.writeFileSync(path.join(backupDir, "sync-one-repo.sh"), syncStub(body), { mode: 0o755 });
    if (mirrorExists) fs.mkdirSync(path.join(backupDir, "good", "good_r1.git"), { recursive: true });
  });

const counts = (r: BackupRun) => ({ success: r.lastRun.success, fail: r.lastRun.fail, action: r.lastRun.repos[0].action });

test("the cron run gives the helper a lock wait, so a held per-repo lock delays the sync and does not skip it", { skip: backupRunSkip }, () => {
  const r = runWithSync('echo "stub wait=${LOCK_WAIT_SECONDS_REPO:-unset}" >> "$LOG_FILE"; result "$1" "$2" "$3" update');
  assert.match(r.log, /^stub wait=600$/m);
});

test("the row takes the action that the helper reports, since the mirror state can change during the lock wait", { skip: backupRunSkip }, () => {
  const r = runWithSync('result "$1" "$2" "$3" clone', true);
  assert.deepEqual(counts(r), { success: 1, fail: 0, action: "clone" });
});

test("a helper that exits 0 with no result line counts as failed, since no sync ran for that repo", { skip: backupRunSkip }, () => {
  const r = runWithSync("exit 0", true);
  assert.equal(r.status, 1);
  assert.deepEqual(counts(r), { success: 0, fail: 1, action: "fail" });
});

test("a lock wait that times out counts as failed", { skip: backupRunSkip }, () => {
  const r = runWithSync("exit 75");
  assert.equal(r.status, 1);
  assert.deepEqual(counts(r), { success: 0, fail: 1, action: "fail" });
});

test("a helper that reports a fail action and exits 0 counts as failed", { skip: backupRunSkip }, () => {
  const r = runWithSync('result "$1" "$2" "$3" fail');
  assert.deepEqual(counts(r), { success: 0, fail: 1, action: "fail" });
});
