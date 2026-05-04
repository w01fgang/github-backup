#!/usr/bin/env node
/**
 * scripts/destroy-droplet.ts
 *
 * Idempotently destroys the github-backup droplet, the matching cloud firewall,
 * and the local .droplet.json. Implements decision D-09 scope only:
 *   droplet + firewall + .droplet.json — nothing else.
 *
 * Refuses to run when .droplet.json is missing (T-01-01-01) so we cannot
 * accidentally delete a stranger's droplet by name. Prompts y/N on stdin
 * by default; pass --yes to skip the prompt (T-01-01-02). The smoke runner's
 * --fresh flag passes --yes; an interactive operator gets the prompt.
 *
 * Usage:
 *   npm run destroy-droplet            # prompts y/N
 *   npm run destroy-droplet -- --yes   # non-interactive (used by smoke --fresh)
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { bail, loadConfig, loadDropletInfo } from "./lib/config";
import { runVisible } from "./lib/ssh";
import { doctlJson } from "./lib/doctl";

interface FirewallRecord {
  id: string;
  name: string;
}

interface DropletRecord {
  id: number;
  name: string;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer: string = await new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Find a firewall by name. Returns id or null. Tolerates the doctl quirk
 * where an empty firewall list errors on some versions (matches create-droplet).
 */
function findFirewallId(firewallName: string): string | null {
  let all: FirewallRecord[] = [];
  try {
    all = doctlJson<FirewallRecord[]>(
      "doctl compute firewall list --output json"
    );
  } catch {
    return null;
  }
  return all.find((fw) => fw.name === firewallName)?.id ?? null;
}

/**
 * Returns true if the droplet still exists. We check by id (from .droplet.json)
 * — never by name — to avoid the T-01-01-01 wrong-droplet hazard.
 *
 * Distinguish a genuine 404 / "not found" from any other doctl failure
 * (auth-expired, network blip, doctl missing). On non-404 errors we
 * rethrow so destroy-droplet aborts before deleting .droplet.json,
 * preventing an orphaned billable droplet (WR-01).
 */
function dropletExists(dropletId: number): boolean {
  try {
    doctlJson<DropletRecord>(
      `doctl compute droplet get ${dropletId} --output json`
    );
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // doctl prints "404" / "not found" in its stderr/message when the
    // resource is gone. Anything else is a real failure we must surface.
    if (/\b404\b|not found/i.test(msg)) {
      return false;
    }
    throw new Error(
      `doctl droplet get ${dropletId} failed (refusing to assume absence): ${msg}`
    );
  }
}

function deleteDropletJson(): void {
  const p = path.resolve(process.cwd(), ".droplet.json");
  try {
    fs.unlinkSync(p);
    console.log("   .droplet.json removed.");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("   .droplet.json already absent.");
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  // 1. Refuse without .droplet.json (T-01-01-01).
  const dropletJsonPath = path.resolve(process.cwd(), ".droplet.json");
  if (!fs.existsSync(dropletJsonPath)) {
    bail("Refusing to destroy: .droplet.json not found.");
  }

  const droplet = loadDropletInfo();
  const cfg = loadConfig();
  const skipPrompt = hasFlag("--yes") || hasFlag("-y");

  if (!skipPrompt) {
    const ok = await confirm(
      `Destroy droplet ${droplet.name} (id ${droplet.id}) and firewall ${cfg.firewallName}? [y/N]: `
    );
    if (!ok) bail("Aborted.");
  }

  console.log(`\n🗑️   Destroying github-backup infrastructure…`);

  // 2. Firewall first — leaves no orphaned firewall pointing at a dead droplet.
  const firewallId = findFirewallId(cfg.firewallName);
  if (firewallId) {
    console.log(`   Deleting firewall ${cfg.firewallName} (${firewallId})…`);
    runVisible(`doctl compute firewall delete ${firewallId} --force`);
  } else {
    console.log(`   Firewall ${cfg.firewallName} already absent.`);
  }

  // 3. Droplet by id (T-01-01-01: id only, never by name).
  if (dropletExists(droplet.id)) {
    console.log(`   Deleting droplet ${droplet.name} (${droplet.id})…`);
    runVisible(`doctl compute droplet delete ${droplet.id} --force`);
  } else {
    console.log(`   Droplet ${droplet.name} (${droplet.id}) already absent.`);
  }

  // 4. Local state.
  deleteDropletJson();

  console.log(`\n✅  Destroy complete.\n`);
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
