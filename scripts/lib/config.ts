/**
 * scripts/lib/config.ts
 *
 * Shared config + droplet-info loaders. Reads ./config.json and ./.droplet.json
 * from the project root. Used by every entry script (create, bootstrap, destroy,
 * and the upcoming smoke + verify runners).
 */

import * as fs from "fs";
import * as path from "path";

export interface Config {
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

export interface DropletInfo {
  id: number;
  ip: string;
  name: string;
  region: string;
}

export function bail(msg: string): never {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

/**
 * Required-field set for full config validation. `create-droplet` needs the
 * complete superset; bootstrap historically only consumed a subset, but the
 * underlying file is the same — checking the superset here makes sure no
 * downstream script silently runs against a half-filled config.
 */
const REQUIRED_FIELDS: (keyof Config)[] = [
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

export function loadConfig(): Config {
  const p = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(p)) {
    bail(
      "config.json not found.\n" +
        "    Copy config.example.json → config.json and fill in your values."
    );
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Config;
  for (const k of REQUIRED_FIELDS) {
    if (!cfg[k]) bail(`config.json is missing required field: "${k}"`);
  }
  return cfg;
}

export function loadDropletInfo(): DropletInfo {
  const p = path.resolve(process.cwd(), ".droplet.json");
  if (!fs.existsSync(p)) {
    bail(
      ".droplet.json not found.\n" +
        "    Run `npm run create-droplet` first."
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as DropletInfo;
}
