#!/usr/bin/env node
/**
 * scripts/bootstrap-droplet.ts
 *
 * Uploads the droplet/ scripts and a generated backup.env to the droplet,
 * then runs bootstrap.sh remotely to install packages, configure GitHub CLI
 * authentication, and install the recurring backup cron job.
 *
 * Usage:
 *   GITHUB_TOKEN=<your_pat> npm run bootstrap-droplet
 *
 * The script is fully idempotent — running it again will overwrite scripts
 * and re-run bootstrap.sh, which is itself idempotent.
 *
 * Prerequisites:
 *   - .droplet.json must exist    (run `npm run create-droplet` first)
 *   - config.json must exist
 *   - GITHUB_TOKEN env var must be set
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Config {
  sshKeyPath: string;
  sshUser: string;
  githubUserOrOrg: string;
  backupDir: string;
  cronSchedule: string;
}

interface DropletInfo {
  id: number;
  ip: string;
  name: string;
  region: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function bail(msg: string): never {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

function loadConfig(): Config {
  const p = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(p)) bail("config.json not found.");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Config;
}

function loadDropletInfo(): DropletInfo {
  const p = path.resolve(process.cwd(), ".droplet.json");
  if (!fs.existsSync(p)) {
    bail(
      ".droplet.json not found.\n" +
        "    Run `npm run create-droplet` first."
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as DropletInfo;
}

/** Expand leading ~ to the real home directory. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return p.replace("~", os.homedir());
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// SSH / SCP wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build common SSH / SCP option flags.
 *
 * - StrictHostKeyChecking=accept-new  — auto-accept new host keys (won't
 *   accept a changed key, protecting against MITM on subsequent runs).
 * - BatchMode=yes                     — fail immediately instead of prompting.
 * - ConnectTimeout=15                 — don't hang forever if port is closed.
 */
function sshFlags(keyPath: string): string {
  return [
    `-i "${expandHome(keyPath)}"`,
    `-o StrictHostKeyChecking=accept-new`,
    `-o BatchMode=yes`,
    `-o ConnectTimeout=15`,
  ].join(" ");
}

/**
 * Run a local command, streaming all output (stdout + stderr) to the terminal.
 * Throws on non-zero exit.
 */
function runVisible(cmd: string): void {
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err: unknown) {
    const detail =
      err instanceof Error
        ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ??
          err.message
        : String(err);
    throw new Error(`Command failed:\n  ${cmd}\n  ${detail}`);
  }
}

/**
 * Run a local command silently (all output captured).
 * Returns trimmed stdout. Throws on non-zero exit.
 */
function runCapture(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (err: unknown) {
    const detail =
      err instanceof Error
        ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ??
          err.message
        : String(err);
    throw new Error(`Command failed:\n  ${cmd}\n  ${detail}`);
  }
}

/**
 * Execute a command on the remote host, streaming output locally.
 *
 * The remote command is wrapped in single quotes on the local shell so that
 * globs (e.g. *.sh) and && are evaluated by the remote bash, not locally.
 * Commands passed here must not themselves contain single-quote characters.
 */
function sshRun(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): void {
  runVisible(`ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`);
}

/**
 * Copy a single local file to a remote path.
 */
