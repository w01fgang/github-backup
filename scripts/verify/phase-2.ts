#!/usr/bin/env node
/**
 * scripts/verify/phase-2.ts
 *
 * Per-phase executable verification for Phase 2 (TEST-02 / MON-01-03).
 *
 * Asserts the Phase 2 surfaces against a live droplet:
 *  - Group 0: pre-flight (trigger backup if last-run.json missing)
 *  - Group 1: /var/lib/github-backup/last-run.json schema + invariants
 *  - Group 2: github-backup-status.sh droplet binary
 *  - Group 3: disk reporting matches live df / du
 *  - Group 4: `npm run status -- --json` local wrapper end-to-end
 *
 * Bails fast on the first failed assertion. No external test framework.
 *
 * Usage:
 *   npm run verify:phase-2
 */

import { spawnSync } from "child_process";
import {
  loadConfig,
  loadDropletInfo,
  type Config,
  type DropletInfo,
} from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";

const REMOTE_STATE_FILE = "/var/lib/github-backup/last-run.json";
const REMOTE_STATE_DIR = "/var/lib/github-backup";
const REMOTE_STATUS_BIN = "/opt/github-backups/github-backup-status.sh";
const REMOTE_BACKUP_BIN = "/opt/github-backups/github-backup.sh";
const REMOTE_BACKUP_DIR = "/opt/github-backups";

/** Local assert — fail-fast. Prints ✓ on pass, ✗ + exit 1 on fail. */
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

/**
 * Run a remote command via SSH and return trimmed stdout. Copied from
 * scripts/verify/phase-1.ts:67-76 — extracting to lib/ is a separate
 * refactor (per project Rule 3, do not preemptively share code).
 * Single-quote wrapping: callers must not include `'` in cmd.
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
 * exit. Re-throws on ssh transport failure (exit 255). Copied from
 * scripts/verify/phase-1.ts:83-113.
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
    throw new Error(`ssh transport failure (exit 255): ${stderr || "no stderr"}`);
  }
  return r.status === 0;
}

/**
 * Run a remote command via SSH and return both stdout and exit status.
 * Unlike sshCapture, does NOT throw on non-zero remote exit — that's the
 * whole point: the status binary exits 1/2/3 by design and we still want
 * to inspect its stdout. Still throws on 255 (transport) and signal kill.
 */
function sshCaptureAllowFail(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): { status: number; stdout: string; stderr: string } {
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
    throw new Error(`ssh transport failure (exit 255): ${stderr || "no stderr"}`);
  }
  return {
    status: r.status,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  };
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait; verify runs are short
  }
}

// ── Group 0: pre-flight ────────────────────────────────────────────────────
function group0Preflight(cfg: Config, info: DropletInfo): void {
  console.log("\n— Group 0: Pre-flight —");
  const { sshUser: user, sshKeyPath: keyPath } = cfg;

  if (sshExitsZero(info.ip, user, keyPath, `test -r ${REMOTE_STATE_FILE}`)) {
    console.log(`✓ ${REMOTE_STATE_FILE} already present — no manual run needed`);
    return;
  }

  console.log(`  ${REMOTE_STATE_FILE} missing — triggering manual backup over SSH…`);
  // Run the backup; on lock contention or other recoverable conditions the
  // existing flock guard makes the trigger a no-op. We poll for the file
  // appearing afterwards regardless.
  const trig = sshCaptureAllowFail(
    info.ip,
    user,
    keyPath,
    `${REMOTE_BACKUP_BIN}`
  );
  console.log(`  manual backup exit: ${trig.status}`);

  // Poll for last-run.json appearing (up to 60 s, every 5 s)
  const deadline = Date.now() + 60_000;
  let appeared = false;
  while (Date.now() < deadline) {
    if (sshExitsZero(info.ip, user, keyPath, `test -r ${REMOTE_STATE_FILE}`)) {
      appeared = true;
      break;
    }
    sleepSync(5_000);
  }

  assert(
    appeared,
    `${REMOTE_STATE_FILE} appeared within 60s after manual backup trigger`
  );
}

