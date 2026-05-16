---
phase: 01-verify-pipeline
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - scripts/destroy-droplet.ts
  - scripts/lib/ssh.ts
  - scripts/lib/doctl.ts
  - scripts/lib/config.ts
  - scripts/create-droplet.ts
  - scripts/bootstrap-droplet.ts
autonomous: true
requirements:
  - TEST-01
  - TEST-02
  - BACKUP-03

must_haves:
  truths:
    - "Operator can run npm run destroy-droplet to remove droplet + firewall + .droplet.json"
    - "package.json exposes smoke-test, verify:phase-1, destroy-droplet scripts via tsx"
    - "Shared SSH/doctl/config helpers exist in scripts/lib so smoke + verify reuse them"
  artifacts:
    - path: "scripts/destroy-droplet.ts"
      provides: "Idempotent droplet + firewall teardown reading .droplet.json (D-09)"
      min_lines: 60
    - path: "scripts/lib/ssh.ts"
      provides: "sshFlags, sshRun, scpFile, waitForSsh, runVisible, runCapture"
      exports: ["sshFlags", "sshRun", "scpFile", "waitForSsh", "runVisible", "runCapture"]
    - path: "scripts/lib/doctl.ts"
      provides: "doctlJson, first, publicIp helpers"
      exports: ["doctlJson", "first", "publicIp"]
    - path: "scripts/lib/config.ts"
      provides: "loadConfig + loadDropletInfo with shared types"
      exports: ["loadConfig", "loadDropletInfo", "Config", "DropletInfo"]
    - path: "package.json"
      provides: "npm scripts for smoke-test, verify:phase-1, destroy-droplet"
      contains: "smoke-test"
  key_links:
    - from: "scripts/destroy-droplet.ts"
      to: ".droplet.json"
      via: "fs.readFileSync + fs.unlinkSync"
      pattern: "\\.droplet\\.json"
    - from: "scripts/destroy-droplet.ts"
      to: "doctl"
      via: "execSync child process"
      pattern: "doctl compute (firewall|droplet) delete"
---

<objective>
Build the foundation that smoke-test and verify:phase-1 stand on: (1) a destroy-droplet script that backs the smoke runner's `--fresh` flag (D-09), (2) shared SSH/doctl/config helpers extracted from the existing two TS scripts so the new code does not duplicate `runVisible`/`sshFlags`/`doctlJson`, and (3) all three new npm scripts wired in package.json so plans 02 and 03 do not need to touch package.json (avoids file conflicts).

Purpose: lock the npm script surface and shared library before any new entrypoint is written, so plans 02 and 03 are pure additions in non-overlapping files.
Output: scripts/destroy-droplet.ts, scripts/lib/{ssh,doctl,config}.ts, updated package.json.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/01-verify-pipeline/01-CONTEXT.md
@scripts/create-droplet.ts
@scripts/bootstrap-droplet.ts
@package.json

<interfaces>
<!-- Existing helpers to extract verbatim. Do not redesign signatures.
     Move existing implementations from scripts/{create,bootstrap}-droplet.ts
     into scripts/lib/, then re-import them from the original files. -->

From scripts/bootstrap-droplet.ts (extract to scripts/lib/ssh.ts):
```typescript
export function sshFlags(keyPath: string): string;
export function runVisible(cmd: string): void;
export function runCapture(cmd: string): string;
export function sshRun(ip: string, user: string, keyPath: string, remoteCmd: string): void;
export function scpFile(localFile: string, ip: string, user: string, keyPath: string, remotePath: string): void;
export function waitForSsh(ip: string, user: string, keyPath: string, timeoutMs?: number): Promise<void>;
export function expandHome(p: string): string;
export function sleep(ms: number): Promise<void>;
```

From scripts/create-droplet.ts (extract to scripts/lib/doctl.ts):
```typescript
export function doctlJson<T>(cmd: string): T;
export function first<T>(cmd: string): T;
export function publicIp(d: { networks: { v4: { ip_address: string; type: string }[] } }): string | undefined;
```

