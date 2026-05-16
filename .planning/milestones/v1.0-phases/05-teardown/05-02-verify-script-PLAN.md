---
phase: 05-teardown
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/verify/phase-5.ts
  - package.json
  - README.md
autonomous: true
requirements:
  - TEARDOWN-01

must_haves:
  truths:
    - "Operator can run npm run verify:phase-5 and get exit 0 iff all four (or five, if listener present) assertion groups pass"
    - "Group 2 enforces sha256 + mtime + mode equality of backup.env across a bootstrap re-run (D-12.2)"
    - "Group 3 enforces exactly-1 # github-backup-managed line in crontab before and after re-run (D-12.3)"
    - "Group 4 (--rotate-env round-trip) is env-gated on GITHUB_TOKEN and skips with a log line when unset"
    - "Group 5 (listener survival) probes for the github-backup-webhook unit; asserts is-active before+after on probe-success; skips with a log line otherwise"
    - "Verify script bails fast on first violated invariant with the assertion name"
    - "README operator section explains the re-run safety contract and how to rotate the token deliberately"
  artifacts:
    - path: "scripts/verify/phase-5.ts"
      provides: "Five assertion groups: pre-conditions, backup.env preservation, cron-marker invariant, --rotate-env round-trip (env-gated), listener-survival (probe-gated)"
      min_lines: 150
    - path: "package.json"
      provides: "verify:phase-5 npm script"
      contains: "verify:phase-5"
    - path: "README.md"
      provides: "Lifecycle subsection — bootstrap re-run is safe; --rotate-env opt-in; manual DO teardown link"
      contains: "Lifecycle"
  key_links:
    - from: "scripts/verify/phase-5.ts"
      to: "scripts/lib/{ssh,doctl,config}.ts"
      via: "import"
      pattern: "from \"\\.\\./lib/(ssh|doctl|config)\""
    - from: "scripts/verify/phase-5.ts"
      to: "scripts/bootstrap-droplet.ts (via spawnSync npm)"
      via: "execSync running `npm run bootstrap-droplet` (and `-- --rotate-env`) as a child process"
      pattern: "npm run bootstrap-droplet"
    - from: "scripts/verify/phase-5.ts"
      to: "droplet/install-cron.sh cron marker"
      via: "ssh crontab -l | grep -c"
      pattern: "github-backup-managed"
---

<objective>
Implement `scripts/verify/phase-5.ts` per D-11 + D-12 (groups 1–4 from CONTEXT), add a fifth probe-gated group for Phase 3 webhook-listener survival (CONTEXT D-Discretion last bullet), wire `verify:phase-5` in `package.json`, and add a short Lifecycle subsection to `README.md` (D-15). Output: an operator can run `npm run verify:phase-5` against a freshly-bootstrapped droplet, re-run bootstrap inside the script, and prove TEARDOWN-01 SC#1–4 hold without human inspection.

Purpose: TEARDOWN-01 SC#1–4 — provable in one command; non-destructive by default; rotation path covered when `GITHUB_TOKEN` is set.
Output: new `scripts/verify/phase-5.ts`, edited `package.json`, edited `README.md`.
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
@.planning/phases/01-verify-pipeline/01-CONTEXT.md
@scripts/verify/phase-1.ts
@scripts/lib/ssh.ts
@scripts/lib/doctl.ts
@scripts/lib/config.ts
@droplet/install-cron.sh
@package.json
@README.md

<interfaces>
<!-- Reused verbatim from scripts/lib (Phase 1). -->
import { loadConfig, loadDropletInfo, bail, type Config, type DropletInfo } from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";
import { doctlJson, first } from "../lib/doctl";

<!-- Phase 1 verify script's local helpers (copy-paste OK per CONTEXT D-Discretion bullet 3 —
     the SSH-capture helper is duplicated in phase-1.ts; one more copy is acceptable;
     extraction to scripts/lib/ssh.ts is explicitly deferred). -->
