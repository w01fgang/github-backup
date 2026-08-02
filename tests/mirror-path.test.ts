/**
 * tests/mirror-path.test.ts
 *
 * Mirror directories are named from the GitHub API's `full_name`, so they
 * carry the account's canonical casing. Slugs are case-insensitive on
 * github.com, so `selectMirrors` has to bridge the two without losing the
 * ambiguity signal the callers bail on.
 *
 * Pure function, no droplet: `listMirrorPaths` owns the SSH round-trip and is
 * exercised live by `npm run verify:phase-4`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMirrors } from "../scripts/lib/mirror-path";

const MIRRORS = [
  "/opt/github-backups/toprent-app/Toprent-app_locale-editor.git",
  "/opt/github-backups/toprent-app/Toprent-app_locale-editor-mcp.git",
  "/opt/github-backups/w01fgang/w01fgang_moto-order-system.git",
];

test("a slug whose casing differs from the mirror dir still resolves", () => {
  assert.deepEqual(selectMirrors(MIRRORS, "toprent-app", "locale-editor"), [
    "/opt/github-backups/toprent-app/Toprent-app_locale-editor.git",
  ]);
});

test("a slug matching the mirror dir byte-for-byte resolves", () => {
  assert.deepEqual(selectMirrors(MIRRORS, "Toprent-app", "locale-editor"), [
    "/opt/github-backups/toprent-app/Toprent-app_locale-editor.git",
  ]);
});

test("matching is anchored to the whole dir name, not a prefix", () => {
  // `Toprent-app_locale-editor-mcp.git` starts with the requested name.
  const hits = selectMirrors(MIRRORS, "toprent-app", "locale-editor");
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].endsWith("locale-editor-mcp.git"));
});

test("an unmirrored slug returns nothing so the caller can bail", () => {
  assert.deepEqual(selectMirrors(MIRRORS, "w01fgang", "never-backed-up"), []);
});

test("the same repo under two sources is reported as ambiguous", () => {
  const twoSources = [
    "/opt/github-backups/alice/alice_shared.git",
    "/opt/github-backups/bob/alice_shared.git",
  ];
  assert.equal(selectMirrors(twoSources, "alice", "shared").length, 2);
});

test("an exact-case match wins over a case-insensitive collision", () => {
  // Two sources legitimately holding differently-cased dirs: naming one of
  // them exactly is not ambiguous, so the caller must not be made to bail.
  const collided = [
    "/opt/github-backups/one/Alice_Shared.git",
    "/opt/github-backups/two/alice_shared.git",
  ];
  assert.deepEqual(selectMirrors(collided, "alice", "shared"), [
    "/opt/github-backups/two/alice_shared.git",
  ]);
  assert.deepEqual(selectMirrors(collided, "Alice", "Shared"), [
    "/opt/github-backups/one/Alice_Shared.git",
  ]);
  // Neither spelling is exact — both are candidates, caller bails.
  assert.equal(selectMirrors(collided, "ALICE", "SHARED").length, 2);
});

test("an empty droplet listing resolves to no match rather than throwing", () => {
  assert.deepEqual(selectMirrors([], "alice", "shared"), []);
});
