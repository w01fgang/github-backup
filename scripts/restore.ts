#!/usr/bin/env node
/**
 * scripts/restore.ts
 *
 * Operator-facing restore helper for Phase 4 (Restore). Wraps the two-step
 * `git clone --mirror` + `git clone <local-mirror>` flow that README §Recovery
 * has historically documented inline. Single source of truth for the restore
 * dance — README copy-paste and scripts/verify/phase-4.ts both invoke this.
 *
 * Decisions captured in .planning/phases/04-restore/04-CONTEXT.md:
 *  - D-04: TypeScript helper, not README copy-paste — centralises path
 *    derivation, fails loud on every error, single function-shaped target
 *    for verify:phase-4.
 *  - D-domain: backups are one-way (github.com → droplet); restore is
 *    droplet → local. Helper does NOT push back to anywhere.
 *  - Working clone origin points at the LOCAL bare mirror (not the droplet,
 *    not github.com). Operator can `git remote set-url origin …` manually
 *    after restore; the helper does not choose for them.
 *
 * Usage:
 *   npm run restore -- <owner>/<repo> <target-dir>
 *
 * Exit: 0 on success, non-zero on any failure (named bail message).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, loadDropletInfo, bail } from "./lib/config";
import { sshFlags, runVisible, expandHome } from "./lib/ssh";

/** `<owner>/<repo>` slug shape — same regex used in loadConfig for restoreTestRepo. */
const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function usage(): never {
  bail("Usage: npm run restore -- <owner>/<repo> <target-dir>");
}

// --- argv parsing ----------------------------------------------------------
// process.argv: [node, scripts/restore.ts, <owner>/<repo>, <target-dir>]
const argv = process.argv.slice(2);
if (argv.length !== 2) {
  usage();
}
const [slug, rawTarget] = argv;

if (!SLUG_RE.test(slug)) {
  bail(
    `First argument must be "<owner>/<repo>" using [A-Za-z0-9._-]. ` +
      `Got: ${JSON.stringify(slug)}`
  );
}
const [owner, repo] = slug.split("/");

// rawTarget is interpolated (after path.resolve) into a double-quoted
// `git clone "${localMirrorPath}" "${workingClonePath}"` argument that
// runs through execSync. Double quotes prevent word-splitting but NOT
// command substitution ($(…) or backticks). Restrict the target path to
// an allow-list of chars before resolving, matching the SHELL_SAFE_RE
// posture from lib/config.ts. Allow `~` for home expansion and `/` for
// path separators; reject anything that could trigger shell expansion.
const TARGET_PATH_SAFE_RE = /^[A-Za-z0-9._/~@:+,= -]+$/;
if (!TARGET_PATH_SAFE_RE.test(rawTarget)) {
  bail(
    `Target path "${rawTarget}" contains characters outside ` +
      `[A-Za-z0-9._/~@:+,= -]; refusing to interpolate into git clone. ` +
      `Pick a path made of normal filename characters.`
  );
}

// --- config + droplet ------------------------------------------------------
const cfg = loadConfig();
const info = loadDropletInfo();

// --- target validation -----------------------------------------------------
const workingClonePath = path.resolve(rawTarget);
if (fs.existsSync(workingClonePath)) {
  bail(
    `Target directory already exists: ${workingClonePath}. ` +
      `Refusing to overwrite — pick a fresh path.`
  );
}

// --- path derivation -------------------------------------------------------
// Remote bare-mirror path on the droplet, matching droplet/github-backup.sh.
const remoteMirrorPath = `${cfg.backupDir}/${owner}_${repo}.git`;

// Local bare-mirror staging path in OS tempdir. Left in place on success —
// small, harmless, lets the operator re-clone offline without re-hitting the
// droplet. verify:phase-4 reads the path from this script's stdout via the
// RESTORE_LOCAL_MIRROR=<abs-path> handshake printed below.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "github-backup-restore-"));
const localMirrorPath = path.join(tmpRoot, `${owner}_${repo}.git`);

// --- step A: mirror clone from droplet -------------------------------------
// GIT_SSH_COMMAND env-prefix forces git's SSH transport to use the project's
// configured key + flags (StrictHostKeyChecking=accept-new, BatchMode, etc).
const envPrefix = `GIT_SSH_COMMAND="ssh ${sshFlags(cfg.sshKeyPath)}"`;
const mirrorCmd =
  `${envPrefix} git clone --mirror ` +
  `"${cfg.sshUser}@${info.ip}:${remoteMirrorPath}" ` +
  `"${localMirrorPath}"`;
console.log(`\n→ Cloning bare mirror from droplet:\n  ${mirrorCmd}\n`);
runVisible(mirrorCmd);

// --- step B: working clone from local bare mirror --------------------------
const workingCmd = `git clone "${localMirrorPath}" "${workingClonePath}"`;
console.log(`\n→ Cloning working copy from local mirror:\n  ${workingCmd}\n`);
runVisible(workingCmd);

// --- success ---------------------------------------------------------------
// FIRST stdout line on success MUST be the machine-readable handshake.
// verify:phase-4 parses it via /^RESTORE_LOCAL_MIRROR=(.+)$/. Do NOT rename
// or reorder this line.
console.log(`RESTORE_LOCAL_MIRROR=${localMirrorPath}`);
console.log(`\n✓ Restored ${owner}/${repo}`);
console.log(`    working clone: ${workingClonePath}`);
console.log(`    local mirror : ${localMirrorPath}  (intermediate, safe to delete)`);
console.log("");
console.log(`    Inspect refs: git -C ${workingClonePath} branch -a && git -C ${workingClonePath} tag`);
console.log(
  `    Re-point to github.com if desired: ` +
    `git -C ${workingClonePath} remote set-url origin https://github.com/${owner}/${repo}.git`
);

// expandHome is intentionally imported (parity with other scripts that use it)
// but not invoked here — sshFlags handles ~ expansion of the key path.
void expandHome;
