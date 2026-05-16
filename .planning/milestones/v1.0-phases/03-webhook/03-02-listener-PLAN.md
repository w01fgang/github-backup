---
phase: 03-webhook
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - droplet/webhook-listener.js
  - droplet/Caddyfile.template
  - droplet/github-backup-webhook.service
  - droplet/bootstrap.sh
autonomous: true
requirements:
  - WEBHOOK-01
  - WEBHOOK-02
  - PROV-02
  - BACKUP-03

must_haves:
  truths:
    - "droplet/webhook-listener.js is a vanilla Node.js script with zero npm deps — only built-in `http`, `crypto`, `fs`, `child_process` modules (D-01). systemd runs it on tcp/127.0.0.1:9100 behind Caddy."
    - "Listener verifies `X-Hub-Signature-256` HMAC-SHA256 over the RAW request body using `crypto.timingSafeEqual` (D-10). Body is read as Buffer; JSON.parse happens AFTER signature verification."
    - "Source resolution: `payload.repository.owner.login` must equal `cfg.githubUserOrOrg` (single-source at v1 per PROJECT.md webhook-before-multi-source decision). Mismatch → 404 + log `unknown source` (D-11); does not reveal the configured value."
    - "Listener does NOT run git itself (D-02). On accepted push event it invokes `systemd-run --collect --no-block /opt/github-backups/sync-one-repo.sh <source> <owner> <repo>` (D-03) and immediately returns 202 with the JSON `{ok: true, delivery_id, owner, repo}`."
    - "`ping` events return 200 with body `pong` (D-13). All non-push, non-ping events return 204 (D-12)."
    - "Caddy reverse-proxies `https://<webhookHostname>/webhook/github` to `http://127.0.0.1:9100/webhook/github` (D-05). Auto-Let's-Encrypt happens on first request — no separate ACME config needed (D-05)."
    - "systemd unit `github-backup-webhook.service` runs listener as root with `Restart=on-failure`, `RestartSec=2`, journal-only logging (D-18). `systemctl is-enabled` returns `enabled` after bootstrap."
    - "Bootstrap is idempotent: re-running `bootstrap.sh` overwrites Caddyfile + listener.js + unit file (droplet-managed code per D-19), runs `systemctl daemon-reload && systemctl enable --now github-backup-webhook && systemctl reload caddy` without duplicating anything (Phase 5/TEARDOWN-01 hook fulfilled, D-20)."
    - "WEBHOOK_SECRET env var (single source at v1) is read from /opt/github-backups/backup.env via systemd unit `EnvironmentFile=`. Missing secret → listener fails to start with a clear journal message."
  artifacts:
    - path: "droplet/webhook-listener.js"
      provides: "Vanilla Node HTTP listener: HMAC verify → systemd-run dispatch → 202 reply. Single file, no node_modules."
      min_lines: 100
      contains: "timingSafeEqual"
    - path: "droplet/Caddyfile.template"
      provides: "One-line reverse-proxy template with placeholder `__WEBHOOK_HOSTNAME__` that bootstrap.sh substitutes."
      contains: "reverse_proxy"
    - path: "droplet/github-backup-webhook.service"
      provides: "systemd unit: ExecStart=/usr/bin/node /opt/github-backups/webhook-listener.js, EnvironmentFile=/opt/github-backups/backup.env, Restart=on-failure."
      contains: "EnvironmentFile=/opt/github-backups/backup.env"
    - path: "droplet/bootstrap.sh"
      provides: "Additional install/enable steps for caddy, nodejs, webhook-listener systemd unit (D-19). Idempotent on re-run."
      contains: "github-backup-webhook"
---

<objective>
Ship the droplet-side webhook plane: a zero-dep Node listener (D-01), a Caddyfile template (D-05), a systemd unit (D-18), and the bootstrap-side install/enable wiring (D-19). After this plan, a signed POST to `https://<webhookHostname>/webhook/github` triggers a per-repo sync via plan 01's `sync-one-repo.sh`. No operator-side TS work — that's plan 03.

