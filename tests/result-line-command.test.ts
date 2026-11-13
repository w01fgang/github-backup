import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resultLineCommand } from "../scripts/lib/result-line";

const OLD = "[2026-01-01T00:00:00Z] BACKUP_REPO_RESULT source=o owner=o repo=r action=update";
const NEW = "[2026-01-02T00:00:00Z] BACKUP_REPO_RESULT source=o owner=o repo=r action=clone";

function run(log: string, offset: number, repo = "r"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-line-"));
  const file = path.join(dir, "github-backup.log");
  fs.writeFileSync(file, log);
  try {
    return execFileSync("bash", ["-c", resultLineCommand("o", repo, offset, file)], {
      encoding: "utf8",
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ignores a result line written before the baseline offset", () => {
  const before = OLD + "\n";
  assert.equal(run(before, Buffer.byteLength(before)), "");
});

test("returns the result line written after the baseline offset", () => {
  const before = OLD + "\n";
  assert.equal(run(before + NEW + "\n", Buffer.byteLength(before)), NEW);
});

test("ignores a result line of another repo after the offset", () => {
  const other = "[2026-01-02T00:00:00Z] BACKUP_REPO_RESULT source=o owner=o repo=x action=clone\n";
  assert.equal(run(other, 0), "");
});

test("a dot in the repo name matches only a dot", () => {
  const other = "[2026-01-02T00:00:00Z] BACKUP_REPO_RESULT source=o owner=o repo=myXrepo action=clone\n";
  assert.equal(run(other, 0, "my.repo"), "");
});
