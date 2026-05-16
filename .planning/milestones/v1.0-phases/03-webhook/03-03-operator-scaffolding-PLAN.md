---
phase: 03-webhook
plan: 03
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - scripts/lib/config.ts
  - scripts/create-droplet.ts
  - scripts/bootstrap-droplet.ts
  - scripts/register-webhooks.ts
  - package.json
  - config.example.json

autonomous: true
requirements:
  - WEBHOOK-01
  - PROV-01
  - PROV-02
  - BACKUP-03

must_haves:
  truths:
    - "Config interface gains `webhookHostname: string` (required, validated as FQDN-shape) and `webhookTestRepo?: string` (optional `<owner>/<repo>` shape, validated only when set; D-08 / D-25 group 4)."
    - "`scripts/create-droplet.ts` adds idempotent inbound rules for TCP/80 + TCP/443 from `0.0.0.0/0` to the cloud firewall, BOTH on initial firewall creation AND when the firewall already exists (D-23). PROV-01 idempotency invariant kept — second `npm run create-droplet` is a no-op."
    - "`scripts/bootstrap-droplet.ts` generates a 64-hex-char webhook secret via `crypto.randomBytes(32).toString('hex')` on first bootstrap, persists into the generated backup.env as `WEBHOOK_SECRET=<hex>` and `WEBHOOK_HOSTNAME=<cfg.webhookHostname>`, ECHOES the secret to operator stdout exactly once (D-07), AND uploads the three non-`.sh` droplet files (webhook-listener.js, Caddyfile.template, github-backup-webhook.service)."
    - "Re-running bootstrap does NOT regenerate the webhook secret — secret is read from the existing remote backup.env over SSH and re-inserted into the freshly-generated backup.env (Phase 5 idempotency posture mirrored from GITHUB_TOKEN: existing remote secret wins unless `--rotate-webhook-secret` is passed)."
    - "`--rotate-webhook-secret` CLI flag on `bootstrap-droplet` regenerates the secret, echoes it once, and prints a reminder that the operator must re-register webhooks (or run `register-webhooks --update`)."
    - "New script `scripts/register-webhooks.ts` (`npm run register-webhooks`): reads `WEBHOOK_SECRET` from the droplet's backup.env via SSH (one read, not cached locally); iterates repos of `cfg.githubUserOrOrg` via `gh api`; for each repo idempotently creates a webhook with `events:['push']`, `config: {url: 'https://<webhookHostname>/webhook/github', secret, content_type: 'json', insecure_ssl: '0'}`. Prints `<N> registered, <M> already present, <K> failed` summary (D-21)."
    - "`--update` flag on register-webhooks PATCHes existing webhooks with the current secret (use after `--rotate-webhook-secret`); without `--update`, existing webhooks are left alone (D-22)."
    - "`package.json` adds `register-webhooks` script wired to `tsx scripts/register-webhooks.ts`."
    - "`config.example.json` documents `webhookHostname` (required) and `webhookTestRepo` (optional)."
  artifacts:
    - path: "scripts/lib/config.ts"
      provides: "Config gains webhookHostname (required) + webhookTestRepo (optional). loadConfig validates FQDN shape + owner/repo shape."
      contains: "webhookHostname"
    - path: "scripts/create-droplet.ts"
      provides: "Firewall create/update path adds TCP/80 + TCP/443 from 0.0.0.0/0 with `doctl compute firewall add-rules` on existing firewalls. PROV-01 idempotency preserved."
      contains: "443"
    - path: "scripts/bootstrap-droplet.ts"
      provides: "Generates / preserves WEBHOOK_SECRET, writes it + WEBHOOK_HOSTNAME into backup.env, uploads non-.sh files. Honors --rotate-webhook-secret."
      contains: "WEBHOOK_SECRET"
    - path: "scripts/register-webhooks.ts"
      provides: "Operator-side TS command to idempotently create/update GitHub webhooks for every repo of cfg.githubUserOrOrg."
      min_lines: 80
      contains: "/webhook/github"
    - path: "package.json"
      provides: "Adds `register-webhooks` npm script entry."
      contains: "register-webhooks"
    - path: "config.example.json"
      provides: "Documents webhookHostname (required) and webhookTestRepo (optional)."
      contains: "webhookHostname"
  key_links:
    - from: "scripts/bootstrap-droplet.ts"
      to: "scripts/lib/config.ts"
      via: "loadConfig import — reads new webhookHostname field"
      pattern: "webhookHostname"
    - from: "scripts/register-webhooks.ts"
      to: "scripts/lib/ssh.ts"
      via: "sshFlags + runCapture for reading remote backup.env"
      pattern: "from \"\\./lib/ssh\""
    - from: "scripts/register-webhooks.ts"
      to: "gh api"
      via: "execSync via runCapture"
      pattern: "gh api"
---

<objective>
Wire the operator-side TS surface around the droplet listener (plan 02): config-type fields (D-08/D-25), firewall rules (D-23), bootstrap secret generation + persistence + file uploads (D-07/D-19/D-22), the `npm run register-webhooks` command (D-21), npm scripts, and example config.

