---
phase: 03-webhook
plan: 04
type: execute
wave: 3
depends_on: ["03-01", "03-02", "03-03"]
files_modified:
  - scripts/verify/phase-3.ts
  - package.json
  - README.md

autonomous: true
requirements:
  - TEST-02
  - TEST-03
  - WEBHOOK-01
  - WEBHOOK-02

must_haves:
  truths:
    - "`npm run verify:phase-3` runs scripts/verify/phase-3.ts, which exits 0 only when every assertion passes (Phase 1 fail-fast style)."
    - "Six assertion groups run in order (D-26): (1) pre-conditions including DNS + listener + Caddy + LE cert; (2) source-resolution: unknown owner → 404; (3) bad HMAC → 401; (4) end-to-end push (env-gated on cfg.webhookTestRepo, log-skip when unset); (5) idempotency: same event processed twice; (6) listener-restart survival."
    - "Group 4 constructs a synthetic GitHub push payload using the real droplet mirror's HEAD SHA (read via SSH) — fully deterministic, no dependence on a real recent GitHub delivery (D-26 group 4 sub: 'fully construct from a real git rev-parse HEAD'). Skips loudly when cfg.webhookTestRepo is unset."
    - "verify:phase-3 prints what each assertion checks before running (Phase 1 NR-04 transparency), and never fakes results (NR-01)."
    - "README gains a `## Webhook setup` section covering: DNS prereq, where the secret is generated + echoed, how to run register-webhooks, how to verify, journalctl command for live tail, troubleshooting Let's-Encrypt issuance failures."
    - "package.json adds `verify:phase-3` script entry, alongside the existing verify:phase-1."
  artifacts:
    - path: "scripts/verify/phase-3.ts"
      provides: "Six-group end-to-end verification of the webhook plane (TEST-02 + TEST-03 hard surface)."
      min_lines: 200
      contains: "BACKUP_REPO_RESULT"
    - path: "package.json"
      provides: "Adds verify:phase-3 npm script entry."
      contains: "verify:phase-3"
    - path: "README.md"
      provides: "Operator-facing webhook section covering DNS, secrets, registration, verification, troubleshooting."
      contains: "## Webhook setup"
  key_links:
    - from: "scripts/verify/phase-3.ts"
      to: "scripts/lib/{ssh,config}.ts"
      via: "import statements"
      pattern: "from \"\\.\\./lib/(ssh|config)\""
    - from: "scripts/verify/phase-3.ts"
      to: "droplet/webhook-listener.js"
      via: "HTTPS POSTs to cfg.webhookHostname"
      pattern: "/webhook/github"
---

<objective>
Ship the operator-visible verification surface for Phase 3: a `verify:phase-3` TypeScript runner with six fail-fast assertion groups (TEST-02 + TEST-03), the README section that documents the full webhook setup workflow, and the package.json wiring. After this plan, an operator can run `npm run verify:phase-3` against a live droplet and get a green/red proof of the webhook plane.

Verification follows the Phase 1 template: `assert(cond, msg)`, exit 0 only on all-pass, print each check's intent before running. Synthetic push payload is constructed from the actual droplet mirror's HEAD SHA (no live GitHub dependency in the assertion path).

Output: 1 new TS file + README section + 1 line of package.json.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/phases/03-webhook/03-CONTEXT.md
@scripts/lib/config.ts
@scripts/lib/ssh.ts
@scripts/verify/phase-1.ts
@droplet/webhook-listener.js
@droplet/sync-one-repo.sh
@README.md
@package.json

