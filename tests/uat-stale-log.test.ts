/**
 * tests/uat-stale-log.test.ts
 *
 * p04-02 reads /tmp/uat-p04-01.log. A log left by an earlier run would let
 * p04-02 pass on old data when p04-01 fails before it writes anything, so a
 * run that includes p04-01 removes the old log first.
 *
 * Hermetic: the log path is a file in a scratch directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeStaleP0401Log } from "../scripts/lib/uat-stale-log";

function staleLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uat-log-"));
  const log = path.join(dir, "uat-p04-01.log");
  fs.writeFileSync(log, "P04_01_DEST=/tmp/old-run\n");
  return log;
}

test("a run that includes p04-01 removes the log of the earlier run", () => {
  const log = staleLog();
  removeStaleP0401Log([{ id: "p01-01" }, { id: "p04-01" }, { id: "p04-02" }], log);
  assert.equal(fs.existsSync(log), false);
});

test("a run of p04-02 alone keeps the log of the last p04-01 run", () => {
  const log = staleLog();
  removeStaleP0401Log([{ id: "p04-02" }], log);
  assert.equal(fs.existsSync(log), true);
});
