/**
 * tests/helpers/backup-run.ts
 *
 * Runs a temp copy of droplet/github-backup.sh with a stub `gh` and a stub
 * sync-one-repo.sh. The script resets PATH to the system directories, so the
 * copy gets the stub directory put in front of that PATH line.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DROPLET = path.join(REPO_ROOT, "droplet");
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
const PATH_LINE = `export PATH="${SYSTEM_PATH}"`;

export interface GhRoute {
  match: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
}

export interface RepoRow {
  source: string;
  name: string;
  action: string;
  duration_ms: number;
}

export interface LastRun {
  exit_code: number;
  total: number;
  success: number;
  fail: number;
  repos: RepoRow[];
  stopped_early: boolean;
}

export interface BackupRun {
  status: number;
  log: string;
  lastRun: LastRun;
  ghCalls: string[];
}

function detectSkipReason(): string | false {
  const probe = spawnSync(
    "/usr/bin/env",
    ["bash", "-c", '(( BASH_VERSINFO[0] >= 5 )) && command -v jq >/dev/null && command -v flock >/dev/null'],
    { env: { PATH: SYSTEM_PATH } }
  );
  if (probe.error || probe.status !== 0) {
    return `github-backup.sh needs bash >= 5, jq and flock in ${SYSTEM_PATH}`;
  }
  return false;
}

export const backupRunSkip = detectSkipReason();

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function writeGhStub(binDir: string, routes: GhRoute[], callsFile: string): void {
  const cases = routes
    .map(
      (r) =>
        `  *${shellQuote(r.match)}*) printf '%s' ${shellQuote(r.stdout ?? "")}; ` +
        `printf '%s' ${shellQuote(r.stderr ?? "")} >&2; exit ${r.exit ?? 0} ;;`
    )
    .join("\n");
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(callsFile)}\ncase "$*" in\n${cases}\nesac\n` +
      `echo "gh stub: no route for $*" >&2\nexit 1\n`,
    { mode: 0o755 }
  );
}

function prepareBackupDir(backupDir: string, stubDir: string, sources: string[]): void {
  fs.mkdirSync(path.join(backupDir, "lib"), { recursive: true });
  for (const f of fs.readdirSync(path.join(DROPLET, "lib"))) {
    fs.copyFileSync(path.join(DROPLET, "lib", f), path.join(backupDir, "lib", f));
  }
  const script = fs.readFileSync(path.join(DROPLET, "github-backup.sh"), "utf8");
  if (!script.includes(PATH_LINE)) {
    throw new Error(`github-backup.sh has no line ${PATH_LINE}`);
  }
  fs.writeFileSync(
    path.join(backupDir, "github-backup.sh"),
    script.replace(PATH_LINE, `export PATH="${stubDir}:${SYSTEM_PATH}"`),
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(backupDir, "sync-one-repo.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(backupDir, "backup.env"),
    `GITHUB_TOKEN=test-token\nGITHUB_USER_OR_ORG=${sources[0]}\n` +
      `GITHUB_SOURCES="${sources.join(" ")}"\nBACKUP_DIR=${backupDir}\n`
  );
}

export function runBackup(
  sources: string[],
  routes: GhRoute[],
  setup?: (backupDir: string) => void
): BackupRun {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-run-"));
  const backupDir = path.join(root, "backup");
  const stubDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const logFile = path.join(root, "backup.log");
  const callsFile = path.join(root, "gh-calls");
  try {
    fs.mkdirSync(stubDir);
    writeGhStub(stubDir, routes, callsFile);
    prepareBackupDir(backupDir, stubDir, sources);
    setup?.(backupDir);
    const r = spawnSync("/usr/bin/env", ["bash", path.join(backupDir, "github-backup.sh")], {
      encoding: "utf8",
      env: {
        PATH: SYSTEM_PATH,
        BACKUP_DIR: backupDir,
        LOG_FILE: logFile,
        STATE_DIR: stateDir,
        LOCK_FILE: path.join(root, "backup.lock"),
      },
    });
    const lastRunFile = path.join(stateDir, "last-run.json");
    if (!fs.existsSync(lastRunFile)) {
      throw new Error(`github-backup.sh wrote no last-run.json (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
    }
    return {
      status: r.status ?? -1,
      log: fs.readFileSync(logFile, "utf8"),
      lastRun: JSON.parse(fs.readFileSync(lastRunFile, "utf8")) as LastRun,
      ghCalls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean) : [],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