function scpFile(
  ip: string,
  user: string,
  keyPath: string,
  localFile: string,
  remotePath: string
): void {
  runVisible(
    `scp ${sshFlags(keyPath)} "${localFile}" "${user}@${ip}:${remotePath}"`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wait for SSH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe SSH until it accepts connections (up to ~6 minutes).
 * DigitalOcean droplets typically need ~30–60 s after "active" before SSH
 * is ready to accept connections.
 */
async function waitForSsh(
  ip: string,
  user: string,
  keyPath: string,
  maxRetries = 36
): Promise<void> {
  console.log(`\n⏳  Waiting for SSH on ${ip} (up to 6 min)…`);
  for (let i = 1; i <= maxRetries; i++) {
    try {
      runCapture(
        `ssh ${sshFlags(keyPath)} ${user}@${ip} echo ok`
      );
      console.log(`   SSH is up! ✓`);
      return;
    } catch {
      process.stdout.write(`   [${i}/${maxRetries}] Not ready, retrying in 10 s…\r`);
      await sleep(10_000);
    }
  }
  bail("SSH did not become available within 6 minutes.");
}

// ─────────────────────────────────────────────────────────────────────────────
// backup.env generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a temporary backup.env to the OS temp dir.
 * Returns the path. The caller is responsible for deleting it.
 *
 * The file is created with mode 0600 to minimise the window during which
 * it is readable by other OS users on the local machine.
 */
function writeBackupEnv(cfg: Config, githubToken: string): string {
  const lines = [
    `# Generated by bootstrap-droplet.ts — do not edit manually`,
    `# Stored at ${cfg.backupDir}/backup.env on the droplet (mode 600)`,
    `GITHUB_TOKEN=${githubToken}`,
    `GITHUB_USER_OR_ORG=${cfg.githubUserOrOrg}`,
    `BACKUP_DIR=${cfg.backupDir}`,
    // Wrap schedule in quotes so it survives `source backup.env` correctly
    `CRON_SCHEDULE="${cfg.cronSchedule}"`,
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-backup-"));
  const envPath = path.join(tmpDir, "backup.env");
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  return envPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Validate inputs ────────────────────────────────────────────────────────
  const githubToken = process.env["GITHUB_TOKEN"] ?? "";
  if (!githubToken) {
    bail(
      "GITHUB_TOKEN environment variable is not set.\n" +
        "    Usage: GITHUB_TOKEN=<your_pat> npm run bootstrap-droplet"
    );
  }

  const cfg = loadConfig();
  const droplet = loadDropletInfo();
  const { ip, name } = droplet;
  const { sshUser: user, sshKeyPath: keyPath, backupDir } = cfg;

  console.log(`\n📦  Bootstrapping droplet "${name}" (${ip})…`);

  // ── Wait for SSH ───────────────────────────────────────────────────────────
  await waitForSsh(ip, user, keyPath);

  // ── Generate backup.env ────────────────────────────────────────────────────
  // This file contains the GitHub token — handle it carefully.
  console.log(`\n📝  Generating backup.env…`);
  const envPath = writeBackupEnv(cfg, githubToken);

  try {
    // ── Create remote backup directory ────────────────────────────────────
    console.log(`\n📁  Creating remote directory: ${backupDir}`);
    sshRun(ip, user, keyPath, `mkdir -p "${backupDir}"`);

    // ── Upload backup.env FIRST so bootstrap.sh can source it ─────────────
    console.log(`\n🔑  Uploading backup.env…`);
    scpFile(ip, user, keyPath, envPath, `${backupDir}/backup.env`);

    // ── Upload droplet/ scripts one by one ────────────────────────────────
    console.log(`\n📤  Uploading droplet scripts…`);
    const dropletDir = path.resolve(process.cwd(), "droplet");
    if (!fs.existsSync(dropletDir)) {
      bail("droplet/ directory not found in the project root.");
    }

    const scriptFiles = fs
      .readdirSync(dropletDir)
      .map((f) => path.join(dropletDir, f));

    for (const file of scriptFiles) {
      const basename = path.basename(file);
      console.log(`   → ${basename}`);
      scpFile(ip, user, keyPath, file, `${backupDir}/${basename}`);
    }

    // ── Run bootstrap.sh ───────────────────────────────────────────────────
    console.log(`\n🚀  Running bootstrap.sh on the droplet…`);
    console.log("─".repeat(60));
    sshRun(
      ip,
      user,
      keyPath,
      `chmod +x ${backupDir}/*.sh && ${backupDir}/bootstrap.sh`
    );
    console.log("─".repeat(60));
  } finally {
    // Always delete the local temp file containing the token
    const tmpDir = path.dirname(envPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n✅  Bootstrap complete!`);
  console.log(`\n   SSH into the droplet:`);
  console.log(`   ssh -i ${cfg.sshKeyPath} ${user}@${ip}`);
  console.log(`\n   Trigger a backup manually:`);
  console.log(
    `   ssh -i ${cfg.sshKeyPath} ${user}@${ip} "${backupDir}/github-backup.sh"`
  );
  console.log(`\n   Watch the backup log:`);
  console.log(
    `   ssh -i ${cfg.sshKeyPath} ${user}@${ip} "tail -f /var/log/github-backup.log"\n`
  );
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
