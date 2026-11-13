import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalSlug, fullNameCommand } from "../scripts/lib/repo-full-name";

test("the phase-3 push uses the GitHub case of the owner so no second mirror is cloned", () => {
  assert.deepEqual(canonicalSlug("toprent-app", "locale-editor", "Toprent-app/locale-editor\n"), {
    owner: "Toprent-app",
    repo: "locale-editor",
  });
});

test("a full_name of another repo is refused so the push does not go to the wrong mirror", () => {
  assert.equal(canonicalSlug("acme", "widgets", "acme/widgets-old"), null);
  assert.equal(canonicalSlug("acme", "widgets", "other/widgets"), null);
});

test("an empty or error lookup output gives no slug", () => {
  assert.equal(canonicalSlug("acme", "widgets", ""), null);
  assert.equal(canonicalSlug("acme", "widgets", "gh: Not Found (HTTP 404)"), null);
});

test("the lookup command asks gh for the full_name with the token of backup.env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-full-name-"));
  const envFile = path.join(dir, "backup.env");
  fs.writeFileSync(envFile, "GITHUB_TOKEN=tok123\n");
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, '#!/bin/bash\necho "token=$GITHUB_TOKEN args=$*"\n', { mode: 0o755 });
  const r = spawnSync("bash", ["-c", fullNameCommand(envFile, "acme", "widgets")], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}` },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "token=tok123 args=api repos/acme/widgets --jq .full_name");
});
