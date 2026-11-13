/**
 * tests/repo-list-command.test.ts
 *
 * Phase-7 discovery picks its webhook target from the repos that `gh api`
 * lists. GitHub returns one page of 100 repos per request, so without
 * `--paginate` a source with more repos never offers the repos past the
 * first page, and an allow list that matches only those repos finds no target.
 *
 * Hermetic: `gh` is a stub on PATH that serves two pages and honours
 * `--paginate` the way the real CLI does. No network, no credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { repoListCommand } from "../scripts/lib/repo-list-command";

const REPO_ROOT = path.resolve(__dirname, "..");
const ENDPOINT_LIB = path.join(REPO_ROOT, "droplet", "lib", "resolve-repo-endpoint.sh");

const GH_STUB = `#!/usr/bin/env bash
paginate=0
for a in "$@"; do [ "$a" = "--paginate" ] && paginate=1; done
echo "acme/first-page-repo"
if [ "$paginate" = 1 ]; then echo "acme/second-page-repo"; fi
`;

function discover(): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-list-"));
  const bin = path.join(dir, "bin");
  const env = path.join(dir, "backup.env");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(env, "");

  const cmd = repoListCommand(env, ENDPOINT_LIB, "acme", "Organization");
  const r = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

test("phase-7 discovery finds a repo on the second page of results", () => {
  assert.ok(discover().includes("acme/second-page-repo"));
});