function assert(cond: boolean, msg: string): void;          // ✓/✗ + exit 1
function sshCapture(ip: string, user: string, key: string, cmd: string): string;  // single-quote-wrapped ssh
function sshExitsZero(ip: string, user: string, key: string, cmd: string): boolean; // exit 255 throws

<!-- Cron marker (droplet/install-cron.sh line 34). -->
const CRON_MARKER = "# github-backup-managed";
const REMOTE_DIR  = "/opt/github-backups";

<!-- Phase 3 listener unit name (CONTEXT 03-webhook D-Listener). Probe-gated; absent on a
     pre-Phase-3 droplet, so the verify must tolerate "unit not installed". -->
const LISTENER_UNIT = "github-backup-webhook.service";
</interfaces>
</context>

<rationale>
**Why mirror phase-1.ts's style (D-11):** Operators read both scripts back-to-back during a phase rollover. Identical `assert(cond, msg)` shape, identical group-header lines (`— Group N: <name> —`), identical fail-fast posture removes cognitive load.

**Why Group 4 is env-gated, not skipped (D-12.4):** Operators who run `verify:phase-5` in CI without `GITHUB_TOKEN` exported still get groups 1–3 + 5 verified. Hard-skipping with no log would silently weaken the suite. The log line names what was skipped and why; the operator can decide.

**Why Group 5 is probe-gated, not env-gated:** Phase 3 (webhook listener) is being planned in parallel. On a droplet that predates Phase 3, the unit file does not exist and `systemctl is-active` would exit non-zero — which would incorrectly fail Group 5. Probe `systemctl list-unit-files github-backup-webhook.service` first; only assert survival when the unit is installed. Once Phase 3 ships and the droplet is re-bootstrapped, Group 5 activates automatically without a verify-script change.

**Why driving the re-run from inside the verify script (D-12.2 + D-12.4):** Capturing the `sha256sum` BEFORE the re-run and AFTER must be the same single script invocation — separating it into "operator runs bootstrap, then verify" gives the operator an opportunity to mutate `backup.env` between the two captures. `spawnSync("npm", ["run", "bootstrap-droplet"])` (and `…, ["run", "bootstrap-droplet", "--", "--rotate-env"]`) keeps the contract sealed inside one process. On non-zero exit of the child, the assertion fails with the child's stderr surfaced.

**Why D-12 group 4 "bash -n + sourced copy" parsing check is skipped (D-Discretion bullet 1):** `gh auth status` exits 0 only when `backup.env` parsed cleanly and produced a usable token in droplet env, which is a strictly stronger end-to-end signal than `bash -n`. Reject the parallel `bash -n` check as redundant work.

**Why `--rotate-env` is the flag name (D-Discretion bullet 2):** "Rotate env" matches the operator's mental model (PAT rotation) and pairs naturally with the skip-log "use --rotate-env to overwrite". `--overwrite-env` is mechanism-first; `--reset-token` is too narrow (the flag also rewrites `cronSchedule`).

**Why ROADMAP SC#4 (Caddy site config + LE certs preserved) has no dedicated group:** CONTEXT scope ("Out of scope: Webhook listener idempotency — Phase 6 owns the systemd unit reload semantics; this phase only commits to 'do not regress whatever Phase 6 lands'") subsumes Caddy + LE under the same "Phase 3 owns the install + idempotency contract" boundary. Phase 5 verify covers SC#4 transitively via Group 5: if Phase 3's bootstrap step is correctly idempotent (its own verify proves), then re-running `bootstrap-droplet` cannot break it. A dedicated Caddy probe here would duplicate Phase 3's verify scope. If a regression surfaces in practice, add a Group 6 probe (`systemctl is-active caddy`, `caddy validate`) in a follow-up — not now.
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Implement scripts/verify/phase-5.ts (groups 1–5, fail-fast)</name>
  <files>scripts/verify/phase-5.ts</files>
  <action>
