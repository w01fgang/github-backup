/**
 * tests/webhook-source-match.test.ts
 *
 * Covers `matchSource()` in droplet/webhook-listener.js — the access check
 * that maps a push payload's owner login to a configured GITHUB_SOURCES entry.
 * GitHub logins are case-insensitive, and the returned name selects the mirror
 * directory `<source>/`, which cron also writes with the configured spelling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRequire } from "node:module";

const LISTENER = path.resolve(__dirname, "..", "droplet", "webhook-listener.js");
const matchSource: (sourcesRaw: string, owner: unknown) => string | undefined =
  createRequire(__filename)(LISTENER).matchSource;

test("a push from owner acme matches configured source Acme and returns the configured spelling", () => {
  assert.equal(matchSource("Acme", "acme"), "Acme");
});

test("a push from owner ACME matches configured source acme among several sources", () => {
  assert.equal(matchSource("solo.dev  acme\tother", "ACME"), "acme");
});

test("an owner with the exact configured casing returns that source", () => {
  assert.equal(matchSource("acme Acme", "Acme"), "Acme");
});

test("a near-miss owner that extends a configured source is rejected", () => {
  assert.equal(matchSource("Acme", "acme-x"), undefined);
});

test("a near-miss owner that is a prefix of a configured source is rejected", () => {
  assert.equal(matchSource("Acme", "acm"), undefined);
});

test("a signed payload with a non-string owner login matches no source", () => {
  assert.equal(matchSource("acme", 123), undefined);
  assert.equal(matchSource("acme", ["acme"]), undefined);
});
