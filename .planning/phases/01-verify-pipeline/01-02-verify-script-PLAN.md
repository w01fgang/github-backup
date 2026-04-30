---
phase: 01-verify-pipeline
plan: 02
type: execute
wave: 2
depends_on: ["01-01"]
files_modified:
  - scripts/verify/phase-1.ts
autonomous: true
requirements:
  - PROV-01
  - PROV-02
  - BACKUP-01
  - BACKUP-02
  - BACKUP-03
  - ACCESS-01
  - TEST-02

must_haves:
  truths:
    - "Operator can run npm run verify:phase-1 and get exit 0 if and only if all four D-07 assertion groups pass"
    - "Verify script bails on first failed assertion with a clear message naming the failed assertion"
    - "Clone-probe runs on the local machine (not the droplet) and lands in a mkdtemp directory"
  artifacts:
    - path: "scripts/verify/phase-1.ts"
      provides: "Four D-07 assertion groups: provision, bootstrap-SSH, backup-ran, clone-probe"
      min_lines: 150
  key_links:
    - from: "scripts/verify/phase-1.ts"
      to: "scripts/lib/ssh.ts + scripts/lib/doctl.ts + scripts/lib/config.ts"
      via: "import statements"
      pattern: "from \"\\.\\./lib/(ssh|doctl|config)\""
    - from: "scripts/verify/phase-1.ts"
      to: "doctl + ssh + git CLIs"
      via: "execSync via runCapture/runVisible"
      pattern: "(doctl compute|ssh .*@|git clone)"
---

<objective>
Implement the per-phase executable verification (TEST-02, decisions D-06 and D-07): a TypeScript assertion script that fails fast on the first violated invariant and exits 0 only when all four assertion groups pass against a live droplet.

Purpose: gives every future phase a green-baseline lock — Phase 1 cannot be marked complete until `npm run verify:phase-1` exits 0.
Output: `scripts/verify/phase-1.ts` covering the full D-07 assertion matrix.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/01-verify-pipeline/01-CONTEXT.md
@.planning/phases/01-verify-pipeline/01-01-SUMMARY.md
@scripts/lib/ssh.ts
@scripts/lib/doctl.ts
@scripts/lib/config.ts
@droplet/install-cron.sh
@droplet/github-backup.sh

<interfaces>
<!-- Available from plan 01-01 -->
import { sshFlags, runVisible, runCapture, sshRun } from "../lib/ssh";
import { doctlJson, first, publicIp } from "../lib/doctl";
import { loadConfig, loadDropletInfo, bail, type Config, type DropletInfo } from "../lib/config";

<!-- Cron marker (droplet/install-cron.sh) -->
const CRON_MARKER = "# github-backup-managed";
const REMOTE_LOG = "/var/log/github-backup.log";
const REMOTE_DIR = "/opt/github-backups";
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement scripts/verify/phase-1.ts assertion harness</name>
  <files>scripts/verify/phase-1.ts</files>
  <action>
Create `scripts/verify/phase-1.ts`. Top-level flow:

1. Define a tiny assert helper local to the file: `function assert(cond: boolean, msg: string): void { if (!cond) { console.error("✗ " + msg); process.exit(1); } else { console.log("✓ " + msg); } }`. No external test framework — this is per CONTEXT.md "Deferred: per-phase verify framework / harness".
2. `loadConfig()` and `loadDropletInfo()` from `../lib/config`. Bail if either missing.

**Group 1 — Provision (D-07.1):**
- Assert `.droplet.json` exists locally (loadDropletInfo() already handles this).
- `doctl compute droplet get <id> -o json` → assert returned droplet `status === "active"`.
- `doctl compute firewall list -o json` → find by `cfg.firewallName` → assert `droplet_ids` includes `info.id`.

**Group 2 — Bootstrap over SSH (D-07.2):**
- `sshRun(ip, user, keyPath, "stat -c '%a %n' /opt/github-backups/backup.env")` — assert mode is exactly `600`. (Use `runCapture` instead of `sshRun` so you can read stdout; build the ssh command with `sshFlags`.)
- For each of `bootstrap.sh`, `install-cron.sh`, `github-backup.sh`: `ssh ... "test -x /opt/github-backups/<name>"` exits 0.
- `ssh ... "crontab -l"` → assert stdout contains the literal string `# github-backup-managed`.
- `ssh ... "gh auth status"` exits 0.