// ── Group 1: state file invariants ────────────────────────────────────────
function group1StateFile(cfg: Config, info: DropletInfo): void {
  console.log("\n— Group 1: state file invariants (MON-01, MON-02, D-03, D-05) —");
  const { sshUser: user, sshKeyPath: keyPath } = cfg;

  const dirMode = sshCapture(info.ip, user, keyPath, `stat -c %a ${REMOTE_STATE_DIR}`).trim();
  assert(dirMode === "700", `${REMOTE_STATE_DIR} mode is 700 (got ${dirMode})`);

  const fileMode = sshCapture(info.ip, user, keyPath, `stat -c %a ${REMOTE_STATE_FILE}`).trim();
  assert(fileMode === "640", `${REMOTE_STATE_FILE} mode is 640 (got ${fileMode})`);

  const raw = sshCapture(info.ip, user, keyPath, `cat ${REMOTE_STATE_FILE}`);
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    assert(false, `last-run.json parses as JSON (parse error: ${(e as Error).message})`);
    return;
  }
  assert(typeof j === "object" && j !== null, "last-run.json is a JSON object");

  const obj = j as Record<string, unknown>;
  assert(typeof obj.started_at === "string", `.started_at is a string`);
  assert(typeof obj.finished_at === "string", `.finished_at is a string`);
  assert(typeof obj.exit_code === "number", `.exit_code is a number`);
  assert(typeof obj.total === "number", `.total is a number`);
  assert(typeof obj.success === "number", `.success is a number`);
  assert(typeof obj.fail === "number", `.fail is a number`);
  assert(Array.isArray(obj.repos), `.repos is an array`);

  const startedDate = new Date(obj.started_at as string);
  assert(!Number.isNaN(startedDate.getTime()), `.started_at parses as a Date`);
  const finishedDate = new Date(obj.finished_at as string);
  assert(!Number.isNaN(finishedDate.getTime()), `.finished_at parses as a Date`);

  const success = obj.success as number;
  const fail = obj.fail as number;
  const total = obj.total as number;
  assert(
    success + fail === total,
    `.success + .fail === .total (${success} + ${fail} === ${total})`
  );

  const repos = obj.repos as unknown[];
  assert(
    repos.length === total,
    `.repos.length === .total (${repos.length} === ${total})`
  );

  for (let i = 0; i < repos.length; i++) {
    const r = repos[i] as Record<string, unknown>;
    assert(typeof r.name === "string", `.repos[${i}].name is a string`);
    const action = r.action as string;
    assert(
      ["clone", "update", "fail"].includes(action),
      `.repos[${i}].action is one of clone|update|fail (got ${JSON.stringify(action)})`
    );
  }
}

// ── Group 2: droplet binary invariants ────────────────────────────────────
function group2StatusBinary(
  cfg: Config,
  info: DropletInfo
): { remoteJson: string } {
  console.log("\n— Group 2: droplet binary invariants (MON-01, D-01) —");
  const { sshUser: user, sshKeyPath: keyPath } = cfg;

  assert(
    sshExitsZero(info.ip, user, keyPath, `test -x ${REMOTE_STATUS_BIN}`),
    `${REMOTE_STATUS_BIN} exists and is executable`
  );

  const helpRes = sshCaptureAllowFail(info.ip, user, keyPath, `bash ${REMOTE_STATUS_BIN} --help`);
  assert(helpRes.status === 0, `--help exits 0 (got ${helpRes.status})`);

  const bogusRes = sshCaptureAllowFail(info.ip, user, keyPath, `bash ${REMOTE_STATUS_BIN} --bogus-flag`);
  assert(bogusRes.status === 64, `--bogus-flag exits 64 (got ${bogusRes.status})`);

  const jsonRes = sshCaptureAllowFail(info.ip, user, keyPath, `bash ${REMOTE_STATUS_BIN} --json`);
  assert(
    [0, 1, 2, 3].includes(jsonRes.status),
    `--json exit status in {0,1,2,3} (got ${jsonRes.status})`
  );
  const remoteJson = jsonRes.stdout.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(remoteJson) as Record<string, unknown>;
  } catch (e) {
    console.error("Raw JSON stdout (truncated):", remoteJson.slice(0, 500));
    assert(false, `--json output parses as JSON (parse error: ${(e as Error).message})`);
    return { remoteJson };
  }
  assert(parsed !== null && typeof parsed === "object", `--json output is a JSON object`);

  const expectedKeys = ["last_run", "disk", "staleness", "verbose", "exit_code"];
  for (const k of expectedKeys) {
    assert(k in parsed, `top-level key '${k}' present in --json output`);
  }

  assert(
    [0, 1, 2, 3].includes(parsed.exit_code as number),
    `.exit_code in {0,1,2,3} (got ${parsed.exit_code})`
  );

  const staleness = parsed.staleness as Record<string, unknown>;
  assert(
    ["OK", "STALE", "NEVER_RAN"].includes(staleness.state as string),
    `.staleness.state in {OK,STALE,NEVER_RAN} (got ${staleness.state})`
  );

  const disk = parsed.disk as Record<string, unknown>;
  assert(
    typeof disk.size_bytes === "number" && (disk.size_bytes as number) > 0,
    `.disk.size_bytes > 0 (got ${disk.size_bytes})`
  );
  assert(
    typeof disk.used_bytes === "number" && (disk.used_bytes as number) >= 0,
    `.disk.used_bytes >= 0 (got ${disk.used_bytes})`
  );

  return { remoteJson };
}