Listener is the smallest possible surface that satisfies WEBHOOK-01 (HMAC) + WEBHOOK-02 (push → sync). Listener writes `last-webhook-event.json` (consumed by plan 04 + Phase 2) at the END of the synchronous path (after `systemd-run` succeeds — D-17). The actual git work happens inside the systemd-spawned `sync-one-repo.sh` from plan 01.

Output: 3 new files in droplet/ + edits to `droplet/bootstrap.sh`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/03-webhook/03-CONTEXT.md
@droplet/bootstrap.sh
@droplet/sync-one-repo.sh
@droplet/github-backup.sh
@scripts/bootstrap-droplet.ts

<interfaces>
<!-- Listener HTTP contract:
       POST /webhook/github
         Headers:
           Content-Type: application/json
           X-GitHub-Event: push | ping | <other>
           X-Hub-Signature-256: sha256=<hex>      (required for push)
           X-GitHub-Delivery: <uuid>              (echoed in dispatch)
         Body: raw JSON (Buffer; do NOT pre-parse before HMAC).
       Responses:
         200 + body "pong"             — ping event (also logs the delivery_id)
         202 + JSON {ok:true,...}      — push accepted + dispatched
         204                           — other event types (no-op)
         400                           — missing signature header, missing/invalid JSON
         401                           — HMAC mismatch
         404                           — payload.repository.owner.login NOT in cfg (single source at v1)
         500                           — systemd-run dispatch failure

     Listener env (from systemd EnvironmentFile=/opt/github-backups/backup.env):
       WEBHOOK_SECRET        required at v1 (single source)
       GITHUB_USER_OR_ORG    required (the single allowed source for v1)
       BACKUP_DIR            default /opt/github-backups
       WEBHOOK_LISTEN_PORT   default 9100
       WEBHOOK_STATE_DIR     default /var/lib/github-backup

     Listener output:
       stdout/stderr → systemd journal (`journalctl -u github-backup-webhook`).
       /var/lib/github-backup/last-webhook-event.json (D-17) written after dispatch — plan 04 owns that field set.

     Worker dispatch contract (D-03):
       /usr/bin/systemd-run --collect --no-block \
         /opt/github-backups/sync-one-repo.sh <source> <owner> <repo>
       systemd-run exit 0 → 202 to GitHub
       systemd-run exit ≠0 → 500 to GitHub (GitHub will retry; cron is the safety net)
-->
</interfaces>
</context>

<rationale>
**Why vanilla Node over Bun / Express / Fastify (D-01):** Caddy already handles TLS, ACME, HSTS — the listener is left with `http.createServer` + `crypto.createHmac` + `child_process.spawnSync`. That's a 100-LOC file, no `npm install`, no `node_modules`. `apt install nodejs` is enough; the droplet stays npm-free for the runtime path. Phase 1 precedent: operator-side scripts use tsx + node_modules; droplet-side scripts use bash + system tools. Listener is droplet-side, so vanilla node is the consistent choice.

**Why HMAC verification BEFORE JSON.parse (D-10):** GitHub signs the raw request body. If we `JSON.parse(body); JSON.stringify(parsed)` and verify on the round-tripped string, key ordering / whitespace differences corrupt the signature. Standard practice: read body as Buffer, HMAC over Buffer, then parse for routing.

**Why source resolution checks owner.login (D-11):** Single source at v1 means there's exactly one allowed owner (cfg.githubUserOrOrg). Webhook MUST reject events whose `payload.repository.owner.login` doesn't match — otherwise an attacker who steals our public webhook URL but not the secret could… well, they couldn't because HMAC rejects them first. But we still want the post-HMAC routing check to prevent a misconfigured webhook on someone else's repo from accidentally cloning that other owner's repos to our droplet. 404 (not 401, not 403) so we don't leak the configured value.

**Why systemd-run --collect --no-block (D-03):** The HTTPS handler must return in seconds (GitHub times out at ~10s and retries — duplicate work). `git remote update` on a large repo can take minutes. systemd-run forks the sync into a transient unit that systemd manages; the handler returns immediately. `--collect` cleans up the unit after exit. `--no-block` returns immediately without waiting for the child. Alternative (long-lived dispatcher reading a queue dir) is more code, more failure modes, more state.

