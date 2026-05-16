---
phase: 05-teardown
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/bootstrap-droplet.ts
autonomous: true
requirements:
  - TEARDOWN-01

must_haves:
  truths:
    - "Re-running npm run bootstrap-droplet on a live droplet preserves the on-droplet backup.env byte-for-byte by default"
    - "Operator can pass --rotate-env to deliberately overwrite the on-droplet backup.env (PAT rotation, schedule change)"
    - "GITHUB_TOKEN is only required on the upload path (first-run or --rotate-env); skip-path tolerates unset token"
    - "Operator never wonders whether their token survived — the skip-path emits an explicit log line"
    - "SSH transport failure on the probe (exit 255) bails loudly — never silently treated as absent"
  artifacts:
    - path: "scripts/bootstrap-droplet.ts"
      provides: "--rotate-env flag parsing, remote probe of backup.env, conditional upload + explicit log, token-gate moved to upload branch only"
      contains: "--rotate-env"
  key_links:
    - from: "scripts/bootstrap-droplet.ts"
      to: "backup.env on droplet"
      via: "ssh test -f probe before scpFile upload"
      pattern: "test -f .*backup\\.env"
    - from: "scripts/bootstrap-droplet.ts"
      to: "writeBackupEnv (existing token-shape validation)"
      via: "conditional call only on upload path"
      pattern: "writeBackupEnv"
---

<objective>
Make `scripts/bootstrap-droplet.ts` safe to re-run against an already-bootstrapped droplet without clobbering the runtime `GITHUB_TOKEN` (D-01..D-04). Add a `--rotate-env` opt-in for deliberate token / config rotation. Token-shape validation in `writeBackupEnv` stays unchanged.

Purpose: TEARDOWN-01 SC#2 — "Re-running preserves existing backup.env by default; --rotate-env forces fresh upload." Single change site; surgical edit; no helpers extracted.
Output: edited `scripts/bootstrap-droplet.ts` with first-run probe, conditional `backup.env` upload, explicit skip-log, gated token requirement.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/05-teardown/05-CONTEXT.md
@scripts/bootstrap-droplet.ts
@scripts/lib/ssh.ts
@scripts/lib/config.ts

<interfaces>
<!-- Helpers already in scripts/lib (Phase 1) — reuse verbatim, do not redesign. -->

From scripts/lib/ssh.ts:
```typescript
export function sshFlags(keyPath: string): string;
export function sshRun(ip: string, user: string, keyPath: string, remoteCmd: string): void; // runVisible-style; throws on non-zero
export function runCapture(cmd: string): string; // returns trimmed stdout; throws on non-zero
export function scpFile(ip: string, user: string, keyPath: string, localPath: string, remotePath: string): void;
export function waitForSsh(ip: string, user: string, keyPath: string, timeoutMs?: number): Promise<void>;
```

From scripts/lib/config.ts:
```typescript
export function bail(msg: string): never; // prints "❌  <msg>" and exit 1
export function loadConfig(): Config;
export function loadDropletInfo(): DropletInfo;
export interface Config { sshUser: string; sshKeyPath: string; backupDir: string; githubUserOrOrg: string; cronSchedule: string; /* ... */ }
```

<!-- Existing local function in scripts/bootstrap-droplet.ts (keep as-is, only call site changes): -->
function writeBackupEnv(cfg: Config, githubToken: string): string; // returns local tmp path, mode 600
</interfaces>
</context>

<rationale>
**Why a remote probe, not a local state file (D-03):** A fresh local checkout has no `.droplet.json` history of prior bootstraps, but the droplet may already be bootstrapped (re-cloned project tree, lost laptop, etc.). The on-droplet `backup.env` is the only true source of truth for "has this droplet been bootstrapped before". One `ssh test -f` is cheap and authoritative.

**Why probe failure must bail (D-03 last sentence):** Silently treating an SSH transport error (exit 255) as "file absent → upload" would let a network blip silently overwrite the operator's token. Fail-loud is the project's existing posture (see Rule 12 / `bail()` usage throughout).

**Why token-gate moves into the upload branch (CONTEXT specifics §3):** Today the script bails on unset `GITHUB_TOKEN` before any droplet contact. Under D-01, the common case (re-deploy droplet scripts after a code edit) does NOT need a token. Gating the bail on the upload branch keeps the error message correct: skip-path is silent on unset token; upload-path bails with today's exact message.

