/**
 * scripts/lib/repo-endpoint.ts
 *
 * Canonical TS entrypoint for "which `gh api` path lists this source's
 * repos". Delegates to droplet/lib/resolve-repo-endpoint.sh — the helper the
 * cron path sources — so local tooling and the droplet never disagree about
 * the repo set, in particular about private repositories (see the helper's
 * header for why a user source cannot use `/users/<login>/repos`).
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { bail } from "./config";

const ENDPOINT_LIB = path.resolve(
  __dirname,
  "..",
  "..",
  "droplet",
  "lib",
  "resolve-repo-endpoint.sh"
);

/** Remote path of the same helper on a bootstrapped droplet. */
export const remoteEndpointLib = (backupDir: string): string =>
  `${backupDir}/lib/resolve-repo-endpoint.sh`;

/**
 * Resolve the repo-listing endpoint for a source.
 *
 * `accountType` comes from `detect_account_type` (or `gh api /users/<slug>`);
 * anything other than `"Organization"` is treated as a user account.
 */
export function resolveRepoEndpoint(owner: string, accountType: string): string {
  if (!fs.existsSync(ENDPOINT_LIB)) {
    bail(
      `repo-endpoint helper missing: ${ENDPOINT_LIB}. Refusing to guess an endpoint ` +
        `(a wrong guess silently drops private repos).`
    );
  }
  const r = spawnSync(
    "bash",
    ["-c", 'source "$0"; resolve_repo_endpoint "$1" "$2"', ENDPOINT_LIB, owner, accountType],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    bail(
      `repo-endpoint resolution failed for source "${owner}": ` +
        `${r.error ? r.error.message : `exit ${r.status}`}.`
    );
  }
  return r.stdout.trim();
}
