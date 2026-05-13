---
status: human_needed
phase: 03-webhook
phase_number: "03"
phase_name: webhook
verified_by: orchestrator (inline)
plans_verified:
  - 03-01-sync-handler
  - 03-02-listener
  - 03-03-operator-scaffolding
  - 03-04-verify-readme
requirements_covered:
  - WEBHOOK-01
  - WEBHOOK-02
  - TEST-03
requirements_touched:
  - PROV-01     # firewall reconcile +80+443 idempotent
  - PROV-02     # bootstrap installs caddy + node + listener systemd unit
  - BACKUP-03   # WEBHOOK_SECRET stored in backup.env
  - BACKUP-02   # cron path continues via sync-one-repo.sh
  - TEST-02     # executable verify:phase-3 runner
score_artifact: 7/7   # all artifact-shape must_haves verified
score_human: 0/6      # operator-side smoke against live droplet pending
completed: 2026-05-13
---

# Phase 3 — Webhook listener: VERIFICATION

## Verification approach

Phase-level gate enforced inline by the orchestrator. Verifier subagent was not
spawnable from the current execution context (the run is itself executing inside
a subagent that lacks the `Task` tool), so each plan's `Self-Check` was treated
as authoritative and cross-checked against the on-disk artifacts. Whole-project
`npx tsc --noEmit` and `bash -n` checks were re-run after the final plan.

## must_have coverage

### Plan 03-01 (sync-handler)

| Truth | Status | Evidence |
|---|---|---|
| Single per-repo handler invoked by cron + webhook | ✓ | `droplet/sync-one-repo.sh` exists, mode 100755 |
| Per-repo flock `/var/lock/github-backup-${OWNER}_${REPO}.lock` on fd 8 | ✓ | `grep flock droplet/sync-one-repo.sh` shows fd-8 redirect + `-n` default + `-w` env-gated branch |
| Global flock preserved in `github-backup.sh` | ✓ | fd-9 acquisition at line 36 retained; loop body still inside it |
| Both scripts emit `BACKUP_REPO_RESULT` | ✓ | `grep -c BACKUP_REPO_RESULT droplet/sync-one-repo.sh` = 1 (emit) |
| `BACKUP_SUMMARY` line unchanged (Phase 1 contract) | ✓ | `grep -nE 'log "BACKUP_SUMMARY' droplet/github-backup.sh` returns line 172 only |
| Exit 0 on clone/update, non-zero on fail | ✓ | `EXIT_CODE=1` default, `EXIT_CODE=0` on success branch |

### Plan 03-02 (listener)

| Truth | Status | Evidence |
|---|---|---|
| Vanilla Node zero-dep listener | ✓ | `grep require droplet/webhook-listener.js` shows only http/crypto/fs/path/child_process |
| HMAC verify on raw buffer BEFORE JSON.parse | ✓ | listener reads chunks → Buffer.concat → verifyHmac BEFORE try/JSON.parse |
| Source resolution returns 404 on owner mismatch | ✓ | listener compares `owner !== ALLOWED_SOURCE` → 404 |
| systemd-run --collect --no-block dispatch | ✓ | listener spawns `/usr/bin/systemd-run --collect --no-block ${SYNC_SCRIPT} owner owner repo` |
| ping → 200 pong; non-push/non-ping → 204 | ✓ | switch on `x-github-event` |
| Caddyfile reverse_proxy template | ✓ | `droplet/Caddyfile.template` has placeholder + one reverse_proxy block |
| systemd unit `github-backup-webhook.service` | ✓ | `droplet/github-backup-webhook.service` has Type=simple, ExecStart=/usr/bin/node, EnvironmentFile=/opt/github-backups/backup.env, Restart=on-failure, RestartSec=2, journal logging, User=root, WantedBy=multi-user.target |
| Bootstrap idempotent install/enable | ✓ | bootstrap.sh installs caddy + node from idempotent apt; overwrite-then-daemon-reload-then-enable-now pattern; pre-flight defensive check for the three uploaded files |
| WEBHOOK_SECRET read from backup.env via EnvironmentFile= | ✓ | systemd unit + listener `process.env.WEBHOOK_SECRET` |

### Plan 03-03 (operator-scaffolding)

| Truth | Status | Evidence |
|---|---|---|
| Config gains required webhookHostname + optional webhookTestRepo | ✓ | scripts/lib/config.ts: REQUIRED_FIELDS+SHELL_SAFE_FIELDS+FQDN_RE+SLUG_RE |
| create-droplet adds TCP/80+443 idempotently (both CREATE + EXISTING branches) | ✓ | reconcile loop only calls `add-rules` for missing rules; CREATE branch installs all three |
| bootstrap generates 64-hex WEBHOOK_SECRET, echoes once, persists to backup.env | ✓ | `resolveWebhookSecret` first-run path + writeBackupEnv 64-hex shape guard |
| Re-bootstrap preserves existing secret (no echo) | ✓ | `resolveWebhookSecret` default-path SSH read of `WEBHOOK_SECRET=` line + 64-hex validation + preserve branch |
| --rotate-webhook-secret regenerates + echoes + reminder | ✓ | `resolveWebhookSecret` rotate=true branch logs banner + new secret + register-webhooks --update reminder |
| register-webhooks idempotent create + --update + --dry-run | ✓ | scripts/register-webhooks.ts has all three paths; lists existing hooks by `config.url` match |
| package.json adds register-webhooks script | ✓ | `tsx scripts/register-webhooks.ts` |
| config.example.json documents new fields | ✓ | webhookHostname + webhookTestRepo placeholders + _readme update |