**Why we don't touch `droplet/install-cron.sh` / `droplet/bootstrap.sh` (D-05, D-07):** Cron marker stripping is already idempotent (lines 48–54 of `install-cron.sh`); `bootstrap.sh` re-run is OS-level idempotent. Phase 5 asserts this in the verify script (plan 02 Group 3), it does not re-implement it.

**Listener-restart wiring is NOT in this plan (D-07 last sentence, CONTEXT out-of-scope):** Phase 3 (webhook listener) owns the `systemctl daemon-reload && systemctl restart github-backup-webhook` line inside `droplet/bootstrap.sh`. Plan 05-02's verify asserts the survival contract conditionally; this plan does not modify droplet-side files.
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Add --rotate-env flag parsing + tiny local hasFlag helper</name>
  <files>scripts/bootstrap-droplet.ts</files>
  <action>
At the top of `main()` (above the existing `GITHUB_TOKEN` read), parse `process.argv` for the `--rotate-env` flag:

```typescript
function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

const rotateEnv = hasFlag("--rotate-env");
```

Inline `hasFlag` is fine — do NOT extract to a lib. (CONTEXT.md notes the previous `hasFlag` was removed from `smoke-test.ts`; re-introducing the trivial local helper is correct per Rule 3 surgical changes.)

**Token-gate restructure.** Move the existing `if (!githubToken) bail(...)` block so it ONLY fires when the script is about to upload `backup.env` (i.e. first-run OR `--rotate-env`). The skip-path must tolerate an unset / empty `GITHUB_TOKEN` silently. Concretely:

- Keep the existing trim: `const githubToken = (process.env["GITHUB_TOKEN"] ?? "").trim();`
- Delete (or move) the eager `if (!githubToken) bail(...)` that currently fires unconditionally on line ~83.
- The new gate fires later, only inside the upload branch added in Task 2. Use the existing bail message verbatim ("GITHUB_TOKEN environment variable is not set (or is empty after trim).\n    Usage: GITHUB_TOKEN=<your_pat> npm run bootstrap-droplet") so operators see the identical error they see today on first-run with no token. Append a short hint when `--rotate-env` is the trigger: ` (—rotate-env requires GITHUB_TOKEN to be set)`.
  </action>
  <verify>
    <automated>npx tsc --noEmit scripts/bootstrap-droplet.ts</automated>
  </verify>
  <done>Script type-checks; `--rotate-env` parsed via `hasFlag`; eager unconditional token bail removed; new gate not yet inserted in this task (Task 2 inserts it).</done>
</task>

<task type="auto">
  <name>Task 2: SSH probe + conditional backup.env upload + explicit skip log</name>
  <files>scripts/bootstrap-droplet.ts</files>
  <action>