**Why Caddy substitutes hostname at bootstrap time (D-05):** Caddyfile syntax doesn't support `${VAR}` interpolation natively. We use `sed` in bootstrap.sh to substitute a `__WEBHOOK_HOSTNAME__` placeholder at install time. The substituted file is the actual `/etc/caddy/Caddyfile` on the droplet. Bootstrap is idempotent because the substitution is deterministic — re-running with the same `webhookHostname` produces the same file.

**Why systemd unit reads backup.env directly via EnvironmentFile= (D-18):** Avoids a second secret-config file. `WEBHOOK_SECRET` lives next to `GITHUB_TOKEN` in `backup.env` per BACKUP-03. systemd's `EnvironmentFile=` directive parses bash-style `KEY=value` lines — same shape as backup.env. Listener reads `process.env.WEBHOOK_SECRET` and `process.env.GITHUB_USER_OR_ORG` — both populated by the EnvironmentFile.

**Why listener writes last-webhook-event.json itself (not sync-one-repo.sh) (D-17):** The listener sees `X-GitHub-Delivery` header and `received_at`; sync-one-repo.sh doesn't (it's called from cron without an HTTP context). Listener writes the event metadata immediately after `systemd-run` exit-0; the dispatched worker emits BACKUP_REPO_RESULT separately (plan 01). Phase 2's status command (read by plan 04 README docs) reads both files independently. Actual write logic for last-webhook-event.json is in plan 04 — listener has a TODO hook here that plan 04 fills (separation: this plan's listener is dispatch-only).

CORRECTION: To avoid plan 04 having to re-edit `webhook-listener.js`, this plan ships the listener with a small `writeLastEvent()` helper that writes the JSON. Plan 04 then only needs to add the doc README + verify-script that READS the file. Cleaner ownership: plan 02 owns all listener code; plan 04 owns verification + docs that consume it.

**Why systemd handles restart (D-18 `Restart=on-failure`):** Listener crashes (rare — vanilla node + tiny surface) auto-recover within `RestartSec=2`. GitHub retries on non-2xx, so the worst case is a 4-second blip and one re-delivered event. systemd journal captures the crash log for `journalctl -u github-backup-webhook`.

**Why bootstrap.sh-managed (not separate webhook-bootstrap.sh) (D-19):** One operator-facing command (`npm run bootstrap-droplet` → `droplet/bootstrap.sh`) installs everything. Adding a separate step is operator friction with zero value. The webhook-specific block is a clearly-marked section inside the existing script. Phase 5 (idempotency) verifies the whole bootstrap re-run is safe; webhook block participates.

