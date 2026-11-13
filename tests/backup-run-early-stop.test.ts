import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { backupRunSkip, runBackup, type BackupRun } from "./helpers/backup-run";

const STATUS_SCRIPT = path.join(__dirname, "..", "droplet", "github-backup-status.sh");

let cached: BackupRun | undefined;
const legacyMirrorRun = (): BackupRun =>
  (cached ??= runBackup(["one", "two"], [], (backupDir) =>
    fs.mkdirSync(path.join(backupDir, "one_legacy.git"))
  ));

const ROUTES = [
  { match: "api /users/good --jq", stdout: "User\n" },
  { match: "api /user --jq", stdout: "someone-else\n" },
  { match: "/users/good/repos", stdout: "good/r1\ngood/r2\n" },
];
const FAIL_R1_THEN_KILL_THE_RUN = '#!/bin/sh\nif [ "$3" = r1 ]; then exit 1; fi\nkill -TERM "$PPID"\n';

let cachedKilled: BackupRun | undefined;
const killedMidSourceRun = (): BackupRun =>
  (cachedKilled ??= runBackup(["good"], ROUTES, (backupDir) =>
    fs.writeFileSync(path.join(backupDir, "sync-one-repo.sh"), FAIL_R1_THEN_KILL_THE_RUN, { mode: 0o755 })
  ));

function statusOf(lastRun: BackupRun["lastRun"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "early-stop-status-"));
  try {
    fs.mkdirSync(path.join(root, "backups"));
    fs.writeFileSync(
      path.join(root, "last-run.json"),
      JSON.stringify({ ...lastRun, finished_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") })
    );
    return spawnSync("bash", [STATUS_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        BACKUP_DIR: path.join(root, "backups"),
        STATE_DIR: root,
        LOG_FILE: path.join(root, "backup.log"),
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a run that stops at the legacy mirror check writes last-run.json with its exit code, so the old result does not stay", { skip: backupRunSkip }, () => {
  const r = legacyMirrorRun();
  assert.equal(r.status, 1);
  assert.match(r.log, /cannot auto-migrate/);
  assert.deepEqual(
    { exit_code: r.lastRun.exit_code, stopped_early: r.lastRun.stopped_early, total: r.lastRun.total, success: r.lastRun.success, fail: r.lastRun.fail, repos: r.lastRun.repos },
    { exit_code: 1, stopped_early: true, total: 0, success: 0, fail: 0, repos: [] }
  );
});

test("status exits 1 and names the early stop for a run that stopped before any repo", { skip: backupRunSkip }, () => {
  const res = statusOf(legacyMirrorRun().lastRun);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /^Run stopped early with exit 1 — see .*backup\.log$/m);
  assert.doesNotMatch(res.stdout, /Failed repos:/);
});

test("a run killed in the middle of a source counts the rows it has, so the failed repo before the stop is not lost", { skip: backupRunSkip }, () => {
  const r = killedMidSourceRun();
  assert.deepEqual(
    { exit_code: r.lastRun.exit_code, stopped_early: r.lastRun.stopped_early, total: r.lastRun.total, success: r.lastRun.success, fail: r.lastRun.fail },
    { exit_code: 143, stopped_early: true, total: 1, success: 0, fail: 1 }
  );
  assert.deepEqual(r.lastRun.repos.map((row) => [row.name, row.action]), [["good/r1", "fail"]]);
});

test("status names the early stop and the failed repo for a run that stopped after a repo failed", { skip: backupRunSkip }, () => {
  const res = statusOf(killedMidSourceRun().lastRun);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /^Run stopped early with exit 143 — see /m);
  assert.match(res.stdout, /^  ✗ fail  good\/r1$/m);
});

test("a run that ends with a failed repo is not marked as stopped early", { skip: backupRunSkip }, () => {
  const r = runBackup(["good"], ROUTES, (backupDir) =>
    fs.writeFileSync(path.join(backupDir, "sync-one-repo.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  );
  assert.equal(r.lastRun.stopped_early, false);
  assert.doesNotMatch(statusOf(r.lastRun).stdout, /Run stopped early/);
});
