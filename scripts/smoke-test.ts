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

/** Phase 6 D-16: per-source SUMMARY emitted alongside the aggregate. */
const SOURCE_SUMMARY_RE =
  /BACKUP_SOURCE_SUMMARY source=(\S+) upstream=(\d+) mirrored=(\d+) failed=(\d+)/g;

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
 * Verifies at least one *.git directory exists under REMOTE_DIR.
 *
 * Phase 6: mirrors live at ${REMOTE_DIR}/<source>/<owner>_<repo>.git, not at
 * the top level. find -maxdepth 2 covers both layouts (the top-level Phase 1
 * pattern is also caught at maxdepth 1) so this probe works during the
 * migration window too.
 */
function pickRemoteMirror(ip: string, user: string, keyPath: string): string {
  const out = sshCapture(
    ip,
    user,
    keyPath,
    `find ${REMOTE_DIR} -maxdepth 2 -type d -name "*.git" 2>/dev/null | head -n 1`
  );
  if (!out) {
    bail(
      `SSH-probe failed: no *.git mirror found under ${REMOTE_DIR} on droplet`
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

  // Phase 6 D-16: per-source BACKUP_SOURCE_SUMMARY appears once per source.
  // Parse the same tail and assert: count matches cfg.sources, source names
  // match cfg.sources names (set equality), and per-source aggregates sum to
  // the aggregate BACKUP_SUMMARY upstream/mirrored. Additive assertion: the
  // single-source legacy case sees exactly 1 BACKUP_SOURCE_SUMMARY line which
  // trivially passes.
  const cfgPhase6 = loadConfig();
  const sourceMatches: { source: string; upstream: number; mirrored: number; failed: number }[] = [];
  // Re-fetch a wider tail for the source summaries — they appear once per
  // source so a 2-source run has 2 lines somewhere in the post-tStart window.
  const wideTail = sshCapture(ip, user, keyPath, `tail -n 500 ${REMOTE_LOG}`);
  const tsRe = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;
  for (const line of wideTail.split("\n")) {
    const tsMatch = line.match(tsRe);
    if (!tsMatch || tsMatch[1] < tStart) continue;
    SOURCE_SUMMARY_RE.lastIndex = 0;
    const mm = SOURCE_SUMMARY_RE.exec(line);
    if (mm) {
      sourceMatches.push({
        source: mm[1],
        upstream: parseInt(mm[2], 10),
        mirrored: parseInt(mm[3], 10),
        failed: parseInt(mm[4], 10),
      });
    }
  }

  const expectedSources = cfgPhase6.sources.map((s) => s.name);
  if (sourceMatches.length !== expectedSources.length) {
    bail(
      `Phase 6 D-16: expected ${expectedSources.length} BACKUP_SOURCE_SUMMARY ` +
        `line(s) post-tStart, got ${sourceMatches.length}`
    );
  }
  const observedSorted = sourceMatches.map((m) => m.source).sort();
  const expectedSorted = [...expectedSources].sort();
  if (JSON.stringify(observedSorted) !== JSON.stringify(expectedSorted)) {
    bail(
      `Phase 6 D-16: BACKUP_SOURCE_SUMMARY source= values do not match cfg.sources: ` +
        `got ${JSON.stringify(observedSorted)} expected ${JSON.stringify(expectedSorted)}`
    );
  }
  const sumUpstream = sourceMatches.reduce((a, m) => a + m.upstream, 0);
  const sumMirrored = sourceMatches.reduce((a, m) => a + m.mirrored, 0);
  const sumFailed = sourceMatches.reduce((a, m) => a + m.failed, 0);
  if (sumMirrored !== sumUpstream || sumFailed !== 0) {
    bail(
      `Phase 6 D-16 100%-pass: per-source mirrored=${sumMirrored} upstream=${sumUpstream} failed=${sumFailed}`
    );
  }
  if (upstream !== sumUpstream) {
    bail(
      `Phase 6 D-16 sum check: aggregate upstream ${upstream} != sum of per-source upstream ${sumUpstream}`
    );
  }
  console.log(
    `   Per-source SUMMARY OK — ${sourceMatches.length} source(s), aggregate matches sum`
  );

  // Per-source SSH probe — for each source, assert at least one *.git exists
  // under ${REMOTE_DIR}/<source>/. Soft-skip a source whose filtered upstream
  // is zero (the operator may have denied everything for that source).
  for (const s of cfgPhase6.sources) {
    const cnt = parseInt(
      sshCapture(
        ip,
        user,
        keyPath,
        `ls -1d ${REMOTE_DIR}/${s.name}/*.git 2>/dev/null | wc -l`
      ).trim(),
      10
    );
    if (cnt === 0) {
      console.log(
        `   [soft] ${REMOTE_DIR}/${s.name}/ has 0 *.git mirrors (filtered out, or upstream empty)`
      );
    } else {
      console.log(`   ${REMOTE_DIR}/${s.name}/ has ${cnt} *.git mirror(s)`);
    }
  }

  // Cross-check filesystem count.
  // Phase 6: mirrors are at ${REMOTE_DIR}/<source>/<owner>_<repo>.git.
  // find -maxdepth 2 also catches the legacy Phase 1 top-level layout
  // during the migration window.
  const fsCountStr = sshCapture(
    ip,
    user,
    keyPath,
    `find ${REMOTE_DIR} -maxdepth 2 -type d -name "*.git" 2>/dev/null | wc -l`
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
