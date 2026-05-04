#!/usr/bin/env node
/**
 * scripts/verify/phase-1.ts
 *
 * Per-phase executable verification for Phase 1 (TEST-02 / D-06 / D-07).
 *
 * Asserts the four D-07 invariant groups against a live droplet. Exits 0
 * only when every assertion passes. Group 3 is the standalone D-02 lock
 * (mirrored == upstream && failed == 0) per plan-checker Issue 5.
 *
 * Bails fast on the first failed assertion with a message naming the
 * failed assertion. No external test framework — see CONTEXT.md "Deferred:
 * per-phase verify framework / harness".
 *
 * Usage:
 *   npm run verify:phase-1
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  loadConfig,
  loadDropletInfo,
  type Config,
  type DropletInfo,
} from "../lib/config";
import { sshFlags, runCapture, runVisible } from "../lib/ssh";
import { doctlJson, first } from "../lib/doctl";

/** BACKUP_SUMMARY contract — emitted by droplet/github-backup.sh (plan 01-03 task 1). */
const BACKUP_SUMMARY_RE =
  /^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$/;

const REMOTE_DIR = "/opt/github-backups";
const REMOTE_LOG = "/var/log/github-backup.log";
const CRON_MARKER = "# github-backup-managed";

/** Local assert — fail-fast. Prints ✓ on pass, ✗ + exit 1 on fail. */
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

interface DropletRecord {
  id: number;
  status: string;
  name: string;
}

interface FirewallRecord {
  id: string;
  name: string;
  droplet_ids: number[];
}

/**
 * Run a remote command via SSH and return trimmed stdout.
 * `sshRun` from the lib streams output via runVisible — we need stdout
 * captured, so we build the same shape locally with runCapture.
 * Single-quote wrapping mirrors sshRun: callers must not include `'` in cmd.
 */
function sshCapture(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): string {
  return runCapture(
    `ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`
  );
}

/**
 * Returns true if `ssh ... <cmd>` exits 0; false on a remote non-zero
 * exit. Re-throws on ssh transport failure (exit 255) so a network blip
 * or auth loss does not get reported as 'remote command failed'.
 */
function sshExitsZero(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): boolean {
  const cmd = `ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`;
  const r = spawnSync(cmd, { shell: true, stdio: "pipe", encoding: "utf8" });
  if (r.error) {
    throw new Error(`ssh spawn failed: ${r.error.message}`);
  }
  // OpenSSH uses 255 for any transport-layer / connection / auth failure.
  // Anything else (including 0) is the remote process's own exit status.
  if (r.status === 255) {
    const stderr = (r.stderr ?? "").trim();
    throw new Error(`ssh transport failure (exit 255): ${stderr || "no stderr"}`);
  }
  return r.status === 0;
}

function group1Provision(cfg: Config, info: DropletInfo): void {
  console.log("\n— Group 1: Provision (D-07.1) —");

  // .droplet.json existence is implicit: loadDropletInfo() bails if absent.
  assert(
    typeof info.id === "number" && info.id > 0,
    `.droplet.json carries a valid droplet id (${info.id})`
  );

  const droplet = first<DropletRecord>(
    `doctl compute droplet get ${info.id} --output json`
  );
  assert(
    droplet.status === "active",
    `doctl droplet ${info.id} status === "active" (got "${droplet.status}")`
  );

  const firewalls = doctlJson<FirewallRecord[]>(
    "doctl compute firewall list --output json"
  );
  const fw = firewalls.find((f) => f.name === cfg.firewallName);
  assert(
    !!fw,
    `firewall "${cfg.firewallName}" present in doctl firewall list`
  );
  assert(
    !!fw && Array.isArray(fw.droplet_ids) && fw.droplet_ids.includes(info.id),
    `firewall "${cfg.firewallName}" droplet_ids includes ${info.id}`
  );
}

function group2Bootstrap(cfg: Config, info: DropletInfo): void {
  console.log("\n— Group 2: Bootstrap over SSH (D-07.2) —");

  const ip = info.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // backup.env mode 600
  const envStat = sshCapture(
    ip,
    user,
    key,
    `stat -c "%a %n" ${REMOTE_DIR}/backup.env`
  );
  const mode = envStat.split(/\s+/)[0];
  assert(
    mode === "600",
    `${REMOTE_DIR}/backup.env mode === 600 (got "${mode}")`
  );

  // bootstrap.sh + install-cron.sh + github-backup.sh present + executable
  for (const script of ["bootstrap.sh", "install-cron.sh", "github-backup.sh"]) {
    assert(
      sshExitsZero(ip, user, key, `test -x ${REMOTE_DIR}/${script}`),
      `${REMOTE_DIR}/${script} present and executable`
    );
  }

  // crontab marker
  const crontab = sshCapture(ip, user, key, "crontab -l");
  assert(
    crontab.includes(CRON_MARKER),
    `crontab contains "${CRON_MARKER}" marker`
  );

  // gh auth
  assert(
    sshExitsZero(ip, user, key, "gh auth status"),
    "gh auth status exits 0 on droplet"
  );
}

