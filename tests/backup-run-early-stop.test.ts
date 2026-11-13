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
    { exit_code: r.lastRun.exit_code, total: r.lastRun.total, success: r.lastRun.success, fail: r.lastRun.fail, repos: r.lastRun.repos },
    { exit_code: 1, total: 0, success: 0, fail: 0, repos: [] }
  );
});

test("status exits 1 and names the early stop for a run that stopped before any repo", { skip: backupRunSkip }, () => {
  const res = statusOf(legacyMirrorRun().lastRun);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /^Run stopped early with exit 1 — see .*backup\.log$/m);
  assert.doesNotMatch(res.stdout, /Failed repos:/);
});
