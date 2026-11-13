import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRequire } from "node:module";

const LISTENER = path.resolve(__dirname, "..", "droplet", "webhook-listener.js");
const syncDispatchArgs: (source: string, owner: string, repo: string) => string[] =
  createRequire(__filename)(LISTENER).syncDispatchArgs;

test("the webhook sync waits for a held per-repo lock", () => {
  const args = syncDispatchArgs("acme", "acme", "widgets");
  const scriptIndex = args.findIndex((a) => a.endsWith("sync-one-repo.sh"));
  const waitIndex = args.indexOf("--setenv=LOCK_WAIT_SECONDS_REPO=3600");
  assert.ok(waitIndex >= 0, "lock wait env is passed to the transient unit");
  assert.ok(waitIndex < scriptIndex, "systemd-run reads options only before the command");
});

test("the webhook sync passes source, owner and repo to the script in order", () => {
  const args = syncDispatchArgs("src", "own", "rep");
  assert.deepEqual(args.slice(-3), ["src", "own", "rep"]);
  assert.deepEqual(args.slice(0, 2), ["--collect", "--no-block"]);
});