**Why install Caddy from official apt repo (D-19 sub):** Ubuntu 22.04's stock Caddy is old (v2.4-ish). ACME bug fixes ship in newer Caddy. The official Cloudsmith repo is well-maintained and signed. Cost: one extra `apt-key` / `signed-by` setup; benefit: latest ACME bug fixes. Phase 1 precedent: gh CLI is already installed from its official repo (bootstrap.sh lines 74-90); reuse the same shape.
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Create droplet/webhook-listener.js</name>
  <files>droplet/webhook-listener.js</files>
  <read_first>
    - .planning/phases/03-webhook/03-CONTEXT.md (D-01 through D-13, D-17 — the listener's full contract)
    - droplet/sync-one-repo.sh (the spawn target — confirm its arg shape <source> <owner> <repo>)
    - droplet/github-backup.sh (for log-line style conventions; listener logs go to journal but format consistently)
  </read_first>
  <acceptance_criteria>
    - First line `#!/usr/bin/env node`.
    - Imports ONLY built-in modules: `http`, `crypto`, `fs`, `path`, `child_process`. NO `require()` or `import` of any 3rd-party package. NO `package.json`.
    - Reads `process.env.WEBHOOK_SECRET` and bails (exit 1 + stderr) if missing or empty.
    - Reads `process.env.GITHUB_USER_OR_ORG` and bails if missing.
    - Reads `process.env.WEBHOOK_LISTEN_PORT` defaulting to 9100, parses as int, bails on NaN.
    - Reads `process.env.BACKUP_DIR` defaulting to `/opt/github-backups`.
    - Reads `process.env.WEBHOOK_STATE_DIR` defaulting to `/var/lib/github-backup`.
    - Creates an HTTP server on `127.0.0.1:${port}` (NOT `0.0.0.0` — Caddy is the public face).
    - For POST /webhook/github: reads body into Buffer (NOT stream-as-string); computes `expected = "sha256=" + crypto.createHmac("sha256", secret).update(buffer).digest("hex")`; compares with `X-Hub-Signature-256` header via `crypto.timingSafeEqual` (after a `Buffer.byteLength` pre-check to avoid the throw on mismatched length).
    - On HMAC mismatch → 401 + log to stderr the delivery_id (NOT the bad signature).
    - On missing signature header for push event → 401.
    - After HMAC pass, JSON.parse the buffer; on parse error → 400.
    - `ping` event (X-GitHub-Event header) → 200 `pong`; log `ping delivery_id=<id>`.
    - Non-push, non-ping event → 204; log skipped event type.
    - Push event → check `parsed.repository.owner.login === process.env.GITHUB_USER_OR_ORG`; mismatch → 404 + log `unknown source`.
    - On accepted push: spawn `/usr/bin/systemd-run --collect --no-block ${BACKUP_DIR}/sync-one-repo.sh <source> <owner> <repo>` via `child_process.spawnSync` (sync call — exits in ms; do NOT spawn async because we need exit code for response).
    - On systemd-run exit 0 → 202 + JSON `{ok: true, delivery_id, owner, repo}`. Then call `writeLastEvent(...)` to atomically write `${WEBHOOK_STATE_DIR}/last-webhook-event.json` with `{received_at, source, owner, repo, delivery_id, action: "dispatched", exit_code: 0, duration_ms}`.
    - On systemd-run exit ≠0 → 500 + JSON `{ok: false, error: "dispatch_failed"}`. Also write last-webhook-event.json with `action: "dispatch_fail"`, `exit_code: <code>`.
    - `writeLastEvent` writes to a temp file (e.g., `${path}.tmp.${pid}`) then `fs.renameSync` to the final path (atomic per D-17 + Phase 2 D-03 pattern). Creates `WEBHOOK_STATE_DIR` with `fs.mkdirSync(..., {recursive: true, mode: 0o700})` on startup.
    - All routes other than POST /webhook/github → 404.
    - Method other than POST on /webhook/github → 405.
    - Logs one line per request to stdout in the form `[<ISO>] <method> <path> <status> delivery=<id> owner=<o> repo=<r> ms=<n>` (no body content).
    - Top-level `process.on("uncaughtException", ...)` and `process.on("unhandledRejection", ...)` log + `process.exit(1)` so systemd restarts cleanly.
    - `node --check droplet/webhook-listener.js` exits 0.
  </acceptance_criteria>
  <action>
1. Create `droplet/webhook-listener.js` with a header comment describing the contract (purpose, env, HTTP routes, exit codes).

2. Implement the listener following the acceptance criteria literally. Concrete skeleton:

```javascript
#!/usr/bin/env node
// droplet/webhook-listener.js
// Tiny HTTPS-handler (behind Caddy) for GitHub push webhooks.
// Single-operator, single-source at v1. See .planning/phases/03-webhook/03-CONTEXT.md.
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function bail(msg) { process.stderr.write(`FATAL: ${msg}\n`); process.exit(1); }

const SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const ALLOWED_SOURCE = (process.env.GITHUB_USER_OR_ORG || "").trim();
const PORT = parseInt(process.env.WEBHOOK_LISTEN_PORT || "9100", 10);
const BACKUP_DIR = process.env.BACKUP_DIR || "/opt/github-backups";
const STATE_DIR = process.env.WEBHOOK_STATE_DIR || "/var/lib/github-backup";

if (!SECRET) bail("WEBHOOK_SECRET not set (load /opt/github-backups/backup.env)");
if (!ALLOWED_SOURCE) bail("GITHUB_USER_OR_ORG not set");
if (!Number.isFinite(PORT)) bail(`WEBHOOK_LISTEN_PORT not a number: ${process.env.WEBHOOK_LISTEN_PORT}`);

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

const LAST_EVENT_PATH = path.join(STATE_DIR, "last-webhook-event.json");
const SYNC_SCRIPT = path.join(BACKUP_DIR, "sync-one-repo.sh");

function writeLastEvent(obj) {
  const tmp = `${LAST_EVENT_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LAST_EVENT_PATH);
}

