import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { backupRunSkip, runBackup, writeGhStub, type GhRoute } from "./helpers/backup-run";

const HELPER = path.resolve(__dirname, "..", "droplet", "lib", "detect-account-type.sh");
const BAD_GATEWAY = { stderr: "gh: Bad Gateway (HTTP 502)\n", exit: 1 };
const NOT_FOUND = {
  stdout: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
  stderr: "gh: Not Found (HTTP 404)\n",
  exit: 1,
};

function detect(route: Omit<GhRoute, "match">): { stdout: string; status: number } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
  try {
    writeGhStub(binDir, [{ match: "api /users/some-slug --jq", ...route }], path.join(binDir, "calls"));
    const r = spawnSync("bash", ["-c", 'set -eu; source "$0"; detect_account_type some-slug', HELPER], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
    });
    return { stdout: r.stdout ?? "", status: r.status ?? -1 };
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test("an unknown login (HTTP 404) still reads as User, so verify:phase-7 keeps its unknown-slug contract", () => {
  assert.deepEqual(detect(NOT_FOUND), { stdout: "User\n", status: 0 });
});

test("any other gh error fails the account type lookup, so an outage cannot turn an organisation into a user", () => {
  const r = detect(BAD_GATEWAY);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
});

test("an organisation whose type probe fails once is a failed source, so its private repos are not dropped in silence", { skip: backupRunSkip }, () => {
  const r = runBackup(["org1", "good"], [
    { match: "api /users/org1 --jq", ...BAD_GATEWAY },
    { match: "api /users/good --jq", stdout: "User\n" },
    { match: "api /user --jq", stdout: "someone-else\n" },
    { match: "/orgs/org1/repos", stdout: "org1/public1\norg1/private1\n" },
    { match: "/users/org1/repos", stdout: "org1/public1\n" },
    { match: "/users/good/repos", stdout: "good/r1\n" },
  ]);
  assert.equal(r.status, 1);
  assert.match(r.log, /BACKUP_SOURCE_SUMMARY source=org1 upstream=1 mirrored=0 failed=1$/m);
  assert.match(r.log, /BACKUP_SUMMARY upstream=2 mirrored=1 failed=1$/m);
  assert.deepEqual(r.ghCalls.filter((c) => c.includes("/org1/repos")), []);
});

test("a user source whose /user lookup fails is a failed source, so the public-only listing never stands in for it", { skip: backupRunSkip }, () => {
  const r = runBackup(["me"], [
    { match: "api /users/me --jq", stdout: "User\n" },
    { match: "api /user --jq", stderr: "gh: Service Unavailable (HTTP 503)\n", exit: 1 },
    { match: "/user/repos", stdout: "me/public1\nme/private1\n" },
    { match: "/users/me/repos", stdout: "me/public1\n" },
  ]);
  assert.equal(r.status, 1);
  assert.match(r.log, /BACKUP_SOURCE_SUMMARY source=me upstream=1 mirrored=0 failed=1$/m);
  assert.deepEqual(r.ghCalls.filter((c) => c.includes("/repos")), []);
});
