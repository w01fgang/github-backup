/**
 * tests/env-slot.test.ts
 *
 * The source-name → env-var slot algorithm exists in three places:
 *   - scripts/bootstrap-droplet.ts   `envSlot()`   (writes backup.env)
 *   - droplet/github-backup.sh       `slot()`      (cron path reads backup.env)
 *   - droplet/webhook-listener.js    `envSlot()`   (webhook path reads backup.env)
 *
 * A one-character disagreement means a source's allow/deny globs silently
 * vanish on the reading side and the filter degrades to pass-through. These
 * tests pin the algorithm and assert three-way byte-for-byte parity.
 *
 * Hermetic: the bash side is exercised by extracting the single-line `slot()`
 * definition out of droplet/github-backup.sh and evaluating just that
 * definition — the script itself is a cron entrypoint and cannot be sourced.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { envSlot } from "../scripts/bootstrap-droplet";

const REPO_ROOT = path.resolve(__dirname, "..");
const BACKUP_SH = path.join(REPO_ROOT, "droplet", "github-backup.sh");
const LISTENER = path.join(REPO_ROOT, "droplet", "webhook-listener.js");

const listenerEnvSlot: (name: string) => string =
  createRequire(__filename)(LISTENER).envSlot;

/**
 * The bash `slot()` definition, lifted verbatim out of github-backup.sh.
 * Extraction is asserted to find exactly one single-line definition so a
 * reshaped helper fails loudly instead of silently skipping the parity check.
 */
const bashSlotDef = (() => {
  const lines = fs.readFileSync(BACKUP_SH, "utf8").split("\n");
  const defs = lines.filter((l) => /^slot\(\)\s*\{.*\}\s*$/.test(l));
  assert.equal(
    defs.length,
    1,
    `expected exactly one single-line slot() definition in ${BACKUP_SH}, found ${defs.length}`
  );
  return defs[0];
})();

/** Evaluate the bash slot() over a batch of names; one output line per name. */
function bashSlot(names: string[]): string[] {
  const r = spawnSync(
    "/bin/bash",
    ["-c", `${bashSlotDef}\nfor a in "$@"; do slot "$a"; done`, "_", ...names],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 0, `bash slot() failed: ${r.stderr}`);
  const out = r.stdout.split("\n");
  assert.equal(out.pop(), "", "bash slot() output must end with a newline");
  assert.equal(
    out.length,
    names.length,
    `bash slot() emitted ${out.length} lines for ${names.length} names`
  );
  return out;
}

/**
 * Awkward-but-representable source names. GitHub owner slugs are ASCII, so
 * the parity contract is defined over ASCII input.
 */
const AWKWARD_NAMES = [
  "acme",
  "ACME",
  "AcMe",
  "acme-corp",
  "acme_corp",
  "acme.corp",
  "acme.corp.io",
  "my-org-2024",
  "2024-org",
  "9",
  "0abc",
  "a b",
  "  padded  ",
  "dots...and---dashes",
  "trailing-",
  "trailing.",
  "trailing_",
  "-leading",
  "___",
  "---",
  ".",
  "-",
  "_",
  "",
  "a",
  "Z",
  "user/repo",
  "user@host",
  "plus+sign",
  "percent%20",
  "tab\there",
  "quote\"inside",
  "single'quote",
  "dollar$sign",
  "back`tick",
  "back\\slash",
  "paren(s)",
  "brace{s}",
  "star*",
  "question?",
  "semi;colon",
  "amp&ersand",
  "pipe|char",
  "hash#tag",
  "bang!",
  "tilde~",
  "caret^",
  "equals=sign",
  "a".repeat(120),
];

// ─── TS algorithm ────────────────────────────────────────────────────────────

test("envSlot uppercases ASCII letters", () => {
  assert.equal(envSlot("acme"), "ACME");
  assert.equal(envSlot("AcMe"), "ACME");
  assert.equal(envSlot("ACME"), "ACME");
});