function logReq(req, status, extra = {}) {
  const ts = new Date().toISOString();
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ");
  process.stdout.write(`[${ts}] ${req.method} ${req.url} ${status} ${parts}\n`);
}

function verifyHmac(buf, headerValue) {
  if (!headerValue || typeof headerValue !== "string") return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(buf).digest("hex");
  const expBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(headerValue, "utf8");
  if (expBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expBuf, gotBuf);
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  if (req.url !== "/webhook/github") { res.writeHead(404).end(); logReq(req, 404); return; }
  if (req.method !== "POST")          { res.writeHead(405).end(); logReq(req, 405); return; }

  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    const event = req.headers["x-github-event"];
    const delivery = req.headers["x-github-delivery"] || "unknown";
    const sig = req.headers["x-hub-signature-256"];

    // ping has no useful payload-shape constraint but still uses HMAC
    if (!verifyHmac(buf, sig)) {
      res.writeHead(401).end();
      logReq(req, 401, { delivery, event, reason: "hmac_fail" });
      return;
    }

    if (event === "ping") {
      res.writeHead(200, {"Content-Type": "text/plain"}).end("pong");
      logReq(req, 200, { delivery, event: "ping" });
      return;
    }

    if (event !== "push") {
      res.writeHead(204).end();
      logReq(req, 204, { delivery, event });
      return;
    }

    let payload;
    try { payload = JSON.parse(buf.toString("utf8")); }
    catch (e) { res.writeHead(400).end(); logReq(req, 400, { delivery, reason: "json_parse" }); return; }

    const owner = payload?.repository?.owner?.login;
    const repo  = payload?.repository?.name;
    if (!owner || !repo) {
      res.writeHead(400).end();
      logReq(req, 400, { delivery, reason: "missing_owner_or_repo" });
      return;
    }

    if (owner !== ALLOWED_SOURCE) {
      res.writeHead(404).end();
      logReq(req, 404, { delivery, owner, reason: "unknown_source" });
      return;
    }

    const ARG_RE = /^[A-Za-z0-9._-]+$/;
    if (!ARG_RE.test(owner) || !ARG_RE.test(repo)) {
      res.writeHead(400).end();
      logReq(req, 400, { delivery, reason: "arg_shape" });
      return;
    }

    const r = spawnSync("/usr/bin/systemd-run",
      ["--collect", "--no-block", SYNC_SCRIPT, owner, owner, repo],
      { stdio: ["ignore", "pipe", "pipe"] });
    const dispatchOk = r.status === 0;
    const elapsed = Date.now() - t0;
    const evt = {
      received_at: new Date().toISOString(),
      source: owner, owner, repo,
      delivery_id: delivery,
      action: dispatchOk ? "dispatched" : "dispatch_fail",
      exit_code: r.status ?? -1,
      duration_ms: elapsed,
    };
    try { writeLastEvent(evt); } catch (e) {
      process.stderr.write(`WARN: writeLastEvent failed: ${e.message}\n`);
    }

    if (dispatchOk) {
      res.writeHead(202, {"Content-Type": "application/json"})
         .end(JSON.stringify({ ok: true, delivery_id: delivery, owner, repo }));
      logReq(req, 202, { delivery, owner, repo, ms: elapsed });
    } else {
      res.writeHead(500, {"Content-Type": "application/json"})
         .end(JSON.stringify({ ok: false, error: "dispatch_failed" }));
      logReq(req, 500, { delivery, owner, repo, ms: elapsed, stderr: (r.stderr||"").toString().slice(0,200) });
    }
  });
});

