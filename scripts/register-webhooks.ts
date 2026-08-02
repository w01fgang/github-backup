#!/usr/bin/env node
/**
 * scripts/register-webhooks.ts
 *
 * Idempotently create GitHub webhooks for every repo under each source in
 * cfg.sources. Reads WEBHOOK_SECRET from the droplet's backup.env
 * over SSH so there is no local secret cache that can drift after
 * `bootstrap-droplet --rotate-webhook-secret`.
 *
 * Webhooks are registered on every repo of each source's owner that the token
 * can admin AND that survives that source's `repos.allow` / `repos.deny` globs.
 *
 * REPOS-01 parity (WEBHOOK-04): filtering here uses the same
 * `droplet/lib/filter-repos.sh` the cron path sources, so registration, cron,
 * and the droplet's webhook-listener all agree on which repos may be mirrored.
 * A denied repo never gets a hook; one that already carries a hook (registered
 * before the deny rule existed, or added by hand) is reported at the end for
 * removal — and is rejected with 403 by the listener in the meantime.
 *
 * Usage:
 *   npm run register-webhooks                # create missing webhooks; no-op on existing
 *   npm run register-webhooks -- --update    # also PATCH existing webhooks (post --rotate-webhook-secret)
 *   npm run register-webhooks -- --dry-run   # show what would happen, no API calls
 *
 * Refs: D-21, D-22 (.planning/phases/03-webhook/03-CONTEXT.md)
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { bail, loadConfig, loadDropletInfo } from "./lib/config";
import { sshFlags, runCapture } from "./lib/ssh";

function gh(args: string): string {
  return runCapture(`gh api ${args}`);
}

const FILTER_LIB = path.resolve(__dirname, "..", "droplet", "lib", "filter-repos.sh");

/**
 * REPOS-01: keep only the repos a source's allow/deny globs admit.
 *
 * Delegates to the canonical `filter_repos` rather than reimplementing bash
 * `case` glob semantics in TS, so registration cannot drift from the cron path
 * or the droplet listener. Empty allow AND empty deny is pass-through
 * (ROADMAP SC#5) and skips the subprocess.
 */
