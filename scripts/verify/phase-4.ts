#!/usr/bin/env node
/**
 * scripts/verify/phase-4.ts
 *
 * Per-phase executable verification for ROADMAP Phase 4 (Restore).
 *
 * Asserts RESTORE-01 (workflow runs end-to-end) and RESTORE-02 (refs
 * preserved). Exits 0 only on full pass; fail-fast with named bail
 * message on first failure.
 *
 * Decisions captured in docs/DECISIONS.md (phase 04 — restore):
 *  - D-01: test repo selection via config.restoreTestRepo (optional;
 *    bails loud if unset, with hint pointing at the field).
 *  - D-02: ref-equivalence via sorted `git for-each-ref` byte-equality
 *    between droplet bare mirror and intermediate local bare mirror
 *    (NOT against the restored working clone, NOT against github.com).
 *    The working-clone vs bare-mirror namespace differs (refs/heads vs
 *    refs/remotes/origin), which is why we compare the helper's
 *    intermediate bare mirror against the droplet bare mirror — both
 *    are bare, same namespace shape, byte-equal sorted-line diff is
 *    sufficient.
 *  - D-03: no self-push assertion. ls-remote sorted equality already
 *    proves byte-equivalent refs; self-push to a throwaway bare adds
 *    zero signal beyond it and would introduce a false-positive risk
 *    (disk space, permissions on the throwaway). Do NOT "fix" this by
 *    adding a push round-trip.
 *  - D-04: invokes `npm run restore` via child_process — exercises the
 *    same code path the operator uses. Does NOT import the helper's
 *    module-level code (would bypass argv parsing + npm-script env).
 *  - D-06: on failure, `verify:phase-4` leaves the temp restore directory on
 *    disk and prints its absolute path so the operator can inspect.
 *  - D-07: `--inject-ref-mismatch` is the negative test for Group 2. The
 *    restore above clones FROM the droplet, so a divergence cannot be staged
 *    from outside this script — inject before it runs and the ref is copied
 *    into both mirrors, inject after it finishes and the comparison is over.
 *    The flag opens that window at the only point it exists, and writes to
 *    verify's own throwaway mirror under the OS temp dir: the droplet is
 *    never written to, so a killed run cannot leave a mirror carrying a
 *    stray ref that later poisons a real verification.
 *
 * No droplet lock acquired: restore is read-only; git pack-objects is
 * read-safe vs `remote update --prune` (CONTEXT.md "Established
 * Patterns"). Do not "fix" this by adding a lock-acquire step.
 *
 * Wall-clock cap: bounded by the configured restoreTestRepo size — one
 * clone-from-droplet + one local clone + two for-each-ref invocations.
 * No hard timeout: if the operator picks a 5-GB monorepo as their test
 * repo, that is a config choice, not a verify-script defect. Pick a
 * small repo with at least one tag for full coverage.
 *
 * Usage:
 *   npm run verify:phase-4
 *   npm run verify:phase-4 -- --inject-ref-mismatch   # negative test; exit 1 is the pass
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { loadConfig, loadDropletInfo, bail } from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const RESTORE_HANDSHAKE_RE = /^RESTORE_LOCAL_MIRROR=(.+)$/;
const INJECTED_REF = "refs/heads/__verify_mismatch__";
const injectRefMismatch = process.argv.slice(2).includes("--inject-ref-mismatch");

/** Local assert — fail-fast. Prints ✓ on pass, ✗ + exit 1 on fail. */
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const cfg = loadConfig();
const info = loadDropletInfo();

// --- Group 0: pre-flight (D-01) -------------------------------------------
console.log("\n— Group 0: Pre-flight (D-01) —");

if (!cfg.restoreTestRepo) {
  bail(
    `config.restoreTestRepo is not set. ` +
      `Set it to a "<owner>/<repo>" you have a mirror of on the droplet, ` +
      `e.g. "sumin/dotfiles". The verify script restores that repo into a ` +
      `temporary directory and diffs its refs against the droplet mirror.`
  );
}
const slug = cfg.restoreTestRepo;
// Defence in depth: loadConfig validated this already, but the entry point
// could change in future. A bypass would otherwise reach `git clone` argv.
if (!SLUG_RE.test(slug)) {
  bail(
    `config.restoreTestRepo "${slug}" is not a valid "<owner>/<repo>" slug ` +
      `(allowed: [A-Za-z0-9._-]).`
  );
}
const [owner, repo] = slug.split("/");
console.log(`✓ config.restoreTestRepo === "${slug}"`);

// --- Group 1: restore runs (RESTORE-01) -----------------------------------
console.log("\n— Group 1: Restore runs (RESTORE-01) —");

const restoreRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "github-backup-verify-phase-4-")
);
const target = path.join(restoreRoot, "working");
console.log(`   Restoring ${slug} into ${target}…`);

