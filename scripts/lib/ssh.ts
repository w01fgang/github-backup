/**
 * scripts/lib/ssh.ts
 *
 * Shared local-shell + SSH/SCP helpers used by every entry script.
 * Extracted verbatim from scripts/bootstrap-droplet.ts so behavior is unchanged.
 */

import { execSync } from "child_process";
import * as os from "os";
import { bail } from "./config";

/** Expand leading ~ to the real home directory. */
export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return p.replace("~", os.homedir());
  return p;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a local command, streaming all output (stdout + stderr) to the terminal.
 * Throws on non-zero exit.
 */
export function runVisible(cmd: string): void {
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
export function runCapture(cmd: string): string {
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
 * Build common SSH / SCP option flags.
 *
 * - StrictHostKeyChecking=accept-new — auto-accept new host keys (won't accept
 *   a changed key, protecting against MITM on subsequent runs).
 * - BatchMode=yes — fail immediately instead of prompting.
 * - ConnectTimeout=15 — don't hang forever if port is closed.
 */
export function sshFlags(keyPath: string): string {
  return [
    `-i "${expandHome(keyPath)}"`,
    `-o StrictHostKeyChecking=accept-new`,
    `-o BatchMode=yes`,
    `-o ConnectTimeout=15`,
  ].join(" ");
}

/**
 * Execute a command on the remote host, streaming output locally.
 *
 * The remote command is wrapped in single quotes on the local shell so that
 * globs (e.g. *.sh) and && are evaluated by the remote bash, not locally.
 * Commands passed here must not themselves contain single-quote characters.
 */
export function sshRun(
  ip: string,
  user: string,
  keyPath: string,
  remoteCmd: string
): void {
  runVisible(`ssh ${sshFlags(keyPath)} ${user}@${ip} '${remoteCmd}'`);
}

/**
 * Copy a single local file to a remote path.
 *
 * Argument order matches the existing scripts/bootstrap-droplet.ts:
 *   (ip, user, keyPath, localFile, remotePath)
 */
export function scpFile(
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

/**
 * Probe SSH until it accepts connections (up to ~6 minutes by default).
 * DigitalOcean droplets typically need ~30–60 s after "active" before SSH
 * is ready to accept connections.
 */
export async function waitForSsh(
  ip: string,
  user: string,
  keyPath: string,
  maxRetries = 36
): Promise<void> {
  console.log(`\n⏳  Waiting for SSH on ${ip} (up to 6 min)…`);
  for (let i = 1; i <= maxRetries; i++) {
    try {
      runCapture(`ssh ${sshFlags(keyPath)} ${user}@${ip} echo ok`);
      console.log(`   SSH is up! ✓`);
      return;
    } catch {
      process.stdout.write(`   [${i}/${maxRetries}] Not ready, retrying in 10 s…\r`);
      await sleep(10_000);
    }
  }
  bail("SSH did not become available within 6 minutes.");
}
