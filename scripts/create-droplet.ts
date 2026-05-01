#!/usr/bin/env node
/**
 * scripts/create-droplet.ts
 *
 * Creates a DigitalOcean droplet for GitHub backups, creates a cloud firewall
 * that restricts inbound SSH to the configured CIDR, attaches the droplet to
 * the firewall, and saves { id, ip, name, region } to .droplet.json.
 *
 * Usage:
 *   npm run create-droplet
 *
 * Prerequisites:
 *   - doctl installed and authenticated  (doctl auth init)
 *   - config.json present               (copy from config.example.json)
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Config {
  region: string;
  size: string;
  image: string;
  dropletName: string;
  firewallName: string;
  sshKeyFingerprint: string;
  sshKeyPath: string;
  sshUser: string;
  githubUserOrOrg: string;
  backupDir: string;
  cronSchedule: string;
  allowedSSHCidr: string;
  tags?: string[];
}

interface DropletNetwork {
  ip_address: string;
  type: "public" | "private";
}

interface DropletRecord {
  id: number;
  name: string;
  status: string;
  networks: { v4: DropletNetwork[] };
}

interface FirewallRecord {
  id: string;
  name: string;
  droplet_ids: number[];
}

/** Persisted to .droplet.json after successful creation. */
interface DropletInfo {
  id: number;
  ip: string;
  name: string;
  region: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function bail(msg: string): never {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

function loadConfig(): Config {
  const p = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(p)) {
    bail(
      "config.json not found.\n" +
        "    Copy config.example.json → config.json and fill in your values."
    );
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Config;
  const required: (keyof Config)[] = [
    "region",
    "size",
    "image",
    "dropletName",
    "firewallName",
    "sshKeyFingerprint",
    "sshKeyPath",
    "sshUser",
    "githubUserOrOrg",
    "backupDir",
    "cronSchedule",
    "allowedSSHCidr",
  ];
  for (const k of required) {
    if (!cfg[k]) bail(`config.json is missing required field: "${k}"`);
  }
  return cfg;
}

/**
 * Run a shell command silently (all output captured).
 * Returns trimmed stdout. Throws a descriptive Error on non-zero exit.
 */
function runCapture(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (err: unknown) {
    const detail =
      err instanceof Error
        ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? err.message
        : String(err);
    throw new Error(`Command failed:\n  ${cmd}\n  ${detail}`);
  }
}

/** Run a doctl command and parse its JSON output. */
function doctlJson<T>(cmd: string): T {
  const raw = runCapture(cmd);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse JSON from:\n  ${cmd}\n  Output: ${raw}`);
  }
}

/** Parse a doctl JSON response that may return either an array or a single object. */
function first<T>(cmd: string): T {
  const result = doctlJson<T | T[]>(cmd);
  return Array.isArray(result) ? (result as T[])[0] : (result as T);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Droplet
// ─────────────────────────────────────────────────────────────────────────────

function publicIp(d: DropletRecord): string | undefined {
  return d.networks?.v4?.find((n) => n.type === "public")?.ip_address;
}

/**
 * Poll doctl until the droplet is "active" with a public IP.
 * Tries every 5 s for up to 5 minutes.
 */
async function waitForActiveIp(
  dropletId: number,
  maxAttempts = 60
): Promise<string> {
  console.log("⏳  Waiting for droplet to become active (up to 5 min)…");
  for (let i = 1; i <= maxAttempts; i++) {
    await sleep(5_000);
    try {
      const d = first<DropletRecord>(
        `doctl compute droplet get ${dropletId} --output json`
      );
      const ip = publicIp(d);
      if (d.status === "active" && ip) {
        console.log(`✅  Active — public IP: ${ip}`);
        return ip;
      }
      process.stdout.write(
        `   [${i}/${maxAttempts}] status=${d.status}, ip=${ip ?? "pending"}…\r`
      );
    } catch {
      process.stdout.write(`   [${i}/${maxAttempts}] Querying droplet…\r`);
    }
  }
  bail("Droplet did not become active within 5 minutes.");
}

async function findOrCreateDroplet(
  cfg: Config
): Promise<{ id: number; ip: string }> {
  console.log(`\n🔍  Checking for existing droplet "${cfg.dropletName}"…`);

  const all = doctlJson<DropletRecord[]>(
    "doctl compute droplet list --output json"
  );
  const existing = all.find((d) => d.name === cfg.dropletName);

  if (existing) {
    const ip = publicIp(existing);
    if (!ip) bail("Existing droplet has no public IP. Check the DO console.");
    console.log(
      `   Already exists — ID: ${existing.id}, IP: ${ip}. Skipping creation.`
    );
    return { id: existing.id, ip };
  }

  const tags = (cfg.tags ?? ["github-backup"]).join(",");
  const createCmd = [
    `doctl compute droplet create "${cfg.dropletName}"`,
    `--region ${cfg.region}`,
    `--size ${cfg.size}`,
    `--image ${cfg.image}`,
    `--ssh-keys "${cfg.sshKeyFingerprint}"`,
    `--tag-names "${tags}"`,
    `--output json`,
  ].join(" ");

  console.log(`🚀  Creating droplet…`);
  console.log(`   $ ${createCmd}`);
  const created = first<DropletRecord>(createCmd);
  console.log(`   Created — ID: ${created.id}`);

  const ip = await waitForActiveIp(created.id);
  return { id: created.id, ip };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firewall
// ─────────────────────────────────────────────────────────────────────────────

function findOrCreateFirewall(cfg: Config): string {
  console.log(`\n🛡️   Checking for existing firewall "${cfg.firewallName}"…`);

  let all: FirewallRecord[] = [];
  try {
    all = doctlJson<FirewallRecord[]>("doctl compute firewall list --output json");
  } catch {
    // An empty firewall list may error on some doctl versions — safe to ignore.
  }

  const existing = all.find((fw) => fw.name === cfg.firewallName);
  if (existing) {
    console.log(
      `   Already exists — ID: ${existing.id}. Skipping creation.`
    );
    return existing.id;
  }

  // Inbound: SSH (22/tcp) from the configured CIDR only.
  // Outbound: all TCP, UDP, ICMP allowed (needed for apt, DNS, HTTPS git clones).
  const createCmd = [
    `doctl compute firewall create`,
    `--name "${cfg.firewallName}"`,
    `--inbound-rules "protocol:tcp,ports:22,sources:addresses:${cfg.allowedSSHCidr}"`,
    `--outbound-rules "protocol:tcp,ports:all,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0"`,
    `--outbound-rules "protocol:udp,ports:all,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0"`,
    `--outbound-rules "protocol:icmp,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0"`,
    `--output json`,
  ].join(" ");

  console.log(`   Creating firewall…`);
  console.log(`   $ ${createCmd}`);
  const fw = first<FirewallRecord>(createCmd);
  console.log(`   Created — ID: ${fw.id}`);
  return fw.id;
}

function attachDropletToFirewall(firewallId: string, dropletId: number): void {
  const fw = first<FirewallRecord>(
    `doctl compute firewall get ${firewallId} --output json`
  );
  if ((fw.droplet_ids ?? []).includes(dropletId)) {
    console.log(`   Droplet is already attached to the firewall. ✓`);
    return;
  }
  runCapture(
    `doctl compute firewall add-droplets ${firewallId} --droplet-ids ${dropletId}`
  );
  console.log(`   Droplet attached to firewall. ✓`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();

  // ── Droplet ──────────────────────────────────────────────────────────────
  const { id: dropletId, ip: dropletIp } = await findOrCreateDroplet(cfg);

  // ── Firewall ─────────────────────────────────────────────────────────────
  const firewallId = findOrCreateFirewall(cfg);

  console.log(`\n🔗  Attaching droplet to firewall…`);
  attachDropletToFirewall(firewallId, dropletId);

  // ── Persist state ─────────────────────────────────────────────────────────
  const info: DropletInfo = {
    id: dropletId,
    ip: dropletIp,
    name: cfg.dropletName,
    region: cfg.region,
  };
  const outPath = path.resolve(process.cwd(), ".droplet.json");
  fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + "\n");

  console.log(`\n✅  Done!`);
  console.log(`   Droplet IP  : ${dropletIp}`);
  console.log(`   Saved to    : .droplet.json`);
  console.log(
    `\n   Next step   : GITHUB_TOKEN=<your_pat> npm run bootstrap-droplet\n`
  );
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