This plan is the "operator-facing" half — anything an operator types or sees runs through here. After this plan: `npm run create-droplet` opens 80+443, `npm run bootstrap-droplet` generates+echoes the secret and ships every droplet/ file, `npm run register-webhooks` registers webhooks on GitHub.

No droplet-side runtime changes — those are plan 02. No verification — that's plan 04.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/03-webhook/03-CONTEXT.md
@scripts/lib/config.ts
@scripts/lib/ssh.ts
@scripts/lib/doctl.ts
@scripts/create-droplet.ts
@scripts/bootstrap-droplet.ts
@package.json
@config.example.json

<interfaces>
<!-- Config interface (after this plan):
export interface Config {
  // ... all existing fields unchanged ...
  webhookHostname: string;       // e.g. "backup.example.com" — required, FQDN-shape
  webhookTestRepo?: string;      // e.g. "sumin/dotfiles" — optional, used only by verify:phase-3
}

REQUIRED_FIELDS additions: "webhookHostname"
SHELL_SAFE_FIELDS additions: "webhookHostname" (FQDN matches the existing regex)
Inline validation (post-SHELL_SAFE loop):
  - webhookHostname matches /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
    (LDH labels separated by dots, at least one dot — no IPs, no underscores, no trailing dot).
  - webhookTestRepo (when defined) matches /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
-->

<!-- backup.env (after this plan):
GITHUB_TOKEN=<unchanged>
GITHUB_USER_OR_ORG=<unchanged>
BACKUP_DIR=<unchanged>
CRON_SCHEDULE="<unchanged>"
WEBHOOK_SECRET=<new — 64 hex chars from crypto.randomBytes(32).toString('hex')>
WEBHOOK_HOSTNAME=<new — cfg.webhookHostname, no quotes (FQDN is shell-safe)>
WEBHOOK_LISTEN_PORT=9100        # optional, listener has its own default
WEBHOOK_STATE_DIR=/var/lib/github-backup    # optional, listener has its own default

CRITICAL: webhook secret persistence on re-bootstrap (Phase 5 idempotency posture):
  Default path: SSH to droplet, `grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env || true`,
    if found → preserve the value, do NOT regenerate.
    if missing → generate fresh via crypto.randomBytes, echo to operator stdout.
  --rotate-webhook-secret flag path: always regenerate, echo, print "remember to re-register".
-->

<!-- create-droplet firewall expansion (D-23):
  Firewall CREATE branch (today: lines 152-160): add two more --inbound-rules:
    --inbound-rules "protocol:tcp,ports:80,sources:addresses:0.0.0.0/0,::/0"
    --inbound-rules "protocol:tcp,ports:443,sources:addresses:0.0.0.0/0,::/0"
  Firewall EXISTING branch (today: lines 142-148): currently exits early. After this plan, it must:
    1. doctl compute firewall get <existing.id> --output json
    2. Compute the set of currently-present inbound rules (protocol+port+sources)
    3. For each of the new rules (22 from cfg.allowedSSHCidr, 80 from 0.0.0.0/0, 443 from 0.0.0.0/0):
       if absent → `doctl compute firewall add-rules <id> --inbound-rules ...`
       if present → skip with log line
    4. Returns the existing firewall id, same as before.
  PROV-01 invariant: a second `npm run create-droplet` against a droplet whose firewall
    already has all three rules must be entirely no-op (no `add-rules` calls, no errors).
-->

<!-- register-webhooks CLI shape:
  npm run register-webhooks                     # idempotent create
  npm run register-webhooks -- --update         # also patch existing webhooks with current secret
  npm run register-webhooks -- --dry-run        # list what WOULD happen, no API calls
-->
</interfaces>
</context>

<rationale>
**Why webhookHostname is REQUIRED (D-04):** GitHub rejects insecure webhook URLs. There is no fallback to HTTP / self-signed. If the operator hasn't pointed a domain at the droplet IP, the listener cannot be installed. Failing loud at `loadConfig` time means `bootstrap-droplet` exits before SCP'ing anything — operator sees the actionable error without waiting for ACME failure on the droplet 30 seconds later.

**Why per-source secret stays singular at v1:** PROJECT.md's "Webhook listener ships before multi-source" decision means there's exactly one source today (cfg.githubUserOrOrg). Per-source naming (`WEBHOOK_SECRET_<SOURCE_UPPER>`) is correct shape for Phase 6 but premature here — Phase 6 will migrate `WEBHOOK_SECRET` → `WEBHOOK_SECRET_<UPPER>` when `cfg.sources[]` lands. Keeping the v1 name simple keeps plan 02's listener simple.

**Why crypto.randomBytes(32).toString('hex') (D-07):** 64 hex chars = 256 bits of entropy. Matches GitHub's secret-length recommendation. Shell-safe by construction (hex alphabet). Same node built-in module the listener already imports (zero new dependencies).

