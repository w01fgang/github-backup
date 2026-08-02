/**
 * tests/mirror-path.test.ts
 *
 * Mirror directories are named from the GitHub API's `full_name`, so they
 * carry the account's canonical casing. Slugs are case-insensitive on
 * github.com, so the droplet-side search has to bridge the two without losing
 * the ambiguity signal the callers bail on.
 *
 * The command built by `mirrorFindCommand` is run here against a scratch tree
 * laid out like <backupDir>/<source>/<owner>_<repo>.git. That exercises the
 * real matching mechanism rather than a TypeScript restatement of it — the
 * droplet runs the same string over SSH.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { mirrorFindCommand } from "../scripts/lib/mirror-path";

const MIRRORS = [
  "toprent-app/Toprent-app_locale-editor.git",
  "toprent-app/Toprent-app_locale-editor-mcp.git",
  "w01fgang/w01fgang_moto-order-system.git",
  // One repo left behind under an old casing after GitHub changed the
  // canonical spelling — sync-one-repo.sh clones the new path, never removing
  // the old, so both sit in the same source dir.
  "alice/Alice_Shared.git",
  "alice/alice_shared.git",
];

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-path-test-"));
for (const m of MIRRORS) {
  fs.mkdirSync(path.join(backupDir, m), { recursive: true });
}
// Depth-3 decoy: `find` must not descend into a mirror's own contents.
fs.mkdirSync(path.join(backupDir, "w01fgang/w01fgang_moto-order-system.git/refs"), {
  recursive: true,
});

// The droplet is ext4, but this suite also runs on a developer's macOS box,
// where the default APFS volume folds case and the two-casing fixture above
// collapses into a single directory. Detect that rather than assert something
// the filesystem cannot represent.
const caseFoldingFs = fs.existsSync(path.join(backupDir, "alice/ALICE_SHARED.GIT"));

after(() => fs.rmSync(backupDir, { recursive: true, force: true }));

/** Run the droplet-side command locally and return the matched paths. */
function search(owner: string, repo: string): string[] {
  const out = execFileSync("bash", ["-c", mirrorFindCommand(backupDir, owner, repo)], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => path.relative(backupDir, p))
    .sort();
}

test("a slug whose casing differs from the mirror dir still resolves", () => {
  assert.deepEqual(search("toprent-app", "locale-editor"), [
    "toprent-app/Toprent-app_locale-editor.git",
  ]);
});

test("a slug matching the mirror dir byte-for-byte resolves", () => {
  assert.deepEqual(search("Toprent-app", "locale-editor"), [
    "toprent-app/Toprent-app_locale-editor.git",
  ]);
});

test("matching is anchored to the whole dir name, not a prefix", () => {
  const hits = search("toprent-app", "locale-editor");
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].endsWith("locale-editor-mcp.git"));
});

test("an unmirrored slug returns nothing so the caller can bail", () => {
  assert.deepEqual(search("w01fgang", "never-backed-up"), []);
});

test("a repo mirrored under two casings stays ambiguous, whichever casing is asked for", {
  skip: caseFoldingFs
    ? "filesystem folds case — the two-casing fixture cannot exist here (droplet is ext4)"
    : false,
}, () => {
  // Every casing names the same repo, so returning one of them would hand the
  // operator whichever mirror their spelling matched — stale half the time.
  for (const [owner, repo] of [
    ["alice", "shared"],
    ["Alice", "Shared"],
    ["ALICE", "SHARED"],
  ]) {
    assert.deepEqual(
      search(owner, repo),
      ["alice/Alice_Shared.git", "alice/alice_shared.git"],
      `slug ${owner}/${repo} must stay ambiguous`
    );
  }
});

test("the search never descends into a mirror's own directories", () => {
  assert.deepEqual(search("w01fgang", "moto-order-system"), [
    "w01fgang/w01fgang_moto-order-system.git",
  ]);
  assert.deepEqual(search("refs", ""), []);
});

test("a missing backup dir yields no match instead of failing the caller", () => {
  const out = execFileSync(
    "bash",
    ["-c", mirrorFindCommand(path.join(backupDir, "does-not-exist"), "alice", "shared")],
    { encoding: "utf8" }
  );
  assert.equal(out.trim(), "");
});

test("a backupDir that is a symlink to the real volume still resolves", () => {
  // README documents backupDir as "any absolute path", and an operator who
  // moved the mirrors onto an attached volume points it at a symlink. `find`
  // defaults to -P, which visits the symlink and nothing beneath it; the shell
  // glob this replaced expanded through it, so -P would be a silent regression
  // reporting every existing mirror absent.
  const link = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-path-link-")) + "/volume";
  fs.symlinkSync(backupDir, link, "dir");
  try {
    const out = execFileSync(
      "bash",
      ["-c", mirrorFindCommand(link, "toprent-app", "locale-editor")],
      { encoding: "utf8" }
    );
    assert.deepEqual(
      out.split("\n").map((l) => l.trim()).filter(Boolean),
      [path.join(link, "toprent-app/Toprent-app_locale-editor.git")]
    );
  } finally {
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  }
});

test("a mirror that is itself a symlink is still found", () => {
  // sync-one-repo.sh tests `[[ -d "${MIRROR_PATH}" ]]`, which follows the
  // link, so an operator who moved one heavy mirror onto another volume and
  // symlinked it in place still gets it updated every run. The search has to
  // agree, or restore reports a mirror the backup path is actively maintaining
  // as absent. -H is not enough here: it dereferences the starting path only,
  // leaving a symlinked mirror as -type l.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-path-vol-"));
  const target = path.join(other, "alice_moved.git");
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(backupDir, "alice/alice_moved.git"), "dir");
  try {
    assert.deepEqual(search("alice", "moved"), ["alice/alice_moved.git"]);
  } finally {
    fs.rmSync(path.join(backupDir, "alice/alice_moved.git"), { force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("a dangling mirror symlink is not offered as a restore source", () => {
  // Following links must not go so far that a broken one counts as a mirror:
  // the caller would hand `git clone` a path it cannot read. Bailing with
  // "no mirror" names the real problem.
  const dead = path.join(backupDir, "alice/alice_vanished.git");
  fs.symlinkSync(path.join(os.tmpdir(), "mirror-path-no-such-target"), dead, "dir");
  try {
    assert.deepEqual(search("alice", "vanished"), []);
  } finally {
    fs.rmSync(dead, { force: true });
  }
});