Create `scripts/verify/phase-5.ts`. Copy the assert/sshCapture/sshExitsZero helpers from `scripts/verify/phase-1.ts` verbatim (Rule 11 codebase convention; CONTEXT D-Discretion bullet 3 explicitly approves one more copy). Top-level imports and constants mirror phase-1.ts.

Header JSDoc must state: "Phase 5 verification (TEARDOWN-01 / D-11 / D-12 + listener-survival Group 5). Mostly non-destructive: Group 4 mutates `backup.env` on the droplet only if `GITHUB_TOKEN` is set in the verify script's environment. Group 5 is a no-op if the Phase 3 webhook unit is not installed. Assumes `verify:phase-1` has previously passed (CONTEXT D-14)."

Flow:

1. `loadConfig()`, `loadDropletInfo()`, destructure `ip`, `user`, `keyPath`, `backupDir`. Bail if any missing.

**Group 1 — Pre-conditions (mirrors D-12.1):**
- `doctlJson` against `compute droplet get <id> -o json` → assert `status === "active"`.
- `sshCapture(ip,user,keyPath,"stat -c '%a %n' " + backupDir + "/backup.env")` → assert mode field is exactly `600`.
- `sshCapture(...,"crontab -l 2>/dev/null | grep -v '^#' | grep -c " + JSON.stringify(CRON_MARKER) + " || true")` — note the `grep -v '^#'` per CONTEXT D-Discretion grep-gate hygiene call-out — assert the trimmed integer equals `1`. (The plan-checker's "self-invalidating grep gate" hazard does not apply here because the marker is appended to the cron _line_, not on its own comment line, but the `-v '^#'` defense is cheap insurance.)

**Group 2 — backup.env preservation (D-12.2):**
- `H1 = sshCapture(...,"sha256sum " + backupDir + "/backup.env | awk '{print $1}'")`.
- `M1 = sshCapture(...,"stat -c %Y " + backupDir + "/backup.env")` (mtime epoch).
- Run a child process: `spawnSync("npm", ["run", "bootstrap-droplet"], { stdio: "inherit" })` — DO NOT pass `GITHUB_TOKEN` even if set in the parent env (use `{ env: { ...process.env, GITHUB_TOKEN: "" }, ...}` to force the skip-path, otherwise an env-only `GITHUB_TOKEN` would surprise-rotate). On non-zero exit, fail the assertion `"bootstrap re-run (no --rotate-env) exited cleanly"`.
- `H2 = sshCapture(... sha256sum ...)`, `M2 = sshCapture(... stat -c %Y ...)`.
- `assert(H1 === H2, "backup.env sha256 unchanged across re-run")`.
- `assert(M1 === M2, "backup.env mtime unchanged across re-run")`.
- Re-stat mode: assert it is still `600`.

**Group 3 — Cron-marker invariant (D-12.3):**
- `N2 = sshCapture(... | grep -v '^#' | grep -c ...)` (post-re-run count).
- `assert(N2 === "1", "exactly one # github-backup-managed line in crontab after re-run")` — integer equality, NOT `>= 1`.

**Group 4 — --rotate-env round-trip (D-12.4):**
- If `process.env.GITHUB_TOKEN` is empty/unset: `console.log("⚠ skipping --rotate-env round-trip (GITHUB_TOKEN unset)")` and continue. (Skip — not assert false — per CONTEXT.)
- Else: `spawnSync("npm", ["run", "bootstrap-droplet", "--", "--rotate-env"], { stdio: "inherit" })`. On non-zero exit, fail `"--rotate-env bootstrap exited cleanly"`.
- Assert `backup.env` exists on droplet (`ssh test -f`).
- Re-stat mode: assert it is still `600`.
- `sshExitsZero(..., "gh auth status")` must be true — proves the env file parsed cleanly AND the token in it works.

**Group 5 — Listener survival (probe-gated, CONTEXT D-Discretion bullet 4):**
- `const installed = sshExitsZero(ip, user, keyPath, "test -f /etc/systemd/system/" + LISTENER_UNIT + " -o -f /lib/systemd/system/" + LISTENER_UNIT + "")`.
- If `!installed`: `console.log("⚠ skipping listener-survival (Phase 3 webhook unit not installed)")` and continue.
- Else: capture `is-active` state BEFORE Group 2's re-run ideally; for simplicity (and because Phase 5 lands first per CONTEXT D-Discretion ordering), capture AFTER all prior re-runs: `sshExitsZero(..., "systemctl is-active --quiet " + LISTENER_UNIT)`. If we want the before+after pair, restructure: probe + capture-active BEFORE Group 2, then re-assert AFTER Group 4. Keep the two-pass structure to honor SC#3 ("listener restarts cleanly") — a listener that died during Group 2 and never came back must fail Group 5.

  Implementation pattern:

  ```typescript
  // — at Group 1 end, capture initial state
  const listenerInstalled = sshExitsZero(ip, user, keyPath,
    `test -f /etc/systemd/system/${LISTENER_UNIT} -o -f /lib/systemd/system/${LISTENER_UNIT}`);
  let listenerActiveBefore = false;
  if (listenerInstalled) {
    listenerActiveBefore = sshExitsZero(ip, user, keyPath, `systemctl is-active --quiet ${LISTENER_UNIT}`);
  }

  // … Groups 2, 3, 4 run …

  // — Group 5 — Listener survival
  if (!listenerInstalled) {
    console.log("⚠ skipping listener-survival (Phase 3 webhook unit not installed)");
  } else {
    assert(listenerActiveBefore, `${LISTENER_UNIT} is-active before re-run`);
    const after = sshExitsZero(ip, user, keyPath, `systemctl is-active --quiet ${LISTENER_UNIT}`);
    assert(after, `${LISTENER_UNIT} is-active after re-run (listener survived bootstrap re-run)`);
  }
  ```

Final line: `console.log("\n✓ verify:phase-5 — all assertions passed.")`.

Bail-on-error: any thrown `Error` from `runCapture` / `spawnSync` returning a non-zero `r.signal` should propagate; do NOT wrap in try/catch and convert to assert false — the fail-loud rule trumps prettier output.
  </action>
  <verify>
    <automated>npx tsc --noEmit scripts/verify/phase-5.ts</automated>
  </verify>
  <done>Script type-checks. Five group headers present in source. `GITHUB_TOKEN: ""` override is present on the Group 2 spawnSync (defends against an env-set token surprise-rotating during the preservation check). `grep -v '^#'` defense present on both crontab counts.</done>
</task>

<task type="auto">
  <name>Task 2: Wire verify:phase-5 in package.json + Lifecycle paragraph in README.md</name>
  <files>package.json, README.md</files>
  <action>
**package.json:** Add one line to `scripts`:

```json
"verify:phase-5": "tsx scripts/verify/phase-5.ts"
```

Place it immediately after the existing `"verify:phase-1"` line so the order matches roadmap order. No other changes to `package.json`.

**README.md:** Insert a new H2 section titled `## Lifecycle` between `## Operation` (ends line 263) and `## Recovery` (line 265). Body must be short — D-15 explicitly says "two-paragraph note", terse, command-reference shaped. Suggested literal content:

```markdown
## Lifecycle

### Re-running bootstrap is safe

`npm run bootstrap-droplet` is idempotent. On a droplet that has already
been bootstrapped, the on-droplet `backup.env` (which holds your
`GITHUB_TOKEN`) is **preserved by default** — re-running after editing
`droplet/*.sh` will ship the script changes without touching your token.
A line like `▸ /opt/github-backups/backup.env exists on droplet —
preserving` confirms the skip.

To deliberately rotate your PAT or change `cronSchedule` /
`githubUserOrOrg` in `config.json`:

```bash
GITHUB_TOKEN=<new_pat> npm run bootstrap-droplet -- --rotate-env
```

`--rotate-env` requires `GITHUB_TOKEN` to be set.

### Teardown

Manual: delete the droplet from the
[DigitalOcean control panel](https://cloud.digitalocean.com/droplets),
then remove the local `.droplet.json`. There is no `npm run destroy-droplet`
command — single-operator scale, single command at the DO dashboard.

### Verify idempotency

```bash
npm run verify:phase-5
```

Asserts `backup.env` is preserved across a re-run, exactly one
`# github-backup-managed` cron line exists before and after, and (if
`GITHUB_TOKEN` is set) the `--rotate-env` round-trip leaves the file
parseable. Non-destructive by default.

---
```

Do NOT touch any other README section. Preserve the trailing `---` separator before `## Recovery`.
  </action>
  <verify>
    <automated>node -e "const j=require('./package.json'); if(!j.scripts['verify:phase-5']) process.exit(1)" && grep -c "^## Lifecycle$" README.md | grep -q '^1$'</automated>
  </verify>
  <done>`npm run verify:phase-5` exists as a `tsx` script in package.json. README has exactly one `## Lifecycle` heading. The three subsections (Re-running bootstrap is safe, Teardown, Verify idempotency) are present.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Verify script env → child `npm run bootstrap-droplet` | A surprise-set `GITHUB_TOKEN` in the parent env would silently make the "no --rotate-env" re-run also rotate the token, defeating Group 2. |
| Verify script output → operator confidence | A passing run must mean every invariant held; silently-skipped groups must be announced. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-05-05 | Tampering | Group 2 preservation check | mitigate | Force `GITHUB_TOKEN: ""` in the child env for the no-rotate re-run; the upload-path bail in plan 01 then refuses to write — preserving the file as required. |
| T-05-06 | Information Disclosure | verify script logs | accept | Script prints assertion names, not file contents; no PAT material reaches stdout. |
| T-05-07 | Repudiation | "did Group 4 run?" | mitigate | Skip path emits a `⚠ skipping ... (reason)` line; operator can `grep ⚠` the verify output. |
| T-05-08 | Denial of Service | listener unit absent fails Group 5 | mitigate | Probe `test -f .../{listener-unit}` first; skip-with-log when absent. |
</threat_model>

<verification>
End-to-end on a live droplet (Phase 1 must have shipped first per D-14):

1. `npm run verify:phase-5` against an already-bootstrapped droplet with `GITHUB_TOKEN` unset in shell → exit 0; Group 4 skipped with log; Group 5 skipped with log if Phase 3 not yet shipped.
2. Same, with `GITHUB_TOKEN` exported → exit 0; Group 4 round-trip runs; final `backup.env` reflects the rotated PAT (`gh auth status` exit 0 confirms).
3. Manually mutate the on-droplet cron to add a second `# github-backup-managed` line, then re-run verify → Group 3 fails fast with the named assertion.
</verification>

<success_criteria>
- `npm run verify:phase-5` exits 0 on a freshly-bootstrapped droplet.
- Cron-line count is `1` exactly before AND after a `bootstrap-droplet` re-run.
- `backup.env` sha256 + mtime + mode are unchanged across a re-run without `--rotate-env`.
- With `GITHUB_TOKEN` set, `--rotate-env` round-trip ends with a parseable `backup.env` that `gh auth status` accepts.
- Listener-survival group activates iff `/etc/systemd/system/github-backup-webhook.service` (or `/lib/systemd/system/...`) exists; otherwise skips with a log.
- README has a Lifecycle section that explains the re-run safety contract in ≤30 lines.
</success_criteria>

<output>
After completion, create `.planning/phases/05-teardown/05-02-SUMMARY.md` recording: total lines added to each file, any deviations from the literal README markdown above (verbatim or paraphrased), and one paragraph on whether Group 5 activated during the live verify (Phase 3 shipped first vs Phase 5 shipped first).
</output>