**Why preserve-on-re-bootstrap with --rotate-webhook-secret opt-in (D-09 ↔ Phase 5 idempotency):** Phase 5 needs `bootstrap-droplet` to be re-runnable without breaking webhook auth. Regenerating the secret on every re-run would break every registered GitHub webhook (operator would need to re-register all of them — operationally hostile). Preserve-by-default + opt-in rotation matches Phase 5's posture for GITHUB_TOKEN preservation.

**Why register-webhooks reads the secret over SSH instead of from local state (D-21):** Single source of truth is the droplet's backup.env. Local state files mean drift — operator runs `--rotate-webhook-secret`, then a local `register-webhooks --update` reads the OLD local cache, registers the WRONG secret, every webhook breaks silently. Read-over-SSH means rotation is atomic.

**Why open 80 + 443 to `0.0.0.0/0` (D-23):** GitHub's webhook source IPs drift. Maintaining an allowlist means re-running `create-droplet` to pull `gh api meta` every few weeks — kills idempotency. HMAC is the real security gate at single-operator scale (D-domain). Port 80 is needed for Let's Encrypt's HTTP-01 challenge (Caddy uses HTTP-01 by default). Both ports from `0.0.0.0/0` is the simplest correct posture.

**Why existing-firewall path needs new logic (D-23 vs Phase 1 PROV-01):** Phase 1's create-droplet exits early when the firewall exists (line 142-148). That worked when the firewall had only one inbound rule. With three rules, an existing firewall that's MISSING the new rules (e.g., a Phase 1 droplet upgraded to Phase 3) needs them added — that's the "migration" path D-24 documents. The check is: list current rules, compare against desired, `add-rules` only the missing ones. Second `create-droplet` with all rules present is no-op (idempotent — PROV-01).

**Why register-webhooks is operator-side TS (D-21):** It needs the operator's `gh auth login` scopes (`admin:repo_hook`). The droplet's GITHUB_TOKEN is scoped for `repo` (read) only — granting it `admin:repo_hook` would broaden the blast radius of a droplet compromise. Local `gh` auth is the right place for hook registration.

**Why a `--dry-run` flag (D-21 sub):** Operators with org-scale repo lists may want to preview before making 50+ API calls. Cheap to add; defensible default-off behavior. Used by verify:phase-3 (plan 04) for the "registration is idempotent" assertion path.

**Why `WEBHOOK_LISTEN_PORT` + `WEBHOOK_STATE_DIR` are in backup.env (defaults via listener):** Future operators may need to change them (e.g., bind to a different port if 9100 conflicts with something else on the droplet). Keeping the contract in backup.env means systemd's EnvironmentFile= picks them up — no listener.js code change needed. Defaults are baked into the listener so missing entries are fine.

**Why config.example.json gets new fields:** Operators copy `config.example.json` → `config.json` per `scripts/lib/config.ts` bail message. Without `webhookHostname` in the example, fresh installs would fail at first `loadConfig()` with no obvious hint. Phase 1 precedent: every required config field is in the example.

**Why bootstrap-droplet.ts uploads non-`.sh` files now:** Plan 02's bootstrap.sh defensively bails if `webhook-listener.js` / `Caddyfile.template` / `github-backup-webhook.service` are missing in `${BACKUP_DIR}`. The current uploader filter `d.name.endsWith(".sh")` (line 116) excludes those three. Expanding the filter to a fixed allow-list (`.sh`, `.js`, `.template`, `.service`) is the minimum change.
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Extend scripts/lib/config.ts with webhookHostname (required) + webhookTestRepo (optional)</name>
  <files>scripts/lib/config.ts</files>
  <read_first>
    - scripts/lib/config.ts (full current file)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-04 for required-ness, D-08 for shape constraint, D-25 group 4 for webhookTestRepo)
    - .planning/phases/04-restore/04-01-restore-helper-PLAN.md task 1 (where `restoreTestRepo` was added — same posture)
  </read_first>
  <acceptance_criteria>
    - `Config` interface contains `webhookHostname: string;` (NOT optional).
    - `Config` interface contains `webhookTestRepo?: string;` (optional).
    - `REQUIRED_FIELDS` array includes `"webhookHostname"`.
    - `SHELL_SAFE_FIELDS` array includes `"webhookHostname"` (FQDN matches existing `[A-Za-z0-9._/~@:-]+` regex).
    - `loadConfig()` includes a NEW post-SHELL_SAFE inline check that bails with a loud message if `cfg.webhookHostname` does NOT match the FQDN regex `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/`. (Lowercase only — DNS is case-insensitive but Caddy / LE prefer lower; trailing-dot rejected.)
    - `loadConfig()` includes a NEW gated check: if `cfg.webhookTestRepo !== undefined`, assert it matches `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`; bail loud on mismatch. Mirror style of the planned `restoreTestRepo` validation (plan 04-01 task 1).
    - `tsc --noEmit scripts/lib/config.ts` (or whole-project equivalent) returns 0.
  </acceptance_criteria>
  <action>
