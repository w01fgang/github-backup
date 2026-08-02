#!/usr/bin/env node
/**
 * scripts/verify/phase-7.ts
 *
 * Per-phase executable verification for Phase 7 (DROPLET-01/02/03).
 *
 * Four assertion groups (D-09):
 *   1. sync-one-repo.sh ships + per-repo contract — D-05 (SC#1)
 *   2. detect-account-type.sh source-load + default — D-06 (SC#2)
 *   3. filter-repos.sh source-load + golden cases — D-07 (SC#3)
 *   4. github-backup.sh end-to-end on a whitelisted target — D-08 (SC#4)
 *
 * Bails fast on the first failed assertion. No external test framework.
 * Standalone-per-phase (D-09): no shared verify-helpers module, no new SSH
 * wrapper — reuses scripts/lib/ssh.ts + scripts/lib/config.ts only.
 *
 * Preconditions:
 *   1. .droplet.json exists locally (loadDropletInfo bails otherwise).
 *   2. config.json has >= 1 source. For SC#4, at least one allow-matched
 *      repo must be resolvable: chooseTarget() tries
 *        a. cfg.webhookTestRepo (if owner is a configured source + passes filter)
 *        b. cfg.restoreTestRepo (same constraints)
 *        c. auto-discovery via `gh api` on first source whose filter admits >= 1 repo
 *      and bails operator-actionably if nothing resolves.
 *
 * Usage:
 *   npm run verify:phase-7
 */

import { spawnSync } from "child_process";
import {
  loadConfig,
  loadDropletInfo,
  bail,
  type Config,
  type DropletInfo,
  type NormalizedSource,
} from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";
import { filterRepos } from "../lib/filter-repos";

const REMOTE_DIR = "/opt/github-backups";
const REMOTE_LOG = "/var/log/github-backup.log";
const REMOTE_SYNC_ONE_REPO = `${REMOTE_DIR}/sync-one-repo.sh`;
const REMOTE_DETECT_LIB = `${REMOTE_DIR}/lib/detect-account-type.sh`;
const REMOTE_FILTER_LIB = `${REMOTE_DIR}/lib/filter-repos.sh`;
const REMOTE_ENDPOINT_LIB = `${REMOTE_DIR}/lib/resolve-repo-endpoint.sh`;
const REMOTE_BACKUP_SH = `${REMOTE_DIR}/github-backup.sh`;
const RESULT_TAG = "BACKUP_REPO_RESULT";

/** backup.env path is fixed in v1.0 — Config doesn't expose it. */
function REMOTE_ENV(_cfg: Config): string {
  return `${REMOTE_DIR}/backup.env`;
}

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

/** POSIX-safe single-quote escape: wraps `s` so embedded single quotes survive
 *  one layer of shell unquoting. Required for SSH payloads that themselves
 *  contain `'` (e.g. `printf '%s\n' …`), which would otherwise terminate the
 *  outer `'…'` wrapping. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Run a remote command via SSH and return trimmed stdout. */