process.on("uncaughtException", e => { process.stderr.write(`uncaught: ${e.stack || e}\n`); process.exit(1); });
process.on("unhandledRejection", e => { process.stderr.write(`unhandled: ${e}\n`); process.exit(1); });

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`[${new Date().toISOString()}] webhook-listener up on 127.0.0.1:${PORT} (source=${ALLOWED_SOURCE})\n`);
});
```

3. Verify: `node --check droplet/webhook-listener.js` exits 0.

4. Mental test: walk through a `ping` event, a wrong-sig event, a right-sig+wrong-source event, a right-sig+right-source event. Confirm each lands the right status code + log line + state-file write.
  </action>
</task>

<task type="auto">
  <name>Task 2: Create droplet/Caddyfile.template</name>
  <files>droplet/Caddyfile.template</files>
  <read_first>
    - .planning/phases/03-webhook/03-CONTEXT.md (D-05 — exact Caddyfile shape)
  </read_first>
  <acceptance_criteria>
    - File exists at `droplet/Caddyfile.template`.
    - Contains the placeholder `__WEBHOOK_HOSTNAME__` exactly once.
    - Contains exactly one `reverse_proxy /webhook/github 127.0.0.1:9100` directive.
    - No other site blocks, no global option blocks, no acme overrides — Caddy defaults handle Let's Encrypt automatically.
    - File ends with a newline.
  </acceptance_criteria>
  <action>
Write `droplet/Caddyfile.template` containing exactly:

```caddyfile
# /etc/caddy/Caddyfile — github-backup webhook listener
# Templated from droplet/Caddyfile.template by droplet/bootstrap.sh.
# Hostname placeholder is substituted at bootstrap time from cfg.webhookHostname.

__WEBHOOK_HOSTNAME__ {
	reverse_proxy /webhook/github 127.0.0.1:9100
}
```

(Use literal tab indentation inside the block — Caddyfile syntax tolerates both, but match the convention from `https://caddyserver.com/docs/caddyfile`.)
  </action>
</task>

<task type="auto">
  <name>Task 3: Create droplet/github-backup-webhook.service</name>
  <files>droplet/github-backup-webhook.service</files>
  <read_first>
    - .planning/phases/03-webhook/03-CONTEXT.md (D-18 — systemd unit semantics)
  </read_first>
  <acceptance_criteria>
    - File exists at `droplet/github-backup-webhook.service`.
    - `[Unit]` block has `Description=`, `After=network-online.target`, `Wants=network-online.target`.
    - `[Service]` block has:
      - `Type=simple`
      - `ExecStart=/usr/bin/node /opt/github-backups/webhook-listener.js`
      - `EnvironmentFile=/opt/github-backups/backup.env`
      - `Restart=on-failure`
      - `RestartSec=2`
      - `StandardOutput=journal`
      - `StandardError=journal`
      - `User=root`  (matches cron posture per CONTEXT.md domain block)
    - `[Install]` block has `WantedBy=multi-user.target`.
    - Plain text, no placeholders — this file is installed verbatim by bootstrap.sh.
  </acceptance_criteria>
  <action>
Write `droplet/github-backup-webhook.service`:

```ini
[Unit]
Description=GitHub backup webhook listener
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/github-backups/webhook-listener.js
EnvironmentFile=/opt/github-backups/backup.env
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
User=root

[Install]
WantedBy=multi-user.target
```
  </action>
</task>