1. Edit `scripts/lib/config.ts`:
   - In the `Config` interface, after `tags?: string[];`, add:
     ```typescript
     webhookHostname: string;       // FQDN that operator pointed at droplet IP (D-04)
     webhookTestRepo?: string;      // "owner/repo" — consumed only by verify:phase-3 (D-25)
     ```
     If `restoreTestRepo?: string` is already in the interface from the restore plan 04-01, keep it; append the two webhook fields below it.
   - In `REQUIRED_FIELDS`, append `"webhookHostname"`.
   - In `SHELL_SAFE_FIELDS`, append `"webhookHostname"`.
   - After the existing SHELL_SAFE loop (line ~112-121), AND before the cron check, add:
     ```typescript
     const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
     if (!FQDN_RE.test(cfg.webhookHostname)) {
       bail(
         `config.json field "webhookHostname" is not a valid FQDN ` +
           `(lowercase letters, digits, dashes; at least one dot; no trailing dot). ` +
           `Got: ${JSON.stringify(cfg.webhookHostname)}`
       );
     }
     if (cfg.webhookTestRepo !== undefined) {
       const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
       if (!OWNER_REPO_RE.test(cfg.webhookTestRepo)) {
         bail(
           `config.json field "webhookTestRepo" must be "<owner>/<repo>" shape. ` +
             `Got: ${JSON.stringify(cfg.webhookTestRepo)}`
         );
       }
     }
     ```

2. Verify: `npx tsc --noEmit` exits 0.
  </action>
</task>

<task type="auto">
  <name>Task 2: Extend scripts/create-droplet.ts firewall logic with idempotent 80+443 rules</name>
  <files>scripts/create-droplet.ts</files>
  <read_first>
    - scripts/create-droplet.ts (lines 120-200 — full firewall block)
    - scripts/lib/doctl.ts (doctlJson + first helpers)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-23/D-24 — exact rule shape, idempotency posture)
  </read_first>
  <acceptance_criteria>
    - The firewall CREATE branch (currently lines 152-160) includes two NEW `--inbound-rules` flags for TCP/80 and TCP/443 from `0.0.0.0/0,::/0`.
    - The firewall EXISTING branch (currently lines 142-148) no longer exits early. It:
      1. Fetches the existing firewall via `doctl compute firewall get <id> --output json`.
      2. Builds a list of expected rules: SSH/22 from cfg.allowedSSHCidr, TCP/80 + TCP/443 from 0.0.0.0/0.
      3. For each expected rule absent from the firewall, calls `doctl compute firewall add-rules <id> --inbound-rules "..."`.
      4. Logs `   Rule already present: tcp/<port>` or `   Adding rule: tcp/<port> from <sources>` per rule.
      5. Returns the existing firewall id (preserves Phase 1 attach-droplet flow).
    - PROV-01 invariant: a hypothetical second `create-droplet` run against a firewall with all three rules present must produce ZERO `add-rules` calls. Verify by counting calls in the executor's head: with all rules present, the for-loop body never executes the `add-rules` branch.
    - `npx tsc --noEmit` exits 0.
  </acceptance_criteria>
  <action>
1. In `scripts/create-droplet.ts`, find the existing `findOrCreateFirewall(cfg)` function (lines ~122-167).

2. EXPAND the CREATE branch (line 152-160 region). Replace the createCmd assembly with:

```typescript
const createCmd = [
  `doctl compute firewall create`,
  `--name "${cfg.firewallName}"`,
  `--inbound-rules "protocol:tcp,ports:22,sources:addresses:${cfg.allowedSSHCidr}"`,
  `--inbound-rules "protocol:tcp,ports:80,sources:addresses:0.0.0.0/0,::/0"`,
  `--inbound-rules "protocol:tcp,ports:443,sources:addresses:0.0.0.0/0,::/0"`,
  `--outbound-rules "protocol:tcp,ports:all,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0"`,
  `--outbound-rules "protocol:udp,ports:all,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0"`,
  `--outbound-rules "protocol:icmp,destinations:addresses:0.0.0.0/0,0:0:0:0:0:0:0:0/0"`,
  `--output json`,
].join(" ");
```

3. REPLACE the EXISTING branch (lines 142-148) with a sync-rules path. New shape:

