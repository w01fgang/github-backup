/**
 * scripts/lib/config.ts
 *
 * Shared config + droplet-info loaders. Reads ./config.json and ./.droplet.json
 * from the project root. Used by every entry script (create, bootstrap, destroy,
 * and the upcoming smoke + verify runners).
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Phase 6 multi-source: each entry in `githubSources` is either a bare string
 * (just the user/org slug, no per-repo filtering) or an object with optional
 * allow/deny glob lists. `loadConfig()` normalises both shapes into
 * `cfg.sources: NormalizedSource[]` so downstream code touches a single shape.
 */
export interface SourceFilter {
  allow?: string[]; // bash globs; empty / missing = all repos of the source
  deny?: string[];  // bash globs; deny wins on conflict (ROADMAP SC#4)
}

export type SourceEntry = string | { name: string; repos?: SourceFilter };

export interface NormalizedSource {
  name: string;
  allow: string[]; // always present, may be empty (= match all)
  deny: string[];  // always present, may be empty
}

export interface Config {
  region: string;
  size: string;
  image: string;
  dropletName: string;
  firewallName: string;
  sshKeyFingerprint: string;
  sshKeyPath: string;
  sshUser: string;
  /**
   * Phase 1 single-source field. Optional from Phase 6 onward — exactly one of
   * `githubUserOrOrg` or `githubSources` must resolve to a non-empty list.
   * Still written as the legacy `GITHUB_USER_OR_ORG=` line in backup.env so a
   * not-yet-upgraded droplet script keeps working against source #1.
   */
  githubUserOrOrg?: string;
  /**
   * Phase 6 multi-source declaration. Raw shape from disk; `loadConfig()`
   * normalises into `sources` (do not consume `githubSources` directly
   * downstream — use `cfg.sources`).
   */
  githubSources?: SourceEntry[];
  /**
   * Phase 6 normalised view. Always populated by `loadConfig()`. Empty array
   * is impossible — `loadConfig()` bails when both `githubUserOrOrg` and
   * `githubSources` are missing/empty.
   */
  sources: NormalizedSource[];
  backupDir: string;
  cronSchedule: string;
  allowedSSHCidr: string;
  tags?: string[];
  restoreTestRepo?: string;
  webhookHostname: string;      // FQDN that operator pointed at droplet IP (D-04)
  webhookTestRepo?: string;     // "owner/repo" — consumed only by verify:phase-3 (D-25)
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
  // githubUserOrOrg is no longer required since Phase 6 — exactly one of
  // githubUserOrOrg or githubSources must resolve to a non-empty list,
  // checked in the multi-source normalisation block below.
  "backupDir",
  "cronSchedule",
  "allowedSSHCidr",
  "webhookHostname",
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
  "webhookHostname",
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
 *
 * NR-07: extend the allow-list to cover valid cron grammar that earlier
 * iterations rejected — nicknames (@daily/@hourly/@reboot), named months
 * (JAN-DEC) and days (MON-SUN), last-day-of-month (L), nearest-weekday
 * (W), nth-weekday (#), and the no-specific-value extension (?). The
 * injection-relevant chars (`"`, `$`, `` ` ``, `\`, `;`, `&`, `|`, `<`,
 * `>`, `(`, `)`, `{`, `}`, newline) remain blocked.
 */
const CRON_SAFE_RE = /^[A-Za-z0-9@*,/#? \t-]+$/;

/**
 * Restore test repo slug shape: `<owner>/<repo>`. Optional field consumed by
 * scripts/verify/phase-4.ts and (indirectly, via slug validation) by
 * scripts/restore.ts. Value is interpolated into a shell-quoted `git clone`
 * argument inside restore.ts, so defend in depth here even though the helper
 * re-validates the slug shape on its own.
 */
const RESTORE_TEST_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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
  // ─── Phase 6 multi-source normalisation ───────────────────────────────
  // Collapse the two accepted shapes (legacy single-source `githubUserOrOrg`
  // and `githubSources` array of strings/objects) into `cfg.sources:
  // NormalizedSource[]`. Validates duplicate names, shell-unsafe names,
  // and malformed allow/deny globs (REPOS-01). Inserted BEFORE the cron
  // check so a bad cron still fails loud below.
  const rawSources: SourceEntry[] | undefined = cfg.githubSources;
  const legacy: string | undefined = cfg.githubUserOrOrg;

  let entries: SourceEntry[];
  if (Array.isArray(rawSources) && rawSources.length > 0) {
    if (legacy) {
      console.warn(
        `⚠️  config.json: both "githubUserOrOrg" and "githubSources" set. ` +
          `"githubSources" wins; "githubUserOrOrg" ignored (deprecated, ` +
          `kept only for the legacy backup.env line so a roll-back works).`
      );
    }
    entries = rawSources;
  } else if (legacy) {
    entries = [legacy]; // single-source back-compat (D-02)
  } else {
    bail(
      `config.json must set either "githubSources" (array) or ` +
        `"githubUserOrOrg" (legacy single-source string). Both are empty.`
    );
  }

  const normalised: NormalizedSource[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    let name: string;
    let allow: string[] = [];
    let deny: string[] = [];

    if (typeof e === "string") {
      name = e;
    } else if (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string") {
      name = (e as { name: string }).name;
      const f = (e as { repos?: SourceFilter }).repos;
      if (f) {
        if (f.allow !== undefined) {
          if (!Array.isArray(f.allow) || f.allow.some((g) => typeof g !== "string")) {
            bail(
              `config.json: source "${name}" has invalid repos.allow ` +
                `(must be string[]). Got: ${JSON.stringify(f.allow)}`
            );
          }
          allow = f.allow;
        }
        if (f.deny !== undefined) {
          if (!Array.isArray(f.deny) || f.deny.some((g) => typeof g !== "string")) {
            bail(
              `config.json: source "${name}" has invalid repos.deny ` +
                `(must be string[]). Got: ${JSON.stringify(f.deny)}`
            );
          }
          deny = f.deny;
        }
      }
    } else {
      bail(
        `config.json: githubSources entry must be string or {name,repos?}. ` +
          `Got: ${JSON.stringify(e)}`
      );
    }

    if (!name) bail(`config.json: githubSources entry has empty name`);
    if (!SHELL_SAFE_RE.test(name)) {
      bail(
        `config.json: source name "${name}" contains characters outside ` +
          `[A-Za-z0-9._/~@:-]; refusing (would be interpolated into shell + env-var names). ` +
          `See D-03/D-08.`
      );
    }
    if (seen.has(name)) {
      bail(`config.json: duplicate source name "${name}" in githubSources (D-03)`);
    }
    seen.add(name);

    // Glob shape guard: empty + injection-relevant chars rejected. Bash
    // glob meta (* ? [..]) stays allowed — they're literal inside the
    // double-quoted env line on the droplet side.
    for (const list of [allow, deny]) {
      for (const g of list) {
        if (g.length === 0) {
          bail(
            `config.json: source "${name}" has empty glob in allow/deny list`
          );
        }
        if (/["`$\\\n\r]/.test(g)) {
          bail(
            `config.json: source "${name}" glob "${g}" contains forbidden ` +
              `characters (quote/backtick/dollar/backslash/newline); refusing.`
          );
        }
      }
    }

    normalised.push({ name, allow, deny });
  }

  cfg.sources = normalised;
  // ──────────────────────────────────────────────────────────────────────
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
  // restoreTestRepo is optional, consumed by scripts/verify/phase-4.ts and
  // (via slug validation) by scripts/restore.ts. Defence in depth: even though
  // the helper re-validates the slug, a malformed value here would otherwise
  // pass straight through to a shell-interpolated `git clone` argument.
  if (cfg.restoreTestRepo !== undefined) {
    if (
      typeof cfg.restoreTestRepo !== "string" ||
      !RESTORE_TEST_REPO_RE.test(cfg.restoreTestRepo)
    ) {
      bail(
        `config.json field "restoreTestRepo" must be "<owner>/<repo>" ` +
          `using [A-Za-z0-9._-]; refusing to interpolate into git clone. ` +
          `Got: ${JSON.stringify(cfg.restoreTestRepo)}`
      );
    }
  }
  // D-04: webhookHostname is required and must be a lowercase FQDN. Caddy
  // configures HTTPS for this name via Let's Encrypt; a malformed value would
  // either bail at Caddy startup (operator-hostile) or silently issue against
  // the wrong name. Trailing dots, underscores, IP addresses, and uppercase are
  // all rejected here so the failure is local + actionable.
  const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  if (!FQDN_RE.test(cfg.webhookHostname)) {
    bail(
      `config.json field "webhookHostname" is not a valid FQDN ` +
        `(lowercase letters, digits, dashes; at least one dot; no trailing dot). ` +
        `Got: ${JSON.stringify(cfg.webhookHostname)}`
    );
  }
  // D-25 group 4: webhookTestRepo is optional, consumed by verify:phase-3.
  // Same shape constraint as restoreTestRepo so a malformed value can't reach
  // a shell-interpolated `gh api` call inside the verify runner.
  if (cfg.webhookTestRepo !== undefined) {
    if (
      typeof cfg.webhookTestRepo !== "string" ||
      !RESTORE_TEST_REPO_RE.test(cfg.webhookTestRepo)
    ) {
      bail(
        `config.json field "webhookTestRepo" must be "<owner>/<repo>" ` +
          `using [A-Za-z0-9._-]. ` +
          `Got: ${JSON.stringify(cfg.webhookTestRepo)}`
      );
    }
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
