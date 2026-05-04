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

/**
 * WR-05: fields that get interpolated into single-quoted ssh/scp commands
 * built by lib/ssh.ts. A stray `'` or unbalanced `"` in any of these
 * produces an opaque remote-shell parse error. Restrict to a strict
 * shell-safe allow-list rather than escaping at every call site.
 */
const SHELL_SAFE_FIELDS: (keyof Config)[] = [
  "dropletName",
  "firewallName",
  "sshUser",
  "sshKeyPath",
  "githubUserOrOrg",
  "backupDir",
];
const SHELL_SAFE_RE = /^[A-Za-z0-9._/~@:-]+$/;

/**
 * NR-03: cronSchedule is interpolated into the generated backup.env as
 *   CRON_SCHEDULE="${cfg.cronSchedule}"
 * which the droplet sources with `set -a; source backup.env`. The value
 * is not in SHELL_SAFE_FIELDS because cron expressions legitimately
 * contain spaces, `*`, `,`, `/`, and `-`, which the shell-safe regex
 * rejects. Validate it against a cron-shape allow-list instead so a
 * stray `"`, `$`, `` ` ``, or newline still bails loudly.
 */
const CRON_SAFE_RE = /^[0-9*,/ \t-]+$/;

export function loadConfig(): Config {
  const p = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(p)) {
    bail(
      "config.json not found.\n" +
        "    Copy config.example.json → config.json and fill in your values."
    );
  }
  let cfg: Config;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Config;
  } catch (e) {
    bail(`config.json is not valid JSON: ${(e as Error).message}`);
  }
  for (const k of REQUIRED_FIELDS) {
    if (!cfg[k]) bail(`config.json is missing required field: "${k}"`);
  }
  for (const k of SHELL_SAFE_FIELDS) {
    const v = cfg[k];
    if (typeof v === "string" && !SHELL_SAFE_RE.test(v)) {
      bail(
        `config.json field "${k}" contains characters outside ` +
          `[A-Za-z0-9._/~@:-]; refusing to interpolate into ssh commands. ` +
          `Got: ${JSON.stringify(v)}`
      );
    }
  }
  // NR-03: cronSchedule is interpolated into backup.env quoted as
  // CRON_SCHEDULE="…", which the droplet sources via `set -a; source`.
  // A stray `"`, `$`, backtick, or newline would corrupt the env file
  // or inject shell on the droplet. Cron expressions legitimately
  // contain spaces, `*`, `,`, `/`, and `-`, so use a cron-shape
  // allow-list rather than the strict shell-safe regex.
  if (!CRON_SAFE_RE.test(cfg.cronSchedule)) {
    bail(
      `config.json field "cronSchedule" is not a safe cron expression; ` +
        `refusing to interpolate into backup.env. Got: ${JSON.stringify(
          cfg.cronSchedule
        )}`
    );
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