New shared types (scripts/lib/config.ts) — superset of the two divergent local Configs:
```typescript
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
export interface DropletInfo { id: number; ip: string; name: string; region: string; }
export function loadConfig(): Config;        // reads ./config.json, bails if missing
export function loadDropletInfo(): DropletInfo; // reads ./.droplet.json, bails if missing
export function bail(msg: string): never;
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extract shared lib (ssh.ts, doctl.ts, config.ts)</name>
  <files>scripts/lib/ssh.ts, scripts/lib/doctl.ts, scripts/lib/config.ts, scripts/create-droplet.ts, scripts/bootstrap-droplet.ts</files>
  <action>
Create `scripts/lib/` directory. Move the helpers listed in `<interfaces>` above out of the two existing TS scripts and re-export them from `scripts/lib/{ssh,doctl,config}.ts`. Use the EXACT current implementations — do not redesign. The `Config` interface in `scripts/lib/config.ts` is the union of both current local Configs (use the superset from `create-droplet.ts`); `bootstrap-droplet.ts` was already reading the same `config.json` so the field superset is safe. Update both existing scripts to import from `./lib/{ssh,doctl,config}` instead of defining the helpers locally. Keep `main()` in each entry script unchanged. Decision D-09 + Claude's Discretion (extract shared lib) drives this.
  </action>
  <verify>
    <automated>npx tsc --noEmit -p tsconfig.json</automated>
  </verify>
  <done>
- scripts/lib/{ssh,doctl,config}.ts exist with the listed exports
- scripts/create-droplet.ts and scripts/bootstrap-droplet.ts import from ./lib/* (grep confirms)
- `npx tsc --noEmit` exits 0 (no type regressions)
- `npm run create-droplet -- --help` (or invocation that exits before doctl) does not throw module-not-found
  </done>
</task>

<task type="auto">
  <name>Task 2: Implement scripts/destroy-droplet.ts</name>
  <files>scripts/destroy-droplet.ts</files>
  <action>
Create `scripts/destroy-droplet.ts` that implements D-09 scope guardrail (droplet + firewall + .droplet.json only — NOT TEARDOWN-01 idempotent re-bootstrap). Behavior:

1. Import `loadDropletInfo`, `loadConfig`, `bail` from `./lib/config` and `runVisible`, `runCapture` from `./lib/ssh`, and `doctlJson` from `./lib/doctl`.
2. Read `.droplet.json`. If missing, bail with non-zero exit and message "Refusing to destroy: .droplet.json not found." (TEARDOWN-02 partial — refuse if missing).
3. Read `config.json` to get `firewallName`.
4. Look up firewall by name via `doctl compute firewall list -o json`. If found, run `doctl compute firewall delete <id> --force`. If not found, log "firewall already absent" and continue (idempotent).
5. Look up droplet by id (from .droplet.json). If found, run `doctl compute droplet delete <id> --force`. If not found, log "droplet already absent" and continue.
6. Delete `.droplet.json` (use `fs.unlinkSync`, swallow ENOENT).
7. Support optional `--yes` flag to skip the confirmation prompt; without it, prompt "Destroy droplet <name> (id <id>) and firewall <name>? [y/N]: " on stdin and abort on anything other than `y`/`Y`.
8. Wire `main()` with top-level `.catch` that prints error + `process.exit(1)`.

Per D-09: scope is droplet + firewall + .droplet.json only. Do NOT attempt to remove DNS, SSH known_hosts entries, or anything else — those are out of Phase 1.

Per Claude's Discretion (auto-mode): include `--yes` flag because the smoke runner's `--fresh` path needs non-interactive destroy.
  </action>
  <verify>
    <automated>npx tsc --noEmit -p tsconfig.json && bash -c 'set -o pipefail; out=$(npx tsx scripts/destroy-droplet.ts 2>&1); rc=$?; [ $rc -ne 0 ] || { echo "expected non-zero exit, got 0"; exit 1; }; echo "$out" | grep -q "\.droplet\.json not found" || { echo "expected refusal message missing; full output: $out"; exit 1; }'</automated>
  </verify>
  <done>
- scripts/destroy-droplet.ts exists and type-checks
- Running it without `.droplet.json` exits non-zero with "Refusing to destroy: .droplet.json not found."
- `--yes` flag short-circuits the prompt (grep confirms `--yes` handling exists)
- Imports come from ./lib/* (no duplicated helper bodies)
  </done>
</task>

<task type="auto">
  <name>Task 3: Wire all three npm scripts in package.json</name>
  <files>package.json</files>
  <action>
Add three scripts to `package.json` under the existing `scripts` block, alongside `create-droplet` and `bootstrap-droplet`:

```json
"smoke-test": "tsx scripts/smoke-test.ts",
"verify:phase-1": "tsx scripts/verify/phase-1.ts",
"destroy-droplet": "tsx scripts/destroy-droplet.ts"
```

Also add a `tsconfig.json` if absent (project root has none — verify with `ls`); if absent, create a minimal one:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["scripts/**/*.ts"]
}
```

