#!/usr/bin/env node
/**
 * scripts/smoke-test.ts
 *
 * End-to-end smoke runner for Phase 1 (TEST-01 / D-03 / D-04 / D-05).
 *
 * Orchestrates the live pipeline against real DigitalOcean infrastructure
 * and the operator's real GitHub user (D-01) at the 100%-pass bar (D-02):
 *
 *   1. provision via npm run create-droplet                (PROV-01)
 *   2. bootstrap via npm run bootstrap-droplet             (PROV-02 + BACKUP-03)
 *   3. trigger /opt/github-backups/github-backup.sh remotely (BACKUP-01/02)
 *   4. SSH-probe — confirm at least one *.git mirror exists  (BACKUP-02)
 *   5. clone-probe — git clone one mirror over SSH locally  (ACCESS-01)
 *   6. parse BACKUP_SUMMARY marker — enforce 100% pass     (D-02)
 *
 * Default behaviour leaves the droplet alive. Re-runnable.
 *
 * Re-provisioning from scratch: delete the droplet manually from the DO
 * dashboard (and remove `.droplet.json` locally), then re-run. Automated
 * teardown is intentionally not provided — see PROJECT.md (2026-05-11).
 *
 * Usage:
 *   npm run smoke-test
 *
 * Required env: GITHUB_TOKEN (passed through to bootstrap).
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bail, loadConfig, loadDropletInfo } from "./lib/config";
import { runCapture, runVisible, sshFlags, sshRun } from "./lib/ssh";

/** BACKUP_SUMMARY contract — emitted by droplet/github-backup.sh (plan 01-03 step 0). */
const BACKUP_SUMMARY_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$/m;

const REMOTE_DIR = "/opt/github-backups";
const REMOTE_LOG = "/var/log/github-backup.log";
const REMOTE_BACKUP = `${REMOTE_DIR}/github-backup.sh`;

/**
 * Run another npm script in this project. Streams output. Returns exit code.
 * No throw — caller decides whether non-zero is fatal (destroy is best-effort,
 * create + bootstrap are fatal).
 */
