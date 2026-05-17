#!/usr/bin/env node
/**
 * scripts/uat-runner.ts
 *
 * Phase 10 (VALID-01/02/03) — runner for the 21 outstanding human UAT
 * scenarios across Phases 01, 03, 04 + 3 Phase 8 deferred live-validation
 * items. Conservative automation (D-02): pure-script checks and read-only
 * assertions only; anything that mutates infrastructure stays in the
 * MANUAL: list.
 *
 * Survey-style runner: DOES NOT bail-fast. Iterates ALL filtered scenarios,
 * collects results, then exits at the end (0 = all scripted passed, 1 = any
 * scripted failed, 2 = runner crashed).
 *
 * Usage:
 *   npm run uat                                   # all 21
 *   tsx scripts/uat-runner.ts --phase 01
 *   tsx scripts/uat-runner.ts --phase 03
 *   tsx scripts/uat-runner.ts --phase 04
 *   tsx scripts/uat-runner.ts --phase 8-deferred
 *   tsx scripts/uat-runner.ts --scenario p03-05
 *   tsx scripts/uat-runner.ts --no-color
 *   tsx scripts/uat-runner.ts --help
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  loadConfig,
  loadDropletInfo,
  bail,
  type Config,
  type DropletInfo,
} from "./lib/config";

// ─── Types ────────────────────────────────────────────────────────────────

type ScenarioMode = "scripted" | "manual";
type PhaseTag = "01" | "03" | "04" | "8-deferred";
type ResultKind = "passed" | "failed" | "manual";

interface ScriptedStep {
  /** Human-readable label printed before execution. */
  label: string;
  /**
   * Local shell command run with `spawnSync("bash", ["-lc", cmd])`.
   * Non-zero exit = fail unless `expectExit` overrides.
   * Supports `{{cfg.X}}` and `{{droplet.Y}}` placeholders (resolved at run time).
   */
  cmd: string;
  /** Optional override of the success exit code (default 0). */
  expectExit?: number;
  /** Optional regex the captured stdout must match. */
  expectStdout?: RegExp;
  /** Optional regex the captured stdout must NOT match. */
  forbidStdout?: RegExp;
  /** Max wall-clock seconds; runner kills + fails after this. Default 60. */
  timeoutSec?: number;
}

interface Scenario {
  id: string;            // e.g. "p01-04"
  phase: PhaseTag;
  title: string;
  mode: ScenarioMode;
  steps?: ScriptedStep[];          // required when mode === "scripted"
  manualInstruction?: string;      // required when mode === "manual"
}

interface ScenarioResult {
  id: string;
  kind: ResultKind;
  message: string;       // pass: empty; fail: classified reason; manual: the printed instruction
}

interface ParsedFlags {
  phase: PhaseTag | "all";
  scenario?: string;
  noColor: boolean;
  help: boolean;
}

// ─── Scenario manifest (21 entries, strict-floor manual ≥ 7) ──────────────