function sshCapture(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): string {
  return runCapture(`ssh ${sshFlags(keyPath)} ${user}@${ip} ${shq(remoteCmd)}`);
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
  const cmd = `ssh ${sshFlags(keyPath)} ${user}@${ip} ${shq(remoteCmd)}`;
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

/** Defence-in-depth slug regex re-validated at the verify boundary. */
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

function parseRepoSlug(slug: string): { owner: string; repo: string } | null {
  const m = slug.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** True iff `owner/repo` survives the source's allow/deny globs (deny wins). */
function passesRepoFilter(
  s: NormalizedSource,
  owner: string,
  repo: string
): boolean {
  return filterRepos(s.name, [`${owner}/${repo}`], s.allow, s.deny).length > 0;
}

// ─── Group 1 ─────────────────────────────────────────────────────────────
function group1SyncOneRepoContract(
  cfg: Config,
  dropInfo: DropletInfo,
  target: { source: string; owner: string; repo: string }
): void {
  console.log(
    "\n— Group 1: sync-one-repo.sh ships + per-repo contract (SC#1, D-05) —"
  );
  const { ip } = dropInfo;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // 1a. ships + executable
  assert(
    sshExitsZero(ip, user, key, `test -x ${REMOTE_SYNC_ONE_REPO}`),
    `${REMOTE_SYNC_ONE_REPO} exists and is executable on droplet`
  );

  // 1b. defence-in-depth slug guard
  const { source, owner, repo } = target;
  if (!SLUG_RE.test(source) || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) {
    bail(
      `Phase 7 verify: target slug "${source}/${owner}/${repo}" has shell-unsafe chars; refusing`
    );
  }

  // 1c. invoke against the chosen target — exit must be 0
  const invokeCmd =
    `set -a; source ${REMOTE_ENV(cfg)}; set +a; ` +
    `${REMOTE_SYNC_ONE_REPO} ${source} ${owner} ${repo} >/dev/null 2>&1; ` +
    `echo exit=$?`;
  const out = sshCapture(ip, user, key, invokeCmd);
  assert(
    /exit=0/.test(out),
    `sync-one-repo.sh ${source} ${owner} ${repo} exited 0`
  );

  // 1d. namespaced mirror dir exists
  const mirrorPath = `${REMOTE_DIR}/${source}/${owner}_${repo}.git`;
  assert(
    sshExitsZero(ip, user, key, `test -d ${mirrorPath}`),
    `namespaced mirror dir ${mirrorPath} exists (D-07)`
  );

  // 1e. BACKUP_REPO_RESULT line emitted (action=clone or update)
  const grepCmd = `grep -F "${RESULT_TAG} source=${source} owner=${owner} repo=${repo}" ${REMOTE_LOG} | tail -1`;
  const tag = sshCapture(ip, user, key, grepCmd);
  assert(
    tag.length > 0 && /action=(clone|update)/.test(tag),
    `${REMOTE_LOG} contains ${RESULT_TAG} for ${source}/${owner}/${repo} with action=clone|update`
  );
}

// ─── Group 2 ─────────────────────────────────────────────────────────────
function group2DetectAccountType(cfg: Config, dropInfo: DropletInfo): void {
  console.log(
    "\n— Group 2: detect-account-type.sh source-load + default (SC#2, D-06) —"
  );
  const { ip } = dropInfo;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // 2a. source-load smoke: bash -c "set -e; source detect-account-type.sh; echo OK"
  const smoke = sshCapture(
    ip,
    user,
    key,
    `bash -c "set -e; source ${REMOTE_DETECT_LIB}; echo OK"`
  );
  assert(
    smoke.trim() === "OK",
    `${REMOTE_DETECT_LIB} source-loads under set -e`
  );

  // 2b. functional: unknown slug defaults to "User"
  const fnOut = sshCapture(
    ip,
    user,
    key,
    `bash -c "set -a; source ${REMOTE_ENV(cfg)}; set +a; ` +
      `source ${REMOTE_DETECT_LIB}; detect_account_type definitely-not-a-real-slug-xxx"`
  );
  assert(
    fnOut.trim() === "User",
    `detect_account_type for unknown slug returns "User" (default-on-non-200)`
  );
}

// ─── Group 3 ─────────────────────────────────────────────────────────────
function group3FilterRepos(cfg: Config, dropInfo: DropletInfo): void {
  console.log(
    "\n— Group 3: filter-repos.sh source-load + golden cases (SC#3, D-07) —"
  );
  const { ip } = dropInfo;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // 3a. source-load smoke: bash -c "set -e; source filter-repos.sh; echo OK"
  const smoke = sshCapture(
    ip,
    user,
    key,
    `bash -c "set -e; source ${REMOTE_FILTER_LIB}; echo OK"`
  );
  assert(
    smoke.trim() === "OK",
    `${REMOTE_FILTER_LIB} source-loads under set -e`
  );

  // 3b. case 1 — empty allow passes all 3 lines
  const case1 = sshCapture(
    ip,
    user,
    key,
    `bash -c "source ${REMOTE_FILTER_LIB}; ` +
      `printf '%s\\n' owner/a owner/b owner/c | filter_repos test '' ''"`
  );
  const case1Lines = case1
    .split("\n")
    .filter((l) => l.length > 0)
    .sort();
  assert(
    JSON.stringify(case1Lines) ===
      JSON.stringify(["owner/a", "owner/b", "owner/c"]),
    `case 1: empty allow passes all 3 lines (got ${JSON.stringify(case1Lines)})`
  );

  // 3c. case 2 — deny "*-test" wins over allow "*"
  const case2 = sshCapture(
    ip,
    user,
    key,
    `bash -c "source ${REMOTE_FILTER_LIB}; ` +
      `printf '%s\\n' owner/foo owner/foo-test | filter_repos test '*' '*-test'"`
  );
  const case2Lines = case2
    .split("\n")
    .filter((l) => l.length > 0)
    .sort();
  assert(
    JSON.stringify(case2Lines) === JSON.stringify(["owner/foo"]),
    `case 2: deny "*-test" wins over allow "*" (got ${JSON.stringify(case2Lines)})`
  );

  // 3d. case 3 — allow "tools/*" passes tools/x, blocks other/y
  const case3 = sshCapture(
    ip,
    user,
    key,
    `bash -c "source ${REMOTE_FILTER_LIB}; ` +
      `printf '%s\\n' tools/x other/y | filter_repos test 'tools/*' ''"`
  );
  const case3Lines = case3
    .split("\n")
    .filter((l) => l.length > 0)
    .sort();
  assert(
    JSON.stringify(case3Lines) === JSON.stringify(["tools/x"]),
    `case 3: allow "tools/*" passes tools/x, blocks other/y (got ${JSON.stringify(case3Lines)})`
  );
}

// ─── Group 4 ─────────────────────────────────────────────────────────────
function group4EndToEnd(
  cfg: Config,
  dropInfo: DropletInfo,
  target: { source: string; owner: string; repo: string }
): void {
  console.log("\n— Group 4: github-backup.sh end-to-end (SC#4, D-08) —");
  const { ip } = dropInfo;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;
  const { source, owner, repo } = target;

  // 4a. compute the target mirror path and snapshot its freshness (mtime of
  // FETCH_HEAD, or the mirror dir itself when FETCH_HEAD is absent) before
  // the run, plus log size so we only inspect lines this run produced. The
  // freshness snapshot proves the upcoming cron run — not Group 1's earlier
  // sync-one-repo.sh call — is what advances the target mirror.
  const mirrorPath = `${REMOTE_DIR}/${source}/${owner}_${repo}.git`;
  const freshnessCmd =
    `stat -c %Y ${mirrorPath}/FETCH_HEAD 2>/dev/null || ` +
    `stat -c %Y ${mirrorPath} 2>/dev/null || echo 0`;
  const freshnessBefore =
    parseInt(sshCapture(ip, user, key, freshnessCmd).trim(), 10) || 0;
  info(`target mirror freshness before: ${freshnessBefore}`);

  const sizeBefore =
    parseInt(
      sshCapture(
        ip,
        user,
        key,
        `wc -c < ${REMOTE_LOG} 2>/dev/null || echo 0`
      ).trim(),
      10
    ) || 0;
  info(`log size before: ${sizeBefore} bytes`);

  // 4b. run cron path — github-backup.sh is the orchestrator. `date +%s`
  // runs first in the same ssh round-trip so the run-start epoch is measured
  // on the droplet's clock, matching the freshness timestamps below.
  // Accept exit 0 (all repos OK) or 1 (≥1 repo failed). Both mean "ran
  // end-to-end"; D-08's contract is the mirror-dir + freshness + RESULT_TAG +
  // clean-log checks below, NOT all-repos-clean (which is out of v1.1 scope —
  // operator's source list may have unrelated breakage).
  const runCmd = `date +%s; ${REMOTE_BACKUP_SH} >/dev/null 2>&1; echo exit=$?`;
  const runOut = sshCapture(ip, user, key, runCmd);
  const runStartEpoch = parseInt(runOut.split(/\r?\n/)[0], 10) || 0;
  const exitMatch = runOut.match(/exit=(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : -1;
  assert(
    exitCode === 0 || exitCode === 1,
    `${REMOTE_BACKUP_SH} ran end-to-end (exit 0 or 1; got ${exitCode})`
  );

  // 4c. namespaced mirror dir exists for target (SC#4a)
  assert(
    sshExitsZero(ip, user, key, `test -d ${mirrorPath}`),
    `(SC#4a) namespaced mirror dir ${mirrorPath} exists after cron run`
  );

  // 4d. target mirror freshness advanced during THIS run (SC#4b). Group 1
  // already created/refreshed the same mirror before Group 4 starts, so 4c
  // alone is trivially true; comparing against the droplet-side run-start
  // epoch proves the cron run itself — not Group 1 — touched the target.
  // github-backup.sh runs under `set -e` and may abort before reaching the
  // target (Phase 1 behavior, out of v1.1 scope); when that happens this
  // assertion fails loud rather than passing on Group 1's leftover mirror.
  const freshnessAfter =
    parseInt(sshCapture(ip, user, key, freshnessCmd).trim(), 10) || 0;
  assert(
    freshnessAfter >= runStartEpoch,
    `(SC#4b) target mirror ${source}/${owner}/${repo} freshness did not advance ` +
      `during this cron run (mirror mtime=${freshnessAfter}, run-start=${runStartEpoch}, ` +
      `before-run mirror mtime=${freshnessBefore}) — github-backup.sh likely aborted ` +
      `before reaching the target; re-run`
  );

  // 4e. >= 1 BACKUP_REPO_RESULT action=clone|update line in the new tail
  // (SC#4c). D-08 says "at least one" — does NOT require it be the target
  // slug. github-backup.sh under `set -e` may abort after the first per-repo
  // failure (Phase 1 behavior, out of v1.1 scope); requiring the target
  // specifically would conflate "cron path works" with "target was first in
  // iteration" — 4d above already proves the target itself was reached.
  const tailCmd = `tail -c +$((${sizeBefore} + 1)) ${REMOTE_LOG}`;
  const newTail = sshCapture(ip, user, key, tailCmd);
  const resultLines = newTail
    .split("\n")
    .filter(
      (l) => l.includes(RESULT_TAG) && /action=(clone|update)/.test(l)
    );
  assert(
    resultLines.length >= 1,
    `(SC#4c) ≥1 ${RESULT_TAG} action=clone|update line in this run (got ${resultLines.length})`
  );

  // 4f. zero "unbound variable" / "command not found" in the new tail (SC#4d)
  const badLines = newTail.split("\n").filter(
    (l) => /unbound variable/.test(l) || /command not found/.test(l)
  );
  assert(
    badLines.length === 0,
    `(SC#4d) zero "unbound variable"/"command not found" in new log tail (got ${badLines.length}${
      badLines.length > 0 ? ": " + JSON.stringify(badLines.slice(0, 3)) : ""
    })`
  );
}

// ─── Target selection ────────────────────────────────────────────────────
function chooseTarget(
  cfg: Config,
  dropInfo: DropletInfo
): { source: string; owner: string; repo: string } {
  const { ip } = dropInfo;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;

  // a/b. config-pinned candidates: webhookTestRepo, then restoreTestRepo
  for (const cand of [cfg.webhookTestRepo, cfg.restoreTestRepo]) {
    if (!cand) continue;
    const parsed = parseRepoSlug(cand);
    if (!parsed) continue;
    if (!SLUG_RE.test(parsed.owner) || !SLUG_RE.test(parsed.repo)) continue;
    const src = cfg.sources.find((s) => s.name === parsed.owner);
    if (!src) continue;
    if (passesRepoFilter(src, parsed.owner, parsed.repo)) {
      info(
        `SC#4 target = ${cand} (from config.${
          cfg.webhookTestRepo === cand ? "webhookTestRepo" : "restoreTestRepo"
        })`
      );
      return { source: src.name, owner: parsed.owner, repo: parsed.repo };
    }
  }

  // c. auto-discovery via gh api on each source
  for (const src of cfg.sources) {
    if (!SLUG_RE.test(src.name)) continue;
    const accountTypeCmd =
      `set -a; source ${REMOTE_ENV(cfg)}; set +a; ` +
      `source ${REMOTE_DETECT_LIB}; detect_account_type ${src.name}`;
    const t = sshCapture(ip, user, key, accountTypeCmd).trim();
    const listCmd =
      `set -a; source ${REMOTE_ENV(cfg)}; set +a; ` +
      `source ${REMOTE_ENDPOINT_LIB}; ` +
      `gh api "$(resolve_repo_endpoint ${src.name} ${t})" --jq ".[].full_name"`;
    const repos = sshCapture(ip, user, key, listCmd)
      .split("\n")
      .filter((l) => l.length > 0);
    for (const r of repos) {
      const parsed = parseRepoSlug(r);
      if (!parsed) continue;
      if (!SLUG_RE.test(parsed.owner) || !SLUG_RE.test(parsed.repo)) continue;
      if (passesRepoFilter(src, parsed.owner, parsed.repo)) {
        info(`SC#4 target = ${r} (auto-discovered from source "${src.name}")`);
        return { source: src.name, owner: parsed.owner, repo: parsed.repo };
      }
    }
  }

  bail(
    "Phase 7 SC#4 needs at least one whitelisted repo. " +
      "Set config.webhookTestRepo or config.restoreTestRepo to a small repo, " +
      "or add a source with a non-empty allow list."
  );
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════");
  console.log(" verify:phase-7 — droplet artifact shipping (DROPLET-01/02/03)");
  console.log("══════════════════════════════════════════════════════════");

  const cfg = loadConfig();
  const dropInfo = loadDropletInfo();

  const target = chooseTarget(cfg, dropInfo);
  group1SyncOneRepoContract(cfg, dropInfo, target);
  group2DetectAccountType(cfg, dropInfo);
  group3FilterRepos(cfg, dropInfo);
  group4EndToEnd(cfg, dropInfo, target);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(" ✓ verify:phase-7 PASSED (DROPLET-01/02/03 contracts hold)");
  console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(`\n❌  ${(e as Error).message}\n`);
  process.exit(1);
});
