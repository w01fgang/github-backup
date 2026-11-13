import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { spawnSync } from "child_process";

const runner = path.resolve(__dirname, "..", "scripts", "uat-runner.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", runner, ...args], {
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
  });
}

test("exits 2 on an unknown phase, since no scenario ran", () => {
  const r = run(["--phase", "99"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--phase must be one of/);
});

test("exits 2 on an unknown flag", () => {
  assert.equal(run(["--bogus"]).status, 2);
});

test("exits 2 when --scenario has no id", () => {
  assert.equal(run(["--scenario"]).status, 2);
});

test("exits 2 on an unknown scenario id", () => {
  assert.equal(run(["--scenario", "p99-99"]).status, 2);
});

test("exits 0 for --help", () => {
  assert.equal(run(["--help"]).status, 0);
});