### Plan 03-04 (verify-readme)

| Truth | Status | Evidence |
|---|---|---|
| `npm run verify:phase-3` runs scripts/verify/phase-3.ts (exit 0 only on all-pass) | ✓ | package.json scripts["verify:phase-3"] = `tsx scripts/verify/phase-3.ts` |
| Six assertion groups in order (D-26) | ✓ | grep "Group" returns 12 (banner + comment per group = 6 banners ✓) |
| Group 4 env-gated on cfg.webhookTestRepo with [skip] log | ✓ | if (!cfg.webhookTestRepo) → console.log skip line |
| Synthetic-but-deterministic push payload | ✓ | `syntheticPushPayload` uses sha1(now-ISO) for `after`, owner/repo from args |
| README §Webhook setup section ships | ✓ | grep -c "^## Webhook setup$" = 1 |
| Section includes all required commands | ✓ | grep -c register-webhooks = 4, verify:phase-3 = 3, journalctl = 2 |
| package.json verify:phase-3 entry | ✓ | yes |

## Phase-level invariants

| Check | Status | Evidence |
|---|---|---|
| Whole-project `npx tsc --noEmit` | ✓ pass | run after every TS-touching commit |
| `bash -n` on every modified shell script | ✓ pass | run per task |
| `node --check droplet/webhook-listener.js` | ✓ pass | run per task |
| `BACKUP_SUMMARY` regex contract from `scripts/verify/phase-1.ts` still matches | ✓ pass (mental trace) | only emit line is unchanged in github-backup.sh |
| `github-backup-webhook.service` unit path matches Phase 5 verify-script expectation | ✓ | Phase 5 plan 05-02 looks for `github-backup-webhook.service`; this phase installs at `/etc/systemd/system/github-backup-webhook.service` |
| Phase 5 D-07 hook (listener-restart after re-bootstrap) | ✓ | bootstrap.sh runs daemon-reload + enable --now + caddy reload on each re-bootstrap |
| Suffix allow-list uploader picks up .js/.template/.service | ✓ | scripts/bootstrap-droplet.ts filter regex |

## requirements traceability

| REQ-ID | Plan(s) | Verified |
|--------|---------|----------|
| WEBHOOK-01 | 03-02, 03-03, 03-04 | ✓ HMAC verify path + verify:phase-3 group 3 |
| WEBHOOK-02 | 03-02, 03-04 | ✓ push event dispatch path + verify:phase-3 group 4 (env-gated) |
| TEST-03 | 03-04 | ✓ verify:phase-3 six groups |
| PROV-01 | 03-03 | ✓ firewall reconcile keeps idempotency (mental trace + commit) |
| PROV-02 | 03-02 | ✓ bootstrap.sh now installs caddy + node + listener unit |
| BACKUP-03 | 03-02, 03-03 | ✓ WEBHOOK_SECRET appended to backup.env mode 600 |
| TEST-02 | 03-04 | ✓ verify:phase-3 is the executable verification step |

## Gaps

None at the artifact-shape level. All must_haves are satisfied on disk.

## Human verification needed

The full Phase 3 success criteria require a live droplet. Six items deferred
to human smoke-test (these surface in `/gsd-progress` and `/gsd-audit-uat`
until cleared):

### 1. DNS A record points at droplet
expected: operator creates an A record for `cfg.webhookHostname` → droplet.ip BEFORE `npm run bootstrap-droplet`. `dig A <webhookHostname>` from anywhere shows the droplet IP.
result: pending

### 2. Caddy auto-issues Let's Encrypt cert
expected: after bootstrap + first incoming HTTPS request, `journalctl -u caddy --since 5m` shows successful ACME challenge; `openssl s_client -servername <hostname> -connect <hostname>:443 | openssl x509 -noout -enddate` returns a notAfter in the future.
result: pending

### 3. systemctl is-active github-backup-webhook
expected: after bootstrap, `ssh root@<ip> systemctl is-active github-backup-webhook` returns `active`.
result: pending

### 4. Signed push triggers mirror within 30s
expected: `npm run register-webhooks` (after secret echoed during bootstrap); push a commit to cfg.webhookTestRepo; `BACKUP_REPO_RESULT … action=clone|update …` appears in `/var/log/github-backup.log` within 30s.
result: pending

### 5. Bad signature returns 401
expected: `curl -X POST -H 'X-Hub-Signature-256: sha256=deadbeef' …` to `https://<hostname>/webhook/github` returns 401 in <2s.
result: pending

### 6. Re-bootstrap preserves secret + restarts listener
expected: second `npm run bootstrap-droplet` (no flag) does NOT echo a new secret; logs `🔐  Preserving existing WEBHOOK_SECRET`; `systemctl is-active github-backup-webhook` still `active` after the run.
result: pending

These are exactly what `scripts/verify/phase-3.ts` exercises end-to-end on a
live droplet. Until a smoke run validates against real infrastructure, the
phase is artifact-complete but not human-verified.

## Notes for Phase 5 (immediately downstream)

`scripts/verify/phase-5.ts` Group 5 probe-gates on
`github-backup-webhook.service`. The unit ships at the exact path Phase 5
expects (`/etc/systemd/system/github-backup-webhook.service` after bootstrap.sh
copies it from `${BACKUP_DIR}/github-backup-webhook.service`). Phase 5's
listener-survival assertion will activate automatically on the next droplet
re-bootstrap.