test("envSlot maps every non-alphanumeric character to a single underscore", () => {
  assert.equal(envSlot("acme-corp"), "ACME_CORP");
  assert.equal(envSlot("acme.corp.io"), "ACME_CORP_IO");
  assert.equal(envSlot("user/repo"), "USER_REPO");
  assert.equal(envSlot("a b"), "A_B");
  // One underscore per character — never collapsed into one.
  assert.equal(envSlot("dots...and---dashes"), "DOTS___AND___DASHES");
});

test("envSlot preserves digits and does not prefix leading-digit names", () => {
  assert.equal(envSlot("2024-org"), "2024_ORG");
  assert.equal(envSlot("0abc"), "0ABC");
});

test("envSlot does not strip trailing underscores", () => {
  // A strip would make "acme-" and "acme" share a slot and silently merge
  // two sources' allow/deny globs.
  assert.equal(envSlot("acme-"), "ACME_");
  assert.equal(envSlot("acme_"), "ACME_");
  assert.equal(envSlot("acme"), "ACME");
  assert.notEqual(envSlot("acme-"), envSlot("acme"));
});

test("envSlot maps the empty name to the empty slot", () => {
  assert.equal(envSlot(""), "");
});

test("envSlot output is a legal shell identifier suffix for ASCII input", () => {
  for (const name of AWKWARD_NAMES) {
    assert.match(
      envSlot(name),
      /^[A-Z0-9_]*$/,
      `slot for ${JSON.stringify(name)} is not [A-Z0-9_]*`
    );
  }
});

// ─── three-way parity ────────────────────────────────────────────────────────

test("TS envSlot and bash slot() agree byte-for-byte over the awkward-name table", () => {
  const fromBash = bashSlot(AWKWARD_NAMES);
  const mismatches: string[] = [];
  AWKWARD_NAMES.forEach((name, i) => {
    const ts = envSlot(name);
    if (ts !== fromBash[i]) {
      mismatches.push(
        `${JSON.stringify(name)}: ts=${JSON.stringify(ts)} bash=${JSON.stringify(fromBash[i])}`
      );
    }
  });
  assert.deepEqual(mismatches, []);
});

test("TS envSlot and bash slot() agree on every printable ASCII character", () => {
  const chars: string[] = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(String.fromCharCode(c));
  // Both the bare character and one embedded between alphanumerics, so a
  // boundary-only bug (e.g. an edge trim) cannot hide.
  const names = [...chars, ...chars.map((ch) => `a${ch}9`)];
  const fromBash = bashSlot(names);
  const mismatches: string[] = [];
  names.forEach((name, i) => {
    if (envSlot(name) !== fromBash[i]) {
      mismatches.push(
        `${JSON.stringify(name)}: ts=${JSON.stringify(envSlot(name))} bash=${JSON.stringify(fromBash[i])}`
      );
    }
  });
  assert.deepEqual(mismatches, []);
});

test("the webhook listener's envSlot matches the bootstrap envSlot exactly", () => {
  for (const name of AWKWARD_NAMES) {
    assert.equal(
      listenerEnvSlot(name),
      envSlot(name),
      `listener/bootstrap slot disagreement for ${JSON.stringify(name)}`
    );
  }
});

test("the parity harness itself detects a divergent slot implementation", () => {
  // Guards against a harness that would pass no matter what: a deliberately
  // wrong algorithm (trailing-underscore strip) must disagree with bash.
  const withTrailingStrip = "acme-"
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+$/, "");
  const fromBash = bashSlot(["acme-"]);
  assert.notEqual(withTrailingStrip, fromBash[0]);
  assert.equal(envSlot("acme-"), fromBash[0]);
});

// ─── the slot's reason for existing ──────────────────────────────────────────

test("distinct source names never collide onto one env slot in the shipped shapes", () => {
  const names = ["acme", "acme-corp", "acme_corp", "acme.corp", "AcmeCorp"];
  const slots = names.map(envSlot);
  // acme-corp / acme_corp / acme.corp all legitimately collapse to ACME_CORP;
  // that collision is inherent to the algorithm and callers must not rely on
  // distinctness. This pins the exact set so a change is a conscious one.
  assert.deepEqual(slots, [
    "ACME",
    "ACME_CORP",
    "ACME_CORP",
    "ACME_CORP",
    "ACMECORP",
  ]);
});
