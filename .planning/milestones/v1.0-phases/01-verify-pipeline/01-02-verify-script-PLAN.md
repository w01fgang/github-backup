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
    - "Group 3 enforces mirrored == upstream AND failed == 0 (standalone D-02 lock — does not depend on smoke-test)"
    - "Verify script bails on first failed assertion with a clear message naming the failed assertion"
    - "Clone-probe runs on the local machine (not the droplet) and lands in a mkdtemp directory"
  artifacts:
    - path: "scripts/verify/phase-1.ts"
      provides: "Four D-07 assertion groups: provision, bootstrap-SSH, backup-ran (incl. D-02 count-equality), clone-probe"
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
    - from: "scripts/verify/phase-1.ts"
      to: "droplet/github-backup.sh BACKUP_SUMMARY marker"
      via: "tail /var/log/github-backup.log + regex parse"
      pattern: "BACKUP_SUMMARY"
---

<objective>
Implement the per-phase executable verification (TEST-02, decisions D-06 and D-07): a TypeScript assertion script that fails fast on the first violated invariant and exits 0 only when all four assertion groups pass against a live droplet. Group 3 enforces the D-02 100% pass bar standalone (does not depend on smoke-test).

Purpose: gives every future phase a green-baseline lock — Phase 1 cannot be marked complete until `npm run verify:phase-1` exits 0.
Output: `scripts/verify/phase-1.ts` covering the full D-07 assertion matrix plus the D-02 count-equality lock.
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

<!-- BACKUP_SUMMARY marker contract (added to droplet/github-backup.sh by plan 01-03 task 1)
     Final-line format on successful backup:
       [YYYY-MM-DD HH:MM:SS] BACKUP_SUMMARY upstream=N mirrored=M failed=F
     Regex: ^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$
-->
const BACKUP_SUMMARY_RE = /^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$/m;
</interfaces>
</context>

<rationale>
Plan-checker Issue 4 chose Option A (smaller bash diff): `droplet/github-backup.sh` emits a single `BACKUP_SUMMARY upstream=N mirrored=M failed=F` line on its successful path. Plan 01-03 task 1 owns the bash diff (it touches the script anyway during the bug-fix loop). This plan parses that line — does NOT re-derive the upstream count via `gh api` in TypeScript, which would duplicate the user-vs-org detection at lines 71–85 of `github-backup.sh`. The marker is the contract; both verify and smoke parse it.

Plan-checker Issue 5: Group 3 was previously `≥1 .git directory`. Now it asserts `mirrored == upstream && failed == 0` — making `npm run verify:phase-1` a standalone D-02 lock. Smoke-test no longer carries the count-equality check alone.
</rationale>

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

**Group 3 — Backup-ran (D-07.3) + 100% pass bar (D-02):**
- Trigger: `ssh ... "/opt/github-backups/github-backup.sh"` (run synchronously; this can take minutes on a real account — acceptable for verify).
- Assert: `ssh ... "tail -n 50 /var/log/github-backup.log"` stdout contains exactly one line matching the regex `^\[.*\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$` (the marker emitted by `droplet/github-backup.sh` — see plan 01-03 task 1 for the bash-side change).
- Parse `upstream`, `mirrored`, `failed` from the matched line.
- Assert `mirrored === upstream && failed === 0` — this is the standalone D-02 lock per plan-checker Issue 5. Any divergence fails verify with a message naming the three counts.
- Assert: `ssh ... "ls -1d /opt/github-backups/*.git 2>/dev/null | wc -l"` returns a number that equals `mirrored` (cross-check: log says N mirrored, filesystem must show N .git dirs).

