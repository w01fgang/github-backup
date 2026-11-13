import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const root = path.resolve(__dirname, "..");
const runner = path.resolve(root, "scripts", "uat-runner.ts");
const tsxLoader = path.resolve(root, "node_modules", "tsx", "dist", "loader.mjs");

function run(args: string[], cwd = root) {
  return spawnSync(process.execPath, ["--import", tsxLoader, runner, ...args], {
    encoding: "utf8",
    cwd,
  });
}

function runInTempDir(configJson?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uat-config-"));
  try {
    if (configJson !== undefined) fs.writeFileSync(path.join(dir, "config.json"), configJson);
    return run(["--phase", "01"], dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("exits 2 with no config.json, since no scenario ran", () => {
  const r = runInTempDir();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /config\.json not found/);
});

test("exits 2 on a config.json that is not valid JSON, since no scenario ran", () => {
  const r = runInTempDir("{");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not valid JSON/);
});

test("exits 2 on a config.json that holds null, since no scenario ran", () => {
  const r = runInTempDir("null");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must hold a JSON object/);
});
