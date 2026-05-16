---
phase: 06-multi-source
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/lib/config.ts
  - scripts/bootstrap-droplet.ts
  - package.json
autonomous: true
requirements:
  - MULTI-01
  - REPOS-01
  - BACKUP-03

must_haves:
  truths:
    - "loadConfig() returns cfg.sources: NormalizedSource[] with each entry {name, allow, deny}; back-compat with legacy githubUserOrOrg preserved (D-01..D-04)"
    - "loadConfig() bails loudly on duplicate source names, empty source array, source name violating SHELL_SAFE_RE, or non-string glob patterns"
    - "githubSources accepts BOTH shapes per entry: string (= name only, no filtering) and object {name, repos?: {allow?: string[], deny?: string[]}} (REPOS-01)"
    - "bootstrap-droplet.ts writes GITHUB_SOURCES=\"src1 src2 ...\" plus per-source GITHUB_SOURCE_ALLOW_<UPPER>/GITHUB_SOURCE_DENY_<UPPER> lines into backup.env (D-04 + REPOS-01)"
    - "backup.env still carries legacy GITHUB_USER_OR_ORG=<sources[0].name> line so a pre-Phase-6 droplet script keeps working against source #1"
    - "package.json has migrate-mirrors and verify:phase-6 npm script entries (used by plan 03)"
    - "Existing single-source configs (githubUserOrOrg only) load unchanged — promoted to cfg.sources=[{name, allow:[], deny:[]}]"
  artifacts:
    - path: "scripts/lib/config.ts"
      provides: "Extended Config interface, NormalizedSource type export, loadConfig multi-source + allow/deny validation"
      exports: ["loadConfig", "loadDropletInfo", "bail", "Config", "DropletInfo", "NormalizedSource", "SourceFilter"]
    - path: "scripts/bootstrap-droplet.ts"
      provides: "Multi-source backup.env writer emitting GITHUB_SOURCES + per-source allow/deny + legacy single-source compat"
    - path: "package.json"
      provides: "npm scripts migrate-mirrors and verify:phase-6 wired (tsx)"
      contains: "verify:phase-6"
  key_links:
    - from: "scripts/lib/config.ts"
      to: "scripts/bootstrap-droplet.ts"
      via: "import { loadConfig, NormalizedSource }"
      pattern: "loadConfig\\(\\)"
    - from: "scripts/bootstrap-droplet.ts"
      to: "backup.env"
      via: "writeBackupEnv emits GITHUB_SOURCES + GITHUB_SOURCE_ALLOW_/DENY_ lines"
      pattern: "GITHUB_SOURCES="
---

<objective>
Land the TypeScript foundation that every other Phase 6 plan stands on:
1. Extend the `Config` shape and `loadConfig` validator to accept multi-source with optional per-repo allow/deny globs (REPOS-01) while preserving Phase 1 back-compat (single `githubUserOrOrg` keeps working).
2. Update `bootstrap-droplet.ts` so `backup.env` carries `GITHUB_SOURCES` (space-separated source names), per-source `GITHUB_SOURCE_ALLOW_<UPPER>` / `GITHUB_SOURCE_DENY_<UPPER>` lines, and a legacy `GITHUB_USER_OR_ORG=<sources[0].name>` line for back-compat with a not-yet-upgraded droplet script.
3. Wire `migrate-mirrors` and `verify:phase-6` npm scripts now (plans 02 + 03 create the underlying TS).

After this plan ships, the local TS surface is multi-source aware. Plans 02 (bash) and 03 (helpers + verify) can land in parallel waves without TS contract churn.

Output: extended `scripts/lib/config.ts`, multi-source-aware `scripts/bootstrap-droplet.ts`, updated `package.json`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/phases/06-multi-source/06-CONTEXT.md
@scripts/lib/config.ts
@scripts/bootstrap-droplet.ts
@package.json
@config.example.json

<interfaces>
Extended Config + new NormalizedSource type (scripts/lib/config.ts):