// Pipe stdout only — restore.ts writes exactly one thing there: the
// RESTORE_LOCAL_MIRROR= handshake, as stdout's first line. Progress and the
// success summary go to the helper's own stderr, which stays on inherit so
// the operator sees them directly as they happen.
//
// `--silent` is load-bearing, not tidiness: npm prints its own
// `> github-backup@1.0.0 restore` banner to the child's *stdout*, which lands
// ahead of the handshake and breaks the first-line contract below. The UAT
// runner's p04-01 step already invokes `npm run --silent restore` for the same
// reason.
const r = spawnSync("npm", ["run", "--silent", "restore", "--", slug, target], {
  stdio: ["inherit", "pipe", "inherit"],
  env: process.env,
  encoding: "utf8",
});

const restoreStdout = r.stdout ?? "";
// Echo the handshake back to our own stdout too, in case anything pipes
// verify:phase-4's stdout looking for it.
if (restoreStdout) process.stdout.write(restoreStdout);

if (r.status !== 0) {
  console.error(
    `\n✗ npm run restore exited ${r.status} for ${slug}. ` +
      `Temp directory left on disk for inspection:\n  ${restoreRoot}`
  );
  process.exit(1);
}
assert(r.status === 0, `npm run restore -- ${slug} ${target} exit 0`);

// Parse the inter-plan handshake off stdout's FIRST line — restore.ts's
// stdout contract reserves that line exclusively for the handshake, so
// anything else there is a contract violation, not a line to search past.
const firstStdoutLine = restoreStdout.split("\n", 1)[0] ?? "";
const handshake = firstStdoutLine.match(RESTORE_HANDSHAKE_RE);
if (!handshake) {
  console.error(
    `\n✗ helper's first stdout line was not the "RESTORE_LOCAL_MIRROR=<path>" ` +
      `handshake (got: ${JSON.stringify(firstStdoutLine)}). Temp directory ` +
      `left at: ${restoreRoot}`
  );
  process.exit(1);
}
const localBareMirrorPath = handshake[1].trim();
assert(
  fs.existsSync(localBareMirrorPath),
  `local bare mirror exists at ${localBareMirrorPath}`
);
assert(
  fs.existsSync(target),
  `restored working clone exists at ${target}`
);

