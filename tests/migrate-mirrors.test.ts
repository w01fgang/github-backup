import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { migrateCommand, migrateScript } from "../scripts/migrate-mirrors";
import { runCapture } from "../scripts/lib/ssh";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-mirrors-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function backupDirWith(...entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(scratch, "bk-"));
  for (const e of entries) fs.mkdirSync(path.join(dir, e), { recursive: true });
  return dir;
}

function runOnStdin(dir: string, from: string): string {
  return execFileSync("bash", ["-s"], {
    input: migrateScript(dir, from),
    encoding: "utf8",
  });
}

test("the migration script moves top-level *.git dirs into <backupDir>/<from>/ when run through bash -s on stdin", () => {
  const dir = backupDirWith("a.git");
  const out = runOnStdin(dir, "legacy");
  assert.match(out, /MIGRATE_RESULT moved=1 skipped_existing=0/);
  assert.ok(fs.existsSync(path.join(dir, "legacy", "a.git")));
  assert.ok(!fs.existsSync(path.join(dir, "a.git")));
});

test("the migration script leaves a mirror that already exists under <from>/ in place", () => {
  const dir = backupDirWith("a.git", "legacy/a.git", "b.git");
  const out = runOnStdin(dir, "legacy");
  assert.match(out, /MIGRATE_RESULT moved=1 skipped_existing=1/);
  assert.ok(fs.existsSync(path.join(dir, "a.git")));
  assert.ok(fs.existsSync(path.join(dir, "legacy", "b.git")));
});

test("the migration script reports nothing to move when no top-level *.git dir exists", () => {
  const dir = backupDirWith("legacy/a.git");
  const out = runOnStdin(dir, "legacy");
  assert.match(out, /MIGRATE_RESULT moved=0 skipped_existing=0 \(nothing to move\)/);
});

test("the ssh command line carries no script text because the script goes on stdin", () => {
  const cmd = migrateCommand("/k/id", "root", "203.0.113.7");
  const script = migrateScript("/srv/backups", "legacy");
  assert.ok(cmd.endsWith(" root@203.0.113.7 bash -s"));
  assert.ok(!cmd.includes("MIGRATE_RESULT"));
  assert.ok(!cmd.includes("TOP="));
  assert.ok(!cmd.includes("\n"));
  assert.ok(script.includes("\n"));
});

test("runCapture writes its input to the command's stdin, which carries the script to the remote bash", () => {
  assert.equal(runCapture("cat", "MIGRATE_RESULT moved=0 skipped_existing=0\n"), "MIGRATE_RESULT moved=0 skipped_existing=0");
});
