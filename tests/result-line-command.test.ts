import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resultLineCommand, resultLineNames } from "../scripts/lib/result-line";

const OLD = "[2026-01-01T00:00:00Z] BACKUP_REPO_RESULT source=o owner=o repo=r action=update";
const NEW = "[2026-01-02T00:00:00Z] BACKUP_REPO_RESULT source=o owner=o repo=r action=clone";

function run(log: string, offset: number, repo = "r", source = "o", owner = "o"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-line-"));
  const file = path.join(dir, "github-backup.log");
  fs.writeFileSync(file, log);
  try {
    return execFileSync("bash", ["-c", resultLineCommand(source, owner, repo, offset, file)], {
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

test("finds the result line when the GitHub owner case differs from the source name", () => {
  const line =
    "[2026-01-02T00:00:00Z] BACKUP_REPO_RESULT source=acme owner=Acme repo=r action=update\n";
  assert.equal(run(line, 0, "r", "acme", "Acme"), line.trim());
});

const LINE = (owner: string, repo: string): string =>
  `[2026-01-02 00:00:00] BACKUP_REPO_RESULT source=s owner=${owner} repo=${repo} action=update duration_ms=5`;

test("resultLineNames finds the result line of a denied repo", () => {
  assert.equal(resultLineNames(LINE("acme", "foo") + "\n", "s", "acme", "foo"), true);
});

test("resultLineNames does not match a repo that shares only a name prefix", () => {
  assert.equal(resultLineNames(LINE("acme", "foo-bar") + "\n", "s", "acme", "foo"), false);
});

test("resultLineNames does not match the same repo name under another owner", () => {
  assert.equal(resultLineNames(LINE("other", "foo") + "\n", "s", "acme", "foo"), false);
});

test("resultLineNames reports an empty log as having no line", () => {
  assert.equal(resultLineNames("", "s", "acme", "foo"), false);
});

test("resultLineNames does not match a line that another source wrote for the same repo, since that source has its own filter", () => {
  assert.equal(resultLineNames(LINE("acme", "foo") + "\n", "other-source", "acme", "foo"), false);
});