// --- Negative-test injection (D-07) ---------------------------------------
let injectedRef = INJECTED_REF;
if (injectRefMismatch) {
  // One listing answers both questions below.
  const refsRes = spawnSync(
    "git",
    ["-C", localBareMirrorPath, "for-each-ref", "--format=%(objectname) %(refname)"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
  const refLines = (refsRes.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (refsRes.status !== 0 || refLines.length === 0) {
    bail(
      `--inject-ref-mismatch: ${localBareMirrorPath} has no ref to anchor the ` +
        `injected ref to, so the mismatch cannot be staged.\n` +
        `    ${(refsRes.stderr ?? "").trim()}`
    );
  }

  // Anchor on an object the mirror definitely has. `HEAD` is not that object:
  // a mirror whose upstream default branch was renamed keeps a symbolic HEAD
  // pointing at a ref that no longer exists — `remote update --prune` in
  // droplet/sync-one-repo.sh never refreshes it — and every other group here
  // is happy with such a mirror. Resolving HEAD would fail the negative test
  // for a reason that has nothing to do with the detector.
  const anchor = refLines[0].split(" ")[0];

  // `__verify_mismatch__` is a legal upstream branch name. If the repo already
  // carries it the mirror does too, `update-ref` writes what is already there,
  // the two ref sets stay equal and the run exits 2 accusing a detector that
  // works. Suffix until the name is genuinely absent.
  const existing = new Set(refLines.map((l) => l.slice(l.indexOf(" ") + 1)));
  for (let n = 1; existing.has(injectedRef); n++) {
    injectedRef = `${INJECTED_REF}-${n}`;
  }

  const inj = spawnSync(
    "git",
    ["-C", localBareMirrorPath, "update-ref", injectedRef, anchor],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
  if (inj.status !== 0) {
    bail(
      `--inject-ref-mismatch: could not write ${injectedRef} into ` +
        `${localBareMirrorPath}\n    ${(inj.stderr ?? "").trim()}`
    );
  }
  console.log(
    `\n⚑ --inject-ref-mismatch: wrote ${injectedRef} -> ${anchor} into the ` +
      `restored bare mirror only.\n   Group 2 must now report local-only count ` +
      `1 and exit 1 — that is the PASS condition for this run.`
  );
}

// --- Group 2: refs match (RESTORE-02 via D-02) ----------------------------
console.log("\n— Group 2: Ref equivalence (RESTORE-02 / D-02) —");

// Multi-source layout: mirrors live under <backupDir>/<source>/<owner>_<repo>.git
// and the source dir is not derivable from owner alone (a source may back up
// repos owned by other accounts). Resolve the actual path by globbing.
let mirrorMatches: string[];
try {
  mirrorMatches = runCapture(
    `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${info.ip} ` +
      // `|| true`: an unmatched glob makes ls exit non-zero, which would throw
      // into the SSH-error branch below; force exit 0 so zero matches reach the
      // length===0 "no mirror" bail. A real SSH failure still throws (ssh exits
      // 255 before the remote command runs).
      `'ls -1d ${cfg.backupDir}/*/${owner}_${repo}.git 2>/dev/null || true'`
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
} catch (e) {
  bail(
    `Could not list mirrors on ${cfg.sshUser}@${info.ip} over SSH. ` +
      `Check the droplet is reachable and the SSH key has access. ` +
      `(${e instanceof Error ? e.message.split("\n")[0] : e})`
  );
}
if (mirrorMatches.length === 0) {
  bail(
    `No mirror for ${owner}/${repo} found under ${cfg.backupDir}/*/ on the droplet. ` +
      `Run a backup first or check config.restoreTestRepo.`
  );
}
if (mirrorMatches.length > 1) {
  bail(
    `Ambiguous: ${owner}/${repo} is mirrored under ${mirrorMatches.length} sources:\n` +
      mirrorMatches.map((m) => `  ${m}`).join("\n") +
      `\nThe same repo is backed up by more than one source — refusing to guess.`
  );
}
const remoteMirrorPath = mirrorMatches[0];
const remoteCmd =
  `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${info.ip} ` +
  `'git -C "${remoteMirrorPath}" for-each-ref --format="%(objectname) %(refname)" | sort'`;
const localCmd =
  `git -C "${localBareMirrorPath}" for-each-ref ` +
  `--format="%(objectname) %(refname)" | sort`;

const remoteLs = runCapture(remoteCmd);
const localLs = runCapture(localCmd);

assert(
  remoteLs.length > 0,
  `droplet mirror ${remoteMirrorPath} has at least one ref`
);
assert(
  localLs.length > 0,
  `local bare mirror ${localBareMirrorPath} has at least one ref`
);

const remoteSet = new Set(remoteLs.split("\n").filter((l) => l.length));
const localSet = new Set(localLs.split("\n").filter((l) => l.length));
const remoteOnly = [...remoteSet].filter((l) => !localSet.has(l));
const localOnly = [...localSet].filter((l) => !remoteSet.has(l));

if (remoteOnly.length > 0 || localOnly.length > 0) {
  console.error(
    `\n✗ ref mismatch between droplet mirror and restored bare mirror`
  );
  console.error(`    remote-only count: ${remoteOnly.length}`);
  console.error(`    local-only count : ${localOnly.length}`);
  if (remoteOnly.length > 0) {
    console.error(`    first ${Math.min(3, remoteOnly.length)} remote-only:`);
    remoteOnly.slice(0, 3).forEach((l) => console.error(`      ${l}`));
  }
  if (localOnly.length > 0) {
    console.error(`    first ${Math.min(3, localOnly.length)} local-only:`);
    localOnly.slice(0, 3).forEach((l) => console.error(`      ${l}`));
  }
  console.error(`    Temp directory left on disk: ${restoreRoot}`);
  console.error(`    Intermediate bare mirror   : ${localBareMirrorPath}`);
  process.exit(1);
}
if (injectRefMismatch) {
  console.error(
    `\n✗ --inject-ref-mismatch: Group 2 compared clean despite ${injectedRef} ` +
      `being present in ${localBareMirrorPath}.\n` +
      `    The ref-mismatch detector is not detecting. Exit 2 (negative test failed).`
  );
  process.exit(2);
}
assert(
  true,
  `sorted for-each-ref output byte-equal between droplet mirror and ` +
    `local bare mirror (${remoteSet.size} refs)`
);

// --- Group 3: branches + tags sanity (RESTORE-02 belt-and-braces) ---------
console.log("\n— Group 3: Branch + tag presence sanity —");

const hasBranches = [...localSet].some((l) => l.includes("refs/heads/"));
assert(
  hasBranches,
  `restored bare mirror has at least one refs/heads/* (branch)`
);

const hasTags = [...localSet].some((l) => l.includes("refs/tags/"));
if (!hasTags) {
  console.warn(
    `⚠ restoreTestRepo "${slug}" has no tags — tag-preservation coverage ` +
      `is vacuous. Pick a tagged repo for full RESTORE-02 coverage. NOT a ` +
      `failure (per plan 04-02 task 1 step 8).`
  );
} else {
  console.log(`✓ restored bare mirror has at least one refs/tags/* (tag)`);
}

// --- Cleanup on success ----------------------------------------------------
fs.rmSync(restoreRoot, { recursive: true, force: true });
// We also remove the helper's intermediate bare mirror tempdir to keep
// /tmp tidy after a passing verify run. On failure (above) we leave both
// in place per D-06 so the operator can inspect.
const localMirrorParent = path.dirname(localBareMirrorPath);
if (
  localMirrorParent.startsWith(os.tmpdir()) &&
  path.basename(localMirrorParent).startsWith("github-backup-restore-")
) {
  fs.rmSync(localMirrorParent, { recursive: true, force: true });
}

console.log("\n✅ verify:phase-4 PASS");
process.exit(0);
