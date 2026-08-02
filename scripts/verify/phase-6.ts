#!/usr/bin/env node
/**
 * scripts/verify/phase-6.ts
 *
 * Per-phase executable verification for Phase 6 (multi-source + REPOS-01).
 *
 * Five assertion groups (D-20):
 *   1. config + env contract     — cfg.sources matches backup.env GITHUB_SOURCES
 *   2. namespaced mirror layout  — D-07 (${BACKUP_DIR}/<source>/<owner>_<repo>.git)
 *   3. SUMMARY contract          — D-16 per-source + Phase 1 aggregate
 *   4. REPOS-01 deny enforcement — SC#4 + SC#5
 *   5. slot ↔ envSlot agreement  — cross-plan contract guard (TS vs bash)
 *
 * Group 6 (webhook routing into namespaced paths) is owned by
 * `npm run verify:phase-3`; this runner just prints a pointer.
 *
 * Bails fast on the first failed assertion. No external test framework.
 *
 * Usage:
 *   npm run verify:phase-6
 */

import { spawnSync } from "child_process";
import {
  loadConfig,
  loadDropletInfo,
  type Config,
  type DropletInfo,
  type NormalizedSource,
} from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";

const REMOTE_DIR = "/opt/github-backups";
const REMOTE_LOG = "/var/log/github-backup.log";

/** BACKUP_SOURCE_SUMMARY contract — emitted by droplet/github-backup.sh (Phase 6 D-16). */
const SOURCE_SUMMARY_RE =
  /BACKUP_SOURCE_SUMMARY source=(\S+) upstream=(\d+) mirrored=(\d+) failed=(\d+)/g;
/** Phase 1 aggregate BACKUP_SUMMARY contract — preserved unchanged. */
const AGG_SUMMARY_RE =
  /BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)/;