function group3BackupRan(cfg: Config, info: DropletInfo): void {
  console.log(
    "\n— Group 3: Backup-ran + 100% pass bar (D-07.3 / D-02 lock) —"
  );

  const ip = info.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // Trigger a synchronous backup run. May take minutes — acceptable for verify.
  console.log(
    `   Triggering ${REMOTE_DIR}/github-backup.sh on droplet (synchronous)…`
  );
  // NR-01: REQUIRE_LOCK=1 makes the remote script block on the cron
  // lock instead of silent-exiting. Without it, an in-flight cron
  // instance would cause this trigger to no-op and the BACKUP_SUMMARY
  // assertion below would parse a stale summary from the prior run.
  runVisible(
    `ssh ${sshFlags(key)} ${user}@${ip} 'REQUIRE_LOCK=1 ${REMOTE_DIR}/github-backup.sh'`
  );

  // Tail log + match BACKUP_SUMMARY exactly once.
  const tail = sshCapture(ip, user, key, `tail -n 50 ${REMOTE_LOG}`);
  const matches = tail
    .split("\n")
    .map((l) => l.match(BACKUP_SUMMARY_RE))
    .filter((m): m is RegExpMatchArray => m !== null);

  assert(
    matches.length >= 1,
    `tail of ${REMOTE_LOG} contains at least one BACKUP_SUMMARY line (got ${matches.length})`
  );

  // Anchor on the most recent line: log is append-only, so a second run
  // will see prior summaries in the tail. Pick the latest (BL-03).
  const m = matches[matches.length - 1];
  const upstream = parseInt(m[1], 10);
  const mirrored = parseInt(m[2], 10);
  const failed = parseInt(m[3], 10);

  console.log(
    `   BACKUP_SUMMARY parsed: upstream=${upstream} mirrored=${mirrored} failed=${failed}`
  );

  // D-02 lock: 100% pass bar — mirrored must equal upstream and failed must be 0.
  assert(
    mirrored === upstream && failed === 0,
    `mirrored === upstream && failed === 0 (upstream=${upstream}, mirrored=${mirrored}, failed=${failed})`
  );

  // Cross-check: filesystem .git count must equal mirrored count.
  const fsCountStr = sshCapture(
    ip,
    user,
    key,
    `ls -1d ${REMOTE_DIR}/*.git 2>/dev/null | wc -l`
  );
  const fsCount = parseInt(fsCountStr.trim(), 10);
  assert(
    fsCount === mirrored,
    `filesystem .git count === mirrored (fs=${fsCount}, mirrored=${mirrored})`
  );
}

function group4CloneProbe(cfg: Config, info: DropletInfo): void {
  console.log("\n— Group 4: Clone-probe (D-07.4 / ACCESS-01) —");

  const ip = info.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // Pick first .git dir on the droplet.
  const firstGit = sshCapture(
    ip,
    user,
    key,
    `ls -1d ${REMOTE_DIR}/*.git 2>/dev/null | head -n1`
  );
  assert(
    firstGit.length > 0 && firstGit.endsWith(".git"),
    `at least one *.git mirror present (picked "${firstGit}")`
  );

  const repoName = path.basename(firstGit);
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-backup-verify-"));
  const cloneDest = path.join(tmpdir, repoName.replace(/\.git$/, ""));
  let cleanupOnSuccess = true;

  try {
    // git clone over SSH — drives the operator's local git through the
    // configured ssh user + key (T-01-02-03: lands inside mkdtemp).
    const sshCmd = `ssh ${sshFlags(key)}`;
    runVisible(
      `GIT_SSH_COMMAND="${sshCmd}" git clone "${user}@${ip}:${firstGit}" "${cloneDest}"`
    );
    assert(
      fs.existsSync(cloneDest),
      `git clone landed at "${cloneDest}"`
    );

    const head = runCapture(`git -C "${cloneDest}" rev-parse HEAD`);
    assert(
      /^[0-9a-f]{40}$/.test(head),
      `git rev-parse HEAD returned a 40-char hex (got "${head}")`
    );

    const refsCountStr = runCapture(
      `git -C "${cloneDest}" for-each-ref | wc -l`
    );
    const refsCount = parseInt(refsCountStr.trim(), 10);
    assert(refsCount > 0, `git for-each-ref count > 0 (got ${refsCount})`);
  } catch (err) {
    // T-01-02-03: retain tmpdir on failure for inspection.
    cleanupOnSuccess = false;
    console.error(`   Clone-probe failed — tmpdir retained at ${tmpdir}`);
    throw err;
  } finally {
    if (cleanupOnSuccess) {
      try {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const info = loadDropletInfo();

  console.log(
    `\n▶  verify:phase-1 — droplet ${info.name} (${info.id}) @ ${info.ip}\n`
  );

  group1Provision(cfg, info);
  group2Bootstrap(cfg, info);
  group3BackupRan(cfg, info);
  group4CloneProbe(cfg, info);

  console.log("\n✅  Phase 1 verification PASSED — all four D-07 groups green.\n");
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