(Use `Read` to check the existing tsconfig.json first; the user's git status shows a tsconfig.json in untracked files, so confirm before creating.)

Wiring all three scripts up front means plans 02 and 03 do not have to touch package.json — eliminates file conflicts and lets them run in later waves cleanly. The npm scripts will fail until plans 02 and 03 land their files; that is expected.
  </action>
  <verify>
    <automated>node -e "const s=require('./package.json').scripts; if(!s['smoke-test']||!s['verify:phase-1']||!s['destroy-droplet'])process.exit(1)"</automated>
  </verify>
  <done>
- `npm run smoke-test`, `npm run verify:phase-1`, `npm run destroy-droplet` are all listed in `package.json`
- `npm run destroy-droplet` (without .droplet.json) exits non-zero with the expected refusal message
- tsconfig.json exists and `npx tsc --noEmit` succeeds across the whole `scripts/` tree
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| destroy-droplet → DO API | Calls `doctl compute {firewall,droplet} delete` with `--force`; destroys real billable infrastructure |
| destroy-droplet → local filesystem | Reads + unlinks `.droplet.json` |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-01-01 | Tampering | Wrong droplet destroyed (id mismatch) | mitigate | destroy-droplet reads droplet id from `.droplet.json` only; refuses if missing. No id-by-name fallback that could match a stranger's resource. |
| T-01-01-02 | Denial of service | Accidental destroy by re-run | mitigate | Default mode prompts `y/N` on stdin; only `--yes` skips it (and only the smoke runner's --fresh path passes --yes). |
| T-01-01-03 | Information disclosure | Helpers logging secrets | mitigate | runVisible/runCapture inherit existing behavior — they spawn child processes and never interpolate env vars into log lines. Lib extraction preserves the existing safe pattern verbatim. |
| T-01-01-04 | Repudiation | Destroy with no audit | accept | doctl emits its own confirmation log; .droplet.json removal is logged to stdout. Single-operator scope (PROJECT.md) — no audit-trail requirement. |
</threat_model>

<verification>
- `npx tsc --noEmit` passes (Task 1, 2)
- `node -e "require('./package.json').scripts['destroy-droplet']"` resolves (Task 3)
- `npx tsx scripts/destroy-droplet.ts` (with no .droplet.json) refuses and exits non-zero
- `grep -r "from \"./lib/" scripts/` shows create/bootstrap/destroy all importing from lib (no duplicated helpers)
</verification>

<success_criteria>
- All three npm scripts wired in package.json
- scripts/destroy-droplet.ts implements D-09 scope and refuses without .droplet.json
- scripts/lib/{ssh,doctl,config}.ts expose helpers reused by all four entrypoints (create, bootstrap, destroy, and the upcoming smoke + verify)
- Type check is clean across the entire scripts/ tree
- No file overlap with plan 02 or plan 03
</success_criteria>

<output>
After completion, create `.planning/phases/01-verify-pipeline/01-01-SUMMARY.md` describing what was extracted, what was added, and any divergence from the planned interfaces.
</output>
