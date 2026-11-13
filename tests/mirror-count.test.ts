import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorCountCovers } from "../scripts/lib/mirror-count";

test("accepts an extra mirror because the old mirror of a denied repo stays on disk", () => {
  assert.equal(mirrorCountCovers(54, 53), true);
});

test("accepts an exact match of filesystem and mirrored counts", () => {
  assert.equal(mirrorCountCovers(53, 53), true);
});

test("rejects fewer mirrors on disk than the run mirrored", () => {
  assert.equal(mirrorCountCovers(52, 53), false);
});

test("rejects an unparsed filesystem count", () => {
  assert.equal(mirrorCountCovers(NaN, 0), false);
});

test("rejects a non-finite filesystem count", () => {
  assert.equal(mirrorCountCovers(Infinity, 53), false);
});