<interfaces>
<!-- Assertion groups (D-26):
  Group 1: Pre-conditions
    - DNS: dig A <webhookHostname>; first answer matches droplet.ip from .droplet.json
    - HTTPS reach: GET https://<webhookHostname>/webhook/github (no body) returns 405 (POST only)
    - LE cert valid: TLS handshake succeeds; `openssl s_client … | openssl x509 -noout -enddate` is in the future
    - systemd: `systemctl is-active github-backup-webhook` over SSH returns `active`
    - caddy: `systemctl is-active caddy` over SSH returns `active`

  Group 2: Source resolution (unknown owner)
    - Build payload with `repository.owner.login = "definitely-not-a-real-owner-abc123"`
    - HMAC-sign with the actual WEBHOOK_SECRET (read over SSH the same way register-webhooks does)
    - POST → assert status === 404

  Group 3: Bad signature
    - Build valid push payload for cfg.githubUserOrOrg
    - Sign with a DELIBERATELY WRONG secret ("nope" repeated)
    - POST → assert status === 401

  Group 4: End-to-end push (gated on cfg.webhookTestRepo)
    - If cfg.webhookTestRepo unset: log "[skip] cfg.webhookTestRepo not set" and SKIP without failing the run (matches verify:phase-1's gated-group precedent if any; matches CONTEXT.md D-26 group 4 explicit gating).
    - If set: parse to {owner, repo}; assert owner === cfg.githubUserOrOrg (single-source at v1 — Phase 6 will relax).
    - Read the droplet's current mirror HEAD via `ssh … "git -C ${BACKUP_DIR}/<owner>_<repo>.git rev-parse HEAD"`. Call this SHA_BEFORE.
    - Build a synthetic push payload with `after: SHA_AFTER` where SHA_AFTER is a deterministic-but-novel 40-hex string (e.g., sha1 of `received_at` ISO timestamp — does NOT need to be a real commit; sync-one-repo.sh runs `git remote update --prune` which fetches from real GitHub, not from the payload).
    - HMAC-sign with real secret. POST → assert status === 202 (dispatched).
    - Poll `cat /var/lib/github-backup/last-webhook-event.json` over SSH every 1s for up to 30s; assert it eventually shows {owner, repo, action: "dispatched"} matching the just-POSTed delivery_id.
    - Poll `git -C ${BACKUP_DIR}/<owner>_<repo>.git log -1 --format=%H` over SSH; the mirror's HEAD may or may not have changed (depends on whether there's a NEW commit on GitHub — we don't control that). The pass condition is the BACKUP_REPO_RESULT line in /var/log/github-backup.log within 30s, action=clone|update (NOT fail). Use `tail -n 50 /var/log/github-backup.log | grep BACKUP_REPO_RESULT | tail -1` over SSH.

  Group 5: Idempotency
    - Re-POST the same payload from group 4 (or a freshly constructed one if group 4 skipped — in skip case, the test target is "known repo not in cfg" with valid sig → 404; we want a different positive idempotency check):
      For group 5 ONLY, use a synthetic non-push event ("repository") → assert 204 once, then re-send identical payload → assert 204 again. Demonstrates listener doesn't dedupe by X-GitHub-Delivery.
    - Mental simpler-alternative: re-send a `ping` event twice, assert 200 both times. Equally valid signal — listener doesn't dedupe.

  Group 6: Listener-restart survival
    - `ssh ... "systemctl restart github-backup-webhook"`
    - Wait 3 seconds.
    - POST a ping event. Assert 200.
    - Confirm `systemctl is-active github-backup-webhook` is `active`.

  TLS detail: use `https.request` from node built-in https module. Trust the system CA chain (Let's Encrypt is in any modern Ubuntu trust store).
  Header detail: every test POST sets `X-GitHub-Event`, `X-GitHub-Delivery`, `X-Hub-Signature-256`, `User-Agent: GitHub-Hookshot/test`.
-->

<!-- README section structure ("## Webhook setup"):
  1. Why (one paragraph: webhook = near-instant sync; cron stays as safety net).
  2. Prereqs: own a domain; point A record at droplet IP BEFORE running bootstrap-droplet (Caddy needs DNS for ACME).
  3. Config additions: webhookHostname (required), webhookTestRepo (optional).
  4. First-time setup: `npm run create-droplet`, `GITHUB_TOKEN=… npm run bootstrap-droplet`, RECORD the echoed WEBHOOK_SECRET, `npm run register-webhooks`.
  5. Rotation: `GITHUB_TOKEN=… npm run bootstrap-droplet -- --rotate-webhook-secret`, then `npm run register-webhooks -- --update`.
  6. Verification: `npm run verify:phase-3`.
  7. Live tail: `ssh root@<droplet-ip> journalctl -u github-backup-webhook -f`.
  8. Troubleshooting: LE-issuance-failure checklist (DNS not pointed, port 80 blocked, hostname mismatch); webhook-not-firing checklist (check `gh api repos/<owner>/<repo>/hooks/<id>/deliveries`); cron-still-doing-everything check (BACKUP_REPO_RESULT lines in /var/log/github-backup.log show source).
-->
</interfaces>
</context>

<rationale>
**Why the synthetic-payload approach for group 4 (D-26 group 4 sub):** A real recent GitHub delivery (`gh api repos/.../hooks/.../deliveries`) would test the registration plumbing too, but it adds variance — the test needs a recent delivery to exist, and might fail spuriously on a fresh test repo with no recent pushes. A locally constructed payload is fully deterministic: we know exactly what owner/repo we're claiming, we sign with the actual secret, and the listener's behavior is identical (it doesn't verify the payload's `after` SHA against anything — it just dispatches `sync-one-repo.sh`, which fetches from real GitHub regardless). The signal we're testing is "signed POST triggers sync within 30s" — that's WEBHOOK-02 — and the synthetic payload tests it precisely.

**Why poll BACKUP_REPO_RESULT in /var/log/github-backup.log instead of mirror HEAD:** The mirror HEAD might not change after the sync (GitHub repo had no new commits). What we want to verify is that the synced ran successfully — `BACKUP_REPO_RESULT … action=clone|update` is the proof. Polling that log line is the same observation surface Phase 2's status command will use, so the test exercises a real production interface.

**Why group 5 uses ping-twice (or non-push duplicate) instead of duplicate-push:** A duplicate signed-push would correctly fire `sync-one-repo.sh` twice, but the second call would race the first on the per-repo lock (plan 01 D-16) and either block briefly or return early. That's correct behavior, but it makes the test slow + flaky. A duplicate `ping` event (or non-push event) tests the same listener property (no dedupe by `X-GitHub-Delivery`) in a way that's instant and stateless. Either implementation is acceptable per CONTEXT.md.

**Why group 6 (restart survival) ties to Phase 5 (D-20):** Phase 5's idempotency verify (`verify:phase-5.ts` per the planned phase 5 plans) must check that a re-run of bootstrap-droplet doesn't break the listener. That assertion can probe `systemctl is-active github-backup-webhook` after re-bootstrap, but Phase 3 also needs its own listener-restart smoke. Group 6 is Phase 3's standalone smoke — Phase 5 will add the "after re-bootstrap" wrapper.

**Why DNS check (group 1) doesn't validate the certificate's content beyond expiry:** Let's Encrypt-issued certs vary by SAN, issuer, etc. The minimum proof that "Caddy issued an LE cert successfully" is the handshake succeeds + the cert is currently valid (notBefore < now < notAfter). Deeper cert chain assertions risk false negatives on legitimate cert rotations. Phase 1 precedent: minimal proofs of life.

**Why the README block is part of THIS plan and not plan 02:** Operators interact with the webhook surface through the README. The README needs to mention `register-webhooks`, `verify:phase-3`, and the rotation workflow — all of which exist only after plans 03 + this plan. Doing the README here means there's one consistent edit instead of three partial edits across plans 02-04.

**Why npm script entry here, not in plan 02 or 03:** plan 03 already adds `register-webhooks`. To avoid two plans touching the same `scripts` object in package.json (merge conflicts during parallel waves), keep all script edits in this last-wave plan. Plan 03's task 5 adds `register-webhooks`; this plan's task 3 adds `verify:phase-3`. Both run in different waves (plan 03 wave 2, this plan wave 3) — by serialization, no overlap.
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Create scripts/verify/phase-3.ts with six assertion groups</name>
  <files>scripts/verify/phase-3.ts</files>
  <read_first>
    - scripts/verify/phase-1.ts (full file — copy the assert helper, file structure, runCapture/sshCapture patterns; DO NOT extract a shared helper module — Phase 1 NR/Phase 4 D-Discretion notes that the helper duplication is acceptable at v1, and extracting changes scope)
    - scripts/lib/config.ts (Config + DropletInfo types)
    - scripts/lib/ssh.ts (sshFlags, runCapture, runVisible)
    - droplet/webhook-listener.js (the listener's contract — HTTP status code map, header names)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-26 group details, D-17 last-webhook-event.json shape)
  </read_first>
  <acceptance_criteria>
    - File exists at `scripts/verify/phase-3.ts` with `#!/usr/bin/env node` shebang.
    - Imports built-ins: `crypto`, `https`, `dns/promises` (or `dns`).
    - Imports from project: `loadConfig`, `loadDropletInfo`, `Config`, `DropletInfo` from `../lib/config`; `sshFlags`, `runCapture` from `../lib/ssh`.
    - Defines a local `assert(cond, msg)` matching the Phase 1 shape exactly (✓ on pass, ✗ + `process.exit(1)` on fail).
    - Defines `postWebhook(payload, headers)` helper that POSTs to `https://${cfg.webhookHostname}/webhook/github` using built-in `https.request`, returns `{status, body, headers}`. Sets a 10-second request timeout.
    - Defines `signPayload(buffer, secret)` returning `"sha256=" + hmac-sha256-hex`.
    - Defines `sshCapture(remoteCmd)` helper that runs `ssh <flags> user@ip <cmd>` via `runCapture` (same pattern as verify/phase-1.ts).
    - Reads `WEBHOOK_SECRET` from the droplet's `/opt/github-backups/backup.env` via SSH (single read, mirror the register-webhooks pattern from plan 03 task 4).
    - Group 1: DNS check (resolve cfg.webhookHostname; first A record matches droplet.ip from .droplet.json); HTTP probe (GET /webhook/github → 405); LE cert validity (verify via TLS handshake notAfter > now); two `systemctl is-active` checks.
    - Group 2: unknown-owner payload → 404.
    - Group 3: bad-signature payload → 401.
    - Group 4: gated on `cfg.webhookTestRepo`:
      - If unset: `console.log("[skip] cfg.webhookTestRepo not set — group 4 not run")` and continue without failing.
      - If set: parse owner/repo, assert owner === cfg.githubUserOrOrg (else loud bail explaining single-source-at-v1), build payload, POST, assert 202, poll for matching `BACKUP_REPO_RESULT` line in `/var/log/github-backup.log` for up to 30s with 1s interval, assert `action=clone|update` (not `fail`).
    - Group 5: send a `ping` event twice, assert 200 both times.
    - Group 6: `systemctl restart github-backup-webhook` via SSH, wait 3s, POST a ping, assert 200, assert `systemctl is-active github-backup-webhook` is `active`.
    - Before each group, `console.log("\n── Group <N>: <name>")` so the operator sees progress.
    - On all-pass: `console.log("\n✅  All assertions passed.")` and exit 0.
    - `npx tsc --noEmit` exits 0.
  </acceptance_criteria>
  <action>
1. Create `scripts/verify/phase-3.ts`. Top-level skeleton:

```typescript
#!/usr/bin/env node
/**
 * scripts/verify/phase-3.ts
 *
 * Per-phase executable verification for Phase 3 (TEST-02 / TEST-03).
 * Six assertion groups per .planning/phases/03-webhook/03-CONTEXT.md D-26.
 *
 * Usage:
 *   npm run verify:phase-3
 *
 * Exit 0 only when every assertion passes. Fail-fast on the first ✗.
 */
import * as crypto from "crypto";
import * as https from "https";
import * as dns from "dns/promises";
import { loadConfig, loadDropletInfo, type Config, type DropletInfo } from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

function sshCapture(cfg: Config, droplet: DropletInfo, remote: string): string {
  const cmd = `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${droplet.ip} ${JSON.stringify(remote)}`;
  return runCapture(cmd);
}

function signPayload(body: Buffer, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

interface PostResult { status: number; body: string; headers: Record<string, string>; }

function postWebhook(
  hostname: string,
  body: Buffer,
  headers: Record<string, string>
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST", host: hostname, path: "/webhook/github", port: 443,
        headers: { "Content-Type": "application/json", "Content-Length": body.length, ...headers },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: Object.fromEntries(Object.entries(res.headers).map(([k,v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")])),
        }));
      }
    );
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function makeDelivery(): string {
  return crypto.randomBytes(16).toString("hex");
}

function syntheticPushPayload(owner: string, repo: string): Buffer {
  // Minimal push event GitHub shape; only fields the listener inspects matter.
  const obj = {
    ref: "refs/heads/main",
    after: crypto.createHash("sha1").update(new Date().toISOString()).digest("hex"),
    before: "0".repeat(40),
    repository: { name: repo, owner: { login: owner } },
  };
  return Buffer.from(JSON.stringify(obj));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const droplet = loadDropletInfo();

  // ── Read WEBHOOK_SECRET from droplet ───────────────────────────────────
  let secret = "";
  try {
    const line = sshCapture(cfg, droplet, "grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env").trim();
    if (line.startsWith("WEBHOOK_SECRET=")) secret = line.slice("WEBHOOK_SECRET=".length).trim();
  } catch (e) {
    console.error(`✗ Could not read WEBHOOK_SECRET from droplet: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  assert(/^[a-f0-9]{64}$/.test(secret), "WEBHOOK_SECRET on droplet is 64 hex chars");

  // ── Group 1: Pre-conditions ────────────────────────────────────────────
  console.log("\n── Group 1: Pre-conditions");

  // DNS
  const resolved = await dns.resolve4(cfg.webhookHostname).catch(() => [] as string[]);
  assert(resolved.includes(droplet.ip),
    `DNS A record for ${cfg.webhookHostname} resolves to ${droplet.ip} (got: [${resolved.join(",")}])`);

  // HTTPS probe — GET should be 405
  const probe = await new Promise<{status:number}>((resolve, reject) => {
    const r = https.request({ method: "GET", host: cfg.webhookHostname, path: "/webhook/github", port: 443, timeout: 10_000 },
      (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    r.end();
  });
  assert(probe.status === 405, `GET https://${cfg.webhookHostname}/webhook/github returns 405 (got ${probe.status})`);

  // LE cert validity via openssl on droplet (avoids parsing TLS in node)
  const certEndDate = sshCapture(cfg, droplet,
    `echo | openssl s_client -servername ${cfg.webhookHostname} -connect ${cfg.webhookHostname}:443 2>/dev/null | openssl x509 -noout -enddate`
  ).trim();
  // certEndDate looks like "notAfter=Jan 15 12:00:00 2027 GMT"
  const m = certEndDate.match(/notAfter=(.+)/);
  assert(!!m, `openssl returned a notAfter line (got: ${certEndDate})`);
  const expiryMs = m ? Date.parse(m[1]) : NaN;
  assert(Number.isFinite(expiryMs) && expiryMs > Date.now(), `Let's Encrypt cert valid until ${m?.[1]}`);

  // systemd units
  assert(sshCapture(cfg, droplet, "systemctl is-active github-backup-webhook").trim() === "active",
    "github-backup-webhook.service is active");
  assert(sshCapture(cfg, droplet, "systemctl is-active caddy").trim() === "active",
    "caddy.service is active");

  // ── Group 2: Source resolution (unknown owner → 404) ───────────────────
  console.log("\n── Group 2: Source resolution");
  {
    const body = syntheticPushPayload("definitely-not-a-real-owner-abc123", "anything");
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 404, `Unknown owner returns 404 (got ${r.status})`);
  }

  // ── Group 3: Bad signature → 401 ───────────────────────────────────────
  console.log("\n── Group 3: Bad signature");
  {
    const body = syntheticPushPayload(cfg.githubUserOrOrg, "repo-doesnt-matter");
    const badSig = signPayload(body, "nope".repeat(16));
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": badSig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 401, `Bad signature returns 401 (got ${r.status})`);
  }

  // ── Group 4: End-to-end push (gated on cfg.webhookTestRepo) ────────────
  console.log("\n── Group 4: End-to-end push");
  if (!cfg.webhookTestRepo) {
    console.log("[skip] cfg.webhookTestRepo not set — group 4 not run");
  } else {
    const [owner, repo] = cfg.webhookTestRepo.split("/");
    assert(owner === cfg.githubUserOrOrg,
      `cfg.webhookTestRepo owner "${owner}" matches cfg.githubUserOrOrg "${cfg.githubUserOrOrg}" (Phase 6 will relax this)`);
    const body = syntheticPushPayload(owner, repo);
    const delivery = makeDelivery();
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 202, `Signed push returns 202 (got ${r.status})`);

    // Poll BACKUP_REPO_RESULT for up to 30s.
    const grepCmd =
      `grep -E '^\\[.*\\] BACKUP_REPO_RESULT source=${owner} owner=${owner} repo=${repo} action=(clone|update|fail)' ` +
      `/var/log/github-backup.log | tail -1`;
    let line = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try { line = sshCapture(cfg, droplet, grepCmd).trim(); } catch { line = ""; }
      if (line) break;
      await new Promise(res => setTimeout(res, 1_000));
    }
    assert(!!line, `BACKUP_REPO_RESULT line for ${owner}/${repo} appeared in /var/log/github-backup.log within 30s`);
    assert(!/action=fail/.test(line),
      `Sync action for ${owner}/${repo} is clone|update, not fail (line: ${line})`);

    // Also assert last-webhook-event.json got written.
    const eventJson = sshCapture(cfg, droplet, "cat /var/lib/github-backup/last-webhook-event.json").trim();
    const ev = JSON.parse(eventJson);
    assert(ev.owner === owner && ev.repo === repo, `last-webhook-event.json names ${owner}/${repo}`);
    assert(ev.action === "dispatched", `last-webhook-event.json action=dispatched`);
  }

  // ── Group 5: Idempotency (ping twice) ──────────────────────────────────
  console.log("\n── Group 5: Idempotency");
  for (let i = 0; i < 2; i++) {
    const body = Buffer.from(JSON.stringify({ zen: "Anything added dilutes everything else." }));
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 200 && r.body.startsWith("pong"), `ping ${i+1}/2 returns 200 + pong`);
  }

  // ── Group 6: Listener-restart survival ─────────────────────────────────
  console.log("\n── Group 6: Listener-restart survival");
  sshCapture(cfg, droplet, "systemctl restart github-backup-webhook");
  await new Promise(res => setTimeout(res, 3_000));
  assert(sshCapture(cfg, droplet, "systemctl is-active github-backup-webhook").trim() === "active",
    "github-backup-webhook is active after restart");
  {
    const body = Buffer.from(JSON.stringify({ zen: "post-restart" }));
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 200, "ping after restart returns 200");
  }

  console.log("\n✅  All assertions passed.");
}