```typescript
const existing = all.find((fw) => fw.name === cfg.firewallName);
if (existing) {
  console.log(`   Already exists — ID: ${existing.id}. Reconciling inbound rules…`);
  // Define expected rules. Each is (protocol, ports, sourceAddrs[]).
  const expected: Array<{ protocol: "tcp"; ports: string; sources: string }> = [
    { protocol: "tcp", ports: "22",  sources: cfg.allowedSSHCidr },
    { protocol: "tcp", ports: "80",  sources: "0.0.0.0/0,::/0" },
    { protocol: "tcp", ports: "443", sources: "0.0.0.0/0,::/0" },
  ];
  // Fetch current rules.
  interface InboundRule { protocol: string; ports: string; sources: { addresses?: string[] } }
  interface FirewallDetail extends FirewallRecord { inbound_rules?: InboundRule[] }
  const detail = first<FirewallDetail>(
    `doctl compute firewall get ${existing.id} --output json`
  );
  const present = detail.inbound_rules ?? [];
  for (const r of expected) {
    const expectedSources = new Set(r.sources.split(","));
    const match = present.find(
      (p) =>
        p.protocol === r.protocol &&
        p.ports === r.ports &&
        new Set((p.sources?.addresses ?? [])).size > 0 &&
        [...new Set(p.sources!.addresses!)].every((a) => expectedSources.has(a)) &&
        expectedSources.size === new Set(p.sources!.addresses!).size
    );
    if (match) {
      console.log(`   ✓ Rule already present: ${r.protocol}/${r.ports} from ${r.sources}`);
    } else {
      console.log(`   + Adding rule: ${r.protocol}/${r.ports} from ${r.sources}`);
      runCapture(
        `doctl compute firewall add-rules ${existing.id} ` +
          `--inbound-rules "protocol:${r.protocol},ports:${r.ports},sources:addresses:${r.sources}"`
      );
    }
  }
  return existing.id;
}
```

4. Add `runCapture` import if not already imported (it's in `./lib/ssh` per Phase 1 plan 01-01).

5. Verify: `npx tsc --noEmit` exits 0. Mental trace: brand-new droplet → CREATE branch creates firewall with 3 rules; pre-existing droplet missing 80+443 → EXISTING branch adds 2 rules; pre-existing droplet with all 3 → EXISTING branch only logs "already present" 3x (zero side effects).
  </action>
</task>

<task type="auto">
  <name>Task 3: Extend scripts/bootstrap-droplet.ts with webhook secret generation + non-.sh uploads + --rotate-webhook-secret</name>
  <files>scripts/bootstrap-droplet.ts</files>
  <read_first>
    - scripts/bootstrap-droplet.ts (full file)
    - scripts/lib/ssh.ts (runCapture for reading remote env)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-07/D-09/D-19 — exact persistence rules)
  </read_first>
  <acceptance_criteria>
    - `scripts/bootstrap-droplet.ts` parses `--rotate-webhook-secret` from `process.argv` (boolean flag). No other arg parsing changes.
    - The webhook secret is determined by this exact algorithm:
      1. If `--rotate-webhook-secret`: generate fresh via `crypto.randomBytes(32).toString('hex')`. Echo to stdout exactly once with a banner that says it must be re-registered. Skip step 2.
      2. Else: SSH to droplet and `grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env || true`. If a value is returned (after `WEBHOOK_SECRET=` prefix strip), preserve it. If empty (file missing or var absent), generate fresh + echo to stdout.
    - The decision points (`rotate`, `preserve`, `fresh-generate`) each emit a single one-line log so the operator sees which branch ran.
    - `writeBackupEnv` is extended with two new env lines: `WEBHOOK_SECRET=<value>` and `WEBHOOK_HOSTNAME=<cfg.webhookHostname>`. Both are validated to match `^[A-Za-z0-9._-]+$` and FQDN-shape respectively before write (existing pattern of refusing to write unsafe shapes — WR-04 echo).
    - The uploader filter (current line 116: `d.name.endsWith(".sh")`) becomes an allow-list of suffixes: `.sh`, `.js`, `.template`, `.service`. No other filter change.
    - `npx tsc --noEmit` exits 0.
  </acceptance_criteria>
  <action>
1. In `scripts/bootstrap-droplet.ts`, add at the top of imports: `import * as crypto from "crypto";` (or inline `import { randomBytes } from "crypto"`).

2. Modify `writeBackupEnv` signature to accept the resolved webhook secret:
   ```typescript
   function writeBackupEnv(cfg: Config, githubToken: string, webhookSecret: string): string {
   ```
   Add to the validation block: bail loud if `!/^[a-f0-9]{64}$/.test(webhookSecret)` (64 hex chars — generated shape; rejects anything else to prevent injection). Append to `lines`:
   ```typescript
   `WEBHOOK_SECRET=${webhookSecret}`,
   `WEBHOOK_HOSTNAME=${cfg.webhookHostname}`,
   ```
   (No quoting needed: hex secret and FQDN are both shell-safe by their regex.)

3. In `main()`, add early:
   ```typescript
   const rotateWebhook = process.argv.includes("--rotate-webhook-secret");
   ```

4. AFTER `const droplet = loadDropletInfo();` (before `writeBackupEnv` call), add the secret-resolution block:

