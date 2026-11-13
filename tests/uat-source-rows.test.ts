/**
 * tests/uat-source-rows.test.ts
 *
 * UAT scenario p01-05 compares each source's kept repo count to its mirror
 * count. A source with an empty allow list ("mirror everything, deny a few")
 * must reach the loop with ALLOW empty and DENY intact. With a whitespace
 * field separator `read` collapses the empty field, DENY lands in ALLOW, and
 * the scenario filters the wrong repos.
 *
 * Hermetic: the shell fragments run against a scratch config.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SOURCE_ROWS_ASSIGN,
  SOURCE_ROWS_READ_HEAD,
} from "../scripts/lib/uat-source-rows";

function readRows(config: unknown): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uat-rows-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const script =
    SOURCE_ROWS_ASSIGN +
    SOURCE_ROWS_READ_HEAD +
    'echo "$SLUG|$ALLOW|$DENY"; ' +
    'done <<< "$ROWS"';
  const r = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
}

test("p01-05 keeps an empty allow list so the deny globs do not shift into it", () => {
  const rows = readRows({
    githubSources: [{ name: "acme", repos: { deny: ["old-*", "tmp-*"] } }],
  });
  assert.deepEqual(rows, ["acme||old-* tmp-*"]);
});

test("p01-05 passes both allow and deny globs of a source through unchanged", () => {
  const rows = readRows({
    githubSources: [
      { name: "acme", repos: { allow: ["web-*"], deny: ["web-old"] } },
      "plain",
    ],
  });
  assert.deepEqual(rows, ["acme|web-*|web-old", "plain||"]);
});