main().catch(err => { console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`); process.exit(1); });
```

2. Verify: `npx tsc --noEmit` exits 0.
  </action>
</task>

<task type="auto">
  <name>Task 2: Add `verify:phase-3` to package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (current state)
    - .planning/phases/03-webhook/03-03-operator-scaffolding-PLAN.md task 5 (where `register-webhooks` was added — same scripts object)
  </read_first>
  <acceptance_criteria>
    - `package.json` has a `scripts["verify:phase-3"]` entry running `tsx scripts/verify/phase-3.ts`.
    - No other script entries touched.
    - `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` exits 0.
  </acceptance_criteria>
  <action>
1. In `package.json` `"scripts"` object, append:
   ```json
   "verify:phase-3": "tsx scripts/verify/phase-3.ts"
   ```
   Mind the comma — append after the previous entry's closing string.

2. Verify with `node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); if (!p.scripts['verify:phase-3']) process.exit(1)"`.
  </action>
</task>

<task type="auto">
  <name>Task 3: Add `## Webhook setup` section to README.md</name>
  <files>README.md</files>
  <read_first>
    - README.md (current state — find a sensible insertion point: after Prerequisites, before Lifecycle / Backup / Restore)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-04, D-06, D-09, D-18, D-21, D-22 — operator-facing semantics)
  </read_first>
  <acceptance_criteria>
    - `README.md` contains a top-level section `## Webhook setup` (or `## Webhook` if the existing heading style omits "setup" — match the existing pattern).
    - Section covers, in order: why, prereqs (DNS + domain), config additions, first-time setup, secret rotation, verification, live tail, troubleshooting (LE failure + webhook-not-firing + cron-vs-webhook signal).
    - Section includes the exact commands:
      - `npm run create-droplet`
      - `GITHUB_TOKEN=… npm run bootstrap-droplet`
      - `npm run register-webhooks`
      - `GITHUB_TOKEN=… npm run bootstrap-droplet -- --rotate-webhook-secret`
      - `npm run register-webhooks -- --update`
      - `npm run verify:phase-3`
      - `ssh root@<droplet-ip> journalctl -u github-backup-webhook -f`
    - Section calls out that the secret is echoed to stdout ONCE and the operator should record it.
    - "Existing README structure preserved" — no other section is edited, table of contents (if any) not regenerated.
  </acceptance_criteria>
  <action>
1. Pick the insertion point in `README.md`: after the existing top-level setup section (Prerequisites + First-time setup, around line 100-150 depending on current state). Insert the new section before the Lifecycle / Recovery sections.

2. Insert this section (adapt heading style to match existing — current README uses `## X`):

```markdown
## Webhook setup

Webhook listener delivers near-instant `git remote update` per pushed repo. The
nightly cron sweep stays as a safety net for missed deliveries, deleted repos,
and idle repos that never push.

### Prerequisites

- Operator owns a domain (e.g. `backup.example.com`).
- BEFORE `npm run bootstrap-droplet`: point an A record at the droplet's public
  IP. Caddy needs the DNS record live for the Let's Encrypt ACME HTTP-01
  challenge to succeed. Bootstrap does not validate DNS — first webhook attempt
  fails loud if the cert was never issued.

### Config additions

In `config.json`:

```json
{
  "webhookHostname": "backup.example.com",
  "webhookTestRepo": "your-owner/your-test-repo"
}
```

- `webhookHostname` (REQUIRED): the FQDN you pointed at the droplet IP.
- `webhookTestRepo` (OPTIONAL, `<owner>/<repo>`): consumed only by
  `npm run verify:phase-3` group 4 (end-to-end push). Unset = group 4 skipped.

### First-time setup

```bash
# 1. Provision droplet + firewall (opens TCP/22, 80, 443).
npm run create-droplet

# 2. Bootstrap droplet — installs Caddy, Node, cron, systemd unit;
#    generates WEBHOOK_SECRET and echoes it to stdout (record it!).
GITHUB_TOKEN=ghp_… npm run bootstrap-droplet

# 3. Register webhooks on every repo of cfg.githubUserOrOrg.
#    Reads WEBHOOK_SECRET from the droplet over SSH — no local secret state.
npm run register-webhooks

# 4. Verify the full plane end-to-end.
npm run verify:phase-3
```

### Secret rotation

```bash
GITHUB_TOKEN=ghp_… npm run bootstrap-droplet -- --rotate-webhook-secret
npm run register-webhooks -- --update
```

The first command regenerates `WEBHOOK_SECRET` on the droplet and echoes the new
value; the second command PATCHes every existing GitHub webhook with the new
secret. Skipping step 2 means GitHub will sign with the OLD secret and the
listener will reject every event.

### Live tail

```bash
ssh root@<droplet-ip> journalctl -u github-backup-webhook -f
```

Listener writes its log to the systemd journal — no separate log file. The
cron-driven backup script still writes to `/var/log/github-backup.log`.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify:phase-3` Group 1 LE-cert assertion fails | DNS not pointed at droplet OR port 80 blocked OR Caddy never tried (no incoming request) | `dig A <webhookHostname>` must show droplet IP. `curl -v http://<webhookHostname>/` from anywhere triggers Caddy's first ACME attempt. `journalctl -u caddy --since 5m` shows the ACME error. |
| Webhook deliveries show 401 in GitHub Settings → Webhooks → Recent Deliveries | Secret mismatch between GitHub and droplet | Run `npm run register-webhooks -- --update` after any `--rotate-webhook-secret`. |
| Webhook fires but mirror doesn't update | sync-one-repo.sh exited non-zero (network, git error) | `grep BACKUP_REPO_RESULT /var/log/github-backup.log \| tail` — look for `action=fail`. Then `journalctl -u github-backup-webhook -n 50`. |
| Some repos syncing via cron only (not webhook) | Webhook not registered on those repos | `gh api repos/<owner>/<repo>/hooks` should show one entry with `config.url` matching `webhookHostname`. Re-run `npm run register-webhooks`. |
```

3. Save. Do NOT regenerate any TOC or touch other sections.
  </action>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` exits 0.
2. `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts['verify:phase-3']"` prints `tsx scripts/verify/phase-3.ts`.
3. `grep -c "## Webhook setup" README.md` returns 1 (or `## Webhook` per heading-style match — confirm by reading README).
4. `grep -c "verify:phase-3" README.md` returns ≥ 1.
5. `grep -c "register-webhooks" README.md` returns ≥ 2 (first-time + rotation).
6. `grep -c "journalctl -u github-backup-webhook" README.md` returns ≥ 1.
7. `grep -c "X-Hub-Signature-256" scripts/verify/phase-3.ts` returns ≥ 1 (group 2 + 3 + 4 all set it).
8. `grep -c "Group" scripts/verify/phase-3.ts` returns ≥ 6 (one banner per group).

End-to-end test isn't runnable in plan-time (requires live droplet) — that's the smoke run on real hardware. Verification at this stage is artifact-shape only.
</verification>

<deferred>
- Real-GitHub-payload mode for group 4 (vs synthetic) — synthetic is deterministic, real is overkill (CONTEXT.md D-26 group 4 sub).
- Helper extraction for assert/sshCapture into a shared lib (Phase 4 D-Discretion suggestion) — out of scope, deferred to a future cleanup phase.
- Webhook-deletes / repo-renamed coverage in verify — out of scope per CONTEXT.md D-14.
- Prometheus metrics scrape — v2 (CONTEXT.md deferred).
</deferred>