```typescript
// ── Resolve webhook secret (preserve on re-bootstrap, opt-in rotation) ──
async function resolveWebhookSecret(): Promise<string> {
  if (rotateWebhook) {
    const fresh = crypto.randomBytes(32).toString("hex");
    console.log(`\n🔁  --rotate-webhook-secret: regenerating WEBHOOK_SECRET`);
    console.log(`\n   NEW WEBHOOK SECRET (record this — needed for register-webhooks --update):`);
    console.log(`     ${fresh}`);
    console.log(`\n   Reminder: run \`npm run register-webhooks -- --update\` to push the new secret to GitHub.\n`);
    return fresh;
  }
  // Read remote backup.env over SSH; preserve existing secret if present.
  const cmd =
    `ssh ${require("./lib/ssh").sshFlags(cfg.sshKeyPath)} ` +
    `${cfg.sshUser}@${droplet.ip} ` +
    `'grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env 2>/dev/null || true'`;
  let existing = "";
  try {
    existing = require("./lib/ssh").runCapture(cmd).trim();
  } catch {
    existing = "";
  }
  if (existing.startsWith("WEBHOOK_SECRET=")) {
    const val = existing.slice("WEBHOOK_SECRET=".length).trim();
    if (/^[a-f0-9]{64}$/.test(val)) {
      console.log(`\n🔐  Preserving existing WEBHOOK_SECRET from droplet's backup.env`);
      return val;
    }
    console.log(`\n⚠️   Remote WEBHOOK_SECRET present but malformed (length=${val.length}); regenerating.`);
  }
  const fresh = crypto.randomBytes(32).toString("hex");
  console.log(`\n🆕  Generating fresh WEBHOOK_SECRET (first-run or missing-on-droplet)`);
  console.log(`\n   WEBHOOK SECRET (record this — needed for register-webhooks):`);
  console.log(`     ${fresh}\n`);
  return fresh;
}

const webhookSecret = await resolveWebhookSecret();
```

5. Update the `writeBackupEnv` call site:
   ```typescript
   const envPath = writeBackupEnv(cfg, githubToken, webhookSecret);
   ```

6. Update the file uploader filter (line 116 region). Replace:
   ```typescript
   .filter((d) => d.isFile() && d.name.endsWith(".sh"))
   ```
   with:
   ```typescript
   .filter((d) =>
     d.isFile() &&
     /\.(sh|js|template|service)$/.test(d.name)
   )
   ```

7. Verify: `npx tsc --noEmit` exits 0. Mental trace: first bootstrap → no remote secret → generate+echo. Second bootstrap → remote secret present → preserve, no echo. Second bootstrap with `--rotate-webhook-secret` → regenerate, echo, print re-register reminder.
  </action>
</task>

<task type="auto">
  <name>Task 4: Create scripts/register-webhooks.ts (idempotent webhook registration)</name>
  <files>scripts/register-webhooks.ts</files>
  <read_first>
    - scripts/lib/config.ts (loadConfig + Config type)
    - scripts/lib/ssh.ts (sshFlags, runCapture, runVisible)
    - scripts/bootstrap-droplet.ts (the secret-read SSH pattern from task 3)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-21/D-22 — exact API call shape)
    - droplet/github-backup.sh (lines 95-111 — account-type detection pattern; mirror in TS)
  </read_first>
  <acceptance_criteria>
    - File exists at `scripts/register-webhooks.ts` with `#!/usr/bin/env node` shebang.
    - Parses `--update` and `--dry-run` flags from `process.argv`.
    - Calls `loadConfig()` and `loadDropletInfo()`; bails loud on missing config or droplet.
    - Reads `WEBHOOK_SECRET` from the droplet's `/opt/github-backups/backup.env` over SSH (one read; do NOT store locally). Bail loud if missing.
    - Determines account type for `cfg.githubUserOrOrg` via `gh api /users/<name>` checking `.type` (mirror github-backup.sh logic).
    - Lists all repos via `gh api --paginate /<users|orgs>/<name>/repos?type=all&per_page=100 --jq '.[].full_name'`.
    - For each repo, calls `gh api repos/<owner>/<repo>/hooks --jq '.[] | select(.config.url == "https://<webhookHostname>/webhook/github") | .id'` to find existing matching hooks.
    - Without `--update`:
      - No existing hook → POST to `repos/<owner>/<repo>/hooks` with body `{name:"web", active:true, events:["push"], config:{url, secret, content_type:"json", insecure_ssl:"0"}}`. Increment `registered`.
      - Existing hook → skip; increment `already_present`.
    - With `--update`:
      - No existing hook → POST (same as no-flag path); increment `registered`.
      - Existing hook → PATCH `repos/<owner>/<repo>/hooks/<id>` with `{config:{url, secret, content_type:"json", insecure_ssl:"0"}}`; increment `updated`.
    - With `--dry-run`: print what WOULD happen without making any POST/PATCH calls. Count `would_register` / `would_update`.
    - Final stdout summary one-liner per source: `<registered> registered, <already_present> already present, <updated> updated, <failed> failed` (or dry-run equivalent).
    - Failures (gh api non-zero exit) increment `failed` per repo, log the repo name + stderr snippet, do NOT abort the whole loop.
    - Exit 0 unless `failed > 0`, in which case exit 1.
    - `npx tsc --noEmit` exits 0.
  </acceptance_criteria>
  <action>
