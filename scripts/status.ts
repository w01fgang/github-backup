#!/usr/bin/env node
/**
 * scripts/status.ts
 *
 * Local wrapper for the droplet-side github-backup-status binary (D-01, D-02).
 * SSHes to the droplet, runs /opt/github-backups/github-backup-status.sh, and
 * propagates the remote exit code as the local exit code.
 *
 * Forwards any argv after `--` to the remote binary:
 *   npm run status
 *   npm run status -- --json
 *   npm run status -- --verbose
 *
 * Prerequisites:
 *   - .droplet.json (run `npm run create-droplet` first)
 *   - config.json
 *   - Droplet already bootstrapped (Phase 1)
 */

import { spawnSync } from "child_process";
import { bail, loadConfig, loadDropletInfo } from "./lib/config";
import { expandHome } from "./lib/ssh";

const ALLOWED_FLAG_RE = /^[A-Za-z0-9._=/-]+$/;

function main(): void {
  const cfg = loadConfig();
  const { ip } = loadDropletInfo();
  const { sshUser: user, sshKeyPath: keyPath, backupDir } = cfg;

  const flags = process.argv.slice(2);
  for (const f of flags) {
    if (!ALLOWED_FLAG_RE.test(f)) {
      bail(
        `Refusing to forward argv with shell-unsafe characters: ${JSON.stringify(f)}\n` +
          "    Status flags are restricted to [A-Za-z0-9._=/-]."
      );
    }
  }

  const remoteCmd = `bash ${backupDir}/github-backup-status.sh ${flags.join(" ")}`.trim();

  const result = spawnSync(
    "ssh",
    [
      "-i", expandHome(keyPath),
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      `${user}@${ip}`,
      remoteCmd,
    ],
    { stdio: "inherit" }
  );

  if (result.error) {
    bail(`ssh transport failed: ${result.error.message}`);
  }

  process.exit(result.status ?? 1);
}

main();
