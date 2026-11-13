/**
 * tests/status-du-failure.test.ts
 *
 * The droplet status script measures the mirror tree with `du`. A running
 * clone, fetch or gc can remove a file during the walk, so `du` prints a size
 * and still exits non-zero. The script must keep that size and finish.
 *
 * A stub `du` first on PATH plays the boundary: it prints a size and exits 1.
 * STATE_DIR and LOG_FILE point the script at temp paths. The test skips on
 * hosts that are not Linux or lack `jq`.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const script = path.join(__dirname, "..", "droplet", "github-backup-status.sh");

const hasJq = spawnSync("jq", ["--version"]).status === 0;
const skipReason =
  os.platform() !== "linux"
    ? "status script needs GNU df and date (Linux)"
    : !hasJq
      ? "status script needs jq"
      : false;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "status-du-test-"));
const backupDir = path.join(scratch, "backups");
const stubDir = path.join(scratch, "bin");
const emptyStateDir = path.join(scratch, "state-empty");
const freshStateDir = path.join(scratch, "state-fresh");
fs.mkdirSync(path.join(backupDir, "acme", "acme_widgets.git"), { recursive: true });
fs.mkdirSync(stubDir);
fs.mkdirSync(emptyStateDir);
fs.mkdirSync(freshStateDir);
const finishedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
fs.writeFileSync(
  path.join(freshStateDir, "last-run.json"),
  JSON.stringify({
    started_at: finishedAt,
    finished_at: finishedAt,
    exit_code: 0,
    total: 1,
    success: 1,
    fail: 0,
    repos: [{ source: "acme", name: "acme/widgets", action: "update", duration_ms: 5 }],
  }),
);
fs.writeFileSync(
  path.join(stubDir, "du"),
  '#!/bin/sh\necho "du: cannot access x: No such file or directory" >&2\nprintf "123\\t%s\\n" "$2"\nexit 1\n',
  { mode: 0o755 },
);

const failingStubDir = path.join(scratch, "bin-find");
fs.mkdirSync(failingStubDir);
fs.copyFileSync(path.join(stubDir, "du"), path.join(failingStubDir, "du"));
fs.writeFileSync(
  path.join(failingStubDir, "find"),
  '#!/bin/sh\necho "find: x: No such file or directory" >&2\necho "$1/acme/acme_widgets.git"\nexit 1\n',
  { mode: 0o755 },
);

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function runStatus(stateDir: string, args: string[], bin = stubDir) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      BACKUP_DIR: backupDir,
      STATE_DIR: stateDir,
      LOG_FILE: path.join(scratch, "no-such.log"),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

test(
  "status prints the mirror size that du reported when du exits non-zero",
  { skip: skipReason },
  () => {
    const res = runStatus(emptyStateDir, ["--json"]);
    assert.equal(res.status, 3, res.stderr);
    assert.equal(JSON.parse(res.stdout).disk.mirror_bytes, 123);
  },
);

test(
  "status --verbose lists each mirror size when find and du exit non-zero",
  { skip: skipReason },
  () => {
    const res = runStatus(freshStateDir, ["--verbose"], failingStubDir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^  123  acme\/acme_widgets\.git$/m);
  },
);