function runNpmScript(scriptName: string, extraArgs: string[] = []): number {
  const args = ["run", scriptName];
  if (extraArgs.length > 0) {
    args.push("--", ...extraArgs);
  }
  const r = spawnSync("npm", args, {
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) {
    bail(`Failed to spawn 'npm ${args.join(" ")}': ${r.error.message}`);
  }
  return r.status ?? 1;
}

/**
 * Run a remote command via SSH and return trimmed stdout.
 * Mirrors the single-quote wrapping contract of sshRun — callers must not
 * include `'` in remoteCmd. Throws on non-zero.
 */
function sshCapture(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): string {
  return runCapture(`ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`);
}

/** Step 1: provision via npm run create-droplet. PROV-01. Fatal on non-zero. */
function provision(): void {
  console.log("\n🚀  Provisioning droplet (npm run create-droplet)…");
  const code = runNpmScript("create-droplet");
  if (code !== 0) bail(`create-droplet failed (exit ${code})`);
}

/** Step 4: bootstrap via npm run bootstrap-droplet. PROV-02 + BACKUP-03. */
function bootstrap(): void {
  // NR-05: trim before checking — a trailing CR or wrapping whitespace
  // would otherwise pass through to bootstrap-droplet.ts where it
  // surfaces as a confusing "characters outside" shape error.
  if (!(process.env["GITHUB_TOKEN"] ?? "").trim()) {
    bail(
      "GITHUB_TOKEN environment variable is not set (or is empty after trim).\n" +
        "    Usage: GITHUB_TOKEN=<your_pat> npm run smoke-test"
    );
  }
  console.log("\n📦  Bootstrapping droplet (npm run bootstrap-droplet)…");
  const code = runNpmScript("bootstrap-droplet");
  if (code !== 0) bail(`bootstrap-droplet failed (exit ${code})`);
}

/** Step 5: trigger backup remotely. BACKUP-01 / BACKUP-02. Synchronous.
 *
 * NR-08: returns the droplet-local timestamp captured *before* the trigger
 * so enforcePassBar can filter out a cron-fired BACKUP_SUMMARY that sneaks
 * in between trigger-return and tail-read. Same YYYY-MM-DD HH:MM:SS shape
 * github-backup.sh writes in its log prefix, so a lexicographic >= compare
 * is monotonic and correct.
 */
function triggerBackup(ip: string, user: string, keyPath: string): string {
  console.log(`\n🔁  Triggering ${REMOTE_BACKUP} on droplet (synchronous)…`);
  const tStart = sshCapture(
    ip,
    user,
    keyPath,
    `date "+%Y-%m-%d %H:%M:%S"`
  ).trim();
  try {
    // NR-01: REQUIRE_LOCK=1 makes the remote script block on the cron
    // lock instead of silent-exiting. Without this, a mid-run cron
    // instance would cause this trigger to no-op and verify/smoke would
    // assert against a stale BACKUP_SUMMARY from the previous run.
    sshRun(ip, user, keyPath, `REQUIRE_LOCK=1 ${REMOTE_BACKUP}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    bail(`Remote github-backup.sh failed: ${msg}`);
  }
  return tStart;
}

/**
 * Step 6: SSH-probe — return the path of one mirror on the droplet.
 * Verifies at least one *.git directory exists in REMOTE_DIR.
 */
function pickRemoteMirror(ip: string, user: string, keyPath: string): string {
  const out = sshCapture(
    ip,
    user,
    keyPath,
    `ls -1d ${REMOTE_DIR}/*.git 2>/dev/null | head -n 1`
  );
  if (!out) {
    bail(
      `SSH-probe failed: no *.git mirror found in ${REMOTE_DIR} on droplet`
    );
  }
  console.log(`   SSH-probe: found mirror ${out}`);
  return out;
}

/**
 * Step 7: clone-probe locally over SSH. ACCESS-01.
 * mkdtemps a unique dir, clones, asserts HEAD + refs, cleans up on success.
 */
function cloneProbe(
  ip: string,
  user: string,
  keyPath: string,
  remoteMirrorPath: string
): void {
  const remoteName = path.basename(remoteMirrorPath); // e.g. owner_name.git
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-backup-smoke-"));
  const localTarget = path.join(tmpDir, remoteName);
  const gitSshCmd = `ssh ${sshFlags(keyPath)}`;
  const cloneUrl = `${user}@${ip}:${remoteMirrorPath}`;

  console.log(`\n📥  Clone-probe: cloning ${cloneUrl} into ${localTarget}…`);
  let cleanupOnSuccess = true;
  try {
    runVisible(
      `GIT_SSH_COMMAND='${gitSshCmd}' git clone "${cloneUrl}" "${localTarget}"`
    );

    const head = runCapture(`git -C "${localTarget}" rev-parse HEAD`);
    if (!/^[0-9a-f]{40}$/.test(head)) {
      bail(`clone-probe: HEAD is not a 40-char hex (got "${head}")`);
    }

    const refsCount = parseInt(
      runCapture(
        `git -C "${localTarget}" for-each-ref | wc -l`
      ).trim(),
      10
    );
    if (!Number.isFinite(refsCount) || refsCount <= 0) {
      bail(`clone-probe: cloned repo has no refs (got ${refsCount})`);
    }

    console.log(
      `   Clone-probe OK — HEAD=${head.slice(0, 12)} refs=${refsCount}`
    );
  } catch (err: unknown) {
    // WR-08: a spurious rmSync error must not masquerade as a probe
    // failure. Mark cleanup off and preserve tmpdir only when the probe
    // itself raised. Mirrors the verify/phase-1.ts pattern.
    cleanupOnSuccess = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `   Clone-probe failed; tmpdir preserved at ${tmpDir} for inspection.`
    );
    bail(`clone-probe: ${msg}`);
  } finally {
    if (cleanupOnSuccess) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Step 8: parse BACKUP_SUMMARY from tail of /var/log/github-backup.log.
 * Enforce mirrored == upstream && failed == 0 (D-02). Cross-check filesystem
 * count of *.git dirs == mirrored.
 *
 * Bash is the single source of truth for the upstream count — we do NOT
 * re-derive it via gh api here.
 *
 * NR-08: tStart is the droplet-local timestamp captured before the trigger
 * fired. Filter matches by timestamp >= tStart so a cron run that fires
 * inside the trigger → tail-read window cannot masquerade as ours.
 */
function enforcePassBar(
  ip: string,
  user: string,
  keyPath: string,
  tStart: string
): void {
  console.log("\n🔢  Parsing BACKUP_SUMMARY marker…");
  const tail = sshCapture(ip, user, keyPath, `tail -n 50 ${REMOTE_LOG}`);
  const allMatches = tail
    .split("\n")
    .map((l) => l.match(BACKUP_SUMMARY_RE))
    .filter((mm): mm is RegExpMatchArray => mm !== null);
  // Lexicographic compare on fixed-width same-tz YYYY-MM-DD HH:MM:SS is
  // monotonic, so `>= tStart` correctly excludes pre-trigger summaries.
  const matches = allMatches.filter((mm) => mm[1] >= tStart);
  // Earliest post-tStart match is our triggered run; a later one would be
  // a cron run that fired after we released the lock.
  const m = matches[0];
  if (!m) {
    bail(
      `BACKUP_SUMMARY line at or after tStart=${tStart} not found in tail of ${REMOTE_LOG}.\n` +
        "    The droplet/github-backup.sh marker line did not run or did not flush.\n" +
        `    (${allMatches.length} total summaries in tail; none post-tStart.)\n` +
        `    Last 50 lines of ${REMOTE_LOG}:\n${tail}`
    );
  }
  const upstream = parseInt(m[2], 10);
  const mirrored = parseInt(m[3], 10);
  const failed = parseInt(m[4], 10);
  console.log(
    `   BACKUP_SUMMARY: upstream=${upstream} mirrored=${mirrored} failed=${failed}`
  );

  if (!(mirrored === upstream && failed === 0)) {
    console.error(
      `SMOKE: FAIL — upstream=${upstream} mirrored=${mirrored} failed=${failed};` +
        ` see ${REMOTE_LOG} on droplet`
    );
    process.exit(1);
  }

  // Cross-check filesystem count.
  const fsCountStr = sshCapture(
    ip,
    user,
    keyPath,
    `ls -1d ${REMOTE_DIR}/*.git 2>/dev/null | wc -l`
  );
  const fsCount = parseInt(fsCountStr.trim(), 10);
  if (fsCount !== mirrored) {
    bail(
      `Filesystem mirror count (${fsCount}) does not match BACKUP_SUMMARY mirrored (${mirrored})`
    );
  }
  console.log(`   Filesystem cross-check OK — ${fsCount} *.git dirs`);
}

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════");
  console.log(" github-backup smoke-test (Phase 1 / TEST-01)");
  console.log("══════════════════════════════════════════════════════════");

  // BL-04: validate GITHUB_TOKEN before any billable action so a missing
  // PAT never produces an unbootstrapped, useless, billed droplet.
  // NR-05: trim before checking so trailing CR / wrapping whitespace
  // does not slip through to the shape-check at writeBackupEnv.
  if (!(process.env["GITHUB_TOKEN"] ?? "").trim()) {
    bail(
      "GITHUB_TOKEN environment variable is not set (or is empty after trim).\n" +
        "    Usage: GITHUB_TOKEN=<your_pat> npm run smoke-test"
    );
  }

  // Step 1: provision.
  provision();

  // Step 3: load droplet info.
  const droplet = loadDropletInfo();
  const cfg = loadConfig();
  const { ip } = droplet;
  const user = cfg.sshUser;
  const keyPath = cfg.sshKeyPath;

  // Step 4: bootstrap.
  bootstrap();

  // Step 5: trigger backup.
  const tStart = triggerBackup(ip, user, keyPath);

  // Step 6: SSH-probe.
  const remoteMirrorPath = pickRemoteMirror(ip, user, keyPath);

  // Step 7: clone-probe.
  cloneProbe(ip, user, keyPath, remoteMirrorPath);

  // Step 8: 100%-pass enforcement via BACKUP_SUMMARY.
  enforcePassBar(ip, user, keyPath, tStart);

  // Step 9: success — droplet preserved (D-04 / D-08).
  console.log(`\n✅  SMOKE: PASS — droplet preserved at ${ip}\n`);
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