**Group 4 — Clone-probe (D-07.4, ACCESS-01):**
- Pick the first repo from `ssh ... "ls -1d /opt/github-backups/*.git | head -n1"` → strip path → use as `<owner>_<repo>.git`.
- `mkdtemp` a local directory (`fs.mkdtempSync(os.tmpdir() + '/gh-backup-verify-')`).
- `git clone <user>@<ip>:/opt/github-backups/<repo>.git <tmpdir>/<repo>` — assert exit 0.
- `cd <tmpdir>/<repo> && git rev-parse HEAD` — assert exit 0 and output is a 40-char hex.
- `cd <tmpdir>/<repo> && git for-each-ref | wc -l` — assert > 0.
- Clean up the tmpdir on success (best-effort `fs.rmSync`); leave it on failure for inspection.

Per the "100% pass bar" decision (D-02): every assertion is hard. No skip flags, no soft-fail.

Per CONTEXT.md "code_context > Integration Points": clone-probe runs on the LOCAL machine (operator's box). Use the operator's local `git` and the configured `sshUser`/`sshKeyPath` from `config.json`.

The `BACKUP_SUMMARY` marker line is added to `droplet/github-backup.sh` by plan 01-03 task 1 (cheaper than re-deriving upstream count in TS — plan-checker Issue 4 chose this option). If executing this plan before that bash diff lands, the marker assertion will fail; that is correct behavior — verify:phase-1 cannot pass without the contract on both sides.
  </action>
  <verify>
    <automated>bash -c 'set -euo pipefail; npx tsc --noEmit -p tsconfig.json; f=scripts/verify/phase-1.ts; n=$(grep -c "^[[:space:]]*assert(" "$f"); [ "$n" -ge 8 ] || { echo "need >=8 assert() calls, got $n"; exit 1; }; grep -E "doctl compute (droplet get|firewall list)" "$f" >/dev/null || { echo "Group 1 (provision) doctl probes missing"; exit 1; }; grep -E "stat -c .%a" "$f" >/dev/null || { echo "Group 2 (bootstrap) mode-600 probe missing"; exit 1; }; grep "github-backup-managed" "$f" >/dev/null || { echo "Group 2 cron marker probe missing"; exit 1; }; grep "BACKUP_SUMMARY" "$f" >/dev/null || { echo "Group 3 BACKUP_SUMMARY marker probe missing"; exit 1; }; grep -E "mirrored.*upstream|upstream.*mirrored" "$f" >/dev/null || { echo "Group 3 count-equality assertion missing (D-02 lock)"; exit 1; }; grep "git clone" "$f" >/dev/null || { echo "Group 4 clone-probe missing"; exit 1; }; grep -E "from \"\\.\\./lib/(ssh|doctl|config)\"" "$f" >/dev/null || { echo "verify script must import from ../lib/*"; exit 1; }'</automated>
  </verify>
  <done>
- scripts/verify/phase-1.ts type-checks
- Contains ≥ 8 `assert(...)` calls covering the four D-07 groups
- Group 3 parses BACKUP_SUMMARY and asserts `mirrored === upstream && failed === 0` (D-02 lock per plan-checker Issue 5)
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
| T-01-02-05 | Tampering | BACKUP_SUMMARY marker spoofing in log | accept | Log file is droplet-local, written by the same script that runs the backup; an attacker who can write the log already owns the droplet. Marker is a correctness contract, not a security boundary. |
</threat_model>

<verification>
All static checks (type check + four-group grep gate + lib-import gate + BACKUP_SUMMARY gate + count-equality gate) are folded into Task 1's `<automated>` block per plan-checker Issue 3, so the per-plan verify gate enforces them. Live execution against the droplet is deferred to plan 03's checkpoint.
</verification>

<success_criteria>
- scripts/verify/phase-1.ts exists and type-checks
- Implements all four D-07 assertion groups
- Group 3 enforces D-02 count-equality standalone (mirrored == upstream && failed == 0)
- Reuses scripts/lib/* — no duplicated helpers
- Exits 0 only when every assert passes (verified by inspection of code + the consolidated <automated> gate, not by live run)
</success_criteria>

<output>
After completion, create `.planning/phases/01-verify-pipeline/01-02-SUMMARY.md` listing the assertions implemented and confirming the BACKUP_SUMMARY regex matches the line shape emitted by plan 01-03 task 1's bash diff.
</output>