1. Create `scripts/register-webhooks.ts`. Concrete skeleton:

```typescript
#!/usr/bin/env node
/**
 * scripts/register-webhooks.ts
 *
 * Idempotently create GitHub webhooks for every repo under cfg.githubUserOrOrg.
 * Reads WEBHOOK_SECRET from the droplet's backup.env over SSH (single source of truth).
 *
 * Usage:
 *   npm run register-webhooks                # create missing webhooks; no-op on existing
 *   npm run register-webhooks -- --update    # also PATCH existing webhooks (post --rotate-webhook-secret)
 *   npm run register-webhooks -- --dry-run   # show what would happen, no API calls
 */
import { loadConfig, loadDropletInfo, bail } from "./lib/config";
import { sshFlags, runCapture } from "./lib/ssh";

interface HookConfig { url: string; }
interface Hook { id: number; config: HookConfig; }
interface GhRepo { full_name: string; }

function gh(args: string): string {
  return runCapture(`gh api ${args}`);
}

function ghIgnoreStderr(args: string): { ok: boolean; stdout: string; stderr: string } {
  try { return { ok: true, stdout: gh(args), stderr: "" }; }
  catch (e: unknown) { return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) }; }
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const dryRun = process.argv.includes("--dry-run");

  const cfg = loadConfig();
  const droplet = loadDropletInfo();
  const url = `https://${cfg.webhookHostname}/webhook/github`;

  // ── Read WEBHOOK_SECRET from droplet ────────────────────────────────────
  const sshCmd =
    `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${droplet.ip} ` +
    `'grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env 2>/dev/null'`;
  let secret = "";
  try {
    const line = runCapture(sshCmd).trim();
    if (line.startsWith("WEBHOOK_SECRET=")) secret = line.slice("WEBHOOK_SECRET=".length).trim();
  } catch (e) {
    bail(
      `Could not read WEBHOOK_SECRET from ${cfg.sshUser}@${droplet.ip}:/opt/github-backups/backup.env. ` +
        `Run \`npm run bootstrap-droplet\` first, or check SSH key access. ` +
        `(${e instanceof Error ? e.message : e})`
    );
  }
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    bail(`Remote WEBHOOK_SECRET malformed (expected 64 hex chars, got len=${secret.length}). Re-bootstrap.`);
  }

  // ── Detect account type + list repos ────────────────────────────────────
  const owner = cfg.githubUserOrOrg;
  let acctType = "User";
  try {
    acctType = gh(`/users/${owner} --jq .type`).trim() || "User";
  } catch { acctType = "User"; }
  const endpoint = acctType === "Organization"
    ? `/orgs/${owner}/repos?type=all&per_page=100`
    : `/users/${owner}/repos?type=all&per_page=100`;

  const fullNames = gh(`--paginate ${endpoint} --jq '.[].full_name'`)
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  console.log(`\n📡  Source: ${owner} (${acctType}) — ${fullNames.length} repos`);
  console.log(`     webhook URL: ${url}`);
  if (dryRun) console.log(`     mode: DRY-RUN (no API calls will be made)\n`);

  let registered = 0, alreadyPresent = 0, updated = 0, failed = 0, wouldRegister = 0, wouldUpdate = 0;

  for (const full of fullNames) {
    const [, repo] = full.split("/");

    // Find existing matching hooks (id only).
    const listRes = ghIgnoreStderr(
      `repos/${full}/hooks --jq '.[] | select(.config.url == "${url}") | .id'`
    );
    if (!listRes.ok) {
      console.log(`   ✗ ${full}: list hooks failed (${listRes.stderr.split("\n")[0]})`);
      failed++;
      continue;
    }
    const existingIds = listRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    if (existingIds.length === 0) {
      // Create
      if (dryRun) { console.log(`   • would CREATE ${full}`); wouldRegister++; continue; }
      const body = JSON.stringify({
        name: "web", active: true, events: ["push"],
        config: { url, secret, content_type: "json", insecure_ssl: "0" },
      });
      // Use --input - to read JSON from stdin (avoids shell quoting hell).
      const cmd = `echo ${JSON.stringify(body)} | gh api -X POST repos/${full}/hooks --input -`;
      try {
        runCapture(cmd);
        console.log(`   ✓ CREATED ${full}`);
        registered++;
      } catch (e) {
        console.log(`   ✗ CREATE ${full} failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
        failed++;
      }
      continue;
    }

    if (!update) {
      console.log(`   = ${full}: webhook already present (id=${existingIds[0]})`);
      alreadyPresent++;
      continue;
    }

    // --update path: PATCH each matching hook.
    if (dryRun) { console.log(`   • would UPDATE ${full} (id=${existingIds.join(",")})`); wouldUpdate++; continue; }
    let allOk = true;
    for (const id of existingIds) {
      const body = JSON.stringify({
        config: { url, secret, content_type: "json", insecure_ssl: "0" },
      });
      const cmd = `echo ${JSON.stringify(body)} | gh api -X PATCH repos/${full}/hooks/${id} --input -`;
      try {
        runCapture(cmd);
      } catch (e) {
        console.log(`   ✗ UPDATE ${full} (id=${id}) failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
        allOk = false;
      }
    }
    if (allOk) { console.log(`   ✓ UPDATED ${full}`); updated++; }
    else failed++;
  }

  console.log(`\n📊  Summary:`);
  if (dryRun) {
    console.log(`     dry-run: ${wouldRegister} would register, ${wouldUpdate} would update, ${failed} failed`);
  } else {
    console.log(`     ${registered} registered, ${alreadyPresent} already present, ${updated} updated, ${failed} failed`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`); process.exit(1); });
```

(The `ghIgnoreStderr` helper above wraps `gh api` to swallow stderr on failure so we can continue the loop. The POST/PATCH paths use raw `runCapture` + try/catch — failures increment `failed` but don't abort.)

2. Verify: `npx tsc --noEmit` exits 0. Mental trace: dry-run on 3 repos (1 missing webhook, 2 already-registered) prints `1 would register, 0 would update, 0 failed`. Real run prints `1 registered, 2 already present, 0 updated, 0 failed`. Exit 0.
  </action>
</task>

<task type="auto">
  <name>Task 5: Wire package.json + config.example.json</name>
  <files>package.json, config.example.json</files>
  <read_first>
    - package.json (full current file)
    - config.example.json (full current file)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-25 — webhookTestRepo doc)
  </read_first>
  <acceptance_criteria>
    - `package.json` has a `scripts.register-webhooks` entry running `tsx scripts/register-webhooks.ts`.
    - No other script entries are touched (avoid conflicts with plan 04 which adds `verify:phase-3`).
    - `config.example.json` adds a `webhookHostname` field with a placeholder value `"backup.example.com"` AND a `webhookTestRepo` field with placeholder `"your-owner/your-test-repo"` (optional documented).
    - `node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"` exits 0 (valid JSON).
  </acceptance_criteria>
  <action>
1. Edit `package.json`:
   - Inside the `"scripts"` object, after the existing entries, add:
     ```json
     "register-webhooks": "tsx scripts/register-webhooks.ts"
     ```
     (Mind the comma placement — append after the previous entry's closing brace/string.)

2. Edit `config.example.json`:
   - Add at the end of the JSON object (above closing `}`), preserving JSON validity (commas):
     ```json
     "webhookHostname": "backup.example.com",
     "webhookTestRepo": "your-owner/your-test-repo"
     ```
   - If the file uses JSON-with-comments style (rare for example config — check first), add a sibling line above each new field briefly describing it. If pure JSON, leave brief explanation for the README §Webhook section (which plan 04 adds).

3. Verify: `node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"` exits 0.

4. Verify: `node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); if (!p.scripts['register-webhooks']) process.exit(1)"` exits 0.
  </action>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` exits 0 (whole project).
2. `node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"` exits 0.
3. `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts['register-webhooks']"` prints `tsx scripts/register-webhooks.ts`.
4. `grep -c "webhookHostname" scripts/lib/config.ts` returns ≥ 2 (interface + REQUIRED_FIELDS at minimum).
5. `grep -c "443" scripts/create-droplet.ts` returns ≥ 2 (CREATE branch + EXISTING-branch reconciliation).
6. `grep -c "WEBHOOK_SECRET" scripts/bootstrap-droplet.ts` returns ≥ 2 (env line + secret-resolution block).
7. `grep -c '/webhook/github' scripts/register-webhooks.ts` returns ≥ 1.
8. `grep -c "rotate-webhook-secret" scripts/bootstrap-droplet.ts` returns ≥ 1.
9. `grep -c "endsWith" scripts/bootstrap-droplet.ts` returns 0 (filter was rewritten to regex per task 3).

Re-running `npm run create-droplet` against a droplet with all rules present should be no-op — mental trace confirms.
Re-running `npm run bootstrap-droplet` without `--rotate-webhook-secret` against a droplet with `WEBHOOK_SECRET` in backup.env should preserve the secret (no new secret echoed). Add this to plan 04's verify:phase-3 as a behavioral assertion (group 6 area).
</verification>

<deferred>
- Per-source secret naming (`WEBHOOK_SECRET_<SOURCE_UPPER>`) — single source at v1; Phase 6 migration.
- Source-IP-allowlist alternative to `0.0.0.0/0` — HMAC is the real gate (CONTEXT.md D-23).
- `register-webhooks --remove` to delete hooks on teardown — out of v1 scope (manual gh API works).
- Local cache of remote `WEBHOOK_SECRET` for faster repeated register-webhooks invocations — single SSH read is cheap; cache invalidation isn't worth it.
- GitHub App alternative to per-repo webhooks — v2 (CONTEXT.md deferred).
</deferred>