After `await waitForSsh(ip, user, keyPath);` and `mkdir -p "${backupDir}"` (the latter must stay — it's harmless on re-run and required for first-run), insert the first-run probe and replace the unconditional `writeBackupEnv` + `scpFile` block with conditional logic:

```typescript
// — D-03: probe on-droplet backup.env. Use runCapture so we can read the
// printed sentinel. ssh transport failure (exit 255) throws — propagate it
// (CONTEXT.md D-03: never silently treat an SSH blip as "absent").
const probeCmd =
  `ssh ${sshFlags(keyPath)} ${user}@${ip} ` +
  `'test -f "${backupDir}/backup.env" && echo present || echo absent'`;
const probe = runCapture(probeCmd).trim();
if (probe !== "present" && probe !== "absent") {
  bail(
    `Unexpected probe response from droplet: ${JSON.stringify(probe)}.\n` +
    `    Expected 'present' or 'absent'. Aborting to avoid clobbering backup.env.`
  );
}
const envExists = probe === "present";

const willUpload = !envExists || rotateEnv;

if (willUpload) {
  // — Token-gate moved here from main() top (Task 1). Upload requires a token.
  if (!githubToken) {
    const hint = rotateEnv ? " (--rotate-env requires GITHUB_TOKEN to be set)" : "";
    bail(
      "GITHUB_TOKEN environment variable is not set (or is empty after trim).\n" +
      "    Usage: GITHUB_TOKEN=<your_pat> npm run bootstrap-droplet" + hint
    );
  }

  console.log(`\n📝  Generating backup.env…`);
  const envPath = writeBackupEnv(cfg, githubToken);
  try {
    console.log(`\n🔑  Uploading backup.env…`);
    scpFile(ip, user, keyPath, envPath, `${backupDir}/backup.env`);
  } finally {
    fs.rmSync(path.dirname(envPath), { recursive: true, force: true });
  }
} else {
  // — D-04: silent preserve is a footgun. Announce the skip.
  console.log(
    `\n▸  ${backupDir}/backup.env exists on droplet — preserving ` +
    `(use --rotate-env to overwrite).`
  );
}
```

Move the existing `try { … } finally { fs.rmSync(...) }` cleanup so it ONLY wraps the upload branch (the tmp dir is only created inside the upload branch now; the outer `finally` block in today's code becomes dead in the skip path and should be removed or folded into the inner try as shown).

Keep the rest of the function (`📤  Uploading droplet scripts…`, the for-loop over `droplet/*.sh`, the `chmod +x ${backupDir}/*.sh && ${backupDir}/bootstrap.sh` final ssh, the success block) **unchanged** — D-06 mandates always-overwrite for `*.sh` and D-07 leaves `bootstrap.sh` re-run as-is.

Update the header JSDoc: replace "The script is fully idempotent — running it again will overwrite scripts and re-run bootstrap.sh, which is itself idempotent." with a two-sentence note that on re-run `backup.env` is preserved by default and `--rotate-env` forces a fresh upload. One sentence, no marketing.
  </action>
  <verify>
    <automated>npx tsc --noEmit scripts/bootstrap-droplet.ts && grep -c "rotate-env" scripts/bootstrap-droplet.ts | awk '$1 >= 3 { exit 0 } { exit 1 }'</automated>
  </verify>
  <done>Script type-checks. `--rotate-env` token appears in ≥3 places (flag parse, gate hint, header JSDoc). Re-running `bootstrap-droplet` against a droplet with an existing `backup.env` without `--rotate-env` and without `GITHUB_TOKEN` set runs to completion without error and prints the preserve-line. (Live-droplet verification is owned by plan 05-02 Group 2 — this `done` is the static contract.)</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Operator shell → droplet `backup.env` | Operator-controlled `GITHUB_TOKEN` is written to a file the droplet sources at backup time; any shell-injection char in the token would corrupt the env file. |
| Local TS → remote droplet over SSH | SSH transport must succeed for the probe to be authoritative; a misclassified transport failure as "absent" would let a network blip overwrite the active token. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-05-01 | Tampering | `backup.env` on droplet | mitigate | Skip-by-default (D-01); explicit `--rotate-env` opt-in (D-02); existing token-shape regex in `writeBackupEnv` unchanged. |
| T-05-02 | Information Disclosure | local tmp `backup.env` containing PAT | mitigate (existing) | `fs.mkdtempSync` + mode 0600 (already in `writeBackupEnv`); `fs.rmSync` in `finally` regardless of upload success. |
| T-05-03 | Repudiation | "did the token survive the re-run?" | mitigate | D-04 explicit skip-log line; operator can verify in script stdout. |
| T-05-04 | Denial of Service | SSH transport blip silently overwrites token | mitigate | Probe sentinel check (`present`/`absent`); any other response (including a thrown exception from `runCapture`) bails loudly. |
</threat_model>

<verification>
After this plan ships, plan 05-02 wires the live-droplet end-to-end verification (`scripts/verify/phase-5.ts` Group 2 captures `sha256sum` before/after the re-run). This plan's `<done>` is the type-check + static-grep contract; it does not own the live assertion.
</verification>

<success_criteria>
- `npx tsc --noEmit scripts/bootstrap-droplet.ts` exits 0.
- `--rotate-env` is recognized; passing it with `GITHUB_TOKEN` unset bails with a clear hint.
- Re-running against an already-bootstrapped droplet without `--rotate-env` and without `GITHUB_TOKEN` set completes without error and prints the preserve-line.
- The pre-existing token-shape validation in `writeBackupEnv` is untouched (operator can `git diff` and see no edits to that function body).
</success_criteria>

<output>
After completion, create `.planning/phases/05-teardown/05-01-SUMMARY.md` recording: lines changed in `scripts/bootstrap-droplet.ts`, the probe sentinel value chosen (should be exactly `"present"` / `"absent"`), and any deviations from the rationale.
</output>
