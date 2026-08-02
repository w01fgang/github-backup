/**
 * tests/resolve-repo-endpoint.test.ts
 *
 * `GET /users/<login>/repos` lists PUBLIC repositories only — GitHub applies
 * that restriction even when the token belongs to <login>. Resolving a user
 * source to that endpoint therefore drops every private repo from the mirror
 * set silently: no error, no warning, just a smaller `upstream=` count.
 *
 * droplet/lib/resolve-repo-endpoint.sh is the single place that picks the
 * listing endpoint for the cron path, register-webhooks, and the phase
 * verifiers. These tests pin its four decisions and its failure mode.
 *
 * Hermetic: `gh` is stubbed on PATH, so no network and no GitHub credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRepoEndpoint } from "../scripts/lib/repo-endpoint";

const REPO_ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(REPO_ROOT, "droplet", "lib", "resolve-repo-endpoint.sh");

/**
 * Run `resolve_repo_endpoint <slug> <accountType>` with a stubbed `gh`.
 *
 * `login` is what `gh api /user --jq .login` prints; `null` makes the stub
 * exit non-zero, standing in for an unauthenticated or unreachable CLI.
 */
function resolve(
  slug: string,
  accountType: string,
  login: string | null
): { stdout: string; status: number } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
  const gh = path.join(binDir, "gh");
  fs.writeFileSync(
    gh,
    login === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nprintf '%s\\n' '${login}'\n`,
    { mode: 0o755 }
  );
  try {
    const r = spawnSync(
      "bash",
      ["-c", 'set -eu; source "$0"; resolve_repo_endpoint "$1" "$2"', HELPER, slug, accountType],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      }
    );
    return { stdout: (r.stdout ?? "").trim(), status: r.status ?? -1 };
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test("an organisation source lists through /orgs, which already honours token visibility", () => {
  const r = resolve("some-org", "Organization", "someone-else");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "/orgs/some-org/repos?type=all&per_page=100");
});

test("the token owner's own user source lists through /user/repos so private repos are included", () => {
  const r = resolve("w01fgang", "User", "w01fgang");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "/user/repos?affiliation=owner&per_page=100");
});

test("login matching ignores case, because GitHub logins are case-insensitive", () => {
  const r = resolve("W01fgang", "User", "w01fgang");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "/user/repos?affiliation=owner&per_page=100");
});

test("a foreign user source keeps /users/<login>, the only endpoint the token may read", () => {
  const r = resolve("octocat", "User", "w01fgang");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "/users/octocat/repos?type=all&per_page=100");
});

test("an unusable gh CLI degrades to the public endpoint instead of aborting the caller", () => {
  const r = resolve("w01fgang", "User", null);
  assert.equal(r.status, 0, "must not trip the caller's `set -e`");
  assert.equal(r.stdout, "/users/w01fgang/repos?type=all&per_page=100");
});

test("an unrecognised account type is treated as a user account", () => {
  const r = resolve("octocat", "Bot", "w01fgang");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "/users/octocat/repos?type=all&per_page=100");
});

test("the TypeScript wrapper returns the shell helper's answer verbatim", () => {
  // No stub here: the org branch never shells out to `gh`, so this asserts the
  // TS↔bash bridge itself rather than the network.
  assert.equal(
    resolveRepoEndpoint("some-org", "Organization"),
    "/orgs/some-org/repos?type=all&per_page=100"
  );
});