const SCENARIOS: Scenario[] = [
  // ─── Phase 01 — 8 scenarios ────────────────────────────────────────────
  {
    id: "p01-01",
    phase: "01",
    title: "Cold Start Smoke Test",
    mode: "scripted",
    steps: [
      {
        label: "npm run smoke-test (idempotent against existing droplet)",
        cmd: "npm run --silent smoke-test",
        timeoutSec: 900,
      },
    ],
  },
  {
    id: "p01-02",
    phase: "01",
    title: "Provision Droplet (read-only reachability check)",
    mode: "scripted",
    steps: [
      {
        label: "ssh echo ok against droplet IP",
        cmd: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} echo ok",
        expectStdout: /^ok$/m,
        timeoutSec: 30,
      },
    ],
  },
  {
    id: "p01-03",
    phase: "01",
    title: "Bootstrap Droplet (read-only artifacts check)",
    mode: "scripted",
    steps: [
      {
        label: "github-backup.sh installed + timer enabled",
        cmd: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} 'test -x /opt/github-backups/github-backup.sh && systemctl is-enabled github-backup.timer'",
        expectStdout: /^enabled$/m,
        timeoutSec: 30,
      },
    ],
  },
  {
    id: "p01-04",
    phase: "01",
    title: "Verify Phase 1 Harness",
    mode: "scripted",
    steps: [
      {
        label: "npm run verify:phase-1",
        cmd: "npm run --silent verify:phase-1",
        timeoutSec: 300,
      },
    ],
  },
  {
    id: "p01-05",
    phase: "01",
    title: "Real GitHub User/Org Mirrored (disk count ≥ upstream count)",
    mode: "scripted",
    steps: [
      {
        label: "compare upstream gh repo count vs disk mirror count",
        cmd:
          "set -euo pipefail; " +
          "SLUG=$(node -e \"const c=require('./config.json'); console.log(c.githubUserOrOrg || (c.githubSources && c.githubSources[0] && (typeof c.githubSources[0]==='string'?c.githubSources[0]:c.githubSources[0].name)));\"); " +
          "if [ -z \"$SLUG\" ] || [ \"$SLUG\" = \"undefined\" ]; then echo \"no github source in config.json\" >&2; exit 1; fi; " +
          "UPSTREAM=$(gh api \"users/$SLUG/repos\" --paginate --jq 'length' 2>/dev/null | awk '{s+=$1} END {print s+0}'); " +
          "if [ \"$UPSTREAM\" = \"0\" ]; then UPSTREAM=$(gh api \"orgs/$SLUG/repos\" --paginate --jq 'length' 2>/dev/null | awk '{s+=$1} END {print s+0}'); fi; " +
          "DISK=$(ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} 'ls -d /opt/github-backups/*/*.git 2>/dev/null | wc -l' | tr -d ' '); " +
          "echo \"upstream=$UPSTREAM disk=$DISK\"; " +
          "if [ \"$DISK\" -lt \"$UPSTREAM\" ]; then echo \"disk ($DISK) < upstream ($UPSTREAM)\" >&2; exit 1; fi",
        expectStdout: /upstream=\d+ disk=\d+/,
        timeoutSec: 120,
      },
    ],
  },
  {
    id: "p01-06",
    phase: "01",
    title: "Git Clone Over SSH Works",
    mode: "scripted",
    steps: [
      {
        label: "pick first *.git on droplet and clone over ssh",
        cmd:
          "set -euo pipefail; " +
          "FIRST=$(ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} 'ls -d /opt/github-backups/*/*.git 2>/dev/null | head -1'); " +
          "if [ -z \"$FIRST\" ]; then echo \"no *.git on droplet\" >&2; exit 1; fi; " +
          "DEST=$(mktemp -d); " +
          "GIT_SSH_COMMAND=\"ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}}\" " +
          "git clone {{cfg.sshUser}}@{{droplet.ip}}:$FIRST $DEST/probe-clone >/dev/null 2>&1; " +
          "test -d $DEST/probe-clone/.git; " +
          "echo CLONE_OK=$DEST/probe-clone",
        expectStdout: /^CLONE_OK=/m,
        timeoutSec: 120,
      },
    ],
  },
  {
    id: "p01-07",
    phase: "01",
    title: "BACKUP_SUMMARY Marker Contract",
    mode: "scripted",
    steps: [
      {
        label: "grep BACKUP_SUMMARY in last 200 log lines",
        cmd: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} 'tail -200 /var/log/github-backup.log | grep -c \"BACKUP_SUMMARY upstream=[0-9]* mirrored=[0-9]* failed=[0-9]*\"'",
        expectStdout: /^[1-9][0-9]*$/m,
        timeoutSec: 30,
      },
    ],
  },
  {
    id: "p01-08",
    phase: "01",
    title: "Destroy Droplet Safety Gates",
    mode: "manual",
    manualInstruction:
      "Operator: on a sacrificial droplet, verify `npx tsx scripts/destroy-droplet.ts` with no `.droplet.json` exits 1 with 'Refusing to destroy: .droplet.json not found.'; with `.droplet.json` and no `--yes` prompts y/N and refuses on empty/N; with `--yes` destroys by id only. D-02: destructive — runner does NOT automate.",
  },

  // ─── Phase 03 — 6 scenarios ────────────────────────────────────────────
  {
    id: "p03-01",
    phase: "03",
    title: "DNS A record points at droplet",
    mode: "manual",
    manualInstruction:
      "Operator: create A record for `cfg.webhookHostname` → droplet IP BEFORE bootstrap. Verify with `dig +short A {{cfg.webhookHostname}}` returns {{droplet.ip}}. D-02: operator-owned DNS creation, runner does NOT automate.",
  },
  {
    id: "p03-02",
    phase: "03",
    title: "Caddy auto-issues Let's Encrypt cert",
    mode: "scripted",
    steps: [
      {
        label: "openssl s_client | x509 -enddate",
        cmd: "echo | openssl s_client -servername {{cfg.webhookHostname}} -connect {{cfg.webhookHostname}}:443 2>/dev/null | openssl x509 -noout -enddate",
        expectStdout: /^notAfter=/m,
        timeoutSec: 30,
      },
    ],
  },
  {
    id: "p03-03",
    phase: "03",
    title: "systemctl is-active github-backup-webhook",
    mode: "scripted",
    steps: [
      {
        label: "ssh systemctl is-active github-backup-webhook",
        cmd: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} systemctl is-active github-backup-webhook",
        expectStdout: /^active$/m,
        timeoutSec: 30,
      },
    ],
  },
  {
    id: "p03-04",
    phase: "03",
    title: "Signed push triggers mirror within 30s",
    mode: "manual",
    manualInstruction:
      "Operator: push a commit to `cfg.webhookTestRepo`. Within 30s, `ssh root@{{droplet.ip}} 'tail -100 /var/log/github-backup.log | grep BACKUP_REPO_RESULT'` should show `action=clone|update` for that repo. D-02: real GitHub push, runner does NOT automate.",
  },
  {
    id: "p03-05",
    phase: "03",
    title: "Bad signature returns 401",
    mode: "scripted",
    steps: [
      {
        label: "curl with deadbeef signature → 401",
        cmd:
          "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' " +
          "-X POST " +
          "-H 'X-Hub-Signature-256: sha256=deadbeef' " +
          "-H 'X-GitHub-Event: push' " +
          "-H 'Content-Type: application/json' " +
          "--data '{}' " +
          "https://{{cfg.webhookHostname}}/webhook/github",
        expectStdout: /^401$/m,
        timeoutSec: 10,
      },
    ],
  },
  {
    id: "p03-06",
    phase: "03",
    title: "Re-bootstrap preserves WEBHOOK_SECRET + restarts listener",
    mode: "manual",
    manualInstruction:
      "Operator: run a second `npm run bootstrap-droplet`. Verify the run log shows `🔐  Preserving existing WEBHOOK_SECRET` AND `ssh root@{{droplet.ip}} systemctl is-active github-backup-webhook` returns `active`. D-02: operator runs the actual second-bootstrap; runner verifies post-conditions only.",
  },

  // ─── Phase 04 — 4 scenarios ────────────────────────────────────────────
  {
    id: "p04-01",
    phase: "04",
    title: "Live-droplet single-repo restore smoke",
    mode: "scripted",
    steps: [
      {
        label: "npm run restore -- <first-repo> against temp dir",
        cmd:
          "set -euo pipefail; " +
          "FIRST=$(ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -i {{cfg.sshKeyPath}} root@{{droplet.ip}} 'ls -d /opt/github-backups/*/*.git 2>/dev/null | head -1'); " +
          "if [ -z \"$FIRST\" ]; then echo \"no *.git on droplet\" >&2; exit 1; fi; " +
          // Strip /opt/github-backups/<owner>/<owner>_<repo>.git → <owner>/<repo>
          "OWNER=$(basename $(dirname \"$FIRST\")); " +
          "BASE=$(basename \"$FIRST\" .git); " +
          "REPO=${BASE#${OWNER}_}; " +
          "DEST=$(mktemp -d)/restore-smoke; " +
          "OUT=$(npm run --silent restore -- \"$OWNER/$REPO\" \"$DEST\" 2>&1); " +
          "echo \"$OUT\" > /tmp/uat-p04-01.log; " +
          "FIRSTLINE=$(echo \"$OUT\" | grep -m1 -E '^RESTORE_LOCAL_MIRROR=' || true); " +
          "if [ -z \"$FIRSTLINE\" ]; then echo \"missing RESTORE_LOCAL_MIRROR= line\" >&2; exit 1; fi; " +
          "test -d \"$DEST/.git\"; " +
          "echo P04_01_DEST=$DEST",
        expectStdout: /^P04_01_DEST=/m,
        timeoutSec: 300,
      },
    ],
  },
  {
    id: "p04-02",
    phase: "04",
    title: "Restored clone refs inspection",
    mode: "scripted",
    steps: [
      {
        label: "branches + tags in restored clone (from p04-01)",
        cmd:
          "set -euo pipefail; " +
          "if [ ! -f /tmp/uat-p04-01.log ]; then echo \"p04-01 did not run (no /tmp/uat-p04-01.log)\" >&2; exit 1; fi; " +
          "DEST=$(grep -m1 -E '^P04_01_DEST=' /tmp/uat-p04-01.log | sed 's/^P04_01_DEST=//' || true); " +
          // Older p04-01 logs may only carry RESTORE_LOCAL_MIRROR=; fall back to its path.
          "if [ -z \"$DEST\" ] || [ ! -d \"$DEST/.git\" ]; then DEST=$(grep -m1 -E '^RESTORE_LOCAL_MIRROR=' /tmp/uat-p04-01.log | sed 's/^RESTORE_LOCAL_MIRROR=//' || true); fi; " +
          "if [ -z \"$DEST\" ] || [ ! -d \"$DEST/.git\" ]; then echo \"no usable restore dir from p04-01\" >&2; exit 1; fi; " +
          "BRANCHES=$(git -C \"$DEST\" branch -a | wc -l | tr -d ' '); " +
          "TAGS=$(git -C \"$DEST\" tag | wc -l | tr -d ' '); " +
          "echo \"branches=$BRANCHES tags=$TAGS\"; " +
          "if [ \"$BRANCHES\" -lt 1 ]; then echo \"branches < 1\" >&2; exit 1; fi",
        expectStdout: /branches=\d+ tags=\d+/,
        timeoutSec: 30,
      },
    ],
  },
  {
    id: "p04-03",
    phase: "04",
    title: "verify:phase-4 happy path",
    mode: "scripted",
    steps: [
      {
        label: "npm run verify:phase-4",
        cmd: "npm run --silent verify:phase-4",
        expectStdout: /✅ verify:phase-4 PASS/,
        timeoutSec: 300,
      },
    ],
  },
  {
    id: "p04-04",
    phase: "04",
    title: "verify:phase-4 ref-mismatch path",
    mode: "manual",
    manualInstruction:
      "Operator: inject a ref mismatch with `ssh root@{{droplet.ip}} 'git -C /opt/github-backups/<owner>/<owner>_<repo>.git update-ref refs/heads/__test__ HEAD'` (use the repo from `cfg.restoreTestRepo`). Run `npm run verify:phase-4` and verify exit 1 + `✗ ref mismatch between droplet mirror and restored bare mirror`. Cleanup: `ssh root@{{droplet.ip}} 'git -C /opt/github-backups/<owner>/<owner>_<repo>.git update-ref -d refs/heads/__test__'`. D-02: mutates droplet mirror, runner does NOT automate.",
  },

  // ─── Phase 8 deferred live-validation — 3 scenarios ────────────────────
  {
    id: "p8d-09",
    phase: "8-deferred",
    title: "Firewall drift-inject test",
    mode: "manual",
    manualInstruction:
      "Operator: run `doctl compute firewall remove-rules <fw-id> --outbound-rules \"protocol:tcp,ports:all,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0\"` then `npm run create-droplet`. Verify post-run: `+ [outbound] Adding rule:` for the deleted entry; zero `add-rules` calls on the immediate re-run. D-02: mutates firewall, runner does NOT automate.",
  },
  {
    id: "p8d-10",
    phase: "8-deferred",
    title: "Firewall extras-preservation test",
    mode: "manual",
    manualInstruction:
      "Operator: run `doctl compute firewall add-rules <fw-id> --outbound-rules \"protocol:tcp,ports:9999,destinations:addresses:0.0.0.0/0\"` then `npm run create-droplet`. Verify post-run: the extras row is still present on the firewall; no `remove-rules` call. D-02: mutates firewall, runner does NOT automate.",
  },
  {
    id: "p8d-11",
    phase: "8-deferred",
    title: "verify:phase-7 regression check",
    mode: "scripted",
    steps: [
      {
        label: "npm run verify:phase-7",
        cmd: "npm run --silent verify:phase-7",
        timeoutSec: 300,
      },
    ],
  },
];