// ── Group 3: disk-reporting invariants ────────────────────────────────────
function group3DiskReporting(
  cfg: Config,
  info: DropletInfo,
  remoteJson: string
): void {
  console.log("\n— Group 3: disk reporting matches live df / du (MON-03, D-08) —");
  const { sshUser: user, sshKeyPath: keyPath } = cfg;

  // Live df: capture size_bytes + used_bytes from second line, fields 2 + 3
  const dfRow = sshCapture(
    info.ip,
    user,
    keyPath,
    `df -P -B1 ${REMOTE_BACKUP_DIR} | awk "NR==2 {print \\$2,\\$3}"`
  ).trim();
  const [liveSize, liveUsed] = dfRow.split(/\s+/).map((s) => parseInt(s, 10));
  assert(Number.isFinite(liveSize) && liveSize > 0, `live df size parsed (${liveSize})`);

  // Live du
  const duStr = sshCapture(
    info.ip,
    user,
    keyPath,
    `du -sb ${REMOTE_BACKUP_DIR} | awk "{print \\$1}"`
  ).trim();
  const liveMirror = parseInt(duStr, 10);
  assert(Number.isFinite(liveMirror), `live du parsed (${liveMirror})`);

  const parsed = JSON.parse(remoteJson) as Record<string, unknown>;
  const disk = parsed.disk as Record<string, unknown>;
  const reportedSize = disk.size_bytes as number;
  const reportedUsed = disk.used_bytes as number;
  const reportedMirror = disk.mirror_bytes as number;

  // Disk size should be stable to within 1%
  const sizeDelta = Math.abs(reportedSize - liveSize) / Math.max(reportedSize, liveSize);
  assert(
    sizeDelta < 0.01,
    `.disk.size_bytes matches live df within 1% (reported=${reportedSize} live=${liveSize} delta=${(sizeDelta * 100).toFixed(2)}%)`
  );

  // Used bytes can drift slightly between the two probes; 1% tolerance
  const usedDelta = liveUsed === 0
    ? Math.abs(reportedUsed - liveUsed)
    : Math.abs(reportedUsed - liveUsed) / Math.max(reportedUsed, liveUsed, 1);
  assert(
    usedDelta < 0.01,
    `.disk.used_bytes matches live df within 1% (reported=${reportedUsed} live=${liveUsed})`
  );

  // Mirror can grow mid-verify (e.g. concurrent webhook sync); 5% tolerance
  const mirrorDelta = reportedMirror === 0 && liveMirror === 0
    ? 0
    : Math.abs(reportedMirror - liveMirror) / Math.max(reportedMirror, liveMirror, 1);
  assert(
    mirrorDelta < 0.05,
    `.disk.mirror_bytes matches live du within 5% (reported=${reportedMirror} live=${liveMirror})`
  );
}