<task type="auto">
  <name>Task 4: Extend droplet/bootstrap.sh to install caddy + nodejs + listener + Caddyfile + systemd unit</name>
  <files>droplet/bootstrap.sh</files>
  <read_first>
    - droplet/bootstrap.sh (current full body — to find correct insertion points)
    - droplet/Caddyfile.template (the template just created — bootstrap reads it via SCP'd copy at ${BACKUP_DIR}/Caddyfile.template)
    - scripts/bootstrap-droplet.ts (lines 108-123 — confirms uploader includes any `*.sh` already; non-`.sh` files need explicit handling — see action step 0)
  </read_first>
  <acceptance_criteria>
    - `droplet/bootstrap.sh` installs `caddy` and `nodejs` via apt — both idempotent (`apt-get install -y` is no-op on already-installed packages).
    - Installs Caddy from official Cloudsmith apt repo (same shape as the existing gh CLI block, lines 70-90).
    - After base packages, writes `/etc/caddy/Caddyfile` by `sed`-substituting `__WEBHOOK_HOSTNAME__` from env `WEBHOOK_HOSTNAME` into the template at `${BACKUP_DIR}/Caddyfile.template`.
    - Bails loud if `WEBHOOK_HOSTNAME` is unset OR matches the placeholder string (`__WEBHOOK_HOSTNAME__`) — operator must set `webhookHostname` in config.json.
    - Installs `/etc/systemd/system/github-backup-webhook.service` by copying from `${BACKUP_DIR}/github-backup-webhook.service` (the SCP-uploaded copy).
    - Runs `systemctl daemon-reload`, then `systemctl enable --now github-backup-webhook`, then `systemctl reload caddy` (or `systemctl restart caddy` if reload fails — but reload should suffice).
    - All of the above is idempotent on re-run: overwriting Caddyfile + service file + listener.js is fine (droplet-managed code); `apt-get install` no-ops; `systemctl enable --now` no-ops if already enabled+active; `daemon-reload` is safe.
    - The webhook block is BELOW the existing cron install block (line 137 currently), so cron still installs first (sync-one-repo.sh is in place before the listener starts).
    - `bash -n droplet/bootstrap.sh` exits 0.
  </acceptance_criteria>
  <action>
0. **Pre-step (read-only check):** Read `scripts/bootstrap-droplet.ts` lines 108-123. Note: the uploader currently filters `*.sh` only (line 116: `d.name.endsWith(".sh")`). The new files `webhook-listener.js`, `Caddyfile.template`, `github-backup-webhook.service` are NOT `.sh`. Plan 03 will update the TS uploader; for THIS plan, only the bootstrap.sh additions are in scope. Add a defensive guard in bootstrap.sh that bails loud if `${BACKUP_DIR}/webhook-listener.js` is missing — that surfaces the plan-03 dependency cleanly during initial bootstrap.

1. In `droplet/bootstrap.sh`, AFTER the existing `▸ Installing base packages` block (around line 58-67), ADD a "Installing Caddy + nodejs" block following the same shape as the existing gh CLI install (lines 70-90):

```bash
# ── Caddy (reverse proxy + Let's Encrypt) ────────────────────────────────────
echo
if command -v caddy &>/dev/null; then
  echo "▸ Caddy already installed ($(caddy version 2>&1 | head -1)), skipping repo setup."
else
  echo "▸ Installing Caddy from the official apt repository…"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
  echo "  ✓ Caddy installed: $(caddy version 2>&1 | head -1)"
fi

# ── Node.js (webhook listener runtime) ───────────────────────────────────────
echo
if command -v node &>/dev/null; then
  echo "▸ Node.js already installed ($(node --version)), skipping."
else
  echo "▸ Installing Node.js (Ubuntu default repo — listener uses only built-in modules)…"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  echo "  ✓ Node.js installed: $(node --version)"
fi
```

2. AFTER the existing `▸ Installing backup cron job…` block (lines 136-138), ADD a "Installing webhook listener" block:

```bash
# ── Webhook listener (Phase 3) ───────────────────────────────────────────────
echo
echo "▸ Installing webhook listener (Phase 3)…"

# Defensive: confirm the three uploaded files are present.
for f in webhook-listener.js Caddyfile.template github-backup-webhook.service; do
  if [[ ! -f "${BACKUP_DIR}/${f}" ]]; then
    echo "ERROR: ${BACKUP_DIR}/${f} not found. Did bootstrap-droplet.ts upload it?" >&2
    echo "       (See scripts/bootstrap-droplet.ts — the uploader must include non-.sh files for Phase 3.)" >&2
    exit 1
  fi
done

# Validate WEBHOOK_HOSTNAME is set + not the placeholder.
: "${WEBHOOK_HOSTNAME:?WEBHOOK_HOSTNAME must be set in ${ENV_FILE} (config.json field webhookHostname)}"
if [[ "${WEBHOOK_HOSTNAME}" == "__WEBHOOK_HOSTNAME__" ]]; then
  echo "ERROR: WEBHOOK_HOSTNAME equals the template placeholder. Set webhookHostname in config.json." >&2
  exit 1
fi

# Substitute hostname into Caddyfile.
echo "  → Writing /etc/caddy/Caddyfile (hostname=${WEBHOOK_HOSTNAME})"
sed "s|__WEBHOOK_HOSTNAME__|${WEBHOOK_HOSTNAME}|g" \
  "${BACKUP_DIR}/Caddyfile.template" > /etc/caddy/Caddyfile

# Install systemd unit (overwrite OK — droplet-managed).
echo "  → Installing /etc/systemd/system/github-backup-webhook.service"
cp "${BACKUP_DIR}/github-backup-webhook.service" /etc/systemd/system/github-backup-webhook.service

# Reload + enable + start.
systemctl daemon-reload
systemctl enable --now github-backup-webhook
echo "  ✓ github-backup-webhook.service: $(systemctl is-active github-backup-webhook)"

# Reload Caddy (graceful — picks up the new Caddyfile).
systemctl reload caddy || systemctl restart caddy
echo "  ✓ caddy reloaded with new Caddyfile"
```

3. `bash -n droplet/bootstrap.sh` returns 0.

4. Mental walk: first-run installs Caddy + node + listener; second-run finds everything already installed, overwrites Caddyfile + unit (no-op if unchanged), `systemctl enable --now` no-ops, `daemon-reload` is safe. No duplicate units, no clobbered config. Phase 5 idempotency (TEARDOWN-01) hook (D-20) is fulfilled by this idempotent block.
  </action>
</task>

</tasks>

<verification>
1. `node --check droplet/webhook-listener.js && bash -n droplet/bootstrap.sh` exits 0.
2. `grep -c "timingSafeEqual" droplet/webhook-listener.js` returns ≥ 1 (HMAC verification path).
3. `grep -c "systemd-run" droplet/webhook-listener.js` returns ≥ 1 (dispatch path).
4. `grep -c "last-webhook-event.json" droplet/webhook-listener.js` returns ≥ 1 (state file path).
5. `grep -c "require(" droplet/webhook-listener.js` returns the count of built-in module imports (http, crypto, fs, path, child_process = 5); `grep "require(" droplet/webhook-listener.js | grep -vE '^(.*"http"|.*"crypto"|.*"fs"|.*"path"|.*"child_process").*$'` returns nothing (no third-party imports).
6. `grep -c "reverse_proxy" droplet/Caddyfile.template` returns 1.
7. `grep -c "__WEBHOOK_HOSTNAME__" droplet/Caddyfile.template` returns 1.
8. `grep -c "EnvironmentFile=/opt/github-backups/backup.env" droplet/github-backup-webhook.service` returns 1.
9. `grep -c "github-backup-webhook" droplet/bootstrap.sh` returns ≥ 2 (defensive check + enable line).
10. `grep -c "WEBHOOK_HOSTNAME" droplet/bootstrap.sh` returns ≥ 2 (validation + sed).

If any check fails, fix and rerun before marking complete.
</verification>

<deferred>
- Listener-side per-source secrets — single source at v1; multi-source (Phase 6) will switch to `WEBHOOK_SECRET_<SOURCE_UPPER>` lookup keyed by `payload.repository.owner.login`.
- Listener metrics endpoint — v2 alerting (CONTEXT.md deferred).
- Long-lived dispatcher process (vs `systemd-run` per event) — `systemd-run` is simpler at v1; per-source rate-limit needs may revisit (CONTEXT.md D-03 sub).
- IP allowlist for /webhook/github — HMAC is the real gate; `0.0.0.0/0` accepted (D-23).
- Webhook delivery audit log beyond `last-webhook-event.json` — v2 (CONTEXT.md deferred).
</deferred>