// ─── Placeholder substitution + step executor (Task 01-02) ────────────────

/** Substitute `{{cfg.X}}` / `{{droplet.Y}}` placeholders in a command string. */
function substitute(template: string, cfg: Config, droplet: DropletInfo | null): string {
  // Replace droplet placeholders first; bail if droplet is null but template references it.
  // DropletInfo shape (scripts/lib/config.ts): { id: number; ip: string; name: string; region: string }.
  template = template.replace(/\{\{droplet\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_m, key: string) => {
    if (!droplet) {
      throw new Error(`droplet placeholder {{droplet.${key}}} used but .droplet.json missing`);
    }
    const v = (droplet as unknown as Record<string, unknown>)[key];
    if (v === undefined) {
      throw new Error(`droplet placeholder {{droplet.${key}}} unresolved (DropletInfo has no field "${key}")`);
    }
    return String(v);
  });
  // Replace cfg placeholders. Resolve dotted paths e.g. {{cfg.webhookHostname}}, {{cfg.sources.0.name}}.
  template = template.replace(/\{\{cfg\.([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g, (_m, path: string) => {
    const parts = path.split(".");
    let cur: unknown = cfg;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        throw new Error(`cfg placeholder {{cfg.${path}}} unresolved (config.json missing this key?)`);
      }
    }
    return String(cur);
  });
  return template;
}

/** Run a single ScriptedStep; return {ok, reason} where reason is empty on success. */
function runStep(step: ScriptedStep, cfg: Config, droplet: DropletInfo | null): { ok: boolean; reason: string } {
  let cmd: string;
  try {
    cmd = substitute(step.cmd, cfg, droplet);
  } catch (e: unknown) {
    return { ok: false, reason: `substitution failed: ${(e as Error).message}` };
  }
  const expectExit = step.expectExit ?? 0;
  const timeoutMs = (step.timeoutSec ?? 60) * 1000;
  const result = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) return { ok: false, reason: `spawn error: ${result.error.message}` };
  if (result.signal) return { ok: false, reason: `killed by signal ${result.signal}` };
  if (result.status !== expectExit) {
    const tail = ((result.stderr ?? "") + (result.stdout ?? "")).trim().split("\n").slice(-3).join(" | ");
    return { ok: false, reason: `exit ${result.status} (expected ${expectExit}): ${tail || "<no output>"}` };
  }
  const stdout = result.stdout ?? "";
  if (step.expectStdout && !step.expectStdout.test(stdout)) {
    return { ok: false, reason: `stdout did not match ${step.expectStdout}` };
  }
  if (step.forbidStdout && step.forbidStdout.test(stdout)) {
    return { ok: false, reason: `stdout matched forbidden pattern ${step.forbidStdout}` };
  }
  return { ok: true, reason: "" };
}

/** Run all steps of a scripted scenario; aggregate to a single ScenarioResult. */
function runScripted(s: Scenario, cfg: Config, droplet: DropletInfo | null): ScenarioResult {
  if (!s.steps || s.steps.length === 0) {
    return { id: s.id, kind: "failed", message: "scripted scenario has no steps (manifest bug)" };
  }
  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i]!;
    const { ok, reason } = runStep(step, cfg, droplet);
    if (!ok) {
      return {
        id: s.id,
        kind: "failed",
        message: `step ${i + 1}/${s.steps.length} (${step.label}): ${reason}`,
      };
    }
  }
  return { id: s.id, kind: "passed", message: "" };
}

