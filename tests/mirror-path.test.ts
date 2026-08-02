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