// ── Group 4: local wrapper end-to-end ─────────────────────────────────────
function group4LocalWrapper(remoteJson: string): void {
  console.log("\n— Group 4: npm run status -- --json local wrapper (MON-01, D-01, D-02) —");

  const r = spawnSync(
    "npm",
    ["run", "status", "--silent", "--", "--json"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );

  assert(r.status !== null, `npm run status exited with a status (signal=${String(r.signal)})`);
  assert(
    [0, 1, 2, 3].includes(r.status as number),
    `npm run status exit in {0,1,2,3} (got ${r.status})`
  );

  const localJson = (r.stdout ?? "").trim();
  let localParsed: Record<string, unknown>;
  let remoteParsed: Record<string, unknown>;
  try {
    localParsed = JSON.parse(localJson) as Record<string, unknown>;
    remoteParsed = JSON.parse(remoteJson) as Record<string, unknown>;
  } catch (e) {
    console.error("Local stdout (truncated):", localJson.slice(0, 500));
    console.error("Remote stdout (truncated):", remoteJson.slice(0, 500));
    assert(false, `local + remote --json both parse as JSON (parse error: ${(e as Error).message})`);
    return;
  }

  // The two snapshots are taken seconds apart, so every live-sampled field
  // drifts between them: staleness.last_run_age_seconds by whole seconds, and
  // disk.used_bytes / percent_used / mirror_bytes by whatever journald and the
  // sync job wrote in between. Byte-equality over those four is unwinnable.
  //
  // Deleting them unchecked is not the answer either: Group 3 gates the REMOTE
  // document only, so a wrapper that dropped or mangled them would sail through
  // a comparison that had removed them from both sides. Each one is therefore
  // asserted present, numeric and within a drift tolerance of the droplet's
  // value, and only then stripped from the byte-equality pass that covers every
  // remaining field (last_run, staleness.state, disk.filesystem, size_bytes, …).
  //
  // Tolerances mirror Group 3's live df/du gates: 1% on used bytes, 5% on the
  // mirror total (a concurrent webhook sync can grow it mid-verify). percent_used
  // is an integer percentage, so it gets 1 point absolute. The age field only
  // advances — local is sampled after remote — and the whole run is a handful of
  // SSH round-trips, so 300 s is a generous ceiling on a healthy verify.
  const drift = (
    label: string,
    localV: unknown,
    remoteV: unknown,
    tolerance: number,
    unit: "ratio" | "absolute"
  ): void => {
    assert(
      typeof localV === "number" && Number.isFinite(localV),
      `${label} present and numeric in local --json (got ${JSON.stringify(localV)})`
    );
    assert(
      typeof remoteV === "number" && Number.isFinite(remoteV),
      `${label} present and numeric in remote --json (got ${JSON.stringify(remoteV)})`
    );
    const l = localV as number;
    const rm = remoteV as number;
    const delta =
      unit === "ratio"
        ? Math.abs(l - rm) / Math.max(Math.abs(l), Math.abs(rm), 1)
        : Math.abs(l - rm);
    const budget = unit === "ratio" ? `${tolerance * 100}%` : `${tolerance}`;
    assert(
      delta <= tolerance,
      `${label} local matches remote within ${budget} (local=${l} remote=${rm})`
    );
  };

  const localDisk = (localParsed.disk ?? {}) as Record<string, unknown>;
  const remoteDisk = (remoteParsed.disk ?? {}) as Record<string, unknown>;
  drift(".disk.used_bytes", localDisk.used_bytes, remoteDisk.used_bytes, 0.01, "ratio");
  drift(".disk.percent_used", localDisk.percent_used, remoteDisk.percent_used, 1, "absolute");
  drift(".disk.mirror_bytes", localDisk.mirror_bytes, remoteDisk.mirror_bytes, 0.05, "ratio");

  const localSt = (localParsed.staleness ?? {}) as Record<string, unknown>;
  const remoteSt = (remoteParsed.staleness ?? {}) as Record<string, unknown>;
  drift(
    ".staleness.last_run_age_seconds",
    localSt.last_run_age_seconds,
    remoteSt.last_run_age_seconds,
    300,
    "absolute"
  );

  const VOLATILE_DISK_FIELDS = ["used_bytes", "percent_used", "mirror_bytes"];
  const norm = (o: Record<string, unknown>): string => {
    const clone = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    const st = clone.staleness as Record<string, unknown> | undefined;
    if (st && "last_run_age_seconds" in st) {
      delete st.last_run_age_seconds;
    }
    const disk = clone.disk as Record<string, unknown> | undefined;
    if (disk) {
      for (const f of VOLATILE_DISK_FIELDS) delete disk[f];
    }
    return JSON.stringify(clone);
  };

  const localCanon = norm(localParsed);
  const remoteCanon = norm(remoteParsed);
  if (localCanon !== remoteCanon) {
    console.error("Local (canonical):", localCanon.slice(0, 500));
    console.error("Remote (canonical):", remoteCanon.slice(0, 500));
  }
  assert(
    localCanon === remoteCanon,
    "local --json output equals remote --json output (live-sampled staleness + disk fields drift-checked above, then stripped)"
  );
}

function main(): void {
  const cfg = loadConfig();
  const info = loadDropletInfo();

  console.log(`\n🔎  Verifying Phase 2 on droplet ${info.name} (${info.ip})…\n`);

  group0Preflight(cfg, info);
  group1StateFile(cfg, info);
  const { remoteJson } = group2StatusBinary(cfg, info);
  group3DiskReporting(cfg, info, remoteJson);
  group4LocalWrapper(remoteJson);

  console.log("\n✅  All Phase 2 assertions passed.\n");
}

main();