**Group 3 — Backup-ran (D-07.3):**
- Trigger: `ssh ... "/opt/github-backups/github-backup.sh"` (run synchronously; this can take minutes on a real account — acceptable for verify).
- Assert: `ssh ... "tail -n 200 /var/log/github-backup.log"` stdout contains at least one of the success markers used by `droplet/github-backup.sh` (grep `droplet/github-backup.sh` to find them — likely "MIRROR" / "UPDATE" / "OK" tokens; use whatever the script actually emits, no assumptions).
- Assert: `ssh ... "ls -1d /opt/github-backups/*.git 2>/dev/null | wc -l"` returns a number ≥ 1.

**Group 4 — Clone-probe (D-07.4, ACCESS-01):**
- Pick the first repo from `ssh ... "ls -1d /opt/github-backups/*.git | head -n1"` → strip path → use as `<owner>_<repo>.git`.
- `mkdtemp` a local directory.
- `git clone <user>@<ip>:/opt/github-backups/<repo>.git <tmpdir>/<repo>` — assert exit 0.
- `cd <tmpdir>/<repo> && git rev-parse HEAD` — assert exit 0 and output is a 40-char hex.
- `cd <tmpdir>/<repo> && git for-each-ref | wc -l` — assert > 0.
- Clean up the tmpdir on success (best-effort `fs.rmSync`); leave it on failure for inspection.

Per the "100% pass bar" decision (D-02): every assertion is hard. No skip flags, no soft-fail.

Per CONTEXT.md "code_context > Integration Points": clone-probe runs on the LOCAL machine (operator's box). Use the operator's local `git` and the configured `sshUser`/`sshKeyPath` from `config.json`.

Open `droplet/github-backup.sh` first to read the actual log-line markers it emits — do NOT guess. If the script does not emit a clear success marker, fall back to asserting "log file is non-empty AND ≥1 .git directory exists" (the .git-directory assertion is the load-bearing one).
  </action>
  <verify>
    <automated>npx tsc --noEmit -p tsconfig.json && grep -c "^[[:space:]]*assert(" scripts/verify/phase-1.ts | awk '{ if($1<8) exit 1 }'</automated>
  </verify>
  <done>
- scripts/verify/phase-1.ts type-checks
- Contains ≥ 8 `assert(...)` calls covering the four D-07 groups
- Imports come exclusively from `../lib/*` — no duplicated SSH/doctl helpers
- Running against an offline/missing droplet exits non-zero (manual sanity check; not part of automated verify)
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| verify-phase-1 → droplet (SSH) | Read-only probes over SSH (stat, ls, crontab -l, gh auth status, git clone) |
| verify-phase-1 → DO API | Read-only `doctl compute {droplet,firewall} {get,list}` |
| local clone-probe → mkdtemp dir | git clones a real mirror into a tmpdir |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-02-01 | Spoofing | SSH host identity | mitigate | Reuses sshFlags from scripts/lib/ssh.ts (accept-new + BatchMode=yes). |
| T-01-02-02 | Information disclosure | Verify output leaking secrets | mitigate | Assertions print only the assertion message + ✓/✗; never echo backup.env contents or token values. |
| T-01-02-03 | Tampering | Verify clone-probe writing inside operator's home | mitigate | Use `fs.mkdtempSync(os.tmpdir()+'/gh-backup-verify-')`; clean on pass, retain on fail. |
| T-01-02-04 | Elevation of privilege | Triggering github-backup.sh on droplet | accept | github-backup.sh runs as the same sshUser; no privilege escalation introduced by verify (it only invokes what cron would run). |
</threat_model>

<verification>
- Type check clean (`npx tsc --noEmit`)
- Grep confirms all four assertion groups are present:
  - `grep -E "doctl compute (droplet get|firewall list)" scripts/verify/phase-1.ts` → ≥ 2 matches
  - `grep "stat -c .%a" scripts/verify/phase-1.ts` → ≥ 1 match (mode 600)
  - `grep "github-backup-managed" scripts/verify/phase-1.ts` → ≥ 1 match
  - `grep "git clone" scripts/verify/phase-1.ts` → ≥ 1 match
- Live execution is deferred to plan 03's checkpoint
</verification>

<success_criteria>
- scripts/verify/phase-1.ts exists and type-checks
- Implements all four D-07 assertion groups
- Reuses scripts/lib/* — no duplicated helpers
- Exits 0 only when every assert passes (verified by inspection of code, not by live run)
</success_criteria>

<output>
After completion, create `.planning/phases/01-verify-pipeline/01-02-SUMMARY.md` listing the assertions implemented and noting any deviations (e.g. if `github-backup.sh` log markers required a fallback assertion).
</output>
