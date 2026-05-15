#!/usr/bin/env node
/**
 * scripts/verify/phase-5.ts
 *
 * Phase 5 verification (TEARDOWN-01 / D-11 / D-12 + listener-survival
 * Group 5). Mostly non-destructive: Group 4 mutates `backup.env` on the
 * droplet only if `GITHUB_TOKEN` is set in the verify script's environment.
 * Group 5 is a no-op if the Phase 3 webhook unit is not installed.
 * Assumes `verify:phase-1` has previously passed (CONTEXT D-14).
 *
 * Bails fast on the first failed assertion with a message naming the
 * failed assertion. No external test framework — see Phase 1 CONTEXT.md
 * "Deferred: per-phase verify framework / harness".
 *
 * Usage:
 *   npm run verify:phase-5
 */

import { spawnSync } from "child_process";
import {
  loadConfig,
  loadDropletInfo,
  bail,
  type Config,
  type DropletInfo,
} from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";
import { doctlJson, first } from "../lib/doctl";

const CRON_MARKER = "# github-backup-managed";
const LISTENER_UNIT = "github-backup-webhook.service";

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

/**
 * Run a remote command via SSH and return trimmed stdout.
 * Single-quote wrapping mirrors sshRun: callers must not include `'` in cmd.
 * (CONTEXT D-Discretion bullet 3 explicitly approves duplicating this from
 * scripts/verify/phase-1.ts; lib extraction is deferred.)
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
 * Mirrors phase-1.ts NR-04 handling: signal-killed and null-status are
 * treated as transport-class failures.
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
  if (r.signal) {
    throw new Error(`ssh killed by signal ${r.signal}`);
  }
  if (r.status === null) {
    throw new Error("ssh exited without a status (no signal reported)");
  }
  if (r.status === 255) {
    const stderr = (r.stderr ?? "").trim();
    throw new Error(
      `ssh transport failure (exit 255): ${stderr || "no stderr"}`
    );
  }
  return r.status === 0;
}

function group1PreConditions(
  cfg: Config,
  info: DropletInfo,
  ip: string,
  user: string,
  keyPath: string,
  backupDir: string
): void {
  console.log("\n— Group 1: Pre-conditions —");
  void cfg;

  // Droplet status
  const droplet = first<DropletRecord>(
    `doctl compute droplet get ${info.id} -o json`
  );
  assert(
    droplet.status === "active",
    `droplet ${info.id} status is "active" (got "${droplet.status}")`
  );

  // backup.env mode 600
  const modeLine = sshCapture(
    ip,
    user,
    keyPath,
    `stat -c "%a %n" "${backupDir}/backup.env"`
  );
  const mode = modeLine.split(/\s+/)[0];
  assert(
    mode === "600",
    `${backupDir}/backup.env mode is 600 (got "${mode}")`
  );

  // Cron marker count: exactly 1. The `grep -v '^#'` strips full-comment
  // lines as defense against a self-counting marker (CONTEXT D-Discretion
  // grep-gate hygiene). Marker is appended to the cron *line*, not on its
  // own comment line, so this is cheap insurance.
  const cronCount = sshCapture(
    ip,
    user,
    keyPath,
    `crontab -l 2>/dev/null | grep -v "^#" | grep -c "${CRON_MARKER}" || true`
  ).trim();
  assert(
    cronCount === "1",
    `exactly one ${CRON_MARKER} line in crontab (got ${cronCount})`
  );
}

function group2PreservationAndProbes(
  ip: string,
  user: string,
  keyPath: string,
  backupDir: string
): {
  listenerInstalled: boolean;
  listenerActiveBefore: boolean;
} {
  console.log(
    "\n— Group 2: backup.env preservation across re-run (no --rotate-env) —"
  );

  // Capture pre-state
  const h1 = sshCapture(
    ip,
    user,
    keyPath,
    `sha256sum "${backupDir}/backup.env" | awk "{print \\$1}"`
  );
  const m1 = sshCapture(
    ip,
    user,
    keyPath,
    `stat -c %Y "${backupDir}/backup.env"`
  );

  // Listener pre-state (probe-gated). Capture before Group 2's re-run so
  // we can prove the listener survived (SC#3) — restructured per plan
  // 05-02 task 1 listener-survival "two-pass structure".
  const listenerInstalled = sshExitsZero(
    ip,
    user,
    keyPath,
    `test -f /etc/systemd/system/${LISTENER_UNIT} -o -f /lib/systemd/system/${LISTENER_UNIT}`
  );
  let listenerActiveBefore = false;
  if (listenerInstalled) {
    listenerActiveBefore = sshExitsZero(
      ip,
      user,
      keyPath,
      `systemctl is-active --quiet ${LISTENER_UNIT}`
    );
  }

  // Re-run bootstrap with GITHUB_TOKEN forced empty in the child env so an
  // operator-set token in our parent shell cannot surprise-rotate the
  // backup.env mid-check (T-05-05 mitigation per plan 05-02 STRIDE).
  const childEnv = { ...process.env, GITHUB_TOKEN: "" };
  const r = spawnSync("npm", ["run", "bootstrap-droplet"], {
    stdio: "inherit",
    env: childEnv,
  });
  if (r.signal) {
    throw new Error(
      `bootstrap-droplet child killed by signal ${r.signal}`
    );
  }
  assert(
    r.status === 0,
    `bootstrap re-run (no --rotate-env) exited cleanly (status=${r.status})`
  );

  // Re-capture post-state
  const h2 = sshCapture(
    ip,
    user,
    keyPath,
    `sha256sum "${backupDir}/backup.env" | awk "{print \\$1}"`
  );
  const m2 = sshCapture(
    ip,
    user,
    keyPath,
    `stat -c %Y "${backupDir}/backup.env"`
  );
  const modeLine2 = sshCapture(
    ip,
    user,
    keyPath,
    `stat -c "%a %n" "${backupDir}/backup.env"`
  );
  const mode2 = modeLine2.split(/\s+/)[0];

  assert(h1 === h2, "backup.env sha256 unchanged across re-run");
  assert(m1 === m2, "backup.env mtime unchanged across re-run");
  assert(
    mode2 === "600",
    `backup.env mode still 600 after re-run (got "${mode2}")`
  );

  return { listenerInstalled, listenerActiveBefore };
}

function group3CronMarkerInvariant(
  ip: string,
  user: string,
  keyPath: string
): void {
  console.log("\n— Group 3: Cron-marker invariant after re-run —");
  const n2 = sshCapture(
    ip,
    user,
    keyPath,
    `crontab -l 2>/dev/null | grep -v "^#" | grep -c "${CRON_MARKER}" || true`
  ).trim();
  // Integer equality, NOT >=1 — D-12.3 / plan 05-02 task 1 explicit.
  assert(
    n2 === "1",
    `exactly one ${CRON_MARKER} line in crontab after re-run (got ${n2})`
  );
}

function group4RotateEnvRoundTrip(
  ip: string,
  user: string,
  keyPath: string,
  backupDir: string
): void {
  console.log("\n— Group 4: --rotate-env round-trip (env-gated) —");
  const tok = (process.env["GITHUB_TOKEN"] ?? "").trim();
  if (!tok) {
    console.log(
      "⚠ skipping --rotate-env round-trip (GITHUB_TOKEN unset)"
    );
    return;
  }

  const r = spawnSync(
    "npm",
    ["run", "bootstrap-droplet", "--", "--rotate-env"],
    { stdio: "inherit" }
  );
  if (r.signal) {
    throw new Error(
      `bootstrap-droplet --rotate-env child killed by signal ${r.signal}`
    );
  }
  assert(
    r.status === 0,
    `--rotate-env bootstrap exited cleanly (status=${r.status})`
  );

  // backup.env exists
  const exists = sshExitsZero(
    ip,
    user,
    keyPath,
    `test -f "${backupDir}/backup.env"`
  );
  assert(exists, `${backupDir}/backup.env exists after --rotate-env`);

  // mode still 600
  const modeLine = sshCapture(
    ip,
    user,
    keyPath,
    `stat -c "%a %n" "${backupDir}/backup.env"`
  );
  const mode = modeLine.split(/\s+/)[0];
  assert(
    mode === "600",
    `backup.env mode still 600 after --rotate-env (got "${mode}")`
  );

  // gh auth status: stronger end-to-end signal than `bash -n` per
  // CONTEXT D-Discretion bullet 1 — proves backup.env parsed cleanly
  // AND the token in it works.
  const authOk = sshExitsZero(ip, user, keyPath, `gh auth status`);
  assert(
    authOk,
    "gh auth status passes on droplet after --rotate-env (backup.env parses + token valid)"
  );
}

function group5ListenerSurvival(
  ip: string,
  user: string,
  keyPath: string,
  pre: { listenerInstalled: boolean; listenerActiveBefore: boolean }
): void {
  console.log(
    "\n— Group 5: Webhook listener survival (probe-gated) —"
  );

  if (!pre.listenerInstalled) {
    console.log(
      "⚠ skipping listener-survival (Phase 3 webhook unit not installed)"
    );
    return;
  }

  assert(
    pre.listenerActiveBefore,
    `${LISTENER_UNIT} is-active before re-run`
  );
  const after = sshExitsZero(
    ip,
    user,
    keyPath,
    `systemctl is-active --quiet ${LISTENER_UNIT}`
  );
  assert(
    after,
    `${LISTENER_UNIT} is-active after re-run (listener survived bootstrap re-run)`
  );
}

function main(): void {
  const cfg = loadConfig();
  const info = loadDropletInfo();
  const ip = info.ip;
  const user = cfg.sshUser;
  const keyPath = cfg.sshKeyPath;
  const backupDir = cfg.backupDir;
  if (!ip || !user || !keyPath || !backupDir) {
    bail(
      "Missing one of: droplet.ip, sshUser, sshKeyPath, backupDir. " +
        "Run create-droplet + bootstrap-droplet first."
    );
  }

  group1PreConditions(cfg, info, ip, user, keyPath, backupDir);
  const pre = group2PreservationAndProbes(ip, user, keyPath, backupDir);
  group3CronMarkerInvariant(ip, user, keyPath);
  group4RotateEnvRoundTrip(ip, user, keyPath, backupDir);
  group5ListenerSurvival(ip, user, keyPath, pre);

  console.log("\n✓ verify:phase-5 — all assertions passed.");
}

main();