// ─── CLI parsing (Task 01-01 stub; main() wired in 01-03) ─────────────────

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { phase: "all", noColor: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--no-color":
        flags.noColor = true;
        break;
      case "--phase": {
        const v = args[++i];
        if (v !== "01" && v !== "03" && v !== "04" && v !== "8-deferred" && v !== "all") {
          bail(`--phase must be one of 01|03|04|8-deferred|all (got: ${v ?? "<missing>"})`);
        }
        flags.phase = v as PhaseTag | "all";
        break;
      }
      case "--scenario": {
        const v = args[++i];
        if (!v) bail(`--scenario requires an id (e.g. p03-05)`);
        flags.scenario = v;
        break;
      }
      default:
        bail(`unknown flag: ${a}`);
    }
  }
  return flags;
}

function printHelp(): void {
  console.log("uat-runner — Phase 10 UAT scenarios (21 total)");
  console.log("");
  console.log("Usage:");
  console.log("  npm run uat                            # all 21");
  console.log("  tsx scripts/uat-runner.ts --phase 01");
  console.log("  tsx scripts/uat-runner.ts --phase 03");
  console.log("  tsx scripts/uat-runner.ts --phase 04");
  console.log("  tsx scripts/uat-runner.ts --phase 8-deferred");
  console.log("  tsx scripts/uat-runner.ts --scenario p03-05");
  console.log("  tsx scripts/uat-runner.ts --no-color");
  console.log("");
  console.log("Exit codes: 0 = all scripted passed, 1 = any scripted failed, 2 = runner crashed.");
  console.log("");
  console.log("Scenarios:");
  for (const s of SCENARIOS) {
    const tag = s.mode === "manual" ? "[MANUAL]  " : "[scripted]";
    console.log(`  ${tag} ${s.id}  phase=${s.phase}  ${s.title}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = parseFlags(args);

  if (flags.help) {
    printHelp();
    return;
  }

  // Filter scenarios.
  let toRun = SCENARIOS;
  if (flags.scenario) {
    toRun = SCENARIOS.filter((s) => s.id === flags.scenario);
    if (toRun.length === 0) bail(`unknown scenario id: ${flags.scenario}`);
  } else if (flags.phase !== "all") {
    toRun = SCENARIOS.filter((s) => s.phase === flags.phase);
  }

  // Load context (cfg always; droplet best-effort — loadDropletInfo() bails
  // hard if .droplet.json is missing, so check existence first).
  const cfg = loadConfig();
  let droplet: DropletInfo | null = null;
  const dropletPath = path.resolve(process.cwd(), ".droplet.json");
  if (fs.existsSync(dropletPath)) {
    try {
      droplet = loadDropletInfo();
    } catch {
      droplet = null;
    }
  }

  // Runtime commit (for paste into 10-VERIFICATION.md frontmatter).
  let runtimeCommit = "(unknown)";
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    if (r.status === 0) runtimeCommit = (r.stdout ?? "").trim() || "(unknown)";
  } catch {
    // best-effort
  }

  // Print banner.
  console.log(
    `━━━ UAT RUNNER ━━━ ${toRun.length} scenario(s) — droplet ${
      droplet ? droplet.ip : "(none)"
    } — runtime ${runtimeCommit}`,
  );

  // Execute. Survey mode — DO NOT bail-fast. Iterate all, collect, exit at end.
  const results: ScenarioResult[] = [];
  for (const s of toRun) {
    if (s.mode === "manual") {
      const instr = s.manualInstruction ?? "<missing instruction — manifest bug>";
      let rendered = instr;
      try {
        rendered = substitute(instr, cfg, droplet);
      } catch {
        // If a placeholder can't resolve (e.g. droplet missing), still print the literal
        // template so the operator sees what to do.
        rendered = instr;
      }
      console.log(`…  MANUAL: ${s.id}: ${rendered}`);
      results.push({ id: s.id, kind: "manual", message: rendered });
      continue;
    }
    // scripted
    if (!droplet && requiresDroplet(s)) {
      console.log(`✗  ${s.id} failed: droplet unreachable (.droplet.json missing)`);
      results.push({ id: s.id, kind: "failed", message: "droplet unreachable" });
      continue;
    }
    const r = runScripted(s, cfg, droplet);
    if (r.kind === "passed") console.log(`✓  ${s.id} passed`);
    else console.log(`✗  ${s.id} failed: ${r.message}`);
    results.push(r);
  }

  // Summary table per phase (printed; copy/paste-ready for 10-VERIFICATION.md).
  printSummary(results);

  // Exit code semantics (D-01).
  const anyFailed = results.some((r) => r.kind === "failed");
  process.exit(anyFailed ? 1 : 0);
}

/** True iff any step.cmd of a scripted scenario references {{droplet.X}}. */
function requiresDroplet(s: Scenario): boolean {
  if (s.mode !== "scripted" || !s.steps) return false;
  for (const step of s.steps) {
    if (/\{\{droplet\./.test(step.cmd)) return true;
  }
  return false;
}

/** Print a markdown summary table (parseable, paste-ready for 10-VERIFICATION.md). */
function printSummary(results: ScenarioResult[]): void {
  const byPhase: Record<PhaseTag, ScenarioResult[]> = {
    "01": [],
    "03": [],
    "04": [],
    "8-deferred": [],
  };
  // Index scenario → phase for grouping.
  const phaseOf = new Map<string, PhaseTag>();
  for (const s of SCENARIOS) phaseOf.set(s.id, s.phase);

  for (const r of results) {
    const p = phaseOf.get(r.id);
    if (p) byPhase[p].push(r);
  }

  console.log("");
  console.log("## Summary");
  console.log("");
  console.log("| Bucket | Total | Passed | Failed | Manual (recorded) |");
  console.log("|--------|-------|--------|--------|-------------------|");
  const phases: PhaseTag[] = ["01", "03", "04", "8-deferred"];
  const labels: Record<PhaseTag, string> = {
    "01": "Phase 01 UAT",
    "03": "Phase 03 UAT",
    "04": "Phase 04 UAT",
    "8-deferred": "Phase 8 deferred",
  };
  let totalT = 0, totalP = 0, totalF = 0, totalM = 0;
  for (const ph of phases) {
    const rs = byPhase[ph];
    const total = rs.length;
    const passed = rs.filter((r) => r.kind === "passed").length;
    const failed = rs.filter((r) => r.kind === "failed").length;
    const manual = rs.filter((r) => r.kind === "manual").length;
    totalT += total;
    totalP += passed;
    totalF += failed;
    totalM += manual;
    console.log(`| ${labels[ph]} | ${total} | ${passed} | ${failed} | ${manual} |`);
  }
  console.log(`| **Total** | **${totalT}** | **${totalP}** | **${totalF}** | **${totalM}** |`);

  // Per-scenario rows (paste into "Phase NN Results" sections).
  for (const ph of phases) {
    const rs = byPhase[ph];
    if (rs.length === 0) continue;
    console.log("");
    console.log(`### ${labels[ph]} — rows`);
    console.log("");
    console.log("| id | kind | message |");
    console.log("|----|------|---------|");
    for (const r of rs) {
      const msg = r.message ? r.message.replace(/\|/g, "\\|").replace(/\n/g, " ") : "";
      console.log(`| ${r.id} | ${r.kind} | ${msg} |`);
    }
  }
}

main().catch((e: unknown) => {
  console.error("runner crashed:", (e as Error).stack || (e as Error).message || String(e));
  process.exit(2);
});