```typescript
/**
 * A source entry in config.json may be either a bare string (name only,
 * no allow/deny filtering) OR an object with optional per-repo filtering.
 * loadConfig() normalises both shapes to NormalizedSource[].
 */
export interface SourceFilter {
  allow?: string[]; // glob patterns; empty / missing = all repos of source
  deny?: string[];  // glob patterns; deny wins on conflict (ROADMAP SC#4)
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
  // Legacy single-source (still accepted; promoted to githubSources[0] when present)
  githubUserOrOrg?: string;
  // New multi-source field
  githubSources?: SourceEntry[];
  // Normalized field (NOT in config.json — set by loadConfig)
  sources: NormalizedSource[];
  backupDir: string;
  cronSchedule: string;
  allowedSSHCidr: string;
  tags?: string[];
}
```

bootstrap-droplet writeBackupEnv signature stays the same — only the body changes.
</interfaces>

</context>

<tasks>

<task type="auto">
  <name>Task 1: Extend scripts/lib/config.ts with multi-source + allow/deny normalisation</name>
  <files>scripts/lib/config.ts</files>
  <action>
**Schema changes:**

1. Add `SourceFilter`, `SourceEntry`, `NormalizedSource` types (signatures above). Export all three.
2. Add `githubUserOrOrg?: string` (already present — make it optional now), `githubSources?: SourceEntry[]`, and `sources: NormalizedSource[]` to the `Config` interface.
3. Remove `githubUserOrOrg` from the `REQUIRED_FIELDS` array (it's now optional — exactly one of `githubUserOrOrg` / `githubSources` must resolve to a non-empty list).
4. Keep `githubUserOrOrg` in `SHELL_SAFE_FIELDS` (validated only if present).

**Normalisation logic in `loadConfig` (after the existing field/safe checks, before the cron check):**

```typescript
// Phase 6 D-01..D-03 — normalise to cfg.sources: NormalizedSource[]
const rawSources: SourceEntry[] | undefined = cfg.githubSources;
const legacy: string | undefined = cfg.githubUserOrOrg;

let entries: SourceEntry[];
if (Array.isArray(rawSources) && rawSources.length > 0) {
  if (legacy) {
    console.warn(
      `⚠️  config.json: both "githubUserOrOrg" and "githubSources" set. ` +
      `"githubSources" wins; "githubUserOrOrg" ignored (deprecated).`
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
  } else if (e && typeof e === "object" && typeof e.name === "string") {
    name = e.name;
    const f = e.repos;
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

  // Validate glob patterns are non-empty strings — keep it light; real
  // glob syntax is bash-side (filter-repos.sh in plan 02). We block only
  // shell-metacharacter injection here because the lists end up inside
  // double-quoted env var values in backup.env.
  for (const list of [allow, deny]) {
    for (const g of list) {
      if (g.length === 0) {
        bail(
          `config.json: source "${name}" has empty glob in allow/deny list`
        );
      }
      // Allow glob metachars: * ? [ ] - but block quotes, $, backtick, etc.
      // which would corrupt the GITHUB_SOURCE_ALLOW_<S>="..." env line.
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
```

**Notes for the executor:**
- Do NOT mutate `cfg.githubUserOrOrg` on disk. Read-only.
- Do NOT rewrite `config.json`. Normalisation is in-memory only (D-02).
- Preserve the existing cron + shell-safe validation order; insert the multi-source block just BEFORE the cron check so a bad cron line still fails loud.
- Keep the existing single-field `if (typeof v === "string" && !SHELL_SAFE_RE.test(v))` block for `SHELL_SAFE_FIELDS` — it still validates `githubUserOrOrg` when present.

**Acceptance:**
- `tsc --noEmit` (or `tsx --check` equivalent if used) passes.
- A config with only `githubUserOrOrg: "sumin"` loads, and `cfg.sources` is `[{name:"sumin",allow:[],deny:[]}]`.
- A config with `githubSources: ["sumin","acme"]` loads, both entries normalised.
- A config with `githubSources: [{name:"acme",repos:{allow:["acme/foo-*"],deny:["*-archive"]}}]` loads, with allow/deny populated.
- Bad shapes (duplicates, empty glob, name with `;`, `repos.allow` containing a number) all `bail()` with messages naming the offender.
  </action>
  <verify>
After implementing, write a one-shot smoke check via `tsx -e` (no test framework — Phase 1 doesn't have one) that:
1. Loads `config.example.json` (existing single-source) — assert `cfg.sources.length === 1`.
2. Creates a temp dir with a fake `config.json` containing a 2-source array with one `{name,repos:{deny:["foo*"]}}` entry, `process.chdir`s, runs `loadConfig`, asserts `cfg.sources.length === 2` and the second source has `deny: ["foo*"]`.
3. Creates a temp config with `githubSources: [{name:"a"},{name:"a"}]` — assert `loadConfig` throws (catch + assert error message contains "duplicate").

Smoke check is throwaway — keep it in a `# smoke check` heredoc in the SUMMARY for traceability, do not commit.
  </verify>
</task>

<task type="auto">
  <name>Task 2: Multi-source backup.env writer + droplet/lib/ upload in scripts/bootstrap-droplet.ts</name>
  <files>scripts/bootstrap-droplet.ts</files>
  <action>
Rewrite `writeBackupEnv` to emit the new multi-source env. Keep the function signature (`writeBackupEnv(cfg: Config, githubToken: string): string`) — caller is unchanged.

**New env file body (replaces the existing `lines` array):**

```typescript
function writeBackupEnv(cfg: Config, githubToken: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(githubToken)) {
    bail(
      "GITHUB_TOKEN contains characters outside [A-Za-z0-9_] after trim.\n" +
        `    Length=${githubToken.length}. Refusing to write it to backup.env\n` +
        "    unquoted (would corrupt the env file or inject shell on the\n" +
        "    droplet). Confirm the token shape, then re-run."
    );
  }

  // D-04: GITHUB_SOURCES is space-separated names. Names are SHELL_SAFE per D-03,
  // so no quoting/escaping needed inside double quotes.
  const sourceNames = cfg.sources.map((s) => s.name);
  const legacyFirst = sourceNames[0]; // back-compat for not-yet-upgraded droplet

  // Per-source allow/deny env var names: GITHUB_SOURCE_ALLOW_<UPPER>=" g1 g2 g3"
  // where <UPPER> is the source name uppercased and every non-alnum char
  // replaced by `_`. Plan 02's bash `slot()` function MUST produce the
  // identical string for the same input. The algorithm is deliberately
  // simple (no trailing-underscore strip) so both sides match without
  // edge cases. Globs are checked SHELL_SAFE in loadConfig, so they
  // interpolate cleanly inside double-quoted env values.
  function envSlot(name: string): string {
    return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  }

  const filterLines: string[] = [];
  for (const s of cfg.sources) {
    const slot = envSlot(s.name);
    filterLines.push(`GITHUB_SOURCE_ALLOW_${slot}="${s.allow.join(" ")}"`);
    filterLines.push(`GITHUB_SOURCE_DENY_${slot}="${s.deny.join(" ")}"`);
  }

  const lines = [
    `# Generated by bootstrap-droplet.ts — do not edit manually`,
    `# Stored at ${cfg.backupDir}/backup.env on the droplet (mode 600)`,
    `GITHUB_TOKEN=${githubToken}`,
    // Legacy single-source line — first source only. github-backup.sh falls
    // back to this if GITHUB_SOURCES is unset (covers the upgrade window
    // where local TS is multi-source but the droplet still has the old
    // single-source github-backup.sh). D-04.
    `GITHUB_USER_OR_ORG=${legacyFirst}`,
    `GITHUB_SOURCES="${sourceNames.join(" ")}"`,
    ...filterLines,
    `BACKUP_DIR=${cfg.backupDir}`,
    `CRON_SCHEDULE="${cfg.cronSchedule}"`,
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-backup-"));
  const envPath = path.join(tmpDir, "backup.env");
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  return envPath;
}
```

**Notes for the executor (env writer):**
- The env-var name slot algorithm (`toUpperCase + replace non-alnum with _`) must match the bash side in plan 02 EXACTLY. Plan 02's `slot()` is `tr '[:lower:]' '[:upper:]' <<< "$1" | tr -c 'A-Z0-9' '_'` (NO trailing-underscore strip — see plan 02 task 1 update). Document the contract in a comment.
- The legacy `GITHUB_USER_OR_ORG` line is intentionally always written (even in the multi-source case) so an unrelated droplet roll-back works.
- Do NOT shell-quote glob characters (`*`, `?`, `[`, `]`) — they're literal inside double quotes.
- Existing log lines / `main()` flow — unchanged.

**Additional change — upload droplet/lib/ helpers:**

The current `main()` enumerates top-level `*.sh` files in `dropletDir` and scp's each. Plan 02 introduces `droplet/lib/detect-account-type.sh` and `droplet/lib/filter-repos.sh`, which `github-backup.sh` will `source` from `${BACKUP_DIR}/lib/`. Add an additional upload step right after the existing top-level `.sh` upload loop:

```typescript
// Phase 6: upload droplet/lib/*.sh helpers (plan 02). github-backup.sh
// sources these from ${backupDir}/lib/, so the dir must exist before
// bootstrap.sh runs (bootstrap.sh chmod+x's them).
const libDir = path.join(dropletDir, "lib");
if (fs.existsSync(libDir) && fs.statSync(libDir).isDirectory()) {
  const libFiles = fs
    .readdirSync(libDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".sh"))
    .map((d) => path.join(libDir, d.name));

  if (libFiles.length > 0) {
    console.log(`\n📤  Uploading droplet/lib/ helpers…`);
    sshRun(ip, user, keyPath, `mkdir -p "${backupDir}/lib"`);
    for (const file of libFiles) {
      const basename = path.basename(file);
      console.log(`   → lib/${basename}`);
      scpFile(ip, user, keyPath, file, `${backupDir}/lib/${basename}`);
    }
  }
}
```

Place this block AFTER the existing top-level `.sh` upload loop and BEFORE the `bootstrap.sh` invocation.

**Acceptance:**
- Running `npm run bootstrap-droplet` against a 2-source config writes a `backup.env` that contains:
  - `GITHUB_SOURCES="sumin acme"`
  - `GITHUB_SOURCE_ALLOW_SUMIN=""`
  - `GITHUB_SOURCE_DENY_SUMIN=""`
  - `GITHUB_SOURCE_ALLOW_ACME="acme/foo-*"` (if config has it)
  - `GITHUB_USER_OR_ORG=sumin`
- Mode 600 preserved.
- After bootstrap, `ssh root@<droplet> ls ${BACKUP_DIR}/lib/` lists `detect-account-type.sh` and `filter-repos.sh`.
- Re-running bootstrap is idempotent (same files overwritten with same content; `mkdir -p` no-ops).
  </action>
</task>

<task type="auto">
  <name>Task 3: Wire migrate-mirrors and verify:phase-6 npm scripts</name>
  <files>package.json</files>
  <action>
Append two entries to `package.json` `scripts` block (plans 02 + 03 create the underlying TS files; wiring now avoids a package.json edit in plan 03, which keeps plan 03 file-disjoint from plan 01):

```json
"migrate-mirrors": "tsx scripts/migrate-mirrors.ts",
"verify:phase-6": "tsx scripts/verify/phase-6.ts"
```

Keep existing script entries in their current order. No other changes.

**Acceptance:**
- `npm run migrate-mirrors` prints a `Cannot find module 'scripts/migrate-mirrors.ts'` (or equivalent tsx error) — this is expected; plan 03 creates the file.
- `npm run verify:phase-6` likewise errors with "file not found". OK.
- `npm run -ls` (or `npm run` with no args) lists both new entries.
  </action>
</task>

</tasks>

<verification>

Goal-backward verification (this plan only):

1. `tsc --noEmit` on `scripts/lib/config.ts` and `scripts/bootstrap-droplet.ts` passes (no new type errors).
2. Manual smoke (from the SUMMARY): `tsx -e "import('./scripts/lib/config').then(m => { process.chdir('/tmp/test'); console.log(m.loadConfig().sources); })"` against a hand-crafted multi-source config produces a `NormalizedSource[]` matching expected shape.
3. `npm run` lists `migrate-mirrors` and `verify:phase-6`.
4. `loadConfig` against the EXISTING `config.example.json` still loads (Phase 1 + 5 back-compat) — assert `cfg.sources.length === 1` after normalisation.

This plan's success criteria DO NOT yet include droplet behavior — that's plan 02. Plan 02 + 03 assert end-to-end against a real droplet.

</verification>