function filterRepos(
  source: string,
  fullNames: string[],
  allow: string[],
  deny: string[]
): string[] {
  const allowStr = allow.join(" ").trim();
  const denyStr = deny.join(" ").trim();
  if (!allowStr && !denyStr) return fullNames;
  if (!fs.existsSync(FILTER_LIB)) {
    bail(`REPOS-01 filter helper missing: ${FILTER_LIB}. Refusing to register webhooks unfiltered.`);
  }
  const r = spawnSync(
    "bash",
    ["-c", 'source "$0"; filter_repos "$1" "$2" "$3"', FILTER_LIB, source, allowStr, denyStr],
    { input: fullNames.join("\n") + "\n", encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    bail(
      `REPOS-01 filter failed for source "${source}": ` +
        `${r.error ? r.error.message : `exit ${r.status}`}. Refusing to register webhooks unfiltered.`
    );
  }
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function ghIgnoreStderr(args: string): CmdResult {
  try {
    return { ok: true, stdout: gh(args), stderr: "" };
  } catch (e: unknown) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Run a local command via execSync with stdin = body. Used for gh api
 * POST/PATCH with --input -, which avoids any shell-quoting of the JSON
 * body.
 */
function ghJson(method: "POST" | "PATCH", url: string, body: object): void {
  execSync(`gh api -X ${method} ${url} --input -`, {
    input: JSON.stringify(body),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const dryRun = process.argv.includes("--dry-run");

  const cfg = loadConfig();
  const droplet = loadDropletInfo();
  const url = `https://${cfg.webhookHostname}/webhook/github`;

  // ── Read WEBHOOK_SECRET from droplet over SSH ───────────────────────────
  const sshCmd =
    `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${droplet.ip} ` +
    `'grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env 2>/dev/null'`;
  let secret = "";
  try {
    const line = runCapture(sshCmd).trim();
    if (line.startsWith("WEBHOOK_SECRET=")) {
      secret = line.slice("WEBHOOK_SECRET=".length).trim();
    }
  } catch (e) {
    bail(
      `Could not read WEBHOOK_SECRET from ${cfg.sshUser}@${droplet.ip}:/opt/github-backups/backup.env. ` +
        `Run \`npm run bootstrap-droplet\` first, or check SSH key access. ` +
        `(${e instanceof Error ? e.message : e})`
    );
  }
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    bail(
      `Remote WEBHOOK_SECRET malformed (expected 64 hex chars, got len=${secret.length}). Re-bootstrap.`
    );
  }

  // ── Per-source: detect account type, list repos, register webhooks ──────
  let registered = 0;
  let alreadyPresent = 0;
  let updated = 0;
  let failed = 0;
  let wouldRegister = 0;
  let wouldUpdate = 0;
  let skippedDenied = 0;
  const staleDenied: Array<{ full: string; ids: string[] }> = [];

  for (const src of cfg.sources) {
    const owner = src.name;
    let acctType = "User";
    try {
      acctType = gh(`/users/${owner} --jq .type`).trim() || "User";
    } catch {
      acctType = "User";
    }
    const endpoint =
      acctType === "Organization"
        ? `/orgs/${owner}/repos?type=all&per_page=100`
        : `/users/${owner}/repos?type=all&per_page=100`;

    // Per-source listing must not be fatal: one source that 404s / is invisible
    // to the token / is rate-limited would otherwise throw out of this loop and
    // skip every remaining source. Log, tally, and move on.
    let fullNames: string[];
    try {
      fullNames = gh(`--paginate "${endpoint}" --jq '.[] | select(.permissions.admin) | .full_name'`)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.log(`   ✗ ${owner}: repo list failed (${msg}) — skipping source`);
      failed++;
      continue;
    }

    // REPOS-01: never put a hook on a repo the operator excluded.
    const kept = filterRepos(owner, fullNames, src.allow, src.deny);
    const denied = fullNames.filter((f) => !kept.includes(f));

    console.log(
      `\n📡  Source: ${owner} (${acctType}) — ${fullNames.length} repos` +
        (denied.length ? `, ${denied.length} excluded by allow/deny` : "")
    );
    console.log(`     webhook URL: ${url}`);
    if (dryRun) console.log(`     mode: DRY-RUN (no API calls will be made)`);

    // A denied repo that still carries our hook predates the deny rule (or was
    // added by hand). The listener rejects its pushes with 403, but the stale
    // hook is worth removing — collect it for the summary.
    for (const full of denied) {
      const res = ghIgnoreStderr(
        `repos/${full}/hooks --jq '.[] | select(.config.url == "${url}") | .id'`
      );
      const ids = res.ok
        ? res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : [];
      if (ids.length > 0) staleDenied.push({ full, ids });
      skippedDenied++;
      console.log(
        `   – SKIP ${full}: excluded by allow/deny` +
          (ids.length ? ` — STALE HOOK id=${ids.join(",")}` : "")
      );
    }

    for (const full of kept) {
      // List existing matching hook IDs (filtered by url).
      const listRes = ghIgnoreStderr(
        `repos/${full}/hooks --jq '.[] | select(.config.url == "${url}") | .id'`
      );
      if (!listRes.ok) {
        console.log(
          `   ✗ ${full}: list hooks failed (${listRes.stderr.split("\n")[0]})`
        );
        failed++;
        continue;
      }
      const existingIds = listRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (existingIds.length === 0) {
        // Create
        if (dryRun) {
          console.log(`   • would CREATE ${full}`);
          wouldRegister++;
          continue;
        }
        try {
          ghJson("POST", `repos/${full}/hooks`, {
            name: "web",
            active: true,
            events: ["push"],
            config: { url, secret, content_type: "json", insecure_ssl: "0" },
          });
          console.log(`   ✓ CREATED ${full}`);
          registered++;
        } catch (e) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          console.log(`   ✗ CREATE ${full} failed: ${msg}`);
          failed++;
        }
        continue;
      }

      if (!update) {
        console.log(
          `   = ${full}: webhook already present (id=${existingIds[0]})`
        );
        alreadyPresent++;
        continue;
      }

      // --update path: PATCH each matching hook with current secret.
      if (dryRun) {
        console.log(`   • would UPDATE ${full} (id=${existingIds.join(",")})`);
        wouldUpdate++;
        continue;
      }
      let allOk = true;
      for (const id of existingIds) {
        try {
          ghJson("PATCH", `repos/${full}/hooks/${id}`, {
            config: { url, secret, content_type: "json", insecure_ssl: "0" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          console.log(`   ✗ UPDATE ${full} (id=${id}) failed: ${msg}`);
          allOk = false;
        }
      }
      if (allOk) {
        console.log(`   ✓ UPDATED ${full}`);
        updated++;
      } else {
        failed++;
      }
    }
  }

  console.log(`\n📊  Summary:`);
  if (dryRun) {
    console.log(
      `     dry-run: ${wouldRegister} would register, ${wouldUpdate} would update, ${failed} failed`
    );
  } else {
    console.log(
      `     ${registered} registered, ${alreadyPresent} already present, ${updated} updated, ${failed} failed`
    );
  }
  console.log(`     ${skippedDenied} skipped by allow/deny (REPOS-01)`);
  if (staleDenied.length > 0) {
    console.log(
      `\n⚠️   ${staleDenied.length} excluded repo(s) still carry this webhook. The listener\n` +
        `     rejects their pushes with 403, but remove the hooks to close the gap:`
    );
    for (const { full, ids } of staleDenied) {
      for (const id of ids) {
        console.log(`       gh api -X DELETE repos/${full}/hooks/${id}`);
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
