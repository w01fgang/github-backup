/**
 * scripts/lib/filter-repos.ts
 *
 * Canonical TS entrypoint for the droplet's allow/deny repo filtering.
 * Every caller that needs REPOS-01 semantics — register-webhooks, phase
 * verifiers, anything else — goes through here so there is exactly one
 * place that implements or invokes the glob contract in TypeScript.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { bail } from "./config";

const FILTER_LIB = path.resolve(
  __dirname,
  "..",
  "..",
  "droplet",
  "lib",
  "filter-repos.sh"
);

/**
 * REPOS-01: keep only the repos a source's allow/deny globs admit.
 *
 * Delegates to the canonical `filter_repos` rather than reimplementing bash
 * `case` glob semantics in TS, so callers cannot drift from the cron path
 * or the droplet listener. Empty allow AND empty deny is pass-through
 * (ROADMAP SC#5) and skips the subprocess.
 */
export function filterRepos(
  owner: string,
  fullNames: string[],
  allow: string[],
  deny: string[]
): string[] {
  const allowStr = allow.join(" ").trim();
  const denyStr = deny.join(" ").trim();
  if (!allowStr && !denyStr) return fullNames;
  if (!fs.existsSync(FILTER_LIB)) {
    bail(`REPOS-01 filter helper missing: ${FILTER_LIB}. Refusing to filter repos unfiltered.`);
  }
  const r = spawnSync(
    "bash",
    ["-c", 'source "$0"; filter_repos "$1" "$2" "$3"', FILTER_LIB, owner, allowStr, denyStr],
    { input: fullNames.join("\n") + "\n", encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    bail(
      `REPOS-01 filter failed for source "${owner}": ` +
        `${r.error ? r.error.message : `exit ${r.status}`}. Refusing to filter repos unfiltered.`
    );
  }
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