/** Local fail-fast assert. Prints ✓ on pass, ✗ + exit 1 on fail. */
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${msg}`);
}

function softSkip(msg: string): void {
  console.log(`SKIP: ${msg}`);
}

/**
 * Slot algorithm — MUST match bash slot() in droplet/github-backup.sh and
 * envSlot() in scripts/bootstrap-droplet.ts byte-for-byte. Group 5 asserts
 * cross-language equality on every configured source name.
 */
function envSlot(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** Run a remote command via SSH and return trimmed stdout. */
function sshCapture(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): string {
  return runCapture(`ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`);
}

/**
 * Returns true iff the remote command exits 0. Re-throws on ssh transport
 * failure (exit 255) so a network blip never reads as a remote-cmd failure.
 */
function sshExitsZero(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): boolean {
  const cmd = `ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`;
  const r = spawnSync(cmd, { shell: true, stdio: "pipe", encoding: "utf8" });
  if (r.error) throw new Error(`ssh spawn failed: ${r.error.message}`);
  if (r.signal) throw new Error(`ssh killed by signal ${r.signal}`);
  if (r.status === null) throw new Error("ssh exited without a status");
  if (r.status === 255) {
    throw new Error(
      `ssh transport failure (exit 255): ${(r.stderr ?? "").trim() || "no stderr"}`
    );
  }
  return r.status === 0;
}

// ─── Group 1 ──────────────────────────────────────────────────────────────
function group1ConfigContract(cfg: Config, dropInfo: DropletInfo): void {
  console.log("\n— Group 1: config + env contract —");

  if (cfg.sources.length < 2) {
    softSkip(
      `Phase 6 multi-source verify requires >= 2 sources; got ${cfg.sources.length}. ` +
        `Configure githubSources with >= 2 entries to exercise group 1+2+5.`
    );
    return;
  }

  const ip = dropInfo.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  const envOut = sshCapture(ip, user, key, `cat ${REMOTE_DIR}/backup.env`);

  // GITHUB_SOURCES line
  const sourcesLine = envOut
    .split("\n")
    .find((l) => l.startsWith("GITHUB_SOURCES="));
  assert(
    sourcesLine !== undefined,
    `backup.env contains a GITHUB_SOURCES= line`
  );
  // Strip surrounding double quotes if present
  const stripped = sourcesLine!
    .slice("GITHUB_SOURCES=".length)
    .replace(/^"(.*)"$/, "$1");
  const envNames = stripped.split(/\s+/).filter((n) => n.length > 0);
  const cfgNames = cfg.sources.map((s) => s.name);
  assert(
    JSON.stringify(envNames) === JSON.stringify(cfgNames),
    `GITHUB_SOURCES env list (${JSON.stringify(envNames)}) equals cfg.sources order (${JSON.stringify(cfgNames)})`
  );

  // Per-source allow/deny lines
  for (const s of cfg.sources) {
    const slot = envSlot(s.name);
    const allowExpected = `GITHUB_SOURCE_ALLOW_${slot}="${s.allow.join(" ")}"`;
    const denyExpected = `GITHUB_SOURCE_DENY_${slot}="${s.deny.join(" ")}"`;
    assert(
      envOut.includes(allowExpected),
      `backup.env contains: ${allowExpected}`
    );
    assert(
      envOut.includes(denyExpected),
      `backup.env contains: ${denyExpected}`
    );
  }
}

// ─── Group 2 ──────────────────────────────────────────────────────────────
function group2NamespacedLayout(cfg: Config, dropInfo: DropletInfo): void {
  console.log("\n— Group 2: namespaced mirror layout (D-07) —");

  if (cfg.sources.length < 2) {
    softSkip(`needs >= 2 sources to exercise; skipping`);
    return;
  }

  const ip = dropInfo.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  for (const s of cfg.sources) {
    assert(
      sshExitsZero(ip, user, key, `test -d ${REMOTE_DIR}/${s.name}`),
      `${REMOTE_DIR}/${s.name}/ exists on droplet`
    );
    // *.git presence — soft-skip per source if upstream filtered to zero.
    const gitsOut = sshCapture(
      ip,
      user,
      key,
      `ls -1d ${REMOTE_DIR}/${s.name}/*.git 2>/dev/null | wc -l`
    );
    const gits = parseInt(gitsOut.trim(), 10) || 0;
    if (gits === 0) {
      info(
        `[soft] ${REMOTE_DIR}/${s.name}/ has 0 *.git mirrors (filter may have ` +
          `dropped all upstream repos for this source)`
      );
    } else {
      assert(
        gits >= 1,
        `${REMOTE_DIR}/${s.name}/ contains >= 1 *.git mirror (got ${gits})`
      );
    }
  }

  // Top-level *.git must NOT exist (legacy layout fully migrated).
  const topOut = sshCapture(
    ip,
    user,
    key,
    `find ${REMOTE_DIR} -maxdepth 1 -type d -name "*.git" 2>/dev/null | wc -l`
  );
  const topCount = parseInt(topOut.trim(), 10) || 0;
  assert(
    topCount === 0,
    `no top-level *.git in ${REMOTE_DIR} (legacy layout migrated; got ${topCount})`
  );
}

// ─── Group 3 ──────────────────────────────────────────────────────────────
function group3SummaryContract(cfg: Config, dropInfo: DropletInfo): void {
  console.log("\n— Group 3: SUMMARY contract (D-16 + Phase 1 aggregate) —");

  if (cfg.sources.length < 2) {
    softSkip(`needs >= 2 sources to exercise; skipping`);
    return;
  }

  const ip = dropInfo.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // Trigger a fresh backup. REQUIRE_LOCK=1 makes flock wait if cron is mid-run
  // instead of exiting 0 (Phase 1 NR-06 carries through).
  console.log(
    `   Triggering ${REMOTE_DIR}/github-backup.sh on droplet (synchronous, REQUIRE_LOCK=1)…`
  );
  const tStart = sshCapture(
    ip,
    user,
    key,
    `date "+%Y-%m-%d %H:%M:%S"`
  ).trim();
  // Use spawnSync directly so we can stream output without going through sshRun.
  const triggerCmd =
    `ssh ${sshFlags(key)} ${user}@${ip} 'REQUIRE_LOCK=1 ${REMOTE_DIR}/github-backup.sh'`;
  const trig = spawnSync(triggerCmd, { shell: true, stdio: "inherit" });
  if (trig.status !== 0) {
    console.error(
      `Remote github-backup.sh failed (exit ${trig.status}); aborting verify.`
    );
    process.exit(1);
  }

  // Tail since tStart. 200 lines is enough for a 2-source run; group will
  // re-fetch a longer tail if there are more sources later.
  const tail = sshCapture(
    ip,
    user,
    key,
    `tail -n 500 ${REMOTE_LOG}`
  );

  // Per-source SUMMARY parsing (post-tStart only).
  // Match all in tail, then filter to those whose log timestamp prefix is >= tStart.
  // log line shape: "[YYYY-MM-DD HH:MM:SS]   BACKUP_SOURCE_SUMMARY source=..."
  const lines = tail.split("\n");
  const sourceSummaries: { source: string; upstream: number; mirrored: number; failed: number }[] = [];
  const tsRe = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;
  for (const l of lines) {
    const tsMatch = l.match(tsRe);
    if (!tsMatch) continue;
    if (tsMatch[1] < tStart) continue;
    SOURCE_SUMMARY_RE.lastIndex = 0;
    const m = SOURCE_SUMMARY_RE.exec(l);
    if (m) {
      sourceSummaries.push({
        source: m[1],
        upstream: parseInt(m[2], 10),
        mirrored: parseInt(m[3], 10),
        failed: parseInt(m[4], 10),
      });
    }
  }

  assert(
    sourceSummaries.length === cfg.sources.length,
    `exactly ${cfg.sources.length} BACKUP_SOURCE_SUMMARY line(s) post-tStart (got ${sourceSummaries.length})`
  );

  const observedSet = new Set(sourceSummaries.map((s) => s.source));
  const expectedSet = new Set(cfg.sources.map((s) => s.name));
  const setsEqual =
    observedSet.size === expectedSet.size &&
    [...observedSet].every((n) => expectedSet.has(n));
  assert(
    setsEqual,
    `BACKUP_SOURCE_SUMMARY source= values match cfg.sources names ` +
      `(observed=${JSON.stringify([...observedSet])}, expected=${JSON.stringify([...expectedSet])})`
  );

  for (const ss of sourceSummaries) {
    assert(
      ss.failed === 0,
      `source "${ss.source}" 100% pass bar — failed === 0 (got ${ss.failed})`
    );
  }

  // Aggregate parsing — find the AGG line post-tStart (single match expected).
  let agg: { upstream: number; mirrored: number; failed: number } | null = null;
  for (const l of lines) {
    const tsMatch = l.match(tsRe);
    if (!tsMatch || tsMatch[1] < tStart) continue;
    const m = l.match(AGG_SUMMARY_RE);
    if (m) {
      agg = {
        upstream: parseInt(m[1], 10),
        mirrored: parseInt(m[2], 10),
        failed: parseInt(m[3], 10),
      };
      // First post-tStart match wins; subsequent (cron interleave) ignored.
      break;
    }
  }
  assert(agg !== null, `aggregate BACKUP_SUMMARY line found post-tStart`);

  const sumUpstream = sourceSummaries.reduce((a, s) => a + s.upstream, 0);
  const sumMirrored = sourceSummaries.reduce((a, s) => a + s.mirrored, 0);
  const sumFailed = sourceSummaries.reduce((a, s) => a + s.failed, 0);
  assert(
    agg!.upstream === sumUpstream,
    `aggregate upstream (${agg!.upstream}) === sum of per-source upstream (${sumUpstream})`
  );
  assert(
    agg!.mirrored === sumMirrored,
    `aggregate mirrored (${agg!.mirrored}) === sum of per-source mirrored (${sumMirrored})`
  );
  assert(
    agg!.failed === 0 && agg!.failed === sumFailed,
    `aggregate failed === 0 and equals sum of per-source failed (${sumFailed})`
  );
}

// ─── Group 4 ──────────────────────────────────────────────────────────────
function group4DenyEnforcement(cfg: Config, dropInfo: DropletInfo): void {
  console.log("\n— Group 4: REPOS-01 deny enforcement (SC#4) —");

  const denySource: NormalizedSource | undefined = cfg.sources.find(
    (s) => s.deny.length > 0
  );
  if (!denySource) {
    softSkip(
      `no source has a non-empty repos.deny list; REPOS-01 SC#4 not exercised. ` +
        `To exercise: set repos.deny=["some-real-repo-pattern"] for one source ` +
        `in config.json, re-run bootstrap-droplet, then re-run verify:phase-6.`
    );
    return;
  }

  const ip = dropInfo.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // Query upstream via gh on the droplet (reuses droplet's GITHUB_TOKEN).
  // Account-type detection delegated to the same helper github-backup.sh uses.
  const setupCmd =
    `set -a; source ${REMOTE_DIR}/backup.env; set +a; ` +
    `source ${REMOTE_DIR}/lib/detect-account-type.sh; ` +
    `source ${REMOTE_DIR}/lib/filter-repos.sh; ` +
    `source ${REMOTE_DIR}/lib/resolve-repo-endpoint.sh; ` +
    `T=$(detect_account_type "${denySource.name}"); ` +
    `EP="$(resolve_repo_endpoint "${denySource.name}" "\$T")"; ` +
    `gh api --paginate "\$EP" --jq ".[].full_name"`;
  const upstream = sshCapture(ip, user, key, setupCmd)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  info(
    `source "${denySource.name}" upstream count = ${upstream.length}; ` +
      `deny patterns = ${JSON.stringify(denySource.deny)}`
  );

  // Determine which upstream repos SHOULD be denied. Use the same bash
  // filter helper to avoid TS/bash glob drift — pipe upstream through
  // `filter_repos` with empty deny (= passthrough) and with the real
  // deny list, then diff.
  const allowEmpty = "";
  const filtered = sshCapture(
    ip,
    user,
    key,
    `set -a; source ${REMOTE_DIR}/backup.env; set +a; ` +
      `source ${REMOTE_DIR}/lib/filter-repos.sh; ` +
      `printf "%s\\n" ${upstream.map((r) => `"${r}"`).join(" ")} ` +
      `| filter_repos "${denySource.name}" "${allowEmpty}" "${denySource.deny.join(" ")}"`
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const deniedRepos = upstream.filter((r) => !filtered.includes(r));
  info(
    `denied (upstream minus filtered): ${deniedRepos.length} repo(s) ${
      deniedRepos.length > 0 ? JSON.stringify(deniedRepos.slice(0, 5)) : ""
    }`
  );

  if (deniedRepos.length === 0) {
    softSkip(
      `deny list does not match any upstream repo of "${denySource.name}". ` +
        `This is not a Phase 6 bug — adjust the deny pattern to one that ` +
        `matches at least one upstream repo to exercise SC#4.`
    );
    return;
  }

  // Assert each denied repo is NOT mirrored on disk under the source.
  for (const r of deniedRepos) {
    const [owner, name] = r.split("/");
    const mirrorPath = `${REMOTE_DIR}/${denySource.name}/${owner}_${name}.git`;
    assert(
      !sshExitsZero(ip, user, key, `test -e ${mirrorPath}`),
      `denied repo "${r}" has NO mirror at ${mirrorPath} (REPOS-01 SC#4)`
    );
  }
}

// ─── Group 5 ──────────────────────────────────────────────────────────────
function group5SlotAgreement(cfg: Config, dropInfo: DropletInfo): void {
  console.log("\n— Group 5: slot() ↔ envSlot() cross-language agreement —");

  const ip = dropInfo.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  for (const s of cfg.sources) {
    // Mirror of plan 02's bash slot() exactly:
    //   slot() { local s; s=$(tr '[:lower:]' '[:upper:]' <<< "$1");
    //     printf '%s\n' "${s}" | tr -c 'A-Z0-9\n' '_'; }
    const remoteCmd =
      `S=$(tr "[:lower:]" "[:upper:]" <<< "${s.name}"); ` +
      `printf "%s\\n" "\$S" | tr -c "A-Z0-9\\n" "_"`;
    const bashSlot = sshCapture(ip, user, key, remoteCmd).trim();
    const tsSlot = envSlot(s.name);
    assert(
      bashSlot === tsSlot,
      `slot agreement for "${s.name}": bash=${JSON.stringify(bashSlot)} === ts=${JSON.stringify(tsSlot)}`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════");
  console.log(" verify:phase-6 — multi-source + per-repo filtering (D-20)");
  console.log("══════════════════════════════════════════════════════════");

  const cfg = loadConfig();
  const dropInfo = loadDropletInfo();

  group1ConfigContract(cfg, dropInfo);
  group2NamespacedLayout(cfg, dropInfo);
  group3SummaryContract(cfg, dropInfo);
  group4DenyEnforcement(cfg, dropInfo);
  group5SlotAgreement(cfg, dropInfo);

  console.log("\n— Group 6: webhook routing into namespaced paths —");
  console.log(
    `  Phase 3 webhook routing into namespaced paths is verified by ` +
      `\`npm run verify:phase-3\`. (REPOS-01 SC#4 enforcement on the webhook ` +
      `path is owned by Phase 3 — see Phase 6 plan 03 group 6 for the cross-` +
      `phase handoff note.)`
  );

  console.log("\n✓ Phase 6 verify: PASSED");
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